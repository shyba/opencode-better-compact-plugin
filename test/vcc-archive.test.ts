import { describe, expect, test } from "bun:test"
import { canonicalSerialize } from "../src/vcc.js"
import { sha256 } from "../src/ledger.js"
import { createVccArchiveHandle, parseVccArchiveHandle, verifyVccArchive } from "../src/vcc-archive.js"

const scope = { host: "opencode-v1" as const, session_id: "archive-session", lineage_id: "archive-lineage", stable_source_id: "event-001" }
const source_bytes = canonicalSerialize({ event: "ev:opencode-v1:event-001", sequence: 1 })
const payload_bytes = "exact payload bytes: café 😀"

function archive() {
  return createVccArchiveHandle({ ...scope, source_bytes, payload_bytes })
}

describe("pure VCC archive identity and verification", () => {
  test("creates stable handles and parses exact digest metadata", () => {
    const first = archive()
    const second = archive()
    expect(second).toEqual(first)
    expect(first.handle).toMatch(/^archive:v1:opencode-v1:[a-f0-9]{64}:[a-f0-9]{64}:[a-f0-9]{64}$/)
    expect(parseVccArchiveHandle(first.handle)).toEqual({ version: 1, host: "opencode-v1", scope_digest: first.scope_digest, source_digest: first.source_digest, payload_digest: first.payload_digest })
    expect(first.scope_digest).toBe(sha256("vcc-scope-v1\0opencode-v1\0archive-session\0archive-lineage"))
    expect(first.source_digest).toBe(sha256("vcc-source-v1\0event\0event-001"))
    expect(first.source_byte_count).toBe(new TextEncoder().encode(source_bytes).byteLength)
    expect(first.payload_byte_count).toBe(new TextEncoder().encode(payload_bytes).byteLength)
  })

  test("resolves byte-identical payload and exposes exact bytes and digests", () => {
    const metadata = archive()
    const result = verifyVccArchive({ ...scope, handle: metadata.handle, source_bytes, payload_bytes })
    expect(result).toMatchObject({ valid: true, handle: metadata.handle, source_digest: metadata.source_digest, payload_digest: metadata.payload_digest, payload_byte_count: metadata.payload_byte_count })
    if (!result.valid) return
    expect(result.payload_bytes).toBe(payload_bytes)
    expect(result.payload_digest).toBe(metadata.payload_digest)
  })

  test("keeps byte payloads exact without transforming them", () => {
    const payload = new Uint8Array([0, 1, 2, 255])
    const metadata = createVccArchiveHandle({ ...scope, source_bytes: new Uint8Array([4, 5]), payload_bytes: payload })
    const result = verifyVccArchive({ ...scope, handle: metadata.handle, source_bytes: new Uint8Array([4, 5]), payload_bytes: payload })
    expect(result.valid).toBe(true)
    if (result.valid) expect([...result.payload_bytes as Uint8Array]).toEqual([0, 1, 2, 255])
  })

  test("scopes equal payloads to distinct session, lineage, and source identities", () => {
    const session = createVccArchiveHandle({ ...scope, session_id: "other-session", source_bytes, payload_bytes })
    const lineage = createVccArchiveHandle({ ...scope, lineage_id: "other-lineage", source_bytes, payload_bytes })
    const source = createVccArchiveHandle({ ...scope, stable_source_id: "event-002", source_bytes, payload_bytes })
    expect(new Set([session.handle, lineage.handle, source.handle]).size).toBe(3)
  })

  test("rejects malformed, extra, uppercase, and unknown-host handles", () => {
    const handle = archive().handle
    const parts = handle.split(":")
    const malformed = ["archive:v1", `${handle}:extra`, handle.toUpperCase(), handle.replace("opencode-v1", "unknown")]
    for (const candidate of malformed) expect(parseVccArchiveHandle(candidate)).toBeUndefined()
    expect(parseVccArchiveHandle(parts.join(":"))).toBeDefined()
  })

  test("rejects wrong scope, source, payload, and byte bound", () => {
    const metadata = archive()
    expect(verifyVccArchive({ ...scope, session_id: "wrong-session", handle: metadata.handle, source_bytes, payload_bytes })).toMatchObject({ valid: false, reason: "scope_mismatch" })
    expect(verifyVccArchive({ ...scope, lineage_id: "wrong-lineage", handle: metadata.handle, source_bytes, payload_bytes })).toMatchObject({ valid: false, reason: "scope_mismatch" })
    expect(verifyVccArchive({ ...scope, stable_source_id: "event-002", handle: metadata.handle, source_bytes, payload_bytes })).toMatchObject({ valid: false, reason: "source_mismatch" })
    expect(verifyVccArchive({ ...scope, handle: metadata.handle, source_bytes: "wrong source", payload_bytes })).toMatchObject({ valid: true })
    expect(verifyVccArchive({ ...scope, stable_source_identity: "event-002", handle: metadata.handle, source_bytes, payload_bytes })).toMatchObject({ valid: false, reason: "source_mismatch" })
    expect(verifyVccArchive({ ...scope, handle: metadata.handle, source_bytes, payload_bytes: "wrong payload" })).toMatchObject({ valid: false, reason: "payload_mismatch" })
    expect(verifyVccArchive({ ...scope, handle: metadata.handle, source_bytes, payload_bytes, max_bytes: 1 })).toMatchObject({ valid: false, reason: "oversized" })
  })

  test("rejects invalid identity and malformed verification bytes", () => {
    expect(() => createVccArchiveHandle({ ...scope, stable_source_id: "1", source_bytes, payload_bytes })).toThrow()
    expect(verifyVccArchive({ ...scope, handle: "archive:v1:opencode-v1:bad:bad:bad", source_bytes, payload_bytes })).toMatchObject({ valid: false, reason: "malformed_handle" })
    expect(verifyVccArchive({ ...scope, handle: archive().handle, source_bytes: 42 as unknown as string, payload_bytes })).toMatchObject({ valid: false, reason: "invalid_bytes" })
  })
})
