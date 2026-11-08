import Link from "next/link";
import { isRecoveryTokenShape } from "@/lib/passwordRecovery";
import { verifyRecoveryAction } from "./actions";

export const metadata = { title: "Reset Password — TenoTrainer" };

type Props = { searchParams: Promise<{ token_hash?: string; type?: string; error?: string }> };

const ERROR_COPY: Record<string, string> = {
  invalid: "This password reset link is invalid or has expired. Links work once and expire after one hour.",
  rate_limited: "Too many attempts. Please wait a few minutes and try again.",
  error: "Something went wrong. Please request a new link.",
};

// M3.5 S4 — the recovery email's landing page. GET never verifies anything
// (email link scanners and prefetchers cannot spend the one-time token): it
// renders one button, and only its POST verifies. No `next` / redirect
// parameter is read.
export default async function ConfirmRecoveryPage({ searchParams }: Props) {
  const { token_hash: tokenHash, type, error } = await searchParams;
  const problem = error ? (ERROR_COPY[error] ?? ERROR_COPY.error) : !isRecoveryTokenShape(tokenHash, type) ? ERROR_COPY.invalid : null;

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <span className="text-3xl font-bold text-brand-600">TenoTrainer</span>
        </div>
        <div className="bg-white rounded-xl shadow border border-gray-100 p-8">
          <h1 className="text-2xl font-bold text-gray-900 mb-1">Reset your password</h1>
          {problem ? (
            <div data-testid="recovery-link-problem">
              <p className="text-sm text-gray-700 mt-4">{problem}</p>
              <Link href="/login/forgot" className="mt-6 inline-flex min-h-11 items-center text-sm font-medium text-brand-600 hover:underline">
                Request a new link
              </Link>
            </div>
          ) : (
            <form action={verifyRecoveryAction} className="mt-4">
              <input type="hidden" name="token_hash" value={tokenHash} />
              <input type="hidden" name="type" value="recovery" />
              <p className="text-sm text-gray-500 mb-6">Continue to choose a new password for your account.</p>
              <button
                type="submit"
                data-testid="confirm-recovery"
                className="w-full py-2.5 bg-brand-600 text-white font-semibold rounded-lg hover:bg-brand-700 active:bg-brand-800 transition-colors"
              >
                Set a new password
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
