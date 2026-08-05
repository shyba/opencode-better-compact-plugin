#!/usr/bin/env bun
import { access, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import path from "node:path"
import { configPaths, loadConfig } from "../src/config.js"
import { Database } from "bun:sqlite"
import { discoverOpenCodeV1, inspectOpenCodeV1 } from "../src/opencode-v1.js"
import type { OpenCodeV1Checkpoint } from "../src/opencode-v1.js"
import { applyRemoteMigration, ensureRemoteSource, openPostgres, readRemoteFence, uploadFenced } from "../src/postgres.js"
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
if (command === "install") {
  process.exit(await activate())
}
if (command === "update") {
  process.exit(await update())
}
if (command === "doctor") {
  process.exit(await doctor())
}
if (command === "installation") {
  const action = process.argv[3]
  if (action === "reset") process.exit(await installationReset(process.argv.includes("--yes")))
  if (action === "adopt") process.exit(await installationAdopt(process.argv.includes("--yes")))
  console.error("Usage: better-compact installation reset|adopt --yes")
  process.exit(2)
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
  better-compact installation reset|adopt --yes  Explicitly recover or replace sync identity
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

async function activate() {
  const mode = await installationMode()
  if (mode === "git") return update()
  if (mode === "npx") {
    console.error("npx is ephemeral; materialize the package to a stable path before activation")
    return 2
  }
  const packageRoot = path.resolve(path.dirname(process.argv[1] ?? "."), "..")
  const bun = process.env.OPENCODE_SAFE_COMPACTION_BUN ?? process.execPath
  const configure = path.join(packageRoot, "scripts", "configure.ts")
  const environment = {
    ...process.env,
    OPENCODE_SAFE_COMPACTION_CONFIG_DIR: configDir,
    OPENCODE_SAFE_COMPACTION_DIR: packageRoot,
    OPENCODE_SAFE_COMPACTION_MODEL: process.env.OPENCODE_SAFE_COMPACTION_MODEL ?? "selected",
    OPENCODE_SAFE_COMPACTION_SERVER_ENTRY: path.join(packageRoot, "dist", "index.js"),
    OPENCODE_SAFE_COMPACTION_TUI_ENTRY: path.join(packageRoot, "dist", "tui.js"),
  }
  return run(bun, [configure], environment)
}

async function installationMode() {
  const executable = process.argv[1] ?? ""
  if (process.env.npm_config_user_agent?.includes("npx") || executable.includes("/.npm/_npx/")) return "npx"
  if (executable.includes("node_modules")) return "npm"
  if (await exists(path.join(installDir, ".git"))) return "git"
  return "package"
}

async function doctor() {
  const checks: Array<[string, boolean, string]> = []
  const config = await loadConfig(paths)
  const mode = await installationMode()
  checks.push(["installation", mode !== "npx", `${mode}: ${process.argv[1] ?? installDir}`])
  checks.push(["better-compact config", await exists(paths.config), paths.config])
  checks.push(["better-compact state parent", await exists(path.dirname(paths.state)), path.dirname(paths.state)])
  checks.push(["state permissions", await userOnly(paths.state), paths.state])
  checks.push(["configuration directory", await exists(configDir), configDir])
  checks.push(["server configuration", await configured("opencode.json") || await configured("opencode.jsonc"), configDir])
  checks.push(["TUI configuration", await configured("tui.json") || await configured("tui.jsonc"), configDir])
  checks.push(["SQLite database", await exists(databasePath), databasePath])
  checks.push(["OpenCode executable", await commandWorks(process.env.OPENCODE_SAFE_COMPACTION_OPENCODE ?? "opencode", ["--version"]), process.env.OPENCODE_SAFE_COMPACTION_OPENCODE ?? "opencode"])
  checks.push(["Bun executable", await commandWorks(process.env.OPENCODE_SAFE_COMPACTION_BUN ?? "bun", ["--version"]), process.env.OPENCODE_SAFE_COMPACTION_BUN ?? "bun"])

  for (const [name, ok, detail] of checks) console.log(`${ok ? "OK" : "FAIL"} ${name}: ${detail}`)
  if (!checks.every((check) => check[1])) return 1
  const sqlite = await sqliteProbe(databasePath)
  console.log(`${sqlite ? "OK" : "FAIL"} SQLite read-only probe: ${databasePath}`)
  if (!sqlite) return 1
  let sourcesHealthy = true
  for (const source of config.sources) {
    const filename = path.resolve(source.database.replace(/^~(?=\/|$)/, process.env.HOME ?? "."))
    let supported = source.kind === "opencode-v1-sqlite"
    if (supported) {
      try { const inspection = inspectOpenCodeV1(filename); console.log(`OK source schema: ${filename} v${inspection.schemaVersion} ${inspection.layoutFingerprint.slice(0, 12)}`) } catch (error) { supported = false; console.log(`FAIL source schema: ${filename}: ${error instanceof Error ? error.message : String(error)}`) }
    } else console.log(`FAIL source adapter: ${source.kind}`)
    sourcesHealthy = sourcesHealthy && supported
  }
  if (!sourcesHealthy) return 1
  return 0
}

async function sqliteProbe(filename: string) {
  try {
    const db = new Database(filename, { readonly: true })
    db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=1000; SELECT 1 FROM sqlite_master LIMIT 1;")
    db.close()
    return true
  } catch { return false }
}

async function syncRun(once: boolean) {
  const config = await loadConfig(paths)
  if (!config.sync.enabled) {
    console.log("sync disabled; set sync.enabled=true in the better-compact config")
    return 0
  }
  const lock = `${paths.state}.lock`
  await mkdir(path.dirname(lock), { recursive: true, mode: 0o700 })
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
  let stopping = false
  const stop = () => { stopping = true }
  process.once("SIGTERM", stop)
  process.once("SIGINT", stop)
  try {
    do {
      try {
        await syncPass(config)
      } catch (error) {
        console.error(`warning: sync pass failed: ${error instanceof Error ? error.message : String(error)}`)
        if (once) return 1
      }
      if (once || stopping) return 0
      await new Promise((resolve) => setTimeout(resolve, config.sync.poll_interval_ms))
    } while (true)
  } finally {
    process.off("SIGTERM", stop)
    process.off("SIGINT", stop)
    await rm(lock, { recursive: true, force: true })
  }
}

async function syncPass(config: Awaited<ReturnType<typeof loadConfig>>) {
  const state = await openSyncState(paths.state)
  try {
    state.purgePayloads(config.sync.retention_days * 24 * 60 * 60 * 1000)
    const installation = state.ensureDefaultInstallation()
    for (const source of config.sources) {
      if (source.kind !== "opencode-v1-sqlite") throw new Error(`unsupported source adapter: ${source.kind}`)
      const filename = path.resolve(source.database.replace(/^~(?=\/|$)/, process.env.HOME ?? "."))
      const sourceID = createHash("sha256").update(`${source.kind}\n${filename}`).digest("hex").slice(0, 32)
      const inspection = inspectOpenCodeV1(filename)
      const sourceIncarnation = state.sourceIncarnation(sourceID)
      state.upsertSource({ id: sourceID, installationID: installation.id, kind: source.kind, schemaVersion: inspection.schemaVersion, locator: filename, fingerprint: inspection.layoutFingerprint, incarnation: sourceIncarnation })
      const backpressure = state.outboxBytes() >= config.sync.max_outbox_bytes
      if (backpressure) console.error(`warning: sync backpressure at ${state.outboxBytes()} bytes; uploading existing rows only`)
      const checkpoint = state.checkpoint(sourceID) as OpenCodeV1Checkpoint | undefined
      const result = backpressure
        ? { records: [], checkpoint: checkpoint ?? { sourceUpdatedAt: 0, sessionCreatedAt: 0, sessionID: "", reconcileBefore: Date.now() }, complete: false }
        : discoverOpenCodeV1(filename, sourceID, checkpoint, config.sync.include_parts, config.sync.include_tool_output)
      state.enqueue(result.records, sourceID, "messages", result.checkpoint, "postgres", { complete: result.complete, recordKinds: ["session", "message", "part", "todo"] }, config.sync.max_outbox_bytes)
      console.log(`staged ${result.records.length} records from ${filename}${result.complete ? " (reconciled)" : " (unchanged)"}`)
      const databaseURL = process.env[config.sync.database_url_env]
      if (databaseURL) {
        assertPostgresTLS(databaseURL)
        const client = openPostgres(databaseURL)
        let rows: ReturnType<typeof state.claim> = []
        try {
          await applyRemoteMigration(client, await readFile(path.resolve(path.dirname(process.argv[1] ?? "."), "..", "db/migrations/001_init.sql"), "utf8"))
          await ensureRemoteSource(client, { installationID: installation.id, sourceID, incarnation: sourceIncarnation, expectedRevision: state.remoteRevision(sourceID) }, source.kind, inspection.schemaVersion, inspection.layoutFingerprint)
          const fence = await readRemoteFence(client, { installationID: installation.id, sourceID, incarnation: sourceIncarnation, expectedRevision: state.remoteRevision(sourceID) })
          if (fence.revision > state.remoteRevision(sourceID)) throw new Error(`remote revision ${fence.revision} is ahead of local ${state.remoteRevision(sourceID)}; run an explicit reset/adopt workflow`)
          rows = state.claim("postgres", config.sync.batch_size, Date.now(), 60_000, sourceID, fence.revision)
          const revision = await uploadFenced(client, { installationID: installation.id, sourceID, incarnation: sourceIncarnation, expectedRevision: fence.revision }, rows)
          state.setRemoteRevision(sourceID, revision)
          state.acknowledge(rows.map((row) => row.id))
          console.log(`uploaded ${rows.length} records from ${filename}`)
        } catch (error) {
          state.fail(rows.map((row) => row.id), error instanceof Error ? error.message : String(error))
          throw error
        } finally {
          await client.close()
        }
      }
    }
  } finally { state.close() }
}

function assertPostgresTLS(url: string) {
  const parsed = new URL(url)
  const local = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "::1"
  const sslmode = parsed.searchParams.get("sslmode")
  if (!local && sslmode !== "require" && sslmode !== "verify-full") throw new Error("refusing non-local Postgres without sslmode=require or verify-full")
  if (!local && sslmode === "disable") throw new Error("refusing sslmode=disable for non-local Postgres")
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

async function installationReset(confirmed: boolean) {
  if (!confirmed) {
    console.error(`This removes local sync identity, cursors, and outbox at ${paths.state}. Re-run with --yes.`)
    return 2
  }
  const lockPID = await readFile(`${paths.state}.lock/pid`, "utf8").catch(() => "")
  if (/^\d+$/.test(lockPID.trim())) {
    try { process.kill(Number(lockPID.trim()), 0); console.error("sync is running; stop it before resetting installation state"); return 2 } catch {}
  }
  await rm(paths.state, { force: true })
  await rm(`${paths.state}-wal`, { force: true })
  await rm(`${paths.state}-shm`, { force: true })
  console.log(`reset local sync identity; next run will allocate a new installation at ${paths.state}`)
  return 0
}

async function installationAdopt(confirmed: boolean) {
  if (!confirmed) {
    console.error("Adoption imports remote high-water marks and acknowledges matching local outbox rows. Re-run with --yes.")
    return 2
  }
  const config = await loadConfig(paths)
  const databaseURL = process.env[config.sync.database_url_env]
  if (!databaseURL) { console.error(`missing ${config.sync.database_url_env}`); return 2 }
  assertPostgresTLS(databaseURL)
  const state = await openSyncState(paths.state)
  const installation = state.ensureDefaultInstallation()
  const client = openPostgres(databaseURL)
  try {
    for (const source of config.sources) {
      if (source.kind !== "opencode-v1-sqlite") continue
      const filename = path.resolve(source.database.replace(/^~(?=\/|$)/, process.env.HOME ?? "."))
      const sourceID = createHash("sha256").update(`${source.kind}\n${filename}`).digest("hex").slice(0, 32)
      const inspection = inspectOpenCodeV1(filename)
      const sourceIncarnation = state.sourceIncarnation(sourceID)
      state.upsertSource({ id: sourceID, installationID: installation.id, kind: source.kind, schemaVersion: inspection.schemaVersion, locator: filename, fingerprint: inspection.layoutFingerprint, incarnation: sourceIncarnation })
      const fence = await readRemoteFence(client, { installationID: installation.id, sourceID, incarnation: sourceIncarnation, expectedRevision: state.remoteRevision(sourceID) }, true)
      state.adoptSourceIncarnation(sourceID, fence.incarnation)
      state.setRemoteRevision(sourceID, fence.revision)
      state.adoptThrough(sourceID, fence.revision)
      console.log(`adopted ${sourceID} at remote revision ${fence.revision}`)
    }
    return 0
  } finally { await client.close(); state.close() }
}

async function syncInstall() {
  const mode = await installationMode()
  if (mode !== "git" && mode !== "npm") {
    console.error("refusing to install a persistent service from an ephemeral package path; materialize the package first")
    return 2
  }
  if (process.platform === "darwin") return launchdInstall(mode)
  if (process.platform !== "linux") {
    console.error("sync install supports systemd user services on Linux and launchd agents on macOS; use sync run for foreground mode")
    return 2
  }
  const serviceDirectory = path.join(process.env.XDG_CONFIG_HOME ?? path.join(process.env.HOME ?? ".", ".config"), "systemd", "user")
  const service = path.join(serviceDirectory, "better-compact-sync.service")
  const executable = process.env.BETTER_COMPACT_EXECUTABLE
  if (executable && !path.isAbsolute(executable)) {
    console.error("BETTER_COMPACT_EXECUTABLE must start with an absolute executable path")
    return 2
  }
  await mkdir(serviceDirectory, { recursive: true, mode: 0o700 })
  const command = executable ? `${quoteSystemd(executable)} sync run` : `${quoteSystemd(process.execPath)} ${quoteSystemd(process.argv[1] ?? "")} sync run`
  const environmentFile = await writeSyncEnvironment()
  await writeFile(`${service}.tmp-${process.pid}`, `[Unit]\nDescription=Better Compact session sync\nAfter=default.target\n\n[Service]\nExecStart=${command}\n${environmentFile ? `EnvironmentFile=-${quoteSystemd(environmentFile)}\n` : ""}Restart=on-failure\nRestartSec=5\n\n[Install]\nWantedBy=default.target\n`, { mode: 0o644 })
  await rename(`${service}.tmp-${process.pid}`, service)
  const reload = await run("systemctl", ["--user", "daemon-reload"], process.env)
  if (reload !== 0) return reload
  const enabled = await run("systemctl", ["--user", "enable", "--now", "better-compact-sync.service"], process.env)
  if (enabled === 0) console.log(`installed ${service}`)
  return enabled
}

async function launchdInstall(mode: string) {
  const directory = path.join(process.env.HOME ?? ".", "Library", "LaunchAgents")
  const label = "com.opencode.better-compact.sync"
  const file = path.join(directory, `${label}.plist`)
  const executable = process.env.BETTER_COMPACT_EXECUTABLE ?? process.execPath
  if (!path.isAbsolute(executable)) { console.error("BETTER_COMPACT_EXECUTABLE must be absolute"); return 2 }
  const args = process.env.BETTER_COMPACT_EXECUTABLE ? [executable, "sync", "run"] : [executable, process.argv[1] ?? "", "sync", "run"]
  const plist = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${xml(label)}</string><key>ProgramArguments</key><array>${args.map((arg) => `<string>${xml(arg)}</string>`).join("")}</array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ProcessType</key><string>Background</string></dict></plist>\n`
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await writeFile(`${file}.tmp-${process.pid}`, plist, { mode: 0o600 })
  await rename(`${file}.tmp-${process.pid}`, file)
  const domain = `gui/${process.getuid?.() ?? ""}`
  const result = await run("launchctl", ["bootstrap", domain, file], process.env)
  if (result === 0) console.log(`installed ${file} (${mode})`)
  return result
}

async function writeSyncEnvironment() {
  const config = await loadConfig(paths)
  const value = process.env[config.sync.database_url_env]
  if (!value) return undefined
  await mkdir(paths.home, { recursive: true, mode: 0o700 })
  const file = path.join(paths.home, "sync.env")
  await writeFile(file, `${config.sync.database_url_env}=${value.replaceAll("\\", "\\\\").replaceAll("\n", "")}\n`, { mode: 0o600 })
  return file
}

function xml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\"", "&quot;").replaceAll("'", "&apos;")
}

function quoteSystemd(value: string) {
  return `"${value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`
}

async function syncUninstall() {
  if (process.platform === "darwin") {
    const file = path.join(process.env.HOME ?? ".", "Library", "LaunchAgents", "com.opencode.better-compact.sync.plist")
    await run("launchctl", ["bootout", `gui/${process.getuid?.() ?? ""}`, file], process.env)
    await rm(file, { force: true })
    console.log(`removed ${file}`)
    return 0
  }
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

async function userOnly(file: string) {
  try { return ((await stat(file)).mode & 0o077) === 0 }
  catch { return true }
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
