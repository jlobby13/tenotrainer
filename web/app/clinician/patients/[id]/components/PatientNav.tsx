import Link from "next/link";

// Clinician patient navigation — plain server-rendered <Link> navigation
// between real routes, never client-side tab state.
//
// M1 (founder-locked D3): a C5 patient sees Overview | Program | Sessions |
// Safety; the legacy Progress / Review interpretation tabs are hidden for
// them (the pages themselves still exist until M4). A legacy-only patient
// keeps Overview | Progress | Review | Prescription, plus Safety — the
// professional-review clinician release applies to every patient (D2).
export type PatientTab = "overview" | "progress" | "review" | "prescription" | "sessions" | "safety";

export function PatientNav({ patientId, active, isC5 = false }: { patientId: string; active: PatientTab; isC5?: boolean }) {
  const tabClass = (tab: PatientTab) =>
    active === tab ? "text-sm font-medium text-brand-600 border-b-2 border-brand-600 pb-2" : "text-sm font-medium text-gray-500 hover:text-brand-600 pb-2";
  const base = `/clinician/patients/${patientId}`;
  const tabs: { tab: PatientTab; href: string; label: string }[] = isC5
    ? [
        { tab: "overview", href: base, label: "Overview" },
        { tab: "prescription", href: `${base}/prescription`, label: "Program" },
        { tab: "sessions", href: `${base}/sessions`, label: "Sessions" },
        { tab: "safety", href: `${base}/safety`, label: "Safety" },
      ]
    : [
        { tab: "overview", href: base, label: "Overview" },
        { tab: "progress", href: `${base}/progress`, label: "Progress" },
        { tab: "review", href: `${base}/review`, label: "Review" },
        { tab: "prescription", href: `${base}/prescription`, label: "Prescription" },
        { tab: "safety", href: `${base}/safety`, label: "Safety" },
      ];

  return (
    <div className="flex flex-wrap gap-x-6 gap-y-2 border-b border-gray-200" data-testid="patient-nav" data-c5-nav={isC5 ? "c5" : "legacy"}>
      {tabs.map((t) => (
        <Link key={t.tab} href={t.href} className={tabClass(t.tab)}>
          {t.label}
        </Link>
      ))}
    </div>
  );
}
