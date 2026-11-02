import Link from "next/link";

export const metadata = { title: "Page not found — TenoTrainer" };

// M3.4a — the application's own not-found page. Next's built-in fallback
// renders inline style elements/attributes that carry no CSP nonce, so under
// the production policy (style-src 'self' 'nonce-…', no 'unsafe-inline') it
// would lose its styling once the CSP is enforced (M3.4g). This page uses
// only the app's stylesheet. Neutral copy; reveals nothing.
export default function NotFound() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <main className="w-full max-w-md text-center">
        <span className="text-3xl font-bold text-brand-600">TenoTrainer</span>
        <h1 className="mt-6 text-xl font-semibold text-gray-900">Page not found</h1>
        <p className="mt-2 text-sm text-gray-500">The page you were looking for doesn&apos;t exist.</p>
        <Link href="/dashboard" className="mt-6 inline-flex min-h-11 items-center text-sm font-medium text-brand-600 hover:text-brand-700">
          Go to your dashboard
        </Link>
      </main>
    </div>
  );
}
