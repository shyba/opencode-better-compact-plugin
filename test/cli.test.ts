import { afterEach, describe, expect, test } from "bun:test"
import { appendFile, chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import os from "node:os"
import path from "node:path"
import { Database } from "bun:sqlite"
import { openSyncState } from "../src/sync-state.js"
import { sessionRecord } from "../src/jsonl.js"

const temporary: string[] = []

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((item) => rm(item, { recursive: true, force: true })))
})

describe("better-compact Pi installation", () => {
  test("registers the managed Git checkout as a Pi package", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "better-compact-cli-"))
    temporary.push(root)
    const install = path.join(root, "safe-compaction")
    await mkdir(path.join(install, ".git"), { recursive: true })
    const log = path.join(root, "pi.log")
    const pi = await fakePi(root)

    const result = await runCLI(["install", "pi"], {
      OPENCODE_SAFE_COMPACTION_DIR: install,
      OPENCODE_SAFE_COMPACTION_PI: pi,
      PI_LOG: log,
    })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain(`Installing safe-compaction Pi extensions from ${install}`)
    expect(await readFile(log, "utf8")).toBe(`--version\ninstall ${install}\n`)
  })

  test("requires an explicit package source from npx", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "better-compact-cli-"))
    temporary.push(root)
    const log = path.join(root, "pi.log")
    const pi = await fakePi(root)

    const result = await runCLI(["install", "pi"], {
      OPENCODE_SAFE_COMPACTION_DIR: path.join(root, "missing"),
      OPENCODE_SAFE_COMPACTION_PI: pi,
      OPENCODE_SAFE_COMPACTION_PI_SOURCE: "git:github.com/shyba/opencode-better-compact-plugin",
      npm_config_user_agent: "npm/11.0.0 npx/11.0.0",
      PI_LOG: log,
    })

    expect(result.exitCode).toBe(0)
    expect(await readFile(log, "utf8")).toBe(
      "--version\ninstall git:github.com/shyba/opencode-better-compact-plugin\n",
    )
  })

  test("refuses an ephemeral npx install without a source override", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "better-compact-cli-"))
    temporary.push(root)
    const log = path.join(root, "pi.log")
    const pi = await fakePi(root)

    const result = await runCLI(["install", "pi"], {
      OPENCODE_SAFE_COMPACTION_DIR: path.join(root, "missing"),
      OPENCODE_SAFE_COMPACTION_PI: pi,
      npm_config_user_agent: "npm/11.0.0 npx/11.0.0",
      PI_LOG: log,
    })

    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain("npx is ephemeral")
    expect(await readFile(log, "utf8")).toBe("--version\n")
  })
})

describe("better-compact sync setup", () => {
  test("stores a validated writer URL outside the JSON config and discovers existing sources", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "better-compact-cli-"))
    temporary.push(root)
    await mkdir(path.join(root, ".codex", "sessions"), { recursive: true })
    const config = path.join(root, "config.json")
    const stateHome = path.join(root, "state")
    const databaseURL = "postgresql://writer:secret@db.example.test:5432/app?sslmode=verify-full"

    const result = await runCLI(["sync", "setup", "--url", databaseURL], {
      HOME: root,
      BETTER_COMPACT_CONFIG: config,
      BETTER_COMPACT_HOME: stateHome,
    })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).not.toContain(databaseURL)
    expect(await readFile(config, "utf8")).not.toContain(databaseURL)
    expect(JSON.parse(await readFile(config, "utf8"))).toMatchObject({
      sync: { enabled: true, allow_insecure_remote: false },
      sources: [
        { kind: "codex-jsonl", database: "~/.codex/sessions" },
        { kind: "codex-jsonl-sessions", database: "~/.codex/sessions" },
      ],
    })
    const environmentFile = path.join(stateHome, "sync.env")
    expect(await readFile(environmentFile, "utf8")).toBe(`OPENCODE_SYNC_DATABASE_URL=\"${databaseURL}\"\n`)
    expect((await stat(environmentFile)).mode & 0o777).toBe(0o600)
  })

  test("accepts a trusted plaintext URL only with the explicit opt-in", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "better-compact-cli-"))
    temporary.push(root)
    const config = path.join(root, "config.json")
    const stateHome = path.join(root, "state")
    const databaseURL = "postgresql://writer:secret@192.168.0.31:5432/app?sslmode=disable"

    const result = await runCLI(["sync", "setup", "--url-stdin", "--allow-insecure-remote"], {
      HOME: root,
      BETTER_COMPACT_CONFIG: config,
      BETTER_COMPACT_HOME: stateHome,
    }, `${databaseURL}\n`)

    expect(result.exitCode).toBe(0)
    expect(result.stdout).not.toContain("secret")
    expect(JSON.parse(await readFile(config, "utf8"))).toMatchObject({ sync: { enabled: true, allow_insecure_remote: true } })
    expect(await readFile(path.join(stateHome, "sync.env"), "utf8")).toContain(databaseURL)
  })

  test("composes the writer URL from the documented database environment variables", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "better-compact-cli-"))
    temporary.push(root)
    const config = path.join(root, "config.json")
    const stateHome = path.join(root, "state")

    const result = await runCLI(["sync", "setup", "--allow-insecure-remote"], {
      HOME: root,
      BETTER_COMPACT_CONFIG: config,
      BETTER_COMPACT_HOME: stateHome,
      POSTGRES_HOST: "192.168.0.31",
      POSTGRES_PORT: "5432",
      POSTGRES_DB: "app",
      DB_WRITER_USER: "writer",
      DB_WRITER_PASSWORD: "secret",
      POSTGRES_SSLMODE: "disable",
    })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).not.toContain("secret")
    expect(await readFile(path.join(stateHome, "sync.env"), "utf8")).toContain(
      "postgresql://writer:secret@192.168.0.31:5432/app?sslmode=disable",
    )
  })

  test("rejects insecure remote URLs without changing configuration", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "better-compact-cli-"))
    temporary.push(root)
    const config = path.join(root, "config.json")
    const stateHome = path.join(root, "state")
    const databaseURL = "postgresql://writer:secret@192.168.0.31:5432/app?sslmode=disable"

    const result = await runCLI(["sync", "setup", "--url", databaseURL], {
      HOME: root,
      BETTER_COMPACT_CONFIG: config,
      BETTER_COMPACT_HOME: stateHome,
    })

    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain("sslmode=verify-full")
    expect(await Bun.file(config).exists()).toBe(false)
    expect(await Bun.file(path.join(stateHome, "sync.env")).exists()).toBe(false)
  })
})

describe("better-compact RAG setup", () => {
  test("persists the measured streaming pipeline settings", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "better-compact-cli-"))
    temporary.push(root)
    const config = path.join(root, "config.json")
    const result = await runCLI(["rag", "setup", "--backend", "torch", "--compute-dtype", "bfloat16", "--length-bucketing", "--batch-size", "16", "--message-batch-size", "2048", "--threads", "16", "--full-sweep-interval-seconds", "900", "--model-path", "/tmp/bge", "--python", "/tmp/.venv/bin/python3"], {
      HOME: root,
      BETTER_COMPACT_CONFIG: config,
      BETTER_COMPACT_HOME: path.join(root, "state"),
    })

    expect(result.exitCode).toBe(0)
    expect(JSON.parse(await readFile(config, "utf8"))).toMatchObject({
      rag: {
        enabled: true,
        backend: "torch",
        compute_dtype: "bfloat16",
        length_bucketing: true,
        batch_size: 16,
        message_batch_size: 2048,
        threads: 16,
        full_sweep_interval_seconds: 900,
        model_path: "/tmp/bge",
        python: "/tmp/.venv/bin/python3",
      },
    })
  })
})

async function fakePi(root: string) {
  const executable = path.join(root, "pi")
  await writeFile(
    executable,
    '#!/bin/sh\nprintf "%s\\n" "$*" >> "$PI_LOG"\n[ "$1" = "--version" ] && exit 0\n[ "$1" = "install" ] && test -n "$2" && exit 0\nexit 1\n',
  )
  await chmod(executable, 0o700)
  return executable
}

async function runCLI(args: string[], overrides: Record<string, string>, input?: string) {
  const child = Bun.spawn([process.execPath, path.join(process.cwd(), "scripts/cli.ts"), ...args], {
    cwd: process.cwd(),
    env: { ...process.env, ...overrides },
    ...(input === undefined ? {} : { stdin: new Blob([input]) }),
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { exitCode: await child.exited, stdout, stderr }
}

describe("better-compact sync run --once", () => {
  test("bypasses the shallow skip fingerprint so a deep append is not stranded", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "better-compact-cli-"))
    temporary.push(root)
    const deep = path.join(root, "sessions", "2026", "08", "14")
    await mkdir(deep, { recursive: true })
    const message = (text: string) => JSON.stringify({ timestamp: "2026-08-14T10:00:00.000Z", type: "event_msg", payload: { type: "user_message", message: text } })
    const filename = path.join(deep, "rollout-once.jsonl")
    await writeFile(filename, [JSON.stringify({ timestamp: "2026-08-14T10:00:00.000Z", type: "session_meta", payload: { id: "55555555-5555-7555-8555-555555555555", timestamp: "2026-08-14T10:00:00.000Z", cwd: "/repo" } }), message("first")].join("\n") + "\n")
    const config = path.join(root, "config.json")
    const state = path.join(root, "state.sqlite")
    await writeFile(config, JSON.stringify({ version: 1, sync: { enabled: true }, sources: [{ kind: "codex-jsonl", database: path.join(root, "sessions") }] }))
    const environment = { HOME: root, BETTER_COMPACT_CONFIG: config, BETTER_COMPACT_STATE: state }

    const first = await runCLI(["sync", "run", "--once"], environment)
    expect(first.exitCode).toBe(0)

    // Append one message to an existing deep file: the directory fingerprint
    // (direct children of the root) cannot see this, so a skip would strand it.
    await appendFile(filename, `${message("second")}\n`)
    const second = await runCLI(["sync", "run", "--once"], environment)
    expect(second.exitCode).toBe(0)
    expect(second.stdout).not.toContain(`unchanged ${path.join(root, "sessions")}`)

    const db = new Database(state, { readonly: true })
    const keys = db.query("select natural_key from normalized_record where record_kind='message' order by natural_key").all().map((row) => String((row as { natural_key: string }).natural_key))
    db.close()
    expect(keys).toContain("2026/08/14/rollout-once.jsonl|line:1")
  })
})

describe("better-compact sync backfill-hierarchy", () => {
  test("stages hierarchy for mirrored sessions and re-runs cleanly", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "better-compact-cli-"))
    temporary.push(root)
    const sessions = path.join(root, "sessions")
    const deep = path.join(sessions, "2026", "08", "14")
    await mkdir(deep, { recursive: true })
    const parent = "00000000-0000-7000-8000-000000000000"
    const message = (text: string) => JSON.stringify({ timestamp: "2026-08-14T10:00:00.000Z", type: "event_msg", payload: { type: "user_message", message: text } })
    await writeFile(path.join(deep, "rollout-sub.jsonl"), [JSON.stringify({ timestamp: "2026-08-14T10:00:00.000Z", type: "session_meta", payload: { id: "66666666-6666-7666-8666-666666666666", timestamp: "2026-08-14T10:00:00.000Z", cwd: "/repo", source: { subagent: { thread_spawn: { parent_thread_id: parent, depth: 1, agent_nickname: "Alder", agent_role: "awaiter" } } } } }), message("sub")].join("\n") + "\n")
    await writeFile(path.join(deep, "rollout-root.jsonl"), [JSON.stringify({ timestamp: "2026-08-14T10:00:00.000Z", type: "session_meta", payload: { id: "77777777-7777-7777-8777-777777777777", timestamp: "2026-08-14T10:00:00.000Z", cwd: "/repo" } }), message("root")].join("\n") + "\n")
    const state = path.join(root, "state.sqlite")
    const sourceID = createHash("sha256").update(`codex-jsonl\n${path.resolve(sessions)}`).digest("hex").slice(0, 32)

    // Simulate sessions mirrored by an older build: no hierarchy in the payload.
    const store = await openSyncState(state)
    store.ensureInstallation("installation-1", "incarnation-1")
    store.upsertSource({ id: sourceID, installationID: "installation-1", kind: "codex-jsonl", schemaVersion: 1, locator: sessions, incarnation: "source-incarnation-1" })
    store.enqueue([sessionRecord(sourceID, "codex-jsonl", "2026/08/14/rollout-sub.jsonl", "66666666-6666-7666-8666-666666666666", { title: undefined, directory: undefined }, 1, 2), sessionRecord(sourceID, "codex-jsonl", "2026/08/14/rollout-root.jsonl", "77777777-7777-7777-8777-777777777777", { title: undefined, directory: undefined }, 1, 2)], sourceID, "messages", { legacy: true })
    store.close()

    const config = path.join(root, "config.json")
    await writeFile(config, JSON.stringify({ version: 1, sync: { enabled: true }, sources: [{ kind: "codex-jsonl", database: sessions }] }))
    const environment = { HOME: root, BETTER_COMPACT_CONFIG: config, BETTER_COMPACT_STATE: state }

    const dry = await runCLI(["sync", "backfill-hierarchy", "--dry-run"], environment)
    expect(dry.exitCode).toBe(0)
    expect(dry.stdout).toContain("would update 2 session records (0 unknown), 0 already current")

    const apply = await runCLI(["sync", "backfill-hierarchy"], environment)
    expect(apply.exitCode).toBe(0)
    expect(apply.stdout).toContain("updated 2 session records (0 unknown), 0 already current")

    const again = await runCLI(["sync", "backfill-hierarchy"], environment)
    expect(again.stdout).toContain("updated 0 session records (0 unknown), 2 already current")

    const db = new Database(state, { readonly: true })
    const rows = db.query("select natural_key, payload_json from normalized_record where record_kind='session'").all().map((row) => row as { natural_key: string; payload_json: string })
    db.close()
    const sub = rows.find((row) => row.natural_key === "2026/08/14/rollout-sub.jsonl|session")
    const subPayload = JSON.parse(sub.payload_json) as Record<string, any>
    expect(subPayload.parent_session_id).toBe(parent)
    expect(subPayload.metadata.hierarchy).toEqual({ hierarchy_status: "subagent", parent_session_id: parent, depth: 1, nickname: "Alder", role: "awaiter" })
    const plain = rows.find((row) => row.natural_key === "2026/08/14/rollout-root.jsonl|session")
    expect((JSON.parse(plain.payload_json) as Record<string, any>).metadata.hierarchy).toEqual({ hierarchy_status: "root" })
  })

  test("marks mirrored sessions whose files are missing locally as unknown", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "better-compact-cli-"))
    temporary.push(root)
    const sessions = path.join(root, "sessions")
    await mkdir(sessions, { recursive: true })
    const state = path.join(root, "state.sqlite")
    const sourceID = createHash("sha256").update(`codex-jsonl\n${path.resolve(sessions)}`).digest("hex").slice(0, 32)
    const store = await openSyncState(state)
    store.ensureInstallation("installation-1", "incarnation-1")
    store.upsertSource({ id: sourceID, installationID: "installation-1", kind: "codex-jsonl", schemaVersion: 1, locator: sessions, incarnation: "source-incarnation-1" })
    store.enqueue([sessionRecord(sourceID, "codex-jsonl", "2025/01/01/rollout-remote.jsonl", "88888888-8888-7888-8888-888888888888", { title: undefined, directory: undefined }, 1, 2)], sourceID, "messages", { legacy: true })
    store.close()

    const config = path.join(root, "config.json")
    await writeFile(config, JSON.stringify({ version: 1, sync: { enabled: true }, sources: [{ kind: "codex-jsonl", database: sessions }] }))
    const result = await runCLI(["sync", "backfill-hierarchy"], { HOME: root, BETTER_COMPACT_CONFIG: config, BETTER_COMPACT_STATE: state })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("updated 1 session record (1 unknown), 0 already current")

    const db = new Database(state, { readonly: true })
    const row = db.query("select payload_json from normalized_record where record_kind='session'").get() as { payload_json: string }
    db.close()
    expect((JSON.parse(row.payload_json) as Record<string, any>).metadata.hierarchy).toEqual({ hierarchy_status: "unknown" })
  })
})
