"use client";

// C5.4D — publication timestamps in the VIEWER's timezone. Stored values stay
// canonical (UTC ISO strings); only presentation changes.
//
// The server cannot know the browser's timezone, so the server render (and
// the hydration pass, via useSyncExternalStore's server snapshot) shows an
// explicit, correct UTC fallback ("… UTC"). Immediately after hydration the
// client snapshot swaps in the local-time text. Because the two snapshots
// are declared separately, React treats the swap as expected rather than as
// a hydration mismatch. Formatting follows the app-wide "en-US" convention.

import { useSyncExternalStore } from "react";

const noopSubscribe = () => () => {};

const FORMATS = {
  datetime: { dateStyle: "medium", timeStyle: "short" },
  date: { dateStyle: "medium" },
} as const satisfies Record<string, Intl.DateTimeFormatOptions>;

function format(iso: string, style: keyof typeof FORMATS, timeZone?: string): string {
  return new Intl.DateTimeFormat("en-US", { ...FORMATS[style], timeZone }).format(new Date(iso));
}

export function LocalDateTime({ iso, style = "datetime" }: { iso: string; style?: keyof typeof FORMATS }) {
  const local = useSyncExternalStore(
    noopSubscribe,
    () => format(iso, style),
    () => null
  );
  return (
    <time dateTime={iso} data-testid="local-datetime" data-localized={local !== null ? "true" : "false"}>
      {local ?? `${format(iso, style, "UTC")} UTC`}
    </time>
  );
}
