export function FamilyEmptyState({ title, message }: { title: string; message: string }) {
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-slate-900 sm:text-3xl">{title}</h1>
      <p className="rounded-2xl border border-dashed border-slate-300 bg-white p-6 text-center text-slate-600">{message}</p>
    </div>
  );
}
