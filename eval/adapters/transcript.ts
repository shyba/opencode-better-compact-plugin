import type { EvalCase, ProviderMessage } from "../types.js"

export function transcriptMessages(test: EvalCase): ProviderMessage[] {
  return test.messages.map((message) => ({
    role: message.role,
    content: [
      message.text,
      ...(message.tool
        ? [
            `[Tool ${message.tool.name} ${message.tool.status}] ${message.tool.title}`,
            message.tool.error ?? message.tool.output ?? "",
          ]
        : []),
    ]
      .filter(Boolean)
      .join("\n"),
  }))
}
