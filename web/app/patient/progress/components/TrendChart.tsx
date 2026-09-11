// Milestone 6, Stage 2 — a small, dependency-free 0-10 line chart.
//
// Renders ONLY the points it's given. Points are plotted at even horizontal
// spacing by array index (a simple category axis, matching the legacy
// FastAPI dashboard's own pain-trend chart precedent), never by a
// proportional date scale — but every point's real date is shown as its own
// label, so the actual date relationship stays fully inspectable. A line is
// drawn only between two consecutive KNOWN points; no point is invented for
// a date with no recorded value, and no shared axis is zero-filled.
//
// Server-rendered (no "use client"): plain SVG, no interactivity/state.

const WIDTH = 600;
const HEIGHT = 160;
const PAD_LEFT = 28;
const PAD_RIGHT = 12;
const PAD_TOP = 12;
const PAD_BOTTOM = 8;

export type TrendChartPoint = { date: string; value: number };

function formatShortDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function TrendChart({
  points,
  max = 10,
  color = "#0284c7",
  emptyMessage = "Not enough recorded data yet.",
}: {
  points: TrendChartPoint[];
  max?: number;
  color?: string;
  emptyMessage?: string;
}) {
  if (points.length === 0) {
    return <p className="text-sm text-gray-400 py-6 text-center">{emptyMessage}</p>;
  }

  const innerWidth = WIDTH - PAD_LEFT - PAD_RIGHT;
  const innerHeight = HEIGHT - PAD_TOP - PAD_BOTTOM;
  const xFor = (i: number) => (points.length === 1 ? PAD_LEFT + innerWidth / 2 : PAD_LEFT + (i / (points.length - 1)) * innerWidth);
  const yFor = (v: number) => PAD_TOP + innerHeight - (Math.max(0, Math.min(max, v)) / max) * innerHeight;

  const linePath = points.map((p, i) => `${i === 0 ? "M" : "L"} ${xFor(i).toFixed(1)} ${yFor(p.value).toFixed(1)}`).join(" ");

  return (
    <div>
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="w-full h-auto" role="img" aria-label="Symptom trend over time">
        {/* Gridlines at 0 / half / max — a fixed, honest scale reference, not a clinical threshold */}
        {[0, max / 2, max].map((v) => (
          <line
            key={v}
            x1={PAD_LEFT}
            x2={WIDTH - PAD_RIGHT}
            y1={yFor(v)}
            y2={yFor(v)}
            stroke="#e5e7eb"
            strokeWidth={1}
          />
        ))}
        <text x={2} y={yFor(max) + 4} fontSize={10} fill="#9ca3af">
          {max}
        </text>
        <text x={2} y={yFor(0) + 4} fontSize={10} fill="#9ca3af">
          0
        </text>

        <path d={linePath} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        {points.map((p, i) => (
          <circle key={`${p.date}-${i}`} cx={xFor(i)} cy={yFor(p.value)} r={3.5} fill={color} />
        ))}
      </svg>

      {/* Textual list — the same values as the chart, accessible and
          unambiguous regardless of point density. */}
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-gray-500">
        {points.map((p, i) => (
          <span key={`${p.date}-${i}`}>
            {formatShortDate(p.date)}: <span className="font-medium text-gray-700">{p.value}</span>
          </span>
        ))}
      </div>
    </div>
  );
}
