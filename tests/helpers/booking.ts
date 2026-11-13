// Ticket 030: synthetic providers, services, availability and guardians for the booking DB suites. Builds on
// tests/helpers/world.ts (users, orgs, children); everything created here is removed by cleanup().
import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import { purgeTestAudit } from "./audit";
import { createWorld, type TestUser } from "./world";

type Db = ReturnType<typeof import("@/lib/db").supabaseAdmin>;

export type TestProvider = { user: TestUser; profileId: string; orgId: string; locationId: string; slug: string };

export function bookingWorld(sql: Sql, db: Db, prefix: string) {
  const world = createWorld(sql, db, prefix);
  const profiles: string[] = [];

  /** A verified + listed provider with a solo-ish org, one Hyderabad clinic (IST) and the profile linked to it. */
  async function provider(name: string, opts: { allWeek?: boolean } = { allWeek: true }): Promise<TestProvider> {
    const user = await world.user(name, "provider");
    const orgId = await world.org(user, `${name} clinic`);
    const slug = `${prefix}-${name}-${world.tag}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");
    const [loc] = await sql<{ id: string }[]>`
      insert into practice_locations (org_id, name, address_line1, locality, pincode, lat, lng)
      values (${orgId}, ${`${name} clinic (synthetic)`}, 'Road 1 (synthetic)', 'Banjara Hills', '500034', 17.41, 78.44)
      returning id`;
    const [profile] = await sql<{ id: string }[]>`
      insert into provider_profiles (user_id, slug, display_name, provider_type, verification_status, verified_at, listed, claimed, is_synthetic)
      values (${user.id}, ${slug}, ${`Dr ${name} (synthetic)`}, 'speech_language_pathologist', 'verified', now(), true, true, false)
      returning id`;
    profiles.push(profile.id);
    await sql`insert into provider_locations (provider_profile_id, location_id, org_id) values (${profile.id}, ${loc.id}, ${orgId})`;
    if (opts.allWeek) {
      // Every day, all day (IST): any aligned time 2 h - 14 days ahead is bookable whenever the suite runs.
      for (const weekday of [0, 1, 2, 3, 4, 5, 6]) {
        await sql`
          insert into availability_rules (provider_profile_id, org_id, location_id, weekday, start_time, end_time, mode, valid_from)
          values (${profile.id}, ${orgId}, ${loc.id}, ${weekday}, '00:00', '24:00', 'both', current_date - 2)`;
      }
    }
    return { user, profileId: profile.id, orgId, locationId: loc.id, slug };
  }

  async function service(
    p: TestProvider,
    opts: { mode?: "in_clinic" | "video"; duration?: number; payment?: "free" | "at_clinic" | "online"; fee?: number; buffer?: number; name?: string } = {},
  ): Promise<string> {
    const mode = opts.mode ?? "in_clinic";
    const payment = opts.payment ?? "free";
    const [row] = await sql<{ id: string }[]>`
      insert into services (provider_profile_id, org_id, location_id, name, mode, duration_min, fee_inr, payment_mode, buffer_min)
      values (${p.profileId}, ${p.orgId}, ${mode === "in_clinic" ? p.locationId : null}, ${opts.name ?? `${mode} ${opts.duration ?? 30} (synthetic)`},
              ${mode}, ${opts.duration ?? 30}, ${payment === "free" ? 0 : (opts.fee ?? 500)}, ${payment}, ${opts.buffer ?? 0})
      returning id`;
    return row.id;
  }

  /** A guardian with one linked child (self-registered). */
  async function guardian(name: string): Promise<{ user: TestUser; childId: string }> {
    const user = await world.user(name, "guardian");
    const [child] = await sql<{ id: string }[]>`
      insert into children (display_name, date_of_birth, source, created_by)
      values (${`${name} child (synthetic)`}, '2021-05-01', 'guardian', ${user.id}) returning id`;
    world.trackChild(child.id);
    await world.link(child.id, user);
    return { user, childId: child.id };
  }

  /** 037 FR-5a: a linked Google identity (as after 019's `linkIdentity`), required for video bookings. */
  async function linkGoogle(user: TestUser): Promise<void> {
    const sub = `${Date.now()}${Math.floor(Math.random() * 1e9)}`;
    await sql`
      insert into auth.identities (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
      values (${sub}, ${user.id}, ${sql.json({ sub, email: user.email, email_verified: true })}, 'google', now(), now(), now())`;
  }

  async function cleanup() {
    if (profiles.length) {
      const appts = await sql<{ id: string }[]>`select id from appointments where provider_profile_id in ${sql(profiles)}`;
      const ids = appts.map((a) => a.id);
      // 037: provider-level events (Google reconnect notices) and their audit rows.
      await sql`delete from outbox_events where aggregate_type = 'provider_profile' and aggregate_id in ${sql(profiles)}`;
      await purgeTestAudit(sql, (tx) => tx`delete from audit_events where entity = 'provider_profile' and entity_id in ${tx(profiles)}`);
      if (ids.length) {
        // 037: Meet jobs and Meet notifications carry the appointment id in the payload under their own aggregate types.
        await sql`delete from outbox_events where (aggregate_type = 'appointment' and aggregate_id in ${sql(ids)}) or payload ->> 'appointment_id' in ${sql(ids)}`;
        await purgeTestAudit(sql, (tx) => tx`delete from audit_events where entity = 'appointment' and entity_id in ${tx(ids)}`);
        // 031: payments block appointment deletes.
        await sql`delete from payments where appointment_id in ${sql(ids)}`;
        await sql`delete from appointments where id in ${sql(ids)}`;
      }
      await purgeTestAudit(sql, (tx) => tx`delete from audit_events where entity in ('service', 'availability_rule', 'availability_override') and actor_user_id in (select user_id from provider_profiles where id in ${tx(profiles)})`);
      await sql`delete from provider_profiles where id in ${sql(profiles)}`;
    }
    await world.cleanup();
  }

  return { ...world, provider, service, guardian, linkGoogle, cleanup };
}

const IST_OFFSET = 330 * 60_000;
const DAY = 86_400_000;

/**
 * The first start >= now + `hoursAhead` on the `stepMin` grid of the all-day IST rules (steps counted from local
 * midnight; every allowed duration divides 24 h, so the grid continues across midnight). `extraSteps` moves further.
 */
export function futureSlot(hoursAhead: number, stepMin = 30, extraSteps = 0): Date {
  const step = stepMin * 60_000;
  const local = Date.now() + hoursAhead * 3_600_000 + IST_OFFSET;
  const dayStart = Math.floor(local / DAY) * DAY;
  const into = Math.ceil((local - dayStart) / step) * step + extraSteps * step;
  return new Date(dayStart + into - IST_OFFSET);
}

export const sessionHash = () => randomUUID().replace(/-/g, "").padEnd(64, "0");
export const key = () => `k-${randomUUID()}`;
