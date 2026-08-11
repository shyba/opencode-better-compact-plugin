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
  keep_remote_on_missing: boolean
  allow_source_shrink: boolean
}

export type RagConfig = {
  enabled: boolean
  database_url_env: string
  model: string
  model_path: string
  python: string
  ssh_host: string
  ssh_user: string
  ssh_local_port: number
  ssh_remote_host: string
  ssh_remote_port: number
  onnx_file: string
  chunk_tokens: number
  overlap: number
  batch_size: number
  message_batch_size: number
  poll_interval_ms: number
  lookback_seconds: number
  threads: number
}

export type SourceConfig = {
  kind: string
  database: string
}

export type BetterCompactConfig = {
  version: 1
  sync: SyncConfig
  rag: RagConfig
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
    keep_remote_on_missing: false,
    allow_source_shrink: false,
  },
  rag: {
    enabled: false,
    database_url_env: "OPENCODE_SYNC_DATABASE_URL",
    model: "BAAI/bge-small-en-v1.5",
    model_path: "",
    python: "",
    ssh_host: "",
    ssh_user: "",
    ssh_local_port: 15432,
    ssh_remote_host: "127.0.0.1",
    ssh_remote_port: 5432,
    onnx_file: "onnx/model_qint8_avx512_vnni.onnx",
    chunk_tokens: 512,
    overlap: 64,
    batch_size: 64,
    message_batch_size: 32,
    poll_interval_ms: 30_000,
    lookback_seconds: 900,
    threads: 16,
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
  const allowedRoot = new Set(["version", "sync", "rag", "sources", "installation"])
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
    rag: { ...defaults.rag },
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
  if (typeof result.sync.include_parts !== "boolean" || typeof result.sync.include_tool_output !== "boolean" || typeof result.sync.allow_insecure_remote !== "boolean" || typeof result.sync.keep_remote_on_missing !== "boolean" || typeof result.sync.allow_source_shrink !== "boolean") throw new TypeError("sync include flags must be boolean")
  const rag = object.rag === undefined ? {} : object.rag
  if (!rag || typeof rag !== "object" || Array.isArray(rag)) throw new TypeError("config.rag must be an object")
  const ragObject = rag as Record<string, unknown>
  const allowedRag = new Set(Object.keys(defaults.rag))
  if (Object.keys(ragObject).some((key) => !allowedRag.has(key))) throw new TypeError("config.rag contains an unknown key")
  result.rag = { ...defaults.rag, ...ragObject }
  if (typeof result.rag.enabled !== "boolean") throw new TypeError("rag.enabled must be boolean")
  if (typeof result.rag.database_url_env !== "string" || !/^[A-Z_][A-Z0-9_]*$/.test(result.rag.database_url_env)) throw new TypeError("rag.database_url_env must be an environment variable name")
  if (typeof result.rag.model !== "string" || !result.rag.model.trim()) throw new TypeError("rag.model must be a non-empty string")
  if (typeof result.rag.model_path !== "string") throw new TypeError("rag.model_path must be a string")
  if (typeof result.rag.python !== "string") throw new TypeError("rag.python must be a string")
  for (const key of ["ssh_host", "ssh_user", "ssh_remote_host"] as const) {
    if (typeof result.rag[key] !== "string") throw new TypeError(`rag.${key} must be a string`)
  }
  for (const key of ["ssh_local_port", "ssh_remote_port"] as const) {
    if (!Number.isSafeInteger(result.rag[key]) || result.rag[key] < 1 || result.rag[key] > 65_535) throw new TypeError(`rag.${key} must be a valid TCP port`)
  }
  if (typeof result.rag.onnx_file !== "string" || !result.rag.onnx_file.trim() || path.isAbsolute(result.rag.onnx_file)) throw new TypeError("rag.onnx_file must be a relative path")
  for (const key of ["chunk_tokens", "overlap", "batch_size", "message_batch_size", "poll_interval_ms", "lookback_seconds", "threads"] as const) {
    if (!Number.isSafeInteger(result.rag[key]) || result.rag[key] <= 0) throw new TypeError(`rag.${key} must be a positive integer`)
  }
  if (result.rag.overlap >= result.rag.chunk_tokens) throw new TypeError("rag.overlap must be smaller than rag.chunk_tokens")
  return result
}
