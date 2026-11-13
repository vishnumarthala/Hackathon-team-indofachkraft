import { defineTemplate } from "./shared";

// Dev/ops check (topic test.ping). An optional `ics_start` adds a 30-minute calendar invite to the email.
export default defineTemplate<{ ics_start?: string }>({
  name: "test_ping",
  strings: {
    en: { title: "Test notification", body: "Notifications are working for your DoctorNearMe account." },
    hi: { title: "परीक्षण सूचना", body: "आपके DoctorNearMe खाते के लिए सूचनाएँ काम कर रही हैं।" },
    te: { title: "పరీక్ష నోటిఫికేషన్", body: "మీ DoctorNearMe ఖాతాకు నోటిఫికేషన్లు పని చేస్తున్నాయి." },
  },
  link: () => "/notifications",
  ics: ({ payload }) => {
    if (!payload.ics_start) return undefined;
    const start = new Date(payload.ics_start);
    if (Number.isNaN(start.getTime())) return undefined;
    return {
      method: "REQUEST",
      start: start.toISOString(),
      end: new Date(start.getTime() + 30 * 60_000).toISOString(),
      summary: "DoctorNearMe test event",
    };
  },
});
