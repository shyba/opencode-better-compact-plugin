import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import {
  DEFAULT_CAT_OPTIONS,
  clearFixedPin,
  collectFiles,
  formatBytes,
  formatInjection,
  formatTokens,
  loadCatOptions,
  parseCatArgs,
  projectContext,
  resolvePatterns,
  saveFixedPin,
  type CatOptions,
} from "./cat-core.js"

export { DEFAULT_CAT_OPTIONS, clearFixedPin, collectFiles, formatInjection, formatPinnedBlock, loadCatOptions, loadFixedPin, parseCatArgs, pinnedPathsOnlyBlock, projectContext, resolvePatterns, saveFixedPin } from "./cat-core.js"

export default function catExtension(pi: ExtensionAPI) {
  let cwd = process.cwd()
  let options: CatOptions = loadCatOptions(cwd)

  pi.on("session_start", (_event, ctx) => {
    cwd = ctx.cwd
    options = loadCatOptions(cwd)
  })

  pi.registerCommand("cat", {
    description: "Attach file contents: /cat <ext> [dir] [tokens] | /cat <glob>... [tokens] | --fixed pins them across compaction | --reset unpins",
    handler: async (args, ctx) => {
      const invocation = parseCatArgs(args)
      if (invocation.reset) {
        await clearFixedPin(cwd)
        if (ctx.hasUI) ctx.ui.notify("Pinned files cleared; compaction will no longer re-attach them.", "info")
        return
      }
      if (invocation.fixed && !invocation.patterns.length) {
        if (ctx.hasUI) ctx.ui.notify("Usage: /cat <patterns> --fixed (patterns are required to pin)", "error")
        return
      }
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
      const notices: string[] = []
      if (collected.skipped.length) notices.push(`${collected.skipped.length} skipped`)
      if (invocation.fixed) {
        await saveFixedPin(cwd, {
          sessionId: ctx.sessionManager.getSessionId() ?? "pi-session",
          patterns,
          ...(invocation.tokenBudget !== undefined ? { tokenBudget: invocation.tokenBudget } : {}),
          pinnedAt: Date.now(),
        })
        notices.push("pinned: files are re-attached, updated, after each compaction (/cat --reset to clear)")
      }
      if (notices.length && ctx.hasUI) {
        ctx.ui.notify(`Attached ${collected.files.length} files; ${notices.join("; ")}.`, "info")
      }
    },
  })
}

function percent(value: number, total: number) {
  return `${Math.round((value / total) * 100)}%`
}
