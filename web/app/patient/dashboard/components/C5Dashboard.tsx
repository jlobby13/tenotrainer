import Link from "next/link";
import type { C5TrainingState } from "@/lib/c5RuntimeTypes";
import { C5PendingCheckInCard, C5SafetyHoldCard, C5TodaysRehabCard } from "./C5TodaysRehabCard";
import { C5WeeklyProgressLine } from "./C5RecoveryGuidance";
import { TimezoneInitializer } from "./TimezoneInitializer";
import { C5ProgramNotices } from "./C5ProgramNotices";
import type { ProgramNotice } from "@/lib/programNoticesServer";

// C5.6D — the patient dashboard when the gated C5 runtime serves this
// patient. Independent of the legacy FastAPI summary (no stage/irritability
// session_plan): Today's Rehab comes only from the authoritative C5 state.
export function C5Dashboard({
  email,
  firstName,
  state,
  pendingCheckIns,
  notices = [],
  pausedSafetyHold = null,
  upcomingMorning = null,
}: {
  email: string;
  firstName: string | null;
  state: C5TrainingState;
  // Outstanding (due) check-ins, from the patient's own obligation rows.
  pendingCheckIns: number;
  // M2 — unread program notices (paused / resumed / shared / updated).
  notices?: ProgramNotice[];
  // PEC — an open safety hold while paused (secondary; see getC5OpenSafetyHold).
  pausedSafetyHold?: { requiresClinicianRelease: boolean } | null;
  // PEC — "Morning check-in opens tomorrow at 7:00 AM." (informational).
  upcomingMorning?: string | null;
}) {
  const checkInCardShown = state.kind === "immediate_response_required" || state.kind === "morning_response_required";
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <TimezoneInitializer />
      <nav className="border-b border-slate-800 px-4 py-3 sm:px-6">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <span className="text-lg font-bold text-teal-300">TenoTrainer</span>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
            <Link href="/patient/progress" className="inline-flex min-h-11 items-center font-medium text-slate-300 hover:text-teal-300">
              Progress
            </Link>
            <Link href="/patient/settings" className="inline-flex min-h-11 items-center font-medium text-slate-300 hover:text-teal-300">
              Settings
            </Link>
            <span className="hidden truncate text-slate-500 sm:inline">{email}</span>
            <a href="/logout" className="inline-flex min-h-11 items-center font-medium text-slate-300 hover:text-teal-300">
              Log out
            </a>
          </div>
        </div>
      </nav>
      <main className="mx-auto max-w-5xl px-4 py-8 lg:py-10">
        <div className="max-w-2xl">
          <h1 className="text-2xl font-semibold text-slate-50">{firstName ? `Welcome back, ${firstName}` : "Welcome back"}</h1>
          <p className="mt-0.5 text-sm text-slate-400">{new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}</p>
          {/* The authoritative state card is always primary; everything
              below it is secondary information. */}
          <div className="mt-6">
            <C5TodaysRehabCard state={state} />
          </div>
          {pendingCheckIns > 0 && !checkInCardShown && (
            <div className="mt-4">
              <C5PendingCheckInCard count={pendingCheckIns} />
            </div>
          )}
          {state.kind === "prescription_paused" && pausedSafetyHold && (
            <div className="mt-4">
              <C5SafetyHoldCard requiresClinicianRelease={pausedSafetyHold.requiresClinicianRelease} />
            </div>
          )}
          {upcomingMorning && (
            <p className="mt-4 rounded-2xl border border-slate-800 bg-slate-900/60 px-5 py-3 text-sm text-slate-300" data-c5-upcoming-morning>
              {upcomingMorning}
            </p>
          )}
          {state.weekly && (
            <div className="mt-4 rounded-2xl border border-slate-800 bg-slate-900/60 px-5 py-3">
              <C5WeeklyProgressLine weekly={state.weekly} />
            </div>
          )}
          <C5ProgramNotices notices={notices} />
        </div>
      </main>
    </div>
  );
}
