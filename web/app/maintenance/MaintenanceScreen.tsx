import { MAINTENANCE_COPY } from "@/lib/operatingMode";

// M3.1 — the neutral patient-facing unavailable experience (founder F5).
// Approved core copy only; no state, no actions, no clinical data.
export function MaintenanceScreen() {
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center px-4" data-testid="maintenance-screen">
      <main className="max-w-md text-center">
        <p className="text-lg font-bold text-teal-300">TenoTrainer</p>
        <h1 className="mt-4 text-xl font-semibold text-slate-50">{MAINTENANCE_COPY}</h1>
        <a href="/logout" className="mt-6 inline-flex min-h-11 items-center text-sm text-slate-400 hover:text-slate-200">
          Log out
        </a>
      </main>
    </div>
  );
}
