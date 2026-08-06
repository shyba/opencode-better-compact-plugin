import { buildRecoveryLedger, type MessageRecord } from "../../src/ledger.js"
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

export type PluginMode = "markdown" | "json" | "fallback"

// The deterministic fallback condition reproduces the V1 runtime contract: whatever the
// model produced, the accepted text is the ledger-grounded authoritative summary, and
// continuation is gated on that summary's structure and digest.
export function preparePlugin(test: EvalCase, mode: PluginMode = "fallback"): PreparedCondition {
  const ledger = buildRecoveryLedger({
    messages: ledgerMessages(test),
    todos: test.todos,
    tailTurns: DEFAULT_OPTIONS.tail_turns,
    maxBytes: DEFAULT_OPTIONS.max_ledger_bytes,
  })
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
