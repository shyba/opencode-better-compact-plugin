import { describe, expect, test } from "bun:test"
import { sha256 } from "../src/ledger.js"
import {
  buildSourceCompleteness,
  canonicalSerialize,
  compileVccCandidate,
  formCausalEpisodes,
  normalizeCanonicalEvent,
  VCC_PATCH_MAX_BYTES,
} from "../src/vcc.js"
import { buildVccPatchSourceIndex } from "../src/vcc.js"
import { buildVccHybridRequest, requestVccHybridPatch } from "../src/vcc-hybrid.js"
import type { VccPatchContext } from "../src/vcc.js"

const scope = { host: "opencode-v1" as const, session_id: "hybrid-session", lineage_id: "hybrid-lineage" }

function patchContext(): VccPatchContext {
  const events = [
    normalizeCanonicalEvent({ ...scope, stable_source_id: "hybrid-human", sequence: 0, provenance: "human_direct", kind: "message", goal_ids: ["goal:hybrid"], content: "Preserve this", source_location: "fixture:human" }),
    normalizeCanonicalEvent({ ...scope, stable_source_id: "hybrid-call", sequence: 1, provenance: "tool_call", kind: "tool_call", pair_id: "hybrid-pair", content: "run", source_location: "fixture:call" }),
    normalizeCanonicalEvent({ ...scope, stable_source_id: "hybrid-result", sequence: 2, provenance: "tool_result", kind: "tool_result", pair_id: "hybrid-pair", content: "done", source_location: "fixture:result" }),
  ]
  const episodes = formCausalEpisodes(events)
  const candidate = compileVccCandidate({ events, episodes, source: buildSourceCompleteness({ ...scope, events, terminal_cursor: null }), options: { max_bytes: 100_000 } })
  return {
    candidate,
    docket_bytes: canonicalSerialize({ question: "Which optional episode matters?" }),
    source_index: buildVccPatchSourceIndex({ events, episodes, goal_ids: ["goal:hybrid"], protected_event_ids: candidate.protected_event_ids }),
  }
}

function validPatch(context: VccPatchContext) {
  return {
    version: 1,
    base_digest: buildVccHybridRequest(context).base_digest,
    active_goal_ids: ["goal:hybrid"],
    relations: [],
    episode_hints: [],
    open_loop_hints: [],
    artifact_hints: [],
    drift: { state: "on_track", goal_ids: [], episode_ids: [] },
    missing_from_projection_ids: [],
  }
}

describe("pure VCC hybrid orchestration", () => {
  test("builds a bounded authority request and makes one valid patch call", async () => {
    const context = patchContext()
    const request = buildVccHybridRequest(context)
    const body = JSON.parse(request.bytes) as { candidate_digest: string; docket_digest: string; base_digest: string; source_index: unknown; authority: { instructions: string[]; forbidden_actions: string[] } }
    expect(body.candidate_digest).toBe(context.candidate.digest)
    expect(body.docket_digest).toBe(sha256(context.docket_bytes))
    expect(body.base_digest).toBe(request.base_digest)
    expect(body.source_index).toBeDefined()
    expect(body.authority.instructions.length).toBeGreaterThan(0)
    expect(body.authority.forbidden_actions).toContain("durable_mutation")
    let calls = 0
    const result = await requestVccHybridPatch(context, { request_patch: async () => { calls++; return canonicalSerialize(validPatch(context)) } })
    expect(calls).toBe(1)
    expect(result.accepted).toBe(true)
    expect(result.patch_digest).toMatch(/^[a-f0-9]{64}$/)
  })

  test("falls back byte-identically for invalid patch variants", async () => {
    const context = patchContext()
    const responses = [
      "not json",
      '{"version":1,"version":1}',
      canonicalSerialize({ ...validPatch(context), completion: "done" }),
      canonicalSerialize({ ...validPatch(context), base_digest: "0".repeat(64) }),
    ]
    for (const response of responses) {
      const result = await requestVccHybridPatch(context, { request_patch: async () => response })
      expect(result.accepted).toBe(false)
      expect(result.candidate_bytes).toBe(context.candidate.bytes)
      expect(result.candidate_digest).toBe(context.candidate.digest)
      expect(result.patch_digest).toBeNull()
    }
  })

  test("falls back for refusal, thrown request, and abort without retry", async () => {
    const context = patchContext()
    let calls = 0
    const refused = await requestVccHybridPatch(context, { request_patch: async () => { calls++; return undefined } })
    const thrown = await requestVccHybridPatch(context, { request_patch: async () => { calls++; throw new Error("refused") } })
    const controller = new AbortController()
    controller.abort()
    const aborted = await requestVccHybridPatch(context, { signal: controller.signal, request_patch: async () => { calls++; return canonicalSerialize(validPatch(context)) } })
    expect(calls).toBe(2)
    for (const result of [refused, thrown, aborted]) {
      expect(result.accepted).toBe(false)
      expect(result.candidate_bytes).toBe(context.candidate.bytes)
      expect(result.candidate_digest).toBe(context.candidate.digest)
      expect(result.patch_digest).toBeNull()
    }
  })

  test("bounds request and response without calling twice", async () => {
    const context = patchContext()
    let requestCalls = 0
    const requestTooLarge = await requestVccHybridPatch(context, { max_request_bytes: 1, request_patch: async () => { requestCalls++; return "" } })
    const responseTooLarge = await requestVccHybridPatch(context, { request_patch: async () => { requestCalls++; return "x".repeat(VCC_PATCH_MAX_BYTES + 1) } })
    expect(requestCalls).toBe(1)
    expect(requestTooLarge.reason).toBe("request_oversized")
    expect(responseTooLarge.reason).toBe("response_oversized")
    expect(requestTooLarge.candidate_bytes).toBe(context.candidate.bytes)
    expect(responseTooLarge.candidate_bytes).toBe(context.candidate.bytes)
  })

  test("valid rehearsal changes only optional warning material", async () => {
    const context = patchContext()
    const before = JSON.parse(context.candidate.bytes) as { protected_events: unknown[]; contract_chain: unknown[] }
    const patch = { ...validPatch(context), relations: [{ from: "goal:hybrid", kind: "supports", to: context.source_index.episode_ids[0]!, evidence_event_ids: [context.source_index.event_ids[2]!] }] }
    const result = await requestVccHybridPatch(context, { request_patch: async () => canonicalSerialize(patch) })
    expect(result.accepted).toBe(true)
    expect(result.warnings.length).toBe(1)
    const after = JSON.parse(result.candidate_bytes) as { protected_events: unknown[]; contract_chain: unknown[] }
    expect(after.protected_events).toEqual(before.protected_events)
    expect(after.contract_chain).toEqual(before.contract_chain)
  })

  test("rejects a tampered candidate before making a patch request", async () => {
    const context = patchContext()
    let calls = 0
    const result = await requestVccHybridPatch({ ...context, candidate: { ...context.candidate, bytes: `${context.candidate.bytes}tampered` } }, { request_patch: async () => { calls++; return canonicalSerialize(validPatch(context)) } })
    expect(calls).toBe(0)
    expect(result.reason).toBe("invalid_candidate_context")
    expect(result.patch_digest).toBeNull()
  })
})
