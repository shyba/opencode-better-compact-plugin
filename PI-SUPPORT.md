# Pi support plan for `opencode-safe-compaction`

Status: implemented on branch `pi-support`. Branch: `pi-support`. Worktree: `/home/user/repos/better-compact-pi-support`.
Companion repo to add the entry point to: `shyba/opencode-better-compact-plugin` (vendored at `plugins/safe-compaction/` in the opencode monorepo).

## Goal

Add a pi extension entry point that re-uses the plugin's existing host-agnostic core (`ledger.ts`, `projection.ts`, `validation.ts`, `options.ts`) to do the same recovery-ledger grounded compaction pi already does, but with strict JSON projection validation and a deterministic fallback.

## What pi supports and OpenCode V1 does not (relevant deltas)

- No `experimental.session.compacting` style hook. Pi gives you `session_before_compact` and `session_before_tree` and expects you to return a complete `CompactionResult` synchronously from the event handler. There is no in-flight text-complete hook to swap a model-written summary after the fact.
- No `experimental.chat.messages.transform`. The model-visible message list during compaction is immutable from extensions. Sanitization happens in the adapter (input to the ledger) and in the rendered summary (output we return) — there is no third layer.
- No `chat.message` admission hook that exposes byte counts. Pi's `input` event is text-only; attachment byte accounting is not surfaced the way OpenCode's `chat.message` exposes it. Per verification, pi itself rejects oversized messages, so this layer is dropped.
- No `experimental.compaction.autocontinue`. Pi stores whatever `compaction.summary` we return; we always return a structurally valid, digest-anchored summary (validated projection if the model produced one, authoritative fallback otherwise). No mid-flight gating needed.
- No native todo table. Todos come from a user-installed todo-tracking extension (e.g. `examples/extensions/todo.ts` from pi) which exposes them via `role: "toolResult"`, `toolName: "todo"`. Adapter scans the branch for the most recent such result and feeds it to `buildRecoveryLedger`. If no such extension is installed, the `todos` section is empty.
- No config hook. Per-extension settings live in `<cwd>/.pi/safe-compaction.json` (mode `0600`), atomic-rename write/read, mirroring `src/config.ts`. Default values match the OpenCode defaults.

## File layout

```
plugins/safe-compaction/
├── src/
│   ├── ledger.ts                  (unchanged — already host-agnostic)
│   ├── projection.ts              (unchanged)
│   ├── validation.ts              (unchanged)
│   ├── options.ts                 (unchanged)
│   ├── state.ts                   (unused by the pi entry point — process-local AttemptStore is meaningless without mid-flight hooks)
│   ├── sanitize.ts                (unused by the pi entry point — sanitization already runs inside `buildRecoveryLedger` on ledger insertion and inside `renderProjectedResponse`/`buildAuthoritativeSummary` on the final summary)
│   ├── server.ts                  (unchanged — OpenCode V1 only)
│   ├── tui.ts                     (unchanged — OpenCode V1 only)
│   ├── sync-state.ts              (unchanged — sync runner CLI, orthogonal)
│   ├── postgres.ts                (unchanged)
│   ├── opencode-v1.ts             (unchanged — sync runner CLI)
│   ├── config.ts                  (unchanged — sync runner CLI)
│   ├── pi-adapter.ts              (NEW — pure adapter)
│   └── pi.ts                      (NEW — entry point)
├── test/
│   └── pi-adapter.test.ts         (NEW — pure unit tests)
├── package.json                   (add `./pi` export + `build:js` step)
├── tsconfig.json                  (unchanged)
└── README.md                      (document the pi entry point + limits)
```

## `src/pi-adapter.ts` (new, ~150 lines)

Pure functions mapping pi types to plugin types.

```ts
import type { AgentMessage, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { MessageRecord, TodoRecord, RecoveryLedger } from "./ledger.js";

/** Walk AgentMessage[] (or build from SessionEntry[]) and emit the plugin's
 *  MessageRecord[]. Tool calls and tool results are folded into the assistant
 *  message as `tool` parts with matching `state.status` / `state.output` /
 *  `state.error` / `state.input` so the ledger's tool-status collection works. */
export function toMessageRecords(
  messages: AgentMessage[],
  sessionID: string,
  parentById?: Map<string, string>,
): MessageRecord[];

/** If a todo-tracking extension is installed, scan the branch and return its
 *  current todo list. Empty array otherwise. */
export function todosFromBranch(branch: SessionEntry[]): TodoRecord[];

/** Find the most recent CompactionEntry whose summary parses via
 *  parsePluginLedger, so we can chain a prior canonical ledger. */
export function priorPluginSummary(branch: SessionEntry[]): { id: string; ledger: RecoveryLedger } | undefined;

/** Settings file at <cwd>/.pi/safe-compaction.json, mode 0600, atomic rename.
 *  Mirrors src/config.ts but is strictly the pi-side option set. */
export function loadPiOptions(cwd: string): ParsedOptions;
export function savePiOptions(cwd: string, options: PluginOptions): Promise<void>;
```

The adapter is pure and tested with fixture `AgentMessage[]` arrays — no live pi runtime needed.

## `src/pi.ts` (new entry point)

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { uuidv7 } from "@earendil-works/pi-ai";
import { buildRecoveryLedger, utf8Bytes, type MessageRecord, type TodoRecord } from "./ledger.js";
import {
  buildAuthoritativeSummary,
  buildCompactionPrompt,
  renderProjectedResponse,
  parsePluginLedger,
  recoveryContext,
} from "./validation.js";
import { SELECTED_MODEL, parseOptions, resolveOptions, type PluginOptions } from "./options.js";
import { toMessageRecords, todosFromBranch, priorPluginSummary, loadPiOptions, savePiOptions } from "./pi-adapter.js";

export default function (pi: ExtensionAPI) {
  const cwd = process.cwd(); // captured at extension load; pi has no cwd migration hook
  let resolved: PluginOptions = resolveOptions(parseOptions(loadPiOptions(cwd)));

  async function runPipeline(input: {
    messages: AgentMessage[];
    branch?: SessionEntry[];
    sessionID: string;
    signal: AbortSignal;
  }): Promise<{ summary: string; usage?: Usage; details?: unknown } | undefined> {
    if (input.signal.aborted) return;
    const messages = toMessageRecords(input.messages, input.sessionID);
    const todos = input.branch ? todosFromBranch(input.branch) : [];
    const prior = input.branch ? priorPluginSummary(input.branch) : undefined;
    const ledger = buildRecoveryLedger({
      messages,
      todos,
      tailTurns: resolved.tail_turns,
      maxBytes: resolved.max_ledger_bytes,
      ...(prior ? { priorSummary: prior } : {}),
    });

    const model = resolved.model === SELECTED_MODEL ? ctx?.model : resolveModel(resolved.model, ctx);
    if (!model) return; // let pi fall back to its built-in compaction

    const prompt = buildCompactionPrompt(
      ledger,
      resolved.max_summary_bytes,
      prior?.projection,
      resolved.response_mode,
    );

    const response = await ctx.modelRegistry.complete(
      model,
      { messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }] },
      {
        maxTokens: resolved.max_output_tokens,
        cacheRetention: "none", // compaction prompts are one-offs
        sessionId: uuidv7(),
        signal: input.signal,
      },
    );
    if (input.signal.aborted) return;

    const text = response.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text).join("\n");

    const finalSummary =
      renderProjectedResponse(text, ledger, resolved.max_summary_bytes, resolved.response_mode) ??
      buildAuthoritativeSummary({ ledger, maxBytes: resolved.max_summary_bytes });

    return {
      summary: finalSummary,
      usage: response.usage,
      details: { ledgerDigest: ledger.digest, ledgerBytes: utf8Bytes(ledger.block) },
    };
  }

  pi.on("session_before_compact", async (event, ctx) => {
    const sessionID = ctx.sessionManager.getSessionId() ?? "unknown";
    const result = await runPipeline({
      messages: [...event.preparation.messagesToSummarize, ...event.preparation.turnPrefixMessages],
      branch: ctx.sessionManager.getBranch(),
      sessionID,
      signal: event.signal,
    });
    if (!result) return; // fall through to pi default
    return {
      compaction: {
        summary: result.summary,
        firstKeptEntryId: event.preparation.firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore,
        usage: result.usage,
        details: result.details,
      },
    };
  });

  pi.on("session_before_tree", async (event, ctx) => {
    const sessionID = ctx.sessionManager.getSessionId() ?? "unknown";
    // branchEntries on session_before_tree is the active branch; entriesToSummarize
    // is a subset we want summarized. We feed everything to the ledger so context
    // isn't lost, but pin firstKept via the latest kept entry on the branch.
    const result = await runPipeline({
      messages: branchToAgentMessages(event.preparation.entriesToSummarize),
      branch: ctx.sessionManager.getBranch(),
      sessionID,
      signal: event.signal,
    });
    if (!result || !event.preparation.userWantsSummary) return;
    return { summary: { summary: result.summary, usage: result.usage, details: result.details } };
  });

  // TUI selector: "compaction-model" command
  pi.registerCommand("compaction-model", {
    description: "Choose a dedicated compaction model or follow the selected model",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) return;
      const options = ctx.modelRegistry.getAvailable().map(/* shape */);
      const choice = await ctx.ui.select("Compaction model", [
        { title: "Follow selected model", value: SELECTED_MODEL },
        ...options.map((o) => ({ title: o.name, value: `${o.provider}/${o.id}` })),
      ], { current: resolved.model });
      if (!choice) return;
      resolved = resolveOptions(parseOptions({ ...resolved, model: choice }));
      await savePiOptions(cwd, resolved);
      ctx.ui.notify(`Compaction model set to ${choice}`, "success");
    },
  });
}
```

### Settings persistence

`loadPiOptions(cwd)` / `savePiOptions(cwd, options)` read/write `<cwd>/.pi/safe-compaction.json`:

```json
{ "model": "selected", "tail_turns": 4, "max_ledger_bytes": 12288, "max_summary_bytes": 49152, ... }
```

Mode `0600`, atomic rename, defaults from `DEFAULT_OPTIONS` minus the OpenCode-managed fields (`preserve_recent_tokens`, `reserved_tokens` which pi manages via its own `compaction.*` settings).

### Errors and graceful degradation

Wrap each event handler in a `try/catch` that logs metadata only (`{hook: "session_before_compact", errorClass}`) and returns `undefined` so pi uses its built-in compaction. Never propagate errors into pi's runtime. Never log conversation content.

## `package.json` changes

```jsonc
{
  "exports": {
    ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" },
    "./server": { "types": "./dist/server.d.ts", "import": "./dist/index.js" },
    "./tui": { "types": "./dist/tui.d.ts", "import": "./dist/tui.js" },
    "./pi": { "types": "./dist/pi.d.ts", "import": "./dist/pi.js" }   // NEW
  },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-ai": "*"
  },
  "scripts": {
    "build:js": "bun build src/index.ts --outfile dist/index.js --target bun --format esm && bun build src/tui.ts --outfile dist/tui.js --target bun --format esm && bun build scripts/cli.ts --outfile dist/cli.js --target bun --format esm && bun build src/pi.ts --outfile dist/pi.js --target bun --format esm"
  }
}
```

`bun.lock` regenerates on `bun install`.

## `README.md` additions

New section under "Manual Git installation" describing the pi entry point:

- Install path: `~/.local/share/better-compact` (or any absolute path).
- Activation: `pi -e /abs/path/to/dist/pi.js` or via `packages: ["git:..."]` in `~/.pi/agent/settings.json`.
- Settings: `<cwd>/.pi/safe-compaction.json` for plugin-side options; pi's own `compaction.{reserveTokens,keepRecentTokens}` for the rest.
- `/compaction-model` slash command to pick the compaction model.

New section under "Limits" listing the pi-specific omissions:

- No admission hook for oversized input — pi rejects at its own layer.
- No history-transform hook — sanitization runs at adapter input and final-summary output only.
- Todos depend on a user-installed todo-tracking extension; empty otherwise.

## Implementation order

1. `src/pi-adapter.ts` — pure adapter + tests.
2. `src/pi.ts` — entry point wiring the adapter into `session_before_compact` first, then `session_before_tree`, then the `/compaction-model` command.
3. `package.json` — `./pi` export + build step + peer deps.
4. Manual smoke test against a real `pi` invocation with `compaction.keepRecentTokens` lowered to force auto-compaction, confirming the ledger block renders in the saved summary.
5. README updates.

## Verification

- `bun typecheck` from package root.
- `bun test` — existing suite passes unchanged. New `pi-adapter.test.ts` exercises the adapter against fixture arrays.
- The eval corpus is unaffected: the shared `renderProjectedResponse` / `buildAuthoritativeSummary` / `buildCompactionPrompt` contract is unchanged, so any provider-model combination that passes `eval/` today will continue to pass when consumed via the pi entry point.