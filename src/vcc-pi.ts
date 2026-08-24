import { utf8Bytes } from "./ledger.js"
import {
  buildSourceCompleteness,
  canonicalSerialize,
  normalizeCanonicalEvent,
  type CanonicalEvent,
  type CanonicalEventInput,
  type SourceCompleteness,
} from "./vcc.js"

export type VccPiBranchEntry = {
  id: string
}

export type VccPiBranchInput<TEntry extends VccPiBranchEntry> = {
  session_id: string
  lineage_id: string
  entries: readonly TEntry[]
  to_event: (entry: TEntry, sequence: number) => CanonicalEventInput
}

export type VccPiBranchResult = {
  events: CanonicalEvent[]
  source: SourceCompleteness
}

export function collectVccPiBranch<TEntry extends VccPiBranchEntry>(input: VccPiBranchInput<TEntry>): VccPiBranchResult {
  const events: CanonicalEvent[] = []
  const identities = new Set<string>()
  if (!Array.isArray(input.entries)) return branchResult(input, events, "unsupported_record")
  for (const entry of input.entries) {
    if (!isRecord(entry) || !validEntryID(entry.id)) return branchResult(input, events, "unsupported_record")
    const typedEntry = entry as TEntry
    if (identities.has(typedEntry.id)) return branchResult(input, events, "duplicate_message_id")
    let eventInput: CanonicalEventInput
    try {
      eventInput = input.to_event(typedEntry, events.length)
    } catch {
      return branchResult(input, events, "unsupported_record")
    }
    if (!isRecord(eventInput) || eventInput.host !== "pi" || eventInput.stable_source_id !== typedEntry.id) return branchResult(input, events, "unsupported_record")
    if (eventInput.session_id !== input.session_id) return branchResult(input, events, "cross_session_record")
    if (typeof eventInput.lineage_id !== "string" || !eventInput.lineage_id || eventInput.lineage_id !== input.lineage_id) return branchResult(input, events, "lineage_ambiguous")
    try {
      events.push(normalizeCanonicalEvent({ ...eventInput, sequence: events.length }))
    } catch {
      return branchResult(input, events, "unsupported_record")
    }
    identities.add(typedEntry.id)
  }
  return branchResult(input, events, null)
}

function branchResult<TEntry extends VccPiBranchEntry>(input: VccPiBranchInput<TEntry>, events: CanonicalEvent[], reason: "unsupported_record" | "duplicate_message_id" | "cross_session_record" | "lineage_ambiguous" | null): VccPiBranchResult {
  return {
    events,
    source: buildSourceCompleteness({
      host: "pi",
      session_id: input.session_id,
      lineage_id: input.lineage_id,
      events,
      page_count: 1,
      byte_count: utf8Bytes(canonicalSerialize(events)),
      terminal_cursor: null,
      reason,
    }),
  }
}

function validEntryID(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !value.includes("\0") && !value.includes("\n") && utf8Bytes(value) <= 512
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
