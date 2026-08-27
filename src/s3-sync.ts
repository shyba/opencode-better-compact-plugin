import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { readdir, stat } from "node:fs/promises"
import { Readable } from "node:stream"
import path from "node:path"

export type S3FileVersion = {
  fileID: string
  size: number
  mtimeMs: number
  sha256: string
}

export type S3Upload = {
  endpoint: string
  token: string
  fileID: string
  sourcePath: string
  filename: string
  size: number
  start: number
  full: boolean
  signal?: AbortSignal
}

export type S3DiscoveredFile = {
  filename: string
  sourcePath: string
  size: number
  mtimeMs: number
}

export type S3SourceSnapshot = {
  rootMtimeMs: number
  files: S3DiscoveredFile[]
}

export type S3UploadPlan =
  | { action: "skip"; version: S3FileVersion }
  | { action: "upload"; version: S3FileVersion; fileID: string; start: number; full: boolean }

/** Decide whether a source version is an append, a complete replacement, or
 *  already represented by the acknowledged bytes. A timestamp-only touch is
 *  intentionally a skip: it must not become an empty continuation frame. */
export function planS3Upload(sourcePath: string, metadata: { size: number; mtimeMs: number }, sha256: string, previous?: S3FileVersion): S3UploadPlan {
  if (previous && previous.size === metadata.size && previous.sha256 === sha256) {
    return { action: "skip", version: { ...previous, mtimeMs: metadata.mtimeMs } }
  }
  const full = !previous || metadata.size < previous.size || (metadata.size === previous.size && previous.sha256 !== sha256)
  const start = full ? 0 : Math.min(previous!.size, metadata.size)
  const version = { fileID: s3FileID(sourcePath, metadata, sha256, start, full), size: metadata.size, mtimeMs: metadata.mtimeMs, sha256 }
  return { action: "upload", version, fileID: version.fileID, start, full }
}

/** Walk only regular JSONL files. The session-center frame contract carries
 *  the relative path, so symlinks and non-JSONL artifacts are intentionally
 *  ignored rather than accidentally archiving credentials or databases. */
export async function discoverS3JsonlFiles(root: string): Promise<string[]> {
  return (await discoverS3JsonlSnapshot(root)).files.map((file) => file.filename)
}

/** Walk JSONL sources once and retain the metadata needed by the incremental
 * scanner. Stat results are collected during discovery so an unchanged file
 * can be skipped without opening it for hashing. */
export async function discoverS3JsonlSnapshot(root: string): Promise<S3SourceSnapshot> {
  const metadata = await stat(root)
  if (metadata.isFile()) {
    return {
      rootMtimeMs: metadata.mtimeMs,
      files: root.endsWith(".jsonl") ? [{ filename: root, sourcePath: path.basename(root), size: metadata.size, mtimeMs: metadata.mtimeMs }] : [],
    }
  }
  if (!metadata.isDirectory()) return { rootMtimeMs: metadata.mtimeMs, files: [] }
  const files: S3DiscoveredFile[] = []
  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const filename = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        await walk(filename)
        continue
      }
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue
      const fileMetadata = await stat(filename)
      files.push({ filename, sourcePath: path.relative(root, filename).split(path.sep).join("/"), size: fileMetadata.size, mtimeMs: fileMetadata.mtimeMs })
    }
  }
  await walk(root)
  files.sort((left, right) => left.sourcePath.localeCompare(right.sourcePath))
  return { rootMtimeMs: metadata.mtimeMs, files }
}

export async function hashS3File(filename: string): Promise<string> {
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(filename)) hash.update(chunk as Uint8Array)
  return hash.digest("hex")
}

/** Match session-center's version identity: an uploaded mtime/size version gets
 *  a fresh id, while replaying the same bytes is skipped or answered with 204. */
export function s3FileID(sourcePath: string, metadata: { size: number; mtimeMs: number }, sha256: string, start: number, full: boolean): string {
  return createHash("sha1").update(`${sourcePath}:${metadata.mtimeMs}:${metadata.size}:${sha256}:${start}:${full ? "full" : "append"}`).digest("hex").slice(0, 24)
}

export async function uploadS3File(input: S3Upload): Promise<{ status: number; sha256?: string; size: number }> {
  const size = Math.max(0, input.size - input.start)
  // Bun's sliced File body can advertise a sentinel-sized content length when
  // the slice is created lazily. A bounded native stream keeps the body
  // byte-exact without buffering the session file in memory.
  const body = size === 0
    ? new Uint8Array()
    : Readable.toWeb(createReadStream(input.filename, { start: input.start, end: input.size - 1 })) as unknown as globalThis.ReadableStream<Uint8Array>
  const url = new URL(`file/${encodeURIComponent(input.fileID)}`, input.endpoint.endsWith("/") ? input.endpoint : `${input.endpoint}/`)
  const response = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${input.token}`,
      "content-type": "application/octet-stream",
      "content-length": String(size),
      "x-vcc-path": input.sourcePath,
      "x-vcc-start": String(input.start),
      ...(input.full ? { "x-vcc-full": "true" } : {}),
    },
    body,
    ...(input.signal ? { signal: input.signal } : {}),
  })
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500)
    throw new Error(`session-center S3 ingest failed (${response.status})${detail ? `: ${detail}` : ""}`)
  }
  const sha256 = response.headers.get("x-sha256")
  return { status: response.status, ...(sha256 ? { sha256 } : {}), size }
}

export function validateS3Endpoint(value: string, allowInsecureRemote = false): string {
  let parsed: URL
  try { parsed = new URL(value) } catch { throw new Error("session-center URL must be an absolute http(s) URL") }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("session-center URL must use http:// or https://")
  if (parsed.pathname.endsWith("/file") || parsed.pathname.endsWith("/health")) throw new Error("session-center URL must be the service base URL, not a route")
  const local = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "::1"
  if (parsed.protocol === "http:" && !local && !allowInsecureRemote) throw new Error("refusing plaintext session-center sync to a non-local host; use https or sync.allow_insecure_remote=true")
  if (parsed.protocol === "http:" && !local && allowInsecureRemote) console.error("warning: session data and bearer token use plaintext transport to a non-local session-center host")
  return parsed.toString().replace(/\/$/, "")
}
