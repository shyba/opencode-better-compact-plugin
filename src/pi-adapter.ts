import { readFileSync } from "node:fs"
import { mkdir, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { CONFIG_DIR_NAME, type SessionEntry } from "@earendil-works/pi-coding-agent"
import type { AgentMessage } from "@earendil-works/pi-agent-core"
import type { ImageContent, TextContent, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai"
import type { MessageRecord, RecoveryLedger, TodoRecord } from "./ledger.js"
import { parseOptions, type ParsedOptions, type PluginOptions } from "./options.js"
import type { ProjectedSummary } from "./projection.js"
import { parsePluginLedger, parseProjectedSummary } from "./validation.js"
import { CAT_INJECTION_MARKER } from "./cat-core.js"

export const PI_CONFIG_FILENAME = "safe-compaction.json"

export type PriorPluginSummary = {
  id: string
  ledger: RecoveryLedger
  projection?: ProjectedSummary
}

// pi manages its own recent-history budgets (compaction.reserveTokens /
// compaction.keepRecentTokens in pi settings), so the OpenCode-managed fields
// preserve_recent_tokens and reserved_tokens are not persisted here.
const PERSISTED_OPTION_KEYS = [
  "model",
  "response_mode",
  "tail_turns",
  "max_output_tokens",
  "max_user_text_bytes",
  "max_inline_data_bytes",
  "max_historical_part_bytes",
  "max_ledger_bytes",
  "max_summary_bytes",
] as const satisfies readonly (keyof PluginOptions)[]

/** True when the message is a /cat attachment message (its text carries the
 *  injection marker). Such messages are file content, not conversation, so the
 *  compaction pipeline skips them: the files are re-attached deterministically
 *  from the fixed pin instead of being summarized by the model. */
export function isCatAttachment(message: AgentMessage): boolean {
  if (message.role === "compactionSummary" || message.role === "branchSummary") {
    return message.summary.includes(CAT_INJECTION_MARKER)
  }
  if (message.role !== "user" && message.role !== "custom") return false
  if (typeof message.content === "string") return message.content.includes(CAT_INJECTION_MARKER)
  return message.content.some((block) => block.type === "text" && block.text.includes(CAT_INJECTION_MARKER))
}

/** Convert pi AgentMessages into the plugin's host-agnostic MessageRecord shape.
 *  Tool calls and their matching tool results are folded into the assistant
 *  message as tool parts so the ledger's tool-status collection works. */
export function toMessageRecords(messages: readonly AgentMessage[], sessionID: string): MessageRecord[] {
  const resultsByCallID = new Map<string, ToolResultMessage>()
  for (const message of messages) {
    if (message.role !== "toolResult") continue
    resultsByCallID.set(message.toolCallId, message)
  }
  const foldedCallIDs = new Set<string>()
  const records: MessageRecord[] = []
  for (const message of messages) {
    if (message.role === "user") {
      const id = messageID(sessionID, records.length)
      records.push({ info: { id, sessionID, role: "user" }, parts: userParts(message.content, id, sessionID) })
      continue
    }
    if (message.role === "assistant") {
      const id = messageID(sessionID, records.length)
      const parts: unknown[] = []
      for (const block of message.content) {
        if (block.type === "text") {
          parts.push({ id: `${id}-p${parts.length}`, sessionID, messageID: id, type: "text", text: block.text })
          continue
        }
        if (block.type === "thinking") {
          parts.push({ id: `${id}-p${parts.length}`, sessionID, messageID: id, type: "reasoning", text: block.thinking })
          continue
        }
        if (block.type === "toolCall") {
          const result = resultsByCallID.get(block.id)
          if (result) foldedCallIDs.add(result.toolCallId)
          parts.push(toolPart(block, result, id, sessionID))
        }
      }
      records.push({ info: { id, sessionID, role: "assistant" }, parts })
      continue
    }
    if (message.role === "toolResult") {
      // Already folded into its assistant toolCall above; only emit standalone
      // when no matching toolCall exists in the window.
      if (foldedCallIDs.has(message.toolCallId)) continue
      const id = messageID(sessionID, records.length)
      records.push({ info: { id, sessionID, role: "assistant" }, parts: [standaloneToolPart(message, id, sessionID)] })
      continue
    }
    if (message.role === "bashExecution") {
      if (message.excludeFromContext === true) continue
      const id = messageID(sessionID, records.length)
      records.push({
        info: { id, sessionID, role: "user" },
        parts: [{ id, sessionID, messageID: id, type: "text", text: bashExecutionText(message) }],
      })
      continue
    }
    if (message.role === "custom") {
      if (message.display === false) continue
      const id = messageID(sessionID, records.length)
      records.push({ info: { id, sessionID, role: "user" }, parts: userParts(message.content, id, sessionID) })
      continue
    }
    if (message.role === "compactionSummary") {
      const id = messageID(sessionID, records.length)
      records.push({
        info: { id, sessionID, role: "assistant", summary: true },
        parts: [{ id, sessionID, messageID: id, type: "text", text: message.summary }],
      })
      continue
    }
    if (message.role === "branchSummary") {
      const id = messageID(sessionID, records.length)
      records.push({
        info: { id, sessionID, role: "assistant", summary: true },
        parts: [{ id, sessionID, messageID: id, type: "text", text: message.summary }],
      })
      continue
    }
  }
  return records
}

/** If a todo-tracking extension is installed, scan the branch for its most
 *  recent todo tool result and return its list. Empty array otherwise. */
export function todosFromBranch(branch: readonly SessionEntry[]): TodoRecord[] {
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index]
    if (!entry || entry.type !== "message" || entry.message.role !== "toolResult" || entry.message.toolName !== "todo") continue
    const details = recordOf(entry.message.details)
    const list = details?.todos
    if (!Array.isArray(list)) continue
    const todos = list.flatMap((item): TodoRecord[] => {
      const todo = recordOf(item)
      if (!todo || typeof todo.text !== "string" || !todo.text.trim()) return []
      const result: TodoRecord = {
        content: todo.text,
        status: typeof todo.status === "string" ? todo.status : todo.done === true ? "completed" : "pending",
        priority: typeof todo.priority === "string" ? todo.priority : "unknown",
      }
      if (typeof todo.id === "string" && todo.id) result.id = todo.id
      else if (typeof todo.id === "number" && Number.isFinite(todo.id)) result.id = String(todo.id)
      return [result]
    })
    if (todos.length) return todos
  }
  return []
}

/** Find the most recent CompactionEntry whose summary carries a plugin-valid
 *  canonical ledger so a prior ledger can be chained across compactions. */
export function priorPluginSummary(branch: readonly SessionEntry[]): PriorPluginSummary | undefined {
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index]
    if (!entry || entry.type !== "compaction") continue
    const ledger = parsePluginLedger(entry.summary)
    if (!ledger) continue
    const result: PriorPluginSummary = { id: entry.id, ledger }
    const projection = parseProjectedSummary(entry.summary, ledger)
    if (projection) result.projection = projection
    return result
  }
  return undefined
}

/** Read the pi-side option file at <cwd>/.pi/safe-compaction.json. Any read or
 *  validation failure falls back to defaults so a bad file never breaks pi. */
export function loadPiOptions(cwd: string): ParsedOptions {
  try {
    const raw = readFileSync(path.join(cwd, CONFIG_DIR_NAME, PI_CONFIG_FILENAME), "utf8")
    const value = JSON.parse(raw) as unknown
    if (!value || typeof value !== "object" || Array.isArray(value)) return {}
    return parseOptions(value as Record<string, unknown>)
  } catch {
    return {}
  }
}

/** Write the pi-side option file with mode 0600, atomic rename, and a lock. */
export async function savePiOptions(cwd: string, options: PluginOptions): Promise<void> {
  const dir = path.join(cwd, CONFIG_DIR_NAME)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const file = path.join(dir, PI_CONFIG_FILENAME)
  const lock = `${file}.lock`
  try {
    await mkdir(lock, { recursive: false, mode: 0o700 })
  } catch {
    throw new Error(`safe-compaction pi configuration is busy: ${file}`)
  }
  try {
    const temporary = `${file}.tmp-${process.pid}`
    await writeFile(temporary, `${JSON.stringify(persistedOptions(options), null, 2)}\n`, { mode: 0o600 })
    await rename(temporary, file)
  } finally {
    await rm(lock, { recursive: true, force: true })
  }
}

function persistedOptions(options: PluginOptions): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const key of PERSISTED_OPTION_KEYS) result[key] = options[key]
  return result
}

function messageID(sessionID: string, index: number) {
  return `${sessionID}-pi-${index + 1}`
}

function userParts(content: string | (TextContent | ImageContent)[], messageID: string, sessionID: string): unknown[] {
  if (typeof content === "string") {
    return [{ id: `${messageID}-p0`, sessionID, messageID, type: "text", text: content }]
  }
  return content.map((block, index) => ({
    id: `${messageID}-p${index}`,
    sessionID,
    messageID,
    type: "text" as const,
    text: block.type === "text" ? block.text : "[image attachment omitted from recovery ledger]",
  }))
}

function toolPart(call: ToolCall, result: ToolResultMessage | undefined, messageID: string, sessionID: string): unknown {
  const state: Record<string, unknown> = {
    status: result ? (result.isError ? "error" : "completed") : "pending",
    input: call.arguments,
  }
  if (result) {
    const text = textOfContent(result.content)
    if (result.isError) state.error = text || "tool failed"
    else state.output = text
  }
  return { id: `${messageID}-tool-${call.id}`, sessionID, messageID, type: "tool", tool: call.name, state }
}

function standaloneToolPart(result: ToolResultMessage, messageID: string, sessionID: string): unknown {
  const state: Record<string, unknown> = {
    status: result.isError ? "error" : "completed",
    input: {},
  }
  const text = textOfContent(result.content)
  if (result.isError) state.error = text || "tool failed"
  else state.output = text
  return { id: `${messageID}-tool-${result.toolCallId}`, sessionID, messageID, type: "tool", tool: result.toolName, state }
}

function textOfContent(content: readonly (TextContent | ImageContent)[]): string {
  return content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n")
}

function bashExecutionText(message: { command?: string; output?: string; truncated?: boolean }): string {
  const command = typeof message.command === "string" ? message.command : ""
  const output = typeof message.output === "string" ? message.output : ""
  let text = `Ran \`${command}\`\n\`\`\`\n${output}\n\`\`\``
  if (message.truncated === true) text += "\n\n[output was truncated by pi before storage]"
  return text
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}
