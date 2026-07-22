import type { EvalCase } from "../types.js"
import { transcriptMessages } from "./transcript.js"
import type { PreparedCondition } from "../types.js"

// Snapshot of the OpenCode V1 compaction contract used for the 1.18.4 comparison.
// It is kept here so the standalone eval never imports from a parent checkout.
export const BASELINE_PROMPT = `Create a new anchored summary from the conversation history.

Output exactly the Markdown structure shown inside <template> and keep the section order unchanged. Do not include the <template> tags in your response.
<template>
## Objective
- [one or two brief sentences describing what the user is trying to accomplish]

## Important Details
- [constraints/preferences, decisions and why, important facts/assumptions, exact context needed to continue, or "(none)"]

## Work State
### Completed
- [finished work, verified facts, or changes made; otherwise "(none)"]

### Active
- [current work, partial changes, or investigation state; otherwise "(none)"]

### Blocked
- [blockers, failing commands, or unknowns; otherwise "(none)"]

## Next Move
1. [immediate concrete action, or "(none)"]
2. [next action if known, or "(none)"]

## Relevant Files
- [file or directory path: why it matters, or "(none)"]
</template>

Rules:
- Keep every section, even when empty.
- Use terse bullets, not prose paragraphs.
- Preserve exact file paths, symbols, commands, error strings, URLs, and identifiers when known.
- Do not mention the summary process or that context was compacted.`

const headings = [
  "## Objective",
  "## Important Details",
  "## Work State",
  "### Completed",
  "### Active",
  "### Blocked",
  "## Next Move",
  "## Relevant Files",
]

export function prepareBaseline(test: EvalCase): PreparedCondition {
  return {
    messages: [...transcriptMessages(test), { role: "user", content: BASELINE_PROMPT }],
    finish(text) {
      const structuralValid = validBaseline(text)
      // V1 core accepts a nonempty provider summary without a structural validator.
      const autoContinue = Boolean(text.trim())
      return {
        acceptedText: text,
        structuralValid,
        digestValid: undefined,
        autoContinue,
        usedFallback: false,
        zeroText: !text.trim(),
      }
    },
  }
}

export function validBaseline(text: string) {
  const positions = headings.map((heading) => text.indexOf(heading))
  return Boolean(
    text.trim() &&
      positions.every((position) => position >= 0) &&
      positions.every((position, index) => index === 0 || position > positions[index - 1]!),
  )
}
