import "server-only";

// C5.3 — the approved structured error model (C5.3A §25, locked in C5.3B
// Part O). Every draft/publish/pause/resume operation throws exactly one
// of these — never a raw SQL/Postgres error message to a caller. Server
// logs may retain non-secret diagnostic detail; clients only ever see
// `code`.
export const PRESCRIPTION_DRAFT_ERROR_CODES = [
  "UNAUTHENTICATED",
  "CLINICIAN_ROLE_REQUIRED",
  "PATIENT_NOT_AUTHORIZED",
  "DRAFT_ALREADY_EXISTS",
  "DRAFT_NOT_FOUND",
  "DRAFT_NOT_OWNED_BY_CALLER",
  "DRAFT_STALE_BASE",
  "VALIDATION_FAILED",
  "EXERCISE_UNAVAILABLE",
  "TEMPLATE_UNAVAILABLE",
  "PUBLISH_DISABLED",
  "PRESCRIPTION_ALREADY_PAUSED",
  "PRESCRIPTION_ALREADY_ACTIVE",
  "INTERNAL_ERROR",
] as const;

export type PrescriptionDraftErrorCode = (typeof PRESCRIPTION_DRAFT_ERROR_CODES)[number];

export class PrescriptionDraftError extends Error {
  readonly code: PrescriptionDraftErrorCode;
  readonly details?: unknown;

  constructor(code: PrescriptionDraftErrorCode, message?: string, details?: unknown) {
    super(message ?? code);
    this.name = "PrescriptionDraftError";
    this.code = code;
    this.details = details;
  }
}

// Maps a Postgres RPC error (RAISE EXCEPTION '<CODE>' USING ERRCODE='P0001')
// onto a structured error. `EXERCISE_UNAVAILABLE`/`VALIDATION_FAILED` are
// intentionally the same external shape regardless of the underlying rule
// that failed — never leaks which specific dosage/scheduling rule tripped
// beyond what validateDraft's own rule list already exposes on request.
export function mapRpcError(error: { message: string } | null | undefined): PrescriptionDraftError {
  const message = error?.message ?? "";
  const code = PRESCRIPTION_DRAFT_ERROR_CODES.find((candidate) => message.includes(candidate));
  if (!code) {
    console.error("prescriptionDraft RPC error (unmapped):", message);
  }
  return new PrescriptionDraftError(code ?? "INTERNAL_ERROR");
}
