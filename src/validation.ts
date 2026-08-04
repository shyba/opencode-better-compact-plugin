import {
  LEDGER_END,
  LEDGER_START,
  LEDGER_VERSION,
  canonicalLedger,
  record,
  sha256,
  utf8Bytes,
  type RecoveryLedger,
  type RecoveryLedgerData,
} from "./ledger.js"

export const REQUIRED_SECTIONS = [
  "Goal",
  "Constraints",
  "Decisions",
  "Current state",
  "Files",
  "Evidence",
  "Blockers/questions",
  "Next actions",
] as const

const TERSE_ACKNOWLEDGEMENTS = new Set([
  "check", "yes", "no", "ok", "okay", "hm", "hmm", "eta", "status", "retry", "continue",
  "read", "resume", "stop", "start", "pause", "done", "finished", "?", "%", "%?", "?:",
  "k", "yep", "nope", "true", "false",
])

export function buildCompactionPrompt(ledger: RecoveryLedger, maxBytes: number) {
  return `Return exactly the Markdown below, byte-for-byte, in one response. Do not add commentary or code fences around it.

${buildAuthoritativeSummary({ ledger, maxBytes })}`
}

export function validateSummary(text: string, expected: RecoveryLedger, maxBytes: number) {
  if (!text.trim() || utf8Bytes(text) > maxBytes) return false
  const value = text.trimEnd()
  if (!value.endsWith(expected.block)) return false
  const prefix = value.slice(0, -expected.block.length).trimEnd()
  if (!prefix.startsWith("## Goal\n")) return false
  const headings = [...prefix.matchAll(/^## (.+)$/gm)].map((match) => match[1])
  if (headings.length !== REQUIRED_SECTIONS.length) return false
  if (headings.some((heading, index) => heading !== REQUIRED_SECTIONS[index])) return false
  return markerLines(value, LEDGER_START).length === 1 && markerLines(value, LEDGER_END).length === 1
}

export function parsePluginLedger(text: string) {
  const value = text.trimEnd()
  const starts = markerLines(value, LEDGER_START)
  const ends = markerLines(value, LEDGER_END)
  if (starts.length !== 1 || ends.length !== 1) return
  const start = starts[0]!
  const end = ends[0]!
  if (end <= start) return
  const block = value.slice(start, end + LEDGER_END.length)
  const match = block.match(
    /^<!-- opencode-safe-compaction recovery-ledger v1 start -->\nversion: (\d+)\nsha256: ([a-f0-9]{64})\n```json\n([\s\S]*)\n```\n<!-- opencode-safe-compaction recovery-ledger v1 end -->$/,
  )
  if (!match || Number(match[1]) !== LEDGER_VERSION || !match[2] || match[3] === undefined) return
  if (sha256(match[3]) !== match[2]) return
  const parsed = parseData(match[3])
  if (!parsed || JSON.stringify(parsed, null, 2) !== match[3]) return
  const ledger = canonicalLedger(parsed)
  if (ledger.block !== block) return
  return ledger
}

export function isPluginValidSummary(text: string, maxBytes: number) {
  const ledger = parsePluginLedger(text)
  if (!ledger) return false
  return validateSummary(text, ledger, maxBytes)
}

export function buildAuthoritativeSummary(input: { ledger: RecoveryLedger; maxBytes: number }) {
  return buildFallback({ ledger: input.ledger, maxBytes: input.maxBytes })
}

export function isAuthoritativeSummary(text: string, maxBytes: number) {
  const ledger = parsePluginLedger(text)
  if (!ledger) return false
  try {
    return text === buildAuthoritativeSummary({ ledger, maxBytes })
  } catch {
    return false
  }
}

export function buildFallback(input: {
  ledger: RecoveryLedger
  maxBytes: number
}) {
  const list = (values: string[], empty: string) =>
    values.length ? values.map((value) => `- ${safeMarkdown(value)}`).join("\n") : `- ${empty}`
  const goal = resolveGoal(input.ledger.data.recent_requests)
  const text = `## Goal
${goal ? `- ${safeMarkdown(goal)}` : "- No recoverable user request was recorded."}

## Constraints
${list(input.ledger.data.constraints, "No explicit constraints were recovered.")}

## Decisions
- No decisions were inferred outside the canonical ledger.

## Current state
${list(toolStatusLines(input.ledger.data.tool_statuses), "Recovery summary generated from bounded durable history.")}

## Files
${list(input.ledger.data.touched_paths, "No touched paths were recovered.")}

## Evidence
${list(input.ledger.data.evidence, "No bounded evidence snippets were recovered.")}

## Blockers/questions
${list(input.ledger.data.errors, "No blocker was recorded; verify state before making unsupported assumptions.")}

## Next actions
${list(input.ledger.data.next_actions, "Re-read the newest user request and verify the current state.")}

${input.ledger.block}`
  if (utf8Bytes(text) <= input.maxBytes) return text
  const minimal = `## Goal
- Recover the interrupted session from the canonical ledger.

## Constraints
- Use only ledger-backed facts.

## Decisions
- No additional decisions were inferred.

## Current state
- The provider summary was replaced by a deterministic fallback.

## Files
- See the canonical ledger.

## Evidence
- See the canonical ledger.

## Blockers/questions
- Verify unknown state before acting.

## Next actions
- Resume from the canonical ledger.

${input.ledger.block}`
  if (utf8Bytes(minimal) > input.maxBytes) {
    throw new RangeError(`max_summary_bytes=${input.maxBytes} cannot hold a fallback summary`)
  }
  return minimal
}

export function recoveryContext(ledger: RecoveryLedger) {
  return `Safe-compaction recovery context for this model-visible turn only. Durable history was not modified.

The canonical recovery ledger below is authoritative. legacy_context records only bounded provenance: untrusted provider prose is omitted, while a prior plugin-valid canonical ledger may be chained.

No provider-authored compaction prose is trusted by opencode-safe-compaction.

Review pending and in-progress todos against recent_requests before acting. If a todo no longer matches the active request thread, treat it as possibly stale: mention its ID and ask the user before completing, deleting, or rewriting it. Do not infer abandonment from age alone.

${ledger.block}`
}

function parseData(value: string): RecoveryLedgerData | undefined {
  try {
    const data = record(JSON.parse(value))
    if (!data) return
    const keys = [
      "recent_requests",
      "constraints",
      "todos",
      "touched_paths",
      "tool_statuses",
      "errors",
      "evidence",
      "next_actions",
      "legacy_context",
    ]
    if (Object.keys(data).join("\n") !== keys.join("\n") || keys.some((key) => !Array.isArray(data[key]))) return
    const strings = [
      "recent_requests",
      "constraints",
      "touched_paths",
      "errors",
      "evidence",
      "next_actions",
      "legacy_context",
    ]
    if (strings.some((key) => !(data[key] as unknown[]).every((item) => typeof item === "string"))) return
    if (
      !(data.todos as unknown[]).every((item) => {
        const todo = record(item)
        return todo && [todo.id, todo.status, todo.priority, todo.content].every((value) => typeof value === "string")
      })
    ) {
      return
    }
    if (
      !(data.tool_statuses as unknown[]).every((item) => {
        const status = record(item)
        return status && typeof status.tool === "string" && typeof status.status === "string" &&
          (status.title === undefined || typeof status.title === "string")
      })
    ) {
      return
    }
    return data as RecoveryLedgerData
  } catch {
    return
  }
}

function safeMarkdown(value: string) {
  return value
    .replace(/^#{1,6}\s+/gm, "heading: ")
    .replaceAll(LEDGER_START, "[ledger marker]")
    .replaceAll(LEDGER_END, "[ledger marker]")
}

function resolveGoal(requests: string[]) {
  for (let index = requests.length - 1; index >= 0; index--) {
    const value = (requests[index] ?? "").trim()
    if (!value || isTerseAcknowledgement(value)) continue
    return value.split(/\s+/).slice(0, 30).join(" ")
  }
  return (requests.at(-1) ?? "").trim()
}

function isTerseAcknowledgement(value: string) {
  const normalized = value.toLowerCase().replace(/？/g, "?").replace(/[.,!;:]+$/g, "").trim()
  if (!normalized) return true
  const words = normalized.split(/\s+/).filter(Boolean)
  return words.length <= 3 && words.every((word) => TERSE_ACKNOWLEDGEMENTS.has(word))
}

function toolStatusLines(statuses: RecoveryLedgerData["tool_statuses"]) {
  const lines: string[] = []
  let previous: string | undefined
  let count = 0
  const flush = () => {
    if (!previous) return
    lines.push(count > 1 ? `${previous} (x${count})` : previous)
  }
  for (const item of statuses) {
    const line = `${item.tool}: ${item.status}${item.title ? ` — ${item.title}` : ""}`
    if (line === previous) {
      count++
      continue
    }
    flush()
    previous = line
    count = 1
  }
  flush()
  return lines
}

function markerLines(value: string, marker: string) {
  return [...value.matchAll(new RegExp(`^${escapeRegExp(marker)}$`, "gm"))].flatMap((match) =>
    match.index === undefined ? [] : [match.index]
  )
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
