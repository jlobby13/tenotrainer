import type { ProgramNotice } from "@/lib/programNoticesServer";
import { dismissProgramNoticeAction } from "../actions";

// M2 — calm, factual program notices (fixed copy per notification type).
export function C5ProgramNotices({ notices }: { notices: ProgramNotice[] }) {
  if (notices.length === 0) return null;
  return (
    <div className="mt-4 space-y-2" data-testid="program-notices">
      {notices.map((n) => (
        <div key={n.id} className="flex items-start justify-between gap-3 rounded-2xl border border-slate-700 bg-slate-900/60 px-5 py-3" data-testid="program-notice" data-type={n.type}>
          <div className="text-sm">
            <p className="text-slate-200">{n.message}</p>
            <p className="mt-0.5 text-xs text-slate-500">
              {new Date(n.createdAt).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}
            </p>
          </div>
          <form action={dismissProgramNoticeAction}>
            <input type="hidden" name="noticeId" value={n.id} />
            <button type="submit" className="min-h-11 shrink-0 text-sm font-medium text-teal-300 hover:text-teal-200" data-testid="dismiss-notice">
              Dismiss
            </button>
          </form>
        </div>
      ))}
    </div>
  );
}
