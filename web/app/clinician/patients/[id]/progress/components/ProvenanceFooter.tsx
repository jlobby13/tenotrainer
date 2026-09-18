import { formatReasonCodeLabel } from "@/lib/clinicianPatientProgress";
import { formatLastSessionLabel } from "@/lib/clinicianRoster";
import type { ProvenanceView } from "@/lib/clinicianPatientProgressServer";

// Shared tail of every domain's "Why this interpretation?" panel: reason
// codes translated to clinician-readable text (never a raw enum), the
// actual session dates that contributed, prescription-version span, and
// heuristic NAMES only (never description/rationale/known_limitations —
// see clinicianPatientProgress.ts's header on why heuristic prose is never
// rendered in C3).
export function ProvenanceFooter({ provenance, now }: { provenance: ProvenanceView | null; now: Date }) {
  if (!provenance) return null;
  const sortedDates = [...provenance.rehabSessionDates].sort((a, b) => a.patientLocalDate.localeCompare(b.patientLocalDate));

  return (
    <div className="mt-3 pt-3 border-t border-gray-100 text-sm text-gray-600 space-y-2">
      {provenance.reasonCodes.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Notable factors</p>
          <ul className="list-disc list-inside space-y-0.5">
            {provenance.reasonCodes.map((code) => (
              <li key={code}>{formatReasonCodeLabel(code)}</li>
            ))}
          </ul>
        </div>
      )}
      {sortedDates.length > 0 && (
        <p>
          Based on {sortedDates.length} session{sortedDates.length === 1 ? "" : "s"}: {sortedDates.map((s) => formatLastSessionLabel(s.patientLocalDate, now)).join(", ")}
        </p>
      )}
      {provenance.prescriptionVersionIds.length > 0 && (
        <p>
          Spans {provenance.prescriptionVersionIds.length} prescription version{provenance.prescriptionVersionIds.length === 1 ? "" : "s"}.
        </p>
      )}
      {provenance.heuristicNames.length > 0 && <p className="text-gray-400">Rules applied: {provenance.heuristicNames.join(", ")}</p>}
    </div>
  );
}
