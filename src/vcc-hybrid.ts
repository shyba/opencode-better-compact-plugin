import { sha256, utf8Bytes } from "./ledger.js"
import {
  VCC_PATCH_MAX_BYTES,
  canonicalSerialize,
  rehearseVccPatch,
  vccPatchBaseDigest,
  type VccPatchContext,
} from "./vcc.js"

export const VCC_HYBRID_DEFAULT_MAX_REQUEST_BYTES = 2 * 1_048_576

export type VccHybridRequest = {
  version: 1
  kind: "vcc_hybrid_patch_request"
  candidate_bytes: string
  candidate_digest: string
  docket_bytes: string
  docket_digest: string
  base_digest: string
  source_index: VccPatchContext["source_index"]
  authority: {
    instructions: string[]
    forbidden_actions: string[]
  }
}

export type VccHybridRequestEnvelope = {
  bytes: string
  digest: string
  base_digest: string
}

export type VccHybridResult = {
  accepted: boolean
  candidate_bytes: string
  candidate_digest: string
  patch_digest: string | null
  reason: string | null
  request_bytes?: string
  request_digest?: string
  selected_episode_ids: string[]
  warnings: string[]
}

export type VccHybridOptions = {
  request_patch: (request_bytes: string, signal?: AbortSignal) => Promise<unknown>
  signal?: AbortSignal
  max_request_bytes?: number
  max_response_bytes?: number
}

export function buildVccHybridRequest(context: VccPatchContext, max_request_bytes = VCC_HYBRID_DEFAULT_MAX_REQUEST_BYTES): VccHybridRequestEnvelope {
  validateCandidate(context)
  requirePositiveLimit(max_request_bytes, "max_request_bytes")
  const docket_digest = sha256(context.docket_bytes)
  const base_digest = vccPatchBaseDigest(context.candidate.bytes, context.docket_bytes)
  const request: VccHybridRequest = {
    version: 1,
    kind: "vcc_hybrid_patch_request",
    candidate_bytes: context.candidate.bytes,
    candidate_digest: context.candidate.digest,
    docket_bytes: context.docket_bytes,
    docket_digest,
    base_digest,
    source_index: context.source_index,
    authority: {
      instructions: [
        "Use only source-index references and source-backed evidence.",
        "Preserve protected candidate material and causal episode integrity.",
        "Suggest optional whole-episode ranking or source-backed warnings only.",
      ],
      forbidden_actions: [
        "completion_claim",
        "deletion",
        "durable_mutation",
        "cut_boundary",
        "pair_split",
        "provider_call",
      ],
    },
  }
  const bytes = canonicalSerialize(request)
  if (utf8Bytes(bytes) > max_request_bytes) throw new RangeError("hybrid patch request exceeds byte bound")
  return { bytes, digest: sha256(bytes), base_digest }
}

export async function requestVccHybridPatch(context: VccPatchContext, options: VccHybridOptions): Promise<VccHybridResult> {
  const fallback = (reason: string, request?: VccHybridRequestEnvelope): VccHybridResult => ({
    accepted: false,
    candidate_bytes: context.candidate.bytes,
    candidate_digest: sha256(context.candidate.bytes),
    patch_digest: null,
    reason,
    ...(request ? { request_bytes: request.bytes, request_digest: request.digest } : {}),
    selected_episode_ids: context.candidate.selected_episode_ids,
    warnings: [],
  })
  let request: VccHybridRequestEnvelope
  try {
    request = buildVccHybridRequest(context, options.max_request_bytes ?? VCC_HYBRID_DEFAULT_MAX_REQUEST_BYTES)
  } catch (error) {
    return fallback(error instanceof RangeError ? "request_oversized" : "invalid_candidate_context")
  }
  const max_response_bytes = options.max_response_bytes ?? VCC_PATCH_MAX_BYTES
  if (!Number.isSafeInteger(max_response_bytes) || max_response_bytes <= 0) return fallback("invalid_response_bound", request)
  if (options.signal?.aborted) return fallback("aborted", request)
  if (typeof options.request_patch !== "function") return fallback("invalid_request_boundary", request)
  let response: unknown
  try {
    response = await options.request_patch(request.bytes, options.signal)
  } catch {
    return fallback(options.signal?.aborted ? "aborted" : "request_failed", request)
  }
  if (options.signal?.aborted) return fallback("aborted", request)
  if (typeof response !== "string") return fallback(response === undefined ? "no_patch" : "non_text_response", request)
  if (utf8Bytes(response) > max_response_bytes) return fallback("response_oversized", request)
  const rehearsal = rehearseVccPatch(context, response)
  if (!rehearsal.accepted) return fallback("invalid_patch", request)
  return {
    accepted: true,
    candidate_bytes: rehearsal.candidate_bytes,
    candidate_digest: rehearsal.candidate_digest,
    patch_digest: rehearsal.patch_digest,
    reason: null,
    request_bytes: request.bytes,
    request_digest: request.digest,
    selected_episode_ids: rehearsal.selected_episode_ids,
    warnings: rehearsal.warnings,
  }
}

function validateCandidate(context: VccPatchContext) {
  if (typeof context.candidate.bytes !== "string" || sha256(context.candidate.bytes) !== context.candidate.digest) throw new Error("candidate digest mismatch")
  if (typeof context.docket_bytes !== "string") throw new TypeError("docket bytes must be text")
}

function requirePositiveLimit(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive safe integer`)
}
