export const metadata = { title: "Check Your Email — TenoTrainer" };

export default function ConfirmPage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <span className="text-3xl font-bold text-brand-600">TenoTrainer</span>
        </div>
        <div className="bg-white rounded-xl shadow border border-gray-100 p-8 text-center">
          <div className="text-4xl mb-4">✉️</div>
          <h1 className="text-2xl font-bold text-gray-900 mb-2">Check your email</h1>
          <p className="text-sm text-gray-500 mb-6">
            We sent a confirmation link to your email address. Click the link to
            activate your account and log in.
          </p>
          <p className="text-xs text-gray-400">
            Didn&apos;t receive it? Check your spam folder, or{" "}
            <a href="/register" className="text-brand-600 hover:underline">
              try registering again
            </a>
            .
          </p>
        </div>
      </div>
    </div>
  );
}
