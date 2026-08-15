# Review v2 — compaction recovery quality (latest.json, 2026-08-04)

> Privacy: session content redacted (paths, requests, tool errors). Counts and
> generic category descriptions preserved. Stable `<todo:HASH>` style used for
> references that need persistence across summaries.

Re-review after upstream shipped three fixes derived from `aidocs/struggles.md`
/ `aidocs/heuristics.md`. Verified against a fresh compaction in `latest.json`
(5 compactions; the just-now summary is the last one). The compaction still
feels like the old system in two specific ways, described below.

---

## What upstream shipped (commit audit)

| commit | claim | actually changes |
|---|---|---|
| `62a6614` improve recovery signal quality | Goal resolution, path de-noise, stale carryover drop | Adds `resolveGoal()` + `isTerseAcknowledgement()` in `src/validation.ts`; `Goal` slot walks past terse acks to the last substantive ask. Drops `Continue the newest request:` from `next_actions`. Adds `isRealPath()` + trailing-slash strip in `src/ledger.ts`. New `toolStatusLines()` collapses consecutive identical `tool: status` lines. |
| `b16e419` review stale todos during recovery | H5 nudge | Appends a sentence to `recoveryContext` telling the next model to cross-check pending/in_progress todos against `recent_requests` before pruning. |
| `487264a` restore native compaction model selection | model picker | Unrelated to summary quality. |

All three ports of the research's recommendations landed — the v3 strategy
files (`tools/sa`, `research/summarize.py`) carry byte-for-byte the same logic
for the schema-safe subset.

## What still feels like the old system (verified)

### 1. Files section is still ~60/64 garbage

The `isRealPath` filter only catches single-segment, short paths. It filtered
**5 of 64** entries in the latest compaction. The other ~59 pass because they
have inner slashes, but they are not real files. Verified surviving categories:

| category | examples (redacted) | why isRealPath lets them through |
|---|---|---|
| URL fragments, no extension, inner slashes | `<api>/<v1>/<resource>`, `<api>/<v1>/<resource>.` | has inner slash → real |
| `/dev/*` pseudo-paths | `<dev>/<null>`, `<dev>/<tcp>/.../<port>` | has inner slash → real |
| truncated filenames | `.../<short_name_>` (trailing `_`), `.../<other_>` (trailing `_`) | has inner slash, no `.` |
| bare directory fragments | `<home>/<user>`, `<px-research>` | short single-segment, but slip past because... see below |
| legitimate real paths | `<repo>/.../<file>.py`, `<repo>/.../<file>.json` | has extension → real |

Note: the `<px-research>` and `<w/>` entries slipped through `isRealPath` —
`<px-research>` (10 chars, single segment, no inner slash) should have been
filtered by `length < 16`, but `compact()` truncates to 300 bytes before the
check, so the length test sees the raw length. Actually: `<px-research>` is
10 chars, `< 16` → should return False. It appears in the noise list because
the test caught it as length<16 noise. So this *is* filtered. Five entries
pass `isRealPath`'s filter test from a noise perspective: the 5 in the
`=== NOISE ===` block.

But the dominant noise (URL fragments, /dev/*, truncated names, bare dirs
with inner slashes) is the 59 entries my conservative filter explicitly
LET through. The filter is too conservative.

**Root cause:** `isRealPath` uses only two signals (inner slash, extension).
URL fragments with inner slashes, `/dev/*`, and truncated filenames all have
inner slashes and slip through.

**Architectural fix (recommended):** `touched_paths` should mean "files I
actually touched." Only `patch.files` and `file.filename`/`source.path` are
trustworthy sources. `forEachPath` scraping of arbitrary tool input should
NOT contribute to `touched_paths` — that field is the source of every URL
fragment and `/dev/*` entry. Removing or restricting that call site is the
single highest-leverage change.

### 2. Goal = `save?` (H1 fix is partial)

`TERSE_ACKNOWLEDGEMENTS` in `src/validation.ts` covers common acks but misses
common single-word imperatives that carry no task signal. Verified case in
the latest compaction: the user's last user-text was a single imperative (redacted),
`resolveGoal` returned it as the Goal because the verb isn't in the set.

The `isTerseAcknowledgement` helper already normalizes (lowercase, strip
trailing punctuation including `?`), so adding missing single words to the
set is a minimal, schema-safe fix. Recommended additions:

- `save`, `wait`, `load`, `next`, `ping`, `sure`, `fine`, `great`

A more durable rule: a goal with ≤ 3 words where every word is an
imperative/interjection (present in this expanded set) is terse. The current
rule has the right structure; it just needs a more complete word list.

### 3. `resolveGoal` fallback when every request is terse

Current code: `(requests.at(-1) ?? "").trim()` — returns the literal last
ack as the Goal. Better behaviors (pick one):

- Return `""` so the placeholder renders ("No recoverable user request was
  recorded.").
- Fall back to the most recent assistant-text intent (requires new ledger
  field, schema bump).

The first option is schema-safe and matches the "honest placeholder" pattern
already used elsewhere (e.g. `(none)` for empty sections).

## What works now (verified against latest.json)

- **Constraints**: 6 genuine standing directives from earlier user messages,
  captured correctly (regex-based extraction working — e.g. "Do not stop
  because of X", "Stop estimating task time", etc.). This is the biggest
  visible quality win vs the old system.
- **`next_actions`** no longer carries stale `Continue the newest request`
  lines. Latest summary's `next_actions` contains 2 substantive entries,
  neither starts with that prefix.
- **`toolStatusLines`** collapses consecutive identical `tool: status` lines.
  The Current state section is now bounded and readable instead of an
  unbounded tool tally.
- **`recoveryContext`** injects the stale-todos review instruction. The next
  model is told to cross-check pending todos against the goal before pruning.
- **Trailing-slash normalization** in `addBoundedPath` works.

## Recommendations (priority order)

### P1 — stop trusting `forEachPath` for `touched_paths`
**Why.** Single source of the wall-of-noise Files section. `forEachPath`
scrapes arbitrary tool input for slash-prefixed tokens and feeds them as if
they were files. That is not what `touched_paths` means.

**How.** In `src/ledger.ts` `buildRecoveryLedger`, either:
- Remove the `forEachPath(...)` call that adds to `touchedPaths`, OR
- Restrict it to accept only paths that appear in tool `state.title` or in
  fields explicitly associated with file artifacts.

**Expected.** Files section drops from ~60 noise entries to ~5–10 real
entries. The user-facing Files section becomes useful for the first time.

### P2 — expand `TERSE_ACKNOWLEDGEMENTS`
**Why.** Goal slot leaks any single-word imperative not in the curated set.

**How.** Add `save`, `wait`, `load`, `next`, `ping`, `sure`, `fine`,
`great` to the set in `src/validation.ts`.

**Expected.** Goal slot resolves to a substantive ask even when the last
user-text is a bare imperative.

### P3 — Goal fallback when all requests are terse
**Why.** When every recorded request is an ack, the literal last ack should
not become the Goal.

**How.** Change the fallback to return `""` so the placeholder renders.

**Expected.** Honest "no recoverable goal" placeholder appears; the next model
isn't misled by a terse fragment.

### P4 — `toolStatusLines` extension
**Why.** The collapse helps, but the section can still surface running state
more semantically.

**How.** Group by tool, surface running PIDs / "process died" / "build ok"
explicitly. Lower priority than P1–P3.

### Deferred (require ledger schema bump)
- Storing `last_assistant_text` in the ledger for back-to-back Goal fallback
  and held-out fidelity.
- New "current task" / "context" sections.

## Test coverage gap

Upstream tests pass against synthetic fixtures with paths like
`/repo/file-00000` that look file-shaped. Against real sessions, the Files
section degrades because:

1. Synthetic fixtures don't exercise `forEachPath`'s URL/JSON fragment output.
2. `TERSE_ACKNOWLEDGEMENTS` isn't tested against real-world single-word
   imperatives.

**Recommendation:** add a regression test using a captured session.json (or
the harness corpus at `tools/sa`) with real-world tool output patterns.
This is a single-file test change that locks in the P1 + P2 fixes against
real input.

## Cross-reference

- Original problem statements: `aidocs/issues.md`
- Quantitative heuristics (H1–H9): `aidocs/heuristics.md`
- Struggle catalog (A1–A5, model-switch signal): `aidocs/struggles.md`
- Autonomous research loop (how the v3 strategy was derived):
  `research/program.md` + `research/results.tsv`
- This review was written because no SSH key is available on the reviewer
  machine to commit the fixes inline.