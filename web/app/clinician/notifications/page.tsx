import Link from "next/link";
import { requireClinicianAuth } from "@/lib/clinicianAuth";
import { getSafetyInbox, type SafetyInboxItem } from "@/lib/safetyNotificationsServer";
import { LEVEL4_REASON_LABELS } from "@/lib/clinicianC5";

export const metadata = { title: "Safety notifications — TenoTrainer" };

// M3.2 — clinician safety notification inbox. Process language first; the
// numeric level is secondary provenance. Only rows the clinician is
// CURRENTLY eligible for are listed (the database re-checks assignment /
// fallback authority on every read). Reading a notification is not a
// clinical review and never releases anything.
const REASON_LABELS: Record<string, string> = { ...LEVEL4_REASON_LABELS, professional_hold: "Professional review hold reported" };

function headline(item: SafetyInboxItem): string {
  if (item.basis === "fallback_clinician_admin") return "No clinician is currently assigned to this patient";
  if (item.subjectKind === "acute_stop_notice") return "Safety check-in outstanding after an acute stop";
  if (item.tier === "urgent_clinician_review") return "Urgent clinician review required";
  if (item.tier === "clinician_review") return "Clinician review required";
  return "Safety check-in pending";
}

function when(ts: string): string {
  return `${new Date(ts).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" })} UTC`;
}

function stateLabel(item: SafetyInboxItem): string {
  if (item.superseded) return "Replaced by a higher review";
  if (item.resolvedAt) return item.subjectKind === "acute_stop_notice" ? `Check-in submitted ${when(item.resolvedAt)}` : `Resolved ${when(item.resolvedAt)}`;
  return "Open";
}

function Item({ item }: { item: SafetyInboxItem }) {
  const urgent = item.tier === "urgent_clinician_review" && item.isOpen && item.basis !== "fallback_clinician_admin";
  const detail = item.basis !== "fallback_clinician_admin" && item.subjectKind === "episode_event"
    ? [
        ...(item.reviewReasons ?? []).map((r) => REASON_LABELS[r] ?? r),
        item.effectiveLevel ? `Level ${item.effectiveLevel}` : null,
      ].filter(Boolean).join(" · ")
    : "";
  return (
    <li data-testid="safety-notification" data-recipient={item.recipientId} data-unread={item.readAt ? "false" : "true"}
        data-open={item.isOpen ? "true" : "false"} data-kind={item.subjectKind} data-tier={item.tier ?? ""} data-basis={item.basis}>
      {/* A plain anchor, never <Link>: opening records read_at, so it must
          never be prefetched, and the full navigation keeps the episode
          anchor of the redirect. */}
      <a href={`/clinician/notifications/${item.recipientId}`}
            className={`block rounded-lg border px-4 py-3 hover:bg-gray-50 ${urgent ? "border-red-300 bg-red-50/40" : "border-gray-200 bg-white"}`}>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className={`text-sm ${item.readAt ? "font-medium text-gray-700" : "font-semibold text-gray-900"}`}>
            {!item.readAt && <span className="mr-2 inline-block h-2 w-2 rounded-full bg-brand-600 align-middle" aria-label="Unread" />}
            {headline(item)}
          </p>
          <p className="text-xs text-gray-500">{when(item.detectedAt)}</p>
        </div>
        <p className="mt-1 text-xs text-gray-500">
          <span data-testid="safety-notification-state">{stateLabel(item)}</span>
          {detail && <span> · {detail}</span>}
        </p>
      </a>
    </li>
  );
}

export default async function SafetyNotificationsPage() {
  const { clinicianId } = await requireClinicianAuth();
  const items = await getSafetyInbox(clinicianId);
  const groups = new Map<string, { name: string; items: SafetyInboxItem[] }>();
  for (const i of items) {
    const g = groups.get(i.patientId) ?? { name: i.patientName ?? "Patient", items: [] };
    g.items.push(i);
    groups.set(i.patientId, g);
  }
  // Patients with an open item first, then by newest activity.
  const ordered = [...groups.entries()].sort(([, a], [, b]) => {
    const ao = a.items.some((i) => i.isOpen) ? 1 : 0;
    const bo = b.items.some((i) => i.isOpen) ? 1 : 0;
    return bo - ao || b.items[0].detectedAt.localeCompare(a.items[0].detectedAt);
  });

  return (
    <div className="min-h-screen bg-gray-50">
      <nav className="bg-white border-b border-gray-200 px-6 py-3 flex items-center justify-between">
        <Link href="/clinician/dashboard" className="text-xl font-bold text-brand-600">TenoTrainer</Link>
        <Link href="/clinician/dashboard" className="text-sm font-medium text-gray-600 hover:text-brand-700">Patients</Link>
      </nav>
      <main className="max-w-3xl mx-auto px-4 py-8">
        <h1 className="text-2xl font-bold text-gray-900 mb-1">Safety notifications</h1>
        <p className="text-sm text-gray-500 mb-6">Safety updates for patients you are responsible for. Opening a notification does not record a clinical review.</p>
        {ordered.length === 0 ? (
          <div className="bg-white rounded-xl shadow border border-gray-100 p-6 text-center text-sm text-gray-500" data-testid="safety-inbox-empty">
            No safety notifications.
          </div>
        ) : (
          <div className="space-y-6" data-testid="safety-inbox">
            {ordered.map(([patientId, g]) => (
              <section key={patientId} data-testid="safety-inbox-patient" data-patient={patientId}>
                <h2 className="mb-2 text-sm font-semibold text-gray-900">{g.name}</h2>
                <ul className="space-y-2">{g.items.map((i) => <Item key={i.recipientId} item={i} />)}</ul>
              </section>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
