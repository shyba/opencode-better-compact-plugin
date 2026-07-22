import type { Config, Hooks, PluginInput, PluginOptions as OpenCodePluginOptions } from "@opencode-ai/plugin"
import { buildRecoveryLedger, record, summaryText, utf8Bytes, type MessageRecord } from "./ledger.js"
import { parseOptions, resolveOptions, type PluginOptions } from "./options.js"
import { AttemptStore, type Attempt } from "./state.js"
import {
  buildCompactionPrompt,
  buildFallback,
  isPluginValidSummary,
  parsePluginLedger,
  recoveryContext,
  validateSummary,
} from "./validation.js"

// The 1.18.4 V1 SDK type omits compaction fields that the 1.18.4 runtime schema accepts.
type RuntimeConfig = Config & {
  agent?: Record<string, { model?: string; temperature?: number; [key: string]: unknown } | undefined>
  compaction?: {
    auto?: boolean
    prune?: boolean
    tail_turns?: number
    preserve_recent_tokens?: number
    reserved?: number
  }
}

type HookPart = Parameters<NonNullable<Hooks["experimental.chat.messages.transform"]>>[1]["messages"][number]["parts"][number]
type ProviderMessage = Parameters<typeof sanitizeHistory>[0][number]

export async function server(input: PluginInput, rawOptions?: OpenCodePluginOptions): Promise<Hooks> {
  const parsed = parseOptions(rawOptions)
  const attempts = new AttemptStore()
  let settings: PluginOptions | undefined

  const hooks = {
    async config(output) {
      const config = output as RuntimeConfig
      settings = resolveOptions(parsed, {
        model: config.agent?.compaction?.model,
        tail_turns: config.compaction?.tail_turns,
        preserve_recent_tokens: config.compaction?.preserve_recent_tokens,
        reserved_tokens: config.compaction?.reserved,
      })
      config.agent = {
        ...config.agent,
        compaction: {
          ...config.agent?.compaction,
          model: settings.model,
          temperature: 0,
        },
      }
      config.compaction = {
        ...config.compaction,
        auto: config.compaction?.auto ?? true,
        prune: config.compaction?.prune ?? false,
        tail_turns: settings.tail_turns,
        preserve_recent_tokens: settings.preserve_recent_tokens,
        reserved: settings.reserved_tokens,
      }
    },

    async "chat.message"(_, output) {
      const options = requireSettings(settings, parsed)
      const textBytes = output.parts.reduce(
        (total, part) => total + (part.type === "text" && part.synthetic !== true ? utf8Bytes(part.text) : 0),
        0,
      )
      if (textBytes > options.max_user_text_bytes) {
        throw new RangeError(
          `opencode-safe-compaction rejected a ${textBytes}-byte user message (limit ${options.max_user_text_bytes}). Use file references or send smaller chunks.`,
        )
      }
      const inlineBytes = output.parts.reduce(
        (total, part) => total + (part.type === "file" && /^data:/i.test(part.url) ? decodedDataUrlBytes(part.url) : 0),
        0,
      )
      if (inlineBytes > options.max_inline_data_bytes) {
        throw new RangeError(
          `opencode-safe-compaction rejected ${inlineBytes} decoded inline-data bytes (limit ${options.max_inline_data_bytes}). Use file references or send smaller attachments.`,
        )
      }
    },

    async "experimental.session.compacting"({ sessionID }, output) {
      const options = requireSettings(settings, parsed)
      const data = await loadSession(input, sessionID)
      const priorValidSummary = newestPluginValidSummary(data.messages, options.max_summary_bytes)
      const ledger = buildRecoveryLedger({
        messages: data.messages,
        todos: data.todos,
        tailTurns: options.tail_turns,
        maxBytes: options.max_ledger_bytes,
      })
      attempts.set({
        sessionID,
        createdAt: Date.now(),
        ledger,
        ...(priorValidSummary ? { priorValidSummary } : {}),
        validation: "pending",
        recoveryInjected: false,
      })
      output.prompt = buildCompactionPrompt(ledger)
    },

    async "experimental.chat.messages.transform"(_, output) {
      const options = requireSettings(settings, parsed)
      const sessionIDs = new Set(output.messages.map((message) => message.info.sessionID).filter(Boolean))
      if (sessionIDs.size !== 1) return
      const sessionID = sessionIDs.values().next().value
      if (!sessionID) return
      let attempt = attempts.get(sessionID)
      const invalid = invalidCompactionBeforeNewestUser(output.messages as MessageRecord[])
      if (!attempt && invalid) {
        attempt = await rebuildAttempt(input, options, sessionID, invalid.info.id)
        attempts.set(attempt)
      }
      if (!attempt) {
        await sanitizeOverflowReplay(input, sessionID, output.messages, options)
        return
      }

      const recoveryUser = invalid ? newestOrdinaryUser(output.messages) : undefined
      const overflowRecovery = invalid && recoveryUser
        ? await isOverflowReplay(input, sessionID, output.messages, invalid, recoveryUser)
        : false
      sanitizeHistory(
        recoveryUser && !overflowRecovery ? output.messages.filter((message) => message !== recoveryUser) : output.messages,
        options,
      )
      if (!invalid || attempt.recoveryInjected || !["pending", "invalid"].includes(attempt.validation)) return
      if (!recoveryUser) return
      recoveryUser.parts.push({
        id: `safe-compaction-recovery-${attempt.ledger.digest.slice(0, 16)}`,
        sessionID,
        messageID: recoveryUser.info.id,
        type: "text",
        synthetic: true,
        text: recoveryContext(attempt.ledger, attempt.priorValidSummary),
      })
      attempt.recoveryInjected = true
    },

    async "chat.params"(hookInput, output) {
      if (hookInput.agent !== "compaction") return
      const options = requireSettings(settings, parsed)
      const actual = `${hookInput.model.providerID}/${hookInput.model.id}`
      if (actual !== options.model) {
        throw new Error(`opencode-safe-compaction expected compaction model ${options.model}, received ${actual}`)
      }
      const runtimeLimit = record(hookInput.model.limit)
      const inputLimit = typeof runtimeLimit?.input === "number" && runtimeLimit.input > 0
        ? runtimeLimit.input
        : hookInput.model.limit.context
      if (inputLimit > 0 && inputLimit <= options.reserved_tokens) {
        throw new RangeError(
          `opencode-safe-compaction reserved_tokens=${options.reserved_tokens} leaves no usable input in ${actual} (${inputLimit})`,
        )
      }
      if (hookInput.model.limit.output <= 0) {
        throw new RangeError(`opencode-safe-compaction cannot use ${actual} with a zero output limit`)
      }
      output.temperature = 0
      const maxOutputTokens = Math.min(
        output.maxOutputTokens ?? options.max_output_tokens,
        options.max_output_tokens,
        hookInput.model.limit.output,
      )
      if (!Number.isFinite(maxOutputTokens) || maxOutputTokens <= 0) {
        throw new RangeError(`opencode-safe-compaction cannot use ${actual} with maxOutputTokens=${maxOutputTokens}`)
      }
      output.maxOutputTokens = maxOutputTokens
    },

    async "experimental.text.complete"(hookInput, output) {
      const options = requireSettings(settings, parsed)
      const target = await input.client.session.message({
        path: { id: hookInput.sessionID, messageID: hookInput.messageID },
        throwOnError: true,
      })
      const targetTextParts = compactionTargetTextParts(target.data, hookInput)
      if (!targetTextParts) return

      let attempt = attempts.get(hookInput.sessionID)
      if (!attempt) {
        attempt = await rebuildAttempt(input, options, hookInput.sessionID, hookInput.messageID)
        attempts.set(attempt)
      }
      if (attempt.textPartID && attempt.textPartID !== hookInput.partID) {
        output.text = ""
        if (attempt.validation === "original") attempt.validation = "invalid"
        return
      }
      attempt.textPartID = hookInput.partID
      attempt.summaryMessageID = hookInput.messageID
      if (targetTextParts === 1 && validateSummary(output.text, attempt.ledger, options.max_summary_bytes)) {
        attempt.validation = "original"
        return
      }
      output.text = buildFallback({
        ledger: attempt.ledger,
        ...(attempt.priorValidSummary ? { priorValidSummary: attempt.priorValidSummary } : {}),
        maxBytes: options.max_summary_bytes,
      })
      attempt.validation = validateSummary(output.text, attempt.ledger, options.max_summary_bytes) ? "fallback" : "invalid"
    },

    async "experimental.compaction.autocontinue"(hookInput, output) {
      if (!output.enabled) return
      const options = requireSettings(settings, parsed)
      const active = attempts.get(hookInput.sessionID)
      const data = await loadSession(input, hookInput.sessionID)
      const current = newestCompactionSummary(data.messages)
      const text = current ? summaryText(current) : ""
      const parsedLedger = text ? parsePluginLedger(text) : undefined
      let valid = false
      if (
        current &&
        active?.validation !== "invalid" &&
        parsedLedger &&
        isPluginValidSummary(text, options.max_summary_bytes)
      ) {
        const rebuilt = await rebuildAttempt(input, options, hookInput.sessionID, current.info.id, data)
        if (rebuilt.ledger.block === parsedLedger.block) {
          rebuilt.validation = "original"
          attempts.set(rebuilt)
          valid = true
        }
      }
      output.enabled = valid
      attempts.delete(hookInput.sessionID)
    },

    async event({ event }) {
      const properties = record(event.properties)
      if (event.type === "session.compacted") {
        attempts.delete(typeof properties?.sessionID === "string" ? properties.sessionID : undefined)
        return
      }
      if (event.type === "session.idle") {
        attempts.delete(typeof properties?.sessionID === "string" ? properties.sessionID : undefined)
        return
      }
      if (event.type === "session.status" && record(properties?.status)?.type === "idle") {
        attempts.delete(typeof properties?.sessionID === "string" ? properties.sessionID : undefined)
        return
      }
      if (event.type === "session.deleted") {
        const info = record(properties?.info)
        attempts.delete(
          typeof properties?.sessionID === "string"
            ? properties.sessionID
            : typeof info?.id === "string"
              ? info.id
              : undefined,
        )
        return
      }
      if (event.type === "session.error") {
        if (typeof properties?.sessionID === "string") attempts.delete(properties.sessionID)
        else attempts.clear()
        return
      }
      attempts.cleanupExpired()
    },

    async dispose() {
      attempts.clear()
    },
  } satisfies Hooks

  return hooks
}

export function decodedDataUrlBytes(url: string) {
  const match = url.match(/^data:([^,]*),(.*)$/is)
  if (!match || match[2] === undefined) throw new TypeError("Invalid inline data URL")
  if (!/;base64(?:;|$)/i.test(match[1] ?? "")) {
    try {
      return utf8Bytes(decodeURIComponent(match[2]))
    } catch {
      throw new TypeError("Invalid percent-encoding in inline data URL")
    }
  }
  const data = match[2].replace(/\s/g, "")
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data) || data.length % 4 === 1) throw new TypeError("Invalid base64 inline data URL")
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0
  if (padding > 0 && data.length % 4 !== 0) throw new TypeError("Invalid base64 inline data URL")
  return Math.floor((data.length * 3) / 4) - padding
}

export function sanitizeHistory(messages: Array<{ info: { id: string; sessionID: string; role: string }; parts: HookPart[] }>, options: PluginOptions) {
  for (const message of messages) {
    message.parts = message.parts.map((part) => {
      if (part.type === "text" && utf8Bytes(part.text) > options.max_historical_part_bytes) {
        return { ...part, text: headTailBytes(part.text, options.max_historical_part_bytes) }
      }
      if (part.type === "tool" && part.state.status === "completed" && Array.from(part.state.output).length > 1_900) {
        const characters = Array.from(part.state.output)
        return {
          ...part,
          state: {
            ...part.state,
            output: `${characters.slice(0, 900).join("")}\n[… ${characters.length - 1_800} characters omitted by opencode-safe-compaction …]\n${characters.slice(-900).join("")}`,
          },
        }
      }
      if (part.type === "file" && /^data:/i.test(part.url) && decodedDataUrlBytes(part.url) > options.max_inline_data_bytes) {
        return {
          id: part.id,
          sessionID: part.sessionID,
          messageID: part.messageID,
          type: "text",
          synthetic: true,
          text: `[Oversized inline ${part.mime} omitted from model-visible history: ${part.filename ?? "unnamed file"}]`,
        }
      }
      return part
    })
  }
}

async function rebuildAttempt(
  input: PluginInput,
  options: PluginOptions,
  sessionID: string,
  summaryMessageID: string,
  loaded?: Awaited<ReturnType<typeof loadSession>>,
): Promise<Attempt> {
  const data = loaded ?? (await loadSession(input, sessionID))
  const index = data.messages.findIndex((message) => message.info.id === summaryMessageID)
  const previous = index < 0 ? data.messages : data.messages.slice(0, index)
  const priorValidSummary = newestPluginValidSummary(previous, options.max_summary_bytes)
  return {
    sessionID,
    createdAt: Date.now(),
    ledger: buildRecoveryLedger({
      messages: data.messages,
      todos: data.todos,
      tailTurns: options.tail_turns,
      maxBytes: options.max_ledger_bytes,
      excludeSummaryID: summaryMessageID,
    }),
    ...(priorValidSummary ? { priorValidSummary } : {}),
    summaryMessageID,
    validation: "pending",
    recoveryInjected: false,
  } satisfies Attempt
}

async function loadSession(input: PluginInput, sessionID: string) {
  const [messages, todos] = await Promise.all([
    input.client.session.messages({ path: { id: sessionID }, throwOnError: true }),
    input.client.session.todo({ path: { id: sessionID }, throwOnError: true }),
  ])
  if (!messages.data || !todos.data) throw new Error(`opencode-safe-compaction could not load session metadata for ${sessionID}`)
  return { messages: messages.data as MessageRecord[], todos: todos.data }
}

function requireSettings(settings: PluginOptions | undefined, parsed: ReturnType<typeof parseOptions>) {
  return settings ?? resolveOptions(parsed)
}

function newestPluginValidSummary(messages: MessageRecord[], maxBytes: number) {
  return messages
    .filter((message) => message.info.role === "assistant" && message.info.summary === true)
    .map(summaryText)
    .findLast((text) => isPluginValidSummary(text, maxBytes))
}

function newestCompactionSummary(messages: MessageRecord[]) {
  const users = new Set(
    messages
      .filter((message) => message.info.role === "user" && message.parts.some((part) => record(part)?.type === "compaction"))
      .map((message) => message.info.id),
  )
  return messages
    .filter(
      (message) =>
      message.info.role === "assistant" &&
      message.info.summary === true &&
      typeof message.info.parentID === "string" &&
      users.has(message.info.parentID),
    )
    .sort((left, right) => right.info.id.localeCompare(left.info.id))[0]
}

function invalidCompactionBeforeNewestUser(messages: MessageRecord[]) {
  const summary = newestCompactionSummary(messages)
  if (!summary || (!summary.info.error && summaryText(summary))) return
  const laterUser = messages.some(
    (message) =>
      message.info.role === "user" &&
      message.info.id > summary.info.id &&
      !message.parts.some((part) => record(part)?.type === "compaction"),
  )
  return laterUser ? summary : undefined
}

async function sanitizeOverflowReplay(
  input: PluginInput,
  sessionID: string,
  messages: Parameters<typeof sanitizeHistory>[0],
  options: PluginOptions,
) {
  const summaries = messages
    .filter(
      (message) =>
        message.info.role === "assistant" &&
        record(message.info)?.summary === true &&
        isPluginValidSummary(summaryText(message as MessageRecord), options.max_summary_bytes),
    )
    .sort((left, right) => right.info.id.localeCompare(left.info.id))
  for (const summary of summaries) {
    const replay = messages
      .filter(
        (message) =>
          message.info.role === "user" &&
          message.info.id > summary.info.id &&
          !message.parts.some((part) => record(part)?.type === "compaction"),
      )
      .sort((left, right) => left.info.id.localeCompare(right.info.id))[0]
    if (!replay) continue
    if (!(await isOverflowReplay(input, sessionID, messages, summary as MessageRecord, replay))) continue
    sanitizeHistory([replay], options)
    return
  }
}

async function isOverflowReplay(
  input: PluginInput,
  sessionID: string,
  messages: ProviderMessage[],
  summary: MessageRecord,
  replay: ProviderMessage,
) {
  const parentID = summary.info.parentID
  const parent = parentID ? messages.find((message) => message.info.id === parentID) : undefined
  const compaction = parent?.parts.map(record).find((part) => part?.type === "compaction")
  if (compaction?.overflow !== true || compaction.auto !== true) return false
  if (
    replay.info.role !== "user" ||
    replay.info.id <= summary.info.id ||
    replay.parts.some((part) => record(part)?.type === "compaction") ||
    replay.parts.some((part) => record(record(part)?.metadata)?.compaction_continue === true)
  ) {
    return false
  }
  if (
    messages.some(
      (message) =>
        message.info.role === "assistant" &&
        message.info.id > summary.info.id &&
        message.info.id < replay.info.id,
    )
  ) {
    return false
  }
  const response = await input.client.session.messages({ path: { id: sessionID }, throwOnError: true })
  const durable = response.data as MessageRecord[] | undefined
  if (!durable) throw new Error(`opencode-safe-compaction could not load session metadata for ${sessionID}`)
  const originals = durable
    .filter(
      (message) =>
        message.info.role === "user" &&
        typeof parentID === "string" &&
        message.info.id < parentID &&
        !message.parts.some((part) => record(part)?.type === "compaction"),
    )
    .sort((left, right) => right.info.id.localeCompare(left.info.id))
  return originals.length >= 2 && replaySignature(originals[0]!.parts, true) === replaySignature(replay.parts)
}

function newestOrdinaryUser(messages: Parameters<typeof sanitizeHistory>[0]) {
  return messages
    .filter(
      (message) =>
        message.info.role === "user" && !message.parts.some((part) => record(part)?.type === "compaction"),
    )
    .sort((left, right) => right.info.id.localeCompare(left.info.id))[0]
}

function replaySignature(parts: unknown[], original = false) {
  const values = parts.flatMap((part) => {
    const value = record(part)
    if (!value || value.type === "compaction") return []
    if (
      original &&
      value.type === "file" &&
      typeof value.mime === "string" &&
      (value.mime.startsWith("image/") || value.mime === "application/pdf")
    ) {
      return [
        stripReplayIdentity({
          type: "text",
          text: `[Attached ${value.mime}: ${typeof value.filename === "string" ? value.filename : "file"}]`,
        }),
      ]
    }
    return [stripReplayIdentity(value)]
  })
  return JSON.stringify(values)
}

function stripReplayIdentity(value: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !["id", "messageID", "sessionID"].includes(key))
      .map(([key, item]) => [key, stableValue(item)])
      .sort((left, right) => String(left[0]).localeCompare(String(right[0]))),
  )
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  const data = record(value)
  if (!data) return value
  return Object.fromEntries(
    Object.entries(data)
      .map(([key, item]) => [key, stableValue(item)])
      .sort((left, right) => String(left[0]).localeCompare(String(right[0]))),
  )
}

function compactionTargetTextParts(
  data: unknown,
  input: { sessionID: string; messageID: string; partID: string },
) {
  const value = record(data)
  const info = record(value?.info)
  if (
    info?.id !== input.messageID ||
    info.sessionID !== input.sessionID ||
    info.role !== "assistant" ||
    info.summary !== true ||
    (info.mode !== "compaction" && info.agent !== "compaction")
  ) {
    return 0
  }
  if (!Array.isArray(value?.parts)) return 0
  const textParts = value.parts.filter((part) => record(part)?.type === "text")
  if (!textParts.some((part) => record(part)?.id === input.partID)) return 0
  return textParts.length
}

function headTailBytes(value: string, maxBytes: number) {
  const marker = "\n[… historical text omitted by opencode-safe-compaction …]\n"
  const budget = Math.max(0, maxBytes - utf8Bytes(marker))
  return takeUtf8(value, Math.floor(budget / 2)) + marker + takeUtf8(Array.from(value).reverse().join(""), Math.ceil(budget / 2), true)
}

function takeUtf8(value: string, maxBytes: number, reverse = false) {
  const result: string[] = []
  let bytes = 0
  for (const character of value) {
    const size = utf8Bytes(character)
    if (bytes + size > maxBytes) break
    result.push(character)
    bytes += size
  }
  return reverse ? result.reverse().join("") : result.join("")
}
