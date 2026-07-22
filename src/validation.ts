import {
  LEDGER_END,
  LEDGER_START,
  LEDGER_VERSION,
  canonicalLedger,
  record,
  sha256,
  truncateUtf8,
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

export function buildCompactionPrompt(ledger: RecoveryLedger) {
  return `Create one recovery summary for the next model turn.

Return one Markdown response and no commentary outside it. Include every H2 section below exactly once and in this order:

## Goal
## Constraints
## Decisions
## Current state
## Files
## Evidence
## Blockers/questions
## Next actions

State only facts supported by the supplied conversation and recovery ledger. Mark unknowns as unknown. Keep paths, commands, errors, verification results, and unfinished work precise. Never include credentials or invent completed work.

End the response with the following recovery-ledger block copied byte-for-byte, including its markers, version, digest, JSON fence, whitespace, and content:

${ledger.block}`
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

export function buildFallback(input: {
  ledger: RecoveryLedger
  priorValidSummary?: string
  maxBytes: number
}) {
  const list = (values: string[], empty: string) =>
    values.length ? values.map((value) => `- ${safeMarkdown(value)}`).join("\n") : `- ${empty}`
  const priorDecisions = input.priorValidSummary ? section(input.priorValidSummary, "Decisions") : ""
  const priorState = input.priorValidSummary ? section(input.priorValidSummary, "Current state") : ""
  const text = `## Goal
${list(input.ledger.data.recent_requests.slice(-1), "No recoverable user request was recorded.")}

## Constraints
${list(input.ledger.data.constraints, "No explicit constraints were recovered.")}

## Decisions
${priorDecisions ? `- Prior validated context: ${safeMarkdown(priorDecisions)}` : "- No validated prior decisions were recovered."}

## Current state
${priorState ? `- Prior validated context: ${safeMarkdown(priorState)}` : list(input.ledger.data.tool_statuses.map((item) => `${item.tool}: ${item.status}`), "Recovery fallback generated from durable history.")}

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

export function recoveryContext(ledger: RecoveryLedger, priorValidSummary?: string) {
  const prior = priorValidSummary
    ? truncateUtf8(section(priorValidSummary, "Current state") || "A prior plugin-valid summary exists.", 4_096)
    : "No prior plugin-valid summary is available."
  return `Safe-compaction recovery context for this model-visible turn only. Durable history was not modified.

Prior validated state: ${safeMarkdown(prior)}

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

function section(text: string, name: (typeof REQUIRED_SECTIONS)[number]) {
  const ledgerStart = markerLines(text, LEDGER_START)[0]
  const prefix = ledgerStart === undefined ? text : text.slice(0, ledgerStart)
  const heading = new RegExp(`^## ${escapeRegExp(name)}$`, "m").exec(prefix)
  if (heading?.index === undefined) return ""
  const content = prefix.slice(heading.index + heading[0].length)
  const end = content.search(/^## /m)
  return truncateUtf8((end < 0 ? content : content.slice(0, end)).trim(), 2_048)
}

function safeMarkdown(value: string) {
  return value
    .replace(/^#{1,6}\s+/gm, "heading: ")
    .replaceAll(LEDGER_START, "[ledger marker]")
    .replaceAll(LEDGER_END, "[ledger marker]")
}

function markerLines(value: string, marker: string) {
  return [...value.matchAll(new RegExp(`^${escapeRegExp(marker)}$`, "gm"))].flatMap((match) =>
    match.index === undefined ? [] : [match.index]
  )
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
