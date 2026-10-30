import Link from "next/link";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { getSessionInfo, hasRole } from "@/lib/auth";
import { getSafetyHealth } from "@/lib/safetyNotificationsServer";

export const metadata = { title: "Safety notification health — TenoTrainer" };

// M3.2 (founder D7) — super-user-only operational health of the safety
// notification pipeline: counts, ages, codes and opaque ids only (no
// patient or clinician identity, no clinical content). External paging is
// M3.3; the production alert destination is M3.4.
function ts(v: unknown): string {
  return v ? `${new Date(v as string).toISOString().replace("T", " ").slice(0, 19)} UTC` : "never";
}

export default async function SafetyHealthPage() {
  await connection();
  const session = await getSessionInfo();
  if (!session.user) redirect("/login");
  if (!hasRole(session.memberships, "super_user")) redirect("/dashboard");
  const h = await getSafetyHealth();
  const v = (h.view ?? {}) as Record<string, unknown>;
  const metrics: [string, string, unknown][] = [
    ["pending_over_5m", "Email intents in flight for more than 5 minutes", h.pendingOver5Minutes],
    ["urgent_unaccepted_over_15m", "Urgent (Level 5) email with no provider acceptance after 15 minutes", h.urgentUnacceptedOver15Minutes],
    ["failed_permanent", "Permanently failed email, by tier", JSON.stringify(h.failedPermanentByTier)],
    ["outbox_by_status", "Email intents by status", JSON.stringify(h.outboxByStatus)],
    ["recipient_resolution_failures", "Notifications with failed recipient resolution", h.recipientResolutionFailures],
    ["repaired_by_hook", "Notification hook failures repaired by the sweep", h.repairedByHook],
    ["events_detected_by_sweep", "Events detected by the sweep (time-based or repair)", h.eventsDetectedBySweep],
    ["orphan_reconciliations", "Orphan safety facts reconciled by the sweep", h.orphanReconciliations],
    ["sweep_last_succeeded_at", "Last successful sweep", ts(v.sweep_last_succeeded_at)],
    ["dispatch_last_succeeded_at", "Last successful dispatch", ts(v.dispatch_last_succeeded_at)],
    ["dispatch_last_failed_at", "Last failed dispatch", ts(v.dispatch_last_failed_at)],
  ];
  return (
    <div className="min-h-screen bg-gray-50">
      <nav className="bg-white border-b border-gray-200 px-6 py-3 flex items-center justify-between">
        <span className="text-xl font-bold text-brand-600">TenoTrainer</span>
        <Link href="/super/dashboard" className="text-sm font-medium text-gray-600 hover:text-brand-700">Admin overview</Link>
      </nav>
      <main className="max-w-4xl mx-auto px-4 py-8 space-y-6">
        <h1 className="text-2xl font-bold text-gray-900">Safety notification health</h1>
        <div className="bg-white rounded-xl shadow border border-gray-100 overflow-hidden">
          <table className="w-full text-sm" data-testid="safety-health-metrics">
            <tbody>
              {metrics.map(([key, label, value]) => (
                <tr key={key} className="border-b border-gray-100 last:border-0" data-metric={key}>
                  <td className="px-4 py-2 text-gray-600">{label}</td>
                  <td className="px-4 py-2 font-mono text-gray-900" data-value>{String(value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="bg-white rounded-xl shadow border border-gray-100 p-4">
          <h2 className="text-sm font-semibold text-gray-900 mb-2">Open alerts ({h.openAlerts.length})</h2>
          {h.openAlerts.length === 0 ? (
            <p className="text-sm text-gray-500" data-testid="safety-health-no-alerts">No open alerts.</p>
          ) : (
            <ul className="space-y-1 text-xs font-mono text-gray-800" data-testid="safety-health-alerts">
              {h.openAlerts.map((a) => (
                <li key={`${a.kind}:${a.subject}`} data-alert-kind={a.kind}>
                  {a.kind} · {a.subject} · {a.code ?? "-"} · ×{a.occurrences} · since {ts(a.firstDetectedAt)}
                </li>
              ))}
            </ul>
          )}
        </div>
      </main>
    </div>
  );
}
