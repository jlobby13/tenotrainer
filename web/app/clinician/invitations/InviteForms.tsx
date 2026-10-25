"use client";

import { useActionState } from "react";
import { createPatientInvitationAction, type InviteFormState } from "./actions";

const ERROR_COPY: Record<string, string> = {
  invalid_email: "Please enter a valid email address.",
  staff_account: "That address belongs to a staff account in your clinic and can't be invited as a patient.",
  already_assigned: "That patient is already assigned to you.",
  not_authorized: "You can't invite patients for this clinic.",
  error: "The invitation could not be created. Please try again.",
};

function Result({ state }: { state: InviteFormState }) {
  if (state.kind === "error") {
    return (
      <p className="text-sm text-red-700" data-testid="invite-result" data-result={state.code}>
        {ERROR_COPY[state.code] ?? ERROR_COPY.error}
      </p>
    );
  }
  if (state.kind !== "created") return null;
  return (
    <div
      className={`rounded-lg border px-4 py-3 text-sm space-y-2 ${state.emailed ? "border-green-200 bg-green-50 text-green-800" : "border-yellow-200 bg-yellow-50 text-yellow-800"}`}
      data-testid="invite-result"
      data-result="created"
    >
      <p className="font-medium">
        {state.emailed ? `Invitation emailed to ${state.email}.` : `Invitation created for ${state.email}, but the email could not be sent.`}
      </p>
      <p className="text-xs">{state.emailed ? "You can also share this one-time link (expires in 7 days):" : "Share this one-time link with the patient (expires in 7 days):"}</p>
      <div className="font-mono text-xs bg-white border border-gray-200 rounded px-3 py-2 break-all select-all" data-testid="invite-link">
        {state.inviteUrl}
      </div>
    </div>
  );
}

export function InvitePatientForm({ organizations }: { organizations: { id: string; name: string }[] }) {
  const [state, action, pending] = useActionState(createPatientInvitationAction, { kind: "idle" } as InviteFormState);
  return (
    <form action={action} className="space-y-4" data-testid="invite-patient-form">
      {organizations.length > 1 ? (
        <div>
          <label htmlFor="organizationId" className="block text-sm font-medium text-gray-700 mb-1">
            Clinic
          </label>
          <select id="organizationId" name="organizationId" className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white">
            {organizations.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        </div>
      ) : (
        <input type="hidden" name="organizationId" value={organizations[0]?.id ?? ""} />
      )}
      <div>
        <label htmlFor="email" className="block text-sm font-medium text-gray-700 mb-1">
          Patient email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          required
          placeholder="patient@example.com"
          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-brand-400 focus:outline-none"
          data-testid="invite-email"
        />
      </div>
      <button
        type="submit"
        disabled={pending}
        className="py-2 px-6 bg-brand-600 text-white font-semibold rounded-lg hover:bg-brand-700 transition-colors text-sm disabled:opacity-60"
        data-testid="send-invitation"
      >
        Send invitation
      </button>
      <Result state={state} />
    </form>
  );
}

// Resend = a new invitation to the same address; the previous link stops
// working (create_patient_invitation cancels it).
export function ResendInvitation({ email, organizationId }: { email: string; organizationId: string }) {
  const [state, action, pending] = useActionState(createPatientInvitationAction, { kind: "idle" } as InviteFormState);
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="email" value={email} />
      <input type="hidden" name="organizationId" value={organizationId} />
      <button type="submit" disabled={pending} className="text-xs text-brand-700 hover:underline font-medium" data-testid="resend-invitation">
        Resend
      </button>
      <Result state={state} />
    </form>
  );
}
