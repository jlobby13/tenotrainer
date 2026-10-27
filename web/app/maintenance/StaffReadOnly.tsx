import { connection } from "next/server";
import { isMutationAllowed } from "@/lib/operatingMode";

// M3.1 — clinician / admin read-only state in maintenance mode. Records stay
// readable; every native form control below is disabled (a disabled
// fieldset). This is presentation only — every mutation is ALSO refused
// server-side (proxy, HTTP boundary, server actions, clinical libraries).
export async function StaffReadOnly({ children }: { children: React.ReactNode }) {
  // The mode is a runtime property: never evaluate it while prerendering.
  await connection();
  if (isMutationAllowed()) return <>{children}</>;
  return (
    <>
      <div className="sticky top-0 z-50 border-b border-amber-300 bg-amber-50 px-4 py-2 text-center text-sm font-medium text-amber-900" role="status" data-testid="maintenance-read-only-banner">
        Maintenance: TenoTrainer is read-only. Records can be viewed; no changes can be made.
      </div>
      <fieldset disabled className="contents" data-testid="maintenance-read-only">
        {children}
      </fieldset>
    </>
  );
}
