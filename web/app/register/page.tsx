import { registerAction } from "./actions";

export const metadata = { title: "Create Account — TenoTrainer" };

type Props = { searchParams: Promise<{ error?: string; name?: string; email?: string }> };

export default async function RegisterPage({ searchParams }: Props) {
  const { error, name, email } = await searchParams;

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <span className="text-3xl font-bold text-brand-600">TenoTrainer</span>
          <p className="text-sm text-gray-500 mt-1">Achilles tendinopathy rehabilitation</p>
        </div>

        <div className="bg-white rounded-xl shadow border border-gray-100 p-8">
          <h1 className="text-2xl font-bold text-gray-900 mb-1">Create your account</h1>
          <p className="text-sm text-gray-500 mb-6">
            Start your personalised rehabilitation programme.
          </p>

          {error && (
            <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-4 py-3 mb-5">
              {error}
            </div>
          )}

          <form action={registerAction} className="space-y-4">
            <div>
              <label htmlFor="name" className="block text-sm font-medium text-gray-700 mb-1">
                Full name
              </label>
              <input
                id="name"
                name="name"
                type="text"
                defaultValue={name ?? ""}
                required
                autoFocus
                autoComplete="name"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-brand-400 focus:border-brand-400 focus:outline-none"
              />
            </div>

            <div>
              <label htmlFor="email" className="block text-sm font-medium text-gray-700 mb-1">
                Email address
              </label>
              <input
                id="email"
                name="email"
                type="email"
                defaultValue={email ?? ""}
                required
                autoComplete="email"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-brand-400 focus:border-brand-400 focus:outline-none"
              />
            </div>

            <div>
              <label htmlFor="password" className="block text-sm font-medium text-gray-700 mb-1">
                Password
              </label>
              <input
                id="password"
                name="password"
                type="password"
                required
                autoComplete="new-password"
                minLength={8}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-brand-400 focus:border-brand-400 focus:outline-none"
              />
              <p className="text-xs text-gray-400 mt-1">Minimum 8 characters.</p>
            </div>

            <div>
              <label
                htmlFor="password_confirm"
                className="block text-sm font-medium text-gray-700 mb-1"
              >
                Confirm password
              </label>
              <input
                id="password_confirm"
                name="password_confirm"
                type="password"
                required
                autoComplete="new-password"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-brand-400 focus:border-brand-400 focus:outline-none"
              />
            </div>

            <button
              type="submit"
              className="w-full py-2.5 bg-brand-600 text-white font-semibold rounded-lg hover:bg-brand-700 active:bg-brand-800 transition-colors"
            >
              Create account
            </button>
          </form>

          <p className="mt-5 text-center text-sm text-gray-500">
            Already have an account?{" "}
            <a href="/login" className="text-brand-600 font-medium hover:underline">
              Log in
            </a>
          </p>
        </div>
      </div>
    </div>
  );
}
