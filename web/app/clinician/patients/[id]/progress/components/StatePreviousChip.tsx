import { describeStateChange } from "@/lib/clinicianPatientProgress";

// "Did this just change, and from what?" — LOCKED purpose of the
// latest+previous history depth (Section 4 of the C3 brief). Four distinct
// cases: no previous interpretation at all, unchanged, changed (names what
// it changed from), or (defensively) present-but-identical resultState.
export function StatePreviousChip({ current, previous, previousLabel }: { current: string; previous: string | null; previousLabel: string | null }) {
  const change = describeStateChange(current, previous);

  if (change === "no_previous") {
    return <span className="text-xs text-gray-400">No previous interpretation</span>;
  }
  if (change === "unchanged") {
    return <span className="text-xs text-gray-400">Unchanged from previous</span>;
  }
  return <span className="text-xs text-gray-400">Changed from: {previousLabel ?? previous}</span>;
}
