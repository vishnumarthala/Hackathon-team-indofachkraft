const PHASES = [
  {
    title: "1. Intake call",
    text: "Before the first visit, an AI voice assistant talks to the parent in Telugu, Hindi or English and prepares a pre-session brief for the therapist.",
  },
  {
    title: "2. Online session",
    text: "During the session, CareThread suggests a rating for each of the 40 ISAA items with an evidence quote and timestamp, and the therapist confirms or edits every one.",
  },
  {
    title: "3. Specialist handoff",
    text: "When a referral is needed, the specialist receives the complete case and can ask questions that are answered with cited evidence.",
  },
];

export function PhaseCards() {
  return (
    <ol className="grid gap-4 sm:grid-cols-3">
      {PHASES.map((p) => (
        <li key={p.title} className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="mb-2 text-lg font-semibold text-slate-900">{p.title}</h2>
          <p className="text-slate-700">{p.text}</p>
        </li>
      ))}
    </ol>
  );
}
