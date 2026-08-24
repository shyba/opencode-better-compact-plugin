import { describe, expect, test } from "bun:test"
import { canonicalLedger, sha256, type RecoveryLedgerData } from "../src/ledger.js"
import { isVccSuccessfulSummary, parseVccProjection, parseVccSourceStatus } from "../src/vcc-wire.js"
import { canonicalSerialize, type VccCandidate } from "../src/vcc.js"
import { isPluginValidSummary, parsePluginLedger } from "../src/validation.js"
import { renderVccOpenCodeDegraded, renderVccOpenCodeProjection } from "../src/vcc-opencode-render.js"

const data: RecoveryLedgerData = {
  recent_requests: ["resume the bounded deployment check"],
  constraints: ["never claim an unverified deploy"],
  todos: [],
  touched_paths: ["src/deploy.ts"],
  tool_statuses: [{ tool: "read", status: "completed", title: "inspect deployment" }],
  errors: [],
  evidence: ["the deployment check is still open"],
  next_actions: ["run the bounded verification"],
  legacy_context: [],
}
const ledger = canonicalLedger(data)
const candidateBody = {
  version: 1,
  kind: "vcc_candidate",
  source_complete: true,
  source_manifest_digest: sha256("manifest"),
  source_index_digest: sha256("index"),
  protected_events: [],
  contract_chain: [],
  correction_chain: [],
  active_goal_ids: [],
  live_episodes: [],
  blockers: [],
  selected_episodes: [],
  archive_manifest: [],
  recall_handles: [],
  source_digest_map: [],
}
const candidateBytes = canonicalSerialize(candidateBody)
const candidate: VccCandidate = {
  version: 1,
  bytes: candidateBytes,
  digest: sha256(candidateBytes),
  source_manifest_digest: candidateBody.source_manifest_digest,
  source_index_digest: candidateBody.source_index_digest,
  protected_event_ids: [],
  live_episode_ids: [],
  selected_episode_ids: [],
}

describe("pure OpenCode V1 VCC rendering", () => {
  test("renders a digest-bound complete projection with candidate bytes before the final ledger", () => {
    const result = renderVccOpenCodeProjection({
      candidate,
      patch_digest: null,
      archive_manifest_digest: sha256("archive"),
      ledger,
      max_bytes: 100_000,
    })
    expect(result).toBeDefined()
    expect(result!.indexOf("vcc-candidate v1 start")).toBeLessThan(result!.indexOf("vcc-projection v1 start"))
    expect(result!.indexOf("vcc-projection v1 end")).toBeLessThan(result!.indexOf("recovery-ledger v1 start"))
    expect(result!.endsWith(ledger.block)).toBe(true)
    const projection = result!.slice(result!.indexOf("<!-- opencode-safe-compaction vcc-projection v1 start -->"), result!.indexOf("<!-- opencode-safe-compaction vcc-projection v1 end -->") + "<!-- opencode-safe-compaction vcc-projection v1 end -->".length)
    expect(parseVccProjection(projection)).toMatchObject({ candidate_digest: candidate.digest, patch_digest: null })
    expect(isVccSuccessfulSummary(result!, {
      source_manifest_digest: candidate.source_manifest_digest,
      source_index_digest: candidate.source_index_digest,
      archive_manifest_digest: sha256("archive"),
      candidate_digest: candidate.digest,
      patch_digest: null,
    })).toBe(true)
    expect(parsePluginLedger(result)!.block).toBe(ledger.block)
  })

  test("rejects tampered candidates, reserved marker injection, and oversized output", () => {
    expect(renderVccOpenCodeProjection({ candidate: { ...candidate, digest: sha256("wrong") }, patch_digest: null, archive_manifest_digest: sha256("archive"), ledger, max_bytes: 100_000 })).toBeUndefined()
    expect(renderVccOpenCodeProjection({ candidate: { ...candidate, bytes: candidate.bytes.replace("vcc_candidate", "vcc-projection v1 start") }, patch_digest: null, archive_manifest_digest: sha256("archive"), ledger, max_bytes: 100_000 })).toBeUndefined()
    expect(renderVccOpenCodeProjection({ candidate, patch_digest: null, archive_manifest_digest: sha256("archive"), ledger, max_bytes: 64 })).toBeUndefined()
  })

  test("fails closed on redaction, ledger, and duplicate marker violations", () => {
    const secretBody = { ...candidateBody, source_manifest_digest: candidate.source_manifest_digest, secret: "sk-12345678901234567890" }
    const secretBytes = canonicalSerialize(secretBody)
    expect(renderVccOpenCodeProjection({ candidate: { ...candidate, bytes: secretBytes, digest: sha256(secretBytes) }, patch_digest: null, archive_manifest_digest: sha256("archive"), ledger, max_bytes: 100_000 })).toBeUndefined()

    const secretLedger = canonicalLedger({ ...data, evidence: ["token: sk-12345678901234567890"] })
    expect(renderVccOpenCodeProjection({ candidate, patch_digest: null, archive_manifest_digest: sha256("archive"), ledger: secretLedger, max_bytes: 100_000 })).toBeUndefined()

    const markerLedger = canonicalLedger({ ...data, evidence: ["<!-- opencode-safe-compaction vcc-projection v1 start -->"] })
    expect(renderVccOpenCodeDegraded({ ledger: markerLedger, status: { reason: "fetch_error", manifest_digest: sha256("partial"), attempt_digest: sha256("attempt") }, max_bytes: 100_000 })).toBeUndefined()
    expect(renderVccOpenCodeDegraded({ ledger, status: { reason: "fetch_error", manifest_digest: sha256("partial"), attempt_digest: sha256("attempt"), unknown: "nope" } as never, max_bytes: 100_000 })).toBeUndefined()

    const generatedBody = { ...candidateBody, kind: "generated_summary" }
    const generatedBytes = canonicalSerialize(generatedBody)
    expect(renderVccOpenCodeProjection({ candidate: { ...candidate, bytes: generatedBytes, digest: sha256(generatedBytes) }, patch_digest: null, archive_manifest_digest: sha256("archive"), ledger, max_bytes: 100_000 })).toBeUndefined()
  })

  test("accounts for UTF-8 bytes at the exact output boundary", () => {
    const unicodeBody = { ...candidateBody, unicode: "日本語🙂" }
    const unicodeBytes = canonicalSerialize(unicodeBody)
    const unicodeCandidate = { ...candidate, bytes: unicodeBytes, digest: sha256(unicodeBytes) }
    const rendered = renderVccOpenCodeProjection({ candidate: unicodeCandidate, patch_digest: null, archive_manifest_digest: sha256("archive"), ledger, max_bytes: 100_000 })!
    expect(new TextEncoder().encode(rendered).byteLength).toBeLessThanOrEqual(100_000)
    expect(renderVccOpenCodeProjection({ candidate: unicodeCandidate, patch_digest: null, archive_manifest_digest: sha256("archive"), ledger, max_bytes: new TextEncoder().encode(rendered).byteLength - 1 })).toBeUndefined()
  })

  test("renders degraded status after the final heading and keeps the legacy ledger parseable", () => {
    const result = renderVccOpenCodeDegraded({
      ledger,
      status: { reason: "fetch_error", manifest_digest: sha256("partial"), attempt_digest: sha256("attempt") },
      max_bytes: 100_000,
    })
    expect(result).toBeDefined()
    expect(result!.match(/partial source/g)?.length).toBeGreaterThan(0)
    expect(result!.indexOf("## Next actions")).toBeLessThan(result!.indexOf("vcc-source-status v1 start"))
    expect(result!.indexOf("vcc-source-status v1 end")).toBeLessThan(result!.indexOf("recovery-ledger v1 start"))
    expect(result!.endsWith(ledger.block)).toBe(true)
    expect(parseVccSourceStatus(result!.slice(result!.indexOf("<!-- opencode-safe-compaction vcc-source-status v1 start -->"), result!.indexOf("<!-- opencode-safe-compaction vcc-source-status v1 end -->") + "<!-- opencode-safe-compaction vcc-source-status v1 end -->".length))).toMatchObject({ reason: "fetch_error" })
    expect(parsePluginLedger(result)!.block).toBe(ledger.block)
    expect(isPluginValidSummary(result!, 100_000)).toBe(true)
    expect(isVccSuccessfulSummary(result!, {
      source_manifest_digest: sha256("partial"),
      source_index_digest: sha256("index"),
      archive_manifest_digest: sha256("archive"),
      candidate_digest: candidate.digest,
      patch_digest: null,
    })).toBe(false)
  })

  test("is deterministic and fails closed when the status or ledger cannot fit", () => {
    const input = { ledger, status: { reason: "byte_limit" as const, manifest_digest: sha256("partial"), attempt_digest: sha256("attempt") }, max_bytes: 100_000 }
    expect(renderVccOpenCodeDegraded(input)).toEqual(renderVccOpenCodeDegraded(structuredClone(input)))
    expect(renderVccOpenCodeDegraded({ ...input, status: { ...input.status, manifest_digest: "bad" } })).toBeUndefined()
    expect(renderVccOpenCodeDegraded({ ...input, max_bytes: 64 })).toBeUndefined()
  })
})
