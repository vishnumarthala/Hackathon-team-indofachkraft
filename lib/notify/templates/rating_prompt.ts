// 036 FR-2: 2 h after a completed appointment, ask the booking guardian to rate the visit (in-app + email; no
// WhatsApp template). Provider name only - never the child.
import type { Template } from "../types";
import { defineTemplate, idOf } from "./shared";

type Payload = { appointment_id: string; provider_name: string };

const template: Template<Payload> = {
  name: "rating_prompt",
  render(ctx) {
    const provider = ctx.payload.provider_name;
    return defineTemplate<Payload>({
      name: "rating_prompt",
      whatsapp: false,
      strings: {
        en: { title: "How was your visit?", body: `Rate your visit with ${provider}. Your rating is shown without your name.` },
        hi: { title: "आपकी विज़िट कैसी रही?", body: `${provider} के साथ अपनी विज़िट को रेटिंग दें। आपकी रेटिंग आपके नाम के बिना दिखाई जाती है।` },
        te: { title: "మీ సందర్శన ఎలా ఉంది?", body: `${provider} తో మీ సందర్శనకు రేటింగ్ ఇవ్వండి. మీ రేటింగ్ మీ పేరు లేకుండా చూపబడుతుంది.` },
      },
      link: (c) => {
        const id = idOf(c.payload, "appointment_id");
        return id ? `/family/appointments/${id}/rate` : "/family/appointments";
      },
    }).render(ctx);
  },
};

export default template;
