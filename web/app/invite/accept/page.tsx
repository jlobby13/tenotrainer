import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getInvitationPreview } from "@/lib/patientInvitationServer";
import {
  acceptInvitationNewUserAction,
  acceptInvitationExistingUserAction,
  acceptPatientInvitationNewUserAction,
  acceptPatientInvitationExistingUserAction,
} from "./actions";

export const metadata = { title: "Accept Invitation — TenoTrainer" };

type Props = { searchParams: Promise<{ token?: string; error?: string }> };

// Neutral copy for every refusal the server can return. Never echoes other
// accounts' addresses or anything about another organization.
const ERROR_COPY: Record<string, string> = {
  name_invalid: "Please enter your name (at least 2 characters).",
  password_invalid: "Your password must be at least 8 characters.",
  account_exists: "An account with this email already exists. Log in to accept the invitation.",
  account_failed: "Your account could not be created. Please try again.",
  wrong_account: "This invitation was sent to a different email address. Log out and sign in with the invited account.",
  staff_account: "This invitation is for a patient account. Staff accounts can't accept patient invitations.",
  other_organization:
    "Your account is already linked to a different clinic, so this invitation can't be accepted automatically. Please contact the clinic that invited you.",
  inviter_unavailable: "This invitation can no longer be accepted. Please ask your clinic for a new invitation.",
  expired: "This invitation has expired. Please ask your clinic for a new one.",
  cancelled: "This invitation has been cancelled.",
  already_used: "This invitation has already been accepted.",
  not_found: "This invitation link is invalid or does not exist.",
  invalid: "This invitation link is invalid or does not exist.",
  error: "Something went wrong. Please try again.",
};

const STATE_COPY: Record<string, string> = {
  not_found: ERROR_COPY.not_found,
  expired: ERROR_COPY.expired,
  already_used: ERROR_COPY.already_used,
  cancelled: ERROR_COPY.cancelled,
};

const STAFF_ROLES = new Set(["clinician", "clinician_admin", "super_user"]);

export default async function AcceptInvitePage({ searchParams }: Props) {
  const { token, error } = await searchParams;

  if (!token) {
    return <InvalidPage reason="No invitation token was provided." />;
  }

  const preview = await getInvitationPreview(token);
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!preview.valid) {
    // Same-user replay after a successful acceptance is a success, not an error.
    if (preview.reason === "already_used" && user && preview.invitation?.accepted_by === user.id) {
      const home = preview.invitation.invitation_type === "PATIENT" ? "/patient/dashboard" : "/dashboard";
      return (
        <Shell>
          <div data-testid="invite-state" data-state="already_accepted" className="text-center">
            <h1 className="text-xl font-bold text-gray-900 mb-2">Invitation accepted</h1>
            <p className="text-sm text-gray-500">You&apos;ve already accepted this invitation.</p>
            <a href={home} className="mt-5 inline-block text-brand-600 text-sm font-medium hover:underline">
              Continue to TenoTrainer
            </a>
          </div>
        </Shell>
      );
    }
    return <InvalidPage reason={STATE_COPY[preview.reason] ?? "Invalid invitation."} state={preview.reason} />;
  }

  const { invitation } = preview;
  const orgName = preview.organizationName ?? "your clinic";
  const isLoggedIn = !!user;
  const emailMatches = user?.email?.toLowerCase() === invitation.email.toLowerCase();
  const loginHref = `/login?next=${encodeURIComponent(`/invite/accept?token=${token}`)}`;
  const errorMessage = error ? (ERROR_COPY[error] ?? ERROR_COPY.error) : null;

  if (invitation.invitation_type === "PATIENT") {
    let isStaff = false;
    if (user && emailMatches) {
      const { data: memberships } = await supabase.from("organization_members").select("role").eq("user_id", user.id);
      isStaff = (memberships ?? []).some((m) => STAFF_ROLES.has(m.role as string));
    }
    return (
      <Shell>
        <div data-testid="patient-invitation">
          <h1 className="text-2xl font-bold text-gray-900 mb-2">You&apos;re invited</h1>
          <p className="text-sm text-gray-600 mb-1" data-testid="invite-inviter">
            <span className="font-medium text-gray-900">{preview.clinicianName ?? "Your clinician"}</span> at{" "}
            <span className="font-medium text-gray-900" data-testid="invite-organization">{orgName}</span> has invited you to TenoTrainer,
            where your rehabilitation program will be shared with you.
          </p>
          <p className="text-sm text-gray-500 mb-6">
            This invitation is for <span className="font-medium text-gray-800">{invitation.email}</span>.
          </p>

          {errorMessage && (
            <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-4 py-3 mb-5" data-testid="invite-error" data-error={error}>
              {errorMessage}
            </div>
          )}

          {isLoggedIn && emailMatches && isStaff ? (
            <div className="bg-yellow-50 border border-yellow-200 text-yellow-800 text-sm rounded-lg px-4 py-4" data-testid="invite-staff-refused">
              {ERROR_COPY.staff_account}
            </div>
          ) : isLoggedIn && emailMatches ? (
            <form action={acceptPatientInvitationExistingUserAction}>
              <input type="hidden" name="token" value={token} />
              <p className="text-sm text-gray-600 mb-4">
                You&apos;re signed in as <span className="font-medium text-gray-900">{user.email}</span>.
              </p>
              <button type="submit" data-testid="accept-invitation" className="w-full py-2.5 bg-brand-600 text-white font-semibold rounded-lg hover:bg-brand-700 transition-colors">
                Accept invitation
              </button>
            </form>
          ) : isLoggedIn ? (
            <WrongAccount signedInAs={user.email ?? ""} />
          ) : (
            <form action={acceptPatientInvitationNewUserAction} className="space-y-4">
              <input type="hidden" name="token" value={token} />
              <NameField />
              <EmailField email={invitation.email} />
              <PasswordField />
              <button type="submit" data-testid="accept-invitation" className="w-full py-2.5 bg-brand-600 text-white font-semibold rounded-lg hover:bg-brand-700 transition-colors">
                Accept invitation
              </button>
              <p className="text-center text-xs text-gray-500">
                Already have an account?{" "}
                <a href={loginHref} className="text-brand-600 font-medium hover:underline" data-testid="invite-login">
                  Log in to accept
                </a>
              </p>
            </form>
          )}
        </div>
      </Shell>
    );
  }

  // Tester / clinician-admin invitations (admin-issued).
  return (
    <Shell>
      <h1 className="text-2xl font-bold text-gray-900 mb-1">You&apos;re invited</h1>
      <p className="text-sm text-gray-500 mb-6">
        Join <span className="font-medium text-gray-800">{orgName}</span> as a{" "}
        <span className="font-medium text-gray-800">{invitation.granted_role.replace(/_/g, " ")}</span>.
        <br />
        This invitation is for <span className="font-medium text-gray-800">{invitation.email}</span>.
      </p>

      {errorMessage && <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-4 py-3 mb-5">{errorMessage}</div>}

      {isLoggedIn && emailMatches ? (
        <form action={acceptInvitationExistingUserAction}>
          <input type="hidden" name="token" value={token} />
          <p className="text-sm text-gray-600 mb-4">
            You&apos;re already logged in as <span className="font-medium text-gray-900">{user.email}</span>. Click below to accept the
            invitation and join {orgName}.
          </p>
          <button type="submit" className="w-full py-2.5 bg-brand-600 text-white font-semibold rounded-lg hover:bg-brand-700 active:bg-brand-800 transition-colors">
            Accept invitation
          </button>
        </form>
      ) : isLoggedIn ? (
        <WrongAccount signedInAs={user.email ?? ""} />
      ) : (
        <form action={acceptInvitationNewUserAction} className="space-y-4">
          <input type="hidden" name="token" value={token} />
          <NameField />
          <EmailField email={invitation.email} />
          <PasswordField />
          <button type="submit" className="w-full py-2.5 bg-brand-600 text-white font-semibold rounded-lg hover:bg-brand-700 active:bg-brand-800 transition-colors">
            Create account &amp; join {orgName}
          </button>
          <p className="text-center text-xs text-gray-500">
            Already have an account?{" "}
            <a href={loginHref} className="text-brand-600 font-medium hover:underline">
              Log in first
            </a>
          </p>
        </form>
      )}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <span className="text-3xl font-bold text-brand-600">TenoTrainer</span>
          <p className="text-sm text-gray-500 mt-1">Invitation</p>
        </div>
        <div className="bg-white rounded-xl shadow border border-gray-100 p-8">{children}</div>
      </div>
    </div>
  );
}

function WrongAccount({ signedInAs }: { signedInAs: string }) {
  return (
    <div className="bg-yellow-50 border border-yellow-200 text-yellow-800 text-sm rounded-lg px-4 py-4" data-testid="invite-wrong-account">
      <p className="font-medium mb-1">Wrong account</p>
      <p>
        You&apos;re signed in as <strong>{signedInAs}</strong>, which is not the address this invitation was sent to.
      </p>
      <a href="/logout" className="mt-3 inline-block text-brand-600 font-medium hover:underline">
        Log out and switch accounts
      </a>
    </div>
  );
}

function NameField() {
  return (
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
        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-brand-400 focus:border-brand-400 focus:outline-none"
      />
    </div>
  );
}

function EmailField({ email }: { email: string }) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
      <input type="text" disabled value={email} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-gray-50 text-gray-500 cursor-not-allowed" />
    </div>
  );
}

function PasswordField() {
  return (
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
  );
}

function InvalidPage({ reason, state }: { reason: string; state?: string }) {
  return (
    <Shell>
      <div className="text-center" data-testid="invite-state" data-state={state ?? "invalid"}>
        <h1 className="text-xl font-bold text-gray-900 mb-2">Invitation unavailable</h1>
        <p className="text-sm text-gray-500">{reason}</p>
        <a href="/login" className="mt-5 inline-block text-brand-600 text-sm font-medium hover:underline">
          Back to login
        </a>
      </div>
    </Shell>
  );
}
