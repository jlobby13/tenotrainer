import Link from "next/link";

// C3/C4/C5.4A — simple clinician patient navigation between Overview (C2),
// Progress (C3), Review (C4), and Prescription (C5.4A). LOCKED: plain
// server-rendered <Link> navigation between real routes, never client-side
// tab state — matches this codebase's existing clinician-surface convention
// (no client JS anywhere in /clinician so far, even C2/C3's expand/collapse
// uses native <details>). The Prescription tab itself links into the C5.4A
// entry point, which is where any client-interactive builder UI begins —
// this nav bar stays server-rendered exactly as before.
export function PatientNav({ patientId, active }: { patientId: string; active: "overview" | "progress" | "review" | "prescription" }) {
  const tabClass = (tab: "overview" | "progress" | "review" | "prescription") =>
    active === tab ? "text-sm font-medium text-brand-600 border-b-2 border-brand-600 pb-2" : "text-sm font-medium text-gray-500 hover:text-brand-600 pb-2";

  return (
    <div className="flex gap-6 border-b border-gray-200">
      <Link href={`/clinician/patients/${patientId}`} className={tabClass("overview")}>
        Overview
      </Link>
      <Link href={`/clinician/patients/${patientId}/progress`} className={tabClass("progress")}>
        Progress
      </Link>
      <Link href={`/clinician/patients/${patientId}/review`} className={tabClass("review")}>
        Review
      </Link>
      <Link href={`/clinician/patients/${patientId}/prescription`} className={tabClass("prescription")}>
        Prescription
      </Link>
    </div>
  );
}
