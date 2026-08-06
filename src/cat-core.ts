import { readdirSync, readFileSync, statSync } from "node:fs"
import { mkdir, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent"

export const CAT_CONFIG_FILENAME = "cat-files.json"

export type CatOptions = {
  warnThreshold: number
  unknownUsageFraction: number
  charsPerToken: number
  maxFileBytes: number
  maxTotalBytes: number
  maxFileCount: number
  skipDirs: string[]
}

export const DEFAULT_CAT_OPTIONS: CatOptions = {
  warnThreshold: 0.95,
  unknownUsageFraction: 0.5,
  charsPerToken: 4,
  maxFileBytes: 4 * 1024 * 1024,
  maxTotalBytes: 32 * 1024 * 1024,
  maxFileCount: 1_000,
  skipDirs: [
    "node_modules", ".git", "dist", "build", "out", "target", "vendor", "__pycache__",
    ".next", ".nuxt", ".turbo", ".cache", ".venv", "venv", ".idea", ".vscode", ".gradle",
  ],
}

export type CatInvocation = {
  patterns: string[]
  tokenBudget?: number
}

export type CatFile = {
  /** Path relative to cwd (with forward slashes). */
  path: string
  bytes: number
  tokens: number
  text: string
}

export type CatCollectResult = {
  files: CatFile[]
  skipped: string[]
  totalBytes: number
  totalTokens: number
}

/** Parse the /cat argument string. The last whitespace token, when a positive
 *  integer, is the token budget. Everything else is a pattern. */
export function parseCatArgs(args: string): CatInvocation {
  const tokens = tokenize(args)
  if (!tokens.length) return { patterns: [] }
  const last = tokens[tokens.length - 1]!
  if (/^[1-9]\d*$/.test(last)) {
    tokens.pop()
    return { patterns: tokens, tokenBudget: Number(last) }
  }
  return { patterns: tokens }
}

/** Turn shorthand forms into explicit globs. Shorthand is `<ext> [dir]`:
 *  first arg starts with "." and looks like an extension (no separators, no
 *  glob meta, short), second arg (if any) must not look like a glob. Any
 *  ambiguous input falls back to explicit globs. */
export function resolvePatterns(invocation: CatInvocation): string[] {
  const { patterns } = invocation
  if (!patterns.length) return []
  const first = patterns[0]!
  const second = patterns[1]
  if (
    isExtensionShorthand(first) &&
    patterns.length <= 2 &&
    !(second !== undefined && looksLikeGlob(second))
  ) {
    const dir = (second ?? ".").replace(/\/+$/, "") || "."
    return [`${dir}/**/*${first}`]
  }
  return patterns
}

/** Resolve patterns to file contents with skip list, per-file cap, aggregate
 *  cap, file count cap, binary detection, and an optional token budget that
 *  stops the read once cumulative estimates exceed it. */
export function collectFiles(
  patterns: string[],
  cwd: string,
  options: CatOptions,
  tokenBudget?: number,
): CatCollectResult {
  const seen = new Set<string>()
  const files: CatFile[] = []
  const skipped: string[] = []
  let totalBytes = 0
  let totalTokens = 0
  let budgetExhausted = false

  const candidates = listFiles(cwd, options.skipDirs)
  for (const pattern of patterns) {
    if (budgetExhausted) break
    const matcher = compileGlob(stripLeadingDotSlash(pattern))
    for (const match of candidates) {
      if (budgetExhausted) break
      if (!matcher(match)) continue
      if (isSkippedDir(match, options.skipDirs)) continue
      const absolute = path.resolve(cwd, match)
      if (seen.has(absolute)) continue
      seen.add(absolute)

      let stat
      try {
        stat = statSync(absolute)
      } catch {
        continue
      }
      if (!stat.isFile()) continue
      if (stat.size > options.maxFileBytes) {
        skipped.push(`${match}: ${formatBytes(stat.size)} exceeds limit of ${formatBytes(options.maxFileBytes)}`)
        continue
      }
      if (files.length >= options.maxFileCount) {
        skipped.push(`${match}: too many files`)
        continue
      }

      let text: string
      try {
        text = readFileBytes(absolute)
      } catch {
        skipped.push(`${match}: unreadable`)
        continue
      }
      if (isBinary(text)) {
        skipped.push(`${match}: binary`)
        continue
      }
      const tokens = estimateTokens(text, options.charsPerToken)
      if (tokenBudget !== undefined && totalTokens + tokens > tokenBudget) {
        skipped.push(`${match}: exceeds token budget`)
        budgetExhausted = true
        break
      }
      if (totalBytes + stat.size > options.maxTotalBytes) {
        skipped.push(`${match}: exceeds aggregate byte limit`)
        budgetExhausted = true
        break
      }
      files.push({ path: match, bytes: stat.size, tokens, text })
      totalBytes += stat.size
      totalTokens += tokens
    }
  }
  return { files, skipped, totalBytes, totalTokens }
}

/** Format attached files as a single user message. */
export function formatInjection(files: CatFile[]): string {
  const body = files
    .map((file) => `<file:${file.path}>\n${file.text}\n</file>`)
    .join("\n\n")
  return `${body}\n\nRead the attached files above. Their full contents are intentionally included; do not re-read them with the read tool unless asked.`
}

export type ContextUsage = {
  tokens: number | null
  contextWindow: number
}

export type CatProjection = {
  fits: boolean
  currentTokens: number
  addedTokens: number
  projectedTokens: number
  contextWindow: number
  thresholdTokens: number
}

/** Decide whether the projection fits. When current usage is unknown (tokens is
 *  null, e.g. right after compaction), assume unknownUsageFraction of the
 *  context window is already consumed. */
export function projectContext(usage: ContextUsage, addedTokens: number, options: CatOptions): CatProjection {
  const contextWindow = usage.contextWindow
  const currentTokens = usage.tokens ?? Math.floor(contextWindow * options.unknownUsageFraction)
  const projectedTokens = currentTokens + addedTokens
  const thresholdTokens = Math.floor(contextWindow * options.warnThreshold)
  return {
    fits: projectedTokens <= thresholdTokens,
    currentTokens,
    addedTokens,
    projectedTokens,
    contextWindow,
    thresholdTokens,
  }
}

export function loadCatOptions(cwd: string): CatOptions {
  try {
    const raw = readFileSync(path.join(cwd, CONFIG_DIR_NAME, CAT_CONFIG_FILENAME), "utf8")
    const value = JSON.parse(raw) as unknown
    if (!value || typeof value !== "object" || Array.isArray(value)) return { ...DEFAULT_CAT_OPTIONS }
    return mergeCatOptions(value as Record<string, unknown>)
  } catch {
    return { ...DEFAULT_CAT_OPTIONS }
  }
}

export async function saveCatOptions(cwd: string, options: CatOptions): Promise<void> {
  const dir = path.join(cwd, CONFIG_DIR_NAME)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const file = path.join(dir, CAT_CONFIG_FILENAME)
  const lock = `${file}.lock`
  try {
    await mkdir(lock, { recursive: false, mode: 0o700 })
  } catch {
    throw new Error(`cat-files configuration is busy: ${file}`)
  }
  try {
    const temporary = `${file}.tmp-${process.pid}`
    await writeFile(temporary, `${JSON.stringify(options, null, 2)}\n`, { mode: 0o600 })
    await rename(temporary, file)
  } finally {
    await rm(lock, { recursive: true, force: true })
  }
}

function mergeCatOptions(value: Record<string, unknown>): CatOptions {
  const merged: CatOptions = { ...DEFAULT_CAT_OPTIONS }
  const numbers = ["warnThreshold", "unknownUsageFraction", "charsPerToken", "maxFileBytes", "maxTotalBytes", "maxFileCount"] as const
  for (const key of numbers) {
    const item = value[key]
    if (typeof item === "number" && Number.isFinite(item) && item > 0) merged[key] = item
  }
  if (Array.isArray(value.skipDirs)) {
    merged.skipDirs = value.skipDirs.filter((item): item is string => typeof item === "string" && item.length > 0)
  }
  return merged
}

function tokenize(args: string): string[] {
  const tokens: string[] = []
  let current = ""
  let quote: '"' | "'" | undefined
  let index = 0
  while (index < args.length) {
    const char = args[index]!
    if (quote) {
      if (char === quote) quote = undefined
      else current += char
      index++
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      index++
      continue
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current)
        current = ""
      }
      index++
      continue
    }
    current += char
    index++
  }
  if (current) tokens.push(current)
  return tokens
}

function isExtensionShorthand(value: string): boolean {
  if (!value.startsWith(".") || value.startsWith("./") || value.startsWith("../")) return false
  return /^\.[a-z0-9]{1,8}$/i.test(value)
}

function looksLikeGlob(value: string): boolean {
  return /[*?[]/.test(value) || value.startsWith("./") || value.startsWith("/")
}

function isSkippedDir(relative: string, skipDirs: readonly string[]): boolean {
  const components = relative.split("/")
  return components.some((component) => skipDirs.includes(component))
}

/** Walk the tree once (dot-entries and symlinked dirs excluded, matching Bun.Glob's
 *  default behavior) and return all file paths relative to cwd. */
function listFiles(cwd: string, skipDirs: readonly string[]): string[] {
  const files: string[] = []
  const stack = [""]
  while (stack.length) {
    const dir = stack.pop()!
    let entries
    try {
      entries = readdirSync(path.join(cwd, dir), { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue
      const relative = dir ? `${dir}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (skipDirs.includes(entry.name)) continue
        stack.push(relative)
        continue
      }
      if (entry.isFile()) files.push(relative)
    }
  }
  return files
}

/** Compile a glob pattern (supporting **, *, ?, [..], {a,b}) into a matcher. */
function compileGlob(pattern: string): (value: string) => boolean {
  const variants = expandBraces(pattern)
  const sources = variants.map(globToRegex)
  const regex = new RegExp(`^(?:${sources.join("|")})$`)
  return (value) => regex.test(value)
}

function globToRegex(pattern: string): string {
  const segments = pattern.split("/")
  let out = ""
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index]!
    if (segment === "**") {
      out += index === segments.length - 1 ? ".*" : "(?:[^/]+/)*"
      continue
    }
    out += globSegmentToRegex(segment)
    if (index < segments.length - 1) out += "/"
  }
  return out
}

function expandBraces(pattern: string): string[] {
  const match = /^([^{]*)\{([^{}]*)\}(.*)$/.exec(pattern)
  if (!match) return [pattern]
  const prefix = match[1]!
  const options = match[2]!
  const suffix = match[3]!
  return options.split(",").flatMap((option) => expandBraces(`${prefix}${option}${suffix}`))
}

function globSegmentToRegex(segment: string): string {
  let out = ""
  for (let index = 0; index < segment.length; index++) {
    const char = segment[index]!
    if (char === "*") {
      out += "[^/]*"
      continue
    }
    if (char === "?") {
      out += "[^/]"
      continue
    }
    if (char === "[") {
      const end = segment.indexOf("]", index + 1)
      if (end < 0) {
        out += "\\["
        continue
      }
      const inner = segment.slice(index + 1, end)
      out += `[${inner.replaceAll("\\", "\\\\")}]`
      index = end
      continue
    }
    out += escapeRegexChar(char)
  }
  return out
}

function stripLeadingDotSlash(pattern: string): string {
  return pattern.startsWith("./") ? pattern.slice(2) : pattern
}

function escapeRegexChar(char: string): string {
  return /[.*+?^${}()|[\]\\]/.test(char) ? `\\${char}` : char
}

function isBinary(text: string): boolean {
  const prefix = text.slice(0, 8_192)
  return prefix.includes("\u0000")
}

function estimateTokens(text: string, charsPerToken: number): number {
  return Math.max(1, Math.ceil([...text].length / charsPerToken))
}

function readFileBytes(absolute: string): string {
  const buffer = readFileSync(absolute)
  return new TextDecoder("utf-8", { fatal: false }).decode(buffer)
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GiB`
}

export function formatTokens(tokens: number): string {
  if (tokens < 1_000) return `${tokens} tokens`
  if (tokens < 1_000_000) return `${(tokens / 1_000).toFixed(1)}k tokens`
  return `${(tokens / 1_000_000).toFixed(1)}M tokens`
}
