"use client";

import { useEffect, useId, useState } from "react";
import { ALPHA1_AGREEMENT_CHECKBOX_LABEL, ALPHA1_AGREEMENT_VERSION } from "@/lib/alpha1Agreement";

// Alpha 1 — the acknowledgment checkbox and the submit button of a patient
// acceptance form. The checkbox is native, unchecked and `required` (the
// browser blocks an unticked submit even without JavaScript). Once hydrated,
// the button is also disabled until the box is ticked. The server re-checks
// both fields (checkAlpha1AgreementForm) — this is convenience, not
// enforcement.
export function AgreementAcceptControls({
  buttonLabel,
  buttonClassName,
  errorId,
}: {
  buttonLabel: string;
  buttonClassName: string;
  // The id of a visible agreement error on the page, if any.
  errorId?: string;
}) {
  const [checked, setChecked] = useState(false);
  // Server HTML (and no-JS clients) keep the button enabled and rely on
  // `required`; after hydration it is disabled until the box is ticked.
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  const noteId = useId();

  return (
    <div className="space-y-3">
      <input type="hidden" name="agreement_version" value={ALPHA1_AGREEMENT_VERSION} />
      <label className="flex min-h-11 cursor-pointer items-start gap-3 text-sm font-medium text-gray-900">
        <input
          type="checkbox"
          name="agreement"
          value="accepted"
          required
          checked={checked}
          onChange={(e) => setChecked(e.target.checked)}
          aria-invalid={errorId ? true : undefined}
          aria-describedby={errorId}
          data-testid="agreement-checkbox"
          className="mt-0.5 h-5 w-5 shrink-0 accent-brand-600"
        />
        <span>{ALPHA1_AGREEMENT_CHECKBOX_LABEL}</span>
      </label>
      {!checked && (
        <p id={noteId} className="text-xs text-gray-500" data-testid="agreement-note">
          Select the agreement checkbox above to continue.
        </p>
      )}
      <button
        type="submit"
        data-testid="accept-invitation"
        disabled={hydrated && !checked}
        aria-describedby={checked ? undefined : noteId}
        className={`${buttonClassName} disabled:cursor-not-allowed disabled:opacity-50`}
      >
        {buttonLabel}
      </button>
    </div>
  );
}
