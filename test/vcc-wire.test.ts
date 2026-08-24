import { describe, expect, test } from "bun:test"
import { canonicalLedger, sha256 } from "../src/ledger.js"
import {
  VCC_PROJECTION_MAX_BYTES,
  VCC_PROJECTION_START,
  VCC_PROJECTION_END,
  VCC_SOURCE_STATUS_MAX_BYTES,
  VCC_SOURCE_STATUS_START,
  VCC_SOURCE_STATUS_END,
  isVccSuccessfulSummary,
  parseVccProjection,
  parseVccSourceStatus,
  renderVccProjection,
  renderVccSourceStatus,
  vccAttemptDigest,
} from "../src/vcc-wire.js"
import { VCC_SOURCE_INCOMPLETE_REASONS } from "../src/vcc.js"

const manifest_digest = "a".repeat(64)
const attempt_digest = "b".repeat(64)
const source_index_digest = "c".repeat(64)
const archive_manifest_digest = "d".repeat(64)
const candidate_digest = "e".repeat(64)
const patch_digest = "f".repeat(64)

const sourceStatus = () => renderVccSourceStatus({ reason: "fetch_error", manifest_digest, attempt_digest })!
const projection = (patch: string | null = null) =>
  renderVccProjection({ source_manifest_digest: manifest_digest, source_index_digest, archive_manifest_digest, candidate_digest, patch_digest: patch })!

function ledgerBlock() {
  return canonicalLedger({
    recent_requests: [],
    constraints: [],
    todos: [],
    touched_paths: [],
    tool_statuses: [],
    errors: [],
    evidence: [],
    next_actions: [],
    legacy_context: [],
  }).block
}

describe("VCC wire marker codecs", () => {
  test("renders and parses every incomplete-source reason with exact framing", () => {
    for (const reason of VCC_SOURCE_INCOMPLETE_REASONS) {
      const rendered = renderVccSourceStatus({ reason, manifest_digest, attempt_digest })
      expect(rendered).toBeDefined()
      expect(rendered?.startsWith(`${VCC_SOURCE_STATUS_START}\n`)).toBe(true)
      expect(rendered?.endsWith(`\n${VCC_SOURCE_STATUS_END}`)).toBe(true)
      expect(parseVccSourceStatus(rendered!)).toEqual({
        version: 1,
        mode: "hybrid",
        complete: false,
        reason,
        manifest_digest,
        attempt_digest,
        outcome: "degraded_summary",
        partial_ledger: true,
      })
    }
    expect(sourceStatus()).toContain(`{"version":1,"mode":"hybrid","complete":false,"reason":"fetch_error"`)
    expect(new TextEncoder().encode(sourceStatus()).byteLength).toBeLessThanOrEqual(VCC_SOURCE_STATUS_MAX_BYTES)
  })

  test("rejects source status duplicates, unknowns, wrong order, prose, uppercase, and bad framing", () => {
    const rendered = sourceStatus()
    expect(parseVccSourceStatus(rendered.replace('{"version":1,', '{"version":1,"version":1,'))).toBeUndefined()
    expect(parseVccSourceStatus(rendered.replace('{"version":1,', '{"version":1,"unknown":1,'))).toBeUndefined()
    expect(parseVccSourceStatus(rendered.replace('{"version":1,"mode":"hybrid"', '{"mode":"hybrid","version":1'))).toBeUndefined()
    expect(parseVccSourceStatus(`${rendered}\nextra prose`)).toBeUndefined()
    expect(parseVccSourceStatus(rendered.replace(manifest_digest, manifest_digest.toUpperCase()))).toBeUndefined()
    expect(parseVccSourceStatus(rendered.replace(VCC_SOURCE_STATUS_START, "wrong marker"))).toBeUndefined()
    expect(parseVccSourceStatus("x".repeat(VCC_SOURCE_STATUS_MAX_BYTES + 1))).toBeUndefined()
    expect(renderVccSourceStatus({ reason: "not-a-reason" as never, manifest_digest, attempt_digest })).toBeUndefined()
  })

  test("uses the exact attempt digest formula and changes with each input", () => {
    const first = vccAttemptDigest("session-wire", "target-wire", manifest_digest)
    expect(first).toBe(sha256(`vcc-attempt-v1\0session-wire\0target-wire\0${manifest_digest}`))
    expect(vccAttemptDigest("session-wire", "target-wire", manifest_digest)).toBe(first)
    expect(vccAttemptDigest("other-session", "target-wire", manifest_digest)).not.toBe(first)
    expect(vccAttemptDigest("session-wire", "other-target", manifest_digest)).not.toBe(first)
    expect(vccAttemptDigest("session-wire", "target-wire", candidate_digest)).not.toBe(first)
    expect(() => vccAttemptDigest("", "target-wire", manifest_digest)).toThrow()
    expect(() => vccAttemptDigest("session-wire", "target-wire", "A".repeat(64))).toThrow()
  })

  test("renders and parses exact projection fields for null and non-null patches", () => {
    for (const patch of [null, patch_digest]) {
      const rendered = projection(patch)
      expect(rendered.startsWith(`${VCC_PROJECTION_START}\n`)).toBe(true)
      expect(rendered.endsWith(`\n${VCC_PROJECTION_END}`)).toBe(true)
      expect(parseVccProjection(rendered)).toEqual({
        version: 1,
        mode: "hybrid",
        source_complete: true,
        source_manifest_digest: manifest_digest,
        source_index_digest,
        archive_manifest_digest,
        candidate_digest,
        patch_digest: patch,
      })
    }
    expect(new TextEncoder().encode(projection()).byteLength).toBeLessThanOrEqual(VCC_PROJECTION_MAX_BYTES)
  })

  test("rejects projection duplicates, unknowns, wrong order, prose, uppercase, and oversize", () => {
    const rendered = projection()
    expect(parseVccProjection(rendered.replace('{"version":1,', '{"version":1,"version":1,'))).toBeUndefined()
    expect(parseVccProjection(rendered.replace('{"version":1,', '{"version":1,"unknown":1,'))).toBeUndefined()
    expect(parseVccProjection(rendered.replace('{"version":1,"mode":"hybrid"', '{"mode":"hybrid","version":1'))).toBeUndefined()
    expect(parseVccProjection(`${rendered}\nextra prose`)).toBeUndefined()
    expect(parseVccProjection(rendered.replace(candidate_digest, candidate_digest.toUpperCase()))).toBeUndefined()
    expect(parseVccProjection(rendered.replace(VCC_PROJECTION_END, "wrong marker"))).toBeUndefined()
    expect(parseVccProjection("x".repeat(VCC_PROJECTION_MAX_BYTES + 1))).toBeUndefined()
    expect(renderVccProjection({ source_manifest_digest: "bad", source_index_digest, archive_manifest_digest, candidate_digest, patch_digest: null })).toBeUndefined()
  })

  test("accepts only a matching projection followed by one final valid ledger", () => {
    const ledger = ledgerBlock()
    const expected = { source_manifest_digest: manifest_digest, source_index_digest, archive_manifest_digest, candidate_digest, patch_digest: null }
    expect(isVccSuccessfulSummary(`${projection()}\n${ledger}`, expected)).toBe(true)
    expect(isVccSuccessfulSummary(`${projection(patch_digest)}\n${ledger}`, { ...expected, patch_digest })).toBe(true)
    expect(isVccSuccessfulSummary(`${projection()}\n${ledger}`, { ...expected, candidate_digest: patch_digest })).toBe(false)
    expect(isVccSuccessfulSummary(projection(), expected)).toBe(false)
    expect(isVccSuccessfulSummary(`${projection()}\n${ledger}\ntrailing prose`, expected)).toBe(false)
    expect(isVccSuccessfulSummary(`${sourceStatus()}\n${projection()}\n${ledger}`, expected)).toBe(false)
    expect(isVccSuccessfulSummary(`${projection()}\n${ledger}\n${sourceStatus()}`, expected)).toBe(false)
    expect(isVccSuccessfulSummary(`${projection()}\n${ledger}\n${ledger}`, expected)).toBe(false)
  })
})
