import type { Metadata } from "next";
import { Noto_Sans, Noto_Sans_Devanagari, Noto_Sans_Telugu } from "next/font/google";
import type { ReactNode } from "react";
import { SiteChrome } from "@/components/SiteChrome";
import { TimeZoneSync } from "@/components/TimeZoneSync";
import { I18nProvider } from "@/lib/i18n/client";
import { HTML_LANG } from "@/lib/i18n/config";
import { getMessages } from "@/lib/i18n/messages";
import { getLocale, getT, getTimeZone } from "@/lib/i18n/server";
import "./globals.css";

// Latin is preloaded; Devanagari and Telugu load on demand (unicode-range) when those glyphs appear.
const notoSans = Noto_Sans({ subsets: ["latin"], variable: "--font-noto-sans", display: "swap" });
const notoDevanagari = Noto_Sans_Devanagari({
  subsets: ["devanagari"],
  variable: "--font-noto-devanagari",
  display: "swap",
  preload: false,
});
const notoTelugu = Noto_Sans_Telugu({ subsets: ["telugu"], variable: "--font-noto-telugu", display: "swap", preload: false });

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT("landing.meta");
  return { title: "DoctorNearMe", description: t("description") };
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const [locale, timeZone] = await Promise.all([getLocale(), getTimeZone()]);
  return (
    <html
      lang={HTML_LANG[locale]}
      className={`${notoSans.variable} ${notoDevanagari.variable} ${notoTelugu.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col">
        <I18nProvider locale={locale} timeZone={timeZone} messages={getMessages(locale)}>
          <TimeZoneSync />
          <SiteChrome />
          <main className="flex-1">{children}</main>
        </I18nProvider>
      </body>
    </html>
  );
}
