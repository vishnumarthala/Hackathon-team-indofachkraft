import Link from "next/link";

export default function CaseNotFound() {
  return (
    <div className="mx-auto max-w-5xl px-4 py-6">
      <h1 className="text-2xl font-semibold">Case not found</h1>
      <Link href="/dashboard" className="mt-3 inline-block underline">
        Back to cases
      </Link>
    </div>
  );
}
