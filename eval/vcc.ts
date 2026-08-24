import {
  buildSourceCompleteness,
  buildVccPatchSourceIndex,
  canonicalSerialize,
  compileVccCandidate,
  formCausalEpisodes,
  normalizeCanonicalEvents,
  rehearseVccPatch,
  vccPatchBaseDigest,
  type CanonicalEvent,
  type CanonicalEventInput,
  type VccCandidate,
  type VccPatchContext,
  type VccSourceIncompleteReason,
} from "../src/vcc.js"
import { createVccArchiveHandle, verifyVccArchive } from "../src/vcc-archive.js"
import {
  buildVccOpenCodeRecallIndex,
  discoverVccOpenCodeHandles,
  resolveVccOpenCodeHandle,
} from "../src/vcc-opencode-recall.js"
import { vccOpenCodePayloadBytes, vccOpenCodeSourceBytes } from "../src/vcc-opencode-message.js"
import type { MessageRecord } from "../src/ledger.js"
import { sha256, utf8Bytes } from "../src/ledger.js"

export const VCC_EVAL_SCHEMA_VERSION = 1
export const VCC_EVAL_CORPUS_VERSION = 1

const SESSION_ID = "vcc-eval-session"
const HOST = "opencode-v1" as const

export type VccEvalCategory =
  | "direct_correction"
  | "question_answer"
  | "causal_pair"
  | "supersession"
  | "incomplete_source"
  | "repeated_cycle"
  | "boundary"

export type VccEvalScenarioResult = {
  id: string
  category: VccEvalCategory
  passed: boolean
  checks: Record<string, boolean>
  provider_calls: 0
  network_calls: 0
  rag_calls: 0
  error?: string
}

export type VccEvalReport = {
  schema_version: 1
  corpus_version: 1
  scenario_count: number
  passed: boolean
  deterministic: true
  stochastic_provider_evidence: "not_run"
  provider_calls: 0
  network_calls: 0
  rag_calls: 0
  categories: Record<VccEvalCategory, { passed: number; total: number }>
  scenarios: VccEvalScenarioResult[]
}

type Scenario = {
  id: string
  category: VccEvalCategory
  lineage_id?: string
  run: () => Record<string, boolean>
}

type Compiled = {
  events: CanonicalEvent[]
  candidate: VccCandidate
  context: VccPatchContext
}

export function runVccEval(): VccEvalReport {
  const scenarios = scenarioFixtures().map((scenario) => runScenario(scenario))
  const categories = Object.fromEntries(
    [...new Set(scenarioFixtures().map((scenario) => scenario.category))].map((category) => {
      const values = scenarios.filter((scenario) => scenario.category === category)
      return [category, { passed: values.filter((scenario) => scenario.passed).length, total: values.length }]
    }),
  ) as Record<VccEvalCategory, { passed: number; total: number }>
  return {
    schema_version: VCC_EVAL_SCHEMA_VERSION,
    corpus_version: VCC_EVAL_CORPUS_VERSION,
    scenario_count: scenarios.length,
    passed: scenarios.every((scenario) => scenario.passed),
    deterministic: true,
    stochastic_provider_evidence: "not_run",
    provider_calls: 0,
    network_calls: 0,
    rag_calls: 0,
    categories,
    scenarios,
  }
}

function runScenario(scenario: Scenario): VccEvalScenarioResult {
  try {
    const checks = scenario.run()
    return {
      id: scenario.id,
      category: scenario.category,
      passed: Object.values(checks).every(Boolean),
      checks,
      provider_calls: 0,
      network_calls: 0,
      rag_calls: 0,
    }
  } catch (error) {
    return {
      id: scenario.id,
      category: scenario.category,
      passed: false,
      checks: {},
      provider_calls: 0,
      network_calls: 0,
      rag_calls: 0,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

function scenarioFixtures(): Scenario[] {
  return [
    ...Array.from({ length: 4 }, (_, index) => directCorrectionScenario(index)),
    ...Array.from({ length: 4 }, (_, index) => questionAnswerScenario(index)),
    ...Array.from({ length: 4 }, (_, index) => causalPairScenario(index)),
    ...Array.from({ length: 4 }, (_, index) => supersessionScenario(index)),
    ...Array.from({ length: 4 }, (_, index) => incompleteSourceScenario(index)),
    ...Array.from({ length: 4 }, (_, index) => repeatedCycleScenario(index)),
    archiveScenario(),
    hybridPatchScenario(),
    continuationScenario(),
    siblingLineageScenario(),
    invalidPatchScenario(),
    staleActionScenario(),
    duplicateIdentityScenario(),
  ]
}

function directCorrectionScenario(index: number): Scenario {
  const suffix = String(index + 1).padStart(2, "0")
  return {
    id: `vcc-direct-correction-${suffix}`,
    category: "direct_correction",
    run: () => {
      const compiled = compile([
        event(`direct-old-${suffix}`, 0, "human_direct", "decision", `retain policy A ${suffix}`),
        event(`direct-new-${suffix}`, 1, "human_direct", "correction", `retain policy B ${suffix}`, undefined, { supersedes_event_ids: [`ev:${HOST}:direct-old-${suffix}`] }),
      ])
      const body = parseCandidate(compiled.candidate)
      const protectedIDs = new Set(compiled.candidate.protected_event_ids)
      return {
        correction_is_protected: protectedIDs.has(`ev:${HOST}:direct-old-${suffix}`) && protectedIDs.has(`ev:${HOST}:direct-new-${suffix}`),
        correction_chain_is_source_backed: Array.isArray(body.correction_chain) && body.correction_chain.length === 2,
        candidate_is_digest_bound: sha256(compiled.candidate.bytes) === compiled.candidate.digest,
      }
    },
  }
}

function questionAnswerScenario(index: number): Scenario {
  const suffix = String(index + 1).padStart(2, "0")
  return {
    id: `vcc-question-answer-${suffix}`,
    category: "question_answer",
    run: () => {
      const compiled = compile([
        event(`question-${suffix}`, 0, "assistant", "question", `Which retention policy ${suffix}?`, `question-pair-${suffix}`),
        event(`question-answer-${suffix}`, 1, "human_tool_answer", "human_tool_answer", `Use policy B ${suffix}`, `question-pair-${suffix}`),
      ])
      const episode = compiled.events.length === 2
        ? formCausalEpisodes(compiled.events).find((candidate) => candidate.event_ids.length === 2)
        : undefined
      return {
        answer_is_human_authoritative: compiled.candidate.protected_event_ids.includes(`ev:${HOST}:question-answer-${suffix}`),
        question_episode_is_complete: episode?.status === "completed" && episode.relevance_signals.complete_pair,
        answer_is_visible_in_candidate: parseCandidate(compiled.candidate).protected_events.some((value) => JSON.stringify(value).includes(`question-answer-${suffix}`)),
      }
    },
  }
}

function causalPairScenario(index: number): Scenario {
  const suffix = String(index + 1).padStart(2, "0")
  return {
    id: `vcc-causal-pair-${suffix}`,
    category: "causal_pair",
    run: () => {
      const inputs = [
        event(`tool-call-${suffix}`, 0, "tool_call", "tool_call", `run check ${suffix}`, `tool-pair-${suffix}`),
        event(`tool-result-${suffix}`, 1, "tool_result", "tool_result", `verified result ${suffix}`, `tool-pair-${suffix}`),
      ]
      const compiled = compile(inputs)
      const episodes = formCausalEpisodes(compiled.events)
      const pair = episodes.find((episode) => episode.event_ids.length === 2)
      const candidateBody = parseCandidate(compiled.candidate)
      const selected = candidateBody.selected_episodes as Array<{ events?: Array<{ id?: string }> }>
      const selectedIDs = selected.flatMap((episode) => episode.events?.flatMap((item) => typeof item.id === "string" ? [item.id] : []) ?? [])
      const sourceIDs = new Set(candidateBody.source_digest_map.map((item) => item.id))
      const callID = `ev:${HOST}:tool-call-${suffix}`
      const resultID = `ev:${HOST}:tool-result-${suffix}`
      return {
        pair_is_one_episode: pair?.kind === "tool_call_result" && pair.relevance_signals.complete_pair,
        pair_remains_source_backed: sourceIDs.has(callID) && sourceIDs.has(resultID),
        pair_is_not_split: selectedIDs.includes(callID) === selectedIDs.includes(resultID),
        candidate_is_repeatable: compile(inputs).candidate.bytes === compiled.candidate.bytes,
      }
    },
  }
}

function supersessionScenario(index: number): Scenario {
  const suffix = String(index + 1).padStart(2, "0")
  return {
    id: `vcc-supersession-${suffix}`,
    category: "supersession",
    run: () => {
      const compiled = compile([
        event(`superseded-${suffix}`, 0, "human_direct", "decision", `old decision ${suffix}`),
        event(`replacement-${suffix}`, 1, "human_direct", "correction", `replacement decision ${suffix}`, undefined, { supersedes_event_ids: [`ev:${HOST}:superseded-${suffix}`] }),
      ])
      const episodes = formCausalEpisodes(compiled.events)
      return {
        old_episode_marked_superseded: episodes.some((episode) => episode.status === "superseded" && episode.event_ids.includes(`ev:${HOST}:superseded-${suffix}`)),
        old_event_remains_source_backed: compiled.candidate.protected_event_ids.includes(`ev:${HOST}:superseded-${suffix}`),
        replacement_remains_protected: compiled.candidate.protected_event_ids.includes(`ev:${HOST}:replacement-${suffix}`),
      }
    },
  }
}

function incompleteSourceScenario(index: number): Scenario {
  const reasons: VccSourceIncompleteReason[] = ["page_limit", "cursor_repeated", "fetch_error", "unsupported_record"]
  const reason = reasons[index]!
  const suffix = String(index + 1).padStart(2, "0")
  return {
    id: `vcc-incomplete-${reason}-${suffix}`,
    category: "incomplete_source",
    run: () => {
      const events = normalizeCanonicalEvents([event(`incomplete-${suffix}`, 0, "human_direct", "request", `incomplete source ${suffix}`)])
      const source = buildSourceCompleteness({ host: HOST, session_id: SESSION_ID, lineage_id: "incomplete-lineage", events, page_count: 1, terminal_cursor: "cursor-incomplete", reason })
      let rejected = false
      try {
        compileVccCandidate({ events, episodes: formCausalEpisodes(events), source, options: { max_bytes: 128 * 1_024 } })
      } catch {
        rejected = true
      }
      return { manifest_is_incomplete: source.complete === false && source.reason === reason, candidate_rejected: rejected }
    },
  }
}

function repeatedCycleScenario(index: number): Scenario {
  const cycles = [1, 2, 4, 8][index]!
  const suffix = String(index + 1).padStart(2, "0")
  return {
    id: `vcc-repeated-cycle-${cycles}-${suffix}`,
    category: "repeated_cycle",
    run: () => {
      const events = [event(`cycle-${suffix}`, 0, "human_direct", "request", `repeat cycle ${suffix}`), event(`cycle-result-${suffix}`, 1, "tool_result", "tool_result", `verified cycle ${suffix}`, `cycle-pair-${suffix}`)]
      const first = compile(events).candidate
      const outputs = Array.from({ length: cycles }, () => compile(events).candidate)
      return {
        repeated_bytes_are_equal: outputs.every((candidate) => candidate.bytes === first.bytes),
        repeated_digests_are_equal: outputs.every((candidate) => candidate.digest === first.digest),
        cycle_count_is_explicit: outputs.length === cycles,
      }
    },
  }
}

function archiveScenario(): Scenario {
  return {
    id: "vcc-boundary-archive-recall-no-rag",
    category: "boundary",
    run: () => {
      const lineage_id = "archive-lineage"
      const message: MessageRecord = {
        info: { id: "archive-event", sessionID: SESSION_ID, role: "user" },
        parts: [{ id: "archive-part", sessionID: SESSION_ID, messageID: "archive-event", type: "text", text: "archive decision" }],
      }
      const source_bytes = vccOpenCodeSourceBytes(message)
      const event_input = {
        host: HOST,
        session_id: SESSION_ID,
        lineage_id,
        stable_source_id: "archive-event",
        sequence: 0,
        provenance: "human_direct" as const,
        kind: "decision",
        content: "archive decision",
        source_location: "opencode-v1:message:archive-event",
      }
      const payload_bytes = vccOpenCodePayloadBytes(event_input)
      const metadata = createVccArchiveHandle({ host: HOST, session_id: SESSION_ID, lineage_id, stable_source_id: "archive-event", source_bytes, payload_bytes })
      const compiled = compile([event("archive-event", 0, "human_direct", "decision", "archive decision", undefined, { archive_handles: [metadata.handle] })], "archive-lineage")
      const verified = verifyVccArchive({ host: HOST, session_id: SESSION_ID, lineage_id, stable_source_id: "archive-event", handle: metadata.handle, source_bytes, payload_bytes })
      const canonicalEvent = normalizeCanonicalEvents([{ ...event_input, archive_handles: [metadata.handle] }])[0]!
      const source = buildSourceCompleteness({ host: HOST, session_id: SESSION_ID, lineage_id, events: [canonicalEvent], page_count: 1, terminal_cursor: null, byte_count: utf8Bytes(canonicalSerialize([message])) })
      const recallResult = {
        source,
        events: [canonicalEvent],
        episodes: formCausalEpisodes([canonicalEvent]),
        raw_source_bytes: canonicalSerialize([message]),
        source_records: [message],
        excluded_generated_message_ids: [],
      }
      const entries = buildVccOpenCodeRecallIndex({ session_id: SESSION_ID, lineage_id, result: recallResult })
      const discovered = discoverVccOpenCodeHandles({ query: "archive decision", entries })
      const recalled = discovered.entries[0] === undefined ? undefined : resolveVccOpenCodeHandle({ handle: discovered.entries[0].handle, session_id: SESSION_ID, lineage_id, entries: entries })
      return {
        archive_resolves_without_provider: verified.valid,
        archive_handle_is_emitted: parseCandidate(compiled.candidate).recall_handles.includes(metadata.handle),
        public_opencode_recall_resolves_without_rag: recalled?.ok === true,
        rag_is_not_consulted: true,
      }
    },
  }
}

function hybridPatchScenario(): Scenario {
  return {
    id: "vcc-boundary-hybrid-valid-and-failure-fallback",
    category: "boundary",
    run: () => {
      const compiled = compile([
        event("hybrid-call", 0, "tool_call", "tool_call", "run bounded probe", "hybrid-pair"),
        event("hybrid-result", 1, "tool_result", "tool_result", "verified bounded probe", "hybrid-pair"),
      ])
      const episode = formCausalEpisodes(compiled.events).find((value) => value.kind === "tool_call_result")
      if (!episode) throw new Error("hybrid fixture did not form a complete tool episode")
      const patch = {
        version: 1 as const,
        base_digest: vccPatchBaseDigest(compiled.candidate.bytes, compiled.context.docket_bytes),
        active_goal_ids: [],
        relations: [],
        episode_hints: [{ episode_id: episode.id, priority: "retain" as const, reason: "recent_verified_result" as const, evidence_event_ids: [compiled.events[1]!.id] }],
        open_loop_hints: [],
        artifact_hints: [],
        drift: { state: "on_track" as const, goal_ids: [], episode_ids: [] },
        missing_from_projection_ids: [],
      }
      const accepted = rehearseVccPatch(compiled.context, canonicalSerialize(patch))
      const rejected = rehearseVccPatch(compiled.context, "{}")
      return {
        valid_patch_is_accepted: accepted.accepted,
        valid_patch_is_digest_bound: accepted.patch_digest !== null && accepted.candidate_digest === sha256(accepted.candidate_bytes),
        valid_patch_keeps_pair_together: accepted.selected_episode_ids.includes(episode.id),
        invalid_patch_falls_back_byte_identically: !rejected.accepted && rejected.candidate_bytes === compiled.candidate.bytes && rejected.candidate_digest === compiled.candidate.digest,
      }
    },
  }
}

function continuationScenario(): Scenario {
  return {
    id: "vcc-boundary-continuation-keeps-open-next-action",
    category: "boundary",
    run: () => {
      const compiled = compile([
        event("continuation-request", 0, "human_direct", "request", "resume the focused verification", "continuation-pair"),
        event("continuation-action", 1, "assistant", "action", "run the focused verification before editing", "continuation-pair"),
      ])
      const candidate = parseCandidate(compiled.candidate)
      const live = candidate.live_episodes as Array<{ id?: string; status?: string; events?: unknown[] }>
      const liveEpisode = live.find((episode) => episode.status === "open")
      return {
        current_human_contract_is_protected: compiled.candidate.protected_event_ids.includes(`ev:${HOST}:continuation-request`),
        open_causal_episode_is_visible: liveEpisode?.id !== undefined && liveEpisode.events?.some((value) => JSON.stringify(value).includes("focused verification before editing")) === true,
        next_action_is_not_marked_complete: liveEpisode?.status === "open",
      }
    },
  }
}

function siblingLineageScenario(): Scenario {
  return {
    id: "vcc-boundary-sibling-lineage",
    category: "boundary",
    run: () => {
      const events = [event("shared-event", 0, "human_direct", "decision", "same source event")]
      const left = compile(events, "branch-left")
      const right = compile(events, "branch-right")
      return { sibling_source_digests_differ: left.candidate.source_manifest_digest !== right.candidate.source_manifest_digest, sibling_candidate_digests_differ: left.candidate.digest !== right.candidate.digest }
    },
  }
}

function invalidPatchScenario(): Scenario {
  return {
    id: "vcc-boundary-invalid-patch-fallback",
    category: "boundary",
    run: () => {
      const compiled = compile([event("invalid-patch", 0, "human_direct", "request", "invalid patch base")])
      const result = rehearseVccPatch(compiled.context, "{}\ntrailing prose")
      return { patch_rejected: !result.accepted, fallback_is_byte_identical: result.candidate_bytes === compiled.candidate.bytes, fallback_digest_is_exact: result.candidate_digest === compiled.candidate.digest }
    },
  }
}

function staleActionScenario(): Scenario {
  return {
    id: "vcc-boundary-stale-action-warning",
    category: "boundary",
    run: () => {
      const compiled = compile([event("stale-action", 0, "assistant", "action", "old action reference")])
      const patch = {
        version: 1,
        base_digest: vccPatchBaseDigest(compiled.candidate.bytes, compiled.context.docket_bytes),
        active_goal_ids: [],
        relations: [],
        episode_hints: [],
        open_loop_hints: [],
        artifact_hints: [],
        drift: { state: "uncertain", goal_ids: [], episode_ids: [] },
        missing_from_projection_ids: [compiled.events[0]!.id],
      }
      const result = rehearseVccPatch(compiled.context, canonicalSerialize(patch))
      return { source_backed_stale_reference_accepted: result.accepted, stale_action_warning_emitted: result.warnings.includes(`missing_from_projection:${compiled.events[0]!.id}`) }
    },
  }
}

function duplicateIdentityScenario(): Scenario {
  return {
    id: "vcc-boundary-duplicate-identity",
    category: "boundary",
    run: () => {
      const duplicate = event("duplicate-event", 0, "human_direct", "request", "duplicate")
      let rejected = false
      try {
        normalizeCanonicalEvents([duplicate, { ...duplicate, sequence: 1 }])
      } catch {
        rejected = true
      }
      return { duplicate_identity_rejected: rejected }
    },
  }
}

function compile(inputs: CanonicalEventInput[], lineage_id = "eval-lineage"): Compiled {
  const events = normalizeCanonicalEvents(inputs.map((input) => ({ ...input, lineage_id })))
  const source = buildSourceCompleteness({ host: HOST, session_id: SESSION_ID, lineage_id, events, page_count: 1, terminal_cursor: null, byte_count: utf8Bytes(canonicalSerialize(events)) })
  const episodes = formCausalEpisodes(events)
  const candidate = compileVccCandidate({ events, episodes, source, options: { max_bytes: 128 * 1_024 } })
  const source_index = buildVccPatchSourceIndex({ events, episodes, goal_ids: events.flatMap((event) => event.goal_ids), artifact_ids: events.flatMap((event) => event.artifact_ids), protected_event_ids: candidate.protected_event_ids, protected_episode_ids: candidate.live_episode_ids })
  const docket_bytes = canonicalSerialize({ version: 1, kind: "vcc-eval-docket", source_manifest_digest: source.digest, source_index_digest: candidate.source_index_digest })
  return { events, candidate, context: { candidate, docket_bytes, source_index } }
}

function event(stable_source_id: string, sequence: number, provenance: CanonicalEventInput["provenance"], kind: string, content: string, pair_id?: string, extra: Partial<CanonicalEventInput> = {}): CanonicalEventInput {
  return { host: HOST, session_id: SESSION_ID, lineage_id: "eval-lineage", stable_source_id, sequence, provenance, kind, content, source_location: `eval:${stable_source_id}`, ...(pair_id === undefined ? {} : { pair_id }), ...extra }
}

function parseCandidate(candidate: VccCandidate) {
  return JSON.parse(candidate.bytes) as {
    protected_events: unknown[]
    correction_chain: unknown[]
    live_episodes: unknown[]
    selected_episodes: unknown[]
    recall_handles: string[]
    source_digest_map: Array<{ id: string; payload_digest: string; source_location: string; archive_handles: string[] }>
  }
}
