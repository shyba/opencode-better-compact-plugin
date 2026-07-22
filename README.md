# opencode-safe-compaction

`opencode-safe-compaction` is a global OpenCode V1 server plugin that builds a bounded recovery ledger, asks the compaction model for a verifiable summary, and replaces malformed nonempty summaries with a deterministic fallback. It is an independent MIT-licensed repository and makes no OpenCode core changes.

The package is private at version `0.1.0`. Git/source-path installation is the supported installation path for now; the package metadata and exports are ready for a later npm release.

## Compatibility and prerequisites

- Bun 1.3.14 or newer (verified with 1.3.14).
- OpenCode `>=1.18.4 <1.19.0`. The plugin uses experimental V1 hooks, so the upper bound is intentional.
- A configured compaction model. The initial configuration below uses `opencode-go/glm-5.2`, but the package itself is provider-neutral.
- The selected model must have an output limit above zero and a context limit larger than `reserved_tokens`.

Before enabling the plugin, remove only the stale `deepseek-v4-flash-free` model-limit override from the global OpenCode JSONC configuration. Do not remove the provider, other model entries, credentials, or unrelated settings. The usual global file is `${XDG_CONFIG_HOME:-~/.config}/opencode/opencode.jsonc`; use the path reported by OpenCode if the configuration directory was overridden. The plugin deliberately does not rewrite provider catalogs.

## One-command installation

Review the installer, then run it on each server:

```sh
curl -fsSL https://raw.githubusercontent.com/shyba/opencode-better-compact-plugin/default/install.sh | sh
```

The installer clones the `default` branch over HTTPS to `$HOME/.local/share/opencode/plugins/safe-compaction`, adds the absolute source tuple to the global OpenCode configuration, preserves JSONC comments and unrelated settings, and verifies the result with `opencode debug config`. It is idempotent: rerunning it fast-forwards a clean checkout and does not duplicate the tuple. When it changes an existing configuration file, it first creates a timestamped `*.safe-compaction-backup-*` copy beside that file.

The command requires `git`, Bun 1.3.14 or newer, and OpenCode `>=1.18.4 <1.19.0` on `PATH`. If OpenCode or Bun is installed at a nonstandard path, or a different compaction model is required, pass overrides to `sh`:

```sh
curl -fsSL https://raw.githubusercontent.com/shyba/opencode-better-compact-plugin/default/install.sh |
  OPENCODE_SAFE_COMPACTION_OPENCODE="$HOME/.local/bin/opencode" \
  OPENCODE_SAFE_COMPACTION_BUN="$HOME/.bun/bin/bun" \
  OPENCODE_SAFE_COMPACTION_MODEL="provider/model" \
  sh
```

Other supported overrides are `OPENCODE_SAFE_COMPACTION_DIR`, `OPENCODE_SAFE_COMPACTION_CONFIG_DIR`, `OPENCODE_SAFE_COMPACTION_REPO`, and `OPENCODE_SAFE_COMPACTION_REF` (an alternate branch). All directory overrides must be absolute. The installer respects an existing `OPENCODE_CONFIG_DIR`. It refuses to update a dirty checkout, a mismatched remote or branch, duplicate/conflicting plugin entries, and configurations containing the stale `deepseek-v4-flash-free` limit override. It never rewrites provider catalogs.

The source plugin has no runtime package dependencies, so the installer does not populate `node_modules`. Restart a running OpenCode server after installation.

## Manual Git installation

Clone this repository to a stable absolute path:

```sh
install_dir="$HOME/.local/share/opencode/plugins/safe-compaction"
git clone --branch default https://github.com/shyba/opencode-better-compact-plugin.git "$install_dir"
```

Add the tuple below to the global server configuration's existing `plugin` array, replacing `USER` with the account's actual home directory. The plugin path must be absolute; environment variables are not expanded inside JSON. JSONC comments are allowed. Keep other plugin entries intact.

```jsonc
{
  "plugin": [
    [
      "/home/USER/.local/share/opencode/plugins/safe-compaction/src/index.ts",
      {
        "model": "opencode-go/glm-5.2",
        "tail_turns": 4,
        "preserve_recent_tokens": 16000,
        "reserved_tokens": 32000,
        "max_output_tokens": 16384,
        "max_user_text_bytes": 524288,
        "max_inline_data_bytes": 10485760,
        "max_historical_part_bytes": 131072,
        "max_ledger_bytes": 12288,
        "max_summary_bytes": 49152
      }
    ]
  ]
}
```

The source path must be absolute. Loading `src/index.ts` is intentional for Git installs; no workspace entry, submodule, parent checkout, or prebuilt `dist` directory is required.

## Options

Tuple options use snake case. Unknown keys and invalid values fail during plugin setup instead of being ignored.

| Option | Default | Meaning |
| --- | ---: | --- |
| `model` | none | Required `provider/model` identifier unless OpenCode already defines the compaction agent model. |
| `tail_turns` | `4` | Number of recent ordinary user requests retained in the recovery ledger. May be zero. |
| `preserve_recent_tokens` | `16000` | Recent-history budget written into OpenCode's V1 compaction settings. |
| `reserved_tokens` | `32000` | Context reserved from compaction input; must leave usable model context. |
| `max_output_tokens` | `16384` | Plugin ceiling for compaction output, further capped by the model limit. |
| `max_user_text_bytes` | `524288` | Maximum combined UTF-8 bytes in newly admitted, non-synthetic text parts. |
| `max_inline_data_bytes` | `10485760` | Maximum combined decoded bytes in newly admitted inline `data:` attachments. |
| `max_historical_part_bytes` | `131072` | Maximum UTF-8 bytes exposed from one historical text part during a compaction/recovery attempt. |
| `max_ledger_bytes` | `12288` | Maximum canonical recovery-ledger block size. |
| `max_summary_bytes` | `49152` | Maximum accepted summary size. It must exceed `max_ledger_bytes` by at least 1024 bytes. |

For values OpenCode already exposes (`model`, `tail_turns`, `preserve_recent_tokens`, and `reserved_tokens`), precedence is explicit tuple option, existing OpenCode value, then plugin default. Other plugin limits use the explicit tuple option or plugin default. The configuration hook sets the compaction model and temperature zero, and applies the selected compaction thresholds. Existing explicit `compaction.auto` and `compaction.prune` values are preserved; absent values default to `true` and `false` respectively.

## Runtime behavior

The plugin has five defensive stages:

1. Admission rejects oversized new user text or decoded inline data and reports the measured and allowed byte counts. It recommends file references or smaller chunks; it never silently truncates a new request.
2. Compaction reads complete session messages and todos through the OpenCode client, redacts credential-shaped values, and builds a deterministic bounded ledger of requests, constraints, todos, paths, tool statuses, errors, evidence snippets, and next actions. Full tool outputs are never copied into the ledger.
3. The compaction prompt requires one Markdown response with `Goal`, `Constraints`, `Decisions`, `Current state`, `Files`, `Evidence`, `Blockers/questions`, and `Next actions`, followed by an exact versioned SHA-256 recovery-ledger block.
4. During an active compaction/recovery attempt, cloned provider history is bounded: oversized historical text is reduced to a byte-bounded head and tail, long completed tool output is reduced to roughly 900 characters from each end, and oversized inline replay is replaced in the model-visible copy. Normal turns are left unchanged.
5. A compaction assistant text part is accepted only when it has every required section, is within the byte limit, and carries the exact ledger digest. A malformed, refusal, oversized, or later split text part is replaced or blanked as appropriate. Auto-continuation is permitted only for an original valid summary or deterministic fallback, and an earlier plugin's disabled setting is preserved.

The plugin stores only bounded attempt metadata in process memory, keyed by the full Session ID, with a 30-minute TTL. Completion, idle, deletion, error, and disposal signals clean it up. Events are cleanup/audit signals, not correctness gates.

## Security and privacy

- The runtime plugin has no telemetry, external network client, or runtime dependency. Its OpenCode client calls read the active session and todo records from the host server.
- It creates no shadow transcript, sidecar recovery file, or external cache. Durable conversation history remains owned by OpenCode.
- Recovery content is bounded and credential-shaped values are redacted before they enter ledger fields.
- Runtime logging contains metadata only; conversation text, tool output, ledger bodies, and credentials are not logged.
- New oversized requests fail closed. Historical truncation affects only the cloned model-visible history used during recovery, not durable records.

The optional live eval adapters described below either spawn an installed OpenCode executable or make an explicit HTTP request to the configured evaluation endpoint. They are development tooling, are never imported by the runtime entry point, and use only the checked-in synthetic corpus.

## Limits

This plugin mitigates compaction failures; it cannot make OpenCode's core cutover atomic.

- Support is limited to the legacy V1 session compactor. V2 support is deferred until public V2 compaction hooks exist.
- Core still owns history head/tail selection, `tail_start_id`, boundary acceptance, durable replay, and cutover.
- A zero-text provider response emits no text-complete hook, so the plugin cannot insert a replacement summary. It suppresses ordinary auto-continuation and can rebuild recovery context on the next user turn.
- A split response can expose more than one text part. When all parts are already visible, the first targeted part is replaced by one fallback and later parts are blanked. If a later part appears only after a valid first part was persisted, V1 offers no hook to replace that earlier text retroactively; the plugin blanks the late part and suppresses auto-continuation.
- Overflow replay bypasses the normal auto-continue hook and remains in durable storage. The plugin can sanitize only the cloned provider-visible replay.
- Nonempty summaries written before this plugin are retained as legacy context, but they are not trusted as validation anchors. Only summaries with a valid plugin ledger may anchor plugin recovery.
- Attempt state is process-local. This plugin does not implement clustered compaction ownership or crash-safe provider retries.

## Development and packaging

Run commands from this repository, not from an enclosing checkout:

```sh
bun install --frozen-lockfile
bun run typecheck
bun test
bun run build
bun -e 'await import("./dist/index.js")'
npm pack --dry-run
```

`dist/` is deliberately untracked. `prepack` builds `dist/index.js` and TypeScript declarations. The package exposes both `opencode-safe-compaction` and `opencode-safe-compaction/server`; both resolve to the runtime build, while the root export also supplies declarations. Keep `private: true` until publication is explicitly approved.

For a portability smoke test, copy or clone the repository outside any OpenCode checkout, repeat install/build/test, and load either the absolute `src/index.ts` path or the packed artifact from an isolated OpenCode configuration. Nothing in source, tests, or eval tooling depends on the parent checkout.

## Evaluation

The `eval/` directory contains 30 sanitized, synthetic transcripts. The runner evaluates three repetitions per case under two separately implemented conditions:

- `baseline` uses a checked-in snapshot of the OpenCode 1.18.4 V1 compaction prompt. It is informational and does not import OpenCode core.
- `plugin` uses this package's real ledger builder, compaction prompt, digest validator, and fallback generator.

Provider transport is a separate adapter shared by both conditions. The default fixture adapter is deterministic and deliberately cycles through valid, malformed, and refusal responses so the harness and fallback path can be tested offline. It is not evidence of model quality or live-provider performance.

```sh
# Offline harness/tests: 30 cases x 3 repetitions x 2 conditions
bun test eval

# Print the deterministic report
bun eval/run.ts --provider fixture --repetitions 3
```

The report includes structural validity, plugin digest validity, invalid/empty auto-continuations, exact normalized key-fact recall, and matches against each case's explicit unsupported-material-claim list. The structural/digest denominator contains nonempty accepted responses; zero-text responses are reported separately because the runtime text hook cannot replace them. The plugin gate requires 100% structure/digest validity after applicable fallback, zero invalid or empty auto-continuations, at least 95% key-fact recall, zero listed unsupported claims, and zero provider errors.

The unsupported-claim metric is a closed, reproducible corpus check, not a general semantic hallucination judge. Review accepted summaries separately before treating a new provider/model as qualified.

To use the installed OpenCode executable and its existing provider authentication, run the CLI adapter. `SAFE_COMPACTION_EVAL_OPENCODE` may be an absolute executable path or a command available on `PATH`; the model must use OpenCode's `provider/model` form.

```sh
SAFE_COMPACTION_EVAL_OPENCODE="/absolute/path/to/opencode" \
SAFE_COMPACTION_EVAL_MODEL="opencode-go/glm-5.2" \
bun eval/run.ts --provider opencode-cli --repetitions 3
```

The adapter starts one non-interactive `opencode run --agent compaction` process per condition, case, and repetition, injects an evaluation-only `{"*":"deny"}` permission override for that agent, passes the tagged synthetic message sequence through stdin, and uses the selected model from the installed OpenCode configuration. A full 30-case, three-repetition comparison starts 180 isolated CLI runs and may consume provider quota. It strips ANSI presentation, normalizes line endings, removes the OpenCode assistant header, and preserves the complete requested baseline or plugin response from plain stdout so trailing material is validated. CLI stderr is consumed but never copied into the eval report or error log, avoiding accidental conversation-content logging.

Alternatively, run the same corpus directly against an OpenAI-compatible chat-completions endpoint:

```sh
SAFE_COMPACTION_EVAL_URL="https://provider.example/v1/chat/completions" \
SAFE_COMPACTION_EVAL_MODEL="provider-model-id" \
SAFE_COMPACTION_EVAL_API_KEY="..." \
bun eval/run.ts --provider openai-compatible --repetitions 3
```

No live-provider result is checked in or claimed by this repository. Record the provider, model, endpoint implementation, date, and raw aggregate report when running a qualification eval; never commit credentials or unsanitized transcripts.
