import "server-only";

import { NextResponse } from "next/server";
import { requireClinicianAuthForRoute } from "@/lib/clinicianAuth";
import { openSafetyNotification } from "@/lib/safetyNotificationsServer";

// M3.2 — the opaque notification link (in-app and email). Identity comes
// only from the session; the database checks the row belongs to this user
// and that they are still eligible. read_at is recorded once, and never in
// maintenance mode. Destinations:
//   episode event      -> the patient's Safety page, at the episode anchor
//   acute-stop notice  -> the session it came from
//   fallback admin     -> a copy-only "no clinician assigned" state (no
//                         clinical detail, no access, no assignment link)
export async function GET(request: Request, { params }: { params: Promise<{ recipientId: string }> }) {
  const { recipientId } = await params;
  // A relative Location (RFC 7231) keeps the browser on the origin it used;
  // request.url may carry the server's configured host instead.
  const to = (path: string) => new NextResponse(null, { status: 303, headers: { Location: path } });
  const auth = await requireClinicianAuthForRoute();
  if (!auth.ok) {
    return auth.reason === "UNAUTHENTICATED"
      ? to(`/login?next=${encodeURIComponent(`/clinician/notifications/${recipientId}`)}`)
      : to("/dashboard");
  }
  const target = await openSafetyNotification(recipientId, auth.clinicianId);
  switch (target.kind) {
    case "patient_safety":
      return to(`/clinician/patients/${target.patientId}/safety#episode-${target.episodeId}`);
    case "patient_session":
      return to(`/clinician/patients/${target.patientId}/sessions/${target.sessionId}`);
    case "assign_clinician":
      return to(`/clinician/notifications/${recipientId}/assignment-required`);
    default:
      return to("/clinician/notifications?unavailable=1");
  }
}
