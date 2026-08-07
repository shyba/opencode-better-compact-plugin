# opencode-safe-compaction

`opencode-safe-compaction` is a global OpenCode V1 plugin that builds a bounded recovery ledger and asks the compaction model to choose the semantically active recovery fields. A structurally valid model-authored summary is accepted only when it preserves the current canonical ledger block and digest. Its separate TUI entrypoint provides a native compaction-model selector. It is an independent MIT-licensed repository and makes no OpenCode core changes.

The package is private at version `0.1.0`. Git/source-path installation is the supported installation path for now; the package metadata and exports are ready for a later npm release.

## Compatibility and prerequisites

- OpenCode supplies the Bun runtime used by the plugin. A separate Bun installation is optional for the one-command installer and required only for development or packaging.
- OpenCode `>=1.18.4 <1.19.0`. The plugin uses experimental V1 hooks, so the upper bound is intentional.
- Either `model: "selected"` to follow each compaction's selected model, or a fixed `provider/model`. The initial configuration below uses `opencode-go/glm-5.2`, but the package itself is provider-neutral.
- The selected model must have a positive output limit and leave positive usable input under OpenCode's V1 overflow calculation.

Before enabling the plugin, remove only the stale `deepseek-v4-flash-free` model-limit override from the global OpenCode JSONC configuration. Do not remove the provider, other model entries, credentials, or unrelated settings. The usual global file is `${XDG_CONFIG_HOME:-~/.config}/opencode/opencode.jsonc`; use the path reported by OpenCode if the configuration directory was overridden. The plugin deliberately does not rewrite provider catalogs.

## One-command installation

Review the installer, then run it on each server:

```sh
curl -fsSL https://raw.githubusercontent.com/shyba/opencode-better-compact-plugin/default/install.sh | sh
```

The installer follows OpenCode's selected model by default on a fresh installation. It never asks for a model, and an upgrade preserves the policy already configured by the plugin.

After installation, run `/compaction-model` inside the OpenCode TUI (or choose **Compaction model** in the command palette). The native selector lists connected models plus **Follow selected model**. A selection is persisted through the same locked, atomic JSONC update used by the installer, then OpenCode reloads its instances. No LLM request is spent on the settings change.

In **Follow selected model** mode, automatic compaction uses the model on the latest user turn and manual `/compact` uses the model selected when the command runs. Changing the ordinary OpenCode model therefore applies to the next compaction without another plugin setting change.

The installer clones the `default` branch over HTTPS to `$HOME/.local/share/opencode/plugins/safe-compaction`, adds the absolute source tuple to both the global server and TUI configurations, preserves JSONC comments and unrelated settings, and verifies the effective model, temperature, and compaction settings reported by `opencode debug config`. The server tuple carries all plugin options; the TUI tuple carries only the synchronized model policy. If exactly one server entry points to a different local safe-compaction checkout, the installer imports that module to verify the expected plugin identity, preserves its validated tuple options, and replaces only its source string with the managed path. Unverifiable lookalikes and duplicate entries are refused. It first loads a generated minimal configuration containing only the exact installed tuple, then checks compatibility with the real target configuration. Fresh installs must retain all three exact numeric thresholds. For a pre-existing partial tuple, values intentionally inherited from earlier configuration or plugin hooks must still satisfy the plugin's type and safety bounds; explicit tuple values remain exact. Both checks use a temporary HOME and XDG directories; inherited `OPENCODE_CONFIG`, `OPENCODE_CONFIG_CONTENT`, and pure mode are neutralized. An unrelated plugin therefore cannot impersonate successful activation. Seeing the tuple alone is not considered successful activation. It is idempotent: rerunning it fast-forwards a clean checkout and does not duplicate either tuple. Configuration edits are serialized with a directory lock and committed by atomic rename as one rollback-safe transaction. When an existing file changes successfully, a timestamped `*.safe-compaction-backup-*` copy remains beside it.

The shortest command follows the mutable `default` branch. For a security-sensitive server, pin the reviewed installer and checkout to the same lowercase 40-character commit:

```sh
commit="COPY_A_REVIEWED_40_CHARACTER_COMMIT_HERE"
curl -fsSL "https://raw.githubusercontent.com/shyba/opencode-better-compact-plugin/$commit/install.sh" |
  env OPENCODE_SAFE_COMPACTION_REF="$commit" sh
```

Before writing configuration, the installer imports the exact absolute server and TUI source modules, checks both plugin identities, initializes the server with the exact tuple options, and runs its configuration hook. Existing tuples go through the same runtime option validation, including unknown-key and cross-limit checks. Duplicate root `plugin` keys are rejected rather than collapsed by JSONC parsing.

Checkout update, configuration activation, and `opencode debug config` verification form one installer transaction. A checkout-parent lock serializes transactions sharing an install path even when their configuration directories differ; a second lock serializes transactions sharing a configuration directory. Both are held from before clone/update through verification and commit. A later failure restores the prior configuration, permissions, and Git commit, or removes a newly created clone. Successfully written configuration and installer-created backups use mode `0600` because OpenCode configuration may contain credentials. Rollback compares the activated configuration digest before restoring it, so it refuses to overwrite a file changed independently during activation; in that case it also preserves the checkout so the independently edited tuple cannot be left pointing at removed or rolled-back source. An uncatchable termination such as `SIGKILL` or a host power loss cannot run the shell rollback trap; the next installer removes a lock whose recorded process no longer exists, but inspect the timestamped backup and checkout before rerunning.

The command requires `git` and OpenCode `>=1.18.4 <1.19.0`. It first checks `PATH`, then the official installer locations (`$OPENCODE_INSTALL_DIR`, `$XDG_BIN_DIR`, `$HOME/bin`, and `$HOME/.opencode/bin`) and common npm, Bun, pnpm, mise, Nix, and Homebrew user/system locations. It uses Bun 1.3.14 or newer when one is already available. Otherwise it downloads the pinned Bun 1.3.14 archive from the official `oven-sh/bun` GitHub release into the installer transaction directory, verifies the archive against a platform-specific SHA-256 digest, and deletes it when the installer exits. The automatic bootstrap supports Linux, macOS, and FreeBSD on x86-64 or ARM64; it needs `curl`, a SHA-256 implementation (`sha256sum`, `shasum`, or `openssl`), and `unzip` or `busybox`. If OpenCode or Bun is installed elsewhere, automatic download is undesirable, or a different compaction model is required, pass overrides to `sh`:

```sh
curl -fsSL https://raw.githubusercontent.com/shyba/opencode-better-compact-plugin/default/install.sh |
  OPENCODE_SAFE_COMPACTION_OPENCODE="$HOME/.local/bin/opencode" \
  OPENCODE_SAFE_COMPACTION_BUN="$HOME/.bun/bin/bun" \
  OPENCODE_SAFE_COMPACTION_MODEL="provider/model" \
  sh
```

Other supported overrides are `OPENCODE_SAFE_COMPACTION_DIR`, `OPENCODE_SAFE_COMPACTION_CONFIG_DIR`, `OPENCODE_SAFE_COMPACTION_REPO`, and `OPENCODE_SAFE_COMPACTION_REF` (an alternate branch or exact lowercase 40-character commit). Exact commits are fetched and checked out detached. All directory overrides must be absolute. The installer respects an existing `OPENCODE_CONFIG_DIR`. It refuses insecure `http://` and `git://` repository URLs, including an insecure existing origin that would otherwise normalize to the requested HTTPS GitHub repository. It also refuses a dirty checkout, a mismatched remote or branch, duplicate or unverifiable plugin entries, and configurations containing the stale `deepseek-v4-flash-free` limit override. It never rewrites provider catalogs.

The source plugin has no runtime package dependencies, so the installer does not populate `node_modules`. OpenCode may manage its standard plugin SDK in the configuration directory when it first loads a TUI plugin. A bootstrapped Bun is temporary and is not installed into the user account or retained by the plugin; the in-app selector uses OpenCode's own Bun runtime. Restart a running OpenCode server after installation.

The installer also creates `better-compact` in the user bin directory when a persistent Bun executable is available:

```sh
better-compact help
better-compact doctor
better-compact update
better-compact sync run --once
better-compact sync status
better-compact installation reset --yes
better-compact installation adopt --yes
```

The generated wrapper points at the persistent checkout and also falls back to the standard checkout path if an older wrapper still references a deleted temporary installer directory. Re-running the installer repairs that wrapper in place.

`installation reset --yes` intentionally discards the local sync identity, cursors, and outbox so the next run starts a new installation. `installation adopt --yes` is the explicit clone/recovery operation: it imports the remote source incarnation and high-water mark, then acknowledges matching local rows. Both commands are destructive and require the flag.

`doctor` checks the managed checkout, both OpenCode configuration surfaces, the OpenCode and Bun executables, and performs a read-only SQLite probe. `update` runs the same rollback-safe checkout/configuration transaction as the installer. If Bun was bootstrapped temporarily during installation, install Bun separately or invoke the CLI with `OPENCODE_SAFE_COMPACTION_BUN=/path/to/bun`.

The sync runner reads configured OpenCode V1 SQLite sources read-only, stages redacted records in the stable local state database, and uploads bounded batches when the configured Postgres environment variable is present. `--once` performs one reconciliation pass; without it, the runner continues polling. Postgres failures leave leased outbox rows for retry and do not affect OpenCode.

Remote Postgres URLs must use certificate-verifying TLS (`sslmode=verify-full`) unless the host is loopback. The runner applies the checked-in, idempotent SQL migrations before the source handshake. Credentials stay in the environment or a separate mode-`0600` service environment file; they are never written to the JSON configuration.

During compaction, the model receives the bounded ledger and a single-response JSON contract. The JSON projection contains goal, constraints, decisions, current state, files, evidence, blockers, and next actions, with every claim tied to stable references in the canonical ledger. The plugin strictly parses it (including duplicate-key rejection), validates its digest and provenance, and renders it into the durable Markdown summary together with the canonical ledger block. The ledger remains the verified recovery anchor; projected files and actions are useful model-authored organization, not independent evidence. Legacy Markdown summaries remain accepted for compatibility. Missing sections, invented digests, stale references, oversized output, refusals, and split/empty responses are replaced with a bounded ledger-grounded summary so the host remains usable; the hook also marks that provisional result with an optimistic `retry` signal, which a retry-capable future host can use to discard it and retry the model before cutover. Current V1 ignores unknown output fields, so no OpenCode fork is required.

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
      "/home/USER/.local/share/opencode/plugins/safe-compaction/runtime",
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

OpenCode loads TUI plugins from its separate global `tui.jsonc`. Add the same runtime directory there with the synchronized model policy:

```jsonc
{
  "plugin": [
    [
      "/home/USER/.local/share/opencode/plugins/safe-compaction/runtime",
      {
        "model": "opencode-go/glm-5.2"
      }
    ]
  ]
}
```

The runtime-directory path must be absolute. Its package metadata exposes separate source-first server and TUI entrypoints; the two configuration entries activate the compaction hooks and the in-app selector respectively. No workspace entry, submodule, parent checkout, or prebuilt `dist` directory is required.

## Options

Tuple options use snake case. Unknown keys and invalid values fail during plugin setup instead of being ignored.

| Option | Default | Meaning |
| --- | ---: | --- |
| `model` | `selected` | `selected` follows the model chosen for each compaction; `provider/model` pins a dedicated compaction model. |
| `response_mode` | `json` | `json` asks the model for the single strict JSON projection and validates it; `markdown` keeps the legacy Markdown contract for a compatibility window. The legacy Markdown validator stays available in both modes for already-stored plugin summaries. |
| `tail_turns` | `4` | Number of recent ordinary user requests retained in the recovery ledger. May be zero. |
| `preserve_recent_tokens` | `16000` | Recent-history budget written into OpenCode's V1 compaction settings. |
| `reserved_tokens` | `32000` | Context reserved from compaction input; must leave usable model context. |
| `max_output_tokens` | `16384` | Plugin ceiling for compaction output, further capped by the model limit. |
| `max_user_text_bytes` | `524288` | Maximum combined UTF-8 bytes in all newly admitted text parts. Client-supplied `synthetic` flags do not bypass it. |
| `max_inline_data_bytes` | `10485760` | Maximum combined decoded bytes in newly admitted inline `data:` attachments. Encoded representation and metadata have derived fixed bounds. |
| `max_historical_part_bytes` | `131072` | Maximum UTF-8 bytes exposed from one historical text part during a compaction/recovery attempt. |
| `max_ledger_bytes` | `12288` | Maximum canonical recovery-ledger block size. |
| `max_summary_bytes` | `49152` | Maximum accepted summary size. In `json` mode it must leave at least 2048 bytes for the projection after the ledger and rendering overhead; `markdown` mode retains the legacy 1024-byte margin. |

For values OpenCode already exposes (`model`, `tail_turns`, `preserve_recent_tokens`, and `reserved_tokens`), precedence is explicit tuple option, existing OpenCode value, then plugin default. Other plugin limits use the explicit tuple option or plugin default. The configuration hook pins a dedicated model or removes that override in `selected` mode, sets temperature zero, and applies the selected compaction thresholds. The request hook validates and caps the actual per-compaction model in either mode while preserving an omitted temperature when the model declares that parameter unsupported. Existing explicit `compaction.auto` and `compaction.prune` values are preserved; absent values default to `true` and `false` respectively.

Safety-critical tuple values also have hard ceilings: `tail_turns=64`, `max_user_text_bytes=8388608`, `max_inline_data_bytes=67108864`, `max_historical_part_bytes=1048576`, `max_ledger_bytes=262144`, and `max_summary_bytes=1048576`. These ceilings keep a tuple from disabling the plugin's resource bounds.

## Runtime behavior

The plugin has five defensive stages:

1. Admission rejects oversized new user text, decoded inline data, or an oversized encoded data-URL representation and reports the measured and allowed byte counts. Data-URL metadata has a fixed 16 KiB ceiling. It recommends file references or smaller chunks; it never silently truncates a new request.
2. Compaction asks the OpenCode API for the newest 10,000 session messages plus todos, then applies smaller deterministic newest-first message, part, and collection budgets while building the ledger. If that recent window has no prior plugin-valid ledger, it follows at most 255 older 256-message cursor pages until it finds the newest older one or reaches the scan budget; the surrounding provider prose is never trusted. Overflow-replay matching uses the same paging contract and stops as soon as it has the two distinct durable requests needed for proof. Page order or durable creation time establishes chronology rather than caller-controlled Message IDs. Requests and constraints come only from eligible user text; assistant, synthetic, and ignored prose cannot become recovered intent. The fallback Goal chooses the newest substantive request instead of a terse acknowledgement such as `check` or `continue`; if every recovered request is terse, it uses an honest placeholder. Synthetic carry-over actions are not accumulated across ledgers. Touched paths come only from explicit patch/file artifacts, not arbitrary tool-input strings; they are normalized and short URL/API fragments are rejected. Credential-shaped values are redacted, and tool evidence hashes only a bounded source prefix rather than scanning or copying an unbounded output.
3. The compaction prompt asks for one strict JSON object with the required semantic fields and stable ledger references. Per-section item limits bound the response: constraints 16, decisions 16, current state 24, blockers 16, evidence 32, files 64, and next actions 16, each item at most 1,024 bytes with at most 8 references. The accepted response is rendered as Markdown with `Goal`, `Constraints`, `Decisions`, `Current state`, `Files`, `Evidence`, `Blockers/questions`, and `Next actions`, followed by a versioned projection block and the canonical SHA-256 recovery-ledger block. Stale projected next actions whose references no longer resolve on a later compaction are surfaced as bounded `[stale projected action]` blockers/questions anchored to the surviving goal instead of being silently dropped.
4. During an initial compaction in `selected` mode, the cloned provider history is left byte-for-byte unchanged so a provider may reuse its existing prompt-cache prefix; the bounded ledger and replacement instruction are appended as the new compaction request. Recovery and overflow replay histories are redacted and byte-bounded; dedicated-model compactions also use the safer transformed history because they cannot reuse the ordinary model's cache. Reasoning is converted to unsigned text; credential-keyed tool input values, outputs, errors, state metadata, and attachments are redacted or bounded; inline and external attachments are replaced by metadata-only omission markers. Bounded opaque provider continuation metadata is preserved because same-model Gemini and similar providers require its signatures to replay tool calls. Malformed historical data URLs cannot abort compaction. Normal turns are left byte-for-byte unchanged.
5. Every targeted nonempty compaction text is replaced with the exact deterministic summary derived from the canonical ledger. Auto-continuation re-loads durable history, binds to the precise core compaction parent, and permits continuation only when that exact summary and ledger still match. An earlier plugin's disabled setting is preserved.

The plugin stores only bounded attempt metadata in process memory, keyed by the full Session ID, with a 30-minute TTL and a 128-attempt cap. Idle can retain a small recovery-complete tombstone until expiry so later turns in the same process do not repeat recovery. After a restart there is no durable proof that clone-only recovery was seen, so the plugin conservatively reinjects bounded recovery context. Events remain cleanup/audit signals, not correctness gates.

Internal failures in the experimental compaction, history-transform, completion, and event hooks are contained at the plugin boundary. Before a summary is accepted, the plugin leaves the hook output unchanged so OpenCode can use its native behavior. Auto-continuation fails closed when durable summary validation cannot complete. A metadata-only warning identifies the hook, Session ID when available, and error class; it never includes the error message, stack, conversation content, ledger, todo, or tool output. Configuration errors, unsafe model-limit combinations, and oversized newly admitted requests remain deliberate failures because silently ignoring them would weaken the configured safety policy.

## Security and privacy

- The runtime plugin has no telemetry, external network client, or runtime dependency. Its OpenCode client calls read the active session and todo records from the host server.
- It creates no shadow transcript, sidecar recovery file, or external cache. Durable conversation history remains owned by OpenCode.
- Recovery content is bounded, credential-shaped values are redacted, and provider-authored legacy summary prose is omitted. A prior plugin-valid canonical ledger may be chained to retain bounded facts across repeated compactions; its provider-authored prose is never carried forward.
- Runtime logging contains metadata only. Contained internal failures warn with the hook, Session ID when available, and error class; conversation text, error messages and stacks, tool output, ledger bodies, and credentials are not logged.
- New oversized requests fail closed. Historical truncation affects only the cloned model-visible history used during recovery, not durable records.

The optional live eval adapters described below either spawn an installed OpenCode executable or make an explicit HTTP request to the configured evaluation endpoint. They are development tooling, are never imported by the runtime entry point, and use only the checked-in synthetic corpus.

## Limits

This plugin mitigates compaction failures; it cannot make OpenCode's core cutover atomic.

- Support is limited to the legacy V1 session compactor. V2 support is deferred until public V2 compaction hooks exist.
- Core still owns history head/tail selection, `tail_start_id`, boundary acceptance, durable replay, and cutover.
- A zero-text provider response emits no text-complete hook, so the plugin cannot insert a replacement summary. It suppresses ordinary auto-continuation and can rebuild recovery context on the next user turn.
- A split response can expose more than one text part. The first targeted part is replaced by one deterministic summary and later text parts are blanked.
- Overflow replay bypasses the normal auto-continue hook and remains in durable storage. The plugin can sanitize only the cloned provider-visible replay.
- Nonempty summaries without a valid plugin ledger are represented only by metadata-only `legacy_context` omission records. A prior plugin-valid canonical ledger can be chained as bounded input, but its surrounding provider-authored prose is neither copied nor trusted.
- Direct recovery facts are extracted from the newest 10,000 messages. Older plugin-valid ledgers remain discoverable across a bounded scan of up to 65,280 additional messages and can carry their already-bounded facts forward. Ordinary pre-plugin history outside those windows is not reprocessed, because V1 exposes neither metadata-only projection nor a response-byte limit.
- V1 pagination bounds message count, not serialized response bytes. The plugin validates page size, distinct and non-overlapping message identities, cursor reuse, the total page budget, and Session identity, but a single historical message with enormous parts can still make one host API response large; a strict response-byte cap requires a core/API change.
- Prompt-cache reuse is provider-dependent rather than guaranteed. `selected` mode preserves the initial history prefix, but OpenCode's model selection, provider cache TTL, cache-key rules, and provider-side normalization still determine whether tokens are actually cache-read.
- OpenCode core owns the automatic-compaction trigger threshold; the plugin applies the configured `auto`/`prune` policy and safe history budgets but cannot force a lower trigger cadence through the V1 plugin hooks.
- Pending todos remain in the canonical ledger across task switches because V1 exposes no authoritative task-abandonment signal. The summary bounds and orders them, but the plugin does not guess that an unfinished todo is safe to discard.
- During recovery, the model is explicitly asked to compare pending todos with the recent request thread and flag possible zombies by ID. That review is advisory only; the plugin never marks, deletes, or rewrites a todo from model judgment alone.
- Attempt state is process-local. This plugin does not implement clustered compaction ownership or crash-safe provider retries.

## Pi support

The package ships two pi extension entry points alongside the OpenCode V1 plugin. They are separate from the OpenCode runtime and are loaded by pi, not by OpenCode.

Install the repository as a Pi package to load both extensions automatically:

```sh
pi install git:github.com/shyba/opencode-better-compact-plugin@default
```

The package manifest points Pi at the TypeScript sources, so this works from a Git checkout without a checked-in `dist/` directory. For a one-off or source checkout, load either entry point explicitly with `pi -e /abs/path/to/src/pi.ts` or `pi -e /abs/path/to/src/cat.ts`. Built `dist/pi.js` and `dist/cat.js` entry points are also available after `bun run build`.

### `opencode-safe-compaction/pi` — recovery-ledger compaction

A pi extension that re-uses the same host-agnostic core (`ledger.ts`, `projection.ts`, `validation.ts`, `options.ts`) to do ledger-grounded compaction through pi's own events, with no OpenCode involvement.

Install the built module and load it as a pi extension:

```sh
pi -e /abs/path/to/dist/pi.js
```

or add it to `~/.pi/agent/settings.json` packages/extensions. The extension registers:

- `session_before_compact` — builds the bounded recovery ledger from the messages pi is about to summarize (plus the split-turn prefix), optionally chains a prior plugin-valid ledger found on the branch, asks the selected compaction model (or a pinned one) for the strict JSON projection, validates digest/refs, and returns either the rendered projection summary or the deterministic authoritative fallback. Any internal failure degrades to pi's default compaction.
- `session_before_tree` — the same pipeline for `/tree` branch summarization when the user opts into a summary.
- `/compaction-model` — pick a dedicated compaction model or "follow selected model". The choice is persisted to `<cwd>/.pi/safe-compaction.json` (mode `0600`, atomic rename).

Plugin-side options are read from `<cwd>/.pi/safe-compaction.json`:

```jsonc
{
  "model": "selected",
  "response_mode": "json",
  "tail_turns": 4,
  "max_output_tokens": 16384,
  "max_user_text_bytes": 524288,
  "max_inline_data_bytes": 10485760,
  "max_historical_part_bytes": 131072,
  "max_ledger_bytes": 12288,
  "max_summary_bytes": 49152
}
```

`model: "selected"` follows the model pi selects for the session; `provider/model` pins a dedicated compaction model. `preserve_recent_tokens` and `reserved_tokens` are not persisted here — pi manages its own recent-history budgets via `compaction.keepRecentTokens` / `compaction.reserveTokens`.

Todo recovery depends on a user-installed todo-tracking extension (e.g. the `todo` example). The adapter scans the branch for the most recent `todo`-tool result; with no such extension installed the ledger's todos section is empty.

Pi-specific limits:

- No admission hook for oversized input — pi rejects oversized messages at its own layer.
- No history-transform hook — sanitization runs inside the ledger build (input) and the rendered summary (output) only. The model-visible history pi sends to its own summarizer is untouched.
- Runs under both Bun-based and Node-based pi installs; under Node a minimal `node:crypto`-backed shim provides the `Bun.CryptoHasher` the shared core uses.

### `opencode-safe-compaction/cat` — attach files to context

A `/cat` slash command that attaches full file contents to the conversation, bypassing pi's bash-output truncation (pi truncates `!cmd` output at ~50 KiB and `!!cmd` excludes it from context entirely).

```
/cat <ext> [dir] [tokens]          shorthand: all <ext> files under dir (default .)
/cat <glob>... [tokens]            explicit globs: src/**/*.ts, 'src/**/*.{ts,tsx}'
```

Examples:

```
/cat .rs src                       all .rs files under src
/cat .md                           all .md files under cwd
/cat src/main.ts src/util.ts       two literal files
/cat 'src/**/*.ts' 80000           glob capped at 80k tokens
```

Behavior:

- Files are read in full (no truncation), wrapped in `<file:path>` markers, and injected as a single user message via `pi.sendUserMessage`. When the agent is streaming the message is queued as a follow-up.
- Before injecting, the projected token count (current usage from `ctx.getContextUsage()` plus `chars / 4` per character, the same heuristic pi uses) is compared against the model context window. If it would exceed `warnThreshold` (default `0.95`) of the window, the command refuses and lists the three largest files; run `/compact` first or re-run with a narrower pattern or a `[tokens]` budget.
- A trailing integer argument is a token budget: the read stops once cumulative estimates exceed it.
- A default skip list excludes `node_modules`, `.git`, `dist`, `build`, `out`, `target`, `vendor`, `__pycache__`, `.next`, `.nuxt`, `.turbo`, `.cache`, `.venv`, `venv`, `.idea`, `.vscode`, `.gradle`. Binary files, files over `maxFileBytes` (4 MiB), and results over `maxTotalBytes` (32 MiB) or `maxFileCount` (1000) are skipped with a marker.
- Settings live in `<cwd>/.pi/cat-files.json` (mode `0600`): `warnThreshold`, `unknownUsageFraction`, `charsPerToken`, `maxFileBytes`, `maxTotalBytes`, `maxFileCount`, `skipDirs`.

Token counts are approximate (`chars / 4`, matching pi's own estimator). Lower `charsPerToken` (e.g. `3.5`) or `warnThreshold` for pessimistic estimates. There is no confirmation dialog — the command either injects or refuses.

## Development and packaging

Run commands from this repository, not from an enclosing checkout:

```sh
bun install --frozen-lockfile
bun run typecheck
bun test
bun run build
bun -e 'await Promise.all([import("./dist/index.js"), import("./dist/tui.js"), import("./dist/pi.js"), import("./dist/cat.js")])'
npm pack --dry-run
```

`dist/` is deliberately untracked. `prepack` builds the server and TUI modules plus TypeScript declarations. The package includes the transactional configurator used by the selector and exposes `opencode-safe-compaction`, `opencode-safe-compaction/server`, `opencode-safe-compaction/tui`, `opencode-safe-compaction/pi`, and `opencode-safe-compaction/cat`; the root and server exports resolve to the server runtime, the TUI export contains only the selector, and the pi and cat exports are the pi extension entry points. Keep `private: true` until publication is explicitly approved.

For a portability smoke test, copy or clone the repository outside any OpenCode checkout, repeat install/build/test, and load either the absolute `runtime` directory or the packed artifact from an isolated OpenCode configuration. Nothing in source, tests, or eval tooling depends on the parent checkout.

## Evaluation

The `eval/` directory contains 30 sanitized, synthetic transcripts. The runner evaluates three repetitions per case under four separately implemented conditions:

- `baseline` uses a checked-in snapshot of the OpenCode 1.18.4 V1 compaction prompt. It is informational and does not import OpenCode core.
- `plugin` reproduces the deterministic fallback contract: whatever the model produced, the accepted text is the ledger-grounded authoritative summary, and continuation is gated on its structure and digest.
- `markdown` and `json` exercise the two projection contracts end to end: the model is prompted with the Markdown or JSON contract, its output is validated (including digest and stable references), and only a valid projection is accepted before any fallback.

Provider transport is a separate adapter shared by all conditions. The default fixture adapter is deterministic and deliberately cycles through valid, malformed, and refusal responses so the harness and fallback path can be tested offline. For the `json` condition the valid response is a ledger-referenced JSON projection. It is not evidence of model quality or live-provider performance.

```sh
# Offline harness/tests: 30 cases x 3 repetitions x 4 conditions
bun test eval

# Print the deterministic report
bun eval/run.ts --provider fixture --repetitions 3
```

The report includes structural validity, plugin digest validity, invalid/empty auto-continuations, exact normalized key-fact recall, and matches against each case's explicit unsupported-material-claim list. The structural/digest denominator contains nonempty accepted responses; zero-text responses are reported separately because the runtime text hook cannot replace them. The plugin gate requires 100% structure/digest validity after applicable fallback, zero invalid or empty auto-continuations, at least 95% key-fact recall, zero listed unsupported claims, and zero provider errors. The same requirements apply to the Markdown and JSON projection conditions in `projection_gates`.

The unsupported-claim metric is a closed, reproducible corpus check, not a general semantic hallucination judge. Review accepted summaries separately before treating a new provider/model as qualified.

To use the installed OpenCode executable and its existing provider authentication, run the CLI adapter. `SAFE_COMPACTION_EVAL_OPENCODE` may be an absolute executable path or a command available on `PATH`; the model must use OpenCode's `provider/model` form.

```sh
SAFE_COMPACTION_EVAL_OPENCODE="/absolute/path/to/opencode" \
SAFE_COMPACTION_EVAL_MODEL="opencode-go/glm-5.2" \
bun eval/run.ts --provider opencode-cli --repetitions 3
```

The adapter starts one non-interactive `opencode run --agent compaction` process per condition, case, and repetition, injects an evaluation-only `{"*":"deny"}` permission override for that agent, passes the tagged synthetic message sequence through stdin, and uses the selected model from the installed OpenCode configuration. A full 30-case, three-repetition comparison starts 360 isolated CLI runs and may consume provider quota. It strips ANSI presentation, normalizes line endings, removes the OpenCode assistant header, and preserves the complete requested baseline or plugin response from plain stdout so trailing material is validated. CLI stderr is consumed but never copied into the eval report or error log, avoiding accidental conversation-content logging.

Alternatively, run the same corpus directly against an OpenAI-compatible chat-completions endpoint:

```sh
SAFE_COMPACTION_EVAL_URL="https://provider.example/v1/chat/completions" \
SAFE_COMPACTION_EVAL_MODEL="provider-model-id" \
SAFE_COMPACTION_EVAL_API_KEY="..." \
bun eval/run.ts --provider openai-compatible --repetitions 3
```

No live-provider result is checked in or claimed by this repository. Record the provider, model, endpoint implementation, date, and raw aggregate report when running a qualification eval; never commit credentials or unsanitized transcripts.
