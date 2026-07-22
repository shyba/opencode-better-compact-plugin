import type { ProviderAdapter, ProviderRequest } from "../types.js"

export function openCodeCLIProvider(): ProviderAdapter {
  const executable = process.env.SAFE_COMPACTION_EVAL_OPENCODE
  const model = process.env.SAFE_COMPACTION_EVAL_MODEL
  if (!executable?.trim()) {
    throw new TypeError("SAFE_COMPACTION_EVAL_OPENCODE is required for the opencode-cli provider")
  }
  if (!model?.trim()) throw new TypeError("SAFE_COMPACTION_EVAL_MODEL is required for the opencode-cli provider")
  return {
    name: "opencode-cli",
    async complete(request) {
      const subprocess = Bun.spawn({
        cmd: buildOpenCodeCommand(executable, model),
        env: {
          ...process.env,
          OPENCODE_CONFIG_CONTENT: JSON.stringify({ agent: { compaction: { permission: { "*": "deny" } } } }),
        },
        stdin: new Blob([serializeOpenCodeInput(request)]),
        stdout: "pipe",
        stderr: "pipe",
      })
      const [stdout, , exitCode] = await Promise.all([
        new Response(subprocess.stdout).text(),
        new Response(subprocess.stderr).text(),
        subprocess.exited,
      ])
      if (exitCode !== 0) {
        throw new Error(
          `opencode CLI exited with status ${exitCode} for ${request.condition}/${request.caseID}`,
        )
      }
      return { text: parsePlainAssistantOutput(stdout, request.condition) }
    },
  }
}

export function buildOpenCodeCommand(executable: string, model: string) {
  if (!executable.trim()) throw new TypeError("OpenCode executable must not be empty")
  if (!/^[^/\s]+\/[^\s]+$/.test(model)) throw new TypeError("OpenCode model must use the provider/model format")
  return [executable, "run", "--model", model, "--agent", "compaction", "--format", "default"]
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
  const heading = condition === "plugin" ? "## Goal" : "## Objective"
  const starts = [...body.matchAll(new RegExp(`^${escapeRegExp(heading)}\\s*$`, "gm"))]
  const start = starts.at(-1)?.index
  if (start === undefined) return body
  return body.slice(start).trim()
}

function stripAnsi(value: string) {
  return value.replace(/\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\))/g, "")
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
