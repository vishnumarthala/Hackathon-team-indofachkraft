// Ticket 056: "Set up your centre" checklist on /dashboard for a new pilot centre. Each step is done when the data
// exists (never a manual tick), so the card disappears by itself once the centre runs on DoctorNearMe.
import { isUuid } from "@/lib/cases/validation";
import { pg } from "@/lib/pg";

export const SETUP_STEP_IDS = ["team", "children", "family", "timetable", "note", "homeProgram"] as const;
export type SetupStepId = (typeof SETUP_STEP_IDS)[number];
export type SetupFacts = Record<SetupStepId, boolean>;
export type SetupStep = { id: SetupStepId; done: boolean; href: string };

/** Pure: steps in order with their links. `firstCaseId` / `caseWithoutParentId` pick the most useful target. */
export function setupSteps(facts: SetupFacts, opts: { firstCaseId: string | null; caseWithoutParentId: string | null }): SetupStep[] {
  const caseHref = (suffix = "") => (opts.firstCaseId ? `/cases/${opts.firstCaseId}${suffix}` : "/dashboard/import");
  const hrefs: Record<SetupStepId, string> = {
    team: "/dashboard/team",
    children: "/dashboard/import",
    family: opts.caseWithoutParentId ? `/cases/${opts.caseWithoutParentId}#parent-code` : caseHref("#parent-code"),
    timetable: caseHref(),
    note: caseHref("/sessions"),
    homeProgram: caseHref("/home-program"),
  };
  return SETUP_STEP_IDS.map((id) => ({ id, done: facts[id], href: hrefs[id] }));
}

/** Facts for the user's active organisations and the cases they may see (same scope as the dashboard). */
export async function loadSetupFacts(userId: string): Promise<SetupFacts> {
  if (!isUuid(userId)) return { team: false, children: false, family: false, timetable: false, note: false, homeProgram: false };
  const sql = await pg();
  const [row] = await sql<SetupFacts[]>`
    with orgs as (select org_id from public.org_members where user_id = ${userId} and status = 'active'),
         c as (select id, child_id from public.accessible_cases(${userId}))
    select
      (select count(*) from public.org_members m where m.org_id in (select org_id from orgs) and m.status = 'active') > 1
        or exists (
          select 1 from public.org_invitations i
          where i.org_id in (select org_id from orgs) and i.accepted_at is null and i.revoked_at is null and i.expires_at > now()
        ) as team,
      exists (select 1 from c) as children,
      exists (select 1 from public.guardian_links gl join c on c.child_id = gl.child_id where gl.status = 'active') as family,
      exists (select 1 from public.appointment_series s where s.org_id in (select org_id from orgs) and s.status = 'active') as timetable,
      exists (select 1 from public.reports r join c on c.id = r.case_id where r.kind = 'session_note') as note,
      exists (select 1 from public.home_programs hp join c on c.id = hp.case_id where hp.status = 'published') as "homeProgram"`;
  return row;
}
