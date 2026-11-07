import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "CareThread",
  description: "The AI assistant for early intervention therapists.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="flex min-h-full flex-col">
        <header className="border-b border-slate-200 bg-white">
          <nav className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-4 py-3">
            <Link href="/" className="text-lg font-semibold text-slate-900">
              CareThread
            </Link>
            <Link href="/dashboard" className="text-sm font-medium text-slate-700 hover:text-slate-900">
              Dashboard
            </Link>
          </nav>
        </header>
        <div role="note" className="bg-yellow-200 px-4 py-2 text-center text-sm font-medium text-yellow-950">
          Demo - synthetic data only. AI documents, the clinician decides.
        </div>
        <main className="flex-1">{children}</main>
      </body>
    </html>
  );
}
