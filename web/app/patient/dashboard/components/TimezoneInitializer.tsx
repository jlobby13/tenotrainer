"use client";

import { useEffect } from "react";

const STORAGE_KEY = "tenotrainer.timezoneInitialized";

// Milestone 4, Stage 1 — minimal timezone INITIALIZATION, not a settings UI.
// Renders nothing. On mount, offers the browser's IANA timezone to the
// server exactly once; the server enforces "only if not already set" (see
// /api/patient/timezone), so this is safe to call redundantly — the
// localStorage guard just avoids a pointless repeat network call, it is not
// load-bearing for correctness. Intentional timezone editing/travel handling
// is deferred to a later stage.
export function TimezoneInitializer() {
  useEffect(() => {
    try {
      if (window.localStorage.getItem(STORAGE_KEY) === "true") return;
    } catch {
      // Storage unavailable — proceed anyway; the server-side write is idempotent regardless.
    }

    let timezone: string;
    try {
      timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
      return;
    }
    if (!timezone) return;

    fetch("/api/patient/timezone", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ timezone }),
    })
      .then(() => {
        try {
          window.localStorage.setItem(STORAGE_KEY, "true");
        } catch {
          // ignore
        }
      })
      .catch(() => {
        // Best-effort — a failure here just means we try again next mount.
      });
  }, []);

  return null;
}
