"use client";

// C5.6D — browser wrappers for /api/patient/c5/**. A thrown C5NetworkError
// means "not known to be saved — safe to retry with the same payload / the
// same clientRequestId"; any returned `result` is the server's authoritative
// answer. The browser never decides lifecycle outcomes itself.

import type { C5PerformancePayload, C5SessionView, C5TrainingState, C5TrainingStatus } from "./c5RuntimeTypes";
import type { C5CheckIns, C5ImmediateResponseInput, C5MorningResponseInput, C5SubmitResult } from "./c5ResponseTypes";

export class C5NetworkError extends Error {
  constructor(message: string, readonly status: number | null) {
    super(message);
  }
}

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, headers: { "Content-Type": "application/json" }, cache: "no-store" });
  } catch {
    throw new C5NetworkError("network", null);
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // fallthrough
  }
  if (!res.ok) throw new C5NetworkError((body as { code?: string } | null)?.code ?? `HTTP ${res.status}`, res.status);
  return body as T;
}

export function fetchC5State(): Promise<{ state: C5TrainingState }> {
  return call("/api/patient/c5/state");
}

export type C5StartResult =
  | { result: "started"; replayed: boolean; session: C5SessionView }
  | { result: string; detail?: string; state: C5TrainingState };

export function startWithFirstPerformance(params: {
  clientRequestId: string;
  expectedVersionId: string;
  workoutId: string;
  performance: C5PerformancePayload;
  preStartSkips: { exercise_id: string; unit_index: number }[];
  sequenceChoice: "repeat_previous" | "advance_next" | null;
}): Promise<C5StartResult> {
  return call("/api/patient/c5/start", { method: "POST", body: JSON.stringify(params) });
}

export function writeUnit(sessionId: string, performance: C5PerformancePayload, edit: boolean): Promise<{ result: string; detail?: string; replayed?: boolean }> {
  return call(`/api/patient/c5/session/${sessionId}/performance`, { method: "POST", body: JSON.stringify({ performance, edit }) });
}

export type C5CloseResult = { result: string; trainingStatus?: C5TrainingStatus; replayed?: boolean };

export function finishSession(sessionId: string): Promise<C5CloseResult> {
  return call(`/api/patient/c5/session/${sessionId}/finish`, { method: "POST", body: "{}" });
}

export function stopSession(
  sessionId: string,
  acuteReport: { sudden_or_sharp_pain?: boolean; pop_felt_or_heard?: boolean; new_functional_difficulty?: boolean } | null
): Promise<C5CloseResult> {
  return call(`/api/patient/c5/session/${sessionId}/stop`, { method: "POST", body: JSON.stringify({ acuteReport }) });
}

export function fetchSessionView(sessionId: string): Promise<{ session: C5SessionView }> {
  return call(`/api/patient/c5/session/${sessionId}/view`);
}

// C5.6E — check-ins.
export function fetchCheckIns(): Promise<{ checkIns: C5CheckIns }> {
  return call("/api/patient/c5/check-ins");
}

export function submitImmediate(sessionId: string, response: C5ImmediateResponseInput): Promise<C5SubmitResult> {
  return call(`/api/patient/c5/check-ins/immediate/${sessionId}`, { method: "POST", body: JSON.stringify({ response }) });
}

export function submitMorning(sessionId: string, response: C5MorningResponseInput): Promise<C5SubmitResult> {
  return call(`/api/patient/c5/check-ins/morning/${sessionId}`, { method: "POST", body: JSON.stringify({ response }) });
}

// C5.6F — Take Recovery Day / Continue (advisory; never starts a session).
export function recordRecoveryDecision(
  clientRequestId: string,
  decision: "take_recovery_day" | "continue"
): Promise<{ result: string; replayed?: boolean; decision?: string; state: C5TrainingState }> {
  return call("/api/patient/c5/recovery-decision", { method: "POST", body: JSON.stringify({ clientRequestId, decision }) });
}
