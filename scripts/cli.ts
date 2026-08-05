#!/usr/bin/env bun
import { access, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import path from "node:path"
import { configPaths, loadConfig } from "../src/config.js"
import { discoverOpenCodeV1, inspectOpenCodeV1 } from "../src/opencode-v1.js"
import { ensureRemoteSource, openPostgres, readRemoteFence, uploadFenced } from "../src/postgres.js"
import { openSyncState } from "../src/sync-state.js"

const installDir = path.resolve(process.env.OPENCODE_SAFE_COMPACTION_DIR ?? path.join(process.env.HOME ?? ".", ".local/share/opencode/plugins/safe-compaction"))
const configDir = path.resolve(process.env.OPENCODE_SAFE_COMPACTION_CONFIG_DIR ?? process.env.OPENCODE_CONFIG_DIR ?? path.join(process.env.XDG_CONFIG_HOME ?? path.join(process.env.HOME ?? ".", ".config"), "opencode"))
const databasePath = path.resolve(process.env.OPENCODE_DB ?? path.join(process.env.XDG_DATA_HOME ?? path.join(process.env.HOME ?? ".", ".local/share"), "opencode", "opencode.db"))
const paths = configPaths()

const command = process.argv[2] ?? "help"
if (command === "help" || command === "--help" || command === "-h") {
  printHelp()
  process.exit(0)
}
if (command === "update" || command === "install") {
  process.exit(await update())
}
if (command === "doctor") {
  process.exit(await doctor())
}
if (command === "sync") {
  const action = process.argv[3]
  if (action === "run") process.exit(await syncRun(process.argv[4] === "--once"))
  if (action === "status") process.exit(await syncStatus())
  if (action === "install") process.exit(await syncInstall())
  if (action === "uninstall") process.exit(await syncUninstall())
  console.error("Usage: better-compact sync run [--once] | status | install | uninstall")
  process.exit(2)
}
console.error(`Unknown command: ${command}`)
printHelp()
process.exit(2)

function printHelp() {
  console.log(`better-compact - OpenCode safe-compaction maintenance

Usage:
  better-compact install  Activate the plugin using the selected installation mode
  better-compact update   Update the managed checkout and verify configuration
  better-compact doctor   Check installation, OpenCode, configuration, and SQLite access
  better-compact sync run [--once] Discover sources and deliver redacted records
  better-compact sync status Show local outbox status
  better-compact sync install|uninstall Manage a systemd user service
  better-compact help     Show this help

Environment overrides:
  OPENCODE_SAFE_COMPACTION_DIR
  OPENCODE_SAFE_COMPACTION_CONFIG_DIR
  OPENCODE_SAFE_COMPACTION_OPENCODE
  OPENCODE_SAFE_COMPACTION_BUN
  OPENCODE_DB
  BETTER_COMPACT_CONFIG
  BETTER_COMPACT_STATE`)
}

async function update() {
  const mode = await installationMode()
  if (mode !== "git") {
    console.error(`${mode} execution is not self-updating; use the package manager to upgrade, then run better-compact install from a stable package location`)
    return 2
  }
  await access(path.join(installDir, "install.sh"))
  const result = await run("sh", [path.join(installDir, "install.sh")], process.env)
  return result
}

async function installationMode() {
  if (await exists(path.join(installDir, ".git"))) return "git"
  const executable = process.argv[1] ?? ""
  if (process.env.npm_config_user_agent?.includes("npx") || executable.includes("/.npm/_npx/")) return "npx"
  if (executable.includes("node_modules")) return "npm"
  return "package"
}

async function doctor() {
  const checks: Array<[string, boolean, string]> = []
  const config = await loadConfig(paths)
  checks.push(["managed checkout", await exists(path.join(installDir, ".git")), installDir])
  checks.push(["better-compact config", await exists(paths.config), paths.config])
  checks.push(["better-compact state parent", await exists(path.dirname(paths.state)), path.dirname(paths.state)])
  checks.push(["configuration directory", await exists(configDir), configDir])
  checks.push(["server configuration", await configured("opencode.json") || await configured("opencode.jsonc"), configDir])
  checks.push(["TUI configuration", await configured("tui.json") || await configured("tui.jsonc"), configDir])
  checks.push(["SQLite database", await exists(databasePath), databasePath])
  checks.push(["OpenCode executable", await commandWorks(process.env.OPENCODE_SAFE_COMPACTION_OPENCODE ?? "opencode", ["--version"]), process.env.OPENCODE_SAFE_COMPACTION_OPENCODE ?? "opencode"])
  checks.push(["Bun executable", await commandWorks(process.env.OPENCODE_SAFE_COMPACTION_BUN ?? "bun", ["--version"]), process.env.OPENCODE_SAFE_COMPACTION_BUN ?? "bun"])

  for (const [name, ok, detail] of checks) console.log(`${ok ? "OK" : "FAIL"} ${name}: ${detail}`)
  if (!checks.every((check) => check[1])) return 1
  const sqlite = await commandWorks("sqlite3", [databasePath, "PRAGMA busy_timeout=1000; PRAGMA query_only=ON; SELECT 1 FROM sqlite_master LIMIT 1;"])
  console.log(`${sqlite ? "OK" : "FAIL"} SQLite read-only probe: ${databasePath}`)
  if (!sqlite) return 1
  for (const source of config.sources) {
    const supported = source.kind === "opencode-v1-sqlite"
    console.log(`${supported ? "OK" : "FAIL"} source adapter: ${source.kind}`)
  }
  if (config.sources.some((source) => source.kind !== "opencode-v1-sqlite")) return 1
  return 0
}

async function syncRun(once: boolean) {
  const config = await loadConfig(paths)
  if (!config.sync.enabled) {
    console.log("sync disabled; set sync.enabled=true in the better-compact config")
    return 0
  }
  const lock = `${paths.state}.lock`
  try {
    await mkdir(lock, { recursive: false, mode: 0o700 })
  } catch {
    let lockPID = ""
    try { lockPID = (await readFile(path.join(lock, "pid"), "utf8")).trim() } catch {}
    let running = false
    if (lockPID && /^\d+$/.test(lockPID)) {
      try { process.kill(Number(lockPID), 0); running = true } catch {}
    }
    if (running) {
      console.error(`sync is already running; lock exists at ${lock}`)
      return 1
    }
    await rm(lock, { recursive: true, force: true })
    await mkdir(lock, { recursive: false, mode: 0o700 })
  }
  await writeFile(path.join(lock, "pid"), `${process.pid}\n`, { mode: 0o600 })
  try {
    do {
      await syncPass(config)
      if (once) return 0
      await new Promise((resolve) => setTimeout(resolve, config.sync.poll_interval_ms))
    } while (true)
  } finally {
    await rm(lock, { recursive: true, force: true })
  }
}

async function syncPass(config: Awaited<ReturnType<typeof loadConfig>>) {
  const state = await openSyncState(paths.state)
  try {
    const installation = state.ensureDefaultInstallation()
    for (const source of config.sources) {
      if (source.kind !== "opencode-v1-sqlite") throw new Error(`unsupported source adapter: ${source.kind}`)
      const filename = path.resolve(source.database.replace(/^~(?=\/|$)/, process.env.HOME ?? "."))
      const sourceID = createHash("sha256").update(`${source.kind}\n${filename}`).digest("hex").slice(0, 32)
      const inspection = inspectOpenCodeV1(filename)
      state.upsertSource({ id: sourceID, installationID: installation.id, kind: source.kind, schemaVersion: inspection.schemaVersion, locator: filename, fingerprint: inspection.layoutFingerprint, incarnation: installation.incarnation })
      const result = discoverOpenCodeV1(filename, sourceID, state.nextRevision(sourceID), config.sync.include_parts, config.sync.include_tool_output)
      state.enqueue(result.records, sourceID, "messages", result.checkpoint, "postgres", { complete: true, recordKinds: ["session", "message", "part", "todo"] }, config.sync.max_outbox_bytes)
      console.log(`staged ${result.records.length} records from ${filename}`)
      const databaseURL = process.env[config.sync.database_url_env]
      if (databaseURL) {
        const client = openPostgres(databaseURL)
        try {
          await ensureRemoteSource(client, { installationID: installation.id, sourceID, incarnation: installation.incarnation, expectedRevision: state.remoteRevision(sourceID) }, source.kind, inspection.schemaVersion, inspection.layoutFingerprint)
          const fence = await readRemoteFence(client, { installationID: installation.id, sourceID, incarnation: installation.incarnation, expectedRevision: state.remoteRevision(sourceID) })
          if (fence.revision > state.remoteRevision(sourceID)) {
            state.setRemoteRevision(sourceID, fence.revision)
            state.acknowledgeThrough(sourceID, fence.revision)
          }
          const rows = state.claim("postgres", config.sync.batch_size, Date.now(), 60_000, sourceID, fence.revision)
          const revision = await uploadFenced(client, { installationID: installation.id, sourceID, incarnation: installation.incarnation, expectedRevision: fence.revision }, rows)
          state.setRemoteRevision(sourceID, revision)
          state.acknowledge(rows.map((row) => row.id))
          console.log(`uploaded ${rows.length} records from ${filename}`)
        } finally {
          await client.close()
        }
      }
    }
  } finally { state.close() }
}

async function syncStatus() {
  const state = await openSyncState(paths.state)
  try {
    console.log(`state: ${paths.state}`)
    console.log(`pending outbox: ${state.pendingCount()}`)
    return 0
  } finally {
    state.close()
  }
}

async function syncInstall() {
  const mode = await installationMode()
  if (mode === "npx") {
    console.error("refusing to install a persistent service from an ephemeral npx path; materialize the package first")
    return 2
  }
  if (process.platform !== "linux") {
    console.error("sync install currently supports systemd user services on Linux; use sync run for foreground mode")
    return 2
  }
  const serviceDirectory = path.join(process.env.XDG_CONFIG_HOME ?? path.join(process.env.HOME ?? ".", ".config"), "systemd", "user")
  const service = path.join(serviceDirectory, "better-compact-sync.service")
  const executable = process.env.BETTER_COMPACT_EXECUTABLE ?? `${process.execPath} ${process.argv[1]}`
  await mkdir(serviceDirectory, { recursive: true, mode: 0o700 })
  await writeFile(`${service}.tmp-${process.pid}`, `[Unit]\nDescription=Better Compact session sync\nAfter=default.target\n\n[Service]\nExecStart=${executable} sync run\nRestart=on-failure\nRestartSec=5\n\n[Install]\nWantedBy=default.target\n`, { mode: 0o644 })
  await rename(`${service}.tmp-${process.pid}`, service)
  const reload = await run("systemctl", ["--user", "daemon-reload"], process.env)
  if (reload !== 0) return reload
  const enabled = await run("systemctl", ["--user", "enable", "--now", "better-compact-sync.service"], process.env)
  if (enabled === 0) console.log(`installed ${service}`)
  return enabled
}

async function syncUninstall() {
  const service = path.join(process.env.XDG_CONFIG_HOME ?? path.join(process.env.HOME ?? ".", ".config"), "systemd", "user", "better-compact-sync.service")
  await run("systemctl", ["--user", "disable", "--now", "better-compact-sync.service"], process.env)
  await rm(service, { force: true })
  await run("systemctl", ["--user", "daemon-reload"], process.env)
  console.log(`removed ${service}`)
  return 0
}

async function configured(name: string) {
  try {
    const text = await readFile(path.join(configDir, name), "utf8")
    return /safe-compaction|opencode-safe-compaction/.test(text)
  } catch {
    return false
  }
}

async function exists(file: string) {
  try {
    await stat(file)
    return true
  } catch {
    return false
  }
}

function commandWorks(command: string, args: string[]) {
  return new Promise<boolean>((resolve) => {
    const child = spawn(command, args, { stdio: "ignore" })
    child.once("error", () => resolve(false))
    child.once("exit", (code) => resolve(code === 0))
  })
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv) {
  return new Promise<number>((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", env })
    child.once("error", reject)
    child.once("exit", (code) => resolve(code ?? 1))
  })
}
