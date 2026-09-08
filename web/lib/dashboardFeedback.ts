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
  | { kind: "cautious_return"; title: string; body: string }
  | { kind: "stage2"; feedback: TodaysRehabFeedback };
