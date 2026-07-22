import type { ProviderAdapter } from "../types.js"

export function openAICompatibleProvider(): ProviderAdapter {
  const url = process.env.SAFE_COMPACTION_EVAL_URL
  const model = process.env.SAFE_COMPACTION_EVAL_MODEL
  const apiKey = process.env.SAFE_COMPACTION_EVAL_API_KEY
  if (!url) throw new TypeError("SAFE_COMPACTION_EVAL_URL is required for the openai-compatible provider")
  if (!model) throw new TypeError("SAFE_COMPACTION_EVAL_MODEL is required for the openai-compatible provider")
  return {
    name: "openai-compatible",
    async complete(request) {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          model,
          messages: request.messages,
          temperature: 0,
          max_tokens: 16_384,
        }),
      })
      if (!response.ok) {
        throw new Error(`provider returned HTTP ${response.status} for ${request.condition}/${request.caseID}`)
      }
      const text = responseText(await response.json())
      if (text === undefined) throw new Error(`provider returned no text for ${request.condition}/${request.caseID}`)
      return { text }
    },
  }
}

function responseText(value: unknown) {
  const object = record(value)
  const choices = object?.choices
  if (!Array.isArray(choices)) return
  const message = record(record(choices[0])?.message)
  if (typeof message?.content === "string") return message.content
  if (!Array.isArray(message?.content)) return
  return message.content
    .flatMap((part) => {
      const current = record(part)
      return typeof current?.text === "string" ? [current.text] : []
    })
    .join("")
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  return value as Record<string, unknown>
}
