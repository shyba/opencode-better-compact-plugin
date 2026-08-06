import type { AgentMessage } from "@earendil-works/pi-agent-core"
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent"
import { sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent"
import type { Model, Usage } from "@earendil-works/pi-ai"
import { uuidv7 } from "@earendil-works/pi-ai"
import { createHash } from "node:crypto"
import { buildRecoveryLedger, utf8Bytes } from "./ledger.js"
import { SELECTED_MODEL, parseOptions, resolveOptions, type PluginOptions } from "./options.js"
import { loadPiOptions, priorPluginSummary, savePiOptions, toMessageRecords, todosFromBranch } from "./pi-adapter.js"
import { remapProjection } from "./projection.js"
import { buildAuthoritativeSummary, buildCompactionPrompt, renderProjectedResponse } from "./validation.js"

export { loadPiOptions, savePiOptions, toMessageRecords, todosFromBranch, priorPluginSummary } from "./pi-adapter.js"
export type { PriorPluginSummary } from "./pi-adapter.js"

export type PiPluginOptions = PluginOptions

type PipelineResult = {
  summary: string
  usage: Usage
  details: { ledgerDigest: string; ledgerBytes: number }
}

export default function piExtension(pi: ExtensionAPI) {
  ensureBunCryptoShim()
  let cwd = process.cwd()
  let resolved = resolveOptions(parseOptions(loadPiOptions(cwd)))

  pi.on("session_start", (_event, ctx) => {
    cwd = ctx.cwd
    resolved = resolveOptions(parseOptions(loadPiOptions(cwd)))
  })

  async function runPipeline(input: {
    messages: AgentMessage[]
    branch: SessionEntry[]
    sessionID: string
    signal: AbortSignal
    ctx: ExtensionContext
  }): Promise<PipelineResult | undefined> {
    const { messages, branch, sessionID, signal, ctx } = input
    if (signal.aborted) return
    const records = toMessageRecords(messages, sessionID)
    const todos = todosFromBranch(branch)
    const prior = priorPluginSummary(branch)
    const ledger = buildRecoveryLedger({
      messages: records,
      todos,
      tailTurns: resolved.tail_turns,
      maxBytes: resolved.max_ledger_bytes,
      ...(prior ? { priorSummary: { id: prior.id, ledger: prior.ledger } } : {}),
    })
    const projection = prior?.projection ? remapProjection(prior.projection, ledger) : undefined
    const model = compactionModel(ctx, resolved.model)
    if (!model) return
    const prompt = buildCompactionPrompt(ledger, resolved.max_summary_bytes, projection, resolved.response_mode)
    const response = await ctx.modelRegistry.complete(
      model,
      {
        messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }],
      },
      {
        maxTokens: resolved.max_output_tokens,
        cacheRetention: "none",
        sessionId: uuidv7(),
        signal,
      },
    )
    if (signal.aborted) return
    const text = response.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n")
    const summary =
      renderProjectedResponse(text, ledger, resolved.max_summary_bytes, resolved.response_mode) ??
      buildAuthoritativeSummary({ ledger, maxBytes: resolved.max_summary_bytes })
    return { summary, usage: response.usage, details: { ledgerDigest: ledger.digest, ledgerBytes: utf8Bytes(ledger.block) } }
  }

  pi.on("session_before_compact", async (event, ctx) => {
    const sessionID = ctx.sessionManager.getSessionId() ?? "pi-session"
    try {
      const result = await runPipeline({
        messages: [...event.preparation.messagesToSummarize, ...event.preparation.turnPrefixMessages],
        branch: ctx.sessionManager.getBranch(),
        sessionID,
        signal: event.signal,
        ctx,
      })
      if (!result) return
      return {
        compaction: {
          summary: result.summary,
          firstKeptEntryId: event.preparation.firstKeptEntryId,
          tokensBefore: event.preparation.tokensBefore,
          usage: result.usage,
          details: result.details,
        },
      }
    } catch (error) {
      warnHook("session_before_compact", sessionID, error)
      return
    }
  })

  pi.on("session_before_tree", async (event, ctx) => {
    const sessionID = ctx.sessionManager.getSessionId() ?? "pi-session"
    try {
      if (!event.preparation.userWantsSummary) return
      const messages = event.preparation.entriesToSummarize.flatMap(sessionEntryToContextMessages)
      const result = await runPipeline({
        messages,
        branch: ctx.sessionManager.getBranch(),
        sessionID,
        signal: event.signal,
        ctx,
      })
      if (!result) return
      return { summary: { summary: result.summary, usage: result.usage, details: result.details } }
    } catch (error) {
      warnHook("session_before_tree", sessionID, error)
      return
    }
  })

  pi.registerCommand("compaction-model", {
    description: "Choose a dedicated compaction model or follow the selected model",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return
      try {
        const values = [
          SELECTED_MODEL,
          ...ctx.modelRegistry.getAvailable().map((model) => `${model.provider}/${model.id}`).sort(),
        ]
        const byLabel = new Map(values.map((value) => [value === SELECTED_MODEL ? "Follow selected model" : value, value]))
        const choice = await ctx.ui.select("Compaction model", [...byLabel.keys()])
        const value = choice ? byLabel.get(choice) : undefined
        if (!value) return
        if (value === resolved.model) {
          ctx.ui.notify(`Compaction model is already ${displayModel(resolved.model)}`, "info")
          return
        }
        const next = resolveOptions(parseOptions({ ...resolved, model: value }))
        await savePiOptions(cwd, next)
        resolved = next
        ctx.ui.notify(`Compaction now uses ${displayModel(resolved.model)}`, "info")
      } catch (error) {
        warnHook("compaction-model", undefined, error)
        if (ctx.hasUI) ctx.ui.notify("Could not update the compaction model", "error")
      }
    },
  })
}

function compactionModel(ctx: ExtensionContext, spec: string): Model<any> | undefined {
  if (spec === SELECTED_MODEL) {
    if (!ctx.model || !ctx.modelRegistry.hasConfiguredAuth(ctx.model)) return undefined
    return ctx.model
  }
  const slash = spec.indexOf("/")
  if (slash <= 0 || slash === spec.length - 1) return undefined
  const model = ctx.modelRegistry.find(spec.slice(0, slash), spec.slice(slash + 1))
  if (!model || !ctx.modelRegistry.hasConfiguredAuth(model)) return undefined
  return model
}

function displayModel(model: string) {
  return model === SELECTED_MODEL ? "the selected model" : model
}

function warnHook(hook: string, sessionID: string | undefined, error: unknown) {
  try {
    console.warn("opencode-safe-compaction pi degraded safely after an internal hook failure", {
      hook,
      ...(sessionID ? { sessionID } : {}),
      error: safeErrorClass(error),
    })
  } catch {
    // Logging is best-effort and must never affect the host.
  }
}

function safeErrorClass(error: unknown) {
  if (error instanceof TypeError) return "TypeError"
  if (error instanceof RangeError) return "RangeError"
  if (error instanceof Error) return "Error"
  return "NonError"
}

// The shared plugin core (ledger.ts) digests with Bun.CryptoHasher. Pi can run
// under Bun or Node; under a Node-based pi installation the Bun global is absent.
// Install a minimal node:crypto-backed shim so both runtimes work. It is a no-op
// when the real Bun global is present.
function ensureBunCryptoShim() {
  const bun = (globalThis as { Bun?: { CryptoHasher?: unknown } }).Bun
  if (bun?.CryptoHasher) return
  class CryptoHasher {
    private readonly hash = createHash("sha256")
    constructor(_algorithm: string) {}
    update(value: string) {
      this.hash.update(value)
      return this
    }
    digest(encoding: string) {
      return this.hash.digest(encoding as "hex")
    }
  }
  if (bun) bun.CryptoHasher = CryptoHasher
  else (globalThis as { Bun: { CryptoHasher: unknown } }).Bun = { CryptoHasher }
}
