import { LEDGER_LIMITS, canonicalLedger, sha256, truncateUtf8, utf8Bytes, type RecoveryLedger, type RecoveryLedgerData } from "./ledger.js"

export const PROJECTION_VERSION = 1
export const PROJECTION_START = "<!-- opencode-safe-compaction projection v1 start -->"
export const PROJECTION_END = "<!-- opencode-safe-compaction projection v1 end -->"
export const PROJECTION_MAX_BYTES = 16_384
export const PROJECTION_RENDER_OVERHEAD_BYTES = 4_096
export const PROJECTION_MIN_BYTES = 2_048

const CLAIM_LIMITS = {
  goal: 2_048,
  list: 1_024,
  items: 24,
  refs: 8,
} as const

export type ProjectionClaim = { text: string; ledger_refs: string[] }
export type ProjectedFile = {
  path: string
  status: "changed" | "created" | "deleted" | "read" | "unchanged" | "unverified"
  summary: string
  evidence_refs: string[]
}
export type ProjectedAction = {
  text: string
  status: "proposed" | "blocked" | "completed"
  ledger_refs: string[]
}
export type ProjectedSummary = {
  version: 1
  goal: ProjectionClaim
  constraints: ProjectionClaim[]
  decisions: ProjectionClaim[]
  current_state: ProjectionClaim[]
  files: ProjectedFile[]
  evidence: ProjectionClaim[]
  blockers: ProjectionClaim[]
  next_actions: ProjectedAction[]
  ledger_sha256: string
}

export function projectionBudget(maxSummaryBytes: number, maxLedgerBytes: number) {
  return Math.min(PROJECTION_MAX_BYTES, maxSummaryBytes - maxLedgerBytes - PROJECTION_RENDER_OVERHEAD_BYTES)
}

export function validateProjection(value: unknown, ledger: RecoveryLedger, options: { requireCurrentDigest?: boolean; maxBytes?: number; references?: Set<string> } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  const object = value as Record<string, unknown>
  const keys = ["version", "goal", "constraints", "decisions", "current_state", "files", "evidence", "blockers", "next_actions", "ledger_sha256"]
  if (!exactKeys(object, keys)) return
  if (object.version !== PROJECTION_VERSION || typeof object.ledger_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(object.ledger_sha256)) return
  if (options.requireCurrentDigest !== false && object.ledger_sha256 !== ledger.digest) return
  if (options.maxBytes !== undefined && utf8Bytes(JSON.stringify(value)) > options.maxBytes) return
  const references = options.references ?? ledgerReferenceIDs(ledger)
  const goal = claim(object.goal, references, CLAIM_LIMITS.goal)
  if (!goal) return
  const constraints = claims(object.constraints, references, CLAIM_LIMITS.items)
  const decisions = claims(object.decisions, references, CLAIM_LIMITS.items)
  const currentState = claims(object.current_state, references, CLAIM_LIMITS.items)
  const evidence = claims(object.evidence, references, CLAIM_LIMITS.items)
  const blockers = claims(object.blockers, references, CLAIM_LIMITS.items)
  if (!constraints || !decisions || !currentState || !evidence || !blockers) return
  if (!Array.isArray(object.files) || object.files.length > 64) return
  const files = object.files.map((item) => file(item, references, ledger)).filter((item): item is ProjectedFile => Boolean(item))
  if (files.length !== object.files.length) return
  if (!Array.isArray(object.next_actions) || object.next_actions.length > 16) return
  const nextActions = object.next_actions.map((item) => action(item, references)).filter((item): item is ProjectedAction => Boolean(item))
  if (nextActions.length !== object.next_actions.length) return
  return { version: 1, goal, constraints, decisions, current_state: currentState, files, evidence, blockers, next_actions: nextActions, ledger_sha256: object.ledger_sha256 } satisfies ProjectedSummary
}

export function parseProjectionJSON(text: string, ledger: RecoveryLedger, maxBytes: number) {
  if (!text.trim() || utf8Bytes(text) > maxBytes || hasUnpairedSurrogate(text)) return
  const value = strictJSON(text)
  if (!value) return
  return validateProjection(value, ledger, { maxBytes })
}

export function projectionBlock(projection: ProjectedSummary) {
  const body = JSON.stringify(projection, null, 2)
  return `${PROJECTION_START}\n\`\`\`json\n${body}\n\`\`\`\n${PROJECTION_END}`
}

export function parseProjectionBlock(text: string) {
  const starts = markerIndexes(text, PROJECTION_START)
  const ends = markerIndexes(text, PROJECTION_END)
  if (starts.length !== 1 || ends.length !== 1 || ends[0]! <= starts[0]!) return
  const block = text.slice(starts[0]!, ends[0]! + PROJECTION_END.length)
  const match = block.match(/^<!-- opencode-safe-compaction projection v1 start -->\n```json\n([\s\S]*)\n```\n<!-- opencode-safe-compaction projection v1 end -->$/)
  if (!match) return
  const value = strictJSON(match[1]!)
  if (!value) return
  const projection = validateProjectionShape(value)
  if (!projection || projectionBlock(projection) !== block) return
  return projection
}

export function renderProjection(projection: ProjectedSummary, ledger: RecoveryLedger, maxBytes: number) {
  const list = (values: ProjectionClaim[], empty: string) => values.length ? values.map((item) => `- ${safeMarkdown(item.text)}`).join("\n") : `- ${empty}`
  const files = projection.files.length
    ? projection.files.map((item) => `- ${safeMarkdown(item.path)} [${item.status}]${item.summary ? ` — ${safeMarkdown(item.summary)}` : ""}`).join("\n")
    : "- No projected files were recovered."
  const actions = projection.next_actions.length
    ? projection.next_actions.map((item) => `- [${item.status}] ${safeMarkdown(item.text)}`).join("\n")
    : "- No projected next actions were recovered."
  const text = `## Goal\n- ${safeMarkdown(projection.goal.text)}\n\n## Constraints\n${list(projection.constraints, "No projected constraints were recovered.")}\n\n## Decisions\n${list(projection.decisions, "No projected decisions were recovered.")}\n\n## Current state\n${list(projection.current_state, "No projected current state was recovered.")}\n\n## Files\n${files}\n\n## Evidence\n${list(projection.evidence, "No projected evidence was recovered.")}\n\n## Blockers/questions\n${list(projection.blockers, "No projected blockers were recovered.")}\n\n## Next actions\n${actions}\n\n${projectionBlock(projection)}\n${ledger.block}`
  if (utf8Bytes(text) > maxBytes) return
  return text
}

export function remapProjection(projection: ProjectedSummary, ledger: RecoveryLedger) {
  const references = ledgerReferenceIDs(ledger)
  const remapClaim = (item: ProjectionClaim) => {
    const refs = item.ledger_refs.filter((ref) => references.has(ref))
    return refs.length ? { ...item, ledger_refs: refs } : undefined
  }
  const goal = remapClaim(projection.goal)
  if (!goal) return
  const remapClaims = (items: ProjectionClaim[]) => items.map(remapClaim).filter((item): item is ProjectionClaim => Boolean(item))
  const touchedPaths = new Set(ledger.data.touched_paths)
  const files = projection.files.map((item) => {
    if (item.status !== "unverified" && !touchedPaths.has(item.path)) return
    const refs = item.evidence_refs.filter((ref) => references.has(ref))
    return refs.length ? { ...item, evidence_refs: refs } : undefined
  }).filter((item): item is ProjectedFile => Boolean(item))
  const nextActions = projection.next_actions.map((item) => {
    const refs = item.ledger_refs.filter((ref) => references.has(ref))
    return refs.length ? { ...item, ledger_refs: refs } : undefined
  }).filter((item): item is ProjectedAction => Boolean(item))
  return {
    ...projection,
    goal,
    constraints: remapClaims(projection.constraints),
    decisions: remapClaims(projection.decisions),
    current_state: remapClaims(projection.current_state),
    files,
    evidence: remapClaims(projection.evidence),
    blockers: remapClaims(projection.blockers),
    next_actions: nextActions,
    ledger_sha256: ledger.digest,
  } satisfies ProjectedSummary
}

export function ledgerReferenceIDs(ledger: RecoveryLedger) {
  const references = new Set<string>()
  const add = (section: string, value: unknown) => references.add(ledgerReferenceID(section, value))
  const data = ledger.data
  for (const section of ["recent_requests", "constraints", "touched_paths", "errors", "evidence", "next_actions", "legacy_context"] as const) for (const value of data[section]) add(section, value)
  for (const section of ["todos", "tool_statuses"] as const) for (const value of data[section]) add(section, value)
  return references
}

export function ledgerReferenceGuide(ledger: RecoveryLedger) {
  const lines: string[] = []
  const add = (section: string, value: unknown) => lines.push(`${ledgerReferenceID(section, value)}\t${JSON.stringify(value)}`)
  const data = ledger.data
  for (const section of ["recent_requests", "constraints", "touched_paths", "errors", "evidence", "next_actions", "legacy_context"] as const) for (const value of data[section]) add(section, value)
  for (const section of ["todos", "tool_statuses"] as const) for (const value of data[section]) add(section, value)
  return lines.join("\n")
}

export function ledgerReferenceID(section: string, value: unknown) {
  return `${section}:${sha256(`${section}\u0000${JSON.stringify(value)}`)}`
}

function validateProjectionShape(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  const data = emptyLedgerData()
  const files = (value as Record<string, unknown>).files
  if (Array.isArray(files)) data.touched_paths = files.flatMap((item) => item && typeof item === "object" && !Array.isArray(item) && typeof (item as Record<string, unknown>).path === "string" ? [(item as Record<string, unknown>).path as string] : [])
  return validateProjection(value, canonicalLedger(data), { requireCurrentDigest: false, references: projectionReferences(value) })
}

function emptyLedgerData(): RecoveryLedgerData {
  return { recent_requests: [], constraints: [], todos: [], touched_paths: [], tool_statuses: [], errors: [], evidence: [], next_actions: [], legacy_context: [] }
}

function projectionReferences(value: unknown) {
  const references = new Set<string>()
  const visit = (item: unknown) => {
    if (Array.isArray(item)) { item.forEach(visit); return }
    if (!item || typeof item !== "object") return
    for (const [key, child] of Object.entries(item)) {
      if ((key === "ledger_refs" || key === "evidence_refs") && Array.isArray(child)) {
        child.filter((ref): ref is string => typeof ref === "string").forEach((ref) => references.add(ref))
        continue
      }
      visit(child)
    }
  }
  visit(value)
  return references
}

function claim(value: unknown, references: Set<string>, maxBytes: number): ProjectionClaim | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  const object = value as Record<string, unknown>
  if (!exactKeys(object, ["text", "ledger_refs"]) || typeof object.text !== "string" || !Array.isArray(object.ledger_refs)) return
  if (!object.text.trim() || utf8Bytes(object.text) > maxBytes || object.ledger_refs.length > CLAIM_LIMITS.refs) return
  const refs = object.ledger_refs.filter((item): item is string => typeof item === "string" && references.has(item))
  if (refs.length !== object.ledger_refs.length || !refs.length) return
  return { text: truncateUtf8(object.text.trim(), maxBytes), ledger_refs: refs }
}

function claims(value: unknown, references: Set<string>, maxItems: number) {
  if (!Array.isArray(value) || value.length > maxItems) return
  const result = value.map((item) => claim(item, references, CLAIM_LIMITS.list)).filter((item): item is ProjectionClaim => Boolean(item))
  return result.length === value.length ? result : undefined
}

function file(value: unknown, references: Set<string>, ledger: RecoveryLedger): ProjectedFile | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  const object = value as Record<string, unknown>
  if (!exactKeys(object, ["path", "status", "summary", "evidence_refs"]) || typeof object.path !== "string" || typeof object.status !== "string" || typeof object.summary !== "string" || !Array.isArray(object.evidence_refs)) return
  if (!/^(changed|created|deleted|read|unchanged|unverified)$/.test(object.status) || utf8Bytes(object.path) > 512 || utf8Bytes(object.summary) > CLAIM_LIMITS.list || object.evidence_refs.length > CLAIM_LIMITS.refs) return
  if (object.status !== "unverified" && !ledger.data.touched_paths.includes(object.path)) return
  const refs = object.evidence_refs.filter((item): item is string => typeof item === "string" && references.has(item) && item.startsWith("evidence:"))
  if (refs.length !== object.evidence_refs.length || !refs.length) return
  return { path: truncateUtf8(object.path.trim(), 512), status: object.status as ProjectedFile["status"], summary: truncateUtf8(object.summary.trim(), CLAIM_LIMITS.list), evidence_refs: refs }
}

function action(value: unknown, references: Set<string>): ProjectedAction | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  const object = value as Record<string, unknown>
  if (!exactKeys(object, ["text", "status", "ledger_refs"]) || typeof object.text !== "string" || typeof object.status !== "string" || !Array.isArray(object.ledger_refs)) return
  if (!/^(proposed|blocked|completed)$/.test(object.status) || !object.text.trim() || utf8Bytes(object.text) > CLAIM_LIMITS.list || object.ledger_refs.length > CLAIM_LIMITS.refs) return
  const refs = object.ledger_refs.filter((item): item is string => typeof item === "string" && references.has(item))
  if (refs.length !== object.ledger_refs.length || !refs.length || object.status === "completed" && !refs.some((ref) => ref.startsWith("todos:") || ref.startsWith("evidence:"))) return
  return { text: truncateUtf8(object.text.trim(), CLAIM_LIMITS.list), status: object.status as ProjectedAction["status"], ledger_refs: refs }
}

function strictJSON(text: string): unknown {
  let index = 0
  const whitespace = () => { while (/\s/.test(text[index] ?? "")) index++ }
  const string = () => {
    const start = index
    if (text[index++] !== '"') throw new Error("string")
    while (index < text.length) {
      const char = text[index++]
      if (char === "\\") index++
      else if (char === '"') {
        const parsed = JSON.parse(text.slice(start, index)) as string
        if (hasUnpairedSurrogate(parsed)) throw new Error("surrogate")
        return parsed
      }
      else if (char && char < " ") throw new Error("control")
    }
    throw new Error("unterminated")
  }
  const value = (): unknown => {
    whitespace()
    const char = text[index]
    if (char === '"') return string()
    if (char === "{") {
      index++
      const result: Record<string, unknown> = {}
      const keys = new Set<string>()
      whitespace()
      if (text[index] === "}") { index++; return result }
      while (index < text.length) {
        whitespace()
        const key = string()
        if (keys.has(key)) throw new Error("duplicate key")
        keys.add(key)
        whitespace()
        if (text[index++] !== ":") throw new Error("colon")
        result[key] = value()
        whitespace()
        if (text[index] === "}") { index++; return result }
        if (text[index++] !== ",") throw new Error("comma")
      }
      throw new Error("object")
    }
    if (char === "[") {
      index++
      const result: unknown[] = []
      whitespace()
      if (text[index] === "]") { index++; return result }
      while (index < text.length) {
        result.push(value())
        whitespace()
        if (text[index] === "]") { index++; return result }
        if (text[index++] !== ",") throw new Error("array")
      }
      throw new Error("array")
    }
    const token = text.slice(index).match(/^(true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/)?.[1]
    if (!token) throw new Error("value")
    index += token.length
    return JSON.parse(token)
  }
  try {
    const result = value()
    whitespace()
    return index === text.length ? result : undefined
  } catch {
    return
  }
}

function exactKeys(object: Record<string, unknown>, keys: string[]) {
  const actual = Object.keys(object).sort()
  return actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index])
}

function markerIndexes(value: string, marker: string) {
  return [...value.matchAll(new RegExp(`^${escapeRegExp(marker)}$`, "gm"))].flatMap((match) => match.index === undefined ? [] : [match.index])
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function hasUnpairedSurrogate(value: string) {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code < 0xd800 || code > 0xdfff) continue
    if (code >= 0xdc00 || index + 1 >= value.length || value.charCodeAt(index + 1) < 0xdc00 || value.charCodeAt(index + 1) > 0xdfff) return true
    index++
  }
  return false
}

function safeMarkdown(value: string) {
  return value.replace(/^#{1,6}\s+/gm, "heading: ").replace(/```/g, "` ` `")
}
