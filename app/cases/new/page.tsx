import Link from "next/link";
import { CaseForm } from "@/components/case/CaseForm";
import { requireProviderPage } from "@/lib/authz";
import { listMemberships } from "@/lib/orgs";

export const dynamic = "force-dynamic";

export default async function NewCasePage() {
  const { user } = await requireProviderPage();
  const memberships = await listMemberships(user.id);

  return (
    <div className="mx-auto max-w-5xl px-4 py-6">
      <h1 className="mb-4 text-2xl font-semibold">New case</h1>
      {memberships.length === 0 ? (
        <p className="text-slate-700">
          Create or join an organisation first.{" "}
          <Link href="/dashboard/team" className="font-medium underline">
            Go to Team
          </Link>
        </p>
      ) : (
        <CaseForm orgs={memberships.map((m) => ({ id: m.org.id, name: m.org.name }))} />
      )}
    </div>
  );
}
