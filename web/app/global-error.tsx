"use client";

import "./globals.css";

// M3.4g — the application's own last-resort error page (an error in the
// root layout, or any render error no nearer boundary handles). Next's
// built-in fallback styles itself with inline style attributes, which the
// enforced policy (style-src 'self' 'nonce-…', no 'unsafe-inline') blocks;
// this page uses only the app's stylesheet and class names, and is
// rendered per request (with the request's nonce). The plain link works
// even if scripts cannot run. Neutral copy; never shows error details.
// (Next's separate built-in 500 document is not replaced by this file.)
export default function GlobalError({ retry }: { error: unknown; retry: () => void }) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full">
        <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
          <main className="w-full max-w-md text-center">
            <span className="text-3xl font-bold text-brand-600">TenoTrainer</span>
            <h1 className="mt-6 text-xl font-semibold text-gray-900">Something went wrong</h1>
            <p className="mt-2 text-sm text-gray-500">Please try again. If this keeps happening, contact your clinician.</p>
            <div className="mt-6 flex flex-col items-center gap-2">
              <button
                type="button"
                onClick={() => retry()}
                className="inline-flex min-h-11 items-center rounded-md bg-brand-600 px-4 text-sm font-medium text-white hover:bg-brand-700"
              >
                Try again
              </button>
              <a href="/dashboard" className="inline-flex min-h-11 items-center text-sm font-medium text-brand-600 hover:text-brand-700">
                Go to your dashboard
              </a>
            </div>
          </main>
        </div>
      </body>
    </html>
  );
}
