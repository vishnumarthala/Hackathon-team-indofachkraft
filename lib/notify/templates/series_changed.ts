import { seriesTemplate } from "./series";

// One template for every series change (payload `change`): new time from a date, pause, end, a skipped date, or one
// session moved to another time.
export default seriesTemplate("series_changed", {
  en: (v, change) => {
    switch (change) {
      case "paused":
        return { title: "Sessions paused", body: `Sessions with ${v.provider} are paused from ${v.date} to ${v.until}.` };
      case "ended":
        return { title: "Weekly sessions ending", body: `Weekly sessions with ${v.provider} end after ${v.date}.` };
      case "skipped":
        return { title: "Session cancelled", body: `There is no session with ${v.provider} on ${v.date}. The rest of the timetable stays the same.` };
      case "moved":
        return { title: "Session moved", body: `The session with ${v.provider} on ${v.date} is moved to ${v.newTime}.` };
      default:
        return { title: "Timetable changed", body: `From ${v.date}, sessions with ${v.provider} are every ${v.days} at ${v.time}. ${v.where}.` };
    }
  },
  hi: (v, change) => {
    switch (change) {
      case "paused":
        return { title: "सेशन रोके गए", body: `${v.provider} के साथ सेशन ${v.date} से ${v.until} तक रुके रहेंगे।` };
      case "ended":
        return { title: "साप्ताहिक सेशन समाप्त", body: `${v.provider} के साथ साप्ताहिक सेशन ${v.date} के बाद समाप्त हो जाएँगे।` };
      case "skipped":
        return { title: "सेशन रद्द हुआ", body: `${v.date} को ${v.provider} के साथ कोई सेशन नहीं है। बाकी समय-सारणी वही रहेगी।` };
      case "moved":
        return { title: "सेशन का समय बदला", body: `${v.date} का ${v.provider} के साथ सेशन अब ${v.newTime} को है।` };
      default:
        return { title: "समय-सारणी बदली", body: `${v.date} से ${v.provider} के साथ सेशन हर ${v.days} को ${v.time} पर हैं। ${v.where}।` };
    }
  },
  te: (v, change) => {
    switch (change) {
      case "paused":
        return { title: "సెషన్లు ఆపబడ్డాయి", body: `${v.provider} తో సెషన్లు ${v.date} నుండి ${v.until} వరకు ఆపబడ్డాయి.` };
      case "ended":
        return { title: "వారపు సెషన్లు ముగుస్తున్నాయి", body: `${v.provider} తో వారపు సెషన్లు ${v.date} తర్వాత ముగుస్తాయి.` };
      case "skipped":
        return { title: "సెషన్ రద్దయింది", body: `${v.date} న ${v.provider} తో సెషన్ లేదు. మిగతా టైమ్‌టేబుల్ అలాగే ఉంటుంది.` };
      case "moved":
        return { title: "సెషన్ సమయం మారింది", body: `${v.date} న ${v.provider} తో సెషన్ ఇప్పుడు ${v.newTime} కి ఉంది.` };
      default:
        return { title: "టైమ్‌టేబుల్ మారింది", body: `${v.date} నుండి ${v.provider} తో సెషన్లు ప్రతి ${v.days} ${v.time} కి. ${v.where}.` };
    }
  },
});
