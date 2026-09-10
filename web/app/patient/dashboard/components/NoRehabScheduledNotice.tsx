// Milestone 5, Stage 4 closure patch — shown in place of TodaysRehabPanel
// when getTodaysRehabDayEligibility() returns "not_scheduled" (Section 7 of
// the brief). Deliberately minimal: no invented rest-day recovery advice,
// no calendar, no "next session" prediction — just a calm factual
// statement. RecentResponseFeedback (rendered separately, above this) still
// carries whatever response context is currently relevant; this component
// only replaces the CTA/exercise-list panel itself.
export function NoRehabScheduledNotice() {
  return (
    <div className="bg-gray-50 border border-gray-200 rounded-xl p-6">
      <h2 className="text-base font-semibold text-gray-700 mb-1">No rehab scheduled today</h2>
      <p className="text-sm text-gray-500">Nothing is prescribed for today. Your next scheduled rehab session will appear here when it's due.</p>
    </div>
  );
}
