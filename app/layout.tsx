import type { Metadata } from "next";
import type { ReactNode } from "react";
import { SiteChrome } from "@/components/SiteChrome";
import "./globals.css";

export const metadata: Metadata = {
  title: "DoctorNearMe",
  description: "Autism and early intervention care near you, with an AI assistant for therapists.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="flex min-h-full flex-col">
        <SiteChrome />
        <main className="flex-1">{children}</main>
      </body>
    </html>
  );
}
