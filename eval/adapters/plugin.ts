import { buildRecoveryLedger, utf8Bytes, type MessageRecord } from "../../src/ledger.js"
import { DEFAULT_OPTIONS } from "../../src/options.js"
import {
  buildAuthoritativeSummary,
  buildCompactionPrompt,
  isAuthoritativeSummary,
  parsePluginLedger,
  renderProjectedResponse,
} from "../../src/validation.js"
import type { EvalCase, PreparedCondition } from "../types.js"
import { transcriptMessages } from "./transcript.js"
import {
  buildSourceCompleteness,
  canonicalSerialize,
  compileVccCandidate,
  formCausalEpisodes,
  normalizeCanonicalEvents,
  type CanonicalEventInput,
} from "../../src/vcc.js"
import { vccOpenCodeArchiveManifestDigest } from "../../src/vcc-opencode-recall.js"
import { renderVccOpenCodeProjection } from "../../src/vcc-opencode-render.js"
import { isVccSuccessfulSummary } from "../../src/vcc-wire.js"

export type PluginMode = "markdown" | "json" | "fallback"

// The deterministic fallback condition reproduces the V1 runtime contract: whatever the
// model produced, the accepted text is the ledger-grounded authoritative summary, and
// continuation is gated on that summary's structure and digest.
export function preparePlugin(test: EvalCase, mode: PluginMode = "fallback"): PreparedCondition {
  const ledger = evalLedger(test)
  const maxSummaryBytes = DEFAULT_OPTIONS.max_summary_bytes
  const promptMode = mode === "fallback" ? "json" : mode
  return {
    messages: [
      ...transcriptMessages(test),
      { role: "user", content: buildCompactionPrompt(ledger, maxSummaryBytes, undefined, promptMode) },
    ],
    finish(text) {
      // In the V1 runtime an empty stream does not emit experimental.text.complete.
      // It is therefore not replaced, and must never authorize continuation.
      if (!text.trim()) {
        return {
          acceptedText: "",
          structuralValid: false,
          digestValid: false,
          autoContinue: false,
          usedFallback: false,
          zeroText: true,
        }
      }
      const fallback = buildAuthoritativeSummary({ ledger, maxBytes: maxSummaryBytes })
      if (mode === "fallback") {
        const parsed = parsePluginLedger(fallback)
        return {
          acceptedText: fallback,
          structuralValid: isAuthoritativeSummary(fallback, maxSummaryBytes),
          digestValid: parsed?.block === ledger.block,
          autoContinue: true,
          usedFallback: text !== fallback,
          zeroText: false,
        }
      }
      const accepted = renderProjectedResponse(text, ledger, maxSummaryBytes, mode)
      const acceptedText = accepted ?? fallback
      const parsed = parsePluginLedger(acceptedText)
      return {
        acceptedText,
        structuralValid: accepted
          ? true
          : isAuthoritativeSummary(fallback, maxSummaryBytes),
        digestValid: parsed?.block === ledger.block,
        autoContinue: Boolean(accepted),
        usedFallback: !accepted,
        zeroText: false,
      }
    },
  }
}

export function prepareOffline(test: EvalCase): PreparedCondition {
  const ledger = evalLedger(test)
  const session_id = `eval-${test.id}`
  const lineage_id = `eval-vcc-${test.id}`
  const events = normalizeCanonicalEvents(vccEventInputs(test, session_id, lineage_id))
  const source = buildSourceCompleteness({
    host: "opencode-v1",
    session_id,
    lineage_id,
    events,
    page_count: 1,
    terminal_cursor: null,
    byte_count: utf8Bytes(canonicalSerialize(events)),
  })
  const candidate = compileVccCandidate({
    events,
    episodes: formCausalEpisodes(events),
    source,
    options: { max_bytes: Math.max(128 * 1_024, DEFAULT_OPTIONS.max_summary_bytes) },
  })
  const archive_manifest_digest = vccOpenCodeArchiveManifestDigest(candidate, session_id, lineage_id)
  if (!archive_manifest_digest) throw new Error(`offline VCC candidate has no archive manifest: ${test.id}`)
  const deterministicText = renderVccOpenCodeProjection({
    candidate,
    patch_digest: null,
    archive_manifest_digest,
    ledger,
    max_bytes: DEFAULT_OPTIONS.max_summary_bytes,
  })
  if (!deterministicText) throw new Error(`offline VCC projection exceeds its bound: ${test.id}`)
  const expected = {
    source_manifest_digest: candidate.source_manifest_digest,
    source_index_digest: candidate.source_index_digest,
    archive_manifest_digest,
    candidate_digest: candidate.digest,
    patch_digest: null,
  }
  return {
    messages: [],
    deterministicText,
    finish(text) {
      const nonempty = Boolean(text.trim())
      const valid = nonempty && isVccSuccessfulSummary(text, expected)
      return {
        acceptedText: valid ? text : "",
        structuralValid: valid,
        digestValid: valid,
        autoContinue: valid,
        usedFallback: false,
        zeroText: !nonempty,
      }
    },
  }
}

function vccEventInputs(test: EvalCase, session_id: string, lineage_id: string): CanonicalEventInput[] {
  const inputs: CanonicalEventInput[] = []
  for (const [messageIndex, message] of test.messages.entries()) {
    const messageID = `${test.id}-message-${messageIndex + 1}`
    inputs.push({
      host: "opencode-v1",
      session_id,
      lineage_id,
      stable_source_id: messageID,
      sequence: inputs.length,
      provenance: message.role === "user" ? "human_direct" : "assistant",
      kind: message.role === "user" ? "request" : "message",
      content: message.text,
      source_location: `eval:${messageID}`,
    })
    if (!message.tool) continue
    const pair_id = `${test.id}-tool-${messageIndex + 1}`
    const toolID = `${messageID}-tool-${messageIndex + 1}`
    inputs.push({
      host: "opencode-v1",
      session_id,
      lineage_id,
      stable_source_id: `${toolID}-call`,
      sequence: inputs.length,
      provenance: "tool_call",
      kind: "tool_call",
      pair_id,
      content: canonicalSerialize({ tool: message.tool.name, input: message.tool.input }),
      source_location: `eval:${toolID}:call`,
    })
    if (message.tool.status !== "completed" && message.tool.status !== "error") continue
    inputs.push({
      host: "opencode-v1",
      session_id,
      lineage_id,
      stable_source_id: `${toolID}-result`,
      sequence: inputs.length,
      provenance: "tool_result",
      kind: "tool_result",
      pair_id,
      content: canonicalSerialize({
        tool: message.tool.name,
        ...(message.tool.error === undefined ? { output: message.tool.output ?? "" } : { error: message.tool.error }),
      }),
      source_location: `eval:${toolID}:result`,
    })
  }
  return inputs
}

function evalLedger(test: EvalCase) {
  return buildRecoveryLedger({
    messages: ledgerMessages(test),
    todos: test.todos,
    tailTurns: DEFAULT_OPTIONS.tail_turns,
    maxBytes: DEFAULT_OPTIONS.max_ledger_bytes,
  })
}

export function ledgerMessages(test: EvalCase): MessageRecord[] {
  return test.messages.map((message, index) => ({
    info: {
      id: `${test.id}-message-${index + 1}`,
      sessionID: `eval-${test.id}`,
      role: message.role,
    },
    parts: [
      {
        id: `${test.id}-part-${index + 1}`,
        sessionID: `eval-${test.id}`,
        messageID: `${test.id}-message-${index + 1}`,
        type: "text",
        text: message.text,
      },
      ...(message.tool
        ? [
            {
              id: `${test.id}-tool-${index + 1}`,
              sessionID: `eval-${test.id}`,
              messageID: `${test.id}-message-${index + 1}`,
              type: "tool",
              tool: message.tool.name,
              state: {
                status: message.tool.status,
                title: message.tool.title,
                input: message.tool.input,
                ...(message.tool.output ? { output: message.tool.output } : {}),
                ...(message.tool.error ? { error: message.tool.error } : {}),
              },
            },
          ]
        : []),
    ],
  }))
}
