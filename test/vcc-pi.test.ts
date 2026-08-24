import { describe, expect, test } from "bun:test"
import { assertCompleteSource, type CanonicalEventInput } from "../src/vcc.js"
import { collectVccPiBranch, type VccPiBranchEntry, type VccPiBranchInput } from "../src/vcc-pi.js"

const scope = { session_id: "pi-session", lineage_id: "pi-lineage" }

type Entry = VccPiBranchEntry & {
  provenance?: CanonicalEventInput["provenance"]
  session_id?: string
  lineage_id?: string
}

function branch(entries: readonly Entry[], toEvent?: VccPiBranchInput<Entry>["to_event"]): VccPiBranchInput<Entry> {
  return {
    ...scope,
    entries,
    to_event: toEvent ?? ((entry, sequence): CanonicalEventInput => ({
      host: "pi",
      ...scope,
      stable_source_id: entry.id,
      sequence,
      provenance: entry.provenance ?? "assistant",
      kind: entry.provenance === "human_tool_answer" ? "human_tool_answer" : "message",
      pair_id: entry.provenance === "human_tool_answer" ? "question-1" : undefined,
      content: entry.id,
      source_location: `fixture:${entry.id}`,
    })),
  }
}

describe("pure Pi VCC active-branch identity", () => {
  test("preserves stable entry IDs and branch order instead of position aliases", () => {
    const first = collectVccPiBranch(branch([{ id: "branch-alpha" }, { id: "branch-beta" }]))
    const reordered = collectVccPiBranch(branch([{ id: "branch-beta" }, { id: "branch-alpha" }]))
    expect(first.events.map((event) => event.id)).toEqual(["ev:pi:branch-alpha", "ev:pi:branch-beta"])
    expect(reordered.events.map((event) => event.id)).toEqual(["ev:pi:branch-beta", "ev:pi:branch-alpha"])
    expect(first.events.map((event) => event.id)).not.toContain("ev:pi:pi-1")
    expect(first.events[0]?.sequence).toBe(0)
    expect(reordered.events[0]?.sequence).toBe(0)
  })

  test("keeps direct and tool-mediated human provenance distinct and authoritative", () => {
    const result = collectVccPiBranch(branch([
      { id: "human-direct", provenance: "human_direct" },
      { id: "human-answer", provenance: "human_tool_answer" },
      { id: "approval", provenance: "human_approval" },
      { id: "rejection", provenance: "human_rejection" },
    ]))
    expect(result.events.map((event) => [event.provenance, event.authority])).toEqual([
      ["human_direct", "authoritative"],
      ["human_tool_answer", "authoritative"],
      ["human_approval", "authoritative"],
      ["human_rejection", "authoritative"],
    ])
  })

  test("preserves pair, derived, supersession, and archive references", () => {
    const originalID = "ev:pi:original"
    const archive = "archive:v1:pi:" + "a".repeat(64) + ":" + "b".repeat(64) + ":" + "c".repeat(64)
    const result = collectVccPiBranch(branch([{ id: "original" }, { id: "correction" }], (entry, sequence): CanonicalEventInput => ({
      host: "pi",
      ...scope,
      stable_source_id: entry.id,
      sequence,
      provenance: "human_direct",
      kind: "message",
      pair_id: sequence === 1 ? "correction-pair" : undefined,
      derived_from_event_ids: sequence === 1 ? [originalID] : undefined,
      supersedes_event_ids: sequence === 1 ? [originalID] : undefined,
      archive_handles: [archive],
      content: entry.id,
      source_location: `fixture:${entry.id}`,
    })))
    expect(result.events[1]?.pair_id).toBe("correction-pair")
    expect(result.events[1]?.derived_from_event_ids).toEqual([originalID])
    expect(result.events[1]?.supersedes_event_ids).toEqual([originalID])
    expect(result.events[0]?.archive_handles).toEqual([archive])
  })

  test("rejects duplicate and missing stable identity", () => {
    const duplicate = collectVccPiBranch(branch([{ id: "same" }, { id: "same" }]))
    const missing = collectVccPiBranch(branch([{ id: "present" }, {} as Entry]))
    expect(duplicate.source.reason).toBe("duplicate_message_id")
    expect(missing.source.reason).toBe("unsupported_record")
    expect(duplicate.source.complete).toBe(false)
    expect(missing.source.complete).toBe(false)
  })

  test("rejects mapper failure and cross-session or lineage mismatch", () => {
    const mapperFailure = collectVccPiBranch(branch([{ id: "broken" }], () => { throw new Error("bad mapper") }))
    const crossSession = collectVccPiBranch(branch([{ id: "cross", session_id: "other-session" }], (entry, sequence) => ({ ...branch([]).to_event(entry, sequence), session_id: entry.session_id ?? scope.session_id })))
    const lineage = collectVccPiBranch(branch([{ id: "branch", lineage_id: "other-lineage" }], (entry, sequence) => ({ ...branch([]).to_event(entry, sequence), lineage_id: entry.lineage_id ?? scope.lineage_id })))
    expect(mapperFailure.source.reason).toBe("unsupported_record")
    expect(crossSession.source.reason).toBe("cross_session_record")
    expect(lineage.source.reason).toBe("lineage_ambiguous")
  })

  test("is deterministic and rejects incomplete source", () => {
    const entries = [{ id: "repeat-a" }, { id: "repeat-b" }]
    const first = collectVccPiBranch(branch(entries))
    const second = collectVccPiBranch(branch(entries))
    expect(second.events).toEqual(first.events)
    expect(second.source).toEqual(first.source)
    expect(second.source.digest).toBe(first.source.digest)
    expect(() => assertCompleteSource(first.source)).not.toThrow()
    const incomplete = collectVccPiBranch(branch([{ id: "bad" }], () => { throw new Error("bad") }))
    expect(() => assertCompleteSource(incomplete.source)).toThrow()
  })
})
