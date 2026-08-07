import { mkdir, readFile, rename, writeFile, rm } from "node:fs/promises"
import path from "node:path"

export type SyncConfig = {
  enabled: boolean
  database_url_env: string
  poll_interval_ms: number
  batch_size: number
  max_outbox_bytes: number
  include_parts: boolean
  include_tool_output: boolean
  retention_days: number
  allow_insecure_remote: boolean
}

export type SourceConfig = {
  kind: string
  database: string
}

export type BetterCompactConfig = {
  version: 1
  sync: SyncConfig
  sources: SourceConfig[]
  installation: { name: string }
}

export type ConfigPaths = {
  home: string
  config: string
  state: string
  logs: string
}

const defaults: BetterCompactConfig = {
  version: 1,
  sync: {
    enabled: false,
    database_url_env: "OPENCODE_SYNC_DATABASE_URL",
    poll_interval_ms: 2_000,
    batch_size: 100,
    max_outbox_bytes: 268_435_456,
    include_parts: true,
    include_tool_output: false,
    retention_days: 90,
    allow_insecure_remote: false,
  },
  sources: [],
  installation: { name: "default" },
}

export function configPaths(env: NodeJS.ProcessEnv = process.env): ConfigPaths {
  const home = path.resolve(env.BETTER_COMPACT_HOME ?? path.join(env.XDG_STATE_HOME ?? path.join(env.HOME ?? ".", ".local/state"), "better-compact"))
  const config = path.resolve(env.BETTER_COMPACT_CONFIG ?? path.join(env.XDG_CONFIG_HOME ?? path.join(env.HOME ?? ".", ".config"), "better-compact", "config.json"))
  const state = path.resolve(env.BETTER_COMPACT_STATE ?? path.join(home, "state.sqlite"))
  const logs = path.resolve(env.BETTER_COMPACT_LOG_DIR ?? path.join(home, "logs"))
  return { home, config, state, logs }
}

export async function loadConfig(paths = configPaths()): Promise<BetterCompactConfig> {
  let value: unknown
  try {
    value = JSON.parse(await readFile(paths.config, "utf8"))
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return structuredClone(defaults)
    throw error
  }
  return validateConfig(value)
}

export async function saveConfig(config: BetterCompactConfig, paths = configPaths()) {
  validateConfig(config)
  await mkdir(path.dirname(paths.config), { recursive: true, mode: 0o700 })
  const lock = `${paths.config}.lock`
  try { await mkdir(lock, { recursive: false, mode: 0o700 }) } catch { throw new Error(`configuration is busy: ${paths.config}`) }
  try {
    const temporary = `${paths.config}.tmp-${process.pid}`
    await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
    await rename(temporary, paths.config)
  } finally { await rm(lock, { recursive: true, force: true }) }
}

export function validateConfig(value: unknown): BetterCompactConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("better-compact config must be an object")
  const object = value as Record<string, unknown>
  const allowedRoot = new Set(["version", "sync", "sources", "installation"])
  if (Object.keys(object).some((key) => !allowedRoot.has(key))) throw new TypeError("config contains an unknown key")
  if (object.version !== 1) throw new TypeError("unsupported better-compact config version")
  if (!object.sync || typeof object.sync !== "object" || Array.isArray(object.sync)) throw new TypeError("config.sync must be an object")
  if (!Array.isArray(object.sources)) throw new TypeError("config.sources must be an array")
  const sync = object.sync as Record<string, unknown>
  const allowedSync = new Set(Object.keys(defaults.sync))
  if (Object.keys(sync).some((key) => !allowedSync.has(key))) throw new TypeError("config.sync contains an unknown key")
  const result = {
    version: 1 as const,
    sync: { ...defaults.sync, ...sync },
    sources: object.sources.map((source) => {
      if (!source || typeof source !== "object" || Array.isArray(source)) throw new TypeError("config.sources entries must be objects")
      const entry = source as Record<string, unknown>
      if (Object.keys(entry).some((key) => key !== "kind" && key !== "database")) throw new TypeError("source contains an unknown key")
      if (typeof entry.kind !== "string" || typeof entry.database !== "string") throw new TypeError("source requires kind and database")
      return { kind: entry.kind, database: entry.database }
    }),
    installation: { name: "default" },
  }
  if (object.installation && typeof object.installation === "object" && !Array.isArray(object.installation)) {
    const installation = object.installation as Record<string, unknown>
    if (Object.keys(installation).some((key) => key !== "name")) throw new TypeError("installation contains an unknown key")
    if (typeof installation.name !== "string" || !installation.name) throw new TypeError("installation.name must be a non-empty string")
    result.installation = { name: installation.name }
  }
  if (typeof result.sync.enabled !== "boolean") throw new TypeError("sync.enabled must be boolean")
  if (typeof result.sync.database_url_env !== "string" || !/^[A-Z_][A-Z0-9_]*$/.test(result.sync.database_url_env)) throw new TypeError("sync.database_url_env must be an environment variable name")
  for (const key of ["poll_interval_ms", "batch_size", "max_outbox_bytes", "retention_days"] as const) {
    if (!Number.isSafeInteger(result.sync[key]) || result.sync[key] <= 0) throw new TypeError(`sync.${key} must be a positive integer`)
  }
  if (typeof result.sync.include_parts !== "boolean" || typeof result.sync.include_tool_output !== "boolean" || typeof result.sync.allow_insecure_remote !== "boolean") throw new TypeError("sync include flags must be boolean")
  return result
}
