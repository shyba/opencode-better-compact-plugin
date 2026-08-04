export const LEDGER_VERSION = 1
export const LEDGER_START = "<!-- opencode-safe-compaction recovery-ledger v1 start -->"
export const LEDGER_END = "<!-- opencode-safe-compaction recovery-ledger v1 end -->"
export const LEDGER_LIMITS = {
  messages: 10_000,
  message_page: 256,
  message_pages: 256,
  parts_per_message: 256,
  compaction_parts_scanned: 4_096,
  user_parts_scanned: 8_192,
  history_parts_scanned: 8_192,
  todos_scanned: 4_096,
  recent_requests: 64,
  constraints: 16,
  todos: 32,
  touched_paths: 64,
  tool_statuses: 48,
  errors: 24,
  evidence: 32,
  next_actions: 16,
  legacy_context: 2,
  compact_source_bytes: 65_536,
  tool_output_source_bytes: 65_536,
  tool_input_nodes: 1_024,
} as const

export type MessageRecord = {
  info: {
    id: string
    sessionID: string
    role: "user" | "assistant"
    summary?: boolean
    error?: unknown
    finish?: string
    parentID?: string
    time?: { created: number }
  }
  parts: unknown[]
}

export type TodoRecord = {
  id?: string
  content?: string
  status?: string
  priority?: string
}

export type RecoveryLedgerData = {
  recent_requests: string[]
  constraints: string[]
  todos: Array<{ id: string; status: string; priority: string; content: string }>
  touched_paths: string[]
  tool_statuses: Array<{ tool: string; status: string; title?: string }>
  errors: string[]
  evidence: string[]
  next_actions: string[]
  legacy_context: string[]
}

export type RecoveryLedger = {
  data: RecoveryLedgerData
  body: string
  digest: string
  block: string
}

export function utf8Bytes(value: string) {
  let bytes = 0
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code <= 0x7f) {
      bytes++
      continue
    }
    if (code <= 0x7ff) {
      bytes += 2
      continue
    }
    if (hasSurrogatePair(value, index)) {
      bytes += 4
      index++
      continue
    }
    bytes += 3
  }
  return bytes
}

export function truncateUtf8(value: string, maxBytes: number) {
  if (utf8Bytes(value) <= maxBytes) return value
  const marker = "…[truncated]"
  const markerBytes = utf8Bytes(marker)
  if (maxBytes <= markerBytes) return marker.slice(0, utf8PrefixEnd(marker, Math.max(0, maxBytes)))
  const budget = maxBytes - markerBytes
  return value.slice(0, utf8PrefixEnd(value, budget)) + marker
}

export function redact(value: string) {
  return value
    .replace(
      /(["']?(?:[a-z0-9_-]{0,64}(?:api[_-]?key|password|passwd|secret|token|private[_-]?key|access[_-]?key(?:[_-]?id)?|credential)|authorization)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/gi,
      "$1[REDACTED]",
    )
    .replace(
      /(^|[\s{,?&])(["']?(?:[a-z0-9_-]{0,64}(?:api[_-]?key|password|passwd|secret|token|private[_-]?key|access[_-]?key(?:[_-]?id)?|credential)|authorization)["']?\s*[:=]\s*)(?:(?:bearer|basic)\s+)?[^\s,}&]+/gim,
      "$1$2[REDACTED]",
    )
    .replace(/\b(sk-[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9]{12,}|github_pat_[A-Za-z0-9_]{12,}|AKIA[A-Z0-9]{16})\b/g, "[REDACTED]")
    .replace(/\b(?![a-f0-9]{40,}\b)[A-Za-z0-9+/]{40,}={0,2}\b/gi, "[REDACTED]")
}

export function sha256(value: string) {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex")
}

export function canonicalLedger(data: RecoveryLedgerData) {
  const body = JSON.stringify(data, null, 2)
  const digest = sha256(body)
  return {
    data,
    body,
    digest,
    block: `${LEDGER_START}\nversion: ${LEDGER_VERSION}\nsha256: ${digest}\n\`\`\`json\n${body}\n\`\`\`\n${LEDGER_END}`,
  } satisfies RecoveryLedger
}

export function buildRecoveryLedger(input: {
  messages: MessageRecord[]
  todos: TodoRecord[]
  tailTurns: number
  maxBytes: number
  excludeSummaryID?: string
  priorSummary?: { id: string; ledger: RecoveryLedger }
}) {
  const firstMessage = Math.max(0, input.messages.length - LEDGER_LIMITS.messages)
  const compactionUsers = new Set<string>()
  let newestCompactionUserID: string | undefined
  let compactionPartsScanned = 0
  for (let messageIndex = input.messages.length - 1; messageIndex >= firstMessage; messageIndex--) {
    if (compactionPartsScanned >= LEDGER_LIMITS.compaction_parts_scanned) break
    const message = input.messages[messageIndex]
    if (!message || message.info.role !== "user") continue
    const partCount = boundedPartCount(message.parts)
    const inspectCount = Math.min(partCount, LEDGER_LIMITS.compaction_parts_scanned - compactionPartsScanned)
    for (let partIndex = partCount - 1; partIndex >= partCount - inspectCount; partIndex--) {
      if (record(boundedPart(message.parts, partIndex))?.type !== "compaction") continue
      compactionUsers.add(message.info.id)
      newestCompactionUserID ??= message.info.id
      break
    }
    compactionPartsScanned += inspectCount
  }
  const requestLimit = Math.max(1, Math.min(input.tailTurns, LEDGER_LIMITS.recent_requests))
  const userRequests: string[] = []
  const constraints: string[] = []
  const constraintSet = new Set<string>()
  const touchedPaths = new Set<string>()
  const toolStatuses: RecoveryLedgerData["tool_statuses"] = []
  const errors: string[] = []
  const errorSet = new Set<string>()
  const evidence: string[] = []
  const evidenceSet = new Set<string>()
  const legacyContext: string[] = []
  let userPartsScanned = 0
  let historyPartsScanned = 0
  let toolInputNodes = 0

  for (let messageIndex = input.messages.length - 1; messageIndex >= firstMessage; messageIndex--) {
    const message = input.messages[messageIndex]
    if (!message) continue
    const compactionUser = compactionUsers.has(message.info.id)
    const compactionAssistant =
      message.info.role === "assistant" && Boolean(message.info.parentID && compactionUsers.has(message.info.parentID))

    if (
      legacyContext.length < LEDGER_LIMITS.legacy_context &&
      message.info.role === "assistant" &&
      message.info.summary === true &&
      (!newestCompactionUserID || message.info.parentID !== newestCompactionUserID) &&
      message.info.id !== input.excludeSummaryID &&
      message.info.id !== input.priorSummary?.id
    ) {
      legacyContext.push(`Untrusted legacy summary ${compact(message.info.id, 96)} omitted`)
    }
    if (compactionUser || compactionAssistant) continue

    const partCount = boundedPartCount(message.parts)
    if (
      message.info.role === "user" &&
      userPartsScanned < LEDGER_LIMITS.user_parts_scanned &&
      (userRequests.length < requestLimit || constraints.length < LEDGER_LIMITS.constraints)
    ) {
      const inspectCount = Math.min(partCount, LEDGER_LIMITS.user_parts_scanned - userPartsScanned)
      const firstPart = partCount - inspectCount
      if (userRequests.length < requestLimit) {
        const request = compactUserTurn(message.parts, firstPart, partCount, 640)
        if (request) userRequests.push(request)
      }
      if (constraints.length < LEDGER_LIMITS.constraints) {
        for (
          let partIndex = partCount - 1;
          partIndex >= firstPart && constraints.length < LEDGER_LIMITS.constraints;
          partIndex--
        ) {
          const value = record(boundedPart(message.parts, partIndex))
          if (!recoverableUserText(value)) continue
          const lines = boundedSource(value.text, LEDGER_LIMITS.compact_source_bytes).split(/\r?\n|(?<=[.!?])\s+/)
          for (let lineIndex = lines.length - 1; lineIndex >= 0 && constraints.length < LEDGER_LIMITS.constraints; lineIndex--) {
            const line = lines[lineIndex]
            if (!line || !/\b(must|never|do not|don't|always|only|without|constraint|required|preserve|keep)\b/i.test(line)) continue
            pushReverseUnique(constraints, constraintSet, compact(line, 360), LEDGER_LIMITS.constraints)
          }
        }
      }
      userPartsScanned += inspectCount
    }

    const historyPartCount = Math.min(partCount, LEDGER_LIMITS.history_parts_scanned - historyPartsScanned)
    for (let partIndex = partCount - 1; partIndex >= partCount - historyPartCount; partIndex--) {
      const value = record(boundedPart(message.parts, partIndex))
      if (!value) continue
      if (value.type === "patch" && Array.isArray(value.files)) {
        value.files
          .filter((file): file is string => typeof file === "string")
          .forEach((file) => addBoundedPath(touchedPaths, file))
      }
      if (value.type === "file") {
        if (typeof value.filename === "string") addBoundedPath(touchedPaths, value.filename)
        const source = record(value.source)
        if (typeof source?.path === "string") addBoundedPath(touchedPaths, source.path)
      }
      if (value.type !== "tool" || typeof value.tool !== "string") continue
      const state = record(value.state)
      if (!state || typeof state.status !== "string") continue
      if (toolStatuses.length < LEDGER_LIMITS.tool_statuses) {
        const status: { tool: string; status: string; title?: string } = {
          tool: compact(value.tool, 96),
          status: compact(state.status, 32),
        }
        if (typeof state.title === "string" && state.title.trim()) status.title = compact(state.title, 180)
        toolStatuses.push(status)
      }
      toolInputNodes += forEachPath(
        state.input,
        LEDGER_LIMITS.tool_input_nodes - toolInputNodes,
        (path) => addBoundedPath(touchedPaths, path),
      )
      if (state.status === "error" && typeof state.error === "string" && errors.length < LEDGER_LIMITS.errors) {
        pushReverseUnique(
          errors,
          errorSet,
          `${compact(value.tool, 96)}: ${compact(state.error, 360)}`,
          LEDGER_LIMITS.errors,
        )
      }
      if (state.status === "completed" && evidence.length < LEDGER_LIMITS.evidence) {
        const detail = typeof state.output === "string" ? toolEvidence(state.output) : "completed"
        pushReverseUnique(
          evidence,
          evidenceSet,
          `${compact(value.tool, 96)}: ${detail}`,
          LEDGER_LIMITS.evidence,
        )
      }
    }
    historyPartsScanned += historyPartCount
    if (message.info.error && errors.length < LEDGER_LIMITS.errors) {
      pushReverseUnique(errors, errorSet, compact(errorText(message.info.error), 360), LEDGER_LIMITS.errors)
    }
  }

  userRequests.reverse()
  constraints.reverse()
  toolStatuses.reverse()
  errors.reverse()
  evidence.reverse()
  legacyContext.reverse()

  const todos: RecoveryLedgerData["todos"] = []
  for (const inputTodo of input.todos.slice(0, LEDGER_LIMITS.todos_scanned)) {
    const todo = record(inputTodo)
    if (!todo || typeof todo.content !== "string") continue
    const content = compact(boundedSource(todo.content, 2_048), 360)
    if (!content) continue
    const id = typeof todo.id === "string" ? compact(boundedSource(todo.id, 512), 96) : ""
    insertSortedBounded(todos, {
      id: id || `todo-${sha256(content).slice(0, 16)}`,
      status: typeof todo.status === "string" ? compact(boundedSource(todo.status, 256), 48) : "unknown",
      priority: typeof todo.priority === "string" ? compact(boundedSource(todo.priority, 256), 48) : "unknown",
      content,
    }, LEDGER_LIMITS.todos, (left, right) => compareText(left.id, right.id) || compareText(left.content, right.content))
  }

  const prior = input.priorSummary?.ledger.data
  const mergeStrings = (older: string[] | undefined, newer: string[], limit: number, maxBytes: number) =>
    unique([...(older ?? []).map((value) => compact(value, maxBytes)), ...newer]).slice(-limit)
  const recentRequests = input.tailTurns === 0
    ? []
    : mergeStrings(prior?.recent_requests, userRequests, Math.min(input.tailTurns, LEDGER_LIMITS.recent_requests), 640)
  const mergedConstraints = mergeStrings(prior?.constraints, constraints, LEDGER_LIMITS.constraints, 360)
  const mergedPaths = mergeStrings(prior?.touched_paths, [...touchedPaths], LEDGER_LIMITS.touched_paths, 512).sort()
  const mergedErrors = mergeStrings(prior?.errors, errors, LEDGER_LIMITS.errors, 360)
  const mergedEvidence = mergeStrings(prior?.evidence, evidence, LEDGER_LIMITS.evidence, 420)
  const mergedToolStatuses = unique([
    ...(prior?.tool_statuses ?? []).map((item) => JSON.stringify({
      tool: compact(item.tool, 96),
      status: compact(item.status, 32),
      ...(item.title ? { title: compact(item.title, 180) } : {}),
    })),
    ...toolStatuses.map((item) => JSON.stringify(item)),
  ]).slice(-LEDGER_LIMITS.tool_statuses).map((item) => JSON.parse(item) as RecoveryLedgerData["tool_statuses"][number])
  const todoByID = new Map(
    [...(prior?.todos ?? []), ...todos].map((todo) => [todo.id, {
      id: compact(todo.id, 96),
      status: compact(todo.status, 48),
      priority: compact(todo.priority, 48),
      content: compact(todo.content, 360),
    }]),
  )
  const mergedTodos: RecoveryLedgerData["todos"] = []
  ;[...todoByID.values()].forEach((todo) =>
    insertSortedBounded(
      mergedTodos,
      todo,
      LEDGER_LIMITS.todos,
      (left, right) => compareText(left.id, right.id) || compareText(left.content, right.content),
    )
  )
  const mergedLegacy = mergeStrings(
    prior?.legacy_context,
    [
      ...legacyContext,
      ...(input.priorSummary ? [`Trusted plugin summary ${compact(input.priorSummary.id, 96)} ledger chained`] : []),
    ],
    LEDGER_LIMITS.legacy_context,
    180,
  )
  const nextActions = unique([
    ...mergedTodos.filter((todo) => todo.status !== "completed" && todo.status !== "cancelled").map((todo) => todo.content),
    ...(prior?.next_actions ?? [])
      .map((value) => compact(value, 360))
      .filter((value) => !value.startsWith("Continue the newest request:")),
  ]).slice(0, LEDGER_LIMITS.next_actions)
  const data: RecoveryLedgerData = {
    recent_requests: recentRequests,
    constraints: mergedConstraints,
    todos: mergedTodos,
    touched_paths: mergedPaths,
    tool_statuses: mergedToolStatuses,
    errors: mergedErrors,
    evidence: mergedEvidence,
    next_actions: nextActions,
    legacy_context: mergedLegacy,
  }
  const removalOrder: Array<keyof RecoveryLedgerData> = [
    "evidence",
    "tool_statuses",
    "errors",
    "legacy_context",
    "constraints",
    "touched_paths",
    "todos",
    "recent_requests",
    "next_actions",
  ]
  return fitLedger(data, removalOrder, input.maxBytes)
}

export function summaryText(message: MessageRecord, maxBytes = Number.POSITIVE_INFINITY) {
  const text: string[] = []
  let bytes = 0
  for (const part of message.parts) {
    const value = record(part)
    if (value?.type !== "text" || typeof value.text !== "string") continue
    bytes += (text.length ? 1 : 0) + utf8Bytes(value.text)
    if (bytes > maxBytes) return ""
    text.push(value.text)
  }
  return text.join("\n").trim()
}

export function record(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  return value as Record<string, unknown>
}

function compact(value: string, maxBytes: number) {
  return truncateUtf8(
    redact(boundedSource(value, LEDGER_LIMITS.compact_source_bytes))
      .replaceAll(LEDGER_START, "[reserved ledger marker]")
      .replaceAll(LEDGER_END, "[reserved ledger marker]")
      .replaceAll("```", "` ` `")
      .replace(/\s+/g, " ")
      .trim(),
    maxBytes,
  )
}

function unique(values: string[]) {
  return [...new Set(values)]
}

function forEachPath(value: unknown, maxNodes: number, visit: (path: string) => void) {
  const pending: unknown[] = [value]
  let nodes = 0
  while (pending.length && nodes < maxNodes) {
    const current = pending.pop()
    nodes++
    if (typeof current === "string") {
      const text = redact(boundedSource(current, LEDGER_LIMITS.compact_source_bytes))
      for (const match of text.matchAll(/(?:^|[\s"'=])((?:\.\.?\/|\/)[A-Za-z0-9_@.+-][A-Za-z0-9_@./+-]*)/g)) {
        if (match[1]) visit(match[1])
      }
      continue
    }
    if (Array.isArray(current)) {
      const remaining = maxNodes - nodes
      for (let index = Math.min(current.length, remaining) - 1; index >= 0; index--) pending.push(current[index])
      continue
    }
    const data = record(current)
    if (!data) continue
    const remaining = maxNodes - nodes
    const entries: Array<[string, unknown]> = []
    for (const key in data) {
      if (!Object.hasOwn(data, key)) continue
      entries.push([key, data[key]])
      if (entries.length >= remaining) break
    }
    for (let index = entries.length - 1; index >= 0; index--) {
      const entry = entries[index]
      if (entry) pending.push(entry[1], entry[0])
    }
  }
  return nodes
}

function errorText(value: unknown) {
  const data = record(value)
  if (!data) return String(value)
  const detail = record(data.data)
  return [data.name, detail?.message, data.message].filter((item): item is string => typeof item === "string").join(": ")
}

function toolEvidence(value: string) {
  if (!value) return "completed with empty output"
  const source = boundedSource(value, LEDGER_LIMITS.tool_output_source_bytes)
  const truncated = source.length < value.length
  const characterLimit = source.length <= 240 ? Math.min(120, Math.floor(codePointCount(source) / 2)) : 120
  const excerpt = compact(source.slice(0, codePointPrefixEnd(source, characterLimit)), 160)
  const detail = truncated
    ? `at least ${utf8Bytes(source)} source bytes; prefix sha256 ${sha256(source).slice(0, 16)}`
    : `${utf8Bytes(source)} bytes; sha256 ${sha256(source).slice(0, 16)}`
  return `${excerpt}… [partial output; ${detail}]`
}

function recoverableUserText(value: Record<string, unknown> | undefined): value is Record<string, unknown> & { text: string } {
  return value?.type === "text" && value.synthetic !== true && value.ignored !== true && typeof value.text === "string"
}

function compactUserTurn(parts: unknown[], firstPart: number, partCount: number, maxBytes: number) {
  const source: string[] = []
  let bytes = 0
  for (let partIndex = firstPart; partIndex < partCount; partIndex++) {
    const value = record(boundedPart(parts, partIndex))
    if (!recoverableUserText(value)) continue
    const text = boundedSource(value.text, LEDGER_LIMITS.compact_source_bytes - bytes)
    if (!text) continue
    source.push(text)
    bytes += utf8Bytes(text)
    if (bytes >= LEDGER_LIMITS.compact_source_bytes) break
  }
  return compact(source.join("\n"), maxBytes)
}

function boundedSource(value: string, maxBytes: number) {
  if (maxBytes <= 0) return ""
  if (value.length <= maxBytes && utf8Bytes(value) <= maxBytes) return value
  return value.slice(0, utf8PrefixEnd(value, maxBytes))
}

function utf8PrefixEnd(value: string, maxBytes: number) {
  let bytes = 0
  let index = 0
  while (index < value.length) {
    const code = value.charCodeAt(index)
    const surrogatePair = hasSurrogatePair(value, index)
    const size = code <= 0x7f ? 1 : code <= 0x7ff ? 2 : surrogatePair ? 4 : 3
    if (bytes + size > maxBytes) break
    bytes += size
    index += surrogatePair ? 2 : 1
  }
  return index
}

function codePointCount(value: string) {
  let count = 0
  for (let index = 0; index < value.length; index++) {
    if (hasSurrogatePair(value, index)) index++
    count++
  }
  return count
}

function codePointPrefixEnd(value: string, limit: number) {
  let count = 0
  let index = 0
  while (index < value.length && count < limit) {
    index += hasSurrogatePair(value, index) ? 2 : 1
    count++
  }
  return index
}

function hasSurrogatePair(value: string, index: number) {
  const high = value.charCodeAt(index)
  if (high < 0xd800 || high > 0xdbff || index + 1 >= value.length) return false
  const low = value.charCodeAt(index + 1)
  return low >= 0xdc00 && low <= 0xdfff
}

function boundedPartCount(parts: unknown[]) {
  return Math.min(parts.length, LEDGER_LIMITS.parts_per_message)
}

function boundedPart(parts: unknown[], index: number) {
  if (parts.length <= LEDGER_LIMITS.parts_per_message) return parts[index]
  const head = Math.floor(LEDGER_LIMITS.parts_per_message / 2)
  return parts[index < head ? index : parts.length - (LEDGER_LIMITS.parts_per_message - index)]
}

function pushReverseUnique(values: string[], seen: Set<string>, value: string, limit: number) {
  if (!value || seen.has(value) || values.length >= limit) return
  seen.add(value)
  values.push(value)
}

function addBoundedPath(paths: Set<string>, value: string) {
  const path = compact(value.replace(/\/+$/, "") || value, 300)
  if (!isRealPath(path) || paths.has(path)) return
  paths.add(path)
  if (paths.size <= LEDGER_LIMITS.touched_paths) return
  let largest: string | undefined
  for (const existing of paths) {
    if (largest === undefined || compareText(existing, largest) > 0) largest = existing
  }
  if (largest) paths.delete(largest)
}

function isRealPath(path: string) {
  if (path.length < 4) return false
  const segment = path.slice(path.lastIndexOf("/") + 1)
  if (segment.includes(".")) return true
  const innerSlashes = (path.slice(1).match(/\//g) ?? []).length
  return innerSlashes >= 1 || path.length >= 16
}

function insertSortedBounded<T>(values: T[], value: T, limit: number, compare: (left: T, right: T) => number) {
  values.push(value)
  values.sort(compare)
  if (values.length > limit) values.pop()
}

function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0
}

function fitLedger(
  data: RecoveryLedgerData,
  removalOrder: Array<keyof RecoveryLedgerData>,
  maxBytes: number,
) {
  let ledger = canonicalLedger(data)
  for (const key of removalOrder) {
    if (utf8Bytes(ledger.block) <= maxBytes) return ledger
    const values = data[key]
    if (!values.length) continue
    const trim = (count: number) => key === "next_actions" ? values.slice(0, values.length - count) : values.slice(count)
    const withoutAll = canonicalLedger({ ...data, [key]: [] } as RecoveryLedgerData)
    if (utf8Bytes(withoutAll.block) > maxBytes) {
      values.splice(0)
      ledger = withoutAll
      continue
    }
    let low = 1
    let high = values.length
    while (low < high) {
      const middle = Math.floor((low + high) / 2)
      const candidate = canonicalLedger({ ...data, [key]: trim(middle) } as RecoveryLedgerData)
      if (utf8Bytes(candidate.block) <= maxBytes) high = middle
      else low = middle + 1
    }
    if (key === "next_actions") values.splice(values.length - low, low)
    else values.splice(0, low)
    ledger = canonicalLedger(data)
  }
  if (utf8Bytes(ledger.block) > maxBytes) {
    throw new RangeError(`max_ledger_bytes=${maxBytes} cannot hold the canonical ledger`)
  }
  return ledger
}
