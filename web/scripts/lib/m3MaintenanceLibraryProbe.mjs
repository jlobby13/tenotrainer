// M3.1 — clinical-library maintenance boundary probe (test infrastructure).
// Imports the app's REAL server libraries in-process with
// TENOTRAINER_MODE=maintenance and calls every guarded mutation directly,
// bypassing the proxy, the HTTP boundary and server actions. Each must
// refuse with MaintenanceError before touching any database.
//
// It can never write: the Supabase client modules are replaced by inert
// stubs (m3ProbeStubHooks.mjs) whose every query resolves to a connection
// error without any network access, so even a missing guard could only fail
// (and would be reported as a FAIL, not a MAINTENANCE refusal). M3.3 S3:
// the configuration is the isolated test profile (reserved .test origin,
// the registered development project ref, unsigned placeholder keys) that
// the centralized contract requires of production/maintenance processes.
// Spawned by verifyM3OperatingModes.mjs; prints one JSON line.
import { register } from "node:module";
import { fakeKeysFor } from "./fakeSupabaseKeys.mjs";
import { RETIRED_CONFIG_NAMES } from "./harnessEnv.mjs";

register("./tsServerModuleHooks.mjs", import.meta.url);
register("./m3ProbeStubHooks.mjs", import.meta.url);

// argv[2] = mode under test (default maintenance; "production" is the negative control).
const PROBE_REF = "kpdxlzqtvueiytwjamiw"; // the registered development project (identity only — no client can connect)
process.env.TENOTRAINER_MODE = process.argv[2] ?? "maintenance";
process.env.NODE_ENV = "production";
process.env.SUPABASE_URL = `https://${PROBE_REF}.supabase.co`;
process.env.TENOTRAINER_SUPABASE_PROJECT_REF = PROBE_REF;
Object.assign(process.env, fakeKeysFor(PROBE_REF));
process.env.TENOTRAINER_APP_ORIGIN = "https://app.tenotrainer.test";
for (const k of ["FASTAPI_URL", "BRIDGE_SECRET", "VERCEL", "VERCEL_ENV", "ANTHROPIC_API_KEY", ...RETIRED_CONFIG_NAMES]) delete process.env[k];
// M3.2 — production / maintenance also require the safety email
// configuration (inert placeholders; nothing is ever sent here).
process.env.TENOTRAINER_EMAIL_PROVIDER = "resend";
process.env.SAFETY_DISPATCH_SECRET = "m32-probe-dispatch-secret-0123456789abcdef";
process.env.RESEND_API_KEY = "re_probe_never_called";
process.env.TENOTRAINER_NOTIFICATION_EMAIL_FROM = "TenoTrainer <safety@tenotrainer.test>";

const TARGETS = {
  "@/lib/prescriptionDraftServer": [
    "createDraft", "updateDraftMetadata", "addWorkout", "updateWorkout", "removeWorkout", "reorderWorkouts",
    "addExercise", "updateExercise", "removeExercise", "reorderExercises", "moveExercise", "updateDosage",
    "discardDraft", "publishDraft", "pausePrescription", "resumePrescription",
  ],
  "@/lib/clinicianSafetyServer": ["releaseAcuteEpisodeAsClinician"],
  "@/lib/acuteSafetyServer": ["submitReassessmentAndMaybeRelease"],
  "@/lib/patientInvitationServer": ["createPatientInvitation", "cancelPatientInvitation", "acceptPatientInvitation"],
  "@/lib/assignmentAdminServer": ["addAssignment", "endAssignment"],
  "@/lib/programNoticesServer": ["dismissProgramNotice"],
  "@/lib/canonicalExerciseLibraryServer": ["setExerciseFavorite"],
  "@/lib/c5RuntimeServer": ["recordFirstPerformance", "writePerformance", "closeSession", "recordRecoveryDecision", "getC5TrainingState"],
  "@/lib/c5ResponseServer": ["submitImmediateResponse", "submitMorningResponse"],
};

const results = [];
for (const [mod, names] of Object.entries(TARGETS)) {
  let m;
  try {
    m = await import(mod);
  } catch (e) {
    for (const n of names) results.push({ fn: `${mod}#${n}`, ok: false, detail: `import failed: ${e.message}` });
    continue;
  }
  for (const n of names) {
    const fn = m[n];
    if (typeof fn !== "function") {
      results.push({ fn: `${mod}#${n}`, ok: false, detail: "not exported" });
      continue;
    }
    const dummy = "00000000-0000-0000-0000-000000000000";
    try {
      const out = await fn({ clinicianId: dummy, patientId: dummy, draftId: dummy }, dummy, dummy, {});
      // getC5TrainingState is a read path: in maintenance it must NOT
      // reconcile (write) and reports the runtime unavailable instead.
      const ok = n === "getC5TrainingState" && out?.kind === "unavailable";
      results.push({ fn: `${mod}#${n}`, ok, detail: ok ? "no reconciliation write; unavailable" : `returned ${JSON.stringify(out)?.slice(0, 120)}` });
    } catch (e) {
      const ok = e?.code === "MAINTENANCE" || e?.name === "MaintenanceError";
      results.push({ fn: `${mod}#${n}`, ok, detail: ok ? "MaintenanceError" : `${e?.name}: ${e?.message}`.slice(0, 160) });
    }
  }
}
console.log(JSON.stringify(results));
