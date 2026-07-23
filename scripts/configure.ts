import { chmod, copyFile, mkdir, open, rename, rm, stat } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const configInput = requiredEnvironment("OPENCODE_SAFE_COMPACTION_CONFIG_DIR")
const installInput = requiredEnvironment("OPENCODE_SAFE_COMPACTION_DIR")
const configDir = path.resolve(configInput)
const installDir = path.resolve(installInput)
const model = requiredEnvironment("OPENCODE_SAFE_COMPACTION_MODEL")
const modelExplicitInput = process.env.OPENCODE_SAFE_COMPACTION_MODEL_EXPLICIT ?? "1"
const modelExplicit = modelExplicitInput !== "0"
const preserveSourceInput = process.env.OPENCODE_SAFE_COMPACTION_PRESERVE_SOURCE ?? "0"
const preserveSource = preserveSourceInput === "1"
const serverEntryInput = process.env.OPENCODE_SAFE_COMPACTION_SERVER_ENTRY
const tuiEntryInput = process.env.OPENCODE_SAFE_COMPACTION_TUI_ENTRY
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
if (model !== "selected" && !/^[^/\s]+\/[^\s]+$/.test(model)) {
  throw new TypeError(`Model must be "selected" or use provider/model format: ${model}`)
}
if (modelExplicitInput !== "0" && modelExplicitInput !== "1") {
  throw new TypeError("OPENCODE_SAFE_COMPACTION_MODEL_EXPLICIT must be 0 or 1")
}
if (preserveSourceInput !== "0" && preserveSourceInput !== "1") {
  throw new TypeError("OPENCODE_SAFE_COMPACTION_PRESERVE_SOURCE must be 0 or 1")
}
if (serverEntryInput && !path.isAbsolute(serverEntryInput)) {
  throw new TypeError(`Server entry must be absolute: ${serverEntryInput}`)
}
if (tuiEntryInput && !path.isAbsolute(tuiEntryInput)) {
  throw new TypeError(`TUI entry must be absolute: ${tuiEntryInput}`)
}
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
  const managedSource = path.join(installDir, "runtime")
  const serverSource = serverEntryInput ?? path.join(managedSource, "server.js")
  const existing = await readConfigs(["config.json", "opencode.json", "opencode.jsonc"])
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

  const installed = existing.flatMap((config) =>
    pluginSpecs(config.value).map((spec) => ({ config, spec }))
  )
  const safeCompaction = installed.filter((item) =>
    isSafeCompaction(item.spec) || samePluginSource(pluginSource(item.spec), managedSource)
  )
  if (safeCompaction.length > 1) {
    throw new Error("The safe-compaction plugin is configured more than once; keep one entry and rerun")
  }
  const installedSafeCompaction = safeCompaction[0]
  if (preserveSource && !installedSafeCompaction) {
    throw new Error("The live compaction-model selector could not find the installed server tuple")
  }
  const source = preserveSource
    ? pluginSource(installedSafeCompaction?.spec) ?? managedSource
    : managedSource
  const target = installedSafeCompaction?.config ?? existing.at(-1) ?? {
    file: path.join(configDir, "opencode.jsonc"),
    text: '{\n  "$schema": "https://opencode.ai/config.json"\n}\n',
    value: { $schema: "https://opencode.ai/config.json" },
  }
  const previousSource = installedSafeCompaction ? pluginSource(installedSafeCompaction.spec) : undefined
  const currentOptions = installedSafeCompaction
    ? tupleOptions(installedSafeCompaction.spec, target.file)
    : undefined
  const selectedModel = modelExplicit || typeof currentOptions?.model !== "string" ? model : currentOptions.model
  const options = currentOptions
    ? { ...currentOptions, model: selectedModel }
    : {
      model: selectedModel,
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
  if (previousSource && !samePluginSource(previousSource, source)) {
    await verifyExistingPluginIdentity(previousSource, target.file, "server")
  }
  const expectations = await preflight(source, serverSource, options, merged)
  await verifyTuiEntrypoint(source, tuiEntryInput ?? path.join(managedSource, "tui.js"))
  await writeVerificationConfig(source, options, expectations)
  const output = previousSource
    ? replacePluginModel(
        samePluginSource(previousSource, source)
          ? target.text
          : replacePluginSource(target.text, previousSource, source),
        samePluginSource(previousSource, source) ? previousSource : source,
        selectedModel,
      )
    : addPlugin(target.text, target.value, [source, options])

  const tuiExisting = await readConfigs(["tui.json", "tui.jsonc"])
  for (const config of tuiExisting) {
    if (config.value.plugin !== undefined && !Array.isArray(config.value.plugin)) {
      throw new TypeError(`OpenCode TUI "plugin" configuration must be an array: ${config.file}`)
    }
  }
  const installedTui = tuiExisting
    .flatMap((config) => pluginSpecs(config.value).map((spec) => ({ config, spec })))
    .filter((item) =>
      isSafeCompaction(item.spec) ||
      samePluginSource(pluginSource(item.spec), source) ||
      samePluginSource(pluginSource(item.spec), managedSource)
    )
  if (installedTui.length > 1) {
    throw new Error("The safe-compaction TUI plugin is configured more than once; keep one entry and rerun")
  }
  const currentTui = installedTui[0]
  if (preserveSource && !currentTui) {
    throw new Error("The live compaction-model selector could not find the installed TUI tuple")
  }
  const tuiTarget = currentTui?.config ?? tuiExisting.at(-1) ?? {
    file: path.join(configDir, "tui.jsonc"),
    text: "{\n}\n",
    value: {},
  }
  const previousTuiSource = currentTui ? pluginSource(currentTui.spec) : undefined
  const tuiOptions = currentTui
    ? { ...tupleOptions(currentTui.spec, tuiTarget.file), model: selectedModel }
    : { model: selectedModel }
  if (previousTuiSource && !samePluginSource(previousTuiSource, source)) {
    if (preserveSource) throw new Error("The server and TUI plugin entries use different sources")
    await verifyExistingPluginIdentity(previousTuiSource, tuiTarget.file, "tui")
  }
  const tuiOutput = previousTuiSource
    ? replacePluginModel(
        samePluginSource(previousTuiSource, source)
          ? tuiTarget.text
          : replacePluginSource(tuiTarget.text, previousTuiSource, source),
        samePluginSource(previousTuiSource, source) ? previousTuiSource : source,
        selectedModel,
      )
    : addPlugin(tuiTarget.text, tuiTarget.value, [source, tuiOptions])

  await writeConfiguredFiles([
    { file: target.file, original: target.text, output },
    { file: tuiTarget.file, original: tuiTarget.text, output: tuiOutput },
  ])
  if (previousSource && !samePluginSource(previousSource, source)) {
    console.log(`Migrated ${previousSource} to ${source}`)
    return
  }
  if (currentOptions?.model !== selectedModel) {
    console.log(`Updated the safe-compaction model to ${selectedModel}`)
    return
  }
  if (!previousSource) {
    console.log(`Configured ${target.file}`)
    return
  }
  console.log(`Configuration already contains ${source}`)
}

async function readConfigs(names: string[]) {
  return (
    await Promise.all(
      names.map(async (name) => {
        const file = path.join(configDir, name)
        if (!(await Bun.file(file).exists())) return
        const text = await Bun.file(file).text()
        return { file, text, value: parseConfig(text, file) }
      }),
    )
  ).filter((item) => item !== undefined)
}

async function writeConfiguredFiles(edits: ConfigEdit[]) {
  const changed = edits.filter((edit) => edit.original !== edit.output)
  if (!changed.length) return
  const stamp = `${Date.now()}-${process.pid}`
  const targets = await Promise.all(
    changed.map(async (edit) => {
      const existed = await Bun.file(edit.file).exists()
      const originalMode = existed ? (await stat(edit.file)).mode & 0o777 : undefined
      return {
        target: edit.file,
        ...(existed ? { backup: `${edit.file}.safe-compaction-backup-${stamp}` } : {}),
        existed,
        ...(existed ? { originalDigest: sha256(edit.original) } : {}),
        ...(originalMode === undefined ? {} : { originalMode }),
        appliedDigest: sha256(edit.output),
        output: edit.output,
      }
    }),
  )
  try {
    for (const target of targets) {
      if (!target.backup) continue
      await copyFile(target.target, target.backup)
      await chmod(target.backup, 0o600)
    }
    if (stateFile) {
      await atomicWrite(
        stateFile,
        JSON.stringify({
          version: 2,
          targets: targets.map(({ output: _, ...target }) => target),
        } satisfies TransactionState),
        0o600,
      )
    }
    for (const target of targets) await atomicWrite(target.target, target.output, 0o600)
  } catch (error) {
    for (const target of targets.toReversed()) {
      if (target.existed && target.backup && (await Bun.file(target.backup).exists())) {
        await atomicRestore(target.backup, target.target, target.originalMode ?? 0o600)
      }
      if (!target.existed) await rm(target.target, { force: true })
    }
    await Promise.all(targets.flatMap((target) => target.backup ? [rm(target.backup, { force: true })] : []))
    if (stateFile) await rm(stateFile, { force: true })
    throw error
  }

  for (const target of targets) {
    if (target.backup) console.log(`Backup: ${target.backup}`)
  }
}

async function verifyExistingPluginIdentity(source: string, file: string, kind: "server" | "tui") {
  try {
    const sourceUrl = source.startsWith("file:")
      ? new URL(source)
      : path.isAbsolute(source)
        ? pathToFileURL(source)
        : undefined
    if (!sourceUrl || sourceUrl.protocol !== "file:") throw new TypeError("source is not an absolute local path")
    const sourcePath = fileURLToPath(sourceUrl)
    const url = pathToFileURL((await stat(sourcePath)).isDirectory() ? path.join(sourcePath, `${kind}.js`) : sourcePath)
    url.searchParams.set("installer-migration", `${Date.now()}-${process.pid}`)
    const module: unknown = await import(url.href)
    const imported = isRecord(module) ? module : undefined
    const plugin = isRecord(imported?.default) ? imported.default : undefined
    const valid = kind === "server"
      ? plugin?.id === "opencode-safe-compaction" && typeof plugin.server === "function"
      : plugin?.id === "opencode-safe-compaction-settings" && typeof plugin.tui === "function"
    if (!valid) {
      throw new TypeError("module does not export the expected plugin identity")
    }
  } catch (error) {
    throw new Error(`Could not verify the existing safe-compaction entry in ${file}: ${errorText(error)}`)
  }
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
  await atomicWrite(
    path.join(verificationDir, "tui.jsonc"),
    `${JSON.stringify({ plugin: [[source, { model: options.model }]] }, null, 2)}\n`,
    0o600,
  )
  await atomicWrite(path.join(verificationDir, "expectations.json"), `${JSON.stringify(expectations, null, 2)}\n`, 0o600)
  await atomicWrite(path.join(verificationDir, "model"), `${String(options.model)}\n`, 0o600)
}

async function verifyResolvedConfig() {
  const text = await Bun.stdin.text()
  const value: unknown = JSON.parse(text)
  if (!isRecord(value)) throw new TypeError("OpenCode debug config did not return an object")
  const source = path.join(installDir, "runtime")
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
  const actualModel = typeof compactionAgent?.model === "string" ? compactionAgent.model : null
  if (actualModel !== expected.model || compactionAgent?.temperature !== expected.temperature) {
    throw new Error(`OpenCode did not activate the safe-compaction config hook for ${expected.model ?? "selected model"}`)
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

type ConfigEdit = {
  file: string
  original: string
  output: string
}

type TransactionTarget = {
  target: string
  backup?: string
  existed: boolean
  originalDigest?: string
  originalMode?: number
  appliedDigest: string
}

type TransactionState = {
  version: 2
  targets: TransactionTarget[]
}

type ExpectedConfig = {
  model: string | null
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
  for (const target of value.targets) {
    if (path.dirname(target.target) !== configDir || (target.backup && path.dirname(target.backup) !== configDir)) {
      throw new Error("Installer transaction targets escape the configured directory")
    }
  }
  const statuses = await Promise.all(
    value.targets.map(async (target) => {
      const currentExists = await Bun.file(target.target).exists()
      const currentDigest = currentExists ? sha256(await Bun.file(target.target).text()) : undefined
      return {
        target,
        unchanged: target.existed ? currentDigest === target.originalDigest : !currentExists,
        currentDigest,
      }
    }),
  )
  for (const status of statuses) {
    if (!status.unchanged && status.currentDigest !== status.target.appliedDigest) {
      throw new Error(`Refusing to overwrite a concurrently modified configuration: ${status.target.target}`)
    }
    if (
      !status.unchanged &&
      status.target.existed &&
      (!status.target.backup || !(await Bun.file(status.target.backup).exists()))
    ) {
      throw new Error(`Configuration backup is missing: ${status.target.backup ?? "unknown"}`)
    }
  }
  for (const status of statuses.toReversed()) {
    if (!status.unchanged && status.target.existed && status.target.backup) {
      await atomicRestore(status.target.backup, status.target.target, status.target.originalMode ?? 0o600)
    }
    if (!status.unchanged && !status.target.existed) await rm(status.target.target, { force: true })
    if (status.target.backup) await rm(status.target.backup, { force: true })
  }
  await rm(file, { force: true })
  console.log(`Rolled back ${value.targets.map((target) => target.target).join(", ")}`)
}

function isTransactionState(value: unknown): value is TransactionState {
  if (!isRecord(value)) return false
  return value.version === 2 && Array.isArray(value.targets) && value.targets.length > 0 && value.targets.every(isTransactionTarget)
}

function isTransactionTarget(value: unknown): value is TransactionTarget {
  if (!isRecord(value)) return false
  return (
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

async function verifyTuiEntrypoint(source: string, tuiSource: string) {
  try {
    const module: unknown = await import(
      `${pathToFileURL(tuiSource).href}?installer-preflight=${Date.now()}-${process.pid}`,
    )
    const imported = isRecord(module) ? module : undefined
    const plugin = isRecord(imported?.default) ? imported.default : undefined
    if (plugin?.id !== "opencode-safe-compaction-settings" || typeof plugin.tui !== "function") {
      throw new TypeError(`Plugin module does not export the expected TUI settings entry: ${source}`)
    }
  } catch (error) {
    throw new Error(`Plugin TUI preflight failed for ${source}: ${errorText(error)}`)
  }
}

async function preflight(
  source: string,
  serverSource: string,
  options: Record<string, unknown>,
  currentConfig: Record<string, unknown>,
) {
  let hooks: Record<string, unknown> | undefined
  try {
    const module: unknown = await import(
      `${pathToFileURL(serverSource).href}?installer-preflight=${Date.now()}-${process.pid}`,
    )
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
    model: typeof compactionAgent?.model === "string" ? compactionAgent.model : null,
    temperature: compactionAgent?.temperature,
    auto: compaction?.auto,
    prune: compaction?.prune,
    tail_turns: compaction?.tail_turns,
    preserve_recent_tokens: compaction?.preserve_recent_tokens,
    reserved: compaction?.reserved,
  }
  const expectedModel = selectedModel === "selected" ? null : selectedModel
  if (!isExpectedConfig(expected) || expected.model !== expectedModel) {
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
    (typeof value.model === "string" || value.model === null) &&
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
  if (value === source) return true
  if (value?.startsWith("file:") && path.isAbsolute(source)) {
    return path.resolve(fileURLToPath(value)) === path.resolve(source)
  }
  if (source.startsWith("file:") && value && path.isAbsolute(value)) {
    return path.resolve(value) === path.resolve(fileURLToPath(source))
  }
  return false
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

function replacePluginSource(text: string, previous: string, source: string) {
  const tokens = tokenize(text)
  if (tokens[0]?.value !== "{") throw new TypeError("OpenCode configuration must start with an object")
  const plugin = rootProperties(tokens).find((item) => item.key === "plugin")
  if (!plugin || tokens[plugin.value]?.value !== "[") {
    throw new TypeError("Could not locate the existing OpenCode plugin array")
  }
  const close = matchingClose(tokens, plugin.value)
  const matches: Token[] = []
  let index = plugin.value + 1
  while (index < close) {
    const entry = tokens[index]
    const sourceToken = entry?.kind === "string"
      ? entry
      : entry?.value === "["
        ? tokens[index + 1]
        : undefined
    if (sourceToken?.kind === "string" && sourceToken.value === previous) matches.push(sourceToken)
    index = skipValue(tokens, index)
    if (tokens[index]?.value === ",") index++
    else if (index !== close) throw new TypeError("Invalid OpenCode plugin array")
  }
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one existing safe-compaction source in the OpenCode plugin array, found ${matches.length}`)
  }
  const match = matches[0]!
  const output = `${text.slice(0, match.start)}${JSON.stringify(source)}${text.slice(match.end)}`
  parseConfig(output, "updated configuration")
  return output
}

function replacePluginModel(text: string, source: string, model: string) {
  const tokens = tokenize(text)
  if (tokens[0]?.value !== "{") throw new TypeError("OpenCode configuration must start with an object")
  const plugin = rootProperties(tokens).find((item) => item.key === "plugin")
  if (!plugin || tokens[plugin.value]?.value !== "[") {
    throw new TypeError("Could not locate the existing OpenCode plugin array")
  }
  const close = matchingClose(tokens, plugin.value)
  const matches: number[] = []
  let index = plugin.value + 1
  while (index < close) {
    const entry = tokens[index]
    if (entry?.value === "[" && tokens[index + 1]?.kind === "string" && tokens[index + 1]?.value === source) {
      const afterSource = skipValue(tokens, index + 1)
      const options = tokens[afterSource]?.value === "," ? afterSource + 1 : -1
      if (options >= 0 && tokens[options]?.value === "{") matches.push(options)
    }
    index = skipValue(tokens, index)
    if (tokens[index]?.value === ",") index++
    else if (index !== close) throw new TypeError("Invalid OpenCode plugin array")
  }
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one safe-compaction options tuple, found ${matches.length}`)
  }

  const options = matches[0]!
  const property = objectProperties(tokens, options).find((item) => item.key === "model")
  if (property) {
    const value = tokens[property.value]
    if (value?.kind !== "string") throw new TypeError('Safe-compaction option "model" must be a string')
    const output = `${text.slice(0, value.start)}${JSON.stringify(model)}${text.slice(value.end)}`
    parseConfig(output, "updated configuration")
    return output
  }

  const optionsClose = matchingClose(tokens, options)
  const first = tokens[options + 1]
  const insertAt = first && options + 1 < optionsClose ? first.start : tokens[optionsClose]!.start
  const spacing = first && options + 1 < optionsClose ? text.slice(tokens[options]!.end, first.start) : ""
  const output =
    `${text.slice(0, insertAt)}"model": ${JSON.stringify(model)}` +
    `${first && options + 1 < optionsClose ? `,${spacing}` : ""}${text.slice(insertAt)}`
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
  return objectProperties(tokens, 0)
}

function objectProperties(tokens: Token[], open: number) {
  const result: { key: string; value: number }[] = []
  const close = matchingClose(tokens, open)
  let index = open + 1
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
