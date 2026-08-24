import type { AgentMessage } from "@earendil-works/pi-agent-core"
import type { SessionEntry } from "@earendil-works/pi-coding-agent"

type LiveEntry = {
  entry: SessionEntry
  message: AgentMessage
}
export type PiVccCut = {
  messages: AgentMessage[]
  firstKeptEntryId: string
  compactAll: boolean
  totalUserTurns: number
  keptUserTurns: number
}

/** Rebuild the live branch from Pi's canonical entries. This mirrors Pi VCC's
 *  orphan recovery rule: a missing/empty previous boundary means that the
 *  next pass starts after the last compaction instead of silently replaying
 *  pre-compaction history. */
export function collectPiVccLiveEntries(entries: readonly SessionEntry[]): LiveEntry[] {
  let compactionIndex = -1
  let keptID: string | undefined
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]
    if (entry?.type !== "compaction") continue
    compactionIndex = index
    keptID = entry.firstKeptEntryId
    break
  }
  const orphan = compactionIndex >= 0 && (!keptID || !entries.some((entry) => entry.id === keptID))
  const start = orphan ? compactionIndex + 1 : keptID ? entries.findIndex((entry) => entry.id === keptID) : 0
  if (start < 0) return collectAfterCompaction(entries, compactionIndex)
  return entries.slice(start).flatMap((entry) => {
    if (entry.type === "compaction") return []
    const message = entryToLiveMessage(entry)
    return message ? [{ entry, message }] : []
  })
}

/** Select the prefix Pi VCC should summarize while keeping a user-turn tail.
 *  Boundaries are always user messages, so a tool call/result pair cannot be
 *  split across the compaction cut. */
export function buildPiVccCut(entries: readonly SessionEntry[], keepUserTurns: number): PiVccCut | undefined {
  const live = collectPiVccLiveEntries(entries)
  if (live.length <= 2) return undefined
  const userIndices = live.flatMap((item, index) => item.message.role === "user" ? [index] : [])
  const totalUserTurns = userIndices.length
  const normalizedKeep = Number.isFinite(keepUserTurns) ? Math.max(0, Math.floor(keepUserTurns)) : 0
  const compactAll = (keptUserTurns: number): PiVccCut => ({
    messages: live.map((item) => item.message),
    firstKeptEntryId: "",
    compactAll: true,
    totalUserTurns,
    keptUserTurns,
  })
  if (normalizedKeep <= 0) return compactAll(0)
  const target = totalUserTurns - normalizedKeep
  const cutIndex = target >= 0 ? userIndices[target] : undefined
  if (cutIndex === undefined || cutIndex <= 0) return compactAll(0)
  return {
    messages: live.slice(0, cutIndex).map((item) => item.message),
    firstKeptEntryId: live[cutIndex]!.entry.id,
    compactAll: false,
    totalUserTurns,
    keptUserTurns: totalUserTurns - target,
  }
}

function collectAfterCompaction(entries: readonly SessionEntry[], compactionIndex: number): LiveEntry[] {
  return entries.slice(Math.max(0, compactionIndex + 1)).flatMap((entry) => {
    if (entry.type === "compaction") return []
    const message = entryToLiveMessage(entry)
    return message ? [{ entry, message }] : []
  })
}

function entryToLiveMessage(entry: SessionEntry): AgentMessage | undefined {
  if (entry.type === "message") return entry.message
  if (entry.type === "custom_message") {
    return {
      role: "custom",
      customType: entry.customType,
      content: entry.content,
      display: entry.display,
      details: entry.details,
      timestamp: new Date(entry.timestamp).getTime(),
    } as unknown as AgentMessage
  }
  if (entry.type === "branch_summary") {
    return {
      role: "branchSummary",
      summary: entry.summary,
      fromId: entry.fromId,
      timestamp: new Date(entry.timestamp).getTime(),
    } as unknown as AgentMessage
  }
  return undefined
}
