import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, expect, test } from "bun:test"
import { discoverS3JsonlFiles, discoverS3JsonlSnapshot, hashS3File, planS3Upload, s3FileID, uploadS3File, validateS3Endpoint } from "../src/s3-sync.js"

describe("session-center S3 source transport", () => {
  test("discovers only regular JSONL files and preserves relative ordering", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "better-compact-s3-"))
    try {
      await mkdir(path.join(root, "nested"), { recursive: true })
      await writeFile(path.join(root, "z.jsonl"), "z\n")
      await writeFile(path.join(root, "nested", "a.jsonl"), "a\n")
      await writeFile(path.join(root, "notes.txt"), "do not archive\n")
      await symlink(path.join(root, "z.jsonl"), path.join(root, "nested", "link.jsonl"))
      expect((await discoverS3JsonlFiles(root)).map((file) => path.relative(root, file))).toEqual(["nested/a.jsonl", "z.jsonl"])
      expect((await discoverS3JsonlSnapshot(root)).files).toEqual([
        expect.objectContaining({ sourcePath: "nested/a.jsonl", size: 2 }),
        expect.objectContaining({ sourcePath: "z.jsonl", size: 2 }),
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("hashes bytes and derives the session-center version identity", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "better-compact-s3-"))
    try {
      const filename = path.join(root, "session.jsonl")
      await writeFile(filename, "hello\n")
      expect(await hashS3File(filename)).toBe("5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03")
      expect(s3FileID("session.jsonl", { size: 6, mtimeMs: 10 }, "a", 0, true)).toBe(s3FileID("session.jsonl", { size: 6, mtimeMs: 10 }, "a", 0, true))
      expect(s3FileID("session.jsonl", { size: 6, mtimeMs: 10 }, "b", 0, true)).not.toBe(s3FileID("session.jsonl", { size: 6, mtimeMs: 10 }, "a", 0, true))
      expect(s3FileID("session.jsonl", { size: 6, mtimeMs: 10 }, "a", 1, false)).not.toBe(s3FileID("session.jsonl", { size: 6, mtimeMs: 10 }, "a", 0, true))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("plans append, replacement, and timestamp-only updates without empty frames", () => {
    const previous = { fileID: "old", size: 10, mtimeMs: 10, sha256: "a" }
    expect(planS3Upload("session.jsonl", { size: 10, mtimeMs: 20 }, "a", previous)).toEqual({
      action: "skip",
      version: { ...previous, mtimeMs: 20 },
    })
    expect(planS3Upload("session.jsonl", { size: 14, mtimeMs: 20 }, "b", previous)).toMatchObject({ action: "upload", start: 10, full: false })
    expect(planS3Upload("session.jsonl", { size: 8, mtimeMs: 20 }, "c", previous)).toMatchObject({ action: "upload", start: 0, full: true })
    expect(planS3Upload("session.jsonl", { size: 10, mtimeMs: 20 }, "b", previous)).toMatchObject({ action: "upload", start: 0, full: true })
  })

  test("validates base URLs and refuses unsafe remote plaintext", () => {
    expect(validateS3Endpoint("http://127.0.0.1:8787/")).toBe("http://127.0.0.1:8787")
    expect(() => validateS3Endpoint("http://archive.example.test:8787")).toThrow("plaintext")
    expect(validateS3Endpoint("http://archive.example.test:8787", true)).toBe("http://archive.example.test:8787")
    expect(() => validateS3Endpoint("https://archive.example.test:8787/file")).toThrow("base URL")
  })

  test("sends append bytes and replacement metadata through the HTTP contract", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "better-compact-s3-"))
    const requests: Array<{ path: string; full: string | null; body: string }> = []
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        requests.push({ path: new URL(request.url).pathname, full: request.headers.get("x-vcc-full"), body: await request.text() })
        return new Response(null, { status: 204, headers: { "x-sha256": "remote-digest" } })
      },
    })
    try {
      const filename = path.join(root, "session.jsonl")
      await writeFile(filename, "alpha\nbeta\n")
      const endpoint = `http://127.0.0.1:${server.port}`
      await uploadS3File({ endpoint, token: "token-token-token", fileID: "version-1", sourcePath: "session.jsonl", filename, size: 11, start: 6, full: false })
      await uploadS3File({ endpoint, token: "token-token-token", fileID: "version-2", sourcePath: "session.jsonl", filename, size: 11, start: 0, full: true })
      expect(requests).toEqual([
        { path: "/file/version-1", full: null, body: "beta\n" },
        { path: "/file/version-2", full: "true", body: "alpha\nbeta\n" },
      ])
    } finally {
      server.stop(true)
      await rm(root, { recursive: true, force: true })
    }
  })
})
