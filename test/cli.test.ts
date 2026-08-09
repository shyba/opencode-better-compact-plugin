import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

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
