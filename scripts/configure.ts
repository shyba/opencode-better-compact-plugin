import { chmod, copyFile, mkdir, open, rename, rm, stat } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"

const configInput = requiredEnvironment("OPENCODE_SAFE_COMPACTION_CONFIG_DIR")
const installInput = requiredEnvironment("OPENCODE_SAFE_COMPACTION_DIR")
const configDir = path.resolve(configInput)
const installDir = path.resolve(installInput)
const model = requiredEnvironment("OPENCODE_SAFE_COMPACTION_MODEL")
const action = process.env.OPENCODE_SAFE_COMPACTION_ACTION ?? "apply"
const stateFile = process.env.OPENCODE_SAFE_COMPACTION_STATE_FILE
const verificationInput = process.env.OPENCODE_SAFE_COMPACTION_VERIFY_DIR
const verificationDir = verificationInput ? path.resolve(verificationInput) : undefined

if (!path.isAbsolute(configInput)) throw new TypeError(`Config directory must be absolute: ${configInput}`)
if (!path.isAbsolute(installInput)) throw new TypeError(`Install directory must be absolute: ${installInput}`)
if (configDir === path.parse(configDir).root) throw new TypeError(`Config directory is unsafe: ${configDir}`)
if (installDir === path.parse(installDir).root || (process.env.HOME && installDir === path.resolve(process.env.HOME))) {
  throw new TypeError(`Install directory is unsafe: ${installDir}`)
}
if (!/^[^/\s]+\/[^\s]+$/.test(model)) throw new TypeError(`Model must use provider/model format: ${model}`)
if (stateFile && !path.isAbsolute(stateFile)) throw new TypeError(`Transaction state path must be absolute: ${stateFile}`)
if (verificationInput && !path.isAbsolute(verificationInput)) {
  throw new TypeError(`Verification directory must be absolute: ${verificationInput}`)
}
if (verificationDir === path.parse(verificationDir ?? "relative").root) {
  throw new TypeError(`Verification directory is unsafe: ${verificationDir}`)
}

if (action === "verify") {
  await verifyResolvedConfig()
  process.exit(0)
}
await mkdir(configDir, { recursive: true })
if (action === "rollback") {
  await withConfigLock(() => rollbackTransaction(requiredStateFile()))
  process.exit(0)
}
if (action === "commit") {
  await rm(requiredStateFile(), { force: true })
  process.exit(0)
}
if (action !== "apply") throw new TypeError(`Unknown configure action: ${action}`)

await withConfigLock(configure)

async function configure() {
  const source = path.join(installDir, "src/index.ts")
  const names = ["config.json", "opencode.json", "opencode.jsonc"]
  const existing = (
    await Promise.all(
      names.map(async (name) => {
        const file = path.join(configDir, name)
        if (!(await Bun.file(file).exists())) return
        const text = await Bun.file(file).text()
        return { file, text, value: parseConfig(text, file) }
      }),
    )
  ).filter((item) => item !== undefined)
  const merged = existing.reduce<Record<string, unknown>>(
    (result, config) => mergeConfig(result, config.value),
    {},
  )

  for (const config of existing) {
    if (hasStaleDeepseekLimit(config.value)) {
      throw new Error(
        `Remove the deepseek-v4-flash-free limit override from ${config.file}, then rerun the installer. ` +
          "The installer does not rewrite provider catalogs.",
      )
    }
    if (config.value.plugin !== undefined && !Array.isArray(config.value.plugin)) {
      throw new TypeError(`OpenCode "plugin" configuration must be an array: ${config.file}`)
    }
  }

  const installed = existing.flatMap((config) => pluginSpecs(config.value).map((spec) => ({ file: config.file, spec })))
  const conflict = installed.find((item) => isSafeCompaction(item.spec) && pluginSource(item.spec) !== source)
  if (conflict) {
    throw new Error(`A different safe-compaction plugin entry already exists in ${conflict.file}; remove it and rerun`)
  }

  const matching = installed.filter((item) => pluginSource(item.spec) === source)
  if (matching.length > 1) throw new Error("The safe-compaction plugin is configured more than once; keep one entry and rerun")
  if (matching.length === 1) {
    const options = tupleOptions(matching[0]!.spec, matching[0]!.file)
    const expectations = await preflight(source, options, merged)
    if (options.model !== model) {
      throw new Error(
        `The existing safe-compaction entry in ${matching[0]!.file} does not select ${model}; edit or remove it and rerun`,
      )
    }
    await writeVerificationConfig(source, options, expectations)
    console.log(`Configuration already contains ${source}`)
    return
  }

  const target = existing.at(-1) ?? {
    file: path.join(configDir, "opencode.jsonc"),
    text: '{\n  "$schema": "https://opencode.ai/config.json"\n}\n',
    value: { $schema: "https://opencode.ai/config.json" },
  }
  const options = {
    model,
    tail_turns: 4,
    preserve_recent_tokens: 16_000,
    reserved_tokens: 32_000,
    max_output_tokens: 16_384,
    max_user_text_bytes: 524_288,
    max_inline_data_bytes: 10_485_760,
    max_historical_part_bytes: 131_072,
    max_ledger_bytes: 12_288,
    max_summary_bytes: 49_152,
  }
  const expectations = await preflight(source, options, merged)
  await writeVerificationConfig(source, options, expectations)
  const output = addPlugin(target.text, target.value, [source, options])
  const existed = await Bun.file(target.file).exists()
  const backup = existed ? `${target.file}.safe-compaction-backup-${Date.now()}-${process.pid}` : undefined
  const originalMode = existed ? (await stat(target.file)).mode & 0o777 : undefined
  const mode = 0o600
  const originalDigest = existed ? sha256(target.text) : undefined
  if (backup) {
    await copyFile(target.file, backup)
    await chmod(backup, 0o600)
  }
  try {
    await atomicWrite(target.file, output, mode)
    if (stateFile) {
      await atomicWrite(
        stateFile,
        JSON.stringify({
          version: 1,
          target: target.file,
          ...(backup ? { backup } : {}),
          existed,
          ...(originalDigest ? { originalDigest } : {}),
          ...(originalMode === undefined ? {} : { originalMode }),
          appliedDigest: sha256(output),
        } satisfies TransactionState),
        0o600,
      )
    }
  } catch (error) {
    if (existed && backup) await atomicRestore(backup, target.file, originalMode ?? mode)
    if (!existed) await rm(target.file, { force: true })
    if (backup) await rm(backup, { force: true })
    if (stateFile) await rm(stateFile, { force: true })
    throw error
  }

  console.log(`Configured ${target.file}`)
  if (backup) console.log(`Backup: ${backup}`)
}

async function writeVerificationConfig(
  source: string,
  options: Record<string, unknown>,
  expectations: VerificationExpectations,
) {
  if (!verificationDir) return
  await atomicWrite(
    path.join(verificationDir, "opencode.jsonc"),
    `${JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      plugin: [[source, options]],
    }, null, 2)}\n`,
    0o600,
  )
  await atomicWrite(path.join(verificationDir, "expectations.json"), `${JSON.stringify(expectations, null, 2)}\n`, 0o600)
}

async function verifyResolvedConfig() {
  const text = await Bun.stdin.text()
  const value: unknown = JSON.parse(text)
  if (!isRecord(value)) throw new TypeError("OpenCode debug config did not return an object")
  const source = path.join(installDir, "src/index.ts")
  if (!pluginSpecs(value).some((spec) => samePluginSource(pluginSource(spec), source))) {
    throw new Error(`OpenCode did not report the installed plugin path: ${source}`)
  }
  if (!verificationDir) throw new TypeError("OPENCODE_SAFE_COMPACTION_VERIFY_DIR must be set for verification")
  const phase = process.env.OPENCODE_SAFE_COMPACTION_VERIFY_PHASE
  if (phase !== "isolated" && phase !== "target") {
    throw new TypeError("OPENCODE_SAFE_COMPACTION_VERIFY_PHASE must be isolated or target")
  }
  const expectations: unknown = JSON.parse(await Bun.file(path.join(verificationDir, "expectations.json")).text())
  if (!isVerificationExpectations(expectations)) throw new TypeError("Invalid installer verification expectations")
  const expected = expectations[phase]
  const agent = isRecord(value.agent) ? value.agent : undefined
  const compactionAgent = isRecord(agent?.compaction) ? agent.compaction : undefined
  if (compactionAgent?.model !== expected.model || compactionAgent.temperature !== expected.temperature) {
    throw new Error(`OpenCode did not activate the safe-compaction config hook for ${model}`)
  }
  const compaction = isRecord(value.compaction) ? value.compaction : undefined
  if (
    !matchesBoolean(compaction?.auto, expected.auto) ||
    !matchesBoolean(compaction?.prune, expected.prune) ||
    !matchesTailTurns(compaction?.tail_turns, expected.tail_turns) ||
    !matchesPositiveInteger(compaction?.preserve_recent_tokens, expected.preserve_recent_tokens) ||
    !matchesPositiveInteger(compaction?.reserved, expected.reserved)
  ) {
    throw new Error("OpenCode did not preserve the safe-compaction thresholds and continuation settings")
  }
  console.log(`Verified ${source}`)
}

type TransactionState = {
  version: 1
  target: string
  backup?: string
  existed: boolean
  originalDigest?: string
  originalMode?: number
  appliedDigest: string
}

type ExpectedConfig = {
  model: string
  temperature: 0
  auto: boolean | null
  prune: boolean | null
  tail_turns: number | null
  preserve_recent_tokens: number | null
  reserved: number | null
}

type VerificationExpectations = {
  isolated: ExpectedConfig
  target: ExpectedConfig
}

async function rollbackTransaction(file: string) {
  if (!(await Bun.file(file).exists())) return
  const value: unknown = JSON.parse(await Bun.file(file).text())
  if (!isTransactionState(value)) throw new TypeError(`Invalid installer transaction state: ${file}`)
  if (path.dirname(value.target) !== configDir || (value.backup && path.dirname(value.backup) !== configDir)) {
    throw new Error("Installer transaction targets escape the configured directory")
  }
  const currentExists = await Bun.file(value.target).exists()
  const currentDigest = currentExists ? sha256(await Bun.file(value.target).text()) : undefined
  const unchanged = value.existed
    ? currentDigest === value.originalDigest
    : !currentExists
  if (!unchanged && currentDigest !== value.appliedDigest) {
    throw new Error(`Refusing to overwrite a concurrently modified configuration: ${value.target}`)
  }
  if (!unchanged && value.existed) {
    if (!value.backup || !(await Bun.file(value.backup).exists())) {
      throw new Error(`Configuration backup is missing: ${value.backup ?? "unknown"}`)
    }
    await atomicRestore(value.backup, value.target, value.originalMode ?? 0o600)
  }
  if (!unchanged && !value.existed) await rm(value.target, { force: true })
  if (value.backup) await rm(value.backup, { force: true })
  await rm(file, { force: true })
  console.log(`Rolled back ${value.target}`)
}

function isTransactionState(value: unknown): value is TransactionState {
  if (!isRecord(value)) return false
  return (
    value.version === 1 &&
    typeof value.target === "string" &&
    path.isAbsolute(value.target) &&
    typeof value.existed === "boolean" &&
    typeof value.appliedDigest === "string" &&
    (value.backup === undefined || (typeof value.backup === "string" && path.isAbsolute(value.backup))) &&
    (value.originalDigest === undefined || typeof value.originalDigest === "string") &&
    (value.originalMode === undefined ||
      (typeof value.originalMode === "number" &&
        Number.isSafeInteger(value.originalMode) &&
        value.originalMode >= 0 &&
        value.originalMode <= 0o777))
  )
}

async function preflight(source: string, options: Record<string, unknown>, currentConfig: Record<string, unknown>) {
  let hooks: Record<string, unknown> | undefined
  try {
    const module: unknown = await import(`${pathToFileURL(source).href}?installer-preflight=${Date.now()}-${process.pid}`)
    const imported = isRecord(module) ? module : undefined
    const plugin = isRecord(imported?.default) ? imported.default : undefined
    if (plugin?.id !== "opencode-safe-compaction" || typeof plugin.server !== "function") {
      throw new TypeError(`Plugin module does not export the expected server: ${source}`)
    }
    const created: unknown = await plugin.server({ client: {} }, options)
    if (!isRecord(created) || typeof created.config !== "function") {
      throw new TypeError(`Plugin server did not return a config hook: ${source}`)
    }
    hooks = created
    const target = structuredClone(currentConfig)
    await created.config(target)
    const isolated: Record<string, unknown> = {
      $schema: "https://opencode.ai/config.json",
      plugin: [[source, options]],
    }
    await created.config(isolated)
    const targetExpectation = expectedConfig(target, source, options.model)
    return {
      isolated: expectedConfig(isolated, source, options.model),
      target: {
        ...targetExpectation,
        auto: null,
        prune: null,
        tail_turns: typeof options.tail_turns === "number" ? targetExpectation.tail_turns : null,
        preserve_recent_tokens:
          typeof options.preserve_recent_tokens === "number" ? targetExpectation.preserve_recent_tokens : null,
        reserved: typeof options.reserved_tokens === "number" ? targetExpectation.reserved : null,
      },
    }
  } catch (error) {
    throw new Error(`Plugin activation preflight failed for ${source}: ${errorText(error)}`)
  } finally {
    if (typeof hooks?.dispose === "function") await hooks.dispose()
  }
}

function expectedConfig(value: Record<string, unknown>, source: string, selectedModel: unknown): ExpectedConfig {
  const agent = isRecord(value.agent) ? value.agent : undefined
  const compactionAgent = isRecord(agent?.compaction) ? agent.compaction : undefined
  const compaction = isRecord(value.compaction) ? value.compaction : undefined
  const expected = {
    model: compactionAgent?.model,
    temperature: compactionAgent?.temperature,
    auto: compaction?.auto,
    prune: compaction?.prune,
    tail_turns: compaction?.tail_turns,
    preserve_recent_tokens: compaction?.preserve_recent_tokens,
    reserved: compaction?.reserved,
  }
  if (!isExpectedConfig(expected) || expected.model !== selectedModel) {
    throw new Error(`Plugin config hook did not activate the selected compaction settings: ${source}`)
  }
  return expected
}

function isVerificationExpectations(value: unknown): value is VerificationExpectations {
  return isRecord(value) && isExpectedConfig(value.isolated) && isExpectedConfig(value.target)
}

function isExpectedConfig(value: unknown): value is ExpectedConfig {
  if (!isRecord(value)) return false
  return (
    typeof value.model === "string" &&
    value.temperature === 0 &&
    (typeof value.auto === "boolean" || value.auto === null) &&
    (typeof value.prune === "boolean" || value.prune === null) &&
    (value.tail_turns === null || isNonNegativeInteger(value.tail_turns)) &&
    (value.preserve_recent_tokens === null || isPositiveInteger(value.preserve_recent_tokens)) &&
    (value.reserved === null || isPositiveInteger(value.reserved))
  )
}

function matchesBoolean(value: unknown, expected: boolean | null) {
  return expected === null ? typeof value === "boolean" : value === expected
}

function matchesTailTurns(value: unknown, expected: number | null) {
  return expected === null ? isNonNegativeInteger(value) && value <= 64 : value === expected
}

function matchesPositiveInteger(value: unknown, expected: number | null) {
  return expected === null ? isPositiveInteger(value) : value === expected
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

function isPositiveInteger(value: unknown) {
  return isNonNegativeInteger(value) && value > 0
}

function tupleOptions(spec: unknown, file: string) {
  if (!Array.isArray(spec) || spec.length !== 2 || !isRecord(spec[1])) {
    throw new TypeError(`The existing safe-compaction entry in ${file} must be a [source, options] tuple`)
  }
  return spec[1]
}

async function withConfigLock<T>(operation: () => Promise<T>) {
  const lock = path.join(configDir, ".opencode-safe-compaction.lock")
  const started = Date.now()
  while (true) {
    try {
      await mkdir(lock, { mode: 0o700 })
      break
    } catch (error) {
      if (!isCode(error, "EEXIST")) throw error
      const age = Date.now() - (await stat(lock).catch(() => ({ mtimeMs: Date.now() }))).mtimeMs
      if (age > 300_000) {
        await rm(lock, { recursive: true, force: true })
        continue
      }
      if (Date.now() - started >= 30_000) throw new Error(`Timed out waiting for configuration lock: ${lock}`)
      await Bun.sleep(25)
    }
  }
  try {
    return await operation()
  } finally {
    await rm(lock, { recursive: true, force: true })
  }
}

async function atomicWrite(file: string, value: string, mode: number) {
  await mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.safe-compaction-${process.pid}-${crypto.randomUUID()}.tmp`
  const handle = await open(temporary, "wx", mode)
  try {
    try {
      await handle.writeFile(value)
    } finally {
      await handle.close()
    }
    await rename(temporary, file)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}

async function atomicRestore(backup: string, target: string, mode: number) {
  const temporary = `${target}.safe-compaction-restore-${process.pid}-${crypto.randomUUID()}.tmp`
  await copyFile(backup, temporary)
  try {
    await chmod(temporary, mode)
    await rename(temporary, target)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}

function sha256(value: string) {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex")
}

function requiredStateFile() {
  if (!stateFile) throw new TypeError("OPENCODE_SAFE_COMPACTION_STATE_FILE must be set for this action")
  return stateFile
}

function isCode(value: unknown, code: string) {
  return isRecord(value) && value.code === code
}

function errorText(value: unknown) {
  return value instanceof Error ? value.message : String(value)
}

function requiredEnvironment(name: string) {
  const value = process.env[name]
  if (!value) throw new TypeError(`${name} must be set`)
  return value
}

function parseConfig(text: string, file: string) {
  const tokens = tokenize(text)
  if (tokens[0]?.value !== "{") throw new TypeError(`OpenCode configuration must be an object: ${file}`)
  if (rootProperties(tokens).filter((item) => item.key === "plugin").length > 1) {
    throw new TypeError(`OpenCode configuration contains duplicate root "plugin" keys: ${file}`)
  }
  const value: unknown = Bun.JSONC.parse(text)
  if (!isRecord(value)) throw new TypeError(`OpenCode configuration must be an object: ${file}`)
  return value
}

// OpenCode loads these global files from config.json through opencode.jsonc and
// recursively lets the later file win. Arrays are replaced; the plugin hook only
// reads the merged agent and compaction objects.
function mergeConfig(target: Record<string, unknown>, source: Record<string, unknown>) {
  return Object.entries(source).reduce<Record<string, unknown>>((result, [key, value]) => {
    Object.defineProperty(result, key, {
      configurable: true,
      enumerable: true,
      writable: true,
      value: isRecord(result[key]) && isRecord(value) ? mergeConfig(result[key], value) : structuredClone(value),
    })
    return result
  }, Object.assign(Object.create(null) as Record<string, unknown>, target))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function hasStaleDeepseekLimit(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasStaleDeepseekLimit)
  if (!isRecord(value)) return false
  if (isRecord(value["deepseek-v4-flash-free"]) && "limit" in value["deepseek-v4-flash-free"]) return true
  return Object.values(value).some(hasStaleDeepseekLimit)
}

function pluginSpecs(value: Record<string, unknown>) {
  return Array.isArray(value.plugin) ? value.plugin : []
}

function pluginSource(spec: unknown) {
  if (typeof spec === "string") return spec
  if (Array.isArray(spec) && typeof spec[0] === "string") return spec[0]
  return undefined
}

function samePluginSource(value: string | undefined, source: string) {
  return value === source || value === pathToFileURL(source).href
}

function isSafeCompaction(spec: unknown) {
  const value = pluginSource(spec)
  if (!value) return false
  return /(?:^|[/:])(?:opencode-safe-compaction(?:@[^/?#]*)?|safe-compaction|opencode-better-compact-plugin(?:\.git)?)(?:[/?#]|$)/.test(
    value,
  )
}

type Token = {
  kind: "string" | "punctuation" | "atom"
  value: string
  start: number
  end: number
}

function addPlugin(text: string, value: Record<string, unknown>, entry: unknown[]) {
  const tokens = tokenize(text)
  if (tokens[0]?.value !== "{") throw new TypeError("OpenCode configuration must start with an object")
  const properties = rootProperties(tokens)
  const plugin = properties.find((item) => item.key === "plugin")
  if (plugin) {
    if (tokens[plugin.value]?.value !== "[") throw new TypeError('OpenCode "plugin" configuration must be an array')
    const close = matchingClose(tokens, plugin.value)
    return insertArrayValue(text, tokens, plugin.value, close, entry)
  }

  const close = matchingClose(tokens, 0)
  const previous = tokens[close - 1]
  if (!previous) throw new TypeError("Could not locate the OpenCode configuration object")
  const indentation = lineIndentation(text, tokens[close]!.start)
  const propertyIndentation = `${indentation}  `
  const block = `${propertyIndentation}"plugin": [\n${indent(JSON.stringify(entry, null, 2), `${propertyIndentation}  `)}\n${propertyIndentation}]`
  const separator = previous.value === "{" || previous.value === "," ? "" : ","
  const output = `${text.slice(0, previous.end)}${separator}\n${block}${text.slice(previous.end)}`
  parseConfig(output, "updated configuration")
  return output
}

function insertArrayValue(text: string, tokens: Token[], open: number, close: number, entry: unknown[]) {
  const previous = tokens[close - 1]
  if (!previous) throw new TypeError("Could not locate the OpenCode plugin array")
  const indentation = lineIndentation(text, tokens[close]!.start)
  const entryIndentation = `${indentation}  `
  const block = indent(JSON.stringify(entry, null, 2), entryIndentation)
  const separator = previous.value === "[" || previous.value === "," ? "" : ","
  const insertAt = previous.value === "[" ? tokens[open]!.end : previous.end
  const output = `${text.slice(0, insertAt)}${separator}\n${block}${text.slice(insertAt)}`
  parseConfig(output, "updated configuration")
  return output
}

function rootProperties(tokens: Token[]) {
  const result: { key: string; value: number }[] = []
  const close = matchingClose(tokens, 0)
  let index = 1
  while (index < close && tokens[index]?.value !== "}") {
    const key = tokens[index]
    const colon = tokens[index + 1]
    if (key?.kind !== "string" || colon?.value !== ":") throw new TypeError("Invalid top-level OpenCode configuration")
    const value = index + 2
    result.push({ key: key.value, value })
    const next = skipValue(tokens, value)
    if (tokens[next]?.value === ",") {
      index = next + 1
      continue
    }
    if (tokens[next]?.value === "}") break
    throw new TypeError("Invalid top-level OpenCode configuration")
  }
  return result
}

function skipValue(tokens: Token[], index: number) {
  const value = tokens[index]?.value
  if (value === "{" || value === "[") return matchingClose(tokens, index) + 1
  if (!tokens[index]) throw new TypeError("Missing OpenCode configuration value")
  return index + 1
}

function matchingClose(tokens: Token[], open: number) {
  const opening = tokens[open]?.value
  const closing = opening === "{" ? "}" : opening === "[" ? "]" : undefined
  if (!closing) throw new TypeError("Expected an object or array")
  let depth = 1
  for (let index = open + 1; index < tokens.length; index++) {
    const token = tokens[index]
    if (token?.value === opening) depth++
    if (token?.value !== closing) continue
    depth--
    if (depth === 0) return index
  }
  throw new TypeError("Unclosed object or array in OpenCode configuration")
}

function tokenize(text: string) {
  const tokens: Token[] = []
  let index = 0
  while (index < text.length) {
    if (/\s/.test(text[index]!)) {
      index++
      continue
    }
    if (text.startsWith("//", index)) {
      const end = text.indexOf("\n", index + 2)
      index = end === -1 ? text.length : end + 1
      continue
    }
    if (text.startsWith("/*", index)) {
      const end = text.indexOf("*/", index + 2)
      if (end === -1) throw new TypeError("Unclosed comment in OpenCode configuration")
      index = end + 2
      continue
    }
    if (text[index] === '"') {
      const end = stringEnd(text, index + 1)
      tokens.push({ kind: "string", value: JSON.parse(text.slice(index, end)), start: index, end })
      index = end
      continue
    }
    if ("{}[]:,".includes(text[index]!)) {
      tokens.push({ kind: "punctuation", value: text[index]!, start: index, end: index + 1 })
      index++
      continue
    }
    const match = /^[^\s{}\[\]:,]+/.exec(text.slice(index))
    if (!match) throw new TypeError(`Invalid OpenCode configuration near byte ${index}`)
    tokens.push({ kind: "atom", value: match[0], start: index, end: index + match[0].length })
    index += match[0].length
  }
  return tokens
}

function stringEnd(text: string, start: number) {
  for (let index = start; index < text.length; index++) {
    if (text[index] === "\\") {
      index++
      continue
    }
    if (text[index] === '"') return index + 1
  }
  throw new TypeError("Unclosed string in OpenCode configuration")
}

function lineIndentation(text: string, index: number) {
  const start = text.lastIndexOf("\n", index - 1) + 1
  return /^\s*/.exec(text.slice(start, index))?.[0] ?? ""
}

function indent(value: string, indentation: string) {
  return value
    .split("\n")
    .map((line) => `${indentation}${line}`)
    .join("\n")
}
