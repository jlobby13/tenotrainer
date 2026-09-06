"use client";

// Thin fetch wrappers for the Milestone 3 Next.js API routes
// (web/app/api/patient/rehab-session/**). Client-safe — no server-only
// import, since this is called from the M3 response-flow client components.
// All calls are idempotent-safe to retry: the server enforces uniqueness on
// sessionInstanceId/prescriptionInstanceId (create) and upserts set_outcomes
// (exercises-complete), and /response accepts partial, repeatable checkpoints.

import type {
  ContributorReason,
  Difficulty,
  RehabSessionRecord,
  SessionEventType,
} from "./rehabSessionTypes";
import type { MorningResponseRecord } from "./morningResponseTypes";

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

export async function createRehabSession(params: {
  sessionInstanceId: string;
  planId: string | null;
  prescriptionInstanceId: string;
  patientLocalDate: string;
  startedAt: string;
  prescriptionSnapshot: unknown;
}): Promise<{ session: RehabSessionRecord }> {
  return postJson("/api/patient/rehab-session", params);
}

export async function submitExercisesComplete(
  sessionId: string,
  params: {
    exerciseOutcome: "completed" | "ended_early" | "acute_terminated";
    earlyEndReason?: string | null;
    setOutcomes: Array<{
      exerciseId: string;
      exerciseOrderIndex: number;
      setIndex: number;
      outcome: "completed" | "skipped";
      prescribedReps: number | null;
      prescribedLoad: number | null;
      actualReps: number | null;
      actualLoad: number | null;
      wasEdited: boolean;
      occurredAt: string;
    }>;
    sessionEvents: Array<{
      exerciseId: string | null;
      setIndex: number | null;
      type: SessionEventType;
      note: string | null;
      occurredAt: string;
    }>;
  }
): Promise<{ session: RehabSessionRecord }> {
  return postJson(`/api/patient/rehab-session/${sessionId}/exercises-complete`, params);
}

export type ResponseCheckpoint = Partial<{
  peakSessionPain: number;
  difficulty: Difficulty;
  contributorReason: ContributorReason;
  contributorExerciseId: string;
  contributorOtherText: string;
  suddenOrSharpPain: boolean;
  newFunctionalDifficulty: boolean;
  popFeltOrHeard: boolean;
  finalize: boolean;
}>;

export async function submitResponseCheckpoint(
  sessionId: string,
  checkpoint: ResponseCheckpoint
): Promise<{ session: RehabSessionRecord; escalation?: { level: number; reason: string; ruleVersion: string } }> {
  return postJson(`/api/patient/rehab-session/${sessionId}/response`, checkpoint);
}

export async function getCurrentRehabSession(): Promise<{ session: RehabSessionRecord | null }> {
  const res = await fetch("/api/patient/rehab-session/current");
  if (!res.ok) throw new Error(`Failed to fetch current session (${res.status})`);
  return res.json();
}

// Date-independent — see the route's comment. Unlike getCurrentRehabSession,
// this specifically finds a lingering awaiting_morning_response session even
// if a newer, different-status session now exists.
export async function getPendingMorningResponseSession(): Promise<{
  session: RehabSessionRecord | null;
  morningResponse: MorningResponseRecord | null;
}> {
  const res = await fetch("/api/patient/rehab-session/pending-morning-response");
  if (!res.ok) throw new Error(`Failed to fetch pending morning-response session (${res.status})`);
  return res.json();
}
