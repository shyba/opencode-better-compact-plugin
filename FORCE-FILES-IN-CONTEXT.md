# Force files into context (pi extension design)

Status: implemented on branch `pi-support`. Separate from the better-compact pi-support work; can land as its own extension. Lives in `/home/user/repos/opencode-pi-support` worktree or a new one — TBD with user.

## Problem

Pi's bash tool (`!cmd`) truncates combined output at ~50 KB (`DEFAULT_MAX_BYTES` in `dist/core/tools/truncate.js`) via `truncateTail`, and records the surviving tail with `truncated: true` plus a temp-file path. Bash results are sent to the LLM as a user-role message (`Ran \`cmd\`\n\`\`\`\n<output>\n\`\`\``), so once a `cat some/file.ts` or `find src -name '*.rs' -print0 | xargs -0 cat` exceeds the limit, the file content the user wanted to push into context is gone.

`!!cmd` is worse: pi records the bash result with `excludeFromContext: true` and `convertToLlm` filters it out before sending to the LLM. So `!!cmd` is not a workaround — it's the opposite.

`user_bash` has `result?: BashResult`, but pi core calls `recordBashResult(command, result, { excludeFromContext })` using the prefix-derived flag. An extension cannot flip a `!!cmd` into "include fully".

The `input` event fires *after* the editor's bash dispatch, so it never sees `!cmd`/`!!cmd`. There is no extension hook between the prefix parse and `recordBashResult`, so we cannot intercept bash with a custom prefix.

## Goal

A user-invoked, explicit way to **attach file contents to the conversation** with:

1. **Explicit invocation** — distinct from the default `!cmd` truncation behavior. Use a slash command so dispatch is unambiguous and not entangled with pi's bash prefix handling.
2. **Context-size awareness** — measure projected total, compare against `ctx.getContextUsage()`, and either auto-proceed or confirm. A positional token-budget argument skips the confirmation when the user has already pre-committed to a limit.
3. **Pattern sugar** — both an ext+dir shorthand (`/cat .rs src`) and explicit globs (`/cat 'src/**/*.{ts,tsx}'`).

## Design: `/cat` slash command

`/cat` is the only command. Preset commands (`/cat-md`, `/cat-rs`, etc.) are deliberately omitted — the shorthand form covers them and extra commands pollute the slash-command namespace. (Names like `/load` and `/attach` are also avoided to leave room for pi's possible future use.)

### Syntax

```
/cat <arg> [<arg> ...]
```

Positional args are parsed in order:

1. **Token budget** (optional, must be the last arg if present). If the last arg parses as a positive integer, it's consumed as a target token budget. Subsequent reads respect this cap. When set and the projected usage is under the budget, the confirmation dialog is skipped — the user has already pre-committed.
2. **Pattern args** (the rest). Either:
   - **Shorthand** (one or two args, first starts with `.`): `<ext> [dir]`. `<ext>` is a file extension like `.rs`, `.md`, `.py`, `.ts`, `.tsx`. Expands to `<dir-or-cwd>/**/*<ext>` via Bun's glob. The dir defaults to `.`.
   - **Explicit globs** (any number of args): each arg is a literal path or a glob pattern (e.g. `src/main.ts`, `src/**/*.ts`, `src/**/*.{ts,tsx}`). Multiple patterns are OR.

Disambiguation rule for the shorthand: the first arg must start with `.`, must look like an extension (no path separators, no glob meta), and the second arg, if present, must not look like a glob (no `*`, `?`, `[`, leading `./` or `/`). If any of these checks fail, fall back to treating all args as explicit globs.

### Examples

```
/cat src/main.ts                       single literal file
/cat src/main.ts src/util.ts           two literal files
/cat 'src/**/*.ts'                     explicit glob
/cat 'src/**/*.{ts,tsx}' 'README.md'   two globs (one bracketed, one literal)
/cat .rs src                           all .rs files under src
/cat .md                               all .md files under cwd
/cat .ts src 50000                     all .ts files under src, capped at 50k tokens
/cat 'src/**/*.ts' 80000               explicit glob capped at 80k tokens
```

### What gets injected

A single user-role message of the form:

```
<file:relative/path/to/file1.ts>
<full file content, no truncation>
</file>

<file:relative/path/to/file2.ts>
<full file content>
</file>
```

Followed by an instruction line:

```
Read the attached files above. Their full contents are intentionally included; do not re-read them with the read tool unless asked.
```

If `ctx.isStreaming()` is false, sent immediately via `pi.sendUserMessage(content)`. If streaming, queued as follow-up via `{ deliverAs: "followUp" }` so the existing turn finishes before the new content reaches the LLM.

### Context-size awareness

Before injection, the command:

1. Resolves patterns to file paths and reads each one (respecting the token budget if given).
2. Computes `totalBytes` and `estTokens` (see "Token estimation" below).
3. Reads current usage from `ctx.getContextUsage()`:
   - `usage.tokens`: may be `null` right after compaction (pi hasn't seen a post-compaction assistant response yet). In that case, treat current usage as `unknownUsageFraction * contextWindow` (default 0.50) for threshold purposes — conservative, since compaction usually leaves room but we can't be sure.
   - `usage.contextWindow`: model context window. If this is `0` (no model set yet), refuse with a clear error.
4. Applies a single threshold (configurable, default `0.95`):
   - `usage + estTokens ≤ threshold * contextWindow` → inject silently.
   - Above → refuse with `ctx.ui.notify(...)` showing the projection, refuse and suggest `/compact` first.
5. **Token budget overrides nothing but caps the read**: if a budget is specified, reading stops when cumulative token estimates exceed it (files already read are kept; later files are dropped). The budget does not bypass the threshold — both apply. If even the highest-priority single file exceeds the budget, refuse with a clear error.

The token-budget cap is applied **before** reading (when expanding the glob and reading files) by tracking cumulative token estimates and stopping early. This avoids reading a 4 MiB file only to drop it.

## Token estimation

Pi's own token estimation (`@earendil-works/pi-ai/dist/utils/estimate.js`) uses a simple heuristic:

```js
const CHARS_PER_TOKEN = 4;
export function estimateTextTokens(text) {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}
```

This is also what pi uses to populate `ctx.getContextUsage()` when there's no fresh `usage.totalTokens` from a recent assistant response (see `estimateMessages` and `estimateTextAndImageContentTokens` in the same file). Pi's `usage.tokens` value is exact when the most recent assistant message has usable `usage.totalTokens`; otherwise it's the chars/4 heuristic.

We will use the **same heuristic** (`chars / 4`), for consistency. Two consequences:

- **No tokenizer dependency.** No `gpt-tokenizer`, `tiktoken`, etc. needed in the extension's `package.json`. Smaller install, no version drift with provider tokenizer changes, no picking-the-wrong-tokenizer risk (different model families use different BPE vocabularies).
- **Approximate projection.** The projection may be off by ±25 % depending on language and content (code is usually denser than English; JSON is denser; markdown mixed content varies). The 0.95 default threshold gives a real 5 % safety margin at the model wall even if our estimate is optimistic.

If a user wants a more accurate count, they can:

- Lower `warnThreshold` in `<cwd>/.pi/cat-files.json` (default `0.95`) to add headroom.
- Pin a per-model multiplier in `<cwd>/.pi/cat-files.json`:
  ```jsonc
  { "charsPerToken": 3.5 }
  ```
  This applies to our projection only — `ctx.getContextUsage()` keeps using pi's own numbers.

Future enhancement (not v1): if a real tokenizer is bundled, it should pick `o200k_base` for `gpt-5*` / `o200k_base` family, `cl100k_base` for older OpenAI / `*-token-plan` providers, and a Claude-tokenizer approximation otherwise. Pi does not expose tokenizer metadata on its `Model` type today (`grep -E "tokensPer|encodingFor" pi-ai/dist/types.d.ts` returns nothing), so this would have to be heuristic-by-model-id. Not worth shipping in v1.

Image content: not applicable here — `/cat` only reads text files. Binary auto-detect skips non-text before counting.

### Skip list

Default skip list (configurable): `node_modules`, `.git`, `dist`, `build`, `out`, `target`, `vendor`, `__pycache__`, `.next`, `.nuxt`, `.turbo`, `.cache`, `.venv`, `venv`, `.idea`, `.vscode`, `.gradle`. A path component matching any of these is excluded when walking. Symlinks are not followed.

### Per-file bounds

Even with context awareness, single files should be bounded:

- `maxFileBytes`: 4 MiB per file (default). Files above the limit are skipped with a marker line (`<file:path skipped: 8.2 MiB exceeds limit of 4 MiB>`).
- `maxTotalBytes`: 32 MiB aggregate (default). If the resolved set would exceed, refuse.
- `maxFileCount`: 1000 files (default). `/cat-tree` is the only preset-sensitive one; a glob like `**/*` could explode otherwise.

All configurable.

### Binary / encoding

- Binary auto-detect: scan first 8 KiB for NUL byte; skip with `<file:path skipped: binary>`.
- Encoding: UTF-8 with replacement on decode failure (`new TextDecoder("utf-8", { fatal: false })`).

### Confirmation UX

**No confirmation.** The user rejected the UX — too much friction for a power-user tool. The flow is:

1. Resolve + read files (capped by `[tokens]` if given).
2. Estimate projected context usage.
3. If projection > `warnThreshold * contextWindow` → notify with the measured numbers, refuse, suggest `/compact` first. Command exits without sending anything.
4. Otherwise → inject via `ctx.sendUserMessage(formatted)`. No confirmation step.

If the user wants to push through despite the warning, they re-run with a `[tokens]` budget. The budget caps the read but does **not** bypass the warn threshold — it's an explicit user commitment, not a way to override the safety check. (We could make the budget bypass the threshold, but per the user's stated workflow the budget is a smaller-than-context read, not "force include anyway".)

The notify message format:

```
Refusing /cat: would use ~142k tokens, project is 87% of 200k context.
Run /compact first, or re-run with a smaller pattern or token budget.
```

The message lists the top 3 largest files by default so the user can decide what to drop.

### Settings

`<cwd>/.pi/cat-files.json` (mode `0600`, atomic rename). Same writer as the better-compact pi adapter.

```jsonc
{
  "warnThreshold": 0.95,
  "unknownUsageFraction": 0.50,
  "charsPerToken": 4.0,
  "maxFileBytes": 4194304,
  "maxTotalBytes": 33554432,
  "maxFileCount": 1000,
  "skipDirs": ["node_modules", ".git", "dist", "build", "out", "target",
               "vendor", "__pycache__", ".next", ".nuxt", ".turbo",
               ".cache", ".venv", "venv", ".idea", ".vscode", ".gradle"]
}
```

### Implementation sketch

```ts
import { Glob } from "bun";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("cat", {
    description: "Attach file contents to the conversation",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const parsed = parseCatArgs(args);   // { patterns: string[], tokenBudget?: number }
      const cwd = ctx.cwd;
      const files = await resolvePatterns(parsed.patterns, cwd); // walks, applies skip list
      // apply per-file cap, read, format, then threshold check
      // ...
      await ctx.sendUserMessage(formatted);
    },
  });
}
```

The parser, walker, formatter, and threshold logic are pure and unit-testable.

### Limits

- `/cat` cannot undo its injection. There's no "remove these files from context" — the user has to `/compact` or `/new`.
- Files are read once at invocation time. Subsequent edits do not propagate unless the user runs `/cat` again.
- No confirmation step. If the projection exceeds the warn threshold, the command refuses outright; user can re-run with a smaller pattern, narrower glob, or a `[tokens]` budget.
- Token-budget overflow drops largest files first by default (see open questions).
- Token counts are approximate (`chars / 4`). The `charsPerToken` config can lower this for pessimistic estimation.

### Open questions

### Open questions

1. **Token-budget overflow**: when the cumulative token count exceeds the budget, should we drop the *largest* file first (keep more files, smaller ones) or the *smallest* (keep fewer files, larger ones)? Default proposal: drop the largest first, since the user probably wants coverage. Caller can specify with a future flag if needed.
2. **Drop-order when budget-threshold both fail**: when projection already exceeds the threshold AND a budget is given, what gets dropped first? Default: drop files (not the whole injection) until projection fits, then keep going under the budget cap. Means the threshold wins; budget is a soft cap below it.
3. **Notify-on-success**: should we still surface a small toast on successful injection (`Attached 12 files (~18k tokens, ~9% of context)`) so the user knows it happened? Or stay silent? Default: silent — the chat transcript shows the new user message, that's enough signal.
4. **Heuristic multiplier calibration**: with `charsPerToken: 4`, code-heavy content can be off by 20–30 %. We default to the safe side (over-estimate) by also accepting a `< 1.0` multiplier in config (`charsPerToken: 3.5` = pessimistic). Acceptable as a v1 trade-off; not worth shipping a tokenizer.
5. **No tokenizer shipped**: this means `/cat .md` on a giant Markdown-heavy repo may report a smaller number than the real token cost, because BPE tokenizes differently per model family. Acceptable for a v1 warn-and-cancel tool — we err on the side of false negatives (refusing when it would have fit) via the configurable multiplier. A v2 could ship `gpt-tokenizer` or similar with a per-model-id heuristic.

### Pinning files across compaction (`--fixed` / `--reset`)

Implemented on branch `cat-fixed`. `/cat <patterns> --fixed` records a session-scoped pin
(`sessionId`, resolved `patterns`, optional `tokenBudget`) in `<cwd>/.pi/cat-files.json`;
`/cat --reset` clears it. While a pin is active, every compaction re-reads the pinned files
fresh from disk and embeds them deterministically at the front of the compaction summary:

- The summary stays `[pinned files][conversation summary][ledger]`. The pinned block is
  byte-identical across turns, so providers cache it as a fixed prefix; the conversation
after it compacts normally.
- Old attachment messages carry a marker (`<!-- cat-files v1 -->`) and are excluded from the
  recovery ledger and the summarization prompt, so compaction never re-bills the file
  contents as input tokens and the summary never describes stale copies.
- If the pinned files alone would exceed 80% of the context window, compaction embeds a
  paths-only block plus a note instead of overflowing.

This replaced the earlier design that re-injected files at the tail after each compaction
(`session_compact` + `sendUserMessage`): tail re-injection places the files after the
dynamic conversation, where providers cannot cache them, so every turn would re-bill the
full file contents as uncached input. Embedding at the front of the summary keeps them in
the cacheable fixed prefix.

### Verification

- `bun test` for the argument parser, glob walker, threshold logic (pure, no pi runtime).
- Manual: load the extension, type `/cat src/index.ts`, confirm the LLM receives the file content in a single message and no temp file or truncation appears.
- Manual: type `/cat .rs src` on a non-trivial repo, confirm the confirm prompt fires when projected usage crosses the threshold, and `/cat .rs src 5000` bypasses the prompt.
- Manual: type `/cat 'src/**/*'`, confirm the skip list excludes `node_modules`, `dist`, etc.
- Manual: type `/cat .bin-some-extension`, confirm the disambiguation rule falls back to glob mode.