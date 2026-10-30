import Link from "next/link";
import { connection } from "next/server";
import { getSessionInfo } from "@/lib/auth";
import { getUnreadSafetyCount } from "@/lib/safetyNotificationsServer";

// M3.2 — clinician-wide safety notification entry point with the unread
// badge (unread = not yet opened; never "reviewed").
export async function SafetyNotificationsBar() {
  await connection();
  const session = await getSessionInfo();
  if (!session.user || !session.memberships.some((m) => m.role === "clinician" || m.role === "clinician_admin")) return null;
  const unread = await getUnreadSafetyCount(session.user.id);
  return (
    <div className="border-b border-gray-200 bg-white px-6 py-1.5 text-right text-sm">
      <Link href="/clinician/notifications" className="inline-flex items-center gap-2 font-medium text-gray-700 hover:text-brand-700" data-testid="safety-notifications-link">
        Safety notifications
        {unread > 0 && (
          <span className="rounded-full bg-red-600 px-2 py-0.5 text-xs font-semibold text-white" data-testid="safety-unread-badge" aria-label={`${unread} unread`}>
            {unread}
          </span>
        )}
      </Link>
    </div>
  );
}
