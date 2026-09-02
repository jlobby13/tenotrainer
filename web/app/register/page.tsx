export const metadata = { title: "Create Account — TenoTrainer" };

export default function RegisterPage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <span className="text-3xl font-bold text-brand-600">TenoTrainer</span>
          <p className="text-sm text-gray-500 mt-1">Achilles tendinopathy rehabilitation</p>
        </div>

        <div className="bg-white rounded-xl shadow border border-gray-100 p-8 text-center">
          <h1 className="text-xl font-bold text-gray-900 mb-2">Invitation required</h1>
          <p className="text-sm text-gray-500 mb-6">
            TenoTrainer is invite-only. New accounts are created through the invitation system.
            If you have been invited, check your email for your invitation link.
          </p>
          <a
            href="/login"
            className="inline-block px-5 py-2.5 bg-brand-600 text-white font-semibold rounded-lg hover:bg-brand-700 transition-colors text-sm"
          >
            Log in
          </a>
        </div>
      </div>
    </div>
  );
}
