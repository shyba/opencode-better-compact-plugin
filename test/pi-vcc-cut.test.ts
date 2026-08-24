import { describe, expect, test } from "bun:test"
import type { AgentMessage } from "@earendil-works/pi-agent-core"
import type { SessionEntry } from "@earendil-works/pi-coding-agent"
import { buildPiVccCut, collectPiVccLiveEntries } from "../src/pi-vcc-cut.js"

function user(text: string): AgentMessage { return { role: "user", content: text, timestamp: 1 } }
function assistant(text: string): AgentMessage {
  return { role: "assistant", content: [{ type: "text", text }], api: "openai-completions", provider: "test", model: "test", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 1 } as AgentMessage
}
function entry(id: string, parentId: string | null, message: AgentMessage): SessionEntry { return { type: "message", id, parentId, timestamp: "2026-01-01T00:00:00.000Z", message } as SessionEntry }

describe("Pi VCC branch cut", () => {
  test("keeps the requested user-turn tail and returns its stable entry id", () => {
    const branch = [entry("u1", null, user("one")), entry("a1", "u1", assistant("done")), entry("u2", "a1", user("two")), entry("a2", "u2", assistant("done"))]
    const cut = buildPiVccCut(branch, 1)
    expect(cut).toMatchObject({ firstKeptEntryId: "u2", compactAll: false, totalUserTurns: 2, keptUserTurns: 1 })
    expect(cut?.messages).toHaveLength(2)
  })

  test("recovers after a compact-all sentinel without replaying old history", () => {
    const branch = [
      entry("u1", null, user("one")),
      entry("a1", "u1", assistant("done")),
      { type: "compaction", id: "c1", parentId: "a1", timestamp: "2026-01-01T00:00:00.000Z", summary: "summary", firstKeptEntryId: "", tokensBefore: 100 } as SessionEntry,
      entry("u2", "c1", user("two")),
      entry("a2", "u2", assistant("done")),
    ]
    expect(collectPiVccLiveEntries(branch).map((item) => item.entry.id)).toEqual(["u2", "a2"])
  })
})
