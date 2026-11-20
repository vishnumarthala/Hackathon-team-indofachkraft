// Narration for the jury video. One entry per scene, in order.
// `voice` is what ElevenLabs speaks (numbers written out so they are read correctly).
// After editing a line, run `npm run voice` again: only changed lines are re-synthesised.

export type SceneId =
  | "hook"
  | "problem"
  | "why-late"
  | "solution"
  | "intake"
  | "forms"
  | "handoff"
  | "different"
  | "business"
  | "close";

export type ScriptLine = { id: SceneId; voice: string };

export const SCRIPT: ScriptLine[] = [
  {
    id: "hook",
    voice:
      "Meet Priya and her son Ravi, a Telugu-speaking family in Stuttgart. Ravi is two and a half, and he has no words yet. Priya noticed the signs months ago. Now they are on a waitlist, and nobody can tell them how long it will take.",
  },
  {
    id: "problem",
    voice:
      "Their story is common. Parents notice the first signs at around two. Support helps most when it starts before three. Yet the median diagnosis in the US comes at four, and in Germany at six and a half, at school entry. One in thirty-one American children is autistic. About one in a hundred worldwide.",
  },
  {
    id: "why-late",
    voice:
      "Why so late? Too few specialists, year-long waitlists, and therapists who spend their sessions on paperwork. And time matters. Four in ten toddlers diagnosed early no longer met autism criteria by school age. In a randomised trial, early intervention raised IQ by seventeen points, against seven with usual care.",
  },
  {
    id: "solution",
    voice:
      "So we built CareThread: an AI assistant for early intervention centres, to get children into support sooner. One thread connects everyone around the child: the family, the therapist, the centre, and the specialist.",
  },
  {
    id: "intake",
    voice:
      "It starts before the first visit. The parent gets a link by WhatsApp or email, gives consent, and talks to our voice agent in Telugu, Hindi or English. Here is a moment from a role-play call.",
  },
  {
    id: "forms",
    voice:
      "The therapist walks in with a brief, red flags already marked. During the session, CareThread separates therapist and parent, and fills all forty items of the ISAA autism assessment. Every suggested rating comes with the exact quote and timestamp. The therapist confirms each item. AI documents. The clinician decides.",
  },
  {
    id: "handoff",
    voice:
      "Afterwards, parents get a voice summary in their own language. When a case is serious, one click sends a full referral packet to a specialist, who can ask the case questions and jump straight to the evidence. The family never repeats their story.",
  },
  {
    id: "different",
    voice:
      "General AI scribes write notes for all of medicine. CareThread is built for one job: scored developmental forms with evidence, parent calls in Indian languages, and a case memory that travels. Every hour saved on forms goes to the next child on the waitlist.",
  },
  {
    id: "business",
    voice:
      "Centres pay. In India, five to fifteen thousand rupees per centre a month. In Germany, ninety-nine to one hundred forty-nine euros per clinician. We start with three pilot centres from our network, and aim for fifty Indian centres and five German sites in year one: one hundred to one hundred fifty thousand euros in annual recurring revenue.",
  },
  {
    id: "close",
    voice:
      "The timing is right. Voice AI now speaks Telugu and Hindi, and two hundred eighty thousand Indians live in Germany. Our ask: three pilot centres, and introductions to S P Z clinicians. CareThread. When the signs appear at two, help should not wait until six.",
  },
];
