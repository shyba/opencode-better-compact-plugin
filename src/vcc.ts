import { redact, sha256, truncateUtf8, utf8Bytes } from "./ledger.js"

export const VCC_SCHEMA_VERSION = 1
export const VCC_HOSTS = ["pi", "opencode-v1"] as const
export type VccHost = (typeof VCC_HOSTS)[number]

export const VCC_PROVENANCE = [
  "human_direct",
  "human_tool_answer",
  "human_approval",
  "human_rejection",
  "assistant",
  "tool_call",
  "tool_result",
  "system",
  "host_state",
] as const
export type VccProvenance = (typeof VCC_PROVENANCE)[number]

export const VCC_SOURCE_INCOMPLETE_REASONS = [
  "cursor_repeated",
  "empty_page_with_cursor",
  "page_limit",
  "byte_limit",
  "fetch_error",
  "invalid_cursor",
  "oversized_page",
  "duplicate_message_id",
  "cross_session_record",
  "lineage_ambiguous",
  "source_shrink",
  "unsupported_record",
  "unknown",
] as const
export type VccSourceIncompleteReason = (typeof VCC_SOURCE_INCOMPLETE_REASONS)[number]

export type CanonicalEventInput = {
  host: VccHost
  session_id: string
  lineage_id: string
  stable_source_id: string
  sequence: number
  provenance: VccProvenance
  kind: string
  content: string | unknown
  source_location: string
  pair_id?: string
  derived_from_event_ids?: string[]
  supersedes_event_ids?: string[]
  goal_ids?: string[]
  artifact_ids?: string[]
  evidence_event_ids?: string[]
  archive_handles?: string[]
  authoritative?: boolean
  advisory?: boolean
}

export type CanonicalEvent = {
  version: 1
  id: string
  host: VccHost
  session_id: string
  lineage_id: string
  sequence: number
  provenance: VccProvenance
  kind: string
  pair_id: string | null
  derived_from_event_ids: string[]
  supersedes_event_ids: string[]
  goal_ids: string[]
  artifact_ids: string[]
  evidence_event_ids: string[]
  archive_handles: string[]
  content: string
  payload_digest: string
  authority: "authoritative" | "advisory"
  source_location: string
}

export type SourceCompleteness = {
  version: 1
  host: VccHost
  session_id: string
  lineage_id: string
  complete: boolean
  reason: VccSourceIncompleteReason | null
  page_count: number
  record_count: number
  first_source_id: string | null
  last_source_id: string | null
  terminal_cursor: string | null
  terminal_cursor_observed: boolean
  byte_count: number
  digest: string
}

export const VCC_EPISODE_STATUSES = ["open", "completed", "blocked", "superseded", "uncertain"] as const
export type VccEpisodeStatus = (typeof VCC_EPISODE_STATUSES)[number]

export type CausalEpisode = {
  version: 1
  id: string
  kind: string
  event_ids: string[]
  goal_ids: string[]
  status: VccEpisodeStatus
  exact_identifiers: string[]
  artifact_ids: string[]
  evidence_event_ids: string[]
  archive_handles: string[]
  relevance_signals: {
    event_count: number
    latest_sequence: number
    human_provenance_count: number
    goal_count: number
    artifact_count: number
    evidence_count: number
    complete_pair: boolean
  }
}

export type VccCompileOptions = {
  max_bytes: number
  protected_event_ids?: string[]
  protected_episode_ids?: string[]
  active_goal_ids?: string[]
}

export type VccCandidate = {
  version: 1
  bytes: string
  digest: string
  source_manifest_digest: string
  source_index_digest: string
  protected_event_ids: string[]
  live_episode_ids: string[]
  selected_episode_ids: string[]
}

export const VCC_PATCH_MAX_BYTES = 32_768
export const PATCH_RELATION_KINDS = ["supports", "blocks", "orthogonal", "conflicts", "explicitly_superseded_by", "uncertain"] as const
export const PATCH_EPISODE_PRIORITIES = ["foreground", "retain", "neutral", "archive_candidate"] as const
export const PATCH_EPISODE_REASONS = ["nonrepeatable_evidence", "active_blocker", "explicit_decision", "exact_identifier", "goal_support", "recent_verified_result", "uncertain_relevance"] as const
export const PATCH_LOOP_STATES = ["active", "possibly_stale", "uncertain"] as const
export const PATCH_ARTIFACT_CLASSES = ["product", "generated", "scratch", "operational", "unknown"] as const
export const PATCH_ARTIFACT_DISPOSITIONS = ["foreground", "manifest", "review_cleanup", "unknown"] as const
export const PATCH_DRIFT_STATES = ["on_track", "suspect", "drift", "uncertain"] as const

export type VccPatch = {
  version: 1
  base_digest: string
  active_goal_ids: string[]
  relations: Array<{ from: string; kind: (typeof PATCH_RELATION_KINDS)[number]; to: string; evidence_event_ids: string[] }>
  episode_hints: Array<{ episode_id: string; priority: (typeof PATCH_EPISODE_PRIORITIES)[number]; reason: (typeof PATCH_EPISODE_REASONS)[number]; evidence_event_ids: string[] }>
  open_loop_hints: Array<{ object_id: string; state: (typeof PATCH_LOOP_STATES)[number]; evidence_event_ids: string[]; evidence_episode_ids: string[] }>
  artifact_hints: Array<{ artifact_id: string; class: (typeof PATCH_ARTIFACT_CLASSES)[number]; disposition: (typeof PATCH_ARTIFACT_DISPOSITIONS)[number]; evidence_event_ids: string[]; evidence_episode_ids: string[] }>
  drift: { state: (typeof PATCH_DRIFT_STATES)[number]; goal_ids: string[]; episode_ids: string[] }
  missing_from_projection_ids: string[]
}

export type VccPatchSourceIndex = {
  event_ids: string[]
  episode_ids: string[]
  goal_ids: string[]
  loop_ids: string[]
  artifact_ids: string[]
  protected_event_ids: string[]
  protected_episode_ids: string[]
  protected_goal_ids: string[]
  correction_gate: Array<{ from: string; to: string; evidence_event_ids: string[] }>
}

export type VccPatchContext = {
  candidate: VccCandidate
  docket_bytes: string
  source_index: VccPatchSourceIndex
}

export type VccPatchValidation =
  | { accepted: true; patch: VccPatch; patch_digest: string; base_digest: string }
  | { accepted: false; reason: string; candidate_bytes: string; candidate_digest: string }

export type VccPatchApplication = {
  accepted: boolean
  candidate_bytes: string
  candidate_digest: string
  patch_digest: string | null
  selected_episode_ids: string[]
  warnings: string[]
}

export function canonicalEventId(host: VccHost, stableSourceID: string) {
  requireHost(host)
  requireStableSourceID(stableSourceID)
  return `ev:${host}:${stableSourceID}`
}

/** Canonical bytes use sorted object keys, preserved Unicode, and one LF. */
export function canonicalSerialize(value: unknown) {
  const serialized = serializeValue(value)
  return serialized.endsWith("\n") ? serialized : `${serialized}\n`
}

export function normalizeCanonicalEvent(input: CanonicalEventInput): CanonicalEvent {
  requireHost(input.host)
  requireNonEmpty(input.session_id, "session_id")
  requireNonEmpty(input.lineage_id, "lineage_id")
  requireStableSourceID(input.stable_source_id)
  if (!Number.isSafeInteger(input.sequence) || input.sequence < 0) throw new TypeError("sequence must be a non-negative safe integer")
  if (!VCC_PROVENANCE.includes(input.provenance)) throw new TypeError(`unsupported provenance: ${input.provenance}`)
  requireNonEmpty(input.kind, "kind")
  requireNonEmpty(input.source_location, "source_location")
  if (input.authoritative && input.advisory) throw new TypeError("an event cannot be authoritative and advisory")
  const content = truncateUtf8(redact(typeof input.content === "string" ? input.content : canonicalSerialize(input.content)), 16_384)
  const derived = normalizeIDs(input.derived_from_event_ids ?? [], "derived_from_event_ids")
  const supersedes = normalizeIDs(input.supersedes_event_ids ?? [], "supersedes_event_ids")
  const goals = normalizeTypedIDs(input.goal_ids ?? [], "goal_ids", "goal")
  const artifacts = normalizeTypedIDs(input.artifact_ids ?? [], "artifact_ids", "artifact")
  const evidence = normalizeIDs(input.evidence_event_ids ?? [], "evidence_event_ids")
  const archives = normalizeArchiveHandles(input.archive_handles ?? [])
  const event: Omit<CanonicalEvent, "payload_digest"> = {
    version: 1,
    id: canonicalEventId(input.host, input.stable_source_id),
    host: input.host,
    session_id: input.session_id,
    lineage_id: input.lineage_id,
    sequence: input.sequence,
    provenance: input.provenance,
    kind: input.kind,
    pair_id: input.pair_id ?? null,
    derived_from_event_ids: derived,
    supersedes_event_ids: supersedes,
    goal_ids: goals,
    artifact_ids: artifacts,
    evidence_event_ids: evidence,
    archive_handles: archives,
    content,
    authority: input.authoritative === false || input.advisory ? "advisory" : "authoritative",
    source_location: input.source_location,
  }
  return { ...event, payload_digest: sha256(canonicalSerialize(event)) }
}

export function normalizeCanonicalEvents(inputs: CanonicalEventInput[]) {
  const events = inputs.map(normalizeCanonicalEvent).sort((left, right) => left.sequence - right.sequence || compareCodePoints(left.id, right.id))
  const seen = new Set<string>()
  for (const event of events) {
    if (seen.has(event.id)) throw new TypeError(`duplicate canonical event identity: ${event.id}`)
    seen.add(event.id)
  }
  return events
}

/**
 * Forms the smallest source-backed causal units. Pair membership is taken only
 * from the canonical pair_id; adjacent events are never implicitly joined.
 */
export function formCausalEpisodes(events: CanonicalEvent[]): CausalEpisode[] {
  const groups = new Map<string, CanonicalEvent[]>()
  for (const event of events) {
    const scope = `${event.host}\0${event.session_id}\0${event.lineage_id}`
    const key = event.pair_id === null ? `${scope}\0event:${event.id}` : `${scope}\0pair:${event.pair_id}`
    groups.set(key, [...(groups.get(key) ?? []), event])
  }
  const episodes = [...groups.values()].map((group) => buildCausalEpisode(group))
  const superseded = new Set(events.flatMap((event) => event.supersedes_event_ids))
  return episodes.map((episode) => episode.event_ids.some((eventID) => superseded.has(eventID)) ? { ...episode, status: "superseded" as const } : episode).sort((left, right) => compareCodePoints(left.id, right.id))
}

function buildCausalEpisode(group: CanonicalEvent[]): CausalEpisode {
  const ordered = [...group].sort((left, right) => left.sequence - right.sequence || compareCodePoints(left.id, right.id))
  const pattern = causalPattern(ordered)
  const event_ids = ordered.map((event) => event.id)
  const goal_ids = uniqueSorted(ordered.flatMap((event) => event.goal_ids))
  const artifact_ids = uniqueSorted(ordered.flatMap((event) => event.artifact_ids))
  const evidence_event_ids = uniqueSorted(ordered.flatMap((event) => event.evidence_event_ids))
  const archive_handles = uniqueSorted(ordered.flatMap((event) => event.archive_handles))
  const exact_identifiers = uniqueSorted([...event_ids, ...ordered.map((event) => event.source_location), ...ordered.flatMap((event) => event.pair_id === null ? [] : [event.pair_id]), ...goal_ids, ...artifact_ids, ...archive_handles])
  const relevance_signals = {
    event_count: ordered.length,
    latest_sequence: ordered.at(-1)?.sequence ?? 0,
    human_provenance_count: ordered.filter((event) => event.provenance.startsWith("human_")).length,
    goal_count: goal_ids.length,
    artifact_count: artifact_ids.length,
    evidence_count: evidence_event_ids.length,
    complete_pair: pattern.complete,
  }
  const body = {
    version: 1 as const,
    kind: pattern.kind,
    event_ids,
    goal_ids,
    status: pattern.status,
    exact_identifiers,
    artifact_ids,
    evidence_event_ids,
    archive_handles,
    relevance_signals,
  }
  return { ...body, id: `ep:${sha256(`vcc-episode-v1\0${canonicalSerialize(body)}`)}` } satisfies CausalEpisode
}

function causalPattern(events: CanonicalEvent[]) {
  const kinds = new Set(events.map((event) => event.kind))
  const has = (...required: string[]) => required.every((kind) => kinds.has(kind))
  const hasHumanToolAnswer = events.some(
    (event) => event.provenance === "human_tool_answer" && (event.kind === "human_tool_answer" || event.kind === "question_answer"),
  )
  const questionCancelled = kinds.has("question_cancelled")
  const complete =
    has("tool_call", "tool_result") ||
    (kinds.has("question") && (hasHumanToolAnswer || questionCancelled)) ||
    (has("tool_call", "question_answer") && hasHumanToolAnswer) ||
    has("request", "action", "result") ||
    has("experiment", "observation") ||
    (kinds.has("edit") && (kinds.has("test") || kinds.has("review"))) ||
    has("decision", "consequence") ||
    has("failure", "correction", "verified_outcome") ||
    has("failure", "correction", "verified_result")
  const kind =
    has("tool_call", "tool_result") ? "tool_call_result" :
      has("tool_call", "question_answer") && hasHumanToolAnswer ? "question_answer" :
      kinds.has("question") ? "question_answer" :
        has("request", "action", "result") ? "request_action_result" :
          has("experiment", "observation") ? "experiment_observation" :
            kinds.has("edit") ? "edit_verification" :
              kinds.has("decision") ? "decision_consequence" :
                kinds.has("failure") ? "failure_correction" : events[0]?.kind ?? "unknown"
  return { kind, complete, status: questionCancelled && kinds.has("question") ? "blocked" as const : complete ? "completed" as const : "open" as const }
}

export function compileVccCandidate(input: {
  events: CanonicalEvent[]
  episodes: CausalEpisode[]
  source: SourceCompleteness
  options: VccCompileOptions
}): VccCandidate {
  assertCompleteSource(input.source)
  if (!Number.isSafeInteger(input.options.max_bytes) || input.options.max_bytes <= 0) throw new TypeError("max_bytes must be a positive safe integer")
  const events = orderedSourceEvents(input.events, input.source)
  if (events.some((event) => ["summary", "compaction", "plugin_summary", "generated_summary"].includes(event.kind))) throw new Error("VCC candidate cannot use generated summary events as source")
  validateEventPayloads(events)
  const episodes = validateEpisodeCoverage(input.episodes, events)
  const expectedEpisodes = formCausalEpisodes(events)
  if (canonicalSerialize(episodes) !== canonicalSerialize(expectedEpisodes)) throw new Error("causal episodes do not match canonical event formation")
  const eventByID = new Map(events.map((event) => [event.id, event]))
  for (const event of events) {
    for (const reference of [...event.derived_from_event_ids, ...event.supersedes_event_ids, ...event.evidence_event_ids]) {
      if (!eventByID.has(reference)) throw new Error(`event reference is not source-backed: ${reference}`)
    }
  }
  const episodeByID = new Map(episodes.map((episode) => [episode.id, episode]))
  const explicitProtectedEventIDs = normalizeIDs(input.options.protected_event_ids ?? [], "protected_event_ids")
  if (explicitProtectedEventIDs.some((eventID) => !eventByID.has(eventID))) throw new TypeError("protected_event_ids contains an unknown event")
  const explicitProtectedEpisodeIDs = input.options.protected_episode_ids ?? []
  if (new Set(explicitProtectedEpisodeIDs).size !== explicitProtectedEpisodeIDs.length || explicitProtectedEpisodeIDs.some((id) => !episodeByID.has(id))) throw new TypeError("protected_episode_ids contains an unknown or duplicate episode")
  const protectedEventIDs = new Set(explicitProtectedEventIDs)
  for (const event of events) {
    if (event.provenance === "human_direct" || event.provenance === "human_tool_answer" || event.provenance === "human_approval" || event.provenance === "human_rejection") protectedEventIDs.add(event.id)
    for (const target of event.supersedes_event_ids) protectedEventIDs.add(target)
  }
  const liveEpisodeIDs = new Set<string>()
  for (const episode of episodes) {
    if (episode.status === "open" || episode.status === "blocked" || episode.status === "uncertain" || explicitProtectedEpisodeIDs.includes(episode.id)) {
      liveEpisodeIDs.add(episode.id)
      for (const eventID of episode.event_ids) protectedEventIDs.add(eventID)
    }
  }
  const protectedEvents = events.filter((event) => protectedEventIDs.has(event.id))
  const activeGoalIDs = uniqueSorted([
    ...normalizeTypedIDs(input.options.active_goal_ids ?? [], "active_goal_ids", "goal"),
    ...protectedEvents.flatMap((event) => event.goal_ids),
    ...episodes.filter((episode) => liveEpisodeIDs.has(episode.id)).flatMap((episode) => episode.goal_ids),
  ])
  const liveEpisodes = episodes.filter((episode) => liveEpisodeIDs.has(episode.id))
  const correctionChain = protectedEvents.filter((event) => event.supersedes_event_ids.length > 0 || [...eventByID.values()].some((candidate) => candidate.supersedes_event_ids.includes(event.id)))
  const sourceDigestMap = events.map((event) => ({ id: event.id, payload_digest: event.payload_digest, source_location: event.source_location, archive_handles: event.archive_handles }))
  const archiveHandles = uniqueSorted(events.flatMap((event) => event.archive_handles))
  const archiveManifest = archiveHandles.map((handle) => ({ handle, event_ids: events.filter((event) => event.archive_handles.includes(handle)).map((event) => event.id) }))
  const sourceIndexDigest = sha256(canonicalSerialize(sourceDigestMap))
  const contractChain = protectedEvents.filter((event) => event.provenance === "human_direct" || event.provenance === "human_tool_answer" || event.provenance === "human_approval" || event.provenance === "human_rejection" || event.supersedes_event_ids.length > 0 || [...eventByID.values()].some((candidate) => candidate.supersedes_event_ids.includes(event.id)))
  const mandatory = {
    version: 1 as const,
    kind: "vcc_candidate" as const,
    source_complete: true as const,
    source_manifest_digest: input.source.digest,
    source_index_digest: sourceIndexDigest,
    protected_events: protectedEvents.map(renderEvent),
    contract_chain: contractChain.map(renderEvent),
    correction_chain: correctionChain.map(renderEvent),
    active_goal_ids: activeGoalIDs,
    live_episodes: liveEpisodes.map((episode) => renderEpisode(episode, eventByID)),
    blockers: liveEpisodes
      .filter((episode) => episode.status === "blocked" || episode.status === "uncertain")
      .map((episode) => renderEpisode(episode, eventByID)),
    selected_episodes: [] as unknown[],
    archive_manifest: archiveManifest,
    recall_handles: archiveHandles,
    source_digest_map: sourceDigestMap,
  }
  const mandatoryBytes = canonicalSerialize(mandatory)
  if (utf8Bytes(mandatoryBytes) > input.options.max_bytes) throw new RangeError("mandatory VCC candidate exceeds max_bytes")
  const completeEpisodes = episodes.filter((episode) => episode.status === "completed" && !episode.event_ids.some((eventID) => protectedEventIDs.has(eventID)))
  const selectedEpisodes = selectCompleteEpisodes(completeEpisodes, mandatory, eventByID, input.options.max_bytes)
  const body = { ...mandatory, selected_episodes: selectedEpisodes.map((episode) => renderEpisode(episode, eventByID)) }
  const bytes = canonicalSerialize(body)
  if (utf8Bytes(bytes) > input.options.max_bytes) throw new RangeError("VCC candidate exceeds max_bytes")
  return {
    version: 1,
    bytes,
    digest: sha256(bytes),
    source_manifest_digest: input.source.digest,
    source_index_digest: sourceIndexDigest,
    protected_event_ids: [...protectedEventIDs].sort(compareCodePoints),
    live_episode_ids: liveEpisodes.map((episode) => episode.id).sort(compareCodePoints),
    selected_episode_ids: selectedEpisodes.map((episode) => episode.id),
  }
}

function orderedSourceEvents(events: CanonicalEvent[], source: SourceCompleteness) {
  const ordered = [...events].sort((left, right) => left.sequence - right.sequence || compareCodePoints(left.id, right.id))
  if (ordered.length !== source.record_count || ordered[0]?.id !== source.first_source_id || ordered.at(-1)?.id !== source.last_source_id) throw new Error("VCC events do not match complete source manifest")
  const seen = new Set<string>()
  for (const event of ordered) {
    if (seen.has(event.id) || event.host !== source.host || event.session_id !== source.session_id || event.lineage_id !== source.lineage_id) throw new Error("VCC events do not match complete source scope")
    seen.add(event.id)
  }
  return ordered
}

function validateEventPayloads(events: CanonicalEvent[]) {
  for (const event of events) {
    const { payload_digest: _payloadDigest, ...withoutPayloadDigest } = event
    if (sha256(canonicalSerialize(withoutPayloadDigest)) !== event.payload_digest) throw new Error(`event payload digest mismatch: ${event.id}`)
  }
}

function validateEpisodeCoverage(episodes: CausalEpisode[], events: CanonicalEvent[]) {
  const eventIDs = new Set(events.map((event) => event.id))
  const covered = new Set<string>()
  const episodeIDs = new Set<string>()
  for (const episode of episodes) {
    if (!/^ep:[a-f0-9]{64}$/.test(episode.id) || episodeIDs.has(episode.id) || episode.event_ids.length === 0) throw new Error("invalid or duplicate causal episode")
    episodeIDs.add(episode.id)
    for (const eventID of episode.event_ids) {
      if (!eventIDs.has(eventID) || covered.has(eventID)) throw new Error("causal episodes split or omit a canonical event")
      covered.add(eventID)
    }
  }
  if (covered.size !== events.length) throw new Error("causal episodes do not cover canonical events")
  return [...episodes].sort((left, right) => compareCodePoints(left.id, right.id))
}

function renderEvent(event: CanonicalEvent) {
  return {
    id: event.id,
    sequence: event.sequence,
    provenance: event.provenance,
    kind: event.kind,
    pair_id: event.pair_id,
    content: event.content,
    goal_ids: event.goal_ids,
    artifact_ids: event.artifact_ids,
    evidence_event_ids: event.evidence_event_ids,
    archive_handles: event.archive_handles,
    payload_digest: event.payload_digest,
    source_location: event.source_location,
  }
}

function renderEpisode(episode: CausalEpisode, eventByID: Map<string, CanonicalEvent>) {
  return {
    id: episode.id,
    kind: episode.kind,
    event_ids: episode.event_ids,
    goal_ids: episode.goal_ids,
    status: episode.status,
    exact_identifiers: episode.exact_identifiers,
    artifact_ids: episode.artifact_ids,
    evidence_event_ids: episode.evidence_event_ids,
    archive_handles: episode.archive_handles,
    relevance_signals: episode.relevance_signals,
    events: episode.event_ids.map((eventID) => renderEvent(eventByID.get(eventID)!)),
  }
}

function selectCompleteEpisodes(episodes: CausalEpisode[], mandatory: Record<string, unknown>, eventByID: Map<string, CanonicalEvent>, maxBytes: number) {
  const selected: CausalEpisode[] = []
  const covered = new Set<string>()
  const remaining = [...episodes]
  while (remaining.length > 0) {
    const ranked = remaining.map((episode, index) => ({ episode, index, dimensions: episodeDimensions(episode, covered) })).sort((left, right) => right.dimensions.uncovered - left.dimensions.uncovered || episodeScore(right.episode) - episodeScore(left.episode) || compareCodePoints(left.episode.id, right.episode.id))
    const candidate = ranked.find(({ episode }) => {
      const trial = canonicalSerialize({ ...mandatory, selected_episodes: [...selected, episode].map((item) => renderEpisode(item, eventByID)) })
      return utf8Bytes(trial) <= maxBytes
    })
    if (!candidate) break
    selected.push(candidate.episode)
    for (const dimension of episodeDimensions(candidate.episode, covered).all) covered.add(dimension)
    remaining.splice(candidate.index, 1)
  }
  return selected
}

function episodeDimensions(episode: CausalEpisode, covered: Set<string>) {
  const all = [
    ...(episode.goal_ids.length > 0 ? ["goal"] : []),
    ...(episode.status === "blocked" || episode.kind.includes("failure") ? ["blocker"] : []),
    ...(episode.kind.includes("decision") ? ["decision"] : []),
    ...(episode.evidence_event_ids.length > 0 || episode.artifact_ids.length > 0 ? ["evidence"] : []),
    ...(episode.relevance_signals.latest_sequence >= 0 ? ["recent"] : []),
  ]
  return { all, uncovered: all.filter((dimension) => !covered.has(dimension)).length }
}

function episodeScore(episode: CausalEpisode) {
  return episode.goal_ids.length * 100_000 + episode.evidence_event_ids.length * 10_000 + (episode.kind.includes("decision") ? 1_000 : 0) + episode.relevance_signals.latest_sequence
}

export function vccPatchBaseDigest(candidateBytes: string, docketBytes: string) {
  return sha256(`vcc-patch-base-v1\0${candidateBytes}\0${docketBytes}`)
}

export function buildVccPatchSourceIndex(input: {
  events: CanonicalEvent[]
  episodes: CausalEpisode[]
  goal_ids?: string[]
  loop_ids?: string[]
  artifact_ids?: string[]
  protected_event_ids?: string[]
  protected_episode_ids?: string[]
  correction_gate?: Array<{ from: string; to: string; evidence_event_ids: string[] }>
}): VccPatchSourceIndex {
  const protectedEventIDs = new Set(input.protected_event_ids ?? [])
  return {
    event_ids: uniqueSorted(input.events.map((event) => event.id)),
    episode_ids: uniqueSorted(input.episodes.map((episode) => episode.id)),
    goal_ids: uniqueSorted(input.goal_ids ?? input.events.flatMap((event) => event.goal_ids)),
    loop_ids: uniqueSorted(input.loop_ids ?? []),
    artifact_ids: uniqueSorted(input.artifact_ids ?? input.events.flatMap((event) => event.artifact_ids)),
    protected_event_ids: uniqueSorted(input.protected_event_ids ?? []),
    protected_episode_ids: uniqueSorted(input.protected_episode_ids ?? []),
    protected_goal_ids: uniqueSorted(input.events.filter((event) => protectedEventIDs.has(event.id)).flatMap((event) => event.goal_ids)),
    correction_gate: (input.correction_gate ?? []).map((gate) => ({ from: gate.from, to: gate.to, evidence_event_ids: uniqueSorted(gate.evidence_event_ids) })).sort((left, right) => compareCodePoints(`${left.from}\0${left.to}`, `${right.from}\0${right.to}`)),
  }
}

export function parseVccPatch(text: string) {
  if (utf8Bytes(text) > VCC_PATCH_MAX_BYTES) return
  const value = new StrictJsonReader(text).parse()
  return isRecord(value) ? value : undefined
}

export function validateVccPatch(text: string, context: VccPatchContext): VccPatchValidation {
  const fallback = () => ({ accepted: false as const, reason: "invalid VCC patch", candidate_bytes: context.candidate.bytes, candidate_digest: sha256(context.candidate.bytes) })
  if (utf8Bytes(text) > VCC_PATCH_MAX_BYTES) return { ...fallback(), reason: "patch exceeds byte bound" }
  if (sha256(context.candidate.bytes) !== context.candidate.digest) return { ...fallback(), reason: "candidate digest mismatch" }
  const value = parseVccPatch(text)
  if (!value) return { ...fallback(), reason: "invalid JSON, duplicate key, or trailing prose" }
  if (!exactKeys(value, ["version", "base_digest", "active_goal_ids", "relations", "episode_hints", "open_loop_hints", "artifact_hints", "drift", "missing_from_projection_ids"])) return { ...fallback(), reason: "patch keys are not exact" }
  const expectedBaseDigest = vccPatchBaseDigest(context.candidate.bytes, context.docket_bytes)
  if (value.version !== 1 || !boundedString(value.base_digest, 64) || !/^[a-f0-9]{64}$/.test(value.base_digest) || value.base_digest !== expectedBaseDigest) return { ...fallback(), reason: "patch version or base digest mismatch" }
  const sets = patchSourceSets(context.source_index)
  const activeGoalIDs = sourceIDs(value.active_goal_ids, sets.goals, "goal") ? value.active_goal_ids as string[] : undefined
  if (!activeGoalIDs || activeGoalIDs.some((id) => !sets.protectedGoals.has(id)) || !sourceIDs(value.missing_from_projection_ids, sets.all, "any")) return { ...fallback(), reason: "unknown, unauthorized, or duplicate patch IDs" }
  if (!Array.isArray(value.relations) || value.relations.some((relation) => !validateRelation(relation, sets, context.source_index.correction_gate))) return { ...fallback(), reason: "invalid relation or evidence" }
  if (!Array.isArray(value.episode_hints) || value.episode_hints.some((hint) => !validateEpisodeHint(hint, sets))) return { ...fallback(), reason: "invalid episode hint" }
  if (!Array.isArray(value.open_loop_hints) || value.open_loop_hints.some((hint) => !validateLoopHint(hint, sets))) return { ...fallback(), reason: "invalid open-loop hint" }
  if (!Array.isArray(value.artifact_hints) || value.artifact_hints.some((hint) => !validateArtifactHint(hint, sets))) return { ...fallback(), reason: "invalid artifact hint" }
  if (!validateDrift(value.drift, sets)) return { ...fallback(), reason: "invalid drift" }
  const patch = value as unknown as VccPatch
  return { accepted: true, patch, patch_digest: sha256(canonicalSerialize(patch)), base_digest: expectedBaseDigest }
}

export function rehearseVccPatch(context: VccPatchContext, text: string): VccPatchApplication {
  const validation = validateVccPatch(text, context)
  if (!validation.accepted) return { accepted: false, candidate_bytes: validation.candidate_bytes, candidate_digest: validation.candidate_digest, patch_digest: null, selected_episode_ids: context.candidate.selected_episode_ids, warnings: [] }
  return applyVccPatch(context, validation)
}

export function applyVccPatch(context: VccPatchContext, validation: Extract<VccPatchValidation, { accepted: true }>): VccPatchApplication {
  const parsed = parseVccPatch(context.candidate.bytes)
  if (!parsed || !Array.isArray(parsed.selected_episodes)) return { accepted: false, candidate_bytes: context.candidate.bytes, candidate_digest: sha256(context.candidate.bytes), patch_digest: null, selected_episode_ids: context.candidate.selected_episode_ids, warnings: [] }
  const priorities = new Map(validation.patch.episode_hints.map((hint) => [hint.episode_id, PATCH_EPISODE_PRIORITIES.indexOf(hint.priority)]))
  const selected = [...parsed.selected_episodes].sort((left, right) => {
    const leftID = isRecord(left) && typeof left.id === "string" ? left.id : ""
    const rightID = isRecord(right) && typeof right.id === "string" ? right.id : ""
    return (priorities.get(leftID) ?? PATCH_EPISODE_PRIORITIES.indexOf("neutral")) - (priorities.get(rightID) ?? PATCH_EPISODE_PRIORITIES.indexOf("neutral")) || compareCodePoints(leftID, rightID)
  })
  const warnings = uniqueSorted([
    ...validation.patch.relations.map((relation) => `relation:${relation.from}:${relation.kind}:${relation.to}`),
    ...validation.patch.open_loop_hints.map((hint) => `loop:${hint.object_id}:${hint.state}`),
    ...validation.patch.artifact_hints.map((hint) => `artifact:${hint.artifact_id}:${hint.disposition}`),
    ...(validation.patch.drift.state === "on_track" ? [] : [`drift:${validation.patch.drift.state}`]),
    ...validation.patch.missing_from_projection_ids.map((id) => `missing_from_projection:${id}`),
  ])
  const body: Record<string, unknown> = { ...parsed, selected_episodes: selected, patch_warnings: warnings }
  if (Array.isArray(parsed.active_goal_ids) && parsed.active_goal_ids.every((id) => typeof id === "string")) {
    const existingGoals = parsed.active_goal_ids as string[]
    const preferredGoals = validation.patch.active_goal_ids.filter((id) => existingGoals.includes(id))
    body.active_goal_ids = [...preferredGoals, ...existingGoals.filter((id) => !preferredGoals.includes(id))]
  }
  const candidateBytes = canonicalSerialize(body)
  return { accepted: true, candidate_bytes: candidateBytes, candidate_digest: sha256(candidateBytes), patch_digest: validation.patch_digest, selected_episode_ids: selected.flatMap((episode) => isRecord(episode) && typeof episode.id === "string" ? [episode.id] : []), warnings }
}

function patchSourceSets(index: VccPatchSourceIndex) {
  return {
    events: new Set(index.event_ids),
    episodes: new Set(index.episode_ids),
    goals: new Set(index.goal_ids),
    loops: new Set(index.loop_ids),
    artifacts: new Set(index.artifact_ids),
    protectedEvents: new Set(index.protected_event_ids),
    protectedGoals: new Set(index.protected_goal_ids),
    all: new Set([...index.event_ids, ...index.episode_ids, ...index.goal_ids, ...index.loop_ids, ...index.artifact_ids]),
  }
}

function validateRelation(value: unknown, sets: ReturnType<typeof patchSourceSets>, correctionGate: VccPatchSourceIndex["correction_gate"]) {
  if (!isRecord(value) || !exactKeys(value, ["from", "kind", "to", "evidence_event_ids"]) || !boundedString(value.from, 512) || !boundedString(value.to, 512) || !enumValue(PATCH_RELATION_KINDS, value.kind) || !nonEmptySourceIDs(value.evidence_event_ids, sets.events, "ev")) return false
  if (!sets.all.has(value.from) || !sets.all.has(value.to)) return false
  if (value.kind !== "explicitly_superseded_by") return true
  return correctionGate.some((gate) => gate.from === value.from && gate.to === value.to && canonicalSerialize(gate.evidence_event_ids) === canonicalSerialize(value.evidence_event_ids) && gate.evidence_event_ids.every((id) => sets.protectedEvents.has(id)))
}

function validateEpisodeHint(value: unknown, sets: ReturnType<typeof patchSourceSets>) {
  return isRecord(value) && exactKeys(value, ["episode_id", "priority", "reason", "evidence_event_ids"]) && boundedString(value.episode_id, 512) && sets.episodes.has(value.episode_id) && enumValue(PATCH_EPISODE_PRIORITIES, value.priority) && enumValue(PATCH_EPISODE_REASONS, value.reason) && nonEmptySourceIDs(value.evidence_event_ids, sets.events, "ev")
}

function validateLoopHint(value: unknown, sets: ReturnType<typeof patchSourceSets>) {
  return isRecord(value) && exactKeys(value, ["object_id", "state", "evidence_event_ids", "evidence_episode_ids"]) && boundedString(value.object_id, 512) && sets.loops.has(value.object_id) && enumValue(PATCH_LOOP_STATES, value.state) && sourceIDs(value.evidence_event_ids, sets.events, "ev") && sourceIDs(value.evidence_episode_ids, sets.episodes, "ep") && (hasIDs(value.evidence_event_ids) || hasIDs(value.evidence_episode_ids))
}

function validateArtifactHint(value: unknown, sets: ReturnType<typeof patchSourceSets>) {
  return isRecord(value) && exactKeys(value, ["artifact_id", "class", "disposition", "evidence_event_ids", "evidence_episode_ids"]) && boundedString(value.artifact_id, 512) && sets.artifacts.has(value.artifact_id) && enumValue(PATCH_ARTIFACT_CLASSES, value.class) && enumValue(PATCH_ARTIFACT_DISPOSITIONS, value.disposition) && sourceIDs(value.evidence_event_ids, sets.events, "ev") && sourceIDs(value.evidence_episode_ids, sets.episodes, "ep") && (hasIDs(value.evidence_event_ids) || hasIDs(value.evidence_episode_ids))
}

function validateDrift(value: unknown, sets: ReturnType<typeof patchSourceSets>) {
  return isRecord(value) && exactKeys(value, ["state", "goal_ids", "episode_ids"]) && enumValue(PATCH_DRIFT_STATES, value.state) && sourceIDs(value.goal_ids, sets.goals, "goal") && sourceIDs(value.episode_ids, sets.episodes, "ep")
}

function sourceIDs(value: unknown, allowed: Set<string>, kind: "ev" | "ep" | "goal" | "any") {
  if (!Array.isArray(value) || value.length > 128) return false
  const ids = value.filter((item): item is string => typeof item === "string")
  if (ids.length !== value.length || new Set(ids).size !== ids.length) return false
  return ids.every((id) => boundedString(id, 512) && (kind === "any" || id.startsWith(`${kind}:`)) && allowed.has(id))
}

function nonEmptySourceIDs(value: unknown, allowed: Set<string>, kind: "ev" | "ep" | "goal" | "any") {
  return hasIDs(value) && sourceIDs(value, allowed, kind)
}

function hasIDs(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0
}

function exactKeys(value: Record<string, unknown>, keys: string[]) {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
}

function boundedString(value: unknown, maxBytes: number): value is string {
  return typeof value === "string" && utf8Bytes(value) <= maxBytes
}

function enumValue<const T extends readonly string[]>(values: T, value: unknown): value is T[number] {
  return typeof value === "string" && values.includes(value)
}

export function buildSourceCompleteness(input: {
  host: VccHost
  session_id: string
  lineage_id: string
  events: CanonicalEvent[]
  page_count?: number
  terminal_cursor?: string | null
  reason?: VccSourceIncompleteReason | null
  byte_count?: number
}) {
  requireHost(input.host)
  requireNonEmpty(input.session_id, "session_id")
  requireNonEmpty(input.lineage_id, "lineage_id")
  if (input.reason !== undefined && input.reason !== null && !VCC_SOURCE_INCOMPLETE_REASONS.includes(input.reason)) throw new TypeError(`unsupported source completeness reason: ${input.reason}`)
  if (input.page_count !== undefined && (!Number.isSafeInteger(input.page_count) || input.page_count < 0)) throw new TypeError("page_count must be a non-negative safe integer")
  if (input.byte_count !== undefined && (!Number.isSafeInteger(input.byte_count) || input.byte_count < 0)) throw new TypeError("byte_count must be a non-negative safe integer")
  const events = [...input.events].sort((left, right) => left.sequence - right.sequence || compareCodePoints(left.id, right.id))
  const identitySet = new Set<string>()
  let reason = input.reason ?? (input.terminal_cursor === null ? null : "unknown")
  for (const event of events) {
    if (event.host !== input.host || event.session_id !== input.session_id || event.lineage_id !== input.lineage_id) reason ??= "cross_session_record"
    if (identitySet.has(event.id)) reason ??= "duplicate_message_id"
    identitySet.add(event.id)
  }
  const terminal_cursor_observed = input.terminal_cursor === null
  const complete = reason === null && terminal_cursor_observed && input.terminal_cursor === null
  const manifestWithoutDigest = {
    version: 1 as const,
    host: input.host,
    session_id: input.session_id,
    lineage_id: input.lineage_id,
    complete,
    reason,
    page_count: input.page_count ?? (events.length === 0 ? 0 : 1),
    record_count: events.length,
    first_source_id: events[0]?.id ?? null,
    last_source_id: events.at(-1)?.id ?? null,
    terminal_cursor: input.terminal_cursor ?? null,
    terminal_cursor_observed,
    byte_count: input.byte_count ?? utf8Bytes(canonicalSerialize(events)),
  }
  const digest = sourceCompletenessDigest(manifestWithoutDigest)
  return { ...manifestWithoutDigest, digest } satisfies SourceCompleteness
}

export function assertCompleteSource(manifest: SourceCompleteness) {
  if (!manifest.complete || manifest.reason !== null || !manifest.terminal_cursor_observed) {
    throw new Error(`VCC source is incomplete${manifest.reason ? `: ${manifest.reason}` : ""}`)
  }
  if (sourceCompletenessDigest(manifest) !== manifest.digest) throw new Error("VCC source manifest digest mismatch")
  return manifest
}

export function sourceCompletenessDigest(manifest: Omit<SourceCompleteness, "digest"> & Partial<Pick<SourceCompleteness, "digest">>) {
  // Page grouping and transport byte totals are observations, not canonical
  // source identity: advisory generated records can shift a 256-record page
  // boundary without changing the authoritative event set.
  const { digest: _digest, page_count: _pageCount, byte_count: _byteCount, ...stableIdentity } = manifest
  return sha256(canonicalSerialize(stableIdentity))
}

function requireHost(host: string): asserts host is VccHost {
  if (!VCC_HOSTS.includes(host as VccHost)) throw new TypeError(`unsupported VCC host: ${host}`)
}

function requireStableSourceID(value: string) {
  requireNonEmpty(value, "stable_source_id")
  if (/^\d+$/.test(value) || value.includes("\n") || value.includes("\0") || value.includes(":") || utf8Bytes(value) > 512) throw new TypeError("stable_source_id must be a host identity, not an array position")
}

function requireNonEmpty(value: string, name: string) {
  if (!value || value.includes("\0") || utf8Bytes(value) > 4_096) throw new TypeError(`${name} must be non-empty and bounded`)
}

function normalizeIDs(ids: string[], name: string) {
  if (new Set(ids).size !== ids.length) throw new TypeError(`${name} contains duplicate IDs`)
  if (ids.some((id) => !/^ev:[^:\s]+:[^:\s]+$/.test(id))) throw new TypeError(`${name} contains an invalid typed event ID`)
  return [...ids].sort(compareCodePoints)
}

function normalizeTypedIDs(ids: string[], name: string, kind: "goal" | "artifact") {
  if (new Set(ids).size !== ids.length) throw new TypeError(`${name} contains duplicate IDs`)
  const pattern = new RegExp(`^${kind}:[^:\\s]+$`)
  if (ids.some((id) => !pattern.test(id))) throw new TypeError(`${name} contains an invalid typed ${kind} ID`)
  return [...ids].sort(compareCodePoints)
}

function normalizeArchiveHandles(handles: string[]) {
  if (new Set(handles).size !== handles.length) throw new TypeError("archive_handles contains duplicate handles")
  if (handles.some((handle) => !/^archive:v1:(?:pi|opencode-v1):[a-f0-9]{64}:[a-f0-9]{64}:[a-f0-9]{64}$/.test(handle))) throw new TypeError("archive_handles contains an invalid archive handle")
  return [...handles].sort(compareCodePoints)
}

function uniqueSorted(values: string[]) {
  return [...new Set(values)].sort(compareCodePoints)
}

function compareCodePoints(left: string, right: string) {
  const leftPoints = Array.from(left)
  const rightPoints = Array.from(right)
  for (let index = 0; index < Math.min(leftPoints.length, rightPoints.length); index++) {
    const leftPoint = leftPoints[index]!.codePointAt(0)!
    const rightPoint = rightPoints[index]!.codePointAt(0)!
    if (leftPoint !== rightPoint) return leftPoint - rightPoint
  }
  return leftPoints.length - rightPoints.length
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

class StrictJsonReader {
  private index = 0
  private depth = 0
  constructor(private readonly text: string) {}

  parse() {
    try {
      const value = this.value()
      this.space()
      return this.index === this.text.length ? value : undefined
    } catch {
      return undefined
    }
  }

  private value(): unknown {
    this.space()
    const char = this.text[this.index]
    if (char === "{") return this.object()
    if (char === "[") return this.array()
    if (char === '"') return this.string()
    if (this.text.startsWith("true", this.index)) return this.advance(4, true)
    if (this.text.startsWith("false", this.index)) return this.advance(5, false)
    if (this.text.startsWith("null", this.index)) return this.advance(4, null)
    const number = this.text.slice(this.index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u)?.[0]
    if (!number) throw new Error("invalid JSON value")
    this.index += number.length
    return Number(number)
  }

  private object() {
    if (++this.depth > 8) throw new Error("JSON nesting too deep")
    this.index++
    const result: Record<string, unknown> = {}
    const keys = new Set<string>()
    this.space()
    if (this.text[this.index] === "}") {
      this.index++
      this.depth--
      return result
    }
    while (true) {
      this.space()
      if (this.text[this.index] !== '"') throw new Error("object key expected")
      const key = this.string()
      if (typeof key !== "string" || keys.has(key)) throw new Error("duplicate object key")
      keys.add(key)
      this.space()
      if (this.text[this.index++] !== ":") throw new Error("object separator expected")
      result[key] = this.value()
      this.space()
      if (this.text[this.index] === "}") {
        this.index++
        this.depth--
        return result
      }
      if (this.text[this.index++] !== ",") throw new Error("object delimiter expected")
    }
  }

  private array() {
    if (++this.depth > 8) throw new Error("JSON nesting too deep")
    this.index++
    const result: unknown[] = []
    this.space()
    if (this.text[this.index] === "]") {
      this.index++
      this.depth--
      return result
    }
    while (true) {
      if (result.length >= 128) throw new Error("JSON array too large")
      result.push(this.value())
      this.space()
      if (this.text[this.index] === "]") {
        this.index++
        this.depth--
        return result
      }
      if (this.text[this.index++] !== ",") throw new Error("array delimiter expected")
    }
  }

  private string() {
    const start = this.index
    this.index++
    while (this.index < this.text.length) {
      const char = this.text[this.index++]
      if (char === "\\") this.index++
      if (char === '"') {
        const value = JSON.parse(this.text.slice(start, this.index)) as unknown
        if (typeof value !== "string" || utf8Bytes(value) > 4_096) throw new Error("JSON string too large")
        return value
      }
    }
    throw new Error("unterminated string")
  }

  private space() {
    while (/\s/u.test(this.text[this.index] ?? "")) this.index++
  }

  private advance(length: number, value: unknown) {
    this.index += length
    return value
  }
}

function serializeValue(value: unknown): string {
  if (value === null) return "null"
  if (typeof value === "string") return JSON.stringify(value)
  if (typeof value === "boolean") return value ? "true" : "false"
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonical JSON does not support non-finite numbers")
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(serializeValue).join(",")}]`
  if (typeof value === "object") {
    return `{${Object.entries(value).sort(([left], [right]) => compareCodePoints(left, right)).map(([key, child]) => `${JSON.stringify(key)}:${serializeValue(child)}`).join(",")}}`
  }
  throw new TypeError("canonical JSON does not support this value")
}
