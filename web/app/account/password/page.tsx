import Link from "next/link";
import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { PASSWORD_MAX_BYTES, PASSWORD_MIN_LENGTH, PASSWORD_POLICY_COPY, PASSWORD_POLICY_HINT, type PasswordPolicyCode } from "@/lib/passwordPolicy";
import { updatePasswordAction } from "./actions";

export const metadata = { title: "Password — TenoTrainer" };

type Props = { searchParams: Promise<{ recovery?: string; updated?: string; error?: string }> };

const ERROR_COPY: Record<string, string> = {
  ...(PASSWORD_POLICY_COPY as Record<PasswordPolicyCode, string>),
  same_password: "Your new password must be different from your current one.",
  weak_password: "That password isn't strong enough. Please choose a longer or less common one.",
  rate_limited: "Too many password changes. Please wait an hour and try again.",
  reauthentication_needed: "For your security, please log out and back in (or use “Forgot password?”) before changing your password.",
  error: "Your password couldn't be changed. Please try again.",
};

// M3.5 S4 — choose a new password: after a recovery link (a fresh recovery
// session) or while signed in. Same page for patients and staff; afterwards
// /dashboard routes each role to its own home.
export default async function AccountPasswordPage({ searchParams }: Props) {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/account/password");

  const { recovery, updated, error } = await searchParams;
  const isRecovery = recovery === "1";
  const message = error ? (ERROR_COPY[error] ?? ERROR_COPY.error) : null;

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <span className="text-3xl font-bold text-brand-600">TenoTrainer</span>
        </div>
        <div className="bg-white rounded-xl shadow border border-gray-100 p-8">
          {updated === "1" ? (
            <div data-testid="password-updated">
              <h1 className="text-2xl font-bold text-gray-900 mb-1">Password updated</h1>
              <p className="text-sm text-gray-700 mt-4">
                Your new password is set. Any other devices signed in to your account have been signed out.
              </p>
              <Link href="/dashboard" data-testid="continue-after-password" className="mt-6 inline-flex min-h-11 items-center text-sm font-medium text-brand-600 hover:underline">
                Continue to TenoTrainer
              </Link>
            </div>
          ) : (
            <>
              <h1 className="text-2xl font-bold text-gray-900 mb-1">{isRecovery ? "Choose a new password" : "Change your password"}</h1>
              <p className="text-sm text-gray-500 mb-6">For {user.email}</p>
              {message && (
                <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-4 py-3 mb-5" data-testid="password-error" data-code={error}>
                  {message}
                </div>
              )}
              <form action={updatePasswordAction} className="space-y-4">
                {isRecovery && <input type="hidden" name="recovery" value="1" />}
                <div>
                  <label htmlFor="password" className="block text-sm font-medium text-gray-700 mb-1">
                    New password
                  </label>
                  <input
                    id="password"
                    name="password"
                    type="password"
                    required
                    minLength={PASSWORD_MIN_LENGTH}
                    maxLength={PASSWORD_MAX_BYTES}
                    autoComplete="new-password"
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-brand-400 focus:border-brand-400 focus:outline-none"
                  />
                  <p className="text-xs text-gray-400 mt-1">{PASSWORD_POLICY_HINT}</p>
                </div>
                <div>
                  <label htmlFor="confirm_password" className="block text-sm font-medium text-gray-700 mb-1">
                    Confirm new password
                  </label>
                  <input
                    id="confirm_password"
                    name="confirm_password"
                    type="password"
                    required
                    minLength={PASSWORD_MIN_LENGTH}
                    maxLength={PASSWORD_MAX_BYTES}
                    autoComplete="new-password"
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-brand-400 focus:border-brand-400 focus:outline-none"
                  />
                </div>
                <button
                  type="submit"
                  data-testid="save-password"
                  className="w-full py-2.5 bg-brand-600 text-white font-semibold rounded-lg hover:bg-brand-700 active:bg-brand-800 transition-colors"
                >
                  Save new password
                </button>
              </form>
              {!isRecovery && (
                <Link href="/dashboard" className="mt-4 inline-flex min-h-11 items-center text-sm font-medium text-gray-600 hover:text-brand-600">
                  Cancel
                </Link>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
