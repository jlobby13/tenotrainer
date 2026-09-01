import { redirect } from "next/navigation";
import { getSessionInfo } from "@/lib/auth";
import { createOrgAction } from "./actions";

export const metadata = { title: "Set Up Your Organization — TenoTrainer" };

type Props = { searchParams: Promise<{ error?: string }> };

export default async function SetupPage({ searchParams }: Props) {
  const { error } = await searchParams;
  const session = await getSessionInfo();

  if (!session.user) redirect("/login");
  if (session.memberships.length > 0) redirect("/dashboard");

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <span className="text-3xl font-bold text-brand-600">TenoTrainer</span>
          <p className="text-sm text-gray-500 mt-1">First-time setup</p>
        </div>

        <div className="bg-white rounded-xl shadow border border-gray-100 p-8">
          <h1 className="text-2xl font-bold text-gray-900 mb-1">Create your organization</h1>
          <p className="text-sm text-gray-500 mb-6">
            You&apos;ll be the super-user and can invite clinicians and testers afterward.
          </p>

          {error && (
            <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-4 py-3 mb-5">
              {error}
            </div>
          )}

          <form action={createOrgAction} className="space-y-4">
            <div>
              <label htmlFor="name" className="block text-sm font-medium text-gray-700 mb-1">
                Organization name
              </label>
              <input
                id="name"
                name="name"
                type="text"
                required
                autoFocus
                placeholder="Acme Physio Clinic"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-brand-400 focus:border-brand-400 focus:outline-none"
              />
            </div>

            <div>
              <label htmlFor="slug" className="block text-sm font-medium text-gray-700 mb-1">
                Slug
              </label>
              <div className="flex items-center gap-2">
                <input
                  id="slug"
                  name="slug"
                  type="text"
                  required
                  placeholder="acme-physio"
                  pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-brand-400 focus:border-brand-400 focus:outline-none"
                />
              </div>
              <p className="text-xs text-gray-400 mt-1">Lowercase letters, numbers, and hyphens only.</p>
            </div>

            <button
              type="submit"
              className="w-full py-2.5 bg-brand-600 text-white font-semibold rounded-lg hover:bg-brand-700 active:bg-brand-800 transition-colors"
            >
              Create organization
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
