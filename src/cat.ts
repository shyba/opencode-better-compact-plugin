import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import {
  DEFAULT_CAT_OPTIONS,
  collectFiles,
  formatBytes,
  formatInjection,
  formatTokens,
  loadCatOptions,
  parseCatArgs,
  projectContext,
  resolvePatterns,
  type CatOptions,
} from "./cat-core.js"

export { DEFAULT_CAT_OPTIONS, collectFiles, formatInjection, loadCatOptions, parseCatArgs, projectContext, resolvePatterns } from "./cat-core.js"

export default function catExtension(pi: ExtensionAPI) {
  let cwd = process.cwd()
  let options: CatOptions = loadCatOptions(cwd)

  pi.on("session_start", (_event, ctx) => {
    cwd = ctx.cwd
    options = loadCatOptions(cwd)
  })

  pi.registerCommand("cat", {
    description: "Attach file contents to the conversation: /cat <ext> [dir] [tokens], /cat <glob>... [tokens]",
    handler: async (args, ctx) => {
      const invocation = parseCatArgs(args)
      const patterns = resolvePatterns(invocation)
      if (!patterns.length) {
        if (ctx.hasUI) ctx.ui.notify("Usage: /cat <ext> [dir] [tokens] or /cat <glob>... [tokens]", "error")
        return
      }
      const collected = collectFiles(patterns, cwd, options, invocation.tokenBudget)
      if (!collected.files.length) {
        if (ctx.hasUI) {
          ctx.ui.notify(
            `No files matched${collected.skipped.length ? ` (${collected.skipped[0]})` : ""}.`,
            "error",
          )
        }
        return
      }

      const usage = ctx.getContextUsage()
      if (!usage || usage.contextWindow <= 0) {
        if (ctx.hasUI) {
          ctx.ui.notify("Cannot measure context window for the current model; /cat refused.", "error")
        }
        return
      }
      const projection = projectContext(
        { tokens: usage.tokens, contextWindow: usage.contextWindow },
        collected.totalTokens,
        options,
      )
      if (!projection.fits) {
        if (ctx.hasUI) {
          const largest = [...collected.files].sort((left, right) => right.bytes - left.bytes).slice(0, 3)
          ctx.ui.notify(
            [
              `Refusing /cat: would use ${formatTokens(projection.projectedTokens)} (${percent(projection.projectedTokens, projection.contextWindow)}) of ${formatTokens(projection.contextWindow)}.`,
              "Run /compact first, or re-run with a smaller pattern or token budget.",
              ...largest.map((file) => `  - ${file.path} (${formatBytes(file.bytes)}, ${formatTokens(file.tokens)})`),
            ].join("\n"),
            "error",
          )
        }
        return
      }

      pi.sendUserMessage(
        formatInjection(collected.files),
        ctx.isIdle() ? undefined : { deliverAs: "followUp" },
      )
      if (collected.skipped.length && ctx.hasUI) {
        ctx.ui.notify(`Attached ${collected.files.length} files; ${collected.skipped.length} skipped.`, "info")
      }
    },
  })
}

function percent(value: number, total: number) {
  return `${Math.round((value / total) * 100)}%`
}
