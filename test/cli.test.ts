import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
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

async function fakePi(root: string) {
  const executable = path.join(root, "pi")
  await writeFile(
    executable,
    '#!/bin/sh\nprintf "%s\\n" "$*" >> "$PI_LOG"\n[ "$1" = "--version" ] && exit 0\n[ "$1" = "install" ] && test -n "$2" && exit 0\nexit 1\n',
  )
  await chmod(executable, 0o700)
  return executable
}

async function runCLI(args: string[], overrides: Record<string, string>) {
  const child = Bun.spawn([process.execPath, path.join(process.cwd(), "scripts/cli.ts"), ...args], {
    cwd: process.cwd(),
    env: { ...process.env, ...overrides },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { exitCode: await child.exited, stdout, stderr }
}
