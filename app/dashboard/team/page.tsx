import { CreateOrgForm, InviteForm, RevokeButton } from "@/components/team/TeamForms";
import { requireProviderPage } from "@/lib/authz";
import { canManage, listMembers, listMemberships, listPendingInvitations } from "@/lib/orgs";

export const dynamic = "force-dynamic";

const ROLE_LABEL = { owner: "Owner", admin: "Admin", member: "Member" } as const;

export default async function TeamPage() {
  const { user } = await requireProviderPage();
  const memberships = await listMemberships(user.id);

  const orgs = await Promise.all(
    memberships.map(async (m) => ({
      ...m,
      manage: canManage(m.org_role),
      members: await listMembers(m.org.id),
      invitations: canManage(m.org_role) ? await listPendingInvitations(m.org.id) : [],
    })),
  );

  return (
    <div className="mx-auto max-w-5xl space-y-8 px-4 py-6">
      <h1 className="text-2xl font-semibold">Team</h1>

      {orgs.length === 0 && (
        <p className="text-slate-700">
          You are not in an organisation yet. Create your practice below, or open the invitation link a colleague sent you.
        </p>
      )}

      {orgs.map(({ org, org_role, manage, members, invitations }) => (
        <section key={org.id} className="space-y-4 rounded border border-slate-200 bg-white p-4">
          <header>
            <h2 className="text-lg font-semibold">{org.name}</h2>
            <p className="text-sm text-slate-600">
              {org.kind === "centre" ? "Centre" : "Solo practice"}
              {org.city ? ` · ${org.city}` : ""} · you are {ROLE_LABEL[org_role].toLowerCase()}
            </p>
          </header>

          <table className="min-w-full text-left text-sm">
            <thead className="text-slate-700">
              <tr>
                <th className="py-1 pr-4 font-medium">Member</th>
                <th className="py-1 pr-4 font-medium">Role</th>
                {manage && <th className="py-1 font-medium"><span className="sr-only">Actions</span></th>}
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.user_id} className="border-t border-slate-100">
                  <td className="py-1 pr-4">{m.email ?? m.user_id}</td>
                  <td className="py-1 pr-4">{ROLE_LABEL[m.org_role]}</td>
                  {manage && (
                    <td className="py-1">
                      <RevokeButton
                        url={`/api/orgs/${org.id}/members/${m.user_id}`}
                        label="Remove"
                        confirmText={`Remove ${m.email ?? "this member"} from ${org.name}? They lose access immediately.`}
                      />
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>

          {manage && (
            <div className="space-y-3">
              <h3 className="font-medium">Invite a colleague</h3>
              <InviteForm orgId={org.id} />
              {invitations.length > 0 && (
                <ul className="space-y-1 text-sm">
                  {invitations.map((inv) => (
                    <li key={inv.id} className="flex flex-wrap items-center gap-3">
                      <span>
                        {inv.email} · {ROLE_LABEL[inv.org_role]} · pending until {new Date(inv.expires_at).toLocaleDateString("en-IN")}
                      </span>
                      <RevokeButton
                        url={`/api/orgs/${org.id}/invitations/${inv.id}`}
                        label="Cancel invitation"
                        confirmText={`Cancel the invitation for ${inv.email}?`}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </section>
      ))}

      <CreateOrgForm />
    </div>
  );
}
