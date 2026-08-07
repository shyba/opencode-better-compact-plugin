import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, expect, test } from "bun:test"
import {
  DEFAULT_CAT_OPTIONS,
  collectFiles,
  formatInjection,
  parseCatArgs,
  projectContext,
  resolvePatterns,
  saveCatOptions,
  loadCatOptions,
} from "../src/cat-core.js"

describe("parseCatArgs", () => {
  test("parses plain patterns", () => {
    expect(parseCatArgs("src/main.ts")).toEqual({ patterns: ["src/main.ts"] })
    expect(parseCatArgs("src/main.ts src/util.ts")).toEqual({ patterns: ["src/main.ts", "src/util.ts"] })
  })

  test("parses a trailing token budget", () => {
    expect(parseCatArgs(".rs src 50000")).toEqual({ patterns: [".rs", "src"], tokenBudget: 50_000 })
    expect(parseCatArgs("src/**/*.ts 80000")).toEqual({ patterns: ["src/**/*.ts"], tokenBudget: 80_000 })
  })

  test("accepts a conventional leading glob separator", () => {
    expect(parseCatArgs('-- "src/**/*.rs"')).toEqual({ patterns: ["src/**/*.rs"] })
  })

  test("does not treat a non-final number as a budget", () => {
    expect(parseCatArgs("50000 .rs")).toEqual({ patterns: ["50000", ".rs"] })
  })

  test("honors quoting so glob braces survive", () => {
    expect(parseCatArgs("'src/**/*.{ts,tsx}' 'README.md'")).toEqual({ patterns: ["src/**/*.{ts,tsx}", "README.md"] })
  })
})

describe("resolvePatterns", () => {
  test("expands extension shorthand with dir", () => {
    expect(resolvePatterns({ patterns: [".rs", "src"] })).toEqual(["src/**/*.rs"])
    expect(resolvePatterns({ patterns: ["rs", "src"] })).toEqual(["src/**/*.rs"])
    expect(resolvePatterns({ patterns: [".md"] })).toEqual(["./**/*.md"])
    expect(resolvePatterns({ patterns: ["md"] })).toEqual(["./**/*.md"])
  })

  test("passes explicit globs through", () => {
    expect(resolvePatterns({ patterns: ["src/**/*.ts"] })).toEqual(["src/**/*.ts"])
    expect(resolvePatterns({ patterns: ["src/main.ts", "README.md"] })).toEqual(["src/main.ts", "README.md"])
  })

  test("recurses simple basename globs like find -name", () => {
    expect(resolvePatterns({ patterns: ["*rs"] })).toEqual(["**/*rs"])
    expect(resolvePatterns({ patterns: ["*.rs"] })).toEqual(["**/*.rs"])
    expect(resolvePatterns({ patterns: ["./*.rs"] })).toEqual(["./*.rs"])
  })

  test("falls back to glob mode for ambiguous input", () => {
    expect(resolvePatterns({ patterns: [".gitignore"] })).toEqual([".gitignore"])
    expect(resolvePatterns({ patterns: ["./.env"] })).toEqual(["./.env"])
    expect(resolvePatterns({ patterns: [".rs", "src/**"] })).toEqual([".rs", "src/**"])
    expect(resolvePatterns({ patterns: [".rs", "src", "extra"] })).toEqual([".rs", "src", "extra"])
  })
})

describe("collectFiles", () => {
  async function fixture(files: Record<string, string>) {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sc-cat-"))
    for (const [relative, content] of Object.entries(files)) {
      const absolute = path.join(dir, relative)
      await mkdir(path.dirname(absolute), { recursive: true })
      await writeFile(absolute, content)
    }
    return dir
  }

  test("collects matching files with tokens and bytes", async () => {
    const dir = await fixture({ "a.rs": "fn main() {}", "b.rs": "let x = 1;", "readme.md": "hi" })
    try {
      const result = collectFiles(["**/*.rs"], dir, DEFAULT_CAT_OPTIONS)
      expect(result.files.map((file) => file.path).sort()).toEqual(["a.rs", "b.rs"])
      expect(result.files.every((file) => file.tokens > 0)).toBe(true)
      expect(result.totalBytes).toBeGreaterThan(0)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("matches recursive basename globs", async () => {
    const dir = await fixture({ "root.rs": "root", "src/api/library.rs": "library", "src/api/readme.md": "readme" })
    try {
      const invocation = parseCatArgs("*rs")
      const result = collectFiles(resolvePatterns(invocation), dir, DEFAULT_CAT_OPTIONS)
      expect(result.files.map((file) => file.path).sort()).toEqual(["root.rs", "src/api/library.rs"])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("applies the skip list", async () => {
    const dir = await fixture({ "src/a.rs": "x", "node_modules/pkg/b.rs": "y", "dist/c.rs": "z" })
    try {
      const result = collectFiles(["**/*.rs"], dir, DEFAULT_CAT_OPTIONS)
      expect(result.files.map((file) => file.path)).toEqual(["src/a.rs"])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("skips binary files", async () => {
    const dir = await fixture({ "a.bin": "a\u0000b\u0000c", "b.ts": "const x = 1" })
    try {
      const result = collectFiles(["**/*"], dir, { ...DEFAULT_CAT_OPTIONS, skipDirs: [] })
      expect(result.files.map((file) => file.path)).toEqual(["b.ts"])
      expect(result.skipped.some((line) => line.startsWith("a.bin"))).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("honors the token budget and drops later files", async () => {
    const dir = await fixture({ "a.md": "a".repeat(200), "b.md": "b".repeat(200) })
    try {
      const result = collectFiles(["**/*.md"], dir, { ...DEFAULT_CAT_OPTIONS, charsPerToken: 4 }, 60)
      expect(result.totalTokens).toBeLessThanOrEqual(60)
      expect(result.files.length).toBe(1)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("caps aggregate bytes", async () => {
    const dir = await fixture({ "a.md": "a".repeat(1_000), "b.md": "b".repeat(1_000) })
    try {
      const result = collectFiles(["**/*.md"], dir, { ...DEFAULT_CAT_OPTIONS, maxTotalBytes: 1_500 })
      expect(result.files.length).toBe(1)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("caps per-file bytes", async () => {
    const dir = await fixture({ "big.md": "x".repeat(10_000), "small.md": "y" })
    try {
      const result = collectFiles(["**/*.md"], dir, { ...DEFAULT_CAT_OPTIONS, maxFileBytes: 2_000 })
      expect(result.files.map((file) => file.path)).toEqual(["small.md"])
      expect(result.skipped.some((line) => line.startsWith("big.md"))).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe("projectContext", () => {
  test("fits when projection is under the threshold", () => {
    const projection = projectContext({ tokens: 50_000, contextWindow: 200_000 }, 20_000, DEFAULT_CAT_OPTIONS)
    expect(projection.fits).toBe(true)
    expect(projection.projectedTokens).toBe(70_000)
  })

  test("refuses when projection crosses the threshold", () => {
    const projection = projectContext({ tokens: 150_000, contextWindow: 200_000 }, 60_000, DEFAULT_CAT_OPTIONS)
    expect(projection.fits).toBe(false)
  })

  test("assumes a fraction of the window when current usage is unknown", () => {
    const projection = projectContext({ tokens: null, contextWindow: 200_000 }, 10_000, DEFAULT_CAT_OPTIONS)
    expect(projection.currentTokens).toBe(100_000)
    expect(projection.fits).toBe(true)
  })
})

describe("formatInjection", () => {
  test("wraps each file with markers and an instruction line", () => {
    const text = formatInjection([
      { path: "src/a.ts", bytes: 3, tokens: 1, text: "x = 1" },
      { path: "b.md", bytes: 2, tokens: 1, text: "hi" },
    ])
    expect(text).toContain("<file:src/a.ts>\nx = 1\n</file>")
    expect(text).toContain("<file:b.md>\nhi\n</file>")
    expect(text).toContain("do not re-read them with the read tool unless asked")
  })
})

describe("cat option persistence", () => {
  test("round-trips settings through save and load", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sc-cat-"))
    try {
      await saveCatOptions(dir, { ...DEFAULT_CAT_OPTIONS, warnThreshold: 0.8, charsPerToken: 3.5 })
      const loaded = loadCatOptions(dir)
      expect(loaded.warnThreshold).toBe(0.8)
      expect(loaded.charsPerToken).toBe(3.5)
      expect(loaded.skipDirs).toEqual(DEFAULT_CAT_OPTIONS.skipDirs)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("falls back to defaults on corrupt files", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sc-cat-"))
    try {
      await mkdir(path.join(dir, ".pi"), { recursive: true })
      await writeFile(path.join(dir, ".pi", "cat-files.json"), "nope")
      expect(loadCatOptions(dir)).toEqual(DEFAULT_CAT_OPTIONS)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
