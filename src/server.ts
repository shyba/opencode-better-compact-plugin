import type { Config, Hooks, PluginInput, PluginOptions as OpenCodePluginOptions } from "@opencode-ai/plugin"
import { LEDGER_LIMITS, buildRecoveryLedger, record, summaryText, utf8Bytes, type MessageRecord } from "./ledger.js"
import { SELECTED_MODEL, parseOptions, resolveOptions, type PluginOptions } from "./options.js"
import { decodedDataUrlBytes, sanitizeHistory } from "./sanitize.js"
import { AttemptStore, type Attempt } from "./state.js"
import {
  buildAuthoritativeSummary,
  buildCompactionPrompt,
  isAuthoritativeSummary,
  isPluginValidSummary,
  parsePluginLedger,
  recoveryContext,
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

type ProviderMessage = Parameters<typeof sanitizeHistory>[0][number]
type SessionMessagesOptions = Parameters<PluginInput["client"]["session"]["messages"]>[0]
type SessionMessagesQuery = NonNullable<SessionMessagesOptions["query"]> & { before?: string }

const REPLAY_SIGNATURE_MAX_BYTES = 8 * 1_024 * 1_024
const REPLAY_SIGNATURE_MAX_NODES = 8_192
const REPLAY_SIGNATURE_MAX_DEPTH = 32

export { decodedDataUrlBytes, sanitizeHistory } from "./sanitize.js"

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
      const compactionAgent = {
        ...config.agent?.compaction,
        temperature: 0,
      }
      if (settings.model === SELECTED_MODEL) delete compactionAgent.model
      else compactionAgent.model = settings.model
      config.agent = {
        ...config.agent,
        compaction: compactionAgent,
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
        (total, part) => total + (part.type === "text" ? utf8Bytes(part.text) : 0),
        0,
      )
      if (textBytes > options.max_user_text_bytes) {
        throw new RangeError(
          `opencode-safe-compaction rejected a ${textBytes}-byte user message (limit ${options.max_user_text_bytes}). Use file references or send smaller chunks.`,
        )
      }
      const inline = output.parts.flatMap((part) =>
        part.type === "file" && /^data:/i.test(part.url) ? [part] : []
      )
      const encodedInlineLimit = options.max_inline_data_bytes * 3 + 16_384
      const encodedInlineCharacters = inline.reduce(
        (total, part) => total + part.url.length,
        0,
      )
      if (encodedInlineCharacters > encodedInlineLimit) {
        throw new RangeError(
          `opencode-safe-compaction rejected at least ${encodedInlineCharacters} encoded inline-data bytes (limit ${encodedInlineLimit}). Use file references or send smaller attachments.`,
        )
      }
      const encodedInlineBytes = inline.reduce((total, part) => total + utf8Bytes(part.url), 0)
      if (encodedInlineBytes > encodedInlineLimit) {
        throw new RangeError(
          `opencode-safe-compaction rejected ${encodedInlineBytes} encoded inline-data bytes (limit ${encodedInlineLimit}). Use file references or send smaller attachments.`,
        )
      }
      const inlineBytes = inline.reduce(
        (total, part) =>
          total + decodedDataUrlBytes(
            part.url,
            Math.max(0, options.max_inline_data_bytes - total),
            encodedInlineLimit,
          ),
        0,
      )
      if (inlineBytes > options.max_inline_data_bytes) {
        throw new RangeError(
          `opencode-safe-compaction rejected ${inlineBytes} decoded inline-data bytes or more (limit ${options.max_inline_data_bytes}). Use file references or send smaller attachments.`,
        )
      }
    },

    async "experimental.session.compacting"({ sessionID }, output) {
      await guardInternalHook("experimental.session.compacting", sessionID, async () => {
        const options = requireSettings(settings, parsed)
        const data = await loadSession(input, sessionID)
        const priorSummary = await newestPriorPluginSummaryFromSession(
          input,
          sessionID,
          data.messages,
          data.nextCursor,
          undefined,
          options.max_summary_bytes,
        )
        const ledger = buildRecoveryLedger({
          messages: data.messages,
          todos: data.todos,
          tailTurns: options.tail_turns,
          maxBytes: options.max_ledger_bytes,
          ...(priorSummary ? { priorSummary } : {}),
        })
        attempts.set({
          sessionID,
          createdAt: Date.now(),
          ledger,
          validation: "pending",
        })
        output.prompt = buildCompactionPrompt(ledger, options.max_summary_bytes)
      }, () => {
        attempts.delete(sessionID)
      })
    },

    async "experimental.chat.messages.transform"(_, output) {
      const sessionID = output.messages[0]?.info.sessionID
      await guardInternalHook("experimental.chat.messages.transform", sessionID, async () => {
        const options = requireSettings(settings, parsed)
        if (!sessionID || output.messages.some((message) => message.info.sessionID !== sessionID)) return
        const messageIDs = new Set<string>()
        if (output.messages.some((message) => {
          if (!message.info.id || messageIDs.has(message.info.id)) return true
          messageIDs.add(message.info.id)
          return false
        })) {
          throw new Error("duplicate model-visible message identity")
        }
        let attempt = attempts.get(sessionID)
        const invalid = invalidCompactionBeforeNewestUser(output.messages as MessageRecord[], options.max_summary_bytes)
        if (!attempt && invalid) {
          attempt = await rebuildAttempt(input, options, sessionID, invalid.info.id)
          attempts.set(attempt)
        }
        if (attempt?.summaryMessageID && !invalid) {
          attempts.delete(sessionID)
          attempt = undefined
        }
        if (!attempt) {
          await sanitizeOverflowReplay(input, sessionID, output.messages, options)
          return
        }

        const recoveryUser = invalid ? newestOrdinaryUser(output.messages) : undefined
        if (attempt.recoveryComplete) return
        const overflowRecovery = invalid && recoveryUser
          ? await isOverflowReplay(input, sessionID, output.messages, invalid, recoveryUser)
          : false
        const recoveryPartID = `safe-compaction-recovery-${attempt.ledger.digest.slice(0, 16)}`
        const recoveryPart = invalid && recoveryUser && !recoveryUser.parts.some((part) => record(part)?.id === recoveryPartID)
          ? {
            id: recoveryPartID,
            sessionID,
            messageID: recoveryUser.info.id,
            type: "text" as const,
            synthetic: true,
            text: recoveryContext(attempt.ledger),
          }
          : undefined
        // Preserve the initial selected-model history so providers can reuse an existing
        // prompt-cache prefix. Recovery, overflow replay, and dedicated-model compaction
        // still use the bounded transformed history.
        const cachePreservingInitialCompaction = options.model === SELECTED_MODEL && !invalid && !recoveryUser
        if (!cachePreservingInitialCompaction) {
          sanitizeHistory(
            recoveryUser && !overflowRecovery ? output.messages.filter((message) => message !== recoveryUser) : output.messages,
            options,
          )
        }
        if (!recoveryUser || !recoveryPart) return
        recoveryUser.parts = [...recoveryUser.parts, recoveryPart]
        attempt.recoveryUserID = recoveryUser.info.id
      }, () => {
        attempts.delete(sessionID)
      })
    },

    async "chat.params"(hookInput, output) {
      if (hookInput.agent !== "compaction") return
      const options = requireSettings(settings, parsed)
      const actual = `${hookInput.model.providerID}/${hookInput.model.id}`
      if (options.model !== SELECTED_MODEL && actual !== options.model) {
        throw new Error(`opencode-safe-compaction expected compaction model ${options.model}, received ${actual}`)
      }
      if (hookInput.model.limit.output <= 0) {
        throw new RangeError(`opencode-safe-compaction cannot use ${actual} with a zero output limit`)
      }
      const runtimeLimit = record(hookInput.model.limit)
      const explicitInput = typeof runtimeLimit?.input === "number" && runtimeLimit.input > 0
        ? runtimeLimit.input
        : undefined
      const usableInput = hookInput.model.limit.context === 0
        ? 0
        : explicitInput
          ? Math.max(0, explicitInput - options.reserved_tokens)
          : output.maxOutputTokens === undefined
            ? undefined
            : Math.max(0, hookInput.model.limit.context - output.maxOutputTokens)
      if (usableInput !== undefined && usableInput <= 0) {
        throw new RangeError(
          `opencode-safe-compaction has no usable input in ${actual} after applying OpenCode's compaction limits`,
        )
      }
      if (output.temperature !== undefined) output.temperature = 0
      if (output.maxOutputTokens === undefined) return
      const maxOutputTokens = Math.min(
        output.maxOutputTokens,
        options.max_output_tokens,
        hookInput.model.limit.output,
      )
      if (!Number.isFinite(maxOutputTokens) || maxOutputTokens <= 0) {
        throw new RangeError(`opencode-safe-compaction cannot use ${actual} with maxOutputTokens=${maxOutputTokens}`)
      }
      output.maxOutputTokens = maxOutputTokens
    },

    async "experimental.text.complete"(hookInput, output) {
      await guardInternalHook("experimental.text.complete", hookInput.sessionID, async () => {
        const options = requireSettings(settings, parsed)
        const target = await input.client.session.message({
          path: { id: hookInput.sessionID, messageID: hookInput.messageID },
          throwOnError: true,
        })
        const targetTextParts = compactionTargetTextParts(target.data, hookInput)
        if (!targetTextParts) return
        const data = await loadSession(input, hookInput.sessionID)
        if (!hasCompactionParent(data.messages, hookInput)) return

        let attempt = attempts.get(hookInput.sessionID)
        if (!attempt || (attempt.summaryMessageID && attempt.summaryMessageID !== hookInput.messageID)) {
          attempt = await rebuildAttempt(input, options, hookInput.sessionID, hookInput.messageID, data)
          attempts.set(attempt)
        }
        if (attempt.textPartID && attempt.textPartID !== hookInput.partID) {
          output.text = ""
          return
        }
        attempt.textPartID = hookInput.partID
        attempt.summaryMessageID = hookInput.messageID
        const text = buildAuthoritativeSummary({
          ledger: attempt.ledger,
          maxBytes: options.max_summary_bytes,
        })
        const validation = targetTextParts >= 1 && isAuthoritativeSummary(text, options.max_summary_bytes)
          ? "fallback"
          : "invalid"
        output.text = text
        attempt.validation = validation
      }, () => {
        const attempt = attempts.get(hookInput.sessionID)
        if (!attempt) return
        attempt.summaryMessageID = hookInput.messageID
        attempt.validation = "invalid"
      })
    },

    async "experimental.compaction.autocontinue"(hookInput, output) {
      if (!output.enabled) return
      await guardInternalHook("experimental.compaction.autocontinue", hookInput.sessionID, async () => {
        const options = requireSettings(settings, parsed)
        const active = attempts.get(hookInput.sessionID)
        const data = await loadSession(input, hookInput.sessionID)
        const current = compactionSummaryForParent(data.messages, hookInput.message.id)
        const text = current ? summaryText(current, options.max_summary_bytes) : ""
        const parsedLedger = text ? parsePluginLedger(text) : undefined
        let valid = false
        if (
          current &&
          !(active?.summaryMessageID === current.info.id && active.validation === "invalid") &&
          parsedLedger &&
          isAuthoritativeSummary(text, options.max_summary_bytes)
        ) {
          const rebuilt = await rebuildAttempt(input, options, hookInput.sessionID, current.info.id, data)
          if (rebuilt.ledger.block === parsedLedger.block) {
            valid = true
          }
        }
        output.enabled = valid
        attempts.delete(hookInput.sessionID)
      }, () => {
        output.enabled = false
        attempts.delete(hookInput.sessionID)
      })
    },

    async event({ event }) {
      const properties = record(event.properties)
      const info = record(properties?.info)
      const sessionID = typeof properties?.sessionID === "string"
        ? properties.sessionID
        : typeof info?.id === "string"
          ? info.id
          : undefined
      await guardInternalHook("event", sessionID, async () => {
        if (event.type === "session.compacted") {
          attempts.delete(sessionID)
          return
        }
        if (event.type === "session.idle") {
          const attempt = sessionID ? attempts.get(sessionID) : undefined
          if (attempt?.recoveryUserID) attempt.recoveryComplete = true
          else attempts.delete(sessionID)
          return
        }
        if (event.type === "session.status" && record(properties?.status)?.type === "idle") {
          const attempt = sessionID ? attempts.get(sessionID) : undefined
          if (attempt?.recoveryUserID) attempt.recoveryComplete = true
          else attempts.delete(sessionID)
          return
        }
        if (event.type === "session.deleted") {
          attempts.delete(sessionID)
          return
        }
        if (event.type === "session.error") {
          if (sessionID) attempts.delete(sessionID)
          else attempts.cleanupExpired()
          return
        }
        attempts.cleanupExpired()
      })
    },

    async dispose() {
      attempts.clear()
    },
  } satisfies Hooks

  return hooks
}

async function guardInternalHook(
  hook: string,
  sessionID: string | undefined,
  operation: () => Promise<void>,
  recover: () => void = () => {},
) {
  try {
    await operation()
  } catch (error) {
    try {
      recover()
    } catch {
      // Cleanup is best-effort and must not turn an internal plugin fault into a host failure.
    }
    try {
      console.warn("opencode-safe-compaction degraded safely after an internal hook failure", {
        hook,
        ...(sessionID ? { sessionID } : {}),
        error: safeErrorClass(error),
      })
    } catch {
      // Logging is best-effort and must never affect the host.
    }
  }
}

function safeErrorClass(error: unknown) {
  if (error instanceof TypeError) return "TypeError"
  if (error instanceof RangeError) return "RangeError"
  if (error instanceof Error) return "Error"
  return "NonError"
}

async function rebuildAttempt(
  input: PluginInput,
  options: PluginOptions,
  sessionID: string,
  summaryMessageID: string,
  loaded?: Awaited<ReturnType<typeof loadSession>>,
): Promise<Attempt> {
  const data = loaded ?? (await loadSession(input, sessionID))
  const priorSummary = await newestPriorPluginSummaryFromSession(
    input,
    sessionID,
    data.messages,
    data.nextCursor,
    summaryMessageID,
    options.max_summary_bytes,
  )
  return {
    sessionID,
    createdAt: Date.now(),
    ledger: buildRecoveryLedger({
      messages: data.messages,
      todos: data.todos,
      tailTurns: options.tail_turns,
      maxBytes: options.max_ledger_bytes,
      excludeSummaryID: summaryMessageID,
      ...(priorSummary ? { priorSummary } : {}),
    }),
    summaryMessageID,
    validation: "pending",
  } satisfies Attempt
}

async function loadSession(input: PluginInput, sessionID: string) {
  const [messages, todos] = await Promise.all([
    loadMessagePage(input, sessionID, LEDGER_LIMITS.messages),
    input.client.session.todo({ path: { id: sessionID }, throwOnError: true }),
  ])
  if (!todos.data) throw new Error(`opencode-safe-compaction could not load session metadata for ${sessionID}`)
  return { messages: messages.messages, todos: todos.data, nextCursor: messages.nextCursor }
}

async function loadMessagePage(input: PluginInput, sessionID: string, limit: number, before?: string) {
  const query: SessionMessagesQuery = { limit, ...(before ? { before } : {}) }
  const response = await input.client.session.messages({
    path: { id: sessionID },
    query,
    throwOnError: true,
  })
  if (!response.data) throw new Error(`opencode-safe-compaction could not load session metadata for ${sessionID}`)
  if (response.data.length > limit) {
    throw new Error(`opencode-safe-compaction received an oversized message page for ${sessionID}`)
  }
  const messages = response.data as MessageRecord[]
  if (messages.some((message) => message.info.sessionID !== sessionID)) {
    throw new Error(`opencode-safe-compaction received a cross-session message page for ${sessionID}`)
  }
  const messageIDs = new Set<string>()
  for (const message of messages) {
    if (typeof message.info.id !== "string" || !message.info.id || messageIDs.has(message.info.id)) {
      throw new Error(`opencode-safe-compaction received duplicate message identity for ${sessionID}`)
    }
    messageIDs.add(message.info.id)
  }
  const nextCursor = response.response?.headers.get("X-Next-Cursor") || undefined
  if (nextCursor && nextCursor.length > 512) {
    throw new Error(`opencode-safe-compaction received an oversized message cursor for ${sessionID}`)
  }
  return { messages, nextCursor }
}

function requireSettings(settings: PluginOptions | undefined, parsed: ReturnType<typeof parseOptions>) {
  return settings ?? resolveOptions(parsed)
}

function newestCompactionSummary(messages: MessageRecord[]) {
  return compactionSummaries(messages)[0]
}

function chronological<T extends { info: object }>(messages: T[]) {
  const created = (message: T) => {
    const value = record(record(message.info)?.time)?.created
    return typeof value === "number" && Number.isFinite(value) ? value : undefined
  }
  if (!messages.every((message) => created(message) !== undefined)) return [...messages]
  return messages
    .map((message, index) => ({ message, index }))
    .sort(
      (left, right) =>
        Number(created(left.message)) - Number(created(right.message)) || left.index - right.index,
    )
    .map((item) => item.message)
}

function compactionSummaries(messages: MessageRecord[]) {
  const users = new Map(
    messages
      .filter(
        (message) =>
          message.info.role === "user" &&
          message.parts.some((part) => {
            const value = record(part)
            return value?.type === "compaction" &&
              value.sessionID === message.info.sessionID &&
              value.messageID === message.info.id
          }),
      )
      .map((message) => [message.info.id, message.info.sessionID]),
  )
  return chronological(messages)
    .filter(
      (message) =>
        message.info.role === "assistant" &&
        message.info.summary === true &&
        typeof message.info.parentID === "string" &&
        users.get(message.info.parentID) === message.info.sessionID &&
        record(message.info)?.mode === "compaction" &&
        record(message.info)?.agent === "compaction",
    )
    .reverse()
}

async function newestPriorPluginSummaryFromSession(
  input: PluginInput,
  sessionID: string,
  messages: MessageRecord[],
  nextCursor: string | undefined,
  excludeID: string | undefined,
  maxBytes: number,
) {
  const recent = await newestPriorPluginSummaryOnPage(input, sessionID, messages, excludeID, maxBytes)
  if (recent) return recent
  const cursors = new Set<string>()
  const messageIDs = new Set(messages.map((message) => message.info.id))
  let pages = 1
  let before = nextCursor
  while (before && pages < LEDGER_LIMITS.message_pages) {
    if (cursors.has(before)) {
      throw new Error(`opencode-safe-compaction received a repeated message cursor for ${sessionID}`)
    }
    cursors.add(before)
    const page = await loadMessagePage(input, sessionID, LEDGER_LIMITS.message_page, before)
    rememberPageMessageIDs(page.messages, messageIDs, sessionID)
    pages++
    const prior = await newestPriorPluginSummaryOnPage(input, sessionID, page.messages, excludeID, maxBytes)
    if (prior) return prior
    if (page.messages.length === 0 && page.nextCursor) {
      throw new Error(`opencode-safe-compaction received an empty paginated message page for ${sessionID}`)
    }
    before = page.nextCursor
  }
}

async function newestPriorPluginSummaryOnPage(
  input: PluginInput,
  sessionID: string,
  messages: MessageRecord[],
  excludeID: string | undefined,
  maxBytes: number,
) {
  const summaries = messages
    .filter(
      (message) =>
        message.info.role === "assistant" &&
        message.info.sessionID === sessionID &&
        message.info.summary === true &&
        typeof message.info.parentID === "string" &&
        record(message.info)?.mode === "compaction" &&
        record(message.info)?.agent === "compaction" &&
        message.info.id !== excludeID,
    )
    .reverse()
  for (const summary of summaries) {
    const text = summaryText(summary, maxBytes)
    if (!isPluginValidSummary(text, maxBytes) || !summary.info.parentID) continue
    const embedded = messages.find((message) => message.info.id === summary.info.parentID)
    if (embedded) {
      if (!isCompactionParent(embedded, sessionID, summary.info.parentID)) continue
      const ledger = parsePluginLedger(text)
      if (ledger) return { id: summary.info.id, ledger }
      continue
    }
    const parent = await input.client.session.message({
      path: { id: sessionID, messageID: summary.info.parentID },
      throwOnError: false,
    })
    if (!parent.data) {
      if (parent.response?.status === 400 || parent.response?.status === 404) continue
      throw new Error(
        `opencode-safe-compaction could not validate compaction parent ${summary.info.parentID} for ${sessionID}`,
      )
    }
    const data = parent.data as MessageRecord
    if (!isCompactionParent(data, sessionID, summary.info.parentID)) continue
    const ledger = parsePluginLedger(text)
    if (ledger) return { id: summary.info.id, ledger }
  }
}

function isCompactionParent(message: MessageRecord, sessionID: string, messageID: string) {
  return message.info.id === messageID &&
    message.info.sessionID === sessionID &&
    message.info.role === "user" &&
    message.parts.some((part) => {
      const value = record(part)
      return value?.type === "compaction" && value.sessionID === sessionID && value.messageID === messageID
    })
}

function rememberPageMessageIDs(messages: MessageRecord[], seen: Set<string>, sessionID: string) {
  for (const message of messages) {
    if (seen.has(message.info.id)) {
      throw new Error(`opencode-safe-compaction received overlapping message pages for ${sessionID}`)
    }
    seen.add(message.info.id)
  }
}

function compactionSummaryForParent(messages: MessageRecord[], parentID: string) {
  const parent = messages.find(
    (message) =>
      message.info.id === parentID &&
      message.info.role === "user" &&
      message.parts.some((part) => {
        const value = record(part)
        return value?.type === "compaction" && value.sessionID === message.info.sessionID && value.messageID === parentID
      }),
  )
  if (!parent) return
  return chronological(messages)
    .filter(
      (message) =>
        message.info.role === "assistant" &&
        message.info.summary === true &&
        message.info.parentID === parentID &&
        record(message.info)?.mode === "compaction" &&
        record(message.info)?.agent === "compaction",
    )
    .at(-1)
}

function invalidCompactionBeforeNewestUser(messages: MessageRecord[], maxSummaryBytes: number) {
  const ordered = chronological(messages)
  const summary = newestCompactionSummary(ordered)
  if (!summary || (!summary.info.error && isAuthoritativeSummary(summaryText(summary, maxSummaryBytes), maxSummaryBytes))) return
  const summaryIndex = ordered.indexOf(summary)
  const laterUser = ordered
    .slice(summaryIndex + 1)
    .findLast(
      (message) =>
        message.info.role === "user" &&
        !message.parts.some((part) => record(part)?.type === "compaction"),
    )
  if (!laterUser) return
  return summary
}

async function sanitizeOverflowReplay(
  input: PluginInput,
  sessionID: string,
  messages: Parameters<typeof sanitizeHistory>[0],
  options: PluginOptions,
) {
  const ordered = chronological(messages)
  const summaries = ordered
    .filter(
      (message) =>
        message.info.role === "assistant" &&
        record(message.info)?.summary === true &&
        isAuthoritativeSummary(
          summaryText(message as MessageRecord, options.max_summary_bytes),
          options.max_summary_bytes,
        ),
    )
    .reverse()
  for (const summary of summaries) {
    const replay = ordered
      .slice(ordered.indexOf(summary) + 1)
      .find(
        (message) =>
          message.info.role === "user" &&
          !message.parts.some((part) => record(part)?.type === "compaction"),
      )
    if (!replay) continue
    if (!(await isOverflowReplay(input, sessionID, ordered, summary as MessageRecord, replay))) continue
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
  const ordered = chronological(messages)
  const parentID = summary.info.parentID
  const parentIndex = parentID ? ordered.findIndex((message) => message.info.id === parentID) : -1
  const summaryIndex = ordered.findIndex((message) => message === summary)
  const replayIndex = ordered.findIndex((message) => message === replay)
  const parent = parentIndex >= 0 ? ordered[parentIndex] : undefined
  const compaction = parent?.parts.map(record).find((part) => part?.type === "compaction")
  if (compaction?.overflow !== true || compaction.auto !== true) return false
  if (
    replay.info.role !== "user" ||
    parentIndex < 0 ||
    summaryIndex <= parentIndex ||
    replayIndex <= summaryIndex ||
    replay.parts.some((part) => record(part)?.type === "compaction") ||
    replay.parts.some((part) => record(record(part)?.metadata)?.compaction_continue === true)
  ) {
    return false
  }
  if (
    ordered.slice(summaryIndex + 1, replayIndex).some((message) => message.info.role === "assistant")
  ) {
    return false
  }
  const originals: MessageRecord[] = []
  const cursors = new Set<string>()
  const messageIDs = new Set<string>()
  let foundParent = false
  let pages = 0
  let before: string | undefined
  while (originals.length < 2 && pages < LEDGER_LIMITS.message_pages) {
    if (before) {
      if (cursors.has(before)) {
        throw new Error(`opencode-safe-compaction received a repeated message cursor for ${sessionID}`)
      }
      cursors.add(before)
    }
    const page = await loadMessagePage(input, sessionID, LEDGER_LIMITS.message_page, before)
    rememberPageMessageIDs(page.messages, messageIDs, sessionID)
    pages++
    const durableParentIndex = foundParent
      ? -1
      : page.messages.findIndex((message) => message.info.id === parentID)
    if (!foundParent && durableParentIndex >= 0) {
      const durableParent = page.messages[durableParentIndex]
      if (!durableParent || !parentID || !isCompactionParent(durableParent, sessionID, parentID)) return false
      foundParent = true
    }
    const eligible = (foundParent && durableParentIndex >= 0
      ? page.messages.slice(0, durableParentIndex)
      : foundParent
        ? page.messages
        : [])
      .filter(
        (message) =>
          message.info.role === "user" &&
          partsBelongToMessage(message) &&
          !message.parts.some((part) => record(part)?.type === "compaction"),
      )
      .reverse()
    originals.push(...eligible.slice(0, 2 - originals.length))
    if (originals.length >= 2 || !page.nextCursor) break
    if (page.messages.length === 0) {
      throw new Error(`opencode-safe-compaction received an empty paginated message page for ${sessionID}`)
    }
    before = page.nextCursor
  }
  const originalSignature = originals.length >= 2 ? replaySignature(originals[0]!.parts, true) : undefined
  const candidateSignature = originalSignature ? replaySignature(replay.parts) : undefined
  return originalSignature !== undefined && originalSignature === candidateSignature
}

function partsBelongToMessage(message: MessageRecord) {
  return message.parts.length > 0 && message.parts.every((part) => {
    const value = record(part)
    return value?.sessionID === message.info.sessionID && value.messageID === message.info.id
  })
}

function newestOrdinaryUser(messages: Parameters<typeof sanitizeHistory>[0]) {
  return chronological(messages)
    .filter(
      (message) =>
        message.info.role === "user" && !message.parts.some((part) => record(part)?.type === "compaction"),
    )
    .at(-1)
}

function replaySignature(parts: unknown[], original = false) {
  if (parts.length > REPLAY_SIGNATURE_MAX_NODES) return
  const hasher = new Bun.CryptoHasher("sha256")
  const budget = { bytes: REPLAY_SIGNATURE_MAX_BYTES, nodes: REPLAY_SIGNATURE_MAX_NODES }
  for (const part of parts) {
    const value = record(part)
    if (!value || value.type === "compaction") continue
    if (
      original &&
      value.type === "file" &&
      typeof value.mime === "string" &&
      (value.mime.startsWith("image/") || value.mime === "application/pdf")
    ) {
      const filename = typeof value.filename === "string" ? value.filename : "file"
      if (value.mime.length > 256 || filename.length > budget.bytes) return
      if (!hashReplayValue(hasher, {
        type: "text",
        text: `[Attached ${value.mime}: ${filename}]`,
      }, budget)) return
      continue
    }
    if (!hashReplayValue(hasher, value, budget)) return
  }
  return hasher.digest("hex")
}

function hashReplayValue(
  hasher: Bun.CryptoHasher,
  value: unknown,
  budget: { bytes: number; nodes: number },
  depth = 0,
): boolean {
  if (depth >= REPLAY_SIGNATURE_MAX_DEPTH || budget.nodes-- <= 0) return false
  if (value === null) {
    hasher.update("null;")
    return true
  }
  if (typeof value === "string") {
    if (value.length > budget.bytes) return false
    const bytes = utf8Bytes(value)
    if (bytes > budget.bytes) return false
    budget.bytes -= bytes
    hasher.update(`string:${bytes}:`).update(value).update(";")
    return true
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    hasher.update(`${typeof value}:${String(value)};`)
    return true
  }
  if (Array.isArray(value)) {
    if (value.length > budget.nodes) return false
    hasher.update(`array:${value.length}:[`)
    for (const item of value) {
      if (!hashReplayValue(hasher, item, budget, depth + 1)) return false
    }
    hasher.update("];")
    return true
  }
  const data = record(value)
  if (!data) {
    hasher.update(`${typeof value};`)
    return true
  }
  const keys: string[] = []
  for (const key in data) {
    if (!Object.hasOwn(data, key) || ["id", "messageID", "sessionID"].includes(key)) continue
    keys.push(key)
    if (keys.length > budget.nodes) return false
  }
  keys.sort()
  hasher.update(`object:${keys.length}:{`)
  for (const key of keys) {
    if (key.length > budget.bytes) return false
    const bytes = utf8Bytes(key)
    if (bytes > budget.bytes) return false
    budget.bytes -= bytes
    hasher.update(`key:${bytes}:${key};`)
    if (!hashReplayValue(hasher, data[key], budget, depth + 1)) return false
  }
  hasher.update("};")
  return true
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
    info.mode !== "compaction" ||
    info.agent !== "compaction"
  ) {
    return 0
  }
  if (!Array.isArray(value?.parts)) return 0
  const textParts = value.parts.filter((part) => record(part)?.type === "text")
  if (
    !textParts.some((part) => {
      const value = record(part)
      return value?.id === input.partID && value.sessionID === input.sessionID && value.messageID === input.messageID
    })
  ) {
    return 0
  }
  return textParts.length
}

function hasCompactionParent(
  messages: MessageRecord[],
  input: { sessionID: string; messageID: string },
) {
  const summary = messages.find(
    (message) =>
      message.info.id === input.messageID &&
      message.info.sessionID === input.sessionID &&
      message.info.role === "assistant",
  )
  if (typeof summary?.info.parentID !== "string") return false
  return messages.some(
    (message) =>
      message.info.id === summary.info.parentID &&
      message.info.sessionID === input.sessionID &&
      message.info.role === "user" &&
      message.parts.some((part) => {
        const value = record(part)
        return value?.type === "compaction" && value.sessionID === input.sessionID && value.messageID === message.info.id
      }),
  )
}
