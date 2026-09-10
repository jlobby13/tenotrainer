// Acute Safety Gate milestone — the dashboard-level wrapper around Stage 2's
// TodaysRehabFeedback. Kept as a SEPARATE type (not merged into
// TodaysRehabFeedback/computeTodaysRehabFeedback, which remain untouched)
// so Stage 2's own pure logic and its full test suite stay exactly as
// founder-approved. This wrapper only decides PRECEDENCE: an active acute
// brake, or a just-released cautious-return moment, both supersede ordinary
// Stage 2 feedback entirely (Section 14) — see
// web/lib/todaysRehabFeedbackServer.ts for where that precedence is
// actually decided.

import type { BrakeDisplayState } from "./acuteSafety";
import type { TodaysRehabFeedback } from "./todaysRehabFeedback";

export type DashboardFeedback =
  | { kind: "acute_brake"; display: BrakeDisplayState }
  // Stage 4 founder-acceptance fix: an outstanding M4 morning-response
  // obligation blocks new session creation just as authoritatively as an
  // acute brake does (Section 12/29 precedence: acute > unresolved morning
  // response > ordinary feedback > normal session start) — the dashboard
  // must not show a normal Start Rehab CTA the server would immediately
  // reject with MORNING_RESPONSE_REQUIRED. MorningResponsePendingNotice
  // already tells the patient what to do next; this kind only suppresses
  // the contradictory CTA underneath it.
  | { kind: "morning_response_pending" }
  | { kind: "cautious_return"; title: string; body: string }
  | { kind: "stage2"; feedback: TodaysRehabFeedback };
