import { copyFile, mkdir, open, rename, stat } from "node:fs/promises"
import path from "node:path"

const configDir = requiredEnvironment("OPENCODE_SAFE_COMPACTION_CONFIG_DIR")
const installDir = requiredEnvironment("OPENCODE_SAFE_COMPACTION_DIR")
const model = requiredEnvironment("OPENCODE_SAFE_COMPACTION_MODEL")

if (!path.isAbsolute(configDir)) throw new TypeError(`Config directory must be absolute: ${configDir}`)
if (!path.isAbsolute(installDir)) throw new TypeError(`Install directory must be absolute: ${installDir}`)
if (!/^[^/\s]+\/[^\s]+$/.test(model)) throw new TypeError(`Model must use provider/model format: ${model}`)

const source = path.join(installDir, "src/index.ts")
const names = ["opencode.jsonc", "opencode.json", "config.json"]
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

for (const config of existing) {
  if (hasStaleDeepseekLimit(config.value)) {
    throw new Error(
      `Remove the deepseek-v4-flash-free limit override from ${config.file}, then rerun the installer. ` +
        "The installer does not rewrite provider catalogs.",
    )
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
  const options = Array.isArray(matching[0]!.spec) ? matching[0]!.spec[1] : undefined
  if (!isRecord(options) || options.model !== model) {
    throw new Error(
      `The existing safe-compaction entry in ${matching[0]!.file} does not select ${model}; edit or remove it and rerun`,
    )
  }
  console.log(`Configuration already contains ${source}`)
  process.exit(0)
}

await mkdir(configDir, { recursive: true })
const target = existing[0] ?? {
  file: path.join(configDir, "opencode.jsonc"),
  text: '{\n  "$schema": "https://opencode.ai/config.json"\n}\n',
  value: { $schema: "https://opencode.ai/config.json" },
}
const entry = [
  source,
  {
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
  },
]
const output = addPlugin(target.text, target.value, entry)
const backup = `${target.file}.safe-compaction-backup-${Date.now()}-${process.pid}`
const temporary = `${target.file}.safe-compaction-${process.pid}.tmp`

if (await Bun.file(target.file).exists()) await copyFile(target.file, backup)
const mode = (await Bun.file(target.file).exists()) ? (await stat(target.file)).mode & 0o777 : 0o600
const temporaryFile = await open(temporary, "wx", mode)
await temporaryFile.writeFile(output).finally(() => temporaryFile.close())
await rename(temporary, target.file)

console.log(`Configured ${target.file}`)
if (await Bun.file(backup).exists()) console.log(`Backup: ${backup}`)

function requiredEnvironment(name: string) {
  const value = process.env[name]
  if (!value) throw new TypeError(`${name} must be set`)
  return value
}

function parseConfig(text: string, file: string) {
  const value: unknown = Bun.JSONC.parse(text)
  if (!isRecord(value)) throw new TypeError(`OpenCode configuration must be an object: ${file}`)
  return value
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

function isSafeCompaction(spec: unknown) {
  const value = pluginSource(spec)
  if (!value) return false
  return value === "opencode-safe-compaction" || /(?:safe-compaction|opencode-better-compact-plugin)/.test(value)
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
