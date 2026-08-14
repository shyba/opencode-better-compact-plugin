import { mkdtemp, rm, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, expect, test } from "bun:test"
import { buildAuthoritativeSummary, isPluginValidSummary } from "../src/validation.js"
import { canonicalLedger } from "../src/ledger.js"
import { SEMANTIC_CHECKPOINT_MAX_BYTES, SemanticStore, attachSemanticCheckpoint, repositoryIdentity, semanticArtifacts, semanticCheckpointBlock, validateSemanticDelta } from "../src/semantic.js"
import { utf8Bytes } from "../src/ledger.js"

describe("semantic checkpoint state", () => {
  test("validates evidence, persists versioned objects, and keeps summaries self-contained", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "better-compact-semantic-"))
    try {
      const store = new SemanticStore(path.join(dir, "state.sqlite"))
      expect((await stat(path.join(dir, "state.sqlite"))).mode & 0o777).toBe(0o600)
      const repository = repositoryIdentity(dir)
      const artifacts = semanticArtifacts([{ path: "src/runner.rs", text: "trait Runner {}", bytes: 15, tokens: 4 }], 1_024)
      const delta = validateSemanticDelta({
        upserts: [{ id: "sem:runner", kind: "concept", title: "Runner", summary: "Execution lifecycle abstraction.", status: "current", confidence: "high", evidence_refs: [artifacts[0]!.ref], related_ids: [] }],
        supersede_ids: [], active_ids: ["sem:runner"], nucleus: ["Runner owns the execution lifecycle."],
      }, artifacts, new Set())
      expect(delta).toBeDefined()
      const checkpoint = store.commit(repository, artifacts, delta!)
      expect(store.context(repository.id)).toContain("sem:runner")
      expect(store.currentIDs(repository.id)).toEqual(new Set(["sem:runner"]))
      expect(store.db.query("select count(*) as count from semantic_artifact").get()).toEqual({ count: 1 })
      expect(JSON.stringify(store.db.query("select * from semantic_artifact").all())).not.toContain("trait Runner")

      const ledger = canonicalLedger({ recent_requests: ["review runner"], constraints: [], todos: [], touched_paths: [], tool_statuses: [], errors: [], evidence: [], next_actions: [], legacy_context: [] })
      const summary = attachSemanticCheckpoint(buildAuthoritativeSummary({ ledger, maxBytes: 49_152 }), checkpoint, 49_152)
      expect(summary).toContain(checkpoint.snapshot_id)
      expect(summary).toContain("Runner owns the execution lifecycle.")
      expect(summary).not.toContain("trait Runner")
      expect(isPluginValidSummary(summary, 49_152)).toBe(true)
      store.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("rejects unsupported evidence and dangling semantic relations", () => {
    const artifacts = semanticArtifacts([{ path: "a.rs", text: "fn a() {}", bytes: 9, tokens: 3 }], 1_024)
    const base = { id: "sem:a", kind: "concept", title: "A", summary: "A concept.", status: "current", confidence: "medium" }
    expect(validateSemanticDelta({ upserts: [{ ...base, evidence_refs: ["cat:invented"], related_ids: [] }], supersede_ids: [], active_ids: ["sem:a"], nucleus: ["A exists."] }, artifacts, new Set())).toBeUndefined()
    expect(validateSemanticDelta({ upserts: [{ ...base, evidence_refs: [artifacts[0]!.ref], related_ids: ["sem:missing"] }], supersede_ids: [], active_ids: ["sem:a"], nucleus: ["A exists."] }, artifacts, new Set())).toBeUndefined()
  })

  test("skips an oversized artifact without hiding later files that fit", () => {
    const artifacts = semanticArtifacts([
      { path: "a.ts", text: "x".repeat(20), bytes: 20, tokens: 5 },
      { path: "b.ts", text: "small", bytes: 5, tokens: 2 },
    ], 10)
    expect(artifacts.map((artifact) => artifact.path)).toEqual(["b.ts"])
  })

  test("bounds the worst accepted inline checkpoint to its reserved bytes", () => {
    const activeIDs = Array.from({ length: 16 }, (_, index) => `sem:${index.toString().padStart(3, "0")}${"x".repeat(120)}`)
    const delta = validateSemanticDelta({
      upserts: [], supersede_ids: [], active_ids: activeIDs,
      nucleus: Array.from({ length: 8 }, (_, index) => `${index}${"n".repeat(254)}`),
    }, [], new Set(activeIDs))
    expect(delta).toBeDefined()
    expect(utf8Bytes(semanticCheckpointBlock({
      version: 1,
      repository_id: `repo:${"r".repeat(32)}`,
      snapshot_id: `semshot:${"s".repeat(32)}`,
      digest: "d".repeat(64),
      active_ids: delta!.active_ids,
      nucleus: delta!.nucleus,
    }))).toBeLessThanOrEqual(SEMANTIC_CHECKPOINT_MAX_BYTES)
  })
})
