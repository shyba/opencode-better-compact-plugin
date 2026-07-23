import { afterEach, describe, expect, test } from "bun:test"
import { chmod, cp, mkdir, mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"

const temporary: string[] = []

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((item) => rm(item, { recursive: true, force: true })))
})

describe("installer", () => {
  test("preserves JSONC comments and existing plugin entries", async () => {
    const root = await directory()
    const config = path.join(root, "config")
    const install = path.join(root, "install")
    await prepareInstall(install)
    await Bun.write(
      path.join(config, "opencode.jsonc"),
      `{
  // This comment and unrelated settings must survive installation.
  "theme": "system",
  "plugin": [
    "file:///opt/safe-compaction-tools/existing-plugin.ts"
  ]
}
`,
    )
    await chmod(path.join(config, "opencode.jsonc"), 0o644)

    const result = await configure(config, install)
    expect(result.exitCode).toBe(0)
    const text = await Bun.file(path.join(config, "opencode.jsonc")).text()
    const value = Bun.JSONC.parse(text) as { theme: string; plugin: unknown[] }
    expect(text).toContain("This comment and unrelated settings must survive installation.")
    expect(value.theme).toBe("system")
    expect(value.plugin[0]).toBe("file:///opt/safe-compaction-tools/existing-plugin.ts")
    expect(value.plugin[1]).toEqual([
      managedSource(install),
      expect.objectContaining({ model: "opencode-go/glm-5.2", max_summary_bytes: 49_152 }),
    ])
    expect(Bun.JSONC.parse(await Bun.file(path.join(config, "tui.jsonc")).text())).toEqual({
      plugin: [[managedSource(install), { model: "opencode-go/glm-5.2" }]],
    })
    const backups = await Array.fromAsync(new Bun.Glob("*.safe-compaction-backup-*").scan(config))
    expect(backups).toHaveLength(1)
    expect((await stat(path.join(config, "opencode.jsonc"))).mode & 0o777).toBe(0o600)
    expect((await stat(path.join(config, backups[0]!))).mode & 0o777).toBe(0o600)

    const repeat = await configure(config, install)
    expect(repeat.exitCode).toBe(0)
    expect(await Bun.file(path.join(config, "opencode.jsonc")).text()).toBe(text)
    expect((await Array.fromAsync(new Bun.Glob("*.safe-compaction-backup-*").scan(config))).length).toBe(1)
  })

  test("switches an existing installation to selected-model mode without disturbing JSONC", async () => {
    const root = await directory()
    const config = path.join(root, "config")
    const install = path.join(root, "install")
    await prepareInstall(install)
    const file = path.join(config, "opencode.jsonc")
    await Bun.write(
      file,
      `{
  "plugin": [
    [
      ${JSON.stringify(pathToFileURL(managedSource(install)).href)},
      {
        // Keep this option comment.
        "model": "opencode-go/glm-5.2",
        "tail_turns": 7
      }
    ]
  ]
}
`,
    )

    const result = await configure(config, install, "selected")
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("Updated the safe-compaction model to selected")
    const text = await Bun.file(file).text()
    expect(text).toContain("// Keep this option comment.")
    const value = Bun.JSONC.parse(text) as { plugin: [[string, { model: string; tail_turns: number }]] }
    expect(value.plugin[0][0]).toBe(pathToFileURL(managedSource(install)).href)
    expect(value.plugin[0][1]).toEqual({ model: "selected", tail_turns: 7 })
    expect(await Array.fromAsync(new Bun.Glob("*.safe-compaction-backup-*").scan(config))).toHaveLength(1)

    const repeat = await configure(config, install, "opencode-go/glm-5.2", false)
    expect(repeat.exitCode).toBe(0)
    expect(repeat.stdout).toContain("Configuration already contains")
    expect(await Bun.file(file).text()).toBe(text)
    expect(await Array.fromAsync(new Bun.Glob("*.safe-compaction-backup-*").scan(config))).toHaveLength(1)
  })

  test("preserves TUI JSONC while installing and synchronizing the native selector", async () => {
    const root = await directory()
    const config = path.join(root, "config")
    const install = path.join(root, "install")
    await prepareInstall(install)
    const file = path.join(config, "tui.jsonc")
    await Bun.write(
      file,
      `{
  // Keep unrelated TUI settings and plugins.
  "theme": "system",
  "plugin": ["file:///opt/existing-tui-plugin.ts"]
}
`,
    )

    expect((await configure(config, install)).exitCode).toBe(0)
    const initial = await Bun.file(file).text()
    expect(initial).toContain("// Keep unrelated TUI settings and plugins.")
    expect(Bun.JSONC.parse(initial)).toEqual({
      theme: "system",
      plugin: [
        "file:///opt/existing-tui-plugin.ts",
        [managedSource(install), { model: "opencode-go/glm-5.2" }],
      ],
    })

    expect((await configure(config, install, "selected")).exitCode).toBe(0)
    const selected = await Bun.file(file).text()
    expect(selected).toContain("// Keep unrelated TUI settings and plugins.")
    expect(Bun.JSONC.parse(selected)).toEqual({
      theme: "system",
      plugin: [
        "file:///opt/existing-tui-plugin.ts",
        [managedSource(install), { model: "selected" }],
      ],
    })
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

  test.each([
    ["unknown", { model: "opencode-go/glm-5.2", unknown_limit: 1 }, "Unknown opencode-safe-compaction option"],
    ["invalid", { model: "opencode-go/glm-5.2", tail_turns: -1 }, 'Option "tail_turns" must be a non-negative integer'],
  ])("validates every existing tuple option (%s)", async (_, options, message) => {
    const root = await directory()
    const config = path.join(root, "config")
    const install = path.join(root, "install")
    await prepareInstall(install)
    const file = path.join(config, "opencode.jsonc")
    const original = JSON.stringify({ plugin: [[managedSource(install), options]] }, null, 2)
    await Bun.write(file, original)

    const result = await configure(config, install)
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain(message)
    expect(await Bun.file(file).text()).toBe(original)
  })

  test("migrates a verified legacy checkout while preserving tuple options and JSONC comments", async () => {
    const root = await directory()
    const config = path.join(root, "config")
    const install = path.join(root, "managed-install")
    const legacy = path.join(root, "legacy", "safe-compaction")
    await prepareInstall(install)
    await prepareInstall(legacy)
    const file = path.join(config, "opencode.jsonc")
    const previousSource = path.join(legacy, "src/index.ts")
    await Bun.write(
      file,
      `{
  // Preserve this comment and the existing options during migration.
  "theme": "system",
  "plugin": [
    "file:///opt/existing-plugin.ts",
    [
      ${JSON.stringify(previousSource)},
      {
        "model": "opencode-go/glm-5.2",
        "tail_turns": 7,
        "max_ledger_bytes": 16384,
        "max_summary_bytes": 65536
      }
    ]
  ]
}
`,
    )

    const result = await configure(config, install)

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain(`Migrated ${previousSource} to ${managedSource(install)}`)
    const text = await Bun.file(file).text()
    const value = Bun.JSONC.parse(text) as { theme: string; plugin: Array<unknown> }
    expect(text).toContain("Preserve this comment and the existing options during migration.")
    expect(text).not.toContain(previousSource)
    expect(value.theme).toBe("system")
    expect(value.plugin).toEqual([
      "file:///opt/existing-plugin.ts",
      [
        managedSource(install),
        {
          model: "opencode-go/glm-5.2",
          tail_turns: 7,
          max_ledger_bytes: 16_384,
          max_summary_bytes: 65_536,
        },
      ],
    ])
    expect(await Array.fromAsync(new Bun.Glob("*.safe-compaction-backup-*").scan(config))).toHaveLength(1)

    const repeat = await configure(config, install)
    expect(repeat.exitCode).toBe(0)
    expect(repeat.stdout).toContain("Configuration already contains")
    expect(await Bun.file(file).text()).toBe(text)
    expect(await Array.fromAsync(new Bun.Glob("*.safe-compaction-backup-*").scan(config))).toHaveLength(1)
  })

  test("migrates a verified runtime-directory installation", async () => {
    const root = await directory()
    const config = path.join(root, "config")
    const install = path.join(root, "managed-install")
    const previousInstall = path.join(root, "previous", "safe-compaction")
    await prepareInstall(install)
    await prepareInstall(previousInstall)
    const file = path.join(config, "opencode.jsonc")
    const previousSource = managedSource(previousInstall)
    await Bun.write(
      file,
      JSON.stringify({
        plugin: [[previousSource, { model: "selected", tail_turns: 6 }]],
      }, null, 2),
    )

    const result = await configure(config, install, "opencode-go/glm-5.2", false)

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain(`Migrated ${previousSource} to ${managedSource(install)}`)
    expect(Bun.JSONC.parse(await Bun.file(file).text())).toEqual({
      plugin: [[managedSource(install), { model: "selected", tail_turns: 6 }]],
    })
  })

  test("refuses to migrate a path-shaped plugin that does not export the expected identity", async () => {
    const root = await directory()
    const config = path.join(root, "config")
    const install = path.join(root, "managed-install")
    const legacy = path.join(root, "legacy", "safe-compaction")
    await prepareInstall(install)
    await mkdir(path.join(legacy, "src"), { recursive: true })
    await Bun.write(path.join(legacy, "src/index.ts"), 'export default { id: "not-safe-compaction", server() {} }\n')
    const file = path.join(config, "opencode.json")
    const original = JSON.stringify({
      plugin: [[path.join(legacy, "src/index.ts"), { model: "opencode-go/glm-5.2" }]],
    }, null, 2)
    await Bun.write(file, original)

    const result = await configure(config, install)

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain("Could not verify the existing safe-compaction entry")
    expect(await Bun.file(file).text()).toBe(original)
    expect(await Array.fromAsync(new Bun.Glob("*.safe-compaction-backup-*").scan(config))).toEqual([])
  })

  test("rejects duplicate root plugin keys before mutation", async () => {
    const root = await directory()
    const config = path.join(root, "config")
    const install = path.join(root, "install")
    const file = path.join(config, "opencode.jsonc")
    const original = `{
  "plugin": [],
  "theme": "system",
  "plugin": []
}
`
    await Bun.write(file, original)

    const result = await configure(config, install)
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('duplicate root "plugin" keys')
    expect(await Bun.file(file).text()).toBe(original)
  })

  test.each([
    ["broken import", "export default {", "Plugin activation preflight failed"],
    [
      "broken initialization",
      `export default {
  id: "opencode-safe-compaction",
  async server() {
    throw new Error("fixture initialization failed")
  },
}
`,
      "fixture initialization failed",
    ],
  ])("does not mutate configuration after %s", async (_, source, message) => {
    const root = await directory()
    const config = path.join(root, "config")
    const install = path.join(root, "install")
    await mkdir(path.join(install, "src"), { recursive: true })
    await Bun.write(path.join(install, "src/index.ts"), source)
    await cp(path.join(process.cwd(), "runtime"), path.join(install, "runtime"), { recursive: true })

    const result = await configure(config, install)
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain(message)
    expect(await Bun.file(path.join(config, "opencode.jsonc")).exists()).toBe(false)
  })

  test("serializes concurrent configuration changes", async () => {
    const root = await directory()
    const config = path.join(root, "config")
    const install = path.join(root, "install")
    await prepareInstall(install)
    await Bun.write(path.join(config, "opencode.jsonc"), '{\n  "theme": "system"\n}\n')
    const environment = configureEnvironment(config, install)
    const [first, second] = await Promise.all([
      command([process.execPath, path.join(process.cwd(), "scripts/configure.ts")], environment),
      command([process.execPath, path.join(process.cwd(), "scripts/configure.ts")], environment),
    ])

    expect([first.exitCode, second.exitCode]).toEqual([0, 0])
    const value = Bun.JSONC.parse(await Bun.file(path.join(config, "opencode.jsonc")).text()) as { plugin: unknown[] }
    expect(value.plugin).toHaveLength(1)
    expect(await Array.fromAsync(new Bun.Glob("*.safe-compaction-backup-*").scan(config))).toHaveLength(1)
    expect(await Bun.file(path.join(config, ".opencode-safe-compaction.lock")).exists()).toBe(false)
  })

  test("rejects an insecure HTTP repository before cloning", async () => {
    const root = await directory()
    const result = await command(
      ["sh"],
      {
        ...process.env,
        HOME: root,
        OPENCODE_SAFE_COMPACTION_REPO: "http://github.com/example/opencode-safe-compaction.git",
        OPENCODE_SAFE_COMPACTION_DIR: path.join(root, "install"),
        OPENCODE_SAFE_COMPACTION_CONFIG_DIR: path.join(root, "config"),
      },
      process.cwd(),
      await Bun.file(path.join(process.cwd(), "install.sh")).text(),
    )
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain("insecure repository URL is not allowed")
    expect(await Bun.file(path.join(root, "install")).exists()).toBe(false)
  })

  test("does not treat an existing HTTP origin as equivalent to HTTPS", async () => {
    const root = await directory()
    const install = path.join(root, "install")
    expect((await command(["git", "clone", "--quiet", process.cwd(), install])).exitCode).toBe(0)
    expect(
      (await command(["git", "remote", "set-url", "origin", "http://github.com/shyba/opencode-better-compact-plugin.git"], process.env, install)).exitCode,
    ).toBe(0)
    const fakeOpenCode = await openCodeFixture(root, "opencode-origin-check")

    const result = await command(["sh", "install.sh"], {
      ...process.env,
      OPENCODE_SAFE_COMPACTION_REPO: "https://github.com/shyba/opencode-better-compact-plugin.git",
      OPENCODE_SAFE_COMPACTION_DIR: install,
      OPENCODE_SAFE_COMPACTION_CONFIG_DIR: path.join(root, "config"),
      OPENCODE_SAFE_COMPACTION_BUN: process.execPath,
      OPENCODE_SAFE_COMPACTION_OPENCODE: fakeOpenCode,
    })
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain("insecure repository URL is not allowed")
  })

  test("bootstraps a pinned temporary Bun when no standalone executable is installed", async () => {
    const root = await directory()
    const origin = await installerOrigin(root)
    const install = path.join(root, "installed")
    const config = path.join(root, "config")
    const temporaryDirectory = path.join(root, "temporary")
    await mkdir(temporaryDirectory)
    const bootstrap = await bootstrapFixtures(root)
    const opencodeDirectory = path.join(root, ".opencode/bin")
    await mkdir(opencodeDirectory, { recursive: true })
    await openCodeFixture(opencodeDirectory, "opencode")
    const environment = {
      ...process.env,
      HOME: root,
      PATH: `${bootstrap.bin}:/usr/bin:/bin`,
      TMPDIR: temporaryDirectory,
      FIXTURE_BUN: process.execPath,
      BOOTSTRAP_LOG: bootstrap.log,
      OPENCODE_SAFE_COMPACTION_REPO: origin,
      OPENCODE_SAFE_COMPACTION_DIR: install,
      OPENCODE_SAFE_COMPACTION_CONFIG_DIR: config,
    }
    delete environment.OPENCODE_SAFE_COMPACTION_BUN
    delete environment.OPENCODE_SAFE_COMPACTION_OPENCODE

    const result = await command(["sh", "install.sh"], environment)

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain(`OpenCode not found on PATH; using ${path.join(opencodeDirectory, "opencode")}`)
    expect(result.stdout).toContain("Bun not found; downloading temporary Bun 1.3.14 for Linux/x86_64")
    expect(await Bun.file(bootstrap.log).text()).toBe(
      "https://github.com/oven-sh/bun/releases/download/bun-v1.3.14/bun-linux-x64-baseline.zip\n",
    )
    expect(await Bun.file(path.join(install, "src/index.ts")).exists()).toBe(true)
    expect(await Array.fromAsync(new Bun.Glob("opencode-safe-compaction.*").scan(temporaryDirectory))).toEqual([])
  })

  test("keeps an explicit missing OpenCode override authoritative", async () => {
    const root = await directory()
    const fallback = path.join(root, ".opencode/bin")
    await mkdir(fallback, { recursive: true })
    await openCodeFixture(fallback, "opencode")

    const result = await command(["sh", "install.sh"], {
      ...process.env,
      HOME: root,
      OPENCODE_SAFE_COMPACTION_DIR: path.join(root, "install"),
      OPENCODE_SAFE_COMPACTION_CONFIG_DIR: path.join(root, "config"),
      OPENCODE_SAFE_COMPACTION_OPENCODE: path.join(root, "explicit-missing-opencode"),
    })

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain(`executable not found: ${path.join(root, "explicit-missing-opencode")}`)
  })

  test("refuses an unverified temporary Bun archive before cloning or editing configuration", async () => {
    const root = await directory()
    const install = path.join(root, "installed")
    const config = path.join(root, "config")
    const bootstrap = await bootstrapFixtures(root, "0".repeat(64))
    const environment = {
      ...process.env,
      HOME: root,
      PATH: `${bootstrap.bin}:/usr/bin:/bin`,
      FIXTURE_BUN: process.execPath,
      BOOTSTRAP_LOG: bootstrap.log,
      OPENCODE_SAFE_COMPACTION_REPO: path.join(root, "unused-origin"),
      OPENCODE_SAFE_COMPACTION_DIR: install,
      OPENCODE_SAFE_COMPACTION_CONFIG_DIR: config,
      OPENCODE_SAFE_COMPACTION_OPENCODE: await openCodeFixture(root, "opencode-bootstrap-checksum"),
    }
    delete environment.OPENCODE_SAFE_COMPACTION_BUN

    const result = await command(["sh", "install.sh"], environment)

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain("temporary Bun download failed SHA-256 verification")
    expect(await Bun.file(install).exists()).toBe(false)
    expect(await Bun.file(config).exists()).toBe(false)
  })

  test("rolls back configuration and a new checkout when OpenCode debug fails", async () => {
    const root = await directory()
    const origin = await installerOrigin(root)
    const install = path.join(root, "installed")
    const config = path.join(root, "config")
    const file = path.join(config, "opencode.jsonc")
    const original = '{\n  "theme": "system"\n}\n'
    await Bun.write(file, original)
    await chmod(file, 0o644)
    const fakeOpenCode = path.join(root, "opencode-failing")
    await Bun.write(
      fakeOpenCode,
      `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf '1.18.4\\n'
  exit 0
fi
if [ "$1" = "debug" ] && [ "$2" = "config" ]; then
  exit 41
fi
exit 1
`,
    )
    await chmod(fakeOpenCode, 0o755)

    const result = await command(["sh", "install.sh"], {
      ...process.env,
      OPENCODE_SAFE_COMPACTION_REPO: origin,
      OPENCODE_SAFE_COMPACTION_DIR: install,
      OPENCODE_SAFE_COMPACTION_CONFIG_DIR: config,
      OPENCODE_SAFE_COMPACTION_BUN: process.execPath,
      OPENCODE_SAFE_COMPACTION_OPENCODE: fakeOpenCode,
    })
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain("OpenCode could not load the isolated plugin configuration")
    expect(await Bun.file(file).text()).toBe(original)
    expect((await stat(file)).mode & 0o777).toBe(0o644)
    expect(await Bun.file(path.join(config, "tui.jsonc")).exists()).toBe(false)
    expect(await Bun.file(install).exists()).toBe(false)
    expect(await Array.fromAsync(new Bun.Glob("*.safe-compaction-backup-*").scan(config))).toHaveLength(0)
  })

  test("rolls back a legacy-path migration when OpenCode verification fails", async () => {
    const root = await directory()
    const origin = await installerOrigin(root)
    const install = path.join(root, "installed")
    const legacy = path.join(root, "legacy", "safe-compaction")
    const config = path.join(root, "config")
    const file = path.join(config, "opencode.json")
    await prepareInstall(legacy)
    const original = JSON.stringify({
      theme: "system",
      plugin: [[path.join(legacy, "src/index.ts"), { model: "opencode-go/glm-5.2", tail_turns: 6 }]],
    }, null, 2)
    await Bun.write(file, original)
    const fakeOpenCode = path.join(root, "opencode-migration-failing")
    await executable(
      fakeOpenCode,
      `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf '1.18.4\\n'
  exit 0
fi
if [ "$1" = "debug" ] && [ "$2" = "config" ]; then
  exit 41
fi
exit 1
`,
    )

    const result = await command(["sh", "install.sh"], {
      ...process.env,
      OPENCODE_SAFE_COMPACTION_REPO: origin,
      OPENCODE_SAFE_COMPACTION_DIR: install,
      OPENCODE_SAFE_COMPACTION_CONFIG_DIR: config,
      OPENCODE_SAFE_COMPACTION_BUN: process.execPath,
      OPENCODE_SAFE_COMPACTION_OPENCODE: fakeOpenCode,
    })

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain("OpenCode could not load the isolated plugin configuration")
    expect(await Bun.file(file).text()).toBe(original)
    expect(await Bun.file(path.join(config, "tui.jsonc")).exists()).toBe(false)
    expect(await Bun.file(install).exists()).toBe(false)
    expect(await Bun.file(path.join(legacy, "src/index.ts")).exists()).toBe(true)
    expect(await Array.fromAsync(new Bun.Glob("*.safe-compaction-backup-*").scan(config))).toHaveLength(0)
  })

  test("rolls back when OpenCode reports the tuple without activating the plugin hook", async () => {
    const root = await directory()
    const origin = await installerOrigin(root)
    const install = path.join(root, "installed")
    const config = path.join(root, "config")
    const file = path.join(config, "opencode.jsonc")
    const original = '{\n  "theme": "system"\n}\n'
    await Bun.write(file, original)
    const fakeOpenCode = path.join(root, "opencode-inactive")
    await Bun.write(
      fakeOpenCode,
      `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf '1.18.4\\n'
  exit 0
fi
if [ "$1" = "debug" ] && [ "$2" = "config" ]; then
  sed -n '1,240p' "$OPENCODE_CONFIG_DIR/opencode.jsonc"
  exit 0
fi
exit 1
`,
    )
    await chmod(fakeOpenCode, 0o755)

    const result = await command(["sh", "install.sh"], {
      ...process.env,
      OPENCODE_SAFE_COMPACTION_REPO: origin,
      OPENCODE_SAFE_COMPACTION_DIR: install,
      OPENCODE_SAFE_COMPACTION_CONFIG_DIR: config,
      OPENCODE_SAFE_COMPACTION_BUN: process.execPath,
      OPENCODE_SAFE_COMPACTION_OPENCODE: fakeOpenCode,
    })

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain("did not activate the plugin config hook")
    expect(await Bun.file(file).text()).toBe(original)
    expect(await Bun.file(install).exists()).toBe(false)
  })

  test("preserves the checkout when rollback refuses a concurrent configuration edit", async () => {
    const root = await directory()
    const origin = await installerOrigin(root)
    const install = path.join(root, "installed")
    const config = path.join(root, "config")
    const fakeOpenCode = path.join(root, "opencode-concurrent-edit")
    await Bun.write(
      fakeOpenCode,
      `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf '1.18.4\\n'
  exit 0
fi
if [ "$1" = "debug" ] && [ "$2" = "config" ]; then
  if [ "$OPENCODE_SAFE_COMPACTION_VERIFY_PHASE" = "target" ]; then
    printf '\\n ' >> "$TARGET_CONFIG_DIR/opencode.jsonc"
    exit 41
  fi
  printf '{"plugin":[["%s/runtime",{"model":"%s"}]],"agent":{"compaction":{"model":"%s","temperature":0}},"compaction":{"auto":true,"prune":false,"tail_turns":4,"preserve_recent_tokens":16000,"reserved":32000}}\\n' \
    "$OPENCODE_SAFE_COMPACTION_DIR" "$OPENCODE_SAFE_COMPACTION_MODEL" "$OPENCODE_SAFE_COMPACTION_MODEL"
  exit 0
fi
exit 1
`,
    )
    await chmod(fakeOpenCode, 0o755)

    const result = await command(["sh", "install.sh"], {
      ...process.env,
      OPENCODE_SAFE_COMPACTION_REPO: origin,
      OPENCODE_SAFE_COMPACTION_DIR: install,
      OPENCODE_SAFE_COMPACTION_CONFIG_DIR: config,
      OPENCODE_SAFE_COMPACTION_BUN: process.execPath,
      OPENCODE_SAFE_COMPACTION_OPENCODE: fakeOpenCode,
      TARGET_CONFIG_DIR: config,
    })

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain("Refusing to overwrite a concurrently modified configuration")
    expect(result.stdout).toContain("preserved the checkout")
    expect(await Bun.file(path.join(install, "src/index.ts")).exists()).toBe(true)
    expect((await Bun.file(path.join(config, "opencode.jsonc")).text()).endsWith("\n ")).toBe(true)
  })

  test("rolls an updated checkout back to its prior commit after activation failure", async () => {
    const root = await directory()
    const origin = await installerOrigin(root)
    const install = path.join(root, "installed")
    const config = path.join(root, "config")
    const fakeOpenCode = await openCodeFixture(root, "opencode-conditional")
    const environment = {
      ...process.env,
      OPENCODE_SAFE_COMPACTION_REPO: origin,
      OPENCODE_SAFE_COMPACTION_DIR: install,
      OPENCODE_SAFE_COMPACTION_CONFIG_DIR: config,
      OPENCODE_SAFE_COMPACTION_BUN: process.execPath,
      OPENCODE_SAFE_COMPACTION_OPENCODE: fakeOpenCode,
    }
    expect((await command(["sh", "install.sh"], environment)).exitCode).toBe(0)
    const prior = (await command(["git", "rev-parse", "HEAD"], process.env, install)).stdout.trim()
    const originalConfig = await Bun.file(path.join(config, "opencode.jsonc")).text()

    await Bun.write(path.join(origin, "ROLLBACK-FIXTURE"), "must disappear\n")
    expect((await command(["git", "add", "ROLLBACK-FIXTURE"], process.env, origin)).exitCode).toBe(0)
    expect(
      (
        await command(
          ["git", "-c", "user.name=Installer Test", "-c", "user.email=installer@example.invalid", "commit", "-m", "rollback fixture"],
          process.env,
          origin,
        )
      ).exitCode,
    ).toBe(0)

    const failed = await command(["sh", "install.sh"], { ...environment, FAIL_DEBUG: "1" })
    expect(failed.exitCode).not.toBe(0)
    expect((await command(["git", "rev-parse", "HEAD"], process.env, install)).stdout.trim()).toBe(prior)
    expect(await Bun.file(path.join(install, "ROLLBACK-FIXTURE")).exists()).toBe(false)
    expect(await Bun.file(path.join(config, "opencode.jsonc")).text()).toBe(originalConfig)
  })

  test("rolls back when target plugins override safe compaction thresholds", async () => {
    const root = await directory()
    const origin = await installerOrigin(root)
    const install = path.join(root, "installed")
    const config = path.join(root, "config")
    const file = path.join(config, "opencode.jsonc")
    const original = '{\n  "theme": "system"\n}\n'
    await Bun.write(file, original)
    const result = await command(["sh", "install.sh"], {
      ...process.env,
      BAD_TARGET_THRESHOLDS: "1",
      OPENCODE_SAFE_COMPACTION_REPO: origin,
      OPENCODE_SAFE_COMPACTION_DIR: install,
      OPENCODE_SAFE_COMPACTION_CONFIG_DIR: config,
      OPENCODE_SAFE_COMPACTION_BUN: process.execPath,
      OPENCODE_SAFE_COMPACTION_OPENCODE: await openCodeFixture(root, "opencode-threshold-override"),
    })

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain("did not preserve the safe-compaction thresholds")
    expect(await Bun.file(file).text()).toBe(original)
    expect(await Bun.file(install).exists()).toBe(false)
  })

  test("loads a target config.json through OpenCode's global configuration path", async () => {
    const root = await directory()
    const origin = await installerOrigin(root)
    const install = path.join(root, "installed")
    const config = path.join(root, "global-opencode")
    const file = path.join(config, "config.json")
    await Bun.write(file, '{\n  "theme": "system"\n}\n')
    const result = await command(["sh", "install.sh"], {
      ...process.env,
      OPENCODE_SAFE_COMPACTION_REPO: origin,
      OPENCODE_SAFE_COMPACTION_DIR: install,
      OPENCODE_SAFE_COMPACTION_CONFIG_DIR: config,
      OPENCODE_SAFE_COMPACTION_BUN: process.execPath,
      OPENCODE_SAFE_COMPACTION_OPENCODE: await openCodeFixture(root, "opencode-config-json"),
    })

    expect(result.exitCode).toBe(0)
    const value = JSON.parse(await Bun.file(file).text()) as { theme: string; plugin: unknown[] }
    expect(value.theme).toBe("system")
    expect(value.plugin).toHaveLength(1)
  })

  test("derives target expectations from the merged global configuration", async () => {
    const root = await directory()
    const origin = await installerOrigin(root)
    const install = path.join(root, "installed")
    const config = path.join(root, "global-opencode")
    await Bun.write(
      path.join(config, "config.json"),
      JSON.stringify({
        compaction: {
          auto: false,
          tail_turns: 7,
          preserve_recent_tokens: 17_000,
          reserved: 34_000,
        },
      }),
    )
    await Bun.write(path.join(config, "opencode.json"), JSON.stringify({ compaction: { prune: true, tail_turns: 8 } }))
    await Bun.write(
      path.join(config, "opencode.jsonc"),
      JSON.stringify({ plugin: [[managedSource(install), { model: "opencode-go/glm-5.2" }]] }),
    )

    const result = await command(["sh", "install.sh"], {
      ...process.env,
      TARGET_MERGED_SETTINGS: "1",
      OPENCODE_SAFE_COMPACTION_REPO: origin,
      OPENCODE_SAFE_COMPACTION_DIR: install,
      OPENCODE_SAFE_COMPACTION_CONFIG_DIR: config,
      OPENCODE_SAFE_COMPACTION_BUN: process.execPath,
      OPENCODE_SAFE_COMPACTION_OPENCODE: await openCodeFixture(root, "opencode-merged-settings"),
    })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("Configuration already contains")
  })

  test("accepts continuation settings intentionally inherited from an earlier plugin hook", async () => {
    const root = await directory()
    const origin = await installerOrigin(root)
    const install = path.join(root, "installed")
    const config = path.join(root, "config")
    await Bun.write(path.join(config, "opencode.jsonc"), JSON.stringify({ plugin: ["file:///fixture-earlier-plugin.ts"] }))
    const result = await command(["sh", "install.sh"], {
      ...process.env,
      TARGET_EARLIER_PLUGIN_SETTINGS: "1",
      OPENCODE_SAFE_COMPACTION_REPO: origin,
      OPENCODE_SAFE_COMPACTION_DIR: install,
      OPENCODE_SAFE_COMPACTION_CONFIG_DIR: config,
      OPENCODE_SAFE_COMPACTION_BUN: process.execPath,
      OPENCODE_SAFE_COMPACTION_OPENCODE: await openCodeFixture(root, "opencode-earlier-hook"),
    })

    expect(result.exitCode).toBe(0)
    const value = Bun.JSONC.parse(await Bun.file(path.join(config, "opencode.jsonc")).text()) as { plugin: unknown[] }
    expect(value.plugin).toHaveLength(2)
  })

  test("serializes the full checkout and configuration transaction", async () => {
    const root = await directory()
    const origin = await installerOrigin(root)
    const install = path.join(root, "installed")
    const config = path.join(root, "config")
    const fakeOpenCode = await openCodeFixture(root, "opencode-concurrent")
    const environment = {
      ...process.env,
      OPENCODE_SAFE_COMPACTION_REPO: origin,
      OPENCODE_SAFE_COMPACTION_DIR: install,
      OPENCODE_SAFE_COMPACTION_CONFIG_DIR: config,
      OPENCODE_SAFE_COMPACTION_BUN: process.execPath,
      OPENCODE_SAFE_COMPACTION_OPENCODE: fakeOpenCode,
    }

    const results = await Promise.all([
      command(["sh", "install.sh"], environment),
      command(["sh", "install.sh"], environment),
    ])

    expect(results.map((result) => result.exitCode)).toEqual([0, 0])
    const value = Bun.JSONC.parse(await Bun.file(path.join(config, "opencode.jsonc")).text()) as { plugin: unknown[] }
    expect(value.plugin).toHaveLength(1)
    expect(await Bun.file(path.join(install, "src/index.ts")).exists()).toBe(true)
    expect(await Bun.file(path.join(config, ".opencode-safe-compaction-install.lock")).exists()).toBe(false)
  })

  test("serializes a shared checkout across different configuration directories", async () => {
    const root = await directory()
    const origin = await installerOrigin(root)
    const install = path.join(root, "installed")
    const firstConfig = path.join(root, "config-a")
    const secondConfig = path.join(root, "config-b")
    const fakeOpenCode = await openCodeFixture(root, "opencode-shared-checkout")
    const environment = {
      ...process.env,
      OPENCODE_SAFE_COMPACTION_REPO: origin,
      OPENCODE_SAFE_COMPACTION_DIR: install,
      OPENCODE_SAFE_COMPACTION_BUN: process.execPath,
      OPENCODE_SAFE_COMPACTION_OPENCODE: fakeOpenCode,
    }

    const results = await Promise.all([
      command(["sh", "install.sh"], { ...environment, OPENCODE_SAFE_COMPACTION_CONFIG_DIR: firstConfig }),
      command(["sh", "install.sh"], { ...environment, OPENCODE_SAFE_COMPACTION_CONFIG_DIR: secondConfig }),
    ])

    expect(results.map((result) => result.exitCode)).toEqual([0, 0])
    for (const config of [firstConfig, secondConfig]) {
      const value = Bun.JSONC.parse(await Bun.file(path.join(config, "opencode.jsonc")).text()) as { plugin: unknown[] }
      expect(value.plugin).toHaveLength(1)
    }
    expect(await Bun.file(path.join(root, ".opencode-safe-compaction-checkout.lock")).exists()).toBe(false)
  })

  test("installs an exact commit in detached mode when given a pinned ref", async () => {
    const root = await directory()
    const origin = await installerOrigin(root)
    const commit = (await command(["git", "rev-parse", "HEAD"], process.env, origin)).stdout.trim()
    const install = path.join(root, "installed")
    const config = path.join(root, "config")
    const fakeOpenCode = await openCodeFixture(root, "opencode-pinned")
    const hostileHome = path.join(root, "hostile-home")
    const hostileConfig = path.join(root, "hostile-config.jsonc")
    const verificationLog = path.join(root, "verification-directories.log")
    await mkdir(path.join(hostileHome, ".opencode"), { recursive: true })
    await Bun.write(path.join(hostileHome, ".opencode/opencode.jsonc"), '{"plugin":["hostile-home-plugin"]}')
    await Bun.write(hostileConfig, '{"plugin":["hostile-config-plugin"]}')

    const result = await command(["sh", "install.sh"], {
      ...process.env,
      HOME: hostileHome,
      OPENCODE_CONFIG: hostileConfig,
      OPENCODE_CONFIG_CONTENT: '{"plugin":["hostile-inline-plugin"]}',
      OPENCODE_PURE: "1",
      OPENCODE_SAFE_COMPACTION_REPO: origin,
      OPENCODE_SAFE_COMPACTION_REF: commit,
      OPENCODE_SAFE_COMPACTION_DIR: install,
      OPENCODE_SAFE_COMPACTION_CONFIG_DIR: config,
      OPENCODE_SAFE_COMPACTION_BUN: process.execPath,
      OPENCODE_SAFE_COMPACTION_OPENCODE: fakeOpenCode,
      VERIFY_LOG: verificationLog,
    })

    expect(result.exitCode).toBe(0)
    expect((await command(["git", "rev-parse", "HEAD"], process.env, install)).stdout.trim()).toBe(commit)
    expect((await command(["git", "symbolic-ref", "--quiet", "HEAD"], process.env, install)).exitCode).not.toBe(0)
    const verificationEnvironments = (await Bun.file(verificationLog).text()).trim().split("\n")
    expect(verificationEnvironments).toHaveLength(2)
    expect(verificationEnvironments[0]).toContain("isolated|")
    expect(verificationEnvironments[0]).toContain("/verify-config|")
    expect(verificationEnvironments[1]).toContain("target||")
    expect(verificationEnvironments[1]).toEndWith("/target-xdg")
  })

  test("installs from a Git checkout and verifies through OpenCode", async () => {
    const root = await directory()
    const origin = path.join(root, "origin")
    const install = path.join(root, "installed")
    const config = path.join(root, "config")
    const fakeOpenCode = path.join(root, "opencode")
    expect((await command(["git", "clone", "--quiet", process.cwd(), origin])).exitCode).toBe(0)
    await rm(path.join(origin, "src"), { recursive: true, force: true })
    await cp(path.join(process.cwd(), "src"), path.join(origin, "src"), { recursive: true })
    await rm(path.join(origin, "runtime"), { recursive: true, force: true })
    await cp(path.join(process.cwd(), "runtime"), path.join(origin, "runtime"), { recursive: true })
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
          ["git", "add", "install.sh", "scripts/configure.ts", "src", "runtime", "INSTALLER-FIXTURE"],
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
  agent_model=
  if [ "$OPENCODE_SAFE_COMPACTION_MODEL" != "selected" ]; then
    agent_model='"model":"'"$OPENCODE_SAFE_COMPACTION_MODEL"'",'
  fi
  printf '{"plugin":[["%s/runtime",{"model":"%s"}]],"agent":{"compaction":{%s"temperature":0}},"compaction":{"auto":true,"prune":false,"tail_turns":4,"preserve_recent_tokens":16000,"reserved":32000}}\n' \
    "$OPENCODE_SAFE_COMPACTION_DIR" "$OPENCODE_SAFE_COMPACTION_MODEL" "$agent_model"
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
    expect(value.plugin[0]?.[0]).toBe(managedSource(install))
    expect(value.plugin[0]?.[1].model).toBe("opencode-go/glm-5.2")
    expect(Bun.JSONC.parse(await Bun.file(path.join(config, "tui.jsonc")).text())).toEqual({
      plugin: [[managedSource(install), { model: "opencode-go/glm-5.2" }]],
    })

    const selected = await configure(config, install, "selected")
    expect(selected.exitCode).toBe(0)
    const selectedValue = Bun.JSONC.parse(await Bun.file(path.join(config, "opencode.jsonc")).text()) as {
      plugin: [[string, { model: string }]]
    }
    expect(selectedValue.plugin[0]?.[1].model).toBe("selected")
    expect(Bun.JSONC.parse(await Bun.file(path.join(config, "tui.jsonc")).text())).toEqual({
      plugin: [[managedSource(install), { model: "selected" }]],
    })

    const third = await command(["sh", "install.sh"], environment)
    expect(third.exitCode).toBe(0)
    expect(third.stdout).toContain("Configuration already contains")
    const preservedValue = Bun.JSONC.parse(await Bun.file(path.join(config, "opencode.jsonc")).text()) as {
      plugin: [[string, { model: string }]]
    }
    expect(preservedValue.plugin[0]?.[1].model).toBe("selected")
  })
})

async function directory() {
  const value = await mkdtemp(path.join(tmpdir(), "safe-compaction-install-"))
  temporary.push(value)
  return value
}

function managedSource(install: string) {
  return path.join(install, "runtime")
}

async function configure(
  config: string,
  install: string,
  model = "opencode-go/glm-5.2",
  modelExplicit = true,
) {
  return command(
    [process.execPath, path.join(process.cwd(), "scripts/configure.ts")],
    configureEnvironment(config, install, model, modelExplicit),
  )
}

function configureEnvironment(
  config: string,
  install: string,
  model = "opencode-go/glm-5.2",
  modelExplicit = true,
) {
  return {
    ...process.env,
    OPENCODE_SAFE_COMPACTION_CONFIG_DIR: config,
    OPENCODE_SAFE_COMPACTION_DIR: install,
    OPENCODE_SAFE_COMPACTION_MODEL: model,
    OPENCODE_SAFE_COMPACTION_MODEL_EXPLICIT: modelExplicit ? "1" : "0",
  }
}

async function prepareInstall(install: string) {
  await mkdir(install, { recursive: true })
  await cp(path.join(process.cwd(), "src"), path.join(install, "src"), { recursive: true })
  await cp(path.join(process.cwd(), "runtime"), path.join(install, "runtime"), { recursive: true })
}

async function installerOrigin(root: string) {
  const origin = path.join(root, `origin-${crypto.randomUUID()}`)
  expect((await command(["git", "clone", "--quiet", process.cwd(), origin])).exitCode).toBe(0)
  await rm(path.join(origin, "src"), { recursive: true, force: true })
  await cp(path.join(process.cwd(), "src"), path.join(origin, "src"), { recursive: true })
  await rm(path.join(origin, "runtime"), { recursive: true, force: true })
  await cp(path.join(process.cwd(), "runtime"), path.join(origin, "runtime"), { recursive: true })
  await mkdir(path.join(origin, "scripts"), { recursive: true })
  await Bun.write(path.join(origin, "install.sh"), Bun.file(path.join(process.cwd(), "install.sh")))
  await Bun.write(path.join(origin, "scripts/configure.ts"), Bun.file(path.join(process.cwd(), "scripts/configure.ts")))
  expect(
    (await command(["git", "add", "install.sh", "scripts/configure.ts", "src", "runtime"], process.env, origin))
      .exitCode,
  ).toBe(0)
  const changed = await command(["git", "diff", "--cached", "--quiet"], process.env, origin)
  if (changed.exitCode !== 0) {
    expect(
      (
        await command(
          ["git", "-c", "user.name=Installer Test", "-c", "user.email=installer@example.invalid", "commit", "-m", "installer fixture"],
          process.env,
          origin,
        )
      ).exitCode,
    ).toBe(0)
  }
  return origin
}

async function openCodeFixture(root: string, name: string) {
  const file = path.join(root, name)
  await Bun.write(
    file,
    `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf '1.18.4\\n'
  exit 0
fi
if [ "$1" = "debug" ] && [ "$2" = "config" ]; then
  if [ "\${FAIL_DEBUG:-}" = "1" ]; then
    exit 42
  fi
  for directory in "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_CACHE_HOME" "$XDG_STATE_HOME"; do
    [ -d "$directory" ] || exit 43
  done
  [ "$OPENCODE_DISABLE_DEFAULT_PLUGINS" = "1" ] || exit 44
  [ -d "$HOME" ] && [ ! -e "$HOME/.opencode/opencode.jsonc" ] || exit 45
  [ -z "$OPENCODE_CONFIG" ] && [ -z "$OPENCODE_CONFIG_CONTENT" ] || exit 46
  [ "$OPENCODE_PURE" = "0" ] || exit 47
  case "$OPENCODE_SAFE_COMPACTION_VERIFY_PHASE" in
    isolated)
      [ -n "$OPENCODE_CONFIG_DIR" ] && [ -f "$OPENCODE_CONFIG_DIR/opencode.jsonc" ] || exit 48
      ;;
    target)
      [ -z "$OPENCODE_CONFIG_DIR" ] && [ -L "$XDG_CONFIG_HOME/opencode" ] || exit 49
      [ -f "$XDG_CONFIG_HOME/opencode/opencode.jsonc" ] || [ -f "$XDG_CONFIG_HOME/opencode/opencode.json" ] || [ -f "$XDG_CONFIG_HOME/opencode/config.json" ] || exit 50
      ;;
    *) exit 51 ;;
  esac
  if [ -n "\${VERIFY_LOG:-}" ]; then
    printf '%s|%s|%s\\n' "$OPENCODE_SAFE_COMPACTION_VERIFY_PHASE" "$OPENCODE_CONFIG_DIR" "$XDG_CONFIG_HOME" >> "$VERIFY_LOG"
  fi
  auto=true
  prune=false
  tail_turns=4
  preserve_recent_tokens=16000
  reserved=32000
  if [ "$OPENCODE_SAFE_COMPACTION_VERIFY_PHASE" = "target" ] && [ "\${TARGET_MERGED_SETTINGS:-}" = "1" ]; then
    auto=false
    prune=true
    tail_turns=8
    preserve_recent_tokens=17000
    reserved=34000
  fi
  if [ "$OPENCODE_SAFE_COMPACTION_VERIFY_PHASE" = "target" ] && [ "\${TARGET_EARLIER_PLUGIN_SETTINGS:-}" = "1" ]; then
    auto=false
    prune=true
  fi
  if [ "$OPENCODE_SAFE_COMPACTION_VERIFY_PHASE" = "target" ] && [ "\${BAD_TARGET_THRESHOLDS:-}" = "1" ]; then
    tail_turns=5
  fi
  agent_model=
  if [ "$OPENCODE_SAFE_COMPACTION_MODEL" != "selected" ]; then
    agent_model='"model":"'"$OPENCODE_SAFE_COMPACTION_MODEL"'",'
  fi
  printf '{"plugin":[["%s/runtime",{"model":"%s"}]],"agent":{"compaction":{%s"temperature":0}},"compaction":{"auto":%s,"prune":%s,"tail_turns":%s,"preserve_recent_tokens":%s,"reserved":%s}}\n' \
    "$OPENCODE_SAFE_COMPACTION_DIR" "$OPENCODE_SAFE_COMPACTION_MODEL" "$agent_model" \
    "$auto" "$prune" "$tail_turns" "$preserve_recent_tokens" "$reserved"
  exit 0
fi
exit 1
`,
  )
  await chmod(file, 0o755)
  return file
}

async function bootstrapFixtures(
  root: string,
  digest = "a063908ae08b7852ca10939bbdc6ceed3ddabce8fb9402dce83d65d73b36e6c7",
) {
  const bin = path.join(root, `bootstrap-bin-${crypto.randomUUID()}`)
  const log = path.join(root, `bootstrap-${crypto.randomUUID()}.log`)
  await mkdir(bin)
  await executable(
    path.join(bin, "uname"),
    `#!/bin/sh
case "$1" in
  -s) printf 'Linux\\n' ;;
  -m) printf 'x86_64\\n' ;;
  *) exit 1 ;;
esac
`,
  )
  await executable(
    path.join(bin, "ldd"),
    `#!/bin/sh
printf 'ldd (GNU libc) 2.39\\n'
`,
  )
  await executable(
    path.join(bin, "curl"),
    `#!/bin/sh
output=
url=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output) output=$2; shift 2 ;;
    https://*) url=$1; shift ;;
    *) shift ;;
  esac
done
[ -n "$output" ] && [ -n "$url" ] || exit 2
printf 'fixture archive' > "$output"
printf '%s\\n' "$url" > "$BOOTSTRAP_LOG"
`,
  )
  await executable(
    path.join(bin, "sha256sum"),
    `#!/bin/sh
printf '${digest}  %s\\n' "$1"
`,
  )
  await executable(
    path.join(bin, "unzip"),
    `#!/bin/sh
destination=
while [ "$#" -gt 0 ]; do
  case "$1" in
    -d) destination=$2; shift 2 ;;
    *) shift ;;
  esac
done
[ -n "$destination" ] || exit 2
mkdir -p "$destination/bun-linux-x64-baseline"
cp "$FIXTURE_BUN" "$destination/bun-linux-x64-baseline/bun"
`,
  )
  return { bin, log }
}

async function executable(file: string, text: string) {
  await Bun.write(file, text)
  await chmod(file, 0o755)
}

async function command(argv: string[], env = process.env, cwd = process.cwd(), input?: string) {
  const child = Bun.spawn(argv, {
    cwd,
    env,
    ...(input === undefined ? {} : { stdin: new Blob([input]) }),
    stdout: "pipe",
    stderr: "pipe",
  })
  const stdout = new Response(child.stdout).text()
  const stderr = new Response(child.stderr).text()
  return {
    exitCode: await child.exited,
    stdout: await stdout,
    stderr: await stderr,
  }
}
