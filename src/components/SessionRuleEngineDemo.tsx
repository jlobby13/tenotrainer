"use client";

import { evaluateSessionTolerance, SessionReport, SignalResult } from "../engine/sessionRuleEngine";

// ---------------------------------------------------------------------------
// Mock test cases — exactly as defined in /specs/session-rule-engine.md
// ---------------------------------------------------------------------------

const TEST_CASES: { label: string; description: string; report: SessionReport }[] = [
  {
    label: "Test 1",
    description: "Perfect Tolerance",
    report: {
      prescribed: { sets: 4, allowedPain: 3 },
      completed: { sets: 4, completed: true, abandonedDueToPain: false },
      symptoms: {
        painDuring: 2,
        painAfter: 1,
        painLaterSameDay: 1,
        nextMorningPain: 1,
        nextMorningStiffness: 2,
        swellingIncrease: false,
        sharpPain: false,
        limpOrFunctionLoss: false,
      },
      baseline: { usualMorningPain: 1, usualMorningStiffness: 2 },
    },
  },
  {
    label: "Test 2",
    description: "Mild Increase Next Day",
    report: {
      prescribed: { sets: 4, allowedPain: 3 },
      completed: { sets: 4, completed: true, abandonedDueToPain: false },
      symptoms: {
        painDuring: 4,
        painAfter: 3,
        painLaterSameDay: 3,
        nextMorningPain: 2,
        nextMorningStiffness: 2,
        swellingIncrease: false,
        sharpPain: false,
        limpOrFunctionLoss: false,
      },
      baseline: { usualMorningPain: 1, usualMorningStiffness: 1 },
    },
  },
  {
    label: "Test 3",
    description: "Overload With Symptoms",
    report: {
      prescribed: { sets: 4, allowedPain: 3 },
      completed: { sets: 4, completed: true, abandonedDueToPain: false },
      symptoms: {
        painDuring: 6,
        painAfter: 5,
        painLaterSameDay: 4,
        nextMorningPain: 2,
        nextMorningStiffness: 2,
        swellingIncrease: false,
        sharpPain: false,
        limpOrFunctionLoss: false,
      },
      baseline: { usualMorningPain: 1, usualMorningStiffness: 1 },
    },
  },
  {
    label: "Test 4",
    description: "Aborted Due to Pain",
    report: {
      prescribed: { sets: 4, allowedPain: 3 },
      completed: { sets: 2, completed: false, abandonedDueToPain: true },
      symptoms: {
        painDuring: 7,
        painAfter: 6,
        painLaterSameDay: 5,
        nextMorningPain: 3,
        nextMorningStiffness: 3,
        swellingIncrease: false,
        sharpPain: false,
        limpOrFunctionLoss: false,
      },
      baseline: { usualMorningPain: 1, usualMorningStiffness: 1 },
    },
  },
  {
    label: "Test 5",
    description: "Overdosed, Minimal Symptoms",
    report: {
      prescribed: { sets: 4, allowedPain: 3 },
      completed: { sets: 6, completed: true, abandonedDueToPain: false },
      symptoms: {
        painDuring: 2,
        painAfter: 1,
        painLaterSameDay: 1,
        nextMorningPain: 1,
        nextMorningStiffness: 2,
        swellingIncrease: false,
        sharpPain: false,
        limpOrFunctionLoss: false,
      },
      baseline: { usualMorningPain: 1, usualMorningStiffness: 2 },
    },
  },
];

// ---------------------------------------------------------------------------
// Signal styling config
// ---------------------------------------------------------------------------

const SIGNAL_CONFIG: Record<
  SignalResult["signal"],
  {
    label: string;
    bg: string;
    border: string;
    badgeBg: string;
    badgeText: string;
    titleText: string;
    icon: string;
  }
> = {
  go: {
    label: "GO",
    bg: "bg-green-50",
    border: "border-green-300",
    badgeBg: "bg-green-600",
    badgeText: "text-white",
    titleText: "text-green-800",
    icon: "✓",
  },
  stay: {
    label: "STAY",
    bg: "bg-blue-50",
    border: "border-blue-300",
    badgeBg: "bg-blue-600",
    badgeText: "text-white",
    titleText: "text-blue-800",
    icon: "→",
  },
  caution: {
    label: "CAUTION",
    bg: "bg-yellow-50",
    border: "border-yellow-400",
    badgeBg: "bg-yellow-500",
    badgeText: "text-white",
    titleText: "text-yellow-800",
    icon: "⚠",
  },
  stop: {
    label: "STOP",
    bg: "bg-red-50",
    border: "border-red-400",
    badgeBg: "bg-red-600",
    badgeText: "text-white",
    titleText: "text-red-800",
    icon: "✕",
  },
};

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function DoseBar({
  prescribed,
  completed,
}: {
  prescribed: number;
  completed: number;
}) {
  const pct = Math.min(Math.round((completed / prescribed) * 100), 150);
  const overLimit = pct > 120;
  const underLimit = pct < 80;
  const barColor = overLimit
    ? "bg-yellow-400"
    : underLimit
    ? "bg-red-400"
    : "bg-green-400";

  return (
    <div>
      <div className="flex justify-between text-xs text-gray-500 mb-1">
        <span>Dose: {completed} / {prescribed} sets</span>
        <span className={overLimit || underLimit ? "font-bold text-yellow-700" : "text-gray-600"}>
          {pct}%
        </span>
      </div>
      <div className="w-full bg-gray-200 rounded-full h-2 relative overflow-hidden">
        <div
          className={`h-2 rounded-full transition-all ${barColor}`}
          style={{ width: `${Math.min(pct, 100)}%` }}
        />
        {/* 80% and 120% markers */}
        <div className="absolute top-0 h-full w-px bg-gray-400 opacity-60" style={{ left: "80%" }} />
        <div className="absolute top-0 h-full w-px bg-gray-400 opacity-60" style={{ left: "100%" }} />
      </div>
      <div className="flex justify-between text-[10px] text-gray-400 mt-0.5">
        <span>0</span>
        <span style={{ marginLeft: "calc(80% - 20px)" }}>80%</span>
        <span>120%+</span>
      </div>
    </div>
  );
}

function PainPill({ label, value, max = 10 }: { label: string; value: number; max?: number }) {
  const color =
    value >= 6 ? "bg-red-100 text-red-700" :
    value >= 4 ? "bg-yellow-100 text-yellow-700" :
    "bg-green-100 text-green-700";
  return (
    <div className={`flex items-center gap-1 px-2 py-1 rounded-lg text-xs ${color}`}>
      <span className="text-gray-500 font-normal">{label}</span>
      <span className="font-bold">{value}/{max}</span>
    </div>
  );
}

function FlagPill({ label, active }: { label: string; active: boolean }) {
  if (!active) return null;
  return (
    <span className="px-2 py-0.5 text-[11px] font-semibold bg-red-100 text-red-700 rounded-full">
      {label}
    </span>
  );
}

function ResultCard({
  testLabel,
  description,
  report,
  result,
}: {
  testLabel: string;
  description: string;
  report: SessionReport;
  result: SignalResult;
}) {
  const cfg = SIGNAL_CONFIG[result.signal];
  const { prescribed, completed, symptoms, baseline } = report;

  const nmPainChange = symptoms.nextMorningPain - baseline.usualMorningPain;
  const nmStiffChange = symptoms.nextMorningStiffness - baseline.usualMorningStiffness;

  return (
    <div className={`rounded-2xl border-2 ${cfg.border} ${cfg.bg} p-5 flex flex-col gap-4`}>

      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-0.5">
            {testLabel}
          </p>
          <h3 className={`text-base font-bold ${cfg.titleText}`}>{description}</h3>
        </div>
        <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full ${cfg.badgeBg} ${cfg.badgeText} text-sm font-black shrink-0 shadow-sm`}>
          <span>{cfg.icon}</span>
          <span>{cfg.label}</span>
        </div>
      </div>

      {/* Dose bar */}
      <DoseBar prescribed={prescribed.sets} completed={completed.sets} />

      {/* Symptom pills */}
      <div className="flex flex-wrap gap-2">
        <PainPill label="During" value={symptoms.painDuring} />
        <PainPill label="After" value={symptoms.painAfter} />
        <PainPill label="Next AM" value={symptoms.nextMorningPain} />
        <PainPill label="AM Δ" value={nmPainChange} />
        <PainPill label="Stiff Δ" value={nmStiffChange} />
        <FlagPill label="Sharp pain" active={symptoms.sharpPain} />
        <FlagPill label="Abandoned" active={completed.abandonedDueToPain} />
        <FlagPill label="Limp" active={symptoms.limpOrFunctionLoss} />
        <FlagPill label="Swelling" active={symptoms.swellingIncrease} />
      </div>

      {/* Divider */}
      <hr className="border-gray-200" />

      {/* Engine output */}
      <div className="space-y-2">
        <div>
          <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide mb-1">
            Reason
          </p>
          <p className={`text-sm font-medium ${cfg.titleText}`}>{result.reason}</p>
        </div>
        <div>
          <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide mb-1">
            Next Session Action
          </p>
          <p className="text-sm text-gray-700">{result.action}</p>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function SessionRuleEngineDemo() {
  const results = TEST_CASES.map((tc) => ({
    ...tc,
    result: evaluateSessionTolerance(tc.report),
  }));

  const signalCounts = results.reduce(
    (acc, r) => {
      acc[r.result.signal] = (acc[r.result.signal] ?? 0) + 1;
      return acc;
    },
    {} as Record<string, number>
  );

  return (
    <div className="min-h-screen bg-gray-50 py-10 px-4">
      <div className="max-w-5xl mx-auto">

        {/* Page header */}
        <div className="mb-8">
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-1">
            TenoTrainer — Deterministic Rule Engine
          </p>
          <h1 className="text-3xl font-black text-gray-900 mb-2">
            Session Tolerance Engine
          </h1>
          <p className="text-sm text-gray-500 max-w-2xl">
            Each card below feeds mock session data into{" "}
            <code className="bg-gray-100 px-1 py-0.5 rounded text-xs font-mono">
              evaluateSessionTolerance()
            </code>{" "}
            and displays the engine output. All decisions are deterministic — rule-based
            only, no AI inference.
          </p>
        </div>

        {/* Summary row */}
        <div className="grid grid-cols-4 gap-3 mb-8">
          {(["go", "stay", "caution", "stop"] as const).map((sig) => {
            const cfg = SIGNAL_CONFIG[sig];
            const count = signalCounts[sig] ?? 0;
            return (
              <div
                key={sig}
                className={`rounded-xl border ${cfg.border} ${cfg.bg} px-4 py-3 flex items-center gap-3`}
              >
                <span className={`text-xl font-black ${cfg.titleText}`}>{cfg.icon}</span>
                <div>
                  <p className={`text-xs font-bold uppercase ${cfg.titleText}`}>{cfg.label}</p>
                  <p className="text-2xl font-black text-gray-800">{count}</p>
                </div>
              </div>
            );
          })}
        </div>

        {/* Rule priority note */}
        <div className="bg-white border border-gray-200 rounded-xl px-5 py-4 mb-8 text-sm text-gray-600">
          <span className="font-semibold text-gray-800">Rule evaluation order: </span>
          <span className="text-red-600 font-semibold">STOP</span>
          <span className="mx-2 text-gray-400">→</span>
          <span className="text-yellow-600 font-semibold">CAUTION</span>
          <span className="mx-2 text-gray-400">→</span>
          <span className="text-green-600 font-semibold">GO</span>
          <span className="mx-2 text-gray-400">→</span>
          <span className="text-blue-600 font-semibold">STAY</span>
          <span className="text-gray-400 ml-2">(default)</span>
          <span className="ml-3 text-gray-400">— first match wins, no aggregation.</span>
        </div>

        {/* Test case cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          {results.map((tc) => (
            <ResultCard
              key={tc.label}
              testLabel={tc.label}
              description={tc.description}
              report={tc.report}
              result={tc.result}
            />
          ))}
        </div>

        {/* Footer note */}
        <p className="mt-8 text-xs text-center text-gray-400">
          Session tolerance signal only. Does not represent a progression decision.
          All clinical decisions must be reviewed by a qualified physiotherapist.
        </p>
      </div>
    </div>
  );
}
