import { CaseForm } from "@/components/case/CaseForm";

export default function NewCasePage() {
  return (
    <div className="mx-auto max-w-5xl px-4 py-6">
      <h1 className="mb-4 text-2xl font-semibold">New case</h1>
      <CaseForm />
    </div>
  );
}
