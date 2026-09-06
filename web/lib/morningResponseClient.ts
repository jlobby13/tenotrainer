"use client";

// Thin fetch wrapper for the M4 Stage 2 morning-response API, mirroring
// rehabSessionClient.ts's shape/conventions exactly. All calls are
// idempotent-safe to retry: the server enforces "already submitted ->
// unchanged" for finalize, and checkpoint fields are a plain upsert of the
// caller's own row (ownership enforced by RLS, not by this client).

import type {
  ExternalLoadCategory,
  ExternalLoadTiming,
  MorningPainTolerability,
  MorningResponseRecord,
  StiffnessDuration,
  ToleranceEvaluationRecord,
} from "./morningResponseTypes";

export type MorningResponseCheckpoint = Partial<{
  nextMorningPain: number;
  nextMorningStiffness: number;
  stiffnessDuration: StiffnessDuration;
  morningPainTolerability: MorningPainTolerability;
  externalLoadCategories: ExternalLoadCategory[];
  externalLoadTiming: ExternalLoadTiming[];
  patientNote: string | null;
  finalize: boolean;
}>;

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) {
    const err = new Error(json.error || `Request to ${url} failed (${res.status})`) as Error & {
      missing?: string[];
      status?: number;
    };
    err.missing = json.missing;
    err.status = res.status;
    throw err;
  }
  return json as T;
}

export async function submitMorningResponseCheckpoint(
  morningResponseId: string,
  checkpoint: MorningResponseCheckpoint
): Promise<{ morningResponse: MorningResponseRecord; toleranceEvaluation: ToleranceEvaluationRecord | null }> {
  return postJson(`/api/patient/morning-response/${morningResponseId}`, checkpoint);
}
