import type { AgentMessage } from "@earendil-works/pi-agent-core"
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent"
import { sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent"
import { Type, type Api, type Model, type Usage } from "@earendil-works/pi-ai"
import { uuidv7 } from "@earendil-works/pi-ai"
import { createHash } from "node:crypto"
import { buildRecoveryLedger, utf8Bytes } from "./ledger.js"
import { SELECTED_MODEL, parseOptions, resolveOptions, type PluginOptions } from "./options.js"
import { catFilesFromMessages, isCatAttachment, loadPiOptions, priorPluginSummary, savePiOptions, toMessageRecords, todosFromBranch } from "./pi-adapter.js"
import { parseProjectionEnvelope, remapProjection, renderProjection } from "./projection.js"
import { buildAuthoritativeSummary, buildCompactionPrompt, renderProjectedResponse } from "./validation.js"
import { collectFiles, formatPinnedBlock, loadCatOptions, loadFixedPin, pinnedPathsOnlyBlock } from "./cat-core.js"
import { SEMANTIC_CHECKPOINT_MAX_BYTES, SemanticStore, attachSemanticCheckpoint, repositoryIdentity, semanticArtifacts, semanticDatabasePath, semanticPromptExtension, validateSemanticDelta } from "./semantic.js"
import { VCC_PI_RECALL_DEFAULT_MAX_BYTES, VCC_PI_RECALL_DEFAULT_MAX_RESULTS, VCC_PI_RECALL_MAX_BYTES, buildVccPiRecallIndex, discoverVccPiHandles, renderVccPiRecallEntry, resolveVccPiHandle, vccPiRecallToolResult } from "./vcc-pi-recall.js"
import { buildPiVccCut } from "./pi-vcc-cut.js"

export { loadPiOptions, savePiOptions, toMessageRecords, todosFromBranch, priorPluginSummary } from "./pi-adapter.js"
export type { PriorPluginSummary } from "./pi-adapter.js"

export type PiPluginOptions = PluginOptions

type PipelineResult = {
  summary: string
  usage?: Usage
  details: { ledgerDigest: string; ledgerBytes: number; mode: PluginOptions["vcc_mode"] }
}

/** Keep the complete compaction artifact below a conservative context fraction
 *  when a fixed file prefix is added. */
const PINNED_FILES_MAX_FRACTION = 0.8

export default function piExtension(pi: ExtensionAPI) {
  ensureBunCryptoShim()
  let cwd = process.cwd()
  let resolved = resolveOptions(parseOptions(loadPiOptions(cwd)))

  pi.on("session_start", (_event, ctx) => {
    cwd = ctx.cwd
    resolved = resolveOptions(parseOptions(loadPiOptions(cwd)))
  })

  pi.registerTool({
    name: "vcc_recall",
    label: "VCC Pi recall",
    description: "Recall exact, source-scoped items from the active Pi session branch. Results are bounded and redacted; archive and all-session lookup are unavailable in Pi V1.",
    promptSnippet: "Recall bounded source-backed items from this Pi branch",
    parameters: Type.Object({
      handle: Type.Optional(Type.String({ maxLength: 512 })),
      query: Type.Optional(Type.String({ maxLength: 1_024 })),
      expand: Type.Optional(Type.Array(Type.String({ maxLength: 512 }), { maxItems: 8 })),
      page: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_024 })),
      max_results: Type.Optional(Type.Integer({ minimum: 1, maximum: 16 })),
      max_bytes: Type.Optional(Type.Integer({ minimum: 256, maximum: VCC_PI_RECALL_MAX_BYTES })),
      scope: Type.Optional(Type.Union([Type.Literal("session"), Type.Literal("all")])),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      const max_bytes = Math.min(VCC_PI_RECALL_MAX_BYTES, Math.max(256, params.max_bytes ?? VCC_PI_RECALL_DEFAULT_MAX_BYTES))
      if (params.scope === "all") return piRecallToolResponse(vccPiRecallToolResult("unavailable", { reason: "scope_unavailable", scope: "session" }, max_bytes))
      const operations = [params.handle !== undefined, params.query !== undefined, params.expand !== undefined].filter(Boolean).length
      if (operations !== 1) return piRecallToolResponse(vccPiRecallToolResult("error", { reason: "exactly_one_operation_required", operations: ["handle", "query", "expand"] }, max_bytes))
      if (params.expand && (params.expand.length > 8 || new Set(params.expand).size !== params.expand.length)) return piRecallToolResponse(vccPiRecallToolResult("error", { reason: "duplicate_or_oversized_handles" }, max_bytes))
      const sessionID = ctx.sessionManager.getSessionId()
      if (!sessionID) return piRecallToolResponse(vccPiRecallToolResult("unavailable", { reason: "session_unavailable" }, max_bytes))
      const index = buildVccPiRecallIndex({ session_id: sessionID, branch: ctx.sessionManager.getBranch() })
      if (!index.complete) return piRecallToolResponse(vccPiRecallToolResult("incomplete", { reason: index.reason ?? "unsupported_record", scope: "active_branch" }, max_bytes))
      if (!index.entries.length) return piRecallToolResponse(vccPiRecallToolResult("unavailable", { reason: "no_canonical_entries", scope: "active_branch" }, max_bytes))
      if (params.handle !== undefined) {
        const resolvedHandle = resolveVccPiHandle({ handle: params.handle, session_id: sessionID, lineage_id: index.lineage_id, entries: index.entries, max_bytes })
        if (!resolvedHandle.ok) return piRecallToolResponse(vccPiRecallToolResult("unavailable", { reason: resolvedHandle.reason }, max_bytes))
        const rendered = renderVccPiRecallEntry(resolvedHandle.entry, max_bytes)
        return piRecallToolResponse(rendered === undefined
          ? vccPiRecallToolResult("unavailable", { reason: "oversized" }, max_bytes)
          : vccPiRecallToolResult("ok", { operation: "handle", item: JSON.parse(rendered) }, max_bytes))
      }
      if (params.expand !== undefined) {
        const item_bytes = Math.max(256, Math.floor(max_bytes / Math.max(1, params.expand.length)))
        const items = params.expand.map((handle) => {
          const resolvedHandle = resolveVccPiHandle({ handle, session_id: sessionID, lineage_id: index.lineage_id, entries: index.entries, max_bytes: item_bytes })
          if (!resolvedHandle.ok) return { handle, status: "unavailable", reason: resolvedHandle.reason }
          const rendered = renderVccPiRecallEntry(resolvedHandle.entry, item_bytes)
          return rendered === undefined ? { handle, status: "unavailable", reason: "oversized" } : { handle, status: "ok", item: JSON.parse(rendered) }
        })
        return piRecallToolResponse(vccPiRecallToolResult("ok", { operation: "expand", items }, max_bytes))
      }
      const query = params.query!.trim()
      if (!query) return piRecallToolResponse(vccPiRecallToolResult("error", { reason: "empty_query" }, max_bytes))
      const discovered = discoverVccPiHandles({ query, entries: index.entries, ...(params.page === undefined ? {} : { page: params.page }), max_results: params.max_results ?? VCC_PI_RECALL_DEFAULT_MAX_RESULTS })
      return piRecallToolResponse(vccPiRecallToolResult("ok", {
        operation: "discover",
        page: discovered.page,
        total_pages: discovered.total_pages,
        total: discovered.total,
        items: discovered.entries.map((entry) => ({
          handle: entry.handle,
          entry_id: entry.entry_id,
          parent_id: entry.parent_id,
          entry_type: entry.entry_type,
          timestamp: entry.timestamp,
          source_location: entry.source_location,
          source_digest: entry.source_digest,
          payload_digest: entry.payload_digest,
          presentation: "transformed_redacted",
        })),
      }, max_bytes))
    },
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
    const fixedPin = loadFixedPin(ctx.cwd, sessionID)
    const fixedFiles = fixedPin
      ? collectFiles(fixedPin.patterns, ctx.cwd, loadCatOptions(ctx.cwd), fixedPin.tokenBudget, fixedPin.excludeGitIgnored).files
      : []
    const artifacts = resolved.semantic_checkpoints
      ? semanticArtifacts(fixedFiles.length ? fixedFiles : catFilesFromMessages(messages), resolved.max_semantic_source_bytes)
      : []
    const records = toMessageRecords(
      fixedPin || resolved.semantic_checkpoints ? messages.filter((message) => !isCatAttachment(message)) : messages,
      sessionID,
    )
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
    const deterministic = () => ({
      summary: buildAuthoritativeSummary({ ledger, maxBytes: resolved.max_summary_bytes }),
      details: { ledgerDigest: ledger.digest, ledgerBytes: utf8Bytes(ledger.block), mode: resolved.vcc_mode },
    } satisfies PipelineResult)
    if (resolved.vcc_mode === "offline") return deterministic()
    const model = compactionModel(ctx, resolved.model)
    if (!model) return resolved.vcc_mode === "hybrid" ? deterministic() : undefined
    let semantic: { store: SemanticStore; repository: ReturnType<typeof repositoryIdentity>; extension: ReturnType<typeof semanticPromptExtension> } | undefined
    if (artifacts.length && resolved.response_mode === "json") {
      let store: SemanticStore | undefined
      try {
        store = new SemanticStore(semanticDatabasePath())
        const repository = repositoryIdentity(ctx.cwd)
        semantic = { store, repository, extension: semanticPromptExtension(store.context(repository.id), artifacts) }
      } catch (error) {
        store?.close()
        warnHook("semantic.prepare", sessionID, error)
      }
    }
    const prompt = buildCompactionPrompt(ledger, resolved.max_summary_bytes, projection, resolved.response_mode, semantic?.extension)
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
    ).catch((error) => {
      semantic?.store.close()
      throw error
    })
    if (signal.aborted) {
      semantic?.store.close()
      return
    }
    const text = response.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n")
    let summary = renderProjectedResponse(text, ledger, resolved.max_summary_bytes, resolved.response_mode)
    if (semantic) {
      try {
        const envelope = parseProjectionEnvelope(
          text,
          ledger,
          resolved.max_summary_bytes,
          ["semantic_delta"],
        )
        if (envelope) {
          summary = renderProjection(envelope.projection, ledger, Math.max(0, resolved.max_summary_bytes - SEMANTIC_CHECKPOINT_MAX_BYTES))
          const delta = validateSemanticDelta(envelope.extras.semantic_delta, artifacts, semantic.store.currentIDs(semantic.repository.id))
          if (delta && summary) {
            const checkpoint = semantic.store.commit(semantic.repository, artifacts, delta)
            summary = attachSemanticCheckpoint(summary, checkpoint, resolved.max_summary_bytes)
          }
        }
      } catch (error) {
        warnHook("semantic.commit", sessionID, error)
      } finally {
        semantic.store.close()
      }
    }
    summary ??= buildAuthoritativeSummary({ ledger, maxBytes: resolved.max_summary_bytes })
    return { summary, usage: response.usage, details: { ledgerDigest: ledger.digest, ledgerBytes: utf8Bytes(ledger.block), mode: resolved.vcc_mode } }
  }

  /** When /cat --fixed pinned files for this session, re-collect them fresh and
   *  embed the block at the front of the summary. The pinned block is
   *  deterministic, so the files stay loaded across compactions, pick up edits
   *  made since the last compaction, and form a cacheable fixed prefix. */
  async function withPinnedFiles(ctx: ExtensionContext, sessionID: string, summary: string): Promise<string> {
    const pin = loadFixedPin(ctx.cwd, sessionID)
    if (!pin || pin.sessionId !== sessionID) return summary
    const collected = collectFiles(pin.patterns, ctx.cwd, loadCatOptions(ctx.cwd), pin.tokenBudget, pin.excludeGitIgnored)
    if (!collected.files.length) return summary
    const usage = ctx.getContextUsage()
    const contextWindow = usage?.contextWindow
    if (contextWindow === undefined || contextWindow <= 0) return summary
    const summaryBytes = utf8Bytes(summary)
    const safeSummaryBytes = Math.floor(contextWindow * PINNED_FILES_MAX_FRACTION)
    const availablePinnedBytes = safeSummaryBytes - summaryBytes - 2
    if (availablePinnedBytes <= 0) return summary
    const pinned = formatPinnedBlock(collected.files, collected.skipped)
    if (utf8Bytes(pinned) <= availablePinnedBytes) return `${pinned}\n\n${summary}`
    const paths = pinnedPathsOnlyBlock(collected.files, availablePinnedBytes)
    if (utf8Bytes(paths) <= availablePinnedBytes) return `${paths}\n\n${summary}`
    return summary
  }

  pi.on("session_before_compact", async (event, ctx) => {
    const sessionID = ctx.sessionManager.getSessionId() ?? "pi-session"
    try {
      const branch = event.branchEntries ?? ctx.sessionManager.getBranch()
      const cut = resolved.vcc_mode === "off" ? undefined : buildPiVccCut(branch, resolved.tail_turns)
      if (resolved.vcc_mode !== "off" && !cut) return
      const result = await runPipeline({
        messages: cut?.messages ?? [...event.preparation.messagesToSummarize, ...event.preparation.turnPrefixMessages],
        branch,
        sessionID,
        signal: event.signal,
        ctx,
      })
      if (!result) return
      return {
        compaction: {
          summary: await withPinnedFiles(ctx, sessionID, result.summary),
          firstKeptEntryId: cut?.firstKeptEntryId ?? event.preparation.firstKeptEntryId,
          tokensBefore: event.preparation.tokensBefore,
          ...(result.usage ? { usage: result.usage } : {}),
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
      return { summary: { summary: await withPinnedFiles(ctx, sessionID, result.summary), ...(result.usage ? { usage: result.usage } : {}), details: result.details } }
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

function piRecallToolResponse(result: ReturnType<typeof vccPiRecallToolResult>) {
  return { content: [{ type: "text" as const, text: result.output }], details: result.metadata }
}

function compactionModel(ctx: ExtensionContext, spec: string): Model<Api> | undefined {
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
