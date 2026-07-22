export const LEDGER_VERSION = 1
export const LEDGER_START = "<!-- opencode-safe-compaction recovery-ledger v1 start -->"
export const LEDGER_END = "<!-- opencode-safe-compaction recovery-ledger v1 end -->"

export type MessageRecord = {
  info: {
    id: string
    sessionID: string
    role: "user" | "assistant"
    summary?: boolean
    error?: unknown
    finish?: string
    parentID?: string
  }
  parts: unknown[]
}

export type TodoRecord = {
  id: string
  content: string
  status: string
  priority: string
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

const encoder = new TextEncoder()

export function utf8Bytes(value: string) {
  return encoder.encode(value).byteLength
}

export function truncateUtf8(value: string, maxBytes: number) {
  if (utf8Bytes(value) <= maxBytes) return value
  const marker = "…[truncated]"
  const budget = Math.max(0, maxBytes - utf8Bytes(marker))
  const result: string[] = []
  let bytes = 0
  for (const character of value) {
    const next = utf8Bytes(character)
    if (bytes + next > budget) break
    result.push(character)
    bytes += next
  }
  return result.join("") + marker
}

export function redact(value: string) {
  return value
    .replace(
      /(["']?(?:(?:[a-z0-9]+[_-])*api[_-]?key|authorization|(?:access[_-]?|auth[_-]?|refresh[_-]?)?token|(?:client[_-]?)?secret|password)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/gi,
      "$1[REDACTED]",
    )
    .replace(
      /(^|[\s{,?&])(["']?(?:(?:[a-z0-9]+[_-])*api[_-]?key|authorization|(?:access[_-]?|auth[_-]?|refresh[_-]?)?token|(?:client[_-]?)?secret|password)["']?\s*[:=]\s*)(?:(?:bearer|basic)\s+)?[^\s,}&]+/gim,
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
}) {
  const compactionUsers = new Set(
    input.messages
      .filter((message) => message.info.role === "user" && message.parts.some((part) => record(part)?.type === "compaction"))
      .map((message) => message.info.id),
  )
  const newestCompactionUserID = input.messages.findLast(
    (message) => message.info.role === "user" && compactionUsers.has(message.info.id),
  )?.info.id
  const ordinary = input.messages.filter(
    (message) =>
      !compactionUsers.has(message.info.id) &&
      !(message.info.role === "assistant" && message.info.parentID && compactionUsers.has(message.info.parentID)),
  )
  const userRequests = ordinary
    .filter((message) => message.info.role === "user")
    .flatMap((message) =>
      message.parts.flatMap((part) => {
        const value = record(part)
        if (value?.type !== "text" || value.synthetic === true || typeof value.text !== "string") return []
        const text = compact(value.text, 640)
        return text ? [text] : []
      }),
    )
  const allText = ordinary.flatMap((message) =>
    message.parts.flatMap((part) => {
      const value = record(part)
      return value?.type === "text" && typeof value.text === "string" ? [value.text] : []
    }),
  )
  const constraints = unique(
    allText.flatMap((text) =>
      text
        .split(/\r?\n|(?<=[.!?])\s+/)
        .filter((line) => /\b(must|never|do not|don't|always|only|without|constraint|required|preserve|keep)\b/i.test(line))
        .map((line) => compact(line, 360))
        .filter(Boolean),
    ),
  ).slice(-16)
  const todos = input.todos
    .map((todo) => ({
      id: compact(todo.id, 96),
      status: compact(todo.status, 48),
      priority: compact(todo.priority, 48),
      content: compact(todo.content, 360),
    }))
    .sort((left, right) => left.id.localeCompare(right.id) || left.content.localeCompare(right.content))
    .slice(0, 32)
  const touchedPaths = new Set<string>()
  const toolStatuses: RecoveryLedgerData["tool_statuses"] = []
  const errors: string[] = []
  const evidence: string[] = []

  for (const message of ordinary) {
    if (message.info.error) errors.push(compact(errorText(message.info.error), 360))
    for (const part of message.parts) {
      const value = record(part)
      if (!value) continue
      if (value.type === "patch" && Array.isArray(value.files)) {
        value.files.filter((file): file is string => typeof file === "string").forEach((file) => touchedPaths.add(file))
      }
      if (value.type === "file") {
        if (typeof value.filename === "string") touchedPaths.add(value.filename)
        const source = record(value.source)
        if (typeof source?.path === "string") touchedPaths.add(source.path)
      }
      if (value.type !== "tool" || typeof value.tool !== "string") continue
      const state = record(value.state)
      if (!state || typeof state.status !== "string") continue
      const status: { tool: string; status: string; title?: string } = {
        tool: compact(value.tool, 96),
        status: compact(state.status, 32),
      }
      if (typeof state.title === "string" && state.title.trim()) status.title = compact(state.title, 180)
      toolStatuses.push(status)
      pathsFrom(state.input).forEach((path) => touchedPaths.add(path))
      if (state.status === "error" && typeof state.error === "string") {
        errors.push(`${status.tool}: ${compact(state.error, 360)}`)
      }
      if (state.status === "completed") {
        const detail = typeof state.output === "string" ? toolEvidence(state.output) : "completed"
        evidence.push(`${status.tool}: ${detail}`)
      }
    }
  }

  const legacyContext = input.messages
    .filter(
      (message) =>
        message.info.role === "assistant" &&
        message.info.summary === true &&
        (!newestCompactionUserID || message.info.parentID !== newestCompactionUserID) &&
        message.info.id !== input.excludeSummaryID,
    )
    .flatMap((message) => summaryText(message) ? [compact(summaryText(message), 720)] : [])
    .slice(-2)
  const nextActions = unique([
    ...todos.filter((todo) => todo.status !== "completed" && todo.status !== "cancelled").map((todo) => todo.content),
    ...userRequests.slice(-1).map((request) => `Continue the newest request: ${request}`),
  ]).slice(0, 16)
  const data: RecoveryLedgerData = {
    recent_requests: input.tailTurns === 0 ? [] : userRequests.slice(-input.tailTurns),
    constraints,
    todos,
    touched_paths: [...touchedPaths].map((path) => compact(path, 300)).sort().slice(0, 64),
    tool_statuses: toolStatuses.slice(-48),
    errors: unique(errors.filter(Boolean)).slice(-24),
    evidence: unique(evidence.filter(Boolean)).slice(-32),
    next_actions: nextActions,
    legacy_context: legacyContext,
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
  let ledger = canonicalLedger(data)
  while (utf8Bytes(ledger.block) > input.maxBytes) {
    const key = removalOrder.find((item) => data[item].length > 0)
    if (!key) throw new RangeError(`max_ledger_bytes=${input.maxBytes} cannot hold the canonical ledger`)
    data[key].shift()
    ledger = canonicalLedger(data)
  }
  return ledger
}

export function summaryText(message: MessageRecord) {
  return message.parts
    .flatMap((part) => {
      const value = record(part)
      return value?.type === "text" && typeof value.text === "string" ? [value.text] : []
    })
    .join("\n")
    .trim()
}

export function record(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  return value as Record<string, unknown>
}

function compact(value: string, maxBytes: number) {
  return truncateUtf8(
    redact(value)
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

function pathsFrom(value: unknown) {
  const text = redact(JSON.stringify(value ?? {}))
  return [...text.matchAll(/(?:^|[\s"'=])((?:\.\.?\/|\/)[A-Za-z0-9_@.+-][A-Za-z0-9_@./+-]*)/g)].flatMap(
    (match) => (match[1] ? [match[1]] : []),
  )
}

function errorText(value: unknown) {
  const data = record(value)
  if (!data) return String(value)
  const detail = record(data.data)
  return [data.name, detail?.message, data.message].filter((item): item is string => typeof item === "string").join(": ")
}

function toolEvidence(value: string) {
  if (!value) return "completed with empty output"
  const characters = Array.from(value)
  const excerpt = compact(characters.slice(0, Math.min(120, Math.floor(characters.length / 2))).join(""), 160)
  return `${excerpt}… [partial output; ${utf8Bytes(value)} bytes; sha256 ${sha256(value).slice(0, 16)}]`
}
