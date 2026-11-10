import "server-only";

import { ALPHA1_AGREEMENT_KEY, ALPHA1_AGREEMENT_VERSION } from "./alpha1Agreement";
import { alpha1AgreementSha256 } from "./alpha1AgreementCore";

export { checkAlpha1AgreementForm, type Alpha1AgreementCheck } from "./alpha1AgreementCore";

// Alpha 1 — the server-controlled agreement identity passed to
// accept_patient_invitation_with_agreement. Never taken from the client:
// the key and version are constants and the hash is computed here from the
// constant text.
export function alpha1AgreementRecord(): { key: string; version: string; sha256: string } {
  return { key: ALPHA1_AGREEMENT_KEY, version: ALPHA1_AGREEMENT_VERSION, sha256: alpha1AgreementSha256() };
}
