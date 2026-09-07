import Link from "next/link";

const LEGACY_LINKS: { label: string; dest: string }[] = [
  { label: "Exercise Log", dest: "/exercise-log" },
  { label: "Assessment", dest: "/onboarding" },
  { label: "VISA-A", dest: "/visa-a" },
  { label: "Messages", dest: "/messages" },
  { label: "Profile", dest: "/profile" },
  { label: "Full Dashboard", dest: "/dashboard" },
];

const LINK_CLASSES =
  "px-3 py-2 rounded-lg border border-gray-200 text-sm text-gray-700 hover:border-brand-300 hover:text-brand-600 transition-colors text-center";

export function SecondaryLinks() {
  return (
    <div className="bg-white rounded-xl shadow border border-gray-100 p-6">
      <h2 className="text-sm font-semibold text-gray-900 mb-3">More</h2>
      <div className="grid grid-cols-2 gap-3">
        {/* Native Next.js page — a plain link, not the FastAPI bridge. */}
        <Link href="/patient/settings" className={LINK_CLASSES}>
          Settings
        </Link>
        {LEGACY_LINKS.map(({ label, dest }) => (
          <a
            key={dest}
            href={`/api/auth/launch-dashboard?dest=${encodeURIComponent(dest)}`}
            className={LINK_CLASSES}
          >
            {label}
          </a>
        ))}
      </div>
    </div>
  );
}
