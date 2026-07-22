import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

const temporary: string[] = []

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((item) => rm(item, { recursive: true, force: true })))
})

describe("installer", () => {
  test("preserves JSONC comments and existing plugin entries", async () => {
    const root = await directory()
    const config = path.join(root, "config")
    const install = path.join(root, "install")
    await Bun.write(
      path.join(config, "opencode.jsonc"),
      `{
  // This comment and unrelated settings must survive installation.
  "theme": "system",
  "plugin": [
    "file:///opt/existing-plugin.ts"
  ]
}
`,
    )
    await chmod(path.join(config, "opencode.jsonc"), 0o600)

    const result = await configure(config, install)
    expect(result.exitCode).toBe(0)
    const text = await Bun.file(path.join(config, "opencode.jsonc")).text()
    const value = Bun.JSONC.parse(text) as { theme: string; plugin: unknown[] }
    expect(text).toContain("This comment and unrelated settings must survive installation.")
    expect(value.theme).toBe("system")
    expect(value.plugin[0]).toBe("file:///opt/existing-plugin.ts")
    expect(value.plugin[1]).toEqual([
      path.join(install, "src/index.ts"),
      expect.objectContaining({ model: "opencode-go/glm-5.2", max_summary_bytes: 49_152 }),
    ])
    const backups = await Array.fromAsync(new Bun.Glob("*.safe-compaction-backup-*").scan(config))
    expect(backups).toHaveLength(1)
    expect((await stat(path.join(config, "opencode.jsonc"))).mode & 0o777).toBe(0o600)
    expect((await stat(path.join(config, backups[0]!))).mode & 0o777).toBe(0o600)

    const repeat = await configure(config, install)
    expect(repeat.exitCode).toBe(0)
    expect(await Bun.file(path.join(config, "opencode.jsonc")).text()).toBe(text)
    expect((await Array.fromAsync(new Bun.Glob("*.safe-compaction-backup-*").scan(config))).length).toBe(1)
  })

  test("refuses the stale provider limit override without changing the file", async () => {
    const root = await directory()
    const config = path.join(root, "config")
    const install = path.join(root, "install")
    const original = `{
  "provider": {
    "example": {
      "models": {
        "deepseek-v4-flash-free": {
          "limit": { "context": 1000 }
        }
      }
    }
  }
}
`
    await Bun.write(path.join(config, "opencode.jsonc"), original)

    const result = await configure(config, install)
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain("does not rewrite provider catalogs")
    expect(await Bun.file(path.join(config, "opencode.jsonc")).text()).toBe(original)
  })

  test("installs from a Git checkout and verifies through OpenCode", async () => {
    const root = await directory()
    const origin = path.join(root, "origin")
    const install = path.join(root, "installed")
    const config = path.join(root, "config")
    const fakeOpenCode = path.join(root, "opencode")
    expect((await command(["git", "clone", "--quiet", process.cwd(), origin])).exitCode).toBe(0)
    await mkdir(path.join(origin, "scripts"), { recursive: true })
    await Bun.write(path.join(origin, "install.sh"), Bun.file(path.join(process.cwd(), "install.sh")))
    await Bun.write(
      path.join(origin, "scripts/configure.ts"),
      Bun.file(path.join(process.cwd(), "scripts/configure.ts")),
    )
    await Bun.write(path.join(origin, "INSTALLER-FIXTURE"), "fixture\n")
    expect(
      (
        await command(
          ["git", "add", "install.sh", "scripts/configure.ts", "INSTALLER-FIXTURE"],
          process.env,
          origin,
        )
      ).exitCode,
    ).toBe(0)
    expect(
      (
        await command(
          ["git", "-c", "user.name=Installer Test", "-c", "user.email=installer@example.invalid", "commit", "-m", "test fixture"],
          process.env,
          origin,
        )
      ).exitCode,
    ).toBe(0)
    await Bun.write(
      fakeOpenCode,
      `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf '1.18.4\\n'
  exit 0
fi
if [ "$1" = "debug" ] && [ "$2" = "config" ]; then
  for file in "$OPENCODE_CONFIG_DIR"/config.json "$OPENCODE_CONFIG_DIR"/opencode.json "$OPENCODE_CONFIG_DIR"/opencode.jsonc; do
    if [ -f "$file" ]; then
      sed -n '1,240p' "$file"
    fi
  done
  exit 0
fi
exit 1
`,
    )
    await chmod(fakeOpenCode, 0o755)

    const environment = {
      ...process.env,
      OPENCODE_SAFE_COMPACTION_REPO: origin,
      OPENCODE_SAFE_COMPACTION_DIR: install,
      OPENCODE_SAFE_COMPACTION_CONFIG_DIR: config,
      OPENCODE_SAFE_COMPACTION_BUN: process.execPath,
      OPENCODE_SAFE_COMPACTION_OPENCODE: fakeOpenCode,
    }
    const first = await command(["sh", "install.sh"], environment)
    expect(first.exitCode).toBe(0)
    expect(first.stdout).toContain("installed successfully")
    expect(await Bun.file(path.join(install, "src/index.ts")).exists()).toBe(true)
    expect(await Bun.file(path.join(install, "node_modules")).exists()).toBe(false)

    await Bun.write(path.join(origin, "INSTALLER-UPDATE-SMOKE"), "updated\n")
    expect((await command(["git", "add", "INSTALLER-UPDATE-SMOKE"], process.env, origin)).exitCode).toBe(0)
    expect(
      (
        await command(
          ["git", "-c", "user.name=Installer Test", "-c", "user.email=installer@example.invalid", "commit", "-m", "test update"],
          process.env,
          origin,
        )
      ).exitCode,
    ).toBe(0)
    const second = await command(["sh", "install.sh"], environment)
    expect(second.exitCode).toBe(0)
    expect(second.stdout).toContain("Configuration already contains")
    expect(await Bun.file(path.join(install, "INSTALLER-UPDATE-SMOKE")).text()).toBe("updated\n")
    const value = Bun.JSONC.parse(await Bun.file(path.join(config, "opencode.jsonc")).text()) as {
      plugin: [[string, { model: string }]]
    }
    expect(value.plugin).toHaveLength(1)
    expect(value.plugin[0]?.[0]).toBe(path.join(install, "src/index.ts"))
    expect(value.plugin[0]?.[1].model).toBe("opencode-go/glm-5.2")
  })
})

async function directory() {
  const value = await mkdtemp(path.join(tmpdir(), "safe-compaction-install-"))
  temporary.push(value)
  return value
}

async function configure(config: string, install: string) {
  return command([process.execPath, path.join(process.cwd(), "scripts/configure.ts")], {
    ...process.env,
    OPENCODE_SAFE_COMPACTION_CONFIG_DIR: config,
    OPENCODE_SAFE_COMPACTION_DIR: install,
    OPENCODE_SAFE_COMPACTION_MODEL: "opencode-go/glm-5.2",
  })
}

async function command(argv: string[], env = process.env, cwd = process.cwd()) {
  const child = Bun.spawn(argv, { cwd, env, stdout: "pipe", stderr: "pipe" })
  const stdout = new Response(child.stdout).text()
  const stderr = new Response(child.stderr).text()
  return {
    exitCode: await child.exited,
    stdout: await stdout,
    stderr: await stderr,
  }
}
