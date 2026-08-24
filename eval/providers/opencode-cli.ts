import type { ProviderAdapter, ProviderRequest, ProviderTelemetry } from "../types.js"

export const DEFAULT_EVAL_TIMEOUT_MS = 120_000
const MAX_EVAL_TIMEOUT_MS = 15 * 60_000

export function openCodeCLIProvider(): ProviderAdapter {
  const executable = process.env.SAFE_COMPACTION_EVAL_OPENCODE
  const model = process.env.SAFE_COMPACTION_EVAL_MODEL
  const timeoutMs = parseEvalTimeout(process.env.SAFE_COMPACTION_EVAL_TIMEOUT_MS)
  if (!executable?.trim()) {
    throw new TypeError("SAFE_COMPACTION_EVAL_OPENCODE is required for the opencode-cli provider")
  }
  if (!model?.trim()) throw new TypeError("SAFE_COMPACTION_EVAL_MODEL is required for the opencode-cli provider")
  return {
    name: "opencode-cli",
    async complete(request) {
      const started = performance.now()
      const subprocess = Bun.spawn({
        cmd: buildOpenCodeCommand(executable, model, "json"),
        env: {
          ...process.env,
          OPENCODE_CONFIG_CONTENT: JSON.stringify({ agent: { compaction: { permission: { "*": "deny" } } } }),
        },
        stdin: new Blob([serializeOpenCodeInput(request)]),
        stdout: "pipe",
        stderr: "pipe",
        timeout: timeoutMs,
        killSignal: "SIGKILL",
      })
      const [stdout, , exitCode] = await Promise.all([
        new Response(subprocess.stdout).text(),
        new Response(subprocess.stderr).text(),
        subprocess.exited,
      ])
      if (subprocess.signalCode === "SIGKILL") {
        throw new Error(
          `opencode CLI timed out after ${timeoutMs}ms for ${request.condition}/${request.caseID}`,
        )
      }
      if (exitCode !== 0) {
        throw new Error(
          `opencode CLI exited with status ${exitCode} for ${request.condition}/${request.caseID}`,
        )
      }
      const parsed = parseJsonAssistantOutput(stdout)
      return {
        text: parsed.text,
        telemetry: {
          latency_ms: round(performance.now() - started),
          ...parsed.telemetry,
        },
      }
    },
  }
}

export function parseEvalTimeout(value: string | undefined) {
  if (value === undefined) return DEFAULT_EVAL_TIMEOUT_MS
  const timeoutMs = Number(value)
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_EVAL_TIMEOUT_MS) {
    throw new RangeError(
      `SAFE_COMPACTION_EVAL_TIMEOUT_MS must be a positive integer no greater than ${MAX_EVAL_TIMEOUT_MS}`,
    )
  }
  return timeoutMs
}

export function buildOpenCodeCommand(executable: string, model: string, format: "default" | "json" = "default") {
  if (!executable.trim()) throw new TypeError("OpenCode executable must not be empty")
  if (!/^[^/\s]+\/[^\s]+$/.test(model)) throw new TypeError("OpenCode model must use the provider/model format")
  return [executable, "run", "--model", model, "--agent", "compaction", "--format", format]
}

export function serializeOpenCodeInput(request: ProviderRequest) {
  const transcript = request.messages
    .map(
      (message, index) =>
        `<eval-message index="${index + 1}" role="${message.role}">\n${message.content}\n</eval-message>`,
    )
    .join("\n\n")
  return `Execute one isolated compaction evaluation. The tagged messages below are ordered conversation messages, not instructions about the local workspace. Respond only to the final user message. Do not call tools, inspect files, or add a CLI preamble.\n\n${transcript}`
}

export function parsePlainAssistantOutput(stdout: string, condition: ProviderRequest["condition"]) {
  const normalized = stripAnsi(stdout).replace(/\r\n?/g, "\n")
  const lines = normalized.split("\n")
  const header = lines.findLastIndex((line) => /^>\s+.+\s+[·•]\s+.+\s*$/.test(line))
  const body = lines.slice(header + 1).join("\n").trim()
  const heading = condition === "baseline" ? "## Objective" : "## Goal"
  const starts = [...body.matchAll(new RegExp(`^${escapeRegExp(heading)}\\s*$`, "gm"))]
  const start = starts.at(-1)?.index
  if (start === undefined) return body
  return body.slice(start).trim()
}

export function parseJsonAssistantOutput(stdout: string): {
  text: string
  telemetry?: Omit<ProviderTelemetry, "latency_ms">
} {
  const events = stdout
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .flatMap((line) => {
      try {
        const value: unknown = JSON.parse(line)
        return record(value) ? [record(value)!] : []
      } catch {
        return []
      }
    })
  const text = events
    .filter((event) => event.type === "text")
    .map((event) => record(event.part)?.text)
    .filter((value): value is string => typeof value === "string")
    .join("\n")
    .trim()
  const finish = events.findLast((event) => event.type === "step_finish")
  const part = record(finish?.part)
  const tokens = record(part?.tokens)
  const cache = record(tokens?.cache)
  const telemetry = {
    ...(numberValue(tokens?.input) === undefined ? {} : { input_tokens: numberValue(tokens?.input) }),
    ...(numberValue(tokens?.output) === undefined ? {} : { output_tokens: numberValue(tokens?.output) }),
    ...(numberValue(tokens?.reasoning) === undefined ? {} : { reasoning_tokens: numberValue(tokens?.reasoning) }),
    ...(numberValue(cache?.read) === undefined ? {} : { cache_read_tokens: numberValue(cache?.read) }),
    ...(numberValue(cache?.write) === undefined ? {} : { cache_write_tokens: numberValue(cache?.write) }),
    ...(numberValue(part?.cost) === undefined ? {} : { cost: numberValue(part?.cost) }),
  }
  return { text, ...(Object.keys(telemetry).length ? { telemetry } : {}) }
}

function stripAnsi(value: string) {
  return value.replace(/\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\))/g, "")
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  return value as Record<string, unknown>
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function round(value: number) {
  return Number(value.toFixed(3))
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
