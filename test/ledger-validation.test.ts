import { describe, expect, test } from "bun:test"
import {
  LEDGER_END,
  LEDGER_LIMITS,
  LEDGER_START,
  buildRecoveryLedger,
  canonicalLedger,
  redact,
  sha256,
  truncateUtf8,
  utf8Bytes,
  type MessageRecord,
  type RecoveryLedgerData,
} from "../src/ledger.js"
import {
  REQUIRED_SECTIONS,
  buildFallback,
  isPluginValidSummary,
  parsePluginLedger,
  recoveryContext,
  validateSummary,
} from "../src/validation.js"

const EMPTY_DATA: RecoveryLedgerData = {
  recent_requests: [],
  constraints: [],
  todos: [],
  touched_paths: [],
  tool_statuses: [],
  errors: [],
  evidence: [],
  next_actions: [],
  legacy_context: [],
}

function message(
  id: string,
  sessionID: string,
  role: "user" | "assistant",
  parts: unknown[],
  extra: Partial<MessageRecord["info"]> = {},
): MessageRecord {
  return { info: { id, sessionID, role, ...extra }, parts }
}

function validSummary(block: string, values: Partial<Record<(typeof REQUIRED_SECTIONS)[number], string>> = {}) {
  return REQUIRED_SECTIONS.map((section) => `## ${section}\n${values[section] ?? `- ${section} fact`}`).join("\n\n") + `\n\n${block}`
}

describe("UTF-8 bounds and redaction", () => {
  test("counts bytes rather than JavaScript code units and truncates on character boundaries", () => {
    expect(utf8Bytes("a🙂é")).toBe(7)
    expect(utf8Bytes("\ud800")).toBe(3)
    const value = truncateUtf8("🙂🙂🙂🙂🙂", 18)
    expect(value).toBe("🙂…[truncated]")
    expect(utf8Bytes(value)).toBeLessThanOrEqual(18)
    expect(value).not.toContain("�")
    expect(utf8Bytes(truncateUtf8("oversized", 4))).toBeLessThanOrEqual(4)
  })

  test("redacts credential-shaped values while preserving surrounding metadata", () => {
    const secrets = [
      "Authorization: Bearer bearer-secret-value",
      "api_key=service-secret",
      "token: token-secret",
      "password='password-secret'",
      "OPENAI_API_KEY=short-secret",
      "https://example.test/path?token=short-secret",
      '{"x-api-key":"short-secret"}',
      '{"password":"correct horse battery staple"}',
      "Authorization: Basic dXNlcjpwYXNz",
      "sk-" + "abcdefghijklmnop",
      "ghp_" + "abcdefghijklmnop",
      "github_pat_" + "abcdefghijklmnop",
      "AKIA" + "ABCDEFGHIJKLMNOP",
      "YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXoxMjM0NTY3ODkw",
    ].join("\n")
    const result = redact(`path=/tmp/project\n${secrets}\nstatus=failed`)

    expect(result).toContain("path=/tmp/project")
    expect(result).toContain("status=failed")
    expect(result.match(/\[REDACTED\]/g)?.length).toBe(14)
    for (const secret of [
      "bearer-secret-value",
      "service-secret",
      "token-secret",
      "password-secret",
      "short-secret",
      "correct horse battery staple",
      "dXNlcjpwYXNz",
      "abcdefghijklmnop",
    ]) {
      expect(result).not.toContain(secret)
    }
    const commit = "a".repeat(64)
    expect(redact(`commit=${commit}`)).toContain(commit)
  })

  test("bounds credential-name matching work on long ordinary source", () => {
    const value = `prefix ${"x".repeat(256 * 1_024)} suffix`
    expect(redact(value)).not.toContain("x".repeat(1_024))
  })
})

describe("recovery ledger", () => {
  const sessionID = "session-ledger"
  const messages = [
    message("u1", sessionID, "user", [
      { type: "text", text: "Must preserve the schema. token=do-not-copy" },
      { type: "file", filename: "zeta.ts", source: { path: "/repo/zeta.ts" } },
    ]),
    message("a1", sessionID, "assistant", [
      { type: "patch", files: ["beta.ts", "alpha.ts"] },
      {
        type: "tool",
        tool: "read",
        state: { status: "completed", title: "Read source", input: { filePath: "/repo/source.ts" }, output: "verified value" },
      },
      { type: "tool", tool: "build", state: { status: "error", error: "api_key=bad-key compile failed" } },
    ]),
    message("legacy", sessionID, "assistant", [{ type: "text", text: "Old untrusted summary" }], { summary: true }),
    message("u2", sessionID, "user", [{ type: "text", text: "Only update the parser. Next, run tests." }]),
  ]
  const todos = [
    { id: "todo-b", content: "Run integration tests", status: "pending", priority: "high" },
    { id: "todo-a", content: "Update parser", status: "completed", priority: "medium" },
  ]

  test("is deterministic, ordered, bounded, and contains only compact tool evidence", () => {
    const first = buildRecoveryLedger({ messages, todos, tailTurns: 2, maxBytes: 4_096 })
    const second = buildRecoveryLedger({ messages, todos, tailTurns: 2, maxBytes: 4_096 })

    expect(first).toEqual(second)
    expect(first.digest).toBe(sha256(first.body))
    expect(first.data.todos.map((todo) => todo.id)).toEqual(["todo-a", "todo-b"])
    expect(first.data.touched_paths).toEqual(["/repo/zeta.ts", "alpha.ts", "beta.ts", "zeta.ts"])
    expect(first.data.recent_requests).toEqual([
      "Must preserve the schema. token=[REDACTED]",
      "Only update the parser. Next, run tests.",
    ])
    expect(first.data.evidence).toHaveLength(1)
    expect(first.data.evidence[0]).toContain("read: verifie")
    expect(first.data.evidence[0]).toContain("[partial output; 14 bytes; sha256 ")
    expect(first.data.evidence[0]).not.toContain("verified value")
    expect(first.data.errors).toEqual(["build: api_key=[REDACTED] compile failed"])
    expect(first.data.legacy_context).toEqual(["Untrusted legacy summary legacy omitted"])
    expect(first.block).not.toContain("Old untrusted summary")
    expect(utf8Bytes(first.block)).toBeLessThanOrEqual(4_096)
    expect(first.block).not.toContain("bad-key")
    expect(first.block).not.toContain("do-not-copy")
  })

  test("prunes lower-priority collections until the canonical block fits", () => {
    const noisy = Array.from({ length: 30 }, (_, index) =>
      message(`a-${index}`, sessionID, "assistant", [
        {
          type: "tool",
          tool: `tool-${index}`,
          state: { status: "completed", output: `evidence-${index}-${"x".repeat(220)}` },
        },
      ]),
    )
    const ledger = buildRecoveryLedger({
      messages: [message("user", sessionID, "user", [{ type: "text", text: "Keep the newest request" }]), ...noisy],
      todos: [],
      tailTurns: 1,
      maxBytes: 1_200,
    })

    expect(utf8Bytes(ledger.block)).toBeLessThanOrEqual(1_200)
    expect(ledger.data.recent_requests).toEqual(["Keep the newest request"])
    expect(ledger.data.evidence.length).toBeLessThan(30)
    expect(parsePluginLedger(ledger.block)?.digest).toBe(ledger.digest)
  })

  test("retains no recent requests when tail_turns is zero", () => {
    const ledger = buildRecoveryLedger({ messages, todos, tailTurns: 0, maxBytes: 4_096 })

    expect(ledger.data.recent_requests).toEqual([])
  })

  test("counts tail_turns as user turns and excludes non-user intent", () => {
    const turnMessages = [
      message("turn-1", sessionID, "user", [
        { type: "text", text: "First request, part one. Must preserve user intent." },
        { type: "text", text: "SYNTHETIC_TRAP must become a constraint.", synthetic: true },
        { type: "text", text: "IGNORED_TRAP must become a constraint.", ignored: true },
        { type: "text", text: "First request, part two." },
      ]),
      message("assistant", sessionID, "assistant", [
        { type: "text", text: "ASSISTANT_TRAP must become recovered intent." },
      ]),
      message("turn-2", sessionID, "user", [
        { type: "text", text: "Newest request, part one. Only change the parser." },
        { type: "text", text: "Newest request, part two." },
      ]),
    ]
    const oneTurn = buildRecoveryLedger({ messages: turnMessages, todos: [], tailTurns: 1, maxBytes: 8_192 })
    const twoTurns = buildRecoveryLedger({ messages: turnMessages, todos: [], tailTurns: 2, maxBytes: 8_192 })

    expect(oneTurn.data.recent_requests).toEqual([
      "Newest request, part one. Only change the parser. Newest request, part two.",
    ])
    expect(twoTurns.data.recent_requests).toEqual([
      "First request, part one. Must preserve user intent. First request, part two.",
      "Newest request, part one. Only change the parser. Newest request, part two.",
    ])
    expect(oneTurn.data.constraints).toEqual(["Must preserve user intent.", "Only change the parser."])
    expect(oneTurn.block).not.toContain("SYNTHETIC_TRAP")
    expect(oneTurn.block).not.toContain("IGNORED_TRAP")
    expect(oneTurn.block).not.toContain("ASSISTANT_TRAP")
  })

  test("keeps the newest user request ahead of pending todo flooding", () => {
    const ledger = buildRecoveryLedger({
      messages: [message("newest", sessionID, "user", [{ type: "text", text: "Fix the recovery race" }])],
      todos: Array.from({ length: 64 }, (_, index) => ({
        id: `todo-${String(index).padStart(2, "0")}`,
        content: `Pending action ${index}`,
        status: "pending",
        priority: "high",
      })),
      tailTurns: 1,
      maxBytes: 256 * 1_024,
    })

    expect(ledger.data.todos).toHaveLength(LEDGER_LIMITS.todos)
    expect(ledger.data.next_actions).toHaveLength(LEDGER_LIMITS.next_actions)
    expect(ledger.data.next_actions[0]).toBe("Pending action 0")
    expect(ledger.data.next_actions.some((action) => action.startsWith("Continue the newest request:"))).toBe(false)
  })

  test("uses explicit file artifacts and ignores arbitrary tool-input paths", () => {
    const ledger = buildRecoveryLedger({
      messages: [message("user", sessionID, "user", [{ type: "text", text: "Inspect the files" }]), message("tools", sessionID, "assistant", [
        { type: "file", filename: "/repo/src/index.ts", source: { path: "/repo/src/index.ts" } },
        { type: "tool", tool: "shell", state: { status: "completed", input: { command: "cat /api/ /g /very-long-path-name" } } },
      ])],
      todos: [],
      tailTurns: 1,
      maxBytes: 16_384,
    })

    expect(ledger.data.touched_paths).toContain("/repo/src/index.ts")
    expect(ledger.data.touched_paths).not.toContain("/very-long-path-name")
    expect(ledger.data.touched_paths).not.toContain("/api")
    expect(ledger.data.touched_paths).not.toContain("/g")
  })

  test("accepts structured paths from allowlisted write tools", () => {
    const ledger = buildRecoveryLedger({
      messages: [message("request", sessionID, "user", [{ type: "text", text: "Write the review" }]), message("write", sessionID, "assistant", [
        { type: "tool", tool: "write", state: { status: "completed", input: { path: "/repo/aidocs/review.md" } } },
        { type: "tool", tool: "shell", state: { status: "completed", input: { path: "/repo/not-a-file-evidence" } } },
      ])],
      todos: [],
      tailTurns: 1,
      maxBytes: 16_384,
    })

    expect(ledger.data.touched_paths).toContain("/repo/aidocs/review.md")
    expect(ledger.data.touched_paths).not.toContain("/repo/not-a-file-evidence")
  })

  test("accepts explicitly structured source paths from allowlisted write tools", () => {
    const ledger = buildRecoveryLedger({
      messages: [message("write", sessionID, "assistant", [{
        type: "tool",
        tool: "write",
        state: {
          status: "completed",
          input: {
            file: { source: { path: "/repo/nested.ts" } },
            source: { path: "/repo/source.ts" },
          },
        },
      }])],
      todos: [],
      tailTurns: 1,
      maxBytes: 4_096,
    })
    expect(ledger.data.touched_paths).toEqual(["/repo/nested.ts", "/repo/source.ts"])
  })

  test("normalizes V1 todos that omit IDs and optional metadata", () => {
    const oversizedWhitespaceID = " ".repeat(1_024 * 1_024) + "must-not-be-reached"
    const input = {
      messages: [message("request", sessionID, "user", [{ type: "text", text: "Resume safely" }])],
      todos: [
        { content: "Run the regression", status: "in_progress", priority: "high" },
        { content: "Inspect the deployment" },
        { id: oversizedWhitespaceID, content: "Bound oversized todo identifiers", status: "pending", priority: "low" },
        { id: "", content: "" },
      ],
      tailTurns: 1,
      maxBytes: 8_192,
    }
    const first = buildRecoveryLedger(input)
    const second = buildRecoveryLedger(input)

    expect(first.block).toBe(second.block)
    expect(first.data.todos).toEqual([
      {
        id: `todo-${sha256("Bound oversized todo identifiers").slice(0, 16)}`,
        status: "pending",
        priority: "low",
        content: "Bound oversized todo identifiers",
      },
      {
        id: `todo-${sha256("Inspect the deployment").slice(0, 16)}`,
        status: "unknown",
        priority: "unknown",
        content: "Inspect the deployment",
      },
      {
        id: `todo-${sha256("Run the regression").slice(0, 16)}`,
        status: "in_progress",
        priority: "high",
        content: "Run the regression",
      },
    ].sort((left, right) => left.id.localeCompare(right.id)))
  })

  test("enforces collection bounds without inspecting omitted history or parts", () => {
    const omitted = {
      get info(): MessageRecord["info"] {
        throw new Error("inspected message outside the bounded window")
      },
      parts: [],
    }
    const history = [omitted as MessageRecord]
    for (let index = 0; index < LEDGER_LIMITS.messages; index++) {
      history.push(message(`user-${index}`, sessionID, "user", [{ type: "text", text: `Request ${index}` }]))
    }

    const inputTarget = Array.from({ length: 100_000 }, (_, index) => `/repo/file-${String(index).padStart(5, "0")}`)
    const guardedInput = new Proxy(inputTarget, {
      get(target, property, receiver) {
        if (typeof property === "string" && /^\d+$/.test(property) && Number(property) >= LEDGER_LIMITS.tool_input_nodes - 1) {
          throw new Error("inspected tool input outside the node bound")
        }
        return Reflect.get(target, property, receiver)
      },
    })
    const partTarget = Array.from({ length: 10_000 }, (_, index) => ({
      type: "tool",
      tool: `tool-${String(index).padStart(5, "0")}`,
      state: { status: "running", input: index === 0 ? guardedInput : undefined },
    }))
    const guardedParts = new Proxy(partTarget, {
      get(target, property, receiver) {
        if (
          typeof property === "string" &&
          /^\d+$/.test(property) &&
          Number(property) >= LEDGER_LIMITS.parts_per_message / 2 &&
          Number(property) < target.length - LEDGER_LIMITS.parts_per_message / 2
        ) {
          throw new Error("inspected message part outside the head/tail bound")
        }
        return Reflect.get(target, property, receiver)
      },
    })
    history.push(message("tools", sessionID, "assistant", guardedParts))

    const ledger = buildRecoveryLedger({
      messages: history,
      todos: [],
      tailTurns: Number.MAX_SAFE_INTEGER,
      maxBytes: 256 * 1_024,
    })

    expect(ledger.data.recent_requests).toHaveLength(LEDGER_LIMITS.recent_requests)
    expect(ledger.data.recent_requests.at(-1)).toBe(`Request ${LEDGER_LIMITS.messages - 1}`)
    expect(ledger.data.tool_statuses).toHaveLength(LEDGER_LIMITS.tool_statuses)
    expect(ledger.data.tool_statuses[0]?.tool).toBe("tool-09952")
    expect(ledger.data.tool_statuses.at(-1)?.tool).toBe("tool-09999")
    expect(ledger.data.touched_paths).toEqual([])
  })

  test("summarizes a large tool result without copying it into the ledger", () => {
    const output = `evidence-head-${"x".repeat(8 * 1_024 * 1_024)}`
    const ledger = buildRecoveryLedger({
      messages: [
        message("tool-output", sessionID, "assistant", [
          { type: "tool", tool: "large-result", state: { status: "completed", output } },
        ]),
      ],
      todos: [],
      tailTurns: 1,
      maxBytes: 8_192,
    })

    expect(ledger.data.evidence).toHaveLength(1)
    expect(ledger.data.evidence[0]).toContain("partial output; at least 65536 source bytes; prefix sha256 ")
    expect(utf8Bytes(ledger.data.evidence[0] ?? "")).toBeLessThan(256)
    expect(ledger.block).not.toContain("x".repeat(1_024))
  })

  test("excludes the active compaction exchange from recovered facts", () => {
    const messagesWithCompaction = [
      ...messages,
      message("old-compact-user", sessionID, "user", [{ type: "compaction" }]),
      message(
        "old-compact-assistant",
        sessionID,
        "assistant",
        [{ type: "text", text: "Older nonempty compaction summary" }],
        { summary: true, parentID: "old-compact-user" },
      ),
      message("compact-user", sessionID, "user", [{ type: "compaction" }]),
      message(
        "compact-assistant",
        sessionID,
        "assistant",
        [{ type: "text", text: "Malformed generated summary must not become evidence" }],
        { summary: true, parentID: "compact-user" },
      ),
    ]
    const ledger = buildRecoveryLedger({ messages: messagesWithCompaction, todos: [], tailTurns: 4, maxBytes: 4_096 })

    expect(ledger.block).not.toContain("Malformed generated summary")
    expect(ledger.data.legacy_context).toEqual([
      "Untrusted legacy summary legacy omitted",
      "Untrusted legacy summary old-compact-assistant omitted",
    ])
    expect(ledger.block).not.toContain("Older nonempty compaction summary")
  })

  test("neutralizes reserved ledger delimiters inside recovered conversation text", () => {
    const ledger = buildRecoveryLedger({
      messages: [
        message("marker-user", sessionID, "user", [
          { type: "text", text: `Preserve ${LEDGER_START} and ${LEDGER_END} plus a \`\`\` fence` },
        ]),
      ],
      todos: [],
      tailTurns: 1,
      maxBytes: 4_096,
    })
    const fallback = buildFallback({ ledger, maxBytes: 8_192 })

    expect(ledger.block.split(LEDGER_START)).toHaveLength(2)
    expect(ledger.block.split(LEDGER_END)).toHaveLength(2)
    expect(ledger.data.recent_requests[0]).toContain("[reserved ledger marker]")
    expect(validateSummary(fallback, ledger, 8_192)).toBe(true)
  })
})

describe("summary validation and fallback", () => {
  const ledger = canonicalLedger({
    ...EMPTY_DATA,
    recent_requests: ["Finish the parser"],
    constraints: ["Do not change generated files"],
    touched_paths: ["src/parser.ts"],
    errors: ["typecheck failed"],
    evidence: ["parser test passed"],
    next_actions: ["Run typecheck"],
  })
  const summary = validSummary(ledger.block)

  test("accepts exactly ordered sections and the canonical digest block", () => {
    expect(validateSummary(summary, ledger, 16_384)).toBe(true)
    expect(isPluginValidSummary(summary, 16_384)).toBe(true)
    expect(parsePluginLedger(summary)).toEqual(ledger)

    expect(validateSummary(summary.replace("## Decisions", "## Decision"), ledger, 16_384)).toBe(false)
    expect(validateSummary(summary.replace("## Decisions", "## Decisions\nextra\n## Decisions"), ledger, 16_384)).toBe(false)
    expect(validateSummary(summary.replace("## Goal", "## Goal\nextra\n## Goal"), ledger, 16_384)).toBe(false)
    expect(validateSummary(summary.replace(ledger.digest, "0".repeat(64)), ledger, 16_384)).toBe(false)
    expect(validateSummary(summary, ledger, utf8Bytes(summary) - 1)).toBe(false)
    expect(validateSummary(`${summary}\nUnsupported trailing claim`, ledger, 16_384)).toBe(false)
    expect(isPluginValidSummary(`${summary}\nUnsupported trailing claim`, 16_384)).toBe(false)
  })

  test("rejects non-canonical JSON even when its digest is internally consistent", () => {
    const compactBody = JSON.stringify(ledger.data)
    const compactBlock = `${LEDGER_START}\nversion: 1\nsha256: ${sha256(compactBody)}\n\`\`\`json\n${compactBody}\n\`\`\`\n${LEDGER_END}`

    expect(parsePluginLedger(compactBlock)).toBeUndefined()
  })

  test("builds a deterministic plugin-valid fallback without provider-authored anchors", () => {
    const first = buildFallback({ ledger, maxBytes: 16_384 })
    const second = buildFallback({ ledger, maxBytes: 16_384 })

    expect(first).toBe(second)
    expect(first).toContain("No decisions were inferred outside the canonical ledger")
    expect(first).not.toContain("Keep the stable API")
    expect(first).not.toContain("Parser implementation is incomplete")
    expect(isPluginValidSummary(first, 16_384)).toBe(true)
    expect(parsePluginLedger(first)?.digest).toBe(ledger.digest)
  })

  test("does not treat a non-plugin legacy summary as a validation anchor", () => {
    const legacy = "## Goal\n- A convincing but untrusted old summary"
    expect(isPluginValidSummary(legacy, 16_384)).toBe(false)
    const fallback = buildFallback({ ledger, maxBytes: 16_384 })
    expect(fallback).not.toContain("convincing")
    expect(recoveryContext(ledger)).toContain("untrusted provider prose is omitted")
  })

  test("uses the minimal fallback when rich recovered detail would exceed the summary bound", () => {
    const verbose = canonicalLedger({
      ...EMPTY_DATA,
      constraints: ["x".repeat(2_000)],
      evidence: ["y".repeat(2_000)],
    })
    const maxBytes = utf8Bytes(verbose.block) + 700
    const fallback = buildFallback({ ledger: verbose, maxBytes })

    expect(fallback).toContain("The provider summary was replaced by a deterministic fallback")
    expect(utf8Bytes(fallback)).toBeLessThanOrEqual(maxBytes)
    expect(isPluginValidSummary(fallback, maxBytes)).toBe(true)
  })
})
