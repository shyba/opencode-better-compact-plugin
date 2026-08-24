import { describe, expect, test } from "bun:test"
import type { MessageRecord } from "../src/ledger.js"
import { canonicalSerialize } from "../src/vcc.js"
import { collectVccOpenCodeSession } from "../src/vcc-opencode-session.js"
import {
  buildVccOpenCodeRecallIndex,
  discoverVccOpenCodeHandles,
  renderVccOpenCodeRecallEntry,
  resolveVccOpenCodeHandle,
  vccOpenCodeArchiveManifestDigest,
} from "../src/vcc-opencode-recall.js"

const session_id = "recall-session"
const lineage_id = "opencode-v1:recall-lineage"

function textMessage(id: string, text: string): MessageRecord {
  return {
    info: { id, sessionID: session_id, role: "user" },
    parts: [{ id: `${id}-part`, sessionID: session_id, messageID: id, type: "text", text }],
  }
}

async function collect(messages: MessageRecord[], next_cursor: string | null = null) {
  return collectVccOpenCodeSession({
    session_id,
    lineage_id,
    max_pages: 8,
    max_bytes: 100_000,
    max_candidate_bytes: 1_024,
    compile_candidate: false,
    fetch_page: async () => ({ records: messages, next_cursor }),
  })
}

describe("OpenCode V1 exact recall resolver", () => {
  test("builds deterministic source-scoped handles and verifies exact canonical payload", async () => {
    const result = await collect([textMessage("decision", 'retain api_key: "sk-12345678901234567890"')])
    const first = buildVccOpenCodeRecallIndex({ session_id, lineage_id, result })
    const second = buildVccOpenCodeRecallIndex({ session_id, lineage_id, result: await collect([textMessage("decision", 'retain api_key: "sk-12345678901234567890"')]) })
    expect(first).toEqual(second)
    expect(first).toHaveLength(1)
    expect(first[0]!.handle).toMatch(/^archive:v1:opencode-v1:[a-f0-9]{64}:[a-f0-9]{64}:[a-f0-9]{64}$/)
    const resolved = resolveVccOpenCodeHandle({ handle: first[0]!.handle, session_id, lineage_id, entries: first })
    expect(resolved).toMatchObject({ ok: true })
    const rendered = renderVccOpenCodeRecallEntry(first[0]!, 16_384)!
    expect(rendered).toContain('"presentation":"exact_canonical_payload"')
    expect(rendered).toContain("decision")
    expect(rendered).not.toContain("sk-12345678901234567890")
    expect(first[0]!.source_bytes).not.toContain("sk-12345678901234567890")
  })

  test("fails closed for malformed, cross-host, missing, and oversized handles", async () => {
    const result = await collect([textMessage("one", "deploy decision")])
    const entries = buildVccOpenCodeRecallIndex({ session_id, lineage_id, result })
    expect(resolveVccOpenCodeHandle({ handle: "bad", session_id, lineage_id, entries })).toMatchObject({ ok: false, reason: "malformed_handle" })
    const crossHost = entries[0]!.handle.replace("archive:v1:opencode-v1:", "archive:v1:pi:")
    expect(resolveVccOpenCodeHandle({ handle: crossHost, session_id, lineage_id, entries })).toMatchObject({ ok: false, reason: "scope_mismatch" })
    expect(resolveVccOpenCodeHandle({ handle: `${entries[0]!.handle.slice(0, -1)}0`, session_id, lineage_id, entries })).toMatchObject({ ok: false, reason: "handle_unavailable" })
    expect(resolveVccOpenCodeHandle({ handle: entries[0]!.handle, session_id, lineage_id: "other-lineage", entries })).toMatchObject({ ok: false, reason: "scope_mismatch" })
    expect(resolveVccOpenCodeHandle({ handle: entries[0]!.handle, session_id, lineage_id, entries, max_bytes: 256 })).toMatchObject({ ok: false, reason: "oversized" })
  })

  test("discovers deterministically, pages results, and keeps expansion bounded", async () => {
    const result = await collect([
      textMessage("first", "deploy decision alpha"),
      textMessage("second", "deploy decision beta"),
      textMessage("third", "unrelated"),
    ])
    const entries = buildVccOpenCodeRecallIndex({ session_id, lineage_id, result })
    const page = discoverVccOpenCodeHandles({ query: "deploy decision", entries, page: 2, max_results: 1 })
    expect(page).toMatchObject({ total: 2, page: 2, total_pages: 2 })
    expect(page.entries).toHaveLength(1)
    expect(page.entries[0]!.event.source_location).toContain("second")
    expect(renderVccOpenCodeRecallEntry(page.entries[0]!, 256)).toBeUndefined()
  })

  test("binds the archive-manifest digest to the candidate handles and source", async () => {
    const result = await collectVccOpenCodeSession({
      session_id,
      lineage_id,
      max_pages: 8,
      max_bytes: 100_000,
      max_candidate_bytes: 100_000,
      fetch_page: async () => ({ records: [textMessage("manifest", "archive this decision")], next_cursor: null }),
    })
    expect(result.candidate).toBeDefined()
    const digest = vccOpenCodeArchiveManifestDigest(result.candidate!, session_id, lineage_id)
    expect(digest).toMatch(/^[a-f0-9]{64}$/)
    const body = JSON.parse(result.candidate!.bytes) as { recall_handles: string[] }
    const changed = { ...result.candidate!, bytes: canonicalSerialize({ ...body, recall_handles: [] }) }
    expect(vccOpenCodeArchiveManifestDigest(changed, session_id, lineage_id)).not.toBe(digest)
  })
})
