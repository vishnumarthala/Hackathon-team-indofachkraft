"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { isValidTimeZone } from "@/lib/i18n/config";
import { useTimeZone } from "@/lib/i18n/client";

const SYNCED_KEY = "dnm_tz_synced";

/**
 * FR-5a: tells the server the browser's time zone (cookie dnm_tz, and the profile when signed in) when it
 * differs from the zone the page was rendered in, then refreshes once so every time shows in local time.
 */
export function TimeZoneSync() {
  const rendered = useTimeZone();
  const router = useRouter();

  useEffect(() => {
    let browser: string | undefined;
    try {
      browser = Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
      return;
    }
    if (!isValidTimeZone(browser) || browser === rendered) return;
    // Once per browser zone per tab session, so a failing cookie can never cause a refresh loop.
    if (sessionStorage.getItem(SYNCED_KEY) === browser) return;
    sessionStorage.setItem(SYNCED_KEY, browser);
    void fetch("/api/locale", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ time_zone: browser }),
    })
      .then((res) => {
        if (res.ok) router.refresh();
      })
      .catch(() => {});
  }, [rendered, router]);

  return null;
}
