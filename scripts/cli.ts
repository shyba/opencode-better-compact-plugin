#!/usr/bin/env bun
import { access, readFile, stat } from "node:fs/promises"
import { spawn } from "node:child_process"
import path from "node:path"

const installDir = path.resolve(process.env.OPENCODE_SAFE_COMPACTION_DIR ?? path.join(process.env.HOME ?? ".", ".local/share/opencode/plugins/safe-compaction"))
const configDir = path.resolve(process.env.OPENCODE_SAFE_COMPACTION_CONFIG_DIR ?? process.env.OPENCODE_CONFIG_DIR ?? path.join(process.env.XDG_CONFIG_HOME ?? path.join(process.env.HOME ?? ".", ".config"), "opencode"))
const databasePath = path.resolve(process.env.OPENCODE_DB ?? path.join(process.env.XDG_DATA_HOME ?? path.join(process.env.HOME ?? ".", ".local/share"), "opencode", "opencode.db"))

const command = process.argv[2] ?? "help"
if (command === "help" || command === "--help" || command === "-h") {
  printHelp()
  process.exit(0)
}
if (command === "update") {
  await update()
  process.exit(0)
}
if (command === "doctor") {
  process.exit(await doctor())
}
console.error(`Unknown command: ${command}`)
printHelp()
process.exit(2)

function printHelp() {
  console.log(`better-compact - OpenCode safe-compaction maintenance

Usage:
  better-compact update   Update the managed checkout and verify configuration
  better-compact doctor   Check installation, OpenCode, configuration, and SQLite access
  better-compact help     Show this help

Environment overrides:
  OPENCODE_SAFE_COMPACTION_DIR
  OPENCODE_SAFE_COMPACTION_CONFIG_DIR
  OPENCODE_SAFE_COMPACTION_OPENCODE
  OPENCODE_SAFE_COMPACTION_BUN
  OPENCODE_DB`)
}

async function update() {
  await access(path.join(installDir, "install.sh"))
  const result = await run("sh", [path.join(installDir, "install.sh")], process.env)
  if (result !== 0) process.exit(result)
}

async function doctor() {
  const checks: Array<[string, boolean, string]> = []
  checks.push(["managed checkout", await exists(path.join(installDir, ".git")), installDir])
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
