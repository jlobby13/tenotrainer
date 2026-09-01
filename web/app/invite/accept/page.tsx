import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { validateInvitationToken } from "@/lib/invitations";
import {
  acceptInvitationNewUserAction,
  acceptInvitationExistingUserAction,
} from "./actions";

export const metadata = { title: "Accept Invitation — TenoTrainer" };

type Props = { searchParams: Promise<{ token?: string; error?: string }> };

export default async function AcceptInvitePage({ searchParams }: Props) {
  const { token, error } = await searchParams;

  if (!token) {
    return <InvalidPage reason="No invitation token was provided." />;
  }

  const validation = await validateInvitationToken(token);

  if (!validation.valid) {
    const messages: Record<string, string> = {
      not_found: "This invitation link is invalid or does not exist.",
      expired: "This invitation has expired. Please ask for a new one.",
      already_used: "This invitation has already been accepted.",
      cancelled: "This invitation has been cancelled.",
    };
    return <InvalidPage reason={messages[validation.reason] ?? "Invalid invitation."} />;
  }

  const { invitation } = validation;
  const orgName = invitation.organizations?.name ?? "an organization";

  // Check if the user is already signed in
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const isLoggedIn = !!user;
  const emailMatches = user?.email?.toLowerCase() === invitation.email.toLowerCase();

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <span className="text-3xl font-bold text-brand-600">TenoTrainer</span>
          <p className="text-sm text-gray-500 mt-1">Invitation</p>
        </div>

        <div className="bg-white rounded-xl shadow border border-gray-100 p-8">
          <h1 className="text-2xl font-bold text-gray-900 mb-1">You&apos;re invited</h1>
          <p className="text-sm text-gray-500 mb-6">
            Join <span className="font-medium text-gray-800">{orgName}</span> as a{" "}
            <span className="font-medium text-gray-800">
              {invitation.granted_role.replace(/_/g, " ")}
            </span>
            .
            <br />
            This invitation is for{" "}
            <span className="font-medium text-gray-800">{invitation.email}</span>.
          </p>

          {error && (
            <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-4 py-3 mb-5">
              {error}
            </div>
          )}

          {isLoggedIn && emailMatches ? (
            // Existing user — correct account logged in
            <form action={acceptInvitationExistingUserAction}>
              <input type="hidden" name="token" value={token} />
              <p className="text-sm text-gray-600 mb-4">
                You&apos;re already logged in as{" "}
                <span className="font-medium text-gray-900">{user.email}</span>. Click below to
                accept the invitation and join {orgName}.
              </p>
              <button
                type="submit"
                className="w-full py-2.5 bg-brand-600 text-white font-semibold rounded-lg hover:bg-brand-700 active:bg-brand-800 transition-colors"
              >
                Accept invitation
              </button>
            </form>
          ) : isLoggedIn && !emailMatches ? (
            // Wrong account
            <div className="bg-yellow-50 border border-yellow-200 text-yellow-800 text-sm rounded-lg px-4 py-4">
              <p className="font-medium mb-1">Wrong account</p>
              <p>
                You&apos;re logged in as <strong>{user.email}</strong>, but this invitation is for{" "}
                <strong>{invitation.email}</strong>.
              </p>
              <a href="/logout" className="mt-3 inline-block text-brand-600 font-medium hover:underline">
                Log out and switch accounts
              </a>
            </div>
          ) : (
            // Not logged in — show registration form
            <form action={acceptInvitationNewUserAction} className="space-y-4">
              <input type="hidden" name="token" value={token} />

              <div>
                <label htmlFor="name" className="block text-sm font-medium text-gray-700 mb-1">
                  Your name
                </label>
                <input
                  id="name"
                  name="name"
                  type="text"
                  required
                  autoFocus
                  autoComplete="name"
                  placeholder="Jane Smith"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-brand-400 focus:border-brand-400 focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
                <input
                  type="text"
                  disabled
                  value={invitation.email}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-gray-50 text-gray-500 cursor-not-allowed"
                />
              </div>

              <div>
                <label htmlFor="password" className="block text-sm font-medium text-gray-700 mb-1">
                  Create a password
                </label>
                <input
                  id="password"
                  name="password"
                  type="password"
                  required
                  minLength={8}
                  autoComplete="new-password"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-brand-400 focus:border-brand-400 focus:outline-none"
                />
                <p className="text-xs text-gray-400 mt-1">At least 8 characters.</p>
              </div>

              <button
                type="submit"
                className="w-full py-2.5 bg-brand-600 text-white font-semibold rounded-lg hover:bg-brand-700 active:bg-brand-800 transition-colors"
              >
                Create account &amp; join {orgName}
              </button>

              <p className="text-center text-xs text-gray-500">
                Already have an account?{" "}
                <a
                  href={`/login?next=${encodeURIComponent(`/invite/accept?token=${token}`)}`}
                  className="text-brand-600 font-medium hover:underline"
                >
                  Log in first
                </a>
              </p>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}

function InvalidPage({ reason }: { reason: string }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <span className="text-3xl font-bold text-brand-600">TenoTrainer</span>
        </div>
        <div className="bg-white rounded-xl shadow border border-gray-100 p-8 text-center">
          <h1 className="text-xl font-bold text-gray-900 mb-2">Invalid invitation</h1>
          <p className="text-sm text-gray-500">{reason}</p>
          <a href="/login" className="mt-5 inline-block text-brand-600 text-sm font-medium hover:underline">
            Back to login
          </a>
        </div>
      </div>
    </div>
  );
}
