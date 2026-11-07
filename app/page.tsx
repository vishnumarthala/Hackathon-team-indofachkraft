import Link from "next/link";

export default function HomePage() {
  return (
    <div className="mx-auto max-w-5xl px-4 py-12">
      <h1 className="text-3xl font-semibold">CareThread</h1>
      <p className="mt-3 text-lg text-slate-700">The AI assistant for early intervention therapists.</p>
      <Link href="/dashboard" className="mt-6 inline-block rounded bg-slate-900 px-4 py-2 font-medium text-white">
        Open dashboard
      </Link>
    </div>
  );
}
