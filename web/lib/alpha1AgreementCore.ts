// Alpha 1 — agreement hashing and the form check. Server code imports this
// through alpha1AgreementServer.ts; it has no "server-only" import so the
// unit tests can run it under plain Node.

import crypto from "crypto";
import { ALPHA1_AGREEMENT_VERSION, alpha1AgreementCanonicalText } from "./alpha1Agreement";

export function alpha1AgreementSha256(): string {
  return crypto.createHash("sha256").update(alpha1AgreementCanonicalText(), "utf8").digest("hex");
}

export type Alpha1AgreementCheck = { ok: true } | { ok: false; code: "agreement_required" | "agreement_updated" };

// The checkbox must be submitted with exactly the value "accepted" (an
// unchecked box submits nothing), and the version the page displayed must be
// the server's current version — a page opened before the agreement changed
// is refused rather than recorded against the new text.
export function checkAlpha1AgreementForm(formData: Pick<FormData, "get">): Alpha1AgreementCheck {
  if (formData.get("agreement") !== "accepted") return { ok: false, code: "agreement_required" };
  if (formData.get("agreement_version") !== ALPHA1_AGREEMENT_VERSION) return { ok: false, code: "agreement_updated" };
  return { ok: true };
}
