import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import { stat } from "node:fs/promises"
import path from "node:path"
import { discoverS3JsonlSnapshot, hashS3FileSnapshot } from "../src/s3-sync.js"

type Source = { kind: string; database: string }
type Stage = { status: string; reason?: string; [key: string]: unknown }
type Result = { path: string; source: string; local: Stage; archive: Stage; loaded: Stage; indexed: Stage }
const unknown = (reason: string): Stage => ({ status: "unknown", reason })

/** Read-only inventory: no receipt reset, upload, schema migration or state writes. */
export async function verifySync(input: {
  sources: Source[]; state: string; endpoint: string; token: string; json: boolean
}): Promise<number> {
  let db: Database | undefined
  const results: Result[] = []
  const seen = new Set<string>()
  const startedAt = new Date().toISOString()
  try {
    let stateError: string | undefined
    let hasReceipts: unknown
    try {
      if (await stat(input.state).then(() => true, () => false)) db = new Database(input.state, { readonly: true })
      hasReceipts = db?.query("select 1 from sqlite_master where type='table' and name='s3_file'").get()
    } catch { stateError = "local receipt database cannot be read" }
    for (const source of input.sources) {
      const root = path.resolve(source.database.replace(/^~(?=\/|$)/, process.env.HOME ?? "."))
      if (seen.has(root)) continue
      seen.add(root)
      const sourceID = createHash("sha256").update(`${source.kind}\n${root}`).digest("hex").slice(0, 32)
      const base = (file: string): Result => ({ path: file, source: root, local: unknown("not scanned"), archive: unknown("not checked"), loaded: unknown("not checked"), indexed: unknown("not checked") })
      if (!["codex-jsonl", "codex-jsonl-sessions", "pi-jsonl"].includes(source.kind)) {
        results.push({ ...base(root), local: unknown(`unsupported S3 source: ${source.kind}`) }); continue
      }
      try {
        const snapshot = await discoverS3JsonlSnapshot(root)
        if (!snapshot.files.length) results.push({ ...base(root), local: unknown("no regular JSONL files discovered; check configured root") })
        for (const file of snapshot.files) {
          const result = base(file.sourcePath)
          results.push(result)
          try {
            const hashed = await hashS3FileSnapshot(file.filename, file.size)
            const after = await stat(file.filename)
            if (after.size !== file.size || after.mtimeMs !== file.mtimeMs) throw new Error("file changed during verification; retry when stable")
            if (stateError) { result.local = unknown(stateError); continue }
            const receipt = hasReceipts ? db!.query("select file_id,size,sha256 from s3_file where source_id=? and path=?").get(sourceID, file.sourcePath) as { file_id: string; size: number; sha256: string } | null : null
            if (!receipt) { result.local = { status: "missing", reason: "no local upload receipt; run sync run --once" }; continue }
            if (Number(receipt.size) !== file.size || receipt.sha256 !== hashed.sha256) {
              result.local = { status: "mismatch", reason: "local content differs from upload receipt; run sync run --once" }; continue
            }
            result.local = { status: "verified", size: file.size, sha256: hashed.sha256 }
            const response = await fetch(`${input.endpoint.replace(/\/$/, "")}/verify`, {
              method: "POST", headers: { Authorization: `Bearer ${input.token}`, "content-type": "application/json" },
              body: JSON.stringify({ files: [{ file_id: receipt.file_id, source_id: sourceID, path: file.sourcePath, size: file.size, sha256: hashed.sha256 }] }),
              signal: AbortSignal.timeout(210_000),
            })
            if (!response.ok) throw new Error(`receiver verification HTTP ${response.status}${response.status === 404 ? "; update the receiver to enable /verify" : ""}`)
            const body = await response.json() as { files?: Array<{ file_id: string; archive: Stage; loaded: Stage; indexed: Stage }> }
            const remote = body.files?.find(item => item.file_id === receipt.file_id)
            if (!remote?.archive?.status || !remote.loaded?.status || !remote.indexed?.status) throw new Error("invalid receiver verification response")
            result.archive = remote.archive; result.loaded = remote.loaded; result.indexed = remote.indexed
          } catch (error) {
            const reason = error instanceof Error ? error.message : "verification failed"
            if (result.local.status !== "verified") result.local = unknown(reason)
            else result.archive = unknown(reason)
          }
          console.error(`${root}/${file.sourcePath}: local=${result.local.status} archive=${result.archive.status} loaded=${result.loaded.status} indexed=${result.indexed.status}`)
        }
      } catch (error) { results.push({ ...base(root), local: unknown(error instanceof Error ? error.message : "source scan failed") }) }
    }
  } finally { db?.close() }
  const complete = results.length > 0 && results.every(row => [row.local, row.archive, row.loaded, row.indexed].every(stage => stage.status === "verified"))
  const summary = { complete, started_at: startedAt, finished_at: new Date().toISOString(), checked: results.length, incomplete: results.filter(row => [row.local, row.archive, row.loaded, row.indexed].some(stage => stage.status !== "verified")).length }
  if (input.json) console.log(JSON.stringify({ ...summary, scope: "configured regular JSONL files; point presence and provenance, not relevance quality", files: results }, null, 2))
  else {
    console.log(`Checked ${summary.checked} entries; ${summary.incomplete} incomplete or unverified.`)
    for (const row of results) for (const [name, stage] of Object.entries({ local: row.local, archive: row.archive, loaded: row.loaded, indexed: row.indexed })) {
      if (stage.status !== "verified" && stage.reason) console.log(`${row.path}: ${name}: ${stage.reason}`)
    }
  }
  return complete ? 0 : 1
}
