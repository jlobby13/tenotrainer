import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "TenoTrainer",
  description: "Achilles tendinopathy rehabilitation — personalised rehab plans powered by clinical rule engine",
};

// M3.3 S2 — every page renders per request: the CSP nonce is per request
// (a prerendered page cannot carry one), and authenticated / clinical HTML
// must never be a reusable cached artifact. (Segment config: this app does
// not enable Cache Components, so `dynamic` is still supported.)
export const dynamic = "force-dynamic";

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
