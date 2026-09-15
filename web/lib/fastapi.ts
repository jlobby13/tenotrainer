import "server-only";

const FASTAPI_URL = process.env.FASTAPI_URL ?? "http://localhost:8000";
const BRIDGE_SECRET = process.env.BRIDGE_SECRET ?? "";

// Two distinct failure shapes a caller needs to tell apart — never surfaced
// with infrastructure detail (URL/port/status/body) to a patient; that
// detail is logged server-side only (see bridgeFetch) and never carried in
// these errors' own messages.
//
// Transport-level: the backend service itself could not be reached at all
// (connection refused, DNS failure, timeout) — nothing about the patient's
// own data or identity. This is the only case that is genuinely "temporary
// service unavailability" from the patient's point of view.
export class BackendUnavailableError extends Error {
  constructor() {
    super("Patient backend service is temporarily unavailable");
    this.name = "BackendUnavailableError";
  }
}

// The backend WAS reached and responded, but with a non-2xx status — a
// real application/data condition (unknown patient identity, malformed
// request, etc.), never a transient outage. Must never be presented to the
// patient as "try again shortly".
export class BackendApplicationError extends Error {
  readonly status: number;
  constructor(status: number) {
    super("Patient backend returned an application error");
    this.name = "BackendApplicationError";
    this.status = status;
  }
}

async function bridgeFetch<T>(path: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${FASTAPI_URL}${path}`, {
      headers: { Authorization: `Bearer ${BRIDGE_SECRET}` },
      cache: "no-store",
    });
  } catch (err) {
    // fetch() itself threw — a transport failure, never a data/identity
    // problem. Full detail (including the underlying URL) is logged here,
    // server-side only; the thrown error carries none of it.
    console.error(`Patient backend unreachable for ${path}:`, err);
    throw new BackendUnavailableError();
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error(`Patient backend returned ${res.status} for ${path}: ${body}`);
    throw new BackendApplicationError(res.status);
  }
  return res.json() as Promise<T>;
}

// ── Patient ──────────────────────────────────────────────────────────────────

export type RecentLog = {
  id: number;
  date: string;
  pain_during: number | null;
  pain_after: number | null;
  next_day_pain: number | null;
  morning_stiffness: number | null;
};

export type SessionExercise = {
  exercise: {
    ex_id: string;
    name: string;
    category: string;
    loading_profile: string | null;
    setup_instructions: string | null;
    execution_cues: string[];
    patient_facing_explanation: string | null;
  };
  reason: string;
  dosage: Record<string, unknown>;
};

export type PreviousPerformance = {
  sets: number | null;
  reps: string | number | null;
  load: number | null;
  date: string;
};

export type PatientSummary = {
  user: { id: number; name: string; email: string };
  has_plan: boolean;
  has_onboarding: boolean;
  current_plan: { id: number; stage: number; irritability: string; decision: string; created_at: string } | null;
  current_stage: number | null;
  current_irritability: string | null;
  session_plan: SessionExercise[];
  today_logged: boolean;
  recent_logs: RecentLog[];
  previous_performance: Record<string, PreviousPerformance | null>;
};

export async function getPatientSummary(email: string): Promise<PatientSummary> {
  return bridgeFetch(`/api/patient/summary?email=${encodeURIComponent(email)}`);
}

// ── Clinician ─────────────────────────────────────────────────────────────────

export type PatientRow = {
  id: number;
  name: string;
  email: string;
  status: "red" | "yellow" | "inactive" | "green";
  stage: number | null;
  irritability: string | null;
  last_session_date: string | null;
  sessions_28d: number;
  adherence_pct: number | null;
  alert_count: number;
  max_severity: string | null;
};

export type ClinicianPatients = { patients: PatientRow[] };

export async function getClinicianPatients(email: string): Promise<ClinicianPatients> {
  return bridgeFetch(`/api/clinician/patients?email=${encodeURIComponent(email)}`);
}

export type PatientAlert = {
  id: number;
  type: string;
  severity: string;
  message: string;
  created_at: string;
};

export type PatientDetail = {
  patient: PatientRow & { alerts: PatientAlert[] };
  current_plan: {
    stage: number;
    irritability: string;
    decision: string;
    created_at: string;
    exercises: unknown[];
  } | null;
  recent_logs: (RecentLog & { note: string | null })[];
};

export async function getPatientDetail(patientId: number, supervisorEmail: string): Promise<PatientDetail> {
  return bridgeFetch(
    `/api/clinician/patients/${patientId}?email=${encodeURIComponent(supervisorEmail)}`
  );
}

// ── Super ─────────────────────────────────────────────────────────────────────

export type SupervisorRow = {
  supabase_id: string | null;
  active_patients: number;
  total_patients: number;
  [key: string]: unknown;
};

export type SuperOverview = { supervisors: SupervisorRow[] };

export async function getSuperOverview(): Promise<SuperOverview> {
  return bridgeFetch("/api/super/overview");
}
