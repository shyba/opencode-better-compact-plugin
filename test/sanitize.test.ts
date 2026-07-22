import { describe, expect, test } from "bun:test"
import type { Hooks } from "@opencode-ai/plugin"
import { parseOptions, resolveOptions } from "../src/options.js"
import { sanitizeHistory } from "../src/sanitize.js"

type Message = Parameters<NonNullable<Hooks["experimental.chat.messages.transform"]>>[1]["messages"][number]

const options = resolveOptions(parseOptions({ model: "test/model", max_historical_part_bytes: 256 }))

function message(parts: Message["parts"]): Message {
  return { info: { id: "assistant", sessionID: "session", role: "assistant" }, parts } as Message
}

describe("complete model-visible history sanitation", () => {
  test("redacts and bounds text, reasoning, tool input, output, errors, and attachments", () => {
    const secret = "sk-" + "a".repeat(24)
    const messages = [message([
      { id: "text", messageID: "assistant", sessionID: "session", type: "text", text: `Authorization: Bearer ${secret}`, metadata: { private: "TEXT-METADATA-SENTINEL" } },
      { id: "reasoning", messageID: "assistant", sessionID: "session", type: "reasoning", text: `token=${secret}`, time: { start: 1 }, metadata: { signature: "REASONING-SIGNATURE-SENTINEL" } },
      {
        id: "tool",
        messageID: "assistant",
        sessionID: "session",
        type: "tool",
        callID: "call",
        tool: "shell",
        metadata: { providerExecuted: true, google: { thoughtSignature: "tool_sig" } },
        state: {
          status: "completed",
          input: { authorization: `Bearer ${secret}`, huge: "i".repeat(1_000_000) },
          output: `HEAD token=${secret} ${"o".repeat(10_000)} TAIL password=${secret}`,
          title: "shell",
          metadata: { password: "short-secret", huge: "m".repeat(1_000_000) },
          time: { start: 1, end: 2 },
          attachments: [{ id: "attachment", messageID: "assistant", sessionID: "session", type: "file", mime: "text/plain", url: `data:text/plain,${secret}` }],
        },
      },
      {
        id: "error",
        messageID: "assistant",
        sessionID: "session",
        type: "tool",
        callID: "error-call",
        tool: "shell",
        state: { status: "error", input: { password: secret }, error: `authorization=${secret}`, time: { start: 1, end: 2 } },
      },
    ] as Message["parts"])]

    sanitizeHistory(messages, options)

    const serialized = JSON.stringify(messages)
    expect(serialized).not.toContain(secret)
    expect(serialized).not.toContain("TEXT-METADATA-SENTINEL")
    expect(serialized).not.toContain("REASONING-SIGNATURE-SENTINEL")
    expect(serialized).not.toContain("short-secret")
    expect(serialized).toContain("[REDACTED]")
    expect(messages[0]!.parts[1]).toMatchObject({ type: "text", synthetic: true })
    const completed = messages[0]!.parts[2] as Extract<Message["parts"][number], { type: "tool" }>
    expect(completed.state.status).toBe("completed")
    if (completed.state.status !== "completed") throw new Error("expected completed tool")
    expect(completed.state.output).toContain("middle omitted")
    expect(completed.state.output).toStartWith("HEAD")
    expect(completed.state.output).toContain("TAIL")
    expect(completed.state.attachments).toEqual([])
    expect(completed.metadata).toEqual({ providerExecuted: true, google: { thoughtSignature: "tool_sig" } })
    expect(JSON.stringify(completed.state.input).length).toBeLessThanOrEqual(options.max_historical_part_bytes)
    expect(JSON.stringify(completed.state.metadata).length).toBeLessThanOrEqual(options.max_historical_part_bytes)
  })

  test("redacts credential-keyed values, enforces serialized bounds, and blocks prototype pollution", () => {
    const bounded = resolveOptions(parseOptions({ model: "test/model", max_historical_part_bytes: 128 }))
    const polluted = JSON.parse('{"__proto__":{"polluted":"yes"},"password":"short-secret","access_token":"plain-access","client_secret":"plain-client"}') as Record<string, unknown>
    Object.assign(polluted, {
      DB_PASSWORD: "short-db-pass",
      POSTGRES_PASSWORD: "short-pg-pass",
      AWS_SECRET_ACCESS_KEY: "short-aws-secret",
      AWS_ACCESS_KEY_ID: "short-aws-id",
      SESSION_TOKEN: "short-session-token",
      SSH_PRIVATE_KEY: "short-private-key",
    })
    Object.assign(polluted, Object.fromEntries(Array.from({ length: 128 }, (_, index) => [`long-key-${index}-${"k".repeat(128)}`, "value"])))
    polluted["k".repeat(256 * 1_024)] = "oversized-key-value"
    const messages = [message([{
      id: "tool",
      messageID: "assistant",
      sessionID: "session",
      type: "tool",
      callID: "call",
      tool: "read",
      state: { status: "completed", input: polluted, output: "done", title: "read", metadata: {}, time: { start: 1, end: 2 } },
    }] as Message["parts"])]

    sanitizeHistory(messages, bounded)
    const part = messages[0]!.parts[0] as Extract<Message["parts"][number], { type: "tool" }>
    const serialized = JSON.stringify(part.state.input)
    expect(new TextEncoder().encode(serialized).byteLength).toBeLessThanOrEqual(128)
    expect(serialized).not.toContain("short-secret")
    expect(serialized).not.toContain("plain-access")
    expect(serialized).not.toContain("plain-client")
    expect(serialized).not.toContain("short-db-pass")
    expect(serialized).not.toContain("short-pg-pass")
    expect(serialized).not.toContain("short-aws-secret")
    expect(serialized).not.toContain("short-aws-id")
    expect(serialized).not.toContain("short-session-token")
    expect(serialized).not.toContain("short-private-key")
    expect((part.state.input as Record<string, unknown>).polluted).toBeUndefined()
    expect(Object.getPrototypeOf(part.state.input)).not.toEqual({ polluted: "yes" })
  })

  test("drops oversized opaque provider metadata but preserves bounded continuation signatures", () => {
    const messages = [message([
      {
        id: "kept",
        messageID: "assistant",
        sessionID: "session",
        type: "tool",
        callID: "kept-call",
        tool: "read",
        metadata: { google: { thoughtSignature: "tool_sig" } },
        state: { status: "completed", input: {}, output: "done", title: "read", metadata: {}, time: { start: 1, end: 2 } },
      },
      {
        id: "dropped",
        messageID: "assistant",
        sessionID: "session",
        type: "tool",
        callID: "dropped-call",
        tool: "read",
        metadata: { providerExecuted: true, google: { thoughtSignature: "x".repeat(70_000) } },
        state: { status: "completed", input: {}, output: "done", title: "read", metadata: {}, time: { start: 1, end: 2 } },
      },
    ] as Message["parts"])]

    sanitizeHistory(messages, options)
    expect((messages[0]!.parts[0] as Extract<Message["parts"][number], { type: "tool" }>).metadata).toEqual({
      google: { thoughtSignature: "tool_sig" },
    })
    expect((messages[0]!.parts[1] as Extract<Message["parts"][number], { type: "tool" }>).metadata).toEqual({
      providerExecuted: true,
    })
  })

  test("redacts common prefixed structured credential keys without relying on value shape", () => {
    const messages = [message([{
      id: "tool",
      messageID: "assistant",
      sessionID: "session",
      type: "tool",
      callID: "credential-call",
      tool: "read",
      state: {
        status: "completed",
        input: {
          DB_PASSWORD: "short-db-pass",
          POSTGRES_PASSWORD: "short-pg-pass",
          AWS_SECRET_ACCESS_KEY: "short-aws-secret",
          AWS_ACCESS_KEY_ID: "short-aws-id",
          SESSION_TOKEN: "short-session-token",
          SSH_PRIVATE_KEY: "short-private-key",
          safe_field: "visible",
        },
        output: "done",
        title: "read",
        metadata: {},
        time: { start: 1, end: 2 },
      },
    }] as Message["parts"])]

    sanitizeHistory(messages, options)
    const part = messages[0]!.parts[0] as Extract<Message["parts"][number], { type: "tool" }>
    expect(part.state.input).toMatchObject({
      DB_PASSWORD: "[REDACTED]",
      POSTGRES_PASSWORD: "[REDACTED]",
      AWS_SECRET_ACCESS_KEY: "[REDACTED]",
      AWS_ACCESS_KEY_ID: "[REDACTED]",
      SESSION_TOKEN: "[REDACTED]",
      SSH_PRIVATE_KEY: "[REDACTED]",
      safe_field: "visible",
    })
  })

  test("omits malformed and valid inline data without throwing or exposing payloads", () => {
    const messages = [message([
      { id: "bad", messageID: "assistant", sessionID: "session", type: "file", mime: "text/plain", filename: "bad.txt", url: "data:not-valid" },
      { id: "valid", messageID: "assistant", sessionID: "session", type: "file", mime: "text/plain", filename: "valid.txt", url: "data:text/plain,PRIVATE-PAYLOAD" },
    ] as Message["parts"])]

    expect(() => sanitizeHistory(messages, options)).not.toThrow()
    expect(JSON.stringify(messages)).toContain("malformed inline data")
    expect(JSON.stringify(messages)).toContain("15-byte inline data")
    expect(JSON.stringify(messages)).not.toContain("PRIVATE-PAYLOAD")
  })

  test("handles a very large tool output without retaining a large result", () => {
    const output = `HEAD-${"x".repeat(50 * 1_024 * 1_024)}-TAIL`
    const messages = [message([{
      id: "tool",
      messageID: "assistant",
      sessionID: "session",
      type: "tool",
      callID: "call",
      tool: "read",
      state: { status: "completed", input: {}, output, title: "read", metadata: {}, time: { start: 1, end: 2 } },
    }] as Message["parts"])]

    sanitizeHistory(messages, options)
    const part = messages[0]!.parts[0] as Extract<Message["parts"][number], { type: "tool" }>
    if (part.state.status !== "completed") throw new Error("expected completed tool")
    expect(part.state.output.length).toBeLessThan(2_000)
    expect(part.state.output).toStartWith("HEAD-")
    expect(part.state.output).toEndWith("-TAIL")
  })
})
