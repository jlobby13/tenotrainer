import Link from "next/link";
import { requestPasswordResetAction } from "./actions";

export const metadata = { title: "Reset Password — TenoTrainer" };

type Props = { searchParams: Promise<{ sent?: string }> };

// M3.5 S4 — password recovery request. One generic confirmation for every
// outcome (no account enumeration).
export default async function ForgotPasswordPage({ searchParams }: Props) {
  const { sent } = await searchParams;

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <span className="text-3xl font-bold text-brand-600">TenoTrainer</span>
        </div>

        <div className="bg-white rounded-xl shadow border border-gray-100 p-8">
          <h1 className="text-2xl font-bold text-gray-900 mb-1">Reset your password</h1>

          {sent === "1" ? (
            <div data-testid="recovery-requested">
              <p className="text-sm text-gray-700 mt-4">
                If an account exists for that email address, we&apos;ve sent a link to reset your password. The link
                works once and expires after one hour.
              </p>
              <p className="text-sm text-gray-500 mt-3">
                Didn&apos;t get an email? Check your spam folder, or wait a minute and try again.
              </p>
              <Link href="/login" className="mt-6 inline-flex min-h-11 items-center text-sm font-medium text-brand-600 hover:underline">
                Back to log in
              </Link>
            </div>
          ) : (
            <>
              <p className="text-sm text-gray-500 mb-6">
                Enter the email address you use for TenoTrainer and we&apos;ll send you a link to choose a new password.
              </p>
              <form action={requestPasswordResetAction} className="space-y-4">
                <div>
                  <label htmlFor="email" className="block text-sm font-medium text-gray-700 mb-1">
                    Email address
                  </label>
                  <input
                    id="email"
                    name="email"
                    type="email"
                    required
                    autoFocus
                    autoComplete="email"
                    maxLength={254}
                    className="w-full min-h-11 border border-gray-300 rounded-lg px-3 py-2 text-base focus:ring-2 focus:ring-brand-400 focus:border-brand-400 focus:outline-none"
                  />
                </div>
                <button
                  type="submit"
                  data-testid="request-recovery"
                  className="w-full py-2.5 bg-brand-600 text-white font-semibold rounded-lg hover:bg-brand-700 active:bg-brand-800 transition-colors"
                >
                  Send reset link
                </button>
              </form>
              <Link href="/login" className="mt-4 inline-flex min-h-11 items-center text-sm font-medium text-gray-600 hover:text-brand-600">
                Back to log in
              </Link>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
