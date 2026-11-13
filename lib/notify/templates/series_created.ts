import { seriesTemplate } from "./series";

export default seriesTemplate("series_created", {
  en: (v) => ({
    title: "Weekly sessions booked",
    body: `Weekly sessions with ${v.provider}: every ${v.days} at ${v.time}, starting ${v.starts}. ${v.where}.`,
  }),
  hi: (v) => ({
    title: "साप्ताहिक सेशन बुक हुए",
    body: `${v.provider} के साथ साप्ताहिक सेशन: हर ${v.days} को ${v.time} पर, ${v.starts} से। ${v.where}।`,
  }),
  te: (v) => ({
    title: "వారపు సెషన్లు బుక్ అయ్యాయి",
    body: `${v.provider} తో వారపు సెషన్లు: ప్రతి ${v.days} ${v.time} కి, ${v.starts} నుండి. ${v.where}.`,
  }),
});
