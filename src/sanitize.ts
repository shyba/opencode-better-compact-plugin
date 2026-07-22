import type { Hooks } from "@opencode-ai/plugin"
import { redact, truncateUtf8, utf8Bytes } from "./ledger.js"
import type { PluginOptions } from "./options.js"

type HookPart = Parameters<NonNullable<Hooks["experimental.chat.messages.transform"]>>[1]["messages"][number]["parts"][number]

const TOOL_EDGE_CHARACTERS = 900
const TOOL_OUTPUT_MAX_BYTES = 8_192
const MAX_DATA_URL_METADATA_BYTES = 16_384
const MAX_PROVIDER_METADATA_BYTES = 65_536
const MAX_STRUCTURED_DEPTH = 8
const MAX_STRUCTURED_ITEMS = 128
const MAX_STRUCTURED_NODES = 512

export function decodedDataUrlBytes(
  url: string,
  maxDecodedBytes = Number.POSITIVE_INFINITY,
  maxEncodedBytes = Number.POSITIVE_INFINITY,
) {
  if (url.length > maxEncodedBytes) throw new RangeError("Inline data URL encoded representation exceeds its limit")
  const comma = url.slice(0, MAX_DATA_URL_METADATA_BYTES + 6).indexOf(",")
  if (url.slice(0, 5).toLowerCase() !== "data:") throw new TypeError("Invalid inline data URL")
  if (comma < 5 && url.length > MAX_DATA_URL_METADATA_BYTES + 5) {
    throw new RangeError(`Inline data URL metadata exceeds ${MAX_DATA_URL_METADATA_BYTES} bytes`)
  }
  if (comma < 5) throw new TypeError("Invalid inline data URL")
  const metadata = url.slice(5, comma)
  if (metadata.length > MAX_DATA_URL_METADATA_BYTES || utf8Bytes(metadata) > MAX_DATA_URL_METADATA_BYTES) {
    throw new RangeError(`Inline data URL metadata exceeds ${MAX_DATA_URL_METADATA_BYTES} bytes`)
  }
  if (utf8Bytes(url) > maxEncodedBytes) throw new RangeError("Inline data URL encoded representation exceeds its limit")
  if (!/;base64(?:;|$)/i.test(metadata)) return percentDecodedBytes(url, comma + 1, maxDecodedBytes)

  let characters = 0
  let padding = 0
  let padded = false
  for (let index = comma + 1; index < url.length; index++) {
    const code = url.charCodeAt(index)
    if (code === 0x20 || (code >= 0x09 && code <= 0x0d)) continue
    if (code === 0x3d) {
      padded = true
      padding++
      characters++
      if (padding > 2) throw new TypeError("Invalid base64 inline data URL")
      continue
    }
    const alphabet = (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a) ||
      (code >= 0x30 && code <= 0x39) || code === 0x2b || code === 0x2f
    if (padded || !alphabet) throw new TypeError("Invalid base64 inline data URL")
    characters++
    if (Math.max(0, Math.floor((characters * 3) / 4) - 2) > maxDecodedBytes) return maxDecodedBytes + 1
  }
  if (characters % 4 === 1 || (padding > 0 && characters % 4 !== 0)) {
    throw new TypeError("Invalid base64 inline data URL")
  }
  const bytes = Math.floor((characters * 3) / 4) - padding
  return bytes > maxDecodedBytes ? maxDecodedBytes + 1 : bytes
}

export function sanitizeHistory(
  messages: Array<{ info: { id: string; sessionID: string; role: string }; parts: HookPart[] }>,
  options: PluginOptions,
) {
  for (const message of messages) {
    message.parts = message.parts.map((part) => {
      if (part.type === "text") {
        const text = sanitizeText(part.text, options.max_historical_part_bytes)
        const metadata = text === part.text ? boundedProviderMetadata(part.metadata) : undefined
        const sanitized = { ...part, text, ...(metadata ? { metadata } : {}) }
        if (!metadata) delete sanitized.metadata
        return sanitized
      }
      if (part.type === "reasoning") {
        return {
          id: part.id,
          sessionID: part.sessionID,
          messageID: part.messageID,
          type: "text",
          synthetic: true,
          text: sanitizeText(
            `[Historical reasoning converted to unsigned text]\n${part.text}`,
            options.max_historical_part_bytes,
          ),
        }
      }
      if (part.type === "tool") {
        const state = part.state
        const input = sanitizeRecord(state.input, options.max_historical_part_bytes)
        const metadata = boundedProviderMetadata(part.metadata) ??
          (part.metadata?.providerExecuted === true ? { providerExecuted: true } : undefined)
        const base = {
          id: part.id,
          sessionID: part.sessionID,
          messageID: part.messageID,
          type: part.type,
          callID: part.callID,
          tool: sanitizeText(part.tool, 512),
          ...(metadata ? { metadata } : {}),
        }
        if (state.status === "completed") {
          return {
            ...base,
            state: {
              status: state.status,
              input,
              output: sanitizeToolOutput(state.output),
              title: typeof state.title === "string" ? sanitizeText(state.title, 512) : sanitizeText(part.tool, 512),
              metadata: sanitizeRecord(state.metadata, options.max_historical_part_bytes),
              time: state.time,
              attachments: [],
            },
          }
        }
        if (state.status === "error") {
          return {
            ...base,
            state: {
              status: state.status,
              input,
              error: sanitizeText(state.error, options.max_historical_part_bytes),
              time: state.time,
              ...(state.metadata ? { metadata: sanitizeRecord(state.metadata, options.max_historical_part_bytes) } : {}),
            },
          }
        }
        if (state.status === "running") {
          return {
            ...base,
            state: {
              status: state.status,
              input,
              time: state.time,
              ...(state.title ? { title: sanitizeText(state.title, 512) } : {}),
              ...(state.metadata ? { metadata: sanitizeRecord(state.metadata, options.max_historical_part_bytes) } : {}),
            },
          }
        }
        return {
          ...base,
          state: {
            status: state.status,
            input,
            raw: sanitizeText(state.raw, options.max_historical_part_bytes),
          },
        }
      }
      if (part.type === "file") {
        const inline = /^data:/i.test(part.url)
        const detail = inline ? inlineDataDetail(part.url, options.max_inline_data_bytes) : "external attachment"
        return {
          id: part.id,
          sessionID: part.sessionID,
          messageID: part.messageID,
          type: "text",
          synthetic: true,
          text: sanitizeText(
            `[Historical ${detail} omitted from model-visible history: ${part.filename ?? "unnamed file"}]`,
            options.max_historical_part_bytes,
          ),
        }
      }
      return part
    })
  }
}

function sanitizeText(value: string, maxBytes: number) {
  const bounded = value.length > maxBytes || utf8Bytes(value) > maxBytes ? headTailBytes(value, maxBytes) : value
  return truncateUtf8(redact(bounded), maxBytes)
}

function percentDecodedBytes(value: string, start: number, maxBytes: number) {
  let bytes = 0
  for (let index = start; index < value.length; index++) {
    if (value[index] !== "%") {
      const high = value.charCodeAt(index)
      if (high <= 0x7f) bytes++
      else if (high <= 0x7ff) bytes += 2
      else if (high >= 0xd800 && high <= 0xdbff && index + 1 < value.length) {
        const low = value.charCodeAt(index + 1)
        if (low >= 0xdc00 && low <= 0xdfff) {
          bytes += 4
          index++
        } else bytes += 3
      } else bytes += 3
      if (bytes > maxBytes) return maxBytes + 1
      continue
    }
    const hex = value.slice(index + 1, index + 3)
    if (!/^[a-f0-9]{2}$/i.test(hex)) throw new TypeError("Invalid percent-encoding in inline data URL")
    bytes++
    if (bytes > maxBytes) return maxBytes + 1
    index += 2
  }
  return bytes
}

function sanitizeToolOutput(value: string) {
  const prefix = takeCodePointsStart(value, TOOL_EDGE_CHARACTERS * 2 + 1)
  if (prefix === value) return sanitizeText(value, TOOL_OUTPUT_MAX_BYTES)
  return sanitizeText(
    `${takeCodePointsStart(value, TOOL_EDGE_CHARACTERS)}\n[… middle omitted by opencode-safe-compaction …]\n${takeCodePointsEnd(value, TOOL_EDGE_CHARACTERS)}`,
    TOOL_OUTPUT_MAX_BYTES,
  )
}

function sanitizeStructured(value: unknown, maxBytes: number) {
  const budget = { bytes: maxBytes, nodes: MAX_STRUCTURED_NODES }
  const result = visit(value, budget, 0)
  return utf8Bytes(JSON.stringify(result)) <= maxBytes
    ? result
    : { safe_compaction_omitted: "structured value exceeded the configured byte limit" }
}

function sanitizeRecord(value: Record<string, unknown>, maxBytes: number) {
  const result = sanitizeStructured(value, maxBytes)
  return typeof result === "object" && result !== null && !Array.isArray(result)
    ? result as Record<string, unknown>
    : { safe_compaction_omitted: String(result) }
}

function visit(value: unknown, budget: { bytes: number; nodes: number }, depth: number): unknown {
  if (budget.nodes-- <= 0 || budget.bytes <= 0) return "[structured value omitted]"
  if (typeof value === "string") {
    const result = sanitizeText(value, Math.min(8_192, budget.bytes))
    budget.bytes -= Math.min(budget.bytes, utf8Bytes(result))
    return result
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value
  if (typeof value === "bigint") return truncateUtf8(String(value), Math.min(128, budget.bytes))
  if (typeof value !== "object" || depth >= MAX_STRUCTURED_DEPTH) return "[unsupported value omitted]"
  if (Array.isArray(value)) {
    const result = value.slice(0, MAX_STRUCTURED_ITEMS).map((item) => visit(item, budget, depth + 1))
    if (value.length > MAX_STRUCTURED_ITEMS) result.push(`[${value.length - MAX_STRUCTURED_ITEMS} items omitted]`)
    return result
  }
  const result = Object.create(null) as Record<string, unknown>
  let count = 0
  for (const key in value) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue
    if (count++ >= MAX_STRUCTURED_ITEMS) {
      result["safe_compaction_omitted"] = "additional fields omitted"
      break
    }
    const boundedKey = key.slice(0, 256)
    const safeKey = truncateUtf8(redact(boundedKey), 256)
    budget.bytes -= Math.min(budget.bytes, utf8Bytes(safeKey))
    result[safeKey] = key.length <= 256 && credentialKey(boundedKey)
      ? "[REDACTED]"
      : visit((value as Record<string, unknown>)[key], budget, depth + 1)
  }
  return result
}

function boundedProviderMetadata(value: Record<string, unknown> | undefined) {
  if (!value) return
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }]
  const seen = new Set<object>()
  let nodes = 0
  let bytes = 0
  while (pending.length) {
    const current = pending.pop()!
    if (typeof current.value === "string") {
      if (current.value.length > MAX_PROVIDER_METADATA_BYTES - bytes) return
      bytes += utf8Bytes(current.value)
      if (bytes > MAX_PROVIDER_METADATA_BYTES) return
      continue
    }
    if (current.value === null || typeof current.value === "number" || typeof current.value === "boolean") continue
    if (typeof current.value !== "object" || current.depth >= MAX_STRUCTURED_DEPTH || seen.has(current.value)) return
    seen.add(current.value)
    if (++nodes > MAX_STRUCTURED_NODES) return
    if (Array.isArray(current.value) && current.value.length > MAX_STRUCTURED_ITEMS) return
    const entries: Array<[string, unknown]> = []
    for (const key in current.value) {
      if (!Object.hasOwn(current.value, key)) continue
      entries.push([key, (current.value as Record<string, unknown>)[key]])
      if (entries.length > MAX_STRUCTURED_ITEMS) return
    }
    for (const [key, item] of entries) {
      if (key.length > MAX_PROVIDER_METADATA_BYTES - bytes) return
      bytes += utf8Bytes(key)
      if (bytes > MAX_PROVIDER_METADATA_BYTES || item === undefined) return
      pending.push({ value: item, depth: current.depth + 1 })
    }
  }
  const serialized = JSON.stringify(value)
  if (utf8Bytes(serialized) > MAX_PROVIDER_METADATA_BYTES) return
  return JSON.parse(serialized) as Record<string, unknown>
}

function credentialKey(value: string) {
  return /^(?:[a-z0-9_-]{0,64}(?:api[_-]?key|password|passwd|secret|token|private[_-]?key|access[_-]?key(?:[_-]?id)?|credential)|authorization)$/i.test(
    value.trim().replace(/^['"]|['"]$/g, ""),
  )
}

function inlineDataDetail(url: string, maxBytes: number) {
  try {
    const bytes = decodedDataUrlBytes(url, maxBytes, maxBytes * 3 + MAX_DATA_URL_METADATA_BYTES)
    return bytes > maxBytes ? "oversized inline data" : `${bytes}-byte inline data`
  } catch (error) {
    if (error instanceof RangeError) return "oversized inline data"
    return "malformed inline data"
  }
}

function headTailBytes(value: string, maxBytes: number) {
  const marker = "\n[… historical text omitted by opencode-safe-compaction …]\n"
  const budget = Math.max(0, maxBytes - utf8Bytes(marker))
  return takeUtf8Start(value, Math.floor(budget / 2)) + marker + takeUtf8End(value, Math.ceil(budget / 2))
}

function takeUtf8Start(value: string, maxBytes: number) {
  let bytes = 0
  let end = 0
  for (const character of value) {
    const size = utf8Bytes(character)
    if (bytes + size > maxBytes) break
    bytes += size
    end += character.length
  }
  return value.slice(0, end)
}

function takeUtf8End(value: string, maxBytes: number) {
  let bytes = 0
  let start = value.length
  while (start > 0) {
    const low = value.charCodeAt(start - 1)
    const width = low >= 0xdc00 && low <= 0xdfff && start > 1 ? 2 : 1
    const next = start - width
    const size = utf8Bytes(value.slice(next, start))
    if (bytes + size > maxBytes) break
    bytes += size
    start = next
  }
  return value.slice(start)
}

function takeCodePointsStart(value: string, count: number) {
  let index = 0
  let seen = 0
  for (const character of value) {
    if (seen++ >= count) break
    index += character.length
  }
  return value.slice(0, index)
}

function takeCodePointsEnd(value: string, count: number) {
  let index = value.length
  let seen = 0
  while (index > 0 && seen++ < count) {
    const low = value.charCodeAt(index - 1)
    index -= low >= 0xdc00 && low <= 0xdfff && index > 1 ? 2 : 1
  }
  return value.slice(index)
}
