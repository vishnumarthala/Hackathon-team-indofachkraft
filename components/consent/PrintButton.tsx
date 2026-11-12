"use client";

export function PrintButton({ label }: { label: string }) {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className="inline-flex min-h-11 items-center rounded bg-slate-900 px-4 py-2 text-sm font-medium text-white print:hidden"
    >
      {label}
    </button>
  );
}
