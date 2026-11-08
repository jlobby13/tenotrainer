import Link from "next/link";
import { connection } from "next/server";
import { getSessionInfo } from "@/lib/auth";
import { getUnreadSafetyCount } from "@/lib/safetyNotificationsServer";

// The shared staff bar (clinician, admin and super-user layouts): the
// Safety notifications link for clinician roles, and Log out for every
// signed-in staff user. Log out is a plain anchor, never next/link, so a
// prefetch can never end the session.
export async function SafetyNotificationsBar() {
  await connection();
  const session = await getSessionInfo();
  if (!session.user) return null;
  const clinician = session.memberships.some((m) => m.role === "clinician" || m.role === "clinician_admin");
  const unread = clinician ? await getUnreadSafetyCount(session.user.id) : 0;
  return (
    <div className="border-b border-gray-200 bg-white px-4 text-sm sm:px-6" data-testid="staff-bar">
      <div className="flex flex-wrap items-center justify-end gap-x-6">
        {clinician && (
          <Link href="/clinician/notifications" className="inline-flex min-h-11 items-center gap-2 font-medium text-gray-700 hover:text-brand-700" data-testid="safety-notifications-link">
            Safety notifications
            {unread > 0 && (
              <span className="rounded-full bg-red-600 px-2 py-0.5 text-xs font-semibold text-white" data-testid="safety-unread-badge" aria-label={`${unread} unread`}>
                {unread}
              </span>
            )}
          </Link>
        )}
        <a href="/account/password" className="inline-flex min-h-11 items-center font-medium text-gray-700 hover:text-brand-700" data-testid="staff-password-link">
          Password
        </a>
        <a href="/logout" className="inline-flex min-h-11 items-center font-medium text-gray-700 hover:text-brand-700" data-testid="staff-logout-link">
          Log out
        </a>
      </div>
    </div>
  );
}
