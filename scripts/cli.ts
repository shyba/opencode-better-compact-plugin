#!/usr/bin/env bun
import { access, chmod, lstat, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { existsSync, readFileSync } from "node:fs"
import { spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import path from "node:path"
import { configPaths, loadConfig, saveConfig } from "../src/config.js"
import { Database } from "bun:sqlite"
import { discoverOpenCodeV1, discoverOpenCodeV1Sessions, inspectOpenCodeV1 } from "../src/opencode-v1.js"
import type { OpenCodeV1Checkpoint } from "../src/opencode-v1.js"
import { discoverJsonl, discoverJsonlSessions, inspectJsonl } from "../src/jsonl.js"
import type { JsonlCheckpoint, JsonlDiscoveryResult, JsonlSessionCheckpoint } from "../src/jsonl.js"
import { applyRemoteMigration, ensureRemoteSource, openPostgres, purgeRemoteTombstones, readRemoteFence, recordObservation, uploadFenced } from "../src/postgres.js"
import { openSyncState } from "../src/sync-state.js"

const installDir = path.resolve(process.env.OPENCODE_SAFE_COMPACTION_DIR ?? path.join(process.env.HOME ?? ".", ".local/share/opencode/plugins/safe-compaction"))
const configDir = path.resolve(process.env.OPENCODE_SAFE_COMPACTION_CONFIG_DIR ?? process.env.OPENCODE_CONFIG_DIR ?? path.join(process.env.XDG_CONFIG_HOME ?? path.join(process.env.HOME ?? ".", ".config"), "opencode"))
const databasePath = path.resolve(process.env.OPENCODE_DB ?? path.join(process.env.XDG_DATA_HOME ?? path.join(process.env.HOME ?? ".", ".local/share"), "opencode", "opencode.db"))
const maxUploadBatchesPerSource = 8
const idleCompactionMinBytes = 8 * 1024 * 1024
const idleCompactionMinFreePages = 1024
const idleCompactionMinFreeRatio = 0.2
const defaultSyncSources = [
  { kind: "opencode-v1-sqlite", database: "~/.local/share/opencode/opencode.db" },
  { kind: "opencode-v1-sessions", database: "~/.local/share/opencode/opencode.db" },
  { kind: "codex-jsonl", database: "~/.codex/sessions" },
  { kind: "codex-jsonl-sessions", database: "~/.codex/sessions" },
  { kind: "pi-jsonl", database: "~/.pi/agent/sessions" },
] as const
const configFlag = flagValue("--config")
const stateFlag = flagValue("--state")
if (configFlag) process.env.BETTER_COMPACT_CONFIG = path.resolve(configFlag)
if (stateFlag) process.env.BETTER_COMPACT_STATE = path.resolve(stateFlag)
const paths = configPaths()
const workerToken = machineWorkerToken(paths.state)

const command = process.argv[2] ?? "help"
if (command === "help" || command === "--help" || command === "-h") {
  printHelp()
  process.exit(0)
}
if (command === "install") {
  if (process.argv[3] === "pi") process.exit(await installPi())
  if (process.argv[3]) {
    console.error("Usage: better-compact install [pi]")
    process.exit(2)
  }
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
  if (action === "run") process.exit(await syncRun(process.argv.includes("--once"), process.argv.includes("--pass")))
  if (action === "setup") process.exit(await syncSetup())
  if (action === "status") process.exit(await syncStatus())
  if (action === "migrate") process.exit(await syncMigrate())
  if (action === "install") process.exit(await syncInstall())
  if (action === "uninstall") process.exit(await syncUninstall())
  if (action === "prune") process.exit(await syncPrune(process.argv.includes("--yes"), process.argv.includes("--missing-directories"), process.argv.includes("--blank-directories")))
  if (action === "compact") process.exit(await syncCompact(process.argv.includes("--yes")))
  if (action === "reconcile") process.exit(await syncReconcile())
  console.error("Usage: better-compact sync setup [--url URL|--url-stdin] [--allow-insecure-remote] [--install] | run [--once] | status | migrate | install | uninstall | prune (--missing-directories|--blank-directories) --yes | compact --yes | reconcile")
  process.exit(2)
}
if (command === "rag") {
  const action = process.argv[3]
  if (action === "migrate") process.exit(await ragMigrate())
  if (action === "status") process.exit(await ragStatus())
  if (action === "setup") process.exit(await ragSetup())
  if (action === "run") process.exit(await ragRun(process.argv.includes("--once")))
  if (action === "install") process.exit(await ragInstall())
  if (action === "uninstall") process.exit(await ragUninstall())
  if (action === "tunnel" && process.argv[4] === "install") process.exit(await ragTunnelInstall(await loadConfig(paths)))
  if (action === "tunnel" && process.argv[4] === "uninstall") process.exit(await ragTunnelUninstall())
  console.error("Usage: better-compact rag setup [--model-path PATH] [--python PATH] [--ssh-host HOST --ssh-user USER] [--install] | run [--once] | status | migrate | install | uninstall | tunnel install|uninstall")
  process.exit(2)
}
console.error(`Unknown command: ${command}`)
printHelp()
process.exit(2)

function printHelp() {
  console.log(`better-compact - OpenCode safe-compaction maintenance

Usage:
  better-compact install  Activate the OpenCode plugin using the selected installation mode
  better-compact install pi  Register both extensions with Pi
  better-compact update   Update the managed checkout and verify configuration
  better-compact doctor   Check installation, OpenCode, configuration, and SQLite access
  better-compact sync setup [--url URL|--url-stdin] [--allow-insecure-remote] [--install] Configure the Postgres destination
  better-compact sync run [--once|--pass] [--config FILE] [--state FILE] Discover sources and deliver redacted records
  better-compact sync status Show local outbox status
  better-compact sync migrate Apply the remote schema using explicit admin credentials
  better-compact sync install|uninstall Manage a systemd user service
  better-compact sync prune (--missing-directories|--blank-directories) --yes Delete local Codex files while retaining remote rows
  better-compact sync compact --yes  Remove acknowledged local cache rows and compact SQLite
  better-compact sync reconcile    Force the next OpenCode source pass to rebuild a complete snapshot
  better-compact rag setup         Enable the BGE-small embedding worker and configure its model/runtime
  better-compact rag run [--once]  Run the streaming BGE-small worker in the foreground
  better-compact rag status        Show model, row, dimension, and size metadata
  better-compact rag migrate       Create the additive 384-dimensional RAG projection (admin credentials)
  better-compact rag install       Install and start the per-user embedding service
  better-compact rag uninstall     Stop and remove the per-user embedding service
  better-compact rag tunnel install|uninstall  Manage the encrypted PostgreSQL SSH tunnel
  better-compact installation reset|adopt --yes  Explicitly recover or replace sync identity
  better-compact help     Show this help

Environment overrides:
  OPENCODE_SAFE_COMPACTION_DIR
  OPENCODE_SAFE_COMPACTION_CONFIG_DIR
  OPENCODE_SAFE_COMPACTION_OPENCODE
  OPENCODE_SAFE_COMPACTION_BUN
  OPENCODE_SAFE_COMPACTION_PI
  OPENCODE_SAFE_COMPACTION_PI_SOURCE
  OPENCODE_DB
  BETTER_COMPACT_CONFIG
  BETTER_COMPACT_STATE`)
}

function flagValue(flag: string) {
  const index = process.argv.indexOf(flag)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function machineWorkerToken(statePath: string) {
  try { return createHash("sha256").update(`${readFileSync("/etc/machine-id", "utf8")}\n${statePath}`).digest("hex") }
  catch { return randomUUID() }
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

async function installPi() {
  const pi = process.env.OPENCODE_SAFE_COMPACTION_PI ?? "pi"
  if (!(await commandWorks(pi, ["--version"]))) {
    console.error(`Pi executable not found or not runnable: ${pi}`)
    console.error("Install Pi first, or set OPENCODE_SAFE_COMPACTION_PI to its absolute executable path")
    return 2
  }

  const mode = await installationMode()
  const source = piSource(mode)
  if (!source) return 2
  console.log(`Installing safe-compaction Pi extensions from ${source}`)
  return run(pi, ["install", source], process.env)
}

function piSource(mode: Awaited<ReturnType<typeof installationMode>>) {
  const override = process.env.OPENCODE_SAFE_COMPACTION_PI_SOURCE
  if (override) return packageSource(override)
  if (mode === "npx") {
    console.error("npx is ephemeral; set OPENCODE_SAFE_COMPACTION_PI_SOURCE to a Git or npm Pi package source")
    return undefined
  }
  if (mode === "git") return installDir
  return path.resolve(path.dirname(process.argv[1] ?? "."), "..")
}

function packageSource(source: string) {
  if (source.startsWith("git:") || source.startsWith("npm:") || source.includes("://")) return source
  return path.resolve(source)
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
  let config: Awaited<ReturnType<typeof loadConfig>>
  try { config = await loadConfig(paths) } catch (error) {
    console.log(`FAIL better-compact config: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
  const mode = await installationMode()
  checks.push(["installation", mode !== "npx", `${mode}: ${process.argv[1] ?? installDir}`])
  checks.push(["better-compact config", await exists(paths.config), paths.config])
  checks.push(["config permissions", await userOnly(paths.config), paths.config])
  checks.push(["better-compact state parent", await exists(path.dirname(paths.state)), path.dirname(paths.state)])
  checks.push(["state permissions", await userOnly(paths.state), paths.state])
  checks.push(["configuration directory", await exists(configDir), configDir])
  checks.push(["server configuration", await configured("opencode.json") || await configured("opencode.jsonc"), configDir])
  checks.push(["TUI configuration", await configured("tui.json") || await configured("tui.jsonc"), configDir])
  checks.push(["SQLite database", await exists(databasePath), databasePath])
  checks.push(["OpenCode executable", await commandWorks(process.env.OPENCODE_SAFE_COMPACTION_OPENCODE ?? "opencode", ["--version"]), process.env.OPENCODE_SAFE_COMPACTION_OPENCODE ?? "opencode"])
  checks.push(["Bun executable", await commandWorks(process.env.OPENCODE_SAFE_COMPACTION_BUN ?? "bun", ["--version"]), process.env.OPENCODE_SAFE_COMPACTION_BUN ?? "bun"])
  if (config.sync.enabled) {
    const databaseURL = databaseURLFor(config)
    let remoteOK = Boolean(databaseURL)
    if (databaseURL) { try { assertPostgresTLS(databaseURL, config.sync.allow_insecure_remote) } catch { remoteOK = false } }
    checks.push(["sync database URL", remoteOK, config.sync.database_url_env])
  }

  for (const [name, ok, detail] of checks) console.log(`${ok ? "OK" : "FAIL"} ${name}: ${detail}`)
  if (!checks.every((check) => check[1])) return 1
  const sqlite = await sqliteProbe(databasePath)
  console.log(`${sqlite ? "OK" : "FAIL"} SQLite read-only probe: ${databasePath}`)
  if (!sqlite) return 1
  let sourcesHealthy = true
  for (const source of config.sources) {
    const filename = path.resolve(source.database.replace(/^~(?=\/|$)/, process.env.HOME ?? "."))
    let supported = true
    if (source.kind === "opencode-v1-sqlite" || source.kind === "opencode-v1-sessions") {
      try { const inspection = inspectOpenCodeV1(filename); console.log(`OK source schema: ${filename} v${inspection.schemaVersion} ${inspection.layoutFingerprint.slice(0, 12)}`) } catch (error) { supported = false; console.log(`FAIL source schema: ${filename}: ${error instanceof Error ? error.message : String(error)}`) }
    } else if (source.kind === "codex-jsonl" || source.kind === "codex-jsonl-sessions" || source.kind === "pi-jsonl") {
      try { const inspection = await inspectJsonl(filename); console.log(`OK source JSONL: ${filename} (${inspection.fileCount} files, ${inspection.totalBytes} bytes)`) } catch (error) { supported = false; console.log(`FAIL source JSONL: ${filename}: ${error instanceof Error ? error.message : String(error)}`) }
    } else {
      supported = false
      console.log(`FAIL source adapter: ${source.kind}`)
    }
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

async function syncRun(once: boolean, singlePass = false) {
  const config = await loadConfig(paths)
  if (!config.sync.enabled) {
    console.log("sync disabled; set sync.enabled=true in the better-compact config")
    return 0
  }
  const databaseURL = databaseURLFor(config)
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
  const controller = new AbortController()
  const stop = () => { stopping = true; controller.abort() }
  process.once("SIGTERM", stop)
  process.once("SIGINT", stop)
  try {
    do {
      try {
        const progress = await syncPass(config, controller.signal)
        if (progress.pending === 0) await compactStateIfIdle()
        if (progress.failed && (once || singlePass)) return 1
        if (stopping || singlePass || (once && (!databaseURL || (!progress.progress && progress.pending === 0)))) return 0
      } catch (error) {
        if (stopping) return 0
        console.error(`warning: sync pass failed: ${error instanceof Error ? error.message : String(error)}`)
        if (once || singlePass) return 1
      }
      if (stopping) return 0
      await new Promise((resolve) => setTimeout(resolve, config.sync.poll_interval_ms))
    } while (true)
  } finally {
    process.off("SIGTERM", stop)
    process.off("SIGINT", stop)
    await rm(lock, { recursive: true, force: true })
  }
}

async function syncReconcile() {
  const lock = `${paths.state}.lock`
  const lockPID = await readFile(path.join(lock, "pid"), "utf8").catch(() => "")
  if (/^\d+$/.test(lockPID.trim())) {
    try { process.kill(Number(lockPID.trim()), 0); console.error("sync is running; stop better-compact-sync.service before forcing a reconcile"); return 2 } catch {}
  }
  const config = await loadConfig(paths)
  const sourceIDs = config.sources
    .filter((source) => source.kind === "opencode-v1-sqlite" || source.kind === "opencode-v1-sessions")
    .map((source) => createHash("sha256").update(`${source.kind}\n${path.resolve(source.database.replace(/^~(?=\/|$)/, process.env.HOME ?? "."))}`).digest("hex").slice(0, 32))
  const state = await openSyncState(paths.state)
  try {
    const changed = state.forceReconcile(sourceIDs)
    console.log(`scheduled ${changed} OpenCode source${changed === 1 ? "" : "s"} for a complete reconcile`)
    return 0
  } finally { state.close() }
}

async function compactStateIfIdle() {
  const metadata = await stat(paths.state).catch(() => undefined)
  if (!metadata || metadata.size < idleCompactionMinBytes) return
  try {
    const db = new Database(paths.state)
    try {
      const pageCount = Number((db.query("pragma page_count").get() as { page_count?: number } | null)?.page_count ?? 0)
      const freePages = Number((db.query("pragma freelist_count").get() as { freelist_count?: number } | null)?.freelist_count ?? 0)
      if (freePages < idleCompactionMinFreePages || freePages / Math.max(pageCount, 1) < idleCompactionMinFreeRatio) return
      db.exec("pragma journal_mode=delete; pragma wal_checkpoint(truncate); vacuum")
    } finally { db.close() }
    console.log(`compacted idle sync state (${metadata.size} bytes before vacuum)`)
  } catch (error) {
    console.error(`warning: idle state compaction failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function syncPass(config: Awaited<ReturnType<typeof loadConfig>>, signal?: AbortSignal) {
  const state = await openSyncState(paths.state)
  let progressed = false
  let failed = false
  try {
    state.releaseAcknowledgedRecords(100_000)
    state.purgePayloads(config.sync.retention_days * 24 * 60 * 60 * 1000)
    const installation = state.ensureDefaultInstallation()
    for (const source of config.sources) {
      if (signal?.aborted) break
      try {
        if (source.kind !== "opencode-v1-sqlite" && source.kind !== "opencode-v1-sessions" && source.kind !== "codex-jsonl" && source.kind !== "codex-jsonl-sessions" && source.kind !== "pi-jsonl") throw new Error(`unsupported source adapter: ${source.kind}`)
        const filename = path.resolve(source.database.replace(/^~(?=\/|$)/, process.env.HOME ?? "."))
      const sourceID = createHash("sha256").update(`${source.kind}\n${filename}`).digest("hex").slice(0, 32)
      const inspection = source.kind === "opencode-v1-sqlite" || source.kind === "opencode-v1-sessions" ? inspectOpenCodeV1(filename) : await inspectJsonl(filename)
      const sourceIncarnation = state.sourceIncarnation(sourceID)
      state.upsertSource({ id: sourceID, installationID: installation.id, kind: source.kind, schemaVersion: inspection.schemaVersion, locator: filename, ...(source.kind === "opencode-v1-sqlite" || source.kind === "opencode-v1-sessions" ? { fingerprint: inspection.layoutFingerprint } : {}), incarnation: sourceIncarnation })
      const outboxBytes = state.outboxBytes()
      const backpressure = outboxBytes >= config.sync.max_outbox_bytes * 0.75
      if (backpressure) console.error(`warning: sync backpressure at ${outboxBytes} bytes; uploading existing rows only`)
      const checkpoint = state.checkpoint(sourceID)
      const result = backpressure
        ? emptyDiscovery(source.kind, checkpoint)
      : await discoverSource(source.kind, filename, sourceID, checkpoint, config.sync.include_parts, config.sync.include_tool_output, config.sync.batch_size * 5, signal, config.sync.keep_remote_on_missing, config.sync.allow_source_shrink)
      if ("reconcileBlocked" in result && result.reconcileBlocked) console.error(`warning: ${filename}: ${result.reconcileBlocked}; retaining remote rows`)
      const snapshot = source.kind === "opencode-v1-sqlite"
        ? { complete: result.complete, recordKinds: ["session", "message", "part", "todo"] }
        : source.kind === "opencode-v1-sessions"
          ? { complete: result.complete, recordKinds: ["session"] }
        : { prefixes: result.reconcilePrefixes }
      state.enqueue(result.records, sourceID, "messages", result.checkpoint, "postgres", snapshot, config.sync.max_outbox_bytes)
      progressed = progressed || result.records.length > 0 || result.reconcilePrefixes.length > 0
      console.log(`staged ${result.records.length} records from ${filename}${result.complete ? " (reconciled)" : result.hasMore ? " (more pending)" : " (unchanged)"}`)
      if (signal?.aborted) break
      const databaseURL = databaseURLFor(config)
        if (databaseURL) {
        assertPostgresTLS(databaseURL, config.sync.allow_insecure_remote)
        const client = openPostgres(databaseURL)
        let rows: ReturnType<typeof state.claim> = []
        let uploaded = 0
        try {
          await ensureRemoteSource(client, { installationID: installation.id, installationIncarnation: installation.incarnation, sourceID, incarnation: sourceIncarnation, ownerToken: workerToken, expectedRevision: state.remoteRevision(sourceID) }, source.kind, inspection.schemaVersion, inspection.layoutFingerprint)
          const fence = await readRemoteFence(client, { installationID: installation.id, installationIncarnation: installation.incarnation, sourceID, incarnation: sourceIncarnation, ownerToken: workerToken, expectedRevision: state.remoteRevision(sourceID) })
          if (fence.revision > state.remoteRevision(sourceID) && !state.reconcileCommitted(sourceID, fence.revision)) throw new Error(`remote revision ${fence.revision} is ahead of local ${state.remoteRevision(sourceID)}; run an explicit reset/adopt workflow`)
          let revision = fence.revision
          for (let batch = 0; batch < maxUploadBatchesPerSource; batch++) {
            if (signal?.aborted) break
            rows = state.claim("postgres", config.sync.batch_size, Date.now(), 60_000, sourceID, revision)
            if (!rows.length) break
            try {
              revision = await uploadFenced(client, { installationID: installation.id, installationIncarnation: installation.incarnation, sourceID, incarnation: sourceIncarnation, ownerToken: workerToken, expectedRevision: revision }, rows)
              state.setRemoteRevision(sourceID, revision)
              state.acknowledge(rows.map((row) => row.id))
              uploaded += rows.length
              progressed = true
              try {
                await recordObservation(client, { installationID: installation.id, installationIncarnation: installation.incarnation, sourceID, incarnation: sourceIncarnation, ownerToken: workerToken, expectedRevision: revision }, result.records.length, rows.length, result.sourceUpdatedAt ? Math.max(0, Date.now() - result.sourceUpdatedAt) : null)
              } catch { console.error("warning: remote observation maintenance failed") }
            } catch (error) {
              state.fail(rows.map((row) => row.id), error instanceof Error ? error.message : String(error))
              throw error
            }
          }
          try {
            await purgeRemoteTombstones(client, { installationID: installation.id, installationIncarnation: installation.incarnation, sourceID, incarnation: sourceIncarnation, ownerToken: workerToken, expectedRevision: revision }, config.sync.retention_days)
          } catch { console.error("warning: remote tombstone maintenance failed") }
          console.log(`uploaded ${uploaded} records from ${filename}`)
        } catch (error) {
          if (rows.length) state.fail(rows.map((row) => row.id), error instanceof Error ? error.message : String(error))
          throw error
        } finally {
          await client.close()
        }
        }
      } catch (error) {
        failed = true
        console.error(`warning: sync source ${source.kind} failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return { progress: progressed, pending: state.pendingCount(), failed }
  } finally { state.close() }
}

async function syncSetup() {
  try {
    const existing = await loadConfig(paths)
    const databaseURL = await setupDatabaseURL(existing)
    const allowInsecureRemote = existing.sync.allow_insecure_remote || process.argv.includes("--allow-insecure-remote")
    assertPostgresURL(databaseURL, allowInsecureRemote)
    const sources = existing.sources.length ? existing.sources : await availableDefaultSyncSources()
    const environmentFile = await writeSyncEnvironment(databaseURL, allowInsecureRemote)
    await saveConfig({
      ...existing,
      sync: { ...existing.sync, enabled: true, allow_insecure_remote: allowInsecureRemote },
      sources,
    }, paths)
    console.log(`configured sync in ${paths.config}`)
    console.log(`stored the writer URL in ${environmentFile} (mode 0600)`)
    if (sources.length) console.log(`configured ${sources.length} session source${sources.length === 1 ? "" : "s"}`)
    else console.error(`warning: no standard session source was found; add sources to ${paths.config} before running sync`)
    if (process.argv.includes("--install")) return syncInstall(databaseURL)
    console.log("next: run better-compact sync migrate once with admin credentials, then better-compact sync install")
    return 0
  } catch (error) {
    console.error(`sync setup failed: ${error instanceof Error ? error.message : String(error)}`)
    return 2
  }
}

async function setupDatabaseURL(config: Awaited<ReturnType<typeof loadConfig>>) {
  const environmentName = config.sync.database_url_env
  const fromFlag = process.argv.includes("--url")
  const fromStdin = process.argv.includes("--url-stdin")
  if (fromFlag && fromStdin) throw new Error("choose either --url or --url-stdin, not both")
  if (fromFlag) {
    const value = flagValue("--url")
    if (!value || value.startsWith("--")) throw new Error("--url requires a Postgres URL")
    return value.trim()
  }
  if (fromStdin) {
    const value = (await Bun.stdin.text()).trim()
    if (!value) throw new Error("--url-stdin received an empty value")
    return value
  }
  const value = process.env[environmentName]?.trim() || syncEnvironmentValue(environmentName)?.trim() || databaseURLFor(config)
  if (!value) throw new Error(`no Postgres URL supplied; use --url, --url-stdin, or set ${environmentName}`)
  return value
}

async function availableDefaultSyncSources() {
  const openCodeDatabase = process.env.OPENCODE_DB ?? (process.env.XDG_DATA_HOME
    ? path.join(process.env.XDG_DATA_HOME, "opencode", "opencode.db")
    : "~/.local/share/opencode/opencode.db")
  const candidates = await Promise.all(defaultSyncSources.map(async (source) => {
    const database = source.kind.startsWith("opencode-") ? openCodeDatabase : source.database
    const filename = path.resolve(database.replace(/^~(?=\/|$)/, process.env.HOME ?? "."))
    if (!(await exists(filename))) return undefined
    return { kind: source.kind, database }
  }))
  return candidates.flatMap((source) => source ? [source] : [])
}

function emptyDiscovery(kind: string, checkpoint: Record<string, unknown> | undefined): JsonlDiscoveryResult | { records: never[]; sessionRecords: never[]; checkpoint: OpenCodeV1Checkpoint; complete: false; hasMore: boolean; reconcilePrefixes: never[]; sourceUpdatedAt: number } {
  if (kind === "opencode-v1-sqlite" || kind === "opencode-v1-sessions") return { records: [], sessionRecords: [], checkpoint: checkpoint as OpenCodeV1Checkpoint ?? { sourceUpdatedAt: 0, sessionCreatedAt: 0, sessionID: "", reconcileBefore: Date.now() }, complete: false, hasMore: false, reconcilePrefixes: [], sourceUpdatedAt: 0 }
  return { records: [], sessionRecords: [], checkpoint: checkpoint as JsonlCheckpoint ?? { version: 1, files: {} }, complete: false, hasMore: true, reconcilePrefixes: [], sourceUpdatedAt: 0 }
}

async function discoverSource(kind: string, filename: string, sourceID: string, checkpoint: Record<string, unknown> | undefined, includeParts: boolean, includeToolOutput: boolean, maxRecords: number, signal?: AbortSignal, keepRemoteOnMissing = false, allowSourceShrink = false) {
  if (kind === "opencode-v1-sqlite") {
    const result = discoverOpenCodeV1(filename, sourceID, checkpoint as OpenCodeV1Checkpoint | undefined, includeParts, includeToolOutput, allowSourceShrink)
    return { ...result, sessionRecords: [], hasMore: false, reconcilePrefixes: [] as never[], sourceUpdatedAt: result.checkpoint.sourceUpdatedAt }
  }
  if (kind === "opencode-v1-sessions") return discoverOpenCodeV1Sessions(filename, sourceID, checkpoint as OpenCodeV1Checkpoint | undefined, allowSourceShrink)
  if (kind === "codex-jsonl" || kind === "pi-jsonl") return discoverJsonl(filename, sourceID, kind, checkpoint as JsonlCheckpoint | undefined, includeToolOutput, maxRecords, signal, keepRemoteOnMissing, allowSourceShrink)
  if (kind === "codex-jsonl-sessions") return discoverJsonlSessions(filename, sourceID, kind, checkpoint as JsonlSessionCheckpoint | undefined, signal, keepRemoteOnMissing, allowSourceShrink)
  throw new Error(`unsupported source adapter: ${kind}`)
}

function databaseURLFor(config: Awaited<ReturnType<typeof loadConfig>>) {
  const explicit = process.env[config.sync.database_url_env]
  if (explicit) return explicit
  const stored = syncEnvironmentValue(config.sync.database_url_env)
  if (stored) return stored
  const host = process.env.POSTGRES_HOST
  const port = process.env.POSTGRES_PORT ?? "5432"
  const database = process.env.POSTGRES_DB
  const user = process.env.DB_WRITER_USER ?? process.env.POSTGRES_USER
  const password = process.env.DB_WRITER_PASSWORD ?? process.env.POSTGRES_PASSWORD
  if (!host || !database || !user || !password) return undefined
  return buildDatabaseURL(host, port, database, user, password)
}

function adminDatabaseURLFor() {
  const explicit = process.env.OPENCODE_SYNC_ADMIN_DATABASE_URL
  if (explicit) return explicit
  const host = process.env.POSTGRES_HOST
  const port = process.env.POSTGRES_PORT ?? "5432"
  const database = process.env.POSTGRES_DB
  const user = process.env.POSTGRES_SUPERUSER_USER
  const password = process.env.POSTGRES_SUPERUSER_PASSWORD
  if (!host || !database || !user || !password) return undefined
  return buildDatabaseURL(host, port, database, user, password)
}

function buildDatabaseURL(host: string, port: string, database: string, user: string, password: string) {
  const url = new URL("postgresql://localhost")
  url.username = user
  url.password = password
  url.hostname = host
  url.port = port
  url.pathname = `/${database}`
  url.searchParams.set("sslmode", process.env.POSTGRES_SSLMODE ?? "disable")
  return url.toString()
}

function assertPostgresTLS(url: string, allowInsecureRemote = false) {
  const parsed = new URL(url)
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") throw new Error("sync database URL must use postgres:// or postgresql://")
  const local = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "::1"
  const sslmode = parsed.searchParams.get("sslmode")
  if (!local && sslmode !== "verify-full" && !allowInsecureRemote) throw new Error("refusing non-local Postgres without sslmode=verify-full; set sync.allow_insecure_remote only on a trusted network when the server has no TLS")
  if (!local && sslmode === "disable" && allowInsecureRemote) console.error("warning: Postgres credentials/session data use plaintext transport to a non-local host because sync.allow_insecure_remote=true")
}

function assertPostgresURL(url: string, allowInsecureRemote: boolean) {
  if (!url || /[\r\n]/.test(url)) throw new Error("Postgres URL must be a single non-empty line")
  let parsed: URL
  try { parsed = new URL(url) } catch { throw new Error("invalid Postgres URL") }
  if (!parsed.hostname || !parsed.pathname || parsed.pathname === "/") throw new Error("Postgres URL must include a host and database")
  assertPostgresTLS(url, allowInsecureRemote)
}

async function syncStatus() {
  console.log(`state: ${paths.state}`)
  if (!(await access(paths.state).then(() => true).catch(() => false))) {
    console.log("pending outbox: 0")
    console.log("outbox bytes: 0")
    return 0
  }
  const db = new Database(paths.state, { readonly: true })
  try {
    db.exec("pragma query_only=on; pragma busy_timeout=5000")
    const pending = db.query("select count(*) as value from outbox").get() as { value: number }
    const bytes = db.query("select coalesce(sum(length(coalesce(payload_json,'') || coalesce(routing_json,''))), 0) as value from outbox").get() as { value: number }
    console.log(`pending outbox: ${Number(pending.value)}`)
    console.log(`outbox bytes: ${Number(bytes.value)}`)
    const cache = db.query("select count(*) as rows, coalesce(sum(length(coalesce(payload_json,'') || coalesce(routing_json,''))), 0) as bytes from normalized_record").get() as { rows: number; bytes: number }
    console.log(`staged local cache: ${Number(cache.rows)} rows / ${Number(cache.bytes)} bytes`)
    const sources = db.query("select id, remote_revision_high_water, last_seen_at from source order by id").all() as Array<{ id: string; remote_revision_high_water?: number; last_seen_at: number }>
    for (const source of sources) console.log(`source ${source.id}: remote_revision=${Number(source.remote_revision_high_water ?? 0)} last_seen=${source.last_seen_at}`)
    return 0
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : ""
    if (code === "SQLITE_BUSY" || code === "SQLITE_LOCKED") {
      console.error("sync state is busy; retry status after the current write transaction")
      return 1
    }
    throw error
  } finally { db.close() }
}

async function syncPrune(confirmed: boolean, missingDirectories: boolean, blankDirectories: boolean) {
  const mode = missingDirectories && !blankDirectories ? "missing" : blankDirectories && !missingDirectories ? "blank" : undefined
  if (!confirmed || !mode) {
    console.error("This removes locally present Codex JSONL files while retaining their remote rows. Choose exactly one of --missing-directories or --blank-directories, stop the sync service, and re-run with --yes.")
    return 2
  }
  const lock = `${paths.state}.lock`
  const lockPID = await readFile(path.join(lock, "pid"), "utf8").catch(() => "")
  if (/^\d+$/.test(lockPID.trim())) {
    try {
      process.kill(Number(lockPID.trim()), 0)
      console.error("sync is running; stop it before pruning local session files")
      return 2
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error
    }
  }
  const config = await loadConfig(paths)
  if (!config.sync.enabled) { console.error("sync is disabled; configure sync before pruning"); return 2 }
  const sourceConfig = config.sources.find((source) => source.kind === "codex-jsonl")
  if (!sourceConfig) { console.error("no codex-jsonl source is configured"); return 2 }
  const root = path.resolve(sourceConfig.database.replace(/^~(?=\/|$)/, process.env.HOME ?? "."))
  const state = new Database(paths.state, { readonly: true })
  try {
    const installation = state.query("select id from installation order by created_at limit 1").get() as { id: string } | null
    const source = state.query("select id, local_revision, coalesce(remote_revision_high_water, 0) as remote_revision_high_water from source where kind=? and canonical_locator=? limit 1").get(sourceConfig.kind, root) as { id: string; local_revision: number; remote_revision_high_water: number } | null
    if (!installation || !source) { console.error("Codex source has not been synced yet"); return 2 }
    const pending = Number((state.query("select count(*) as value from outbox where source_id=? and state in ('pending', 'leased', 'failed')").get(source.id) as { value: number } | null)?.value ?? 0)
    if (pending) { console.error(`Codex source still has ${pending} local outbox rows; drain sync before pruning`); return 2 }
    if (Number(source.local_revision) !== Number(source.remote_revision_high_water)) {
      console.error(`Codex source is not fully uploaded (local revision ${source.local_revision}, remote revision ${source.remote_revision_high_water})`)
      return 2
    }
    const databaseURL = databaseURLFor(config)
    if (!databaseURL) { console.error(`missing ${config.sync.database_url_env}`); return 2 }
    assertPostgresTLS(databaseURL, config.sync.allow_insecure_remote)
    const client = openPostgres(databaseURL)
    let remoteRows: Array<{ source_path?: string; directory?: string }>
    try {
      const query = mode === "blank"
        ? "select metadata->>$3 as source_path, directory from opencode.session where installation_id=$1 and source_id=$2 and deleted_at is null and coalesce(trim(directory),$4)=$4"
        : "select metadata->>$3 as source_path, directory from opencode.session where installation_id=$1 and source_id=$2 and deleted_at is null"
      const values = mode === "blank" ? [installation.id, source.id, "source_path", ""] : [installation.id, source.id, "source_path"]
      remoteRows = await client.unsafe<Array<{ source_path?: string; directory?: string }>>(query, values)
    } finally { await client.close() }
    const resolvedRoot = path.resolve(root)
    const targets = new Map<string, { filename: string; size: number; mtimeMs: number }>()
    for (const row of remoteRows) {
      if (mode === "missing") {
        const directory = typeof row.directory === "string" ? row.directory.trim() : ""
        if (!directory) continue
        try {
          if ((await stat(directory)).isDirectory()) continue
        } catch (error) {
          const code = error && typeof error === "object" && "code" in error ? String(error.code) : ""
          if (code === "EACCES" || code === "EPERM") throw new Error(`cannot verify project directory permissions: ${directory}`)
          if (code !== "ENOENT" && code !== "ENOTDIR") continue
        }
      }
      if (!row.source_path) continue
      const filename = path.resolve(resolvedRoot, row.source_path)
      if (!filename.startsWith(`${resolvedRoot}${path.sep}`)) throw new Error(`remote source path escapes the configured Codex root: ${row.source_path}`)
      try {
        const metadata = await lstat(filename)
        if (!metadata.isFile()) continue
        targets.set(filename, { filename, size: metadata.size, mtimeMs: metadata.mtimeMs })
      } catch {}
    }
    const targetList = [...targets.values()]
    const description = mode === "missing" ? "orphan" : "blank-directory"
    if (!targetList.length) { console.log(`no locally present ${description} Codex files found`); return 0 }
    for (const target of targetList) {
      const metadata = await lstat(target.filename).catch(() => undefined)
      if (!metadata?.isFile() || metadata.size !== target.size || metadata.mtimeMs !== target.mtimeMs) {
        throw new Error(`a target changed during prune planning: ${target.filename}`)
      }
    }
    if (!config.sync.keep_remote_on_missing) {
      await saveConfig({ ...config, sync: { ...config.sync, keep_remote_on_missing: true } }, paths)
    }
    for (const target of targetList) await rm(target.filename)
    const bytes = targetList.reduce((total, target) => total + target.size, 0)
    console.log(`pruned ${targetList.length} local ${description} Codex files (${bytes} bytes); remote rows are retained by sync.keep_remote_on_missing`)
    return 0
  } catch (error) {
    console.error(`sync prune failed: ${error instanceof Error ? error.message : String(error)}`)
    return 2
  } finally { state.close() }
}

async function syncCompact(confirmed: boolean) {
  if (!confirmed) {
    console.error(`This removes acknowledged local cache rows and compacts ${paths.state}. Unsent outbox rows are preserved. Re-run with --yes.`)
    return 2
  }
  const lock = `${paths.state}.lock`
  const lockPID = await readFile(path.join(lock, "pid"), "utf8").catch(() => "")
  if (/^\d+$/.test(lockPID.trim())) {
    try { process.kill(Number(lockPID.trim()), 0); console.error("sync is running; stop it before compacting state"); return 2 } catch {}
  }
  const state = await openSyncState(paths.state)
  let removed = 0
  try {
    let batch = state.releaseAcknowledgedRecords(100_000)
    while (batch) {
      removed += batch
      batch = state.releaseAcknowledgedRecords(100_000)
    }
  } finally { state.close() }
  const db = new Database(paths.state)
  try {
    db.exec("pragma journal_mode=delete; pragma wal_checkpoint(truncate); vacuum")
  } finally { db.close() }
  console.log(`removed ${removed} acknowledged cache rows and compacted ${paths.state}`)
  return 0
}

async function syncMigrate() {
  const config = await loadConfig(paths)
  const databaseURL = adminDatabaseURLFor()
  if (!databaseURL) {
    console.error("missing POSTGRES_SUPERUSER_USER/POSTGRES_SUPERUSER_PASSWORD (or OPENCODE_SYNC_ADMIN_DATABASE_URL)")
    return 2
  }
  assertPostgresTLS(databaseURL, config.sync.allow_insecure_remote)
  const client = openPostgres(databaseURL)
  try {
    await applyRemoteMigration(client, await readFile(path.resolve(path.dirname(process.argv[1] ?? "."), "..", "db/migrations/001_init.sql"), "utf8"))
    await applyRemoteMigration(client, await readFile(path.resolve(path.dirname(process.argv[1] ?? "."), "..", "db/migrations/004_reconcile_prefix_index.sql"), "utf8"))
    console.log("applied better-compact Postgres schema and prefix-reconcile index migrations")
    return 0
  } finally {
    await client.close()
  }
}

async function ragMigrate() {
  const databaseURL = adminDatabaseURLFor()
  if (!databaseURL) {
    console.error("missing POSTGRES_SUPERUSER_USER/POSTGRES_SUPERUSER_PASSWORD (or OPENCODE_SYNC_ADMIN_DATABASE_URL)")
    return 2
  }
  const config = await loadConfig(paths)
  assertPostgresTLS(databaseURL, config.sync.allow_insecure_remote)
  const client = openPostgres(databaseURL)
  try {
    await applyRemoteMigration(client, await readFile(path.resolve(path.dirname(process.argv[1] ?? "."), "..", "db/migrations/002_rag_embedding_384.sql"), "utf8"))
    await applyRemoteMigration(client, await readFile(path.resolve(path.dirname(process.argv[1] ?? "."), "..", "db/migrations/003_rag_chunk_version.sql"), "utf8"))
    console.log("applied the 384-dimensional RAG projection and version-aware chunk migrations")
    return 0
  } finally {
    await client.close()
  }
}

async function ragStatus() {
  const config = await loadConfig(paths)
  console.log(`rag worker state: ${path.join(paths.home, "rag-state.json")}`)
  console.log(`rag configuration: ${config.rag.enabled ? "enabled" : "disabled"}, model=${config.rag.model}, chunk=${config.rag.chunk_tokens}/${config.rag.overlap}`)
  const databaseURL = ragDatabaseURLFor(config)
  if (!databaseURL) {
    console.error("missing the configured Postgres writer URL")
    return 2
  }
  try {
    assertPostgresTLS(databaseURL, config.sync.allow_insecure_remote)
    const client = openPostgres(databaseURL)
    try {
      const table = await client.unsafe<Array<{ relation: string | null }>>("select to_regclass('rag.embedding_current_384')::text as relation")
      if (!table[0]?.relation) {
        console.error("rag.embedding_current_384 is not installed; run better-compact rag migrate with admin credentials")
        return 2
      }
      const rows = await client.unsafe<Array<{ model: string; count: number; min_dimension: number; max_dimension: number; size: string }>>(`
        select embedding_model as model, count(*)::bigint as count,
          min(vector_dims(embedding_vec)) as min_dimension,
          max(vector_dims(embedding_vec)) as max_dimension,
          pg_size_pretty(pg_total_relation_size('rag.embedding_current_384')) as size
        from rag.embedding_current_384
        group by embedding_model
        order by embedding_model`)
      if (!rows.length) {
        console.log("rag.embedding_current_384: installed, empty")
        return 0
      }
      for (const row of rows) console.log(`rag.embedding_current_384: model=${row.model} rows=${Number(row.count)} dimensions=${row.min_dimension}-${row.max_dimension} size=${row.size}`)
      return 0
    } finally {
      await client.close()
    }
  } catch (error) {
    console.error(`warning: RAG database status unavailable: ${error instanceof Error ? error.message : String(error)}`)
    console.error("the embedding service may be holding the configured writer connection; use systemctl --user status better-compact-rag.service")
    return 1
  }
}

async function ragSetup() {
  try {
    const existing = await loadConfig(paths)
    const modelPath = flagValue("--model-path")
    const python = flagValue("--python")
    const model = flagValue("--model")
    const sshHost = flagValue("--ssh-host")
    const sshUser = flagValue("--ssh-user")
    const sshLocalPort = flagValue("--ssh-local-port")
    const sshRemoteHost = flagValue("--ssh-remote-host")
    const sshRemotePort = flagValue("--ssh-remote-port")
    if ([modelPath, python, model, sshHost, sshUser, sshLocalPort, sshRemoteHost, sshRemotePort].some((value) => value?.startsWith("--"))) throw new Error("RAG option values must follow their flags")
    if ((sshHost && !sshUser) || (sshUser && !sshHost)) throw new Error("--ssh-host and --ssh-user must be supplied together")
    const rag = {
      ...existing.rag,
      enabled: true,
      ...(modelPath ? { model_path: path.resolve(modelPath) } : {}),
      ...(python ? { python: path.resolve(python) } : {}),
      ...(model ? { model } : {}),
      ...(sshHost ? { ssh_host: sshHost, ssh_user: sshUser ?? "", database_url_env: "BETTER_COMPACT_RAG_DATABASE_URL" } : {}),
      ...(sshLocalPort ? { ssh_local_port: Number(sshLocalPort) } : {}),
      ...(sshRemoteHost ? { ssh_remote_host: sshRemoteHost } : {}),
      ...(sshRemotePort ? { ssh_remote_port: Number(sshRemotePort) } : {}),
    }
    await saveConfig({ ...existing, rag }, paths)
    if (sshHost) {
      const sourceURL = databaseURLFor(existing)
      if (!sourceURL) throw new Error("an existing sync database URL is required to derive the tunneled RAG URL")
      const localURL = new URL(sourceURL)
      localURL.hostname = "127.0.0.1"
      localURL.port = String(rag.ssh_local_port)
      localURL.searchParams.set("sslmode", "disable")
      await writeRagEnvironment(localURL.toString(), rag.database_url_env)
    }
    console.log(`enabled RAG worker in ${paths.config}`)
    if (rag.model_path) console.log(`RAG model path: ${rag.model_path}`)
    if (rag.python) console.log(`RAG Python runtime: ${rag.python}`)
    if (process.argv.includes("--install")) return ragInstall()
    console.log("next: run better-compact rag migrate once with admin credentials, then better-compact rag install")
    return 0
  } catch (error) {
    console.error(`rag setup failed: ${error instanceof Error ? error.message : String(error)}`)
    return 2
  }
}

async function ragRun(once: boolean) {
  const config = await loadConfig(paths)
  if (!config.rag.enabled) {
    console.error("RAG is disabled; run better-compact rag setup first")
    return 2
  }
  let worker: string
  try { worker = ragWorkerPath() } catch (error) {
    console.error(`RAG worker is unavailable: ${error instanceof Error ? error.message : String(error)}`)
    return 2
  }
  const python = ragPython(config)
  if (!path.isAbsolute(python)) console.error(`warning: RAG Python runtime is not absolute; foreground PATH resolution will be used: ${python}`)
  const args = [worker, "--config", paths.config, "--state", path.join(paths.home, "rag-state.json")]
  if (once) args.push("--once")
  const databaseURL = ragDatabaseURLFor(config)
  const environment: NodeJS.ProcessEnv = { ...process.env, PYTHONUNBUFFERED: "1" }
  if (databaseURL) environment[config.rag.database_url_env] = databaseURL
  return run(python, args, environment)
}

async function ragInstall() {
  const config = await loadConfig(paths)
  if (!config.rag.enabled) {
    console.error("RAG is disabled; run better-compact rag setup first")
    return 2
  }
  if (process.platform !== "linux") {
    console.error("RAG install currently supports systemd user services on Linux; use better-compact rag run on other platforms")
    return 2
  }
  let worker: string
  try { worker = ragWorkerPath() } catch (error) {
    console.error(`RAG worker is unavailable: ${error instanceof Error ? error.message : String(error)}`)
    return 2
  }
  const python = ragPython(config)
  if (!path.isAbsolute(python)) {
    console.error("RAG service requires an absolute Python runtime; pass --python /absolute/path during rag setup")
    return 2
  }
  if (!(await commandWorks(python, ["-c", "import psycopg, sentence_transformers"]))) {
    console.error(`RAG Python runtime is missing psycopg or sentence-transformers: ${python}`)
    return 2
  }
  const serviceDirectory = path.join(process.env.XDG_CONFIG_HOME ?? path.join(process.env.HOME ?? ".", ".config"), "systemd", "user")
  const service = path.join(serviceDirectory, "better-compact-rag.service")
  await mkdir(serviceDirectory, { recursive: true, mode: 0o700 })
  const environmentFile = await writeRagEnvironment(ragDatabaseURLFor(config), config.rag.database_url_env)
  if (config.rag.ssh_host) {
    const tunnel = await ragTunnelInstall(config)
    if (tunnel !== 0) return tunnel
  }
  const command = `${quoteSystemd(python)} ${quoteSystemd(worker)} --config ${quoteSystemd(paths.config)} --state ${quoteSystemd(path.join(paths.home, "rag-state.json"))}`
  const tunnelDependency = config.rag.ssh_host ? "After=better-compact-rag-tunnel.service\nWants=better-compact-rag-tunnel.service\n" : ""
  await writeFile(`${service}.tmp-${process.pid}`, `[Unit]\nDescription=Better Compact BGE-small RAG embeddings\nAfter=better-compact-sync.service\nWants=better-compact-sync.service\n${tunnelDependency}\n[Service]\nExecStart=${command}\n${environmentFile ? `EnvironmentFile=-${systemdEnvironmentFilePath(environmentFile)}\n` : ""}Environment=PYTHONUNBUFFERED=1\nRestart=on-failure\nRestartSec=15\nNice=10\n\n[Install]\nWantedBy=default.target\n`, { mode: 0o644 })
  await rename(`${service}.tmp-${process.pid}`, service)
  const reload = await run("systemctl", ["--user", "daemon-reload"], process.env)
  if (reload !== 0) return reload
  const enabled = await run("systemctl", ["--user", "enable", "--now", "better-compact-rag.service"], process.env)
  if (enabled === 0) console.log(`installed ${service}`)
  return enabled
}

async function ragUninstall() {
  if (process.platform !== "linux") {
    console.error("RAG uninstall currently supports systemd user services on Linux")
    return 2
  }
  const service = path.join(process.env.XDG_CONFIG_HOME ?? path.join(process.env.HOME ?? ".", ".config"), "systemd", "user", "better-compact-rag.service")
  await run("systemctl", ["--user", "disable", "--now", "better-compact-rag.service"], process.env)
  await rm(service, { force: true })
  await run("systemctl", ["--user", "daemon-reload"], process.env)
  await ragTunnelUninstall()
  console.log(`removed ${service}`)
  return 0
}

function ragPython(config: Awaited<ReturnType<typeof loadConfig>>) {
  return config.rag.python || process.env.BETTER_COMPACT_RAG_PYTHON || "python3"
}

function ragDatabaseURLFor(config: Awaited<ReturnType<typeof loadConfig>>) {
  return process.env[config.rag.database_url_env] || ragEnvironmentValue(config.rag.database_url_env) || databaseURLFor(config)
}

function ragWorkerPath() {
  const executable = path.dirname(process.argv[1] ?? ".")
  const candidates = [
    path.join(executable, "rag_worker.py"),
    path.resolve(executable, "..", "scripts", "rag_worker.py"),
    path.join(installDir, "scripts", "rag_worker.py"),
  ]
  const worker = candidates.find((candidate) => existsSync(candidate))
  if (!worker) throw new Error("scripts/rag_worker.py was not included in this installation")
  return worker
}

async function ragTunnelInstall(config: Awaited<ReturnType<typeof loadConfig>>) {
  if (!config.rag.ssh_host) return 0
  if (process.platform !== "linux") {
    console.error("RAG SSH tunnel installation currently supports systemd user services on Linux")
    return 2
  }
  if (!config.rag.ssh_user) {
    console.error("RAG SSH tunnel requires rag.ssh_user")
    return 2
  }
  const ssh = process.env.BETTER_COMPACT_RAG_SSH ?? "/usr/bin/ssh"
  if (!path.isAbsolute(ssh) || !(await exists(ssh))) {
    console.error(`RAG SSH executable is unavailable: ${ssh}`)
    return 2
  }
  const serviceDirectory = path.join(process.env.XDG_CONFIG_HOME ?? path.join(process.env.HOME ?? ".", ".config"), "systemd", "user")
  const service = path.join(serviceDirectory, "better-compact-rag-tunnel.service")
  const forward = `127.0.0.1:${config.rag.ssh_local_port}:${config.rag.ssh_remote_host}:${config.rag.ssh_remote_port}`
  const target = `${config.rag.ssh_user}@${config.rag.ssh_host}`
  await mkdir(serviceDirectory, { recursive: true, mode: 0o700 })
  await writeFile(`${service}.tmp-${process.pid}`, `[Unit]\nDescription=Better Compact encrypted PostgreSQL tunnel\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nExecStart=${quoteSystemd(ssh)} -N -o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -L ${quoteSystemd(forward)} ${quoteSystemd(target)}\nRestart=always\nRestartSec=5\n\n[Install]\nWantedBy=default.target\n`, { mode: 0o600 })
  await rename(`${service}.tmp-${process.pid}`, service)
  const reload = await run("systemctl", ["--user", "daemon-reload"], process.env)
  if (reload !== 0) return reload
  const enabled = await run("systemctl", ["--user", "enable", "--now", "better-compact-rag-tunnel.service"], process.env)
  if (enabled === 0) console.log(`installed ${service}`)
  return enabled
}

async function ragTunnelUninstall() {
  if (process.platform !== "linux") return 0
  const service = path.join(process.env.XDG_CONFIG_HOME ?? path.join(process.env.HOME ?? ".", ".config"), "systemd", "user", "better-compact-rag-tunnel.service")
  await run("systemctl", ["--user", "disable", "--now", "better-compact-rag-tunnel.service"], process.env)
  await rm(service, { force: true })
  await run("systemctl", ["--user", "daemon-reload"], process.env)
  return 0
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
  const databaseURL = databaseURLFor(config)
  if (!databaseURL) { console.error(`missing ${config.sync.database_url_env}`); return 2 }
  assertPostgresTLS(databaseURL, config.sync.allow_insecure_remote)
  const state = await openSyncState(paths.state)
  const installation = state.ensureDefaultInstallation()
  const client = openPostgres(databaseURL)
  try {
    const remoteInstallations = await client.unsafe<Array<{ incarnation: string }>>(
      "select incarnation from opencode.installation where installation_id=$1",
      [installation.id],
    )
    const remoteInstallation = remoteInstallations[0]
    if (!remoteInstallation) {
      console.error(`no remote installation exists for ${installation.id}; run sync once before adopting`)
      return 2
    }
    state.adoptInstallationIncarnation(remoteInstallation.incarnation)
    const adoptedInstallation = state.ensureDefaultInstallation()
    for (const source of config.sources) {
      if (source.kind !== "opencode-v1-sqlite") continue
      const filename = path.resolve(source.database.replace(/^~(?=\/|$)/, process.env.HOME ?? "."))
      const sourceID = createHash("sha256").update(`${source.kind}\n${filename}`).digest("hex").slice(0, 32)
      const inspection = inspectOpenCodeV1(filename)
      const sourceIncarnation = state.sourceIncarnation(sourceID)
      state.upsertSource({ id: sourceID, installationID: installation.id, kind: source.kind, schemaVersion: inspection.schemaVersion, locator: filename, fingerprint: inspection.layoutFingerprint, incarnation: sourceIncarnation })
      const fence = await readRemoteFence(client, { installationID: adoptedInstallation.id, installationIncarnation: remoteInstallation.incarnation, sourceID, incarnation: sourceIncarnation, ownerToken: workerToken, expectedRevision: state.remoteRevision(sourceID) }, true)
      state.adoptSourceIncarnation(sourceID, fence.incarnation)
      state.setRemoteRevision(sourceID, fence.revision)
      state.adoptThrough(sourceID, fence.revision)
      console.log(`adopted ${sourceID} at remote revision ${fence.revision}`)
    }
    return 0
  } finally { await client.close(); state.close() }
}

async function syncInstall(databaseURL?: string) {
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
  const environmentFile = await writeSyncEnvironment(databaseURL)
  await writeFile(`${service}.tmp-${process.pid}`, `[Unit]\nDescription=Better Compact session sync\nAfter=default.target\n\n[Service]\nExecStart=${command}\n${environmentFile ? `EnvironmentFile=-${systemdEnvironmentFilePath(environmentFile)}\n` : ""}Restart=on-failure\nRestartSec=5\n\n[Install]\nWantedBy=default.target\n`, { mode: 0o644 })
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

async function writeSyncEnvironment(databaseURL?: string, allowInsecureRemote?: boolean) {
  const config = await loadConfig(paths)
  const value = databaseURL ?? databaseURLFor(config)
  if (!value) return undefined
  assertPostgresURL(value, allowInsecureRemote ?? config.sync.allow_insecure_remote)
  await mkdir(paths.home, { recursive: true, mode: 0o700 })
  await chmod(paths.home, 0o700)
  const file = path.join(paths.home, "sync.env")
  const temporary = `${file}.tmp-${process.pid}`
  try {
    await writeFile(temporary, `${config.sync.database_url_env}=${quoteSystemd(value)}\n`, { mode: 0o600 })
    await chmod(temporary, 0o600)
    await rename(temporary, file)
  } finally { await rm(temporary, { force: true }) }
  await chmod(file, 0o600)
  return file
}

function syncEnvironmentValue(name: string) {
  return environmentValue(path.join(paths.home, "sync.env"), name)
}

function ragEnvironmentValue(name: string) {
  return environmentValue(path.join(paths.home, "rag.env"), name)
}

function environmentValue(file: string, name: string) {
  try {
    const line = readFileSync(file, "utf8").split(/\r?\n/).find((entry) => entry.startsWith(`${name}=`))
    if (!line) return undefined
    const value = line.slice(name.length + 1)
    if (value.startsWith('"') && value.endsWith('"')) {
      try {
        const decoded: unknown = JSON.parse(value)
        return typeof decoded === "string" ? decoded : undefined
      } catch { return undefined }
    }
    return value
  } catch { return undefined }
}

async function writeRagEnvironment(databaseURL: string | undefined, name: string) {
  const config = await loadConfig(paths)
  if (!databaseURL) return undefined
  assertPostgresURL(databaseURL, config.sync.allow_insecure_remote)
  await mkdir(paths.home, { recursive: true, mode: 0o700 })
  await chmod(paths.home, 0o700)
  const file = path.join(paths.home, "rag.env")
  const temporary = `${file}.tmp-${process.pid}`
  try {
    await writeFile(temporary, `${name}=${quoteSystemd(databaseURL)}\n`, { mode: 0o600 })
    await chmod(temporary, 0o600)
    await rename(temporary, file)
  } finally { await rm(temporary, { force: true }) }
  await chmod(file, 0o600)
  return file
}

function xml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\"", "&quot;").replaceAll("'", "&apos;")
}

function quoteSystemd(value: string) {
  return `"${value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`
}

function systemdEnvironmentFilePath(value: string) {
  return value.replaceAll("\\", "\\\\").replaceAll(" ", "\\s")
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
  return new Promise<number>((resolve) => {
    const child = spawn(command, args, { stdio: "inherit", env })
    child.once("error", () => resolve(127))
    child.once("exit", (code) => resolve(code ?? 1))
  })
}
