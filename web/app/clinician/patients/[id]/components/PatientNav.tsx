import Link from "next/link";

// C3 — simple clinician patient navigation between Overview (C2) and
// Progress (C3). LOCKED: plain server-rendered <Link> navigation between
// two real routes, never client-side tab state — matches this codebase's
// existing clinician-surface convention (no client JS anywhere in
// /clinician so far, even C2's expand/collapse uses native <details>).
export function PatientNav({ patientId, active }: { patientId: string; active: "overview" | "progress" }) {
  const tabClass = (tab: "overview" | "progress") =>
    active === tab ? "text-sm font-medium text-brand-600 border-b-2 border-brand-600 pb-2" : "text-sm font-medium text-gray-500 hover:text-brand-600 pb-2";

  return (
    <div className="flex gap-6 border-b border-gray-200">
      <Link href={`/clinician/patients/${patientId}`} className={tabClass("overview")}>
        Overview
      </Link>
      <Link href={`/clinician/patients/${patientId}/progress`} className={tabClass("progress")}>
        Progress
      </Link>
    </div>
  );
}
