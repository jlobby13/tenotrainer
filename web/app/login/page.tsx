import { loginAction } from "./actions";
import { safeInternalPath } from "@/lib/safeRedirect";

export const metadata = { title: "Log In — TenoTrainer" };

type Props = { searchParams: Promise<{ error?: string; email?: string; next?: string; notice?: string }> };

// M3.5 S4 — fixed copy only: the `error` parameter is a code; unknown codes
// (or free text from an old/crafted link) show the generic message.
const LOGIN_ERROR_COPY: Record<string, string> = {
  invalid_credentials: "Invalid email or password.",
  rate_limited: "Too many sign-in attempts. Please wait 15 minutes and try again, or reset your password below.",
  unavailable: "We couldn't sign you in right now. Please try again shortly.",
  link_invalid: "That link is invalid or has expired. Please log in, or request a new link.",
  account_created: "Your account was created. Please log in to continue.",
};
const GENERIC_LOGIN_ERROR = "Something went wrong. Please try again.";

export default async function LoginPage({ searchParams }: Props) {
  const { error: errorCode, email, next, notice } = await searchParams;
  const error = errorCode ? (LOGIN_ERROR_COPY[errorCode] ?? GENERIC_LOGIN_ERROR) : null;

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-md">
        {/* Logo / brand */}
        <div className="text-center mb-8">
          <span className="text-3xl font-bold text-brand-600">TenoTrainer</span>
          <p className="text-sm text-gray-500 mt-1">Achilles tendinopathy rehabilitation</p>
        </div>

        <div className="bg-white rounded-xl shadow border border-gray-100 p-8">
          <h1 className="text-2xl font-bold text-gray-900 mb-1">Log in</h1>
          <p className="text-sm text-gray-500 mb-6">
            Access your rehab plan and progress tracking.
          </p>

          {notice === "invitation_required" && (
            <div className="bg-gray-50 border border-gray-200 text-gray-700 text-sm rounded-lg px-4 py-3 mb-5" data-testid="invitation-required">
              TenoTrainer currently requires an invitation. If you&apos;ve been invited, use the link in your invitation email.
            </div>
          )}

          {error && (
            <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-4 py-3 mb-5" data-testid="login-error" data-code={errorCode}>
              {error}
            </div>
          )}

          <form action={loginAction} className="space-y-4">
            <input type="hidden" name="next" value={safeInternalPath(next, "/dashboard")} />

            <div>
              <label
                htmlFor="email"
                className="block text-sm font-medium text-gray-700 mb-1"
              >
                Email address
              </label>
              <input
                id="email"
                name="email"
                type="email"
                defaultValue={email ?? ""}
                required
                autoFocus
                autoComplete="email"
                className="w-full min-h-11 border border-gray-300 rounded-lg px-3 py-2 text-base focus:ring-2 focus:ring-brand-400 focus:border-brand-400 focus:outline-none"
              />
            </div>

            <div>
              <label
                htmlFor="password"
                className="block text-sm font-medium text-gray-700 mb-1"
              >
                Password
              </label>
              <input
                id="password"
                name="password"
                type="password"
                required
                autoComplete="current-password"
                className="w-full min-h-11 border border-gray-300 rounded-lg px-3 py-2 text-base focus:ring-2 focus:ring-brand-400 focus:border-brand-400 focus:outline-none"
              />
            </div>

            <button
              type="submit"
              className="w-full py-2.5 bg-brand-600 text-white font-semibold rounded-lg hover:bg-brand-700 active:bg-brand-800 transition-colors"
            >
              Log in
            </button>
          </form>
          <div className="mt-4 text-center">
            <a href="/login/forgot" data-testid="forgot-password-link" className="inline-flex min-h-11 items-center text-sm font-medium text-brand-600 hover:underline">
              Forgot password?
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
