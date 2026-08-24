import { redact, record, truncateUtf8, utf8Bytes, type MessageRecord } from "./ledger.js"
import { createVccArchiveHandle } from "./vcc-archive.js"
import { canonicalSerialize, type CanonicalEvent, type CanonicalEventInput } from "./vcc.js"

export type VccOpenCodeMessageInput = {
  message: MessageRecord
  session_id: string
  lineage_id: string
  sequence: number
}

type ToolPart = {
  part_id: string
  tool: string
  call_id: string
  status: "pending" | "running" | "completed" | "error"
  input: Record<string, unknown>
  output?: string
  error?: string
  answers?: string[][]
}

/**
 * Map one V1 message into bounded source-backed event inputs. Tool parts are
 * the one case that expands a message: a completed call emits a call and a
 * result so the causal episode machinery can retain the pair together. The
 * standalone caller must reserve the returned sequence interval before
 * mapping its next message; this seam is intentionally not wired to the
 * single-event page collector.
 */
export function toVccOpenCodeEvents(input: VccOpenCodeMessageInput): CanonicalEventInput[] | undefined {
  try {
    const message = input.message
    const info = record(message?.info)
    if (!info || !validIdentity(info.id) || info.sessionID !== input.session_id || !validScope(input.session_id) || !validScope(input.lineage_id) || !Number.isSafeInteger(input.sequence) || input.sequence < 0) return
    if (info.role !== "user" && info.role !== "assistant") return
    if (Object.prototype.hasOwnProperty.call(info, "summary") && typeof info.summary !== "boolean") return
    if (Object.prototype.hasOwnProperty.call(info, "parentID") && !validCorrelation(info.parentID)) return
    if (!Array.isArray(message.parts) || message.parts.length === 0) return

    const toolParts: ToolPart[] = []
    const toolPartIDs = new Set<string>()
    const contentParts: unknown[] = []
    let hasCompaction = false
    for (let index = 0; index < message.parts.length; index++) {
      const part = record(message.parts[index])
      if (!part || !validPartScope(part, input.session_id, info.id)) return
      if (part.type === "tool") {
        const tool = parseToolPart(part)
        if (!tool || toolPartIDs.has(tool.part_id)) return
        toolPartIDs.add(tool.part_id)
        toolParts.push(tool)
        continue
      }
      if (part.type === "compaction") hasCompaction = true
      const content = contentPart(part)
      if (content === undefined) return
      contentParts.push(content)
    }

    const events: CanonicalEventInput[] = []
    const advisory = info.summary === true || hasCompaction
    if (contentParts.length > 0) {
      const kind = hasCompaction ? "compaction" : info.summary === true ? "summary" : "message"
      events.push({
        ...eventScope(input, info.id, events.length),
        provenance: info.role === "user" ? "human_direct" : "assistant",
        kind,
        content: canonicalContent({ message_id: info.id, role: info.role, parts: contentParts }),
        source_location: sourceLocation(info.id),
        ...(typeof info.parentID === "string" ? { pair_id: info.parentID } : {}),
        ...(advisory ? { advisory: true } : { authoritative: true }),
      })
    }

    for (const tool of toolParts) {
      const pair_id = tool.call_id
      events.push({
        ...eventScope(input, `${info.id}~tool~${tool.part_id}~call`, events.length),
        provenance: "tool_call",
        kind: "tool_call",
        pair_id,
        content: canonicalContent({ call_id: pair_id, input: tool.input, tool: tool.tool }),
        source_location: sourceLocation(info.id, tool.part_id),
        ...(advisory ? { advisory: true } : { authoritative: true }),
      })
      if (tool.status !== "completed" && tool.status !== "error") continue
      const humanAnswer = tool.tool === "question" && tool.answers !== undefined
      events.push({
        ...eventScope(input, `${info.id}~tool~${tool.part_id}~result`, events.length),
        provenance: humanAnswer ? "human_tool_answer" : "tool_result",
        kind: humanAnswer ? "question_answer" : "tool_result",
        pair_id,
        content: canonicalContent({
          call_id: pair_id,
          ...(tool.error === undefined ? { output: tool.output } : { error: tool.error }),
          ...(tool.answers === undefined ? {} : { answers: tool.answers }),
          tool: tool.tool,
        }),
        source_location: sourceLocation(info.id, tool.part_id),
        ...(advisory ? { advisory: true } : { authoritative: true }),
      })
    }
    return events.length > 0
      ? events.map((event) => ({
        ...event,
        archive_handles: [createVccArchiveHandle({
          host: "opencode-v1",
          session_id: input.session_id,
          lineage_id: input.lineage_id,
          stable_source_id: event.stable_source_id,
          source_bytes: vccOpenCodeSourceBytes(message),
          payload_bytes: vccOpenCodePayloadBytes(event),
        }).handle],
      }))
      : undefined
  } catch {
    return
  }
}

function eventScope(input: VccOpenCodeMessageInput, stable_source_id: string, offset: number) {
  const sequence = input.sequence + offset
  if (!Number.isSafeInteger(sequence)) throw new TypeError("event sequence overflow")
  return { host: "opencode-v1" as const, session_id: input.session_id, lineage_id: input.lineage_id, stable_source_id, sequence }
}

function parseToolPart(part: Record<string, unknown>): ToolPart | undefined {
  if (typeof part.tool !== "string" || !part.tool || typeof part.callID !== "string" || !validCorrelation(part.callID)) return
  if (!validIdentity(part.id)) return
  const part_id = part.id
  const state = record(part.state)
  if (!state || !["pending", "running", "completed", "error"].includes(String(state.status))) return
  const input = record(state.input)
  if (!input) return
  const result: ToolPart = { part_id, tool: part.tool, call_id: part.callID, status: state.status as ToolPart["status"], input }
  if (result.status === "completed") {
    if (typeof state.output !== "string") return
    result.output = state.output
    const answers = questionAnswers(part, state)
    if (answers !== undefined) result.answers = answers
  }
  if (result.status === "error") {
    if (typeof state.error !== "string") return
    result.error = state.error
  }
  return result
}

function questionAnswers(part: Record<string, unknown>, state: Record<string, unknown>) {
  const stateMetadata = record(state.metadata)
  const partMetadata = record(part.metadata)
  const answers = stateMetadata?.answers ?? partMetadata?.answers
  if (answers === undefined) return
  if (!Array.isArray(answers) || answers.some((answer) => !Array.isArray(answer) || answer.some((value) => typeof value !== "string"))) return
  return answers as string[][]
}

function contentPart(part: Record<string, unknown>) {
  if (part.type === "text" || part.type === "reasoning") {
    return typeof part.text === "string" ? { type: part.type, text: part.text } : undefined
  }
  if (part.type === "file") {
    if (typeof part.mime !== "string" || !part.mime) return
    return { type: "file", ...(typeof part.filename === "string" ? { filename: part.filename } : {}), mime: part.mime }
  }
  if (part.type === "patch") {
    if (!Array.isArray(part.files) || part.files.some((file) => typeof file !== "string")) return
    return { files: part.files, type: "patch" }
  }
  if (part.type === "compaction") return { auto: part.auto === true, type: "compaction" }
  if (["step-start", "step-finish", "snapshot", "agent", "retry", "subtask"].includes(String(part.type))) return { type: part.type }
  return
}

function canonicalContent(value: unknown) {
  return truncateUtf8(redact(canonicalSerialize(value)), 16_384)
}

export function vccOpenCodeSourceBytes(message: MessageRecord) {
  const info = record(message.info)
  return truncateUtf8(redact(canonicalSerialize({
    version: 1,
    kind: "opencode-v1-source-record",
    info: {
      id: info?.id,
      sessionID: info?.sessionID,
      role: info?.role,
    },
    parts: message.parts,
  })), 64 * 1_024)
}

export function vccOpenCodePayloadBytes(event: CanonicalEventInput | CanonicalEvent) {
  const stable_source_id = "stable_source_id" in event ? event.stable_source_id : event.id.slice("ev:opencode-v1:".length)
  return canonicalSerialize({
    version: 1,
    host: event.host,
    session_id: event.session_id,
    lineage_id: event.lineage_id,
    stable_source_id,
    kind: event.kind,
    source_location: event.source_location,
    content: typeof event.content === "string" ? event.content : canonicalSerialize(event.content),
  })
}

function sourceLocation(messageID: string, partID?: string) {
  return partID === undefined ? `opencode-v1:message:${messageID}` : `opencode-v1:message:${messageID}:part:${partID}`
}

function validPartScope(part: Record<string, unknown>, sessionID: string, messageID: string) {
  if (part.sessionID !== undefined && part.sessionID !== sessionID) return false
  if (part.messageID !== undefined && part.messageID !== messageID) return false
  if (part.id !== undefined && !validIdentity(part.id)) return false
  return true
}

function validIdentity(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !/^\d+$/u.test(value) && !/[\0:\n]/u.test(value) && utf8Bytes(value) <= 512
}

function validCorrelation(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !/[\0\n]/u.test(value) && utf8Bytes(value) <= 4_096
}

function validScope(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !value.includes("\0") && utf8Bytes(value) <= 4_096
}
