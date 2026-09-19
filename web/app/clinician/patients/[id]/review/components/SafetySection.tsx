import { CLINICAL_REVIEW_ACTIVE_TITLE } from "@/lib/clinicianPatientReview";

// C4 — Safety section. LOCKED: reuses the exact C1B/C2/C3 "Clinical review
// active" terminology verbatim, never diagnoses, never exposes L3/L4/L5 as
// the primary label, never suppresses What Changed/Review Context below
// (they remain fully rendered regardless — see review/page.tsx), never
// resets/invalidates any M6 state. Renders nothing at all when no active
// episode exists — no empty-state placeholder, since an absent Safety
// section is itself already the (silent, restrained) "no active review"
// signal, consistent with C1B/C2/C3's own precedent of never rendering an
// acute badge when nothing is active.
export function SafetySection({ active }: { active: boolean }) {
  if (!active) return null;

  return (
    <section className="bg-red-50 border border-red-100 rounded-xl p-4">
      <h2 className="text-xs font-semibold text-red-700 uppercase tracking-wide mb-1">Safety</h2>
      <p className="text-base font-medium text-red-900">{CLINICAL_REVIEW_ACTIVE_TITLE}</p>
      <p className="text-sm text-red-700 mt-1">
        An active acute safety episode exists for this patient. The information below remains visible and unchanged.
      </p>
    </section>
  );
}
