import { buildRecoveryLedger, type MessageRecord } from "../../src/ledger.js"
import { DEFAULT_OPTIONS } from "../../src/options.js"
import {
  buildAuthoritativeSummary,
  buildCompactionPrompt,
  isAuthoritativeSummary,
  parsePluginLedger,
} from "../../src/validation.js"
import type { EvalCase, PreparedCondition } from "../types.js"
import { transcriptMessages } from "./transcript.js"

export function preparePlugin(test: EvalCase): PreparedCondition {
  const ledger = buildRecoveryLedger({
    messages: ledgerMessages(test),
    todos: test.todos,
    tailTurns: DEFAULT_OPTIONS.tail_turns,
    maxBytes: DEFAULT_OPTIONS.max_ledger_bytes,
  })
  return {
    messages: [
      ...transcriptMessages(test),
      { role: "user", content: buildCompactionPrompt(ledger, DEFAULT_OPTIONS.max_summary_bytes) },
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
      const acceptedText = buildAuthoritativeSummary({ ledger, maxBytes: DEFAULT_OPTIONS.max_summary_bytes })
      const parsed = parsePluginLedger(acceptedText)
      return {
        acceptedText,
        structuralValid: isAuthoritativeSummary(acceptedText, DEFAULT_OPTIONS.max_summary_bytes),
        digestValid: parsed?.block === ledger.block,
        autoContinue: true,
        usedFallback: text !== acceptedText,
        zeroText: false,
      }
    },
  }
}

function ledgerMessages(test: EvalCase): MessageRecord[] {
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
