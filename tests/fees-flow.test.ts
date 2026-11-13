// Ticket 045 against the real database through the route handlers (DEMO_MODE gateway with payment links):
//   * "pay at clinic": refused for new services (API + database), existing ones migrate to online (the migration's own
//     statement, run in a rolled-back transaction);
//   * package offer -> payment link -> signed `payment_link.paid` webhook (replay -> duplicate no-op, tampered -> 401)
//     -> package active, ledger charge + payment, receipt DNM/<FY>/<n> (+ the receipt PDF and the guardian's receipt);
//   * 12 present sessions -> used_up, consultation amounts 75000 each (remainder: ₹10,000 / 12); an absent,
//     non-billable session uses nothing; a correction gives the session back;
//   * a billable session without a package -> a charge plus a balance link; paying it -> balance 0 (E-3);
//   * receipt numbers gap-free under 20 parallel captures, FY rollover on 1 April;
//   * refund of unused sessions = price minus used consultation amounts (refund job, ledger refund row);
//   * ledger updates and deletes raise; members who are not owner/admin 403, other organisations 404;
//   * reminders (FR-8), offer expiry, the 046 seam (fees_consultations), prepaid one-off absent -> refunded.
// Synthetic users only; skipped without DATABASE_URL.
import { createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { loadEnvConfig } from "@next/env";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { purgeTestAudit } from "./helpers/audit";
import { bookingWorld, type TestProvider } from "./helpers/booking";
import { pdfText } from "./helpers/pdf";
import { ctx, post, type TestUser } from "./helpers/world";

loadEnvConfig(process.cwd(), false, { info: () => {}, error: () => {} });
const enabled = Boolean(process.env.DATABASE_URL) && process.env.SKIP_DB_TESTS !== "1";

const session = vi.hoisted(() => ({ user: null as null | { id: string; email?: string }, cookies: new Map<string, string>() }));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, getAuthenticatedUser: vi.fn(async () => session.user) };
});
vi.mock("next/cache", () => ({ revalidateTag: vi.fn(), unstable_cache: (fn: () => unknown) => fn }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (session.cookies.has(name) ? { name, value: session.cookies.get(name)! } : undefined),
    getAll: () => [...session.cookies].map(([name, value]) => ({ name, value })),
    has: (name: string) => session.cookies.has(name),
  }),
  headers: async () => ({ get: () => null }),
}));

type Json = Record<string, unknown>;
const TZ = "Asia/Kolkata";
const HOUR = 60;
const KEY_SECRET = "t045_key_secret_synthetic";
const WEBHOOK_SECRET = "t045_webhook_secret_synthetic";
const APP = "http://localhost:3999";

async function call(handler: (req: Request, c: never) => Promise<Response>, req: Request, params?: Record<string, string>) {
  const res = await handler(req, (params ? ctx(params) : undefined) as never);
  return { status: res.status, json: (await res.clone().json().catch(() => ({}))) as Json, res };
}

describe.skipIf(!enabled)("packages and family payments (database, route handlers)", { timeout: 240_000 }, () => {
  let sql: Sql;
  let world: ReturnType<typeof bookingWorld>;
  let owner: TestProvider;
  let outsider: TestProvider;
  let member: TestUser;
  let speech: string; // online, ₹800
  let prepaid: string; // online, ₹900 (one-off prepaid)
  let otherService: string; // not covered by the package
  let family: { user: TestUser; childId: string };
  let family2: { user: TestUser; childId: string };
  let family3: { user: TestUser; childId: string };
  let caseId: string;
  let case2: string;
  let case3: string;
  let pkg9000: string;
  let pkg10000: string;
  let pastCursor = -2 * HOUR;
  const past = () => (pastCursor -= HOUR);
  let routes: {
    offer: typeof import("@/app/api/cases/[id]/fees/offer/route");
    request: typeof import("@/app/api/cases/[id]/fees/request-payment/route");
    adjust: typeof import("@/app/api/cases/[id]/fees/adjustments/route");
    refund: typeof import("@/app/api/cases/[id]/fees/refunds/route");
    account: typeof import("@/app/api/cases/[id]/fees/route");
    packages: typeof import("@/app/api/orgs/[id]/packages/route");
    pkg: typeof import("@/app/api/orgs/[id]/packages/[packageId]/route");
    mark: typeof import("@/app/api/appointments/[id]/attendance/route");
    webhook: typeof import("@/app/api/webhooks/razorpay/route");
    callback: typeof import("@/app/api/payments/links/callback/route");
    demo: typeof import("@/app/api/payments/links/demo/route");
    receipt: typeof import("@/app/api/fees/payments/[id]/receipt/route");
    qr: typeof import("@/app/api/fees/payments/[id]/qr/route");
    services: typeof import("@/app/api/provider/services/route");
  };
  let fees: typeof import("@/lib/fees/store");
  let jobs: typeof import("@/lib/fees/jobs");

  const as = (user: TestUser | null) => {
    session.user = user;
    session.cookies.clear();
    session.cookies.set("dnm_tz", TZ);
  };
  const feeUrl = (c: string, tail: string) => `http://localhost/api/cases/${c}/fees${tail}`;
  const offer = (c: string, packageId: string) => call(routes.offer.POST, post(feeUrl(c, "/offer"), { package_id: packageId }), { id: c });
  const mark = (id: string, attendance: string, reason?: string) =>
    call(routes.mark.POST, post(`http://localhost/api/appointments/${id}/attendance`, { attendance, ...(reason ? { reason } : {}) }), { id });

  /** A confirmed past appointment for the child (raw insert: past sessions cannot be booked through 030). */
  async function appt(serviceId: string, childId: string, c: string, guardian: string, offset = past()): Promise<string> {
    const [row] = await sql<{ id: string }[]>`
      insert into appointments (provider_profile_id, org_id, service_id, service_snapshot, child_id, guardian_user_id, case_id, slot, status)
      select s.provider_profile_id, s.org_id, s.id,
             jsonb_build_object('name', s.name, 'duration_min', 30, 'mode', s.mode, 'fee_inr', s.fee_inr, 'payment_mode', s.payment_mode,
                                'buffer_min', 0, 'provider_name', p.display_name, 'time_zone', ${TZ}::text, 'location', null),
             ${childId}::uuid, ${guardian}::uuid, ${c}::uuid,
             tstzrange(now() + make_interval(mins => ${offset}), now() + make_interval(mins => ${offset + 30}), '[)'), 'confirmed'
      from services s join provider_profiles p on p.id = s.provider_profile_id where s.id = ${serviceId}
      returning id`;
    return row.id;
  }
  const balance = async (childId: string) => Number((await sql<{ b: string }[]>`select public.fees_balance(${owner.orgId}, ${childId}) as b`)[0].b);
  const openItemsTotal = async (childId: string) =>
    Number((await sql<{ n: string }[]>`select coalesce(sum(amount_paise), 0)::text as n from public.fees_open_items(${owner.orgId}, ${childId})`)[0].n);
  const ledger = (childId: string) =>
    sql<{ id: string; kind: string; amount_paise: number; note: string; receipt_no: string | null; payment_id: string | null; appointment_id: string | null }[]>`
      select id::text, kind, amount_paise, note, receipt_no, payment_id, appointment_id from family_ledger where org_id = ${owner.orgId} and child_id = ${childId} order by id`;

  function linkPaidBody(linkId: string, paymentId: string, amount: number, extra: Json = {}) {
    return JSON.stringify({
      event: "payment_link.paid",
      created_at: Math.floor(Date.now() / 1000),
      payload: {
        payment_link: { entity: { id: linkId, entity: "payment_link", amount, amount_paid: amount, status: "paid", reference_id: "ref", customer: { contact: "+919876543210" } } },
        payment: { entity: { id: paymentId, entity: "payment", amount, order_id: `order_${paymentId.slice(4)}`, status: "captured", vpa: "parent@okbank", ...extra } },
      },
    });
  }
  function webhookRequest(body: string, opts: { eventId?: string; signature?: string | null } = {}) {
    const headers: Record<string, string> = { "x-razorpay-event-id": opts.eventId ?? `evt_t045${randomUUID().replace(/-/g, "").slice(0, 16)}` };
    const signature = opts.signature === undefined ? createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex") : opts.signature;
    if (signature !== null) headers["x-razorpay-signature"] = signature;
    return new Request("http://localhost/api/webhooks/razorpay", { method: "POST", headers, body });
  }
  const webhook = (body: string, opts: { eventId?: string; signature?: string | null } = {}) => call(routes.webhook.POST, webhookRequest(body, opts));
  const newPaymentId = () => `pay_T045${randomUUID().replace(/-/g, "").slice(0, 14)}`;
  const linkOf = async (paymentId: string) =>
    (await sql<{ razorpay_payment_link_id: string; payment_link_url: string; amount_paise: number; status: string; receipt_no: string | null }[]>`
      select razorpay_payment_link_id, payment_link_url, amount_paise, status, receipt_no from payments where id = ${paymentId}`)[0];

  beforeAll(async () => {
    vi.stubEnv("DEMO_MODE", "true");
    vi.stubEnv("RAZORPAY_KEY_ID", "");
    vi.stubEnv("RAZORPAY_KEY_SECRET", KEY_SECRET);
    vi.stubEnv("RAZORPAY_WEBHOOK_SECRET", WEBHOOK_SECRET);
    vi.stubEnv("NEXT_PUBLIC_APP_URL", APP);
    sql = postgres(process.env.DATABASE_URL as string, { max: 24, prepare: false, onnotice: () => {} });
    const db = (await import("@/lib/db")).supabaseAdmin();
    world = bookingWorld(sql, db, "t045");
    owner = await world.provider("pa");
    outsider = await world.provider("pb");
    speech = await world.service(owner, { duration: 30, payment: "online", fee: 800, name: "Speech therapy (synthetic)" });
    prepaid = await world.service(owner, { duration: 30, payment: "online", fee: 900, name: "Prepaid consult (synthetic)" });
    otherService = await world.service(owner, { duration: 30, payment: "online", fee: 600, name: "OT (synthetic)" });
    member = await world.user("mem", "provider");
    await sql`insert into org_members (org_id, user_id, org_role) values (${owner.orgId}, ${member.id}, 'member')`;
    family = await world.guardian("ga");
    family2 = await world.guardian("gb");
    family3 = await world.guardian("gc");
    caseId = (await world.kase(owner.orgId, { childId: family.childId })).caseId;
    case2 = (await world.kase(owner.orgId, { childId: family2.childId })).caseId;
    case3 = (await world.kase(owner.orgId, { childId: family3.childId })).caseId;
    await sql`insert into case_assignments (case_id, user_id, care_role) values (${caseId}, ${member.id}, 'member')`;
    fees = await import("@/lib/fees/store");
    jobs = await import("@/lib/fees/jobs");
    routes = {
      offer: await import("@/app/api/cases/[id]/fees/offer/route"),
      request: await import("@/app/api/cases/[id]/fees/request-payment/route"),
      adjust: await import("@/app/api/cases/[id]/fees/adjustments/route"),
      refund: await import("@/app/api/cases/[id]/fees/refunds/route"),
      account: await import("@/app/api/cases/[id]/fees/route"),
      packages: await import("@/app/api/orgs/[id]/packages/route"),
      pkg: await import("@/app/api/orgs/[id]/packages/[packageId]/route"),
      mark: await import("@/app/api/appointments/[id]/attendance/route"),
      webhook: await import("@/app/api/webhooks/razorpay/route"),
      callback: await import("@/app/api/payments/links/callback/route"),
      demo: await import("@/app/api/payments/links/demo/route"),
      receipt: await import("@/app/api/fees/payments/[id]/receipt/route"),
      qr: await import("@/app/api/fees/payments/[id]/qr/route"),
      services: await import("@/app/api/provider/services/route"),
    };
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    if (sql && owner) {
      const payments = (await sql<{ id: string }[]>`select id from payments where org_id = ${owner.orgId}`).map((r) => r.id);
      if (payments.length) await sql`delete from outbox_events where aggregate_type = 'payment' and aggregate_id in ${sql(payments)}`;
      await sql`delete from outbox_events where aggregate_type in ('child', 'child_package', 'fee_refund') and payload ->> 'child_id' in ${sql([family.childId, family2.childId, family3.childId])}`;
      await purgeTestAudit(sql, (tx) => tx`delete from audit_events where org_id in ${tx([owner.orgId, outsider.orgId])}`);
      await sql`delete from platform_receipt_counters where fy in ('2001-02', '2002-03')`;
    }
    await world?.cleanup();
    await sql?.end({ timeout: 5 });
  });

  describe("FR-2 pay at clinic is retired", () => {
    it("new services: API 400, database check refuses at_clinic", async () => {
      as(owner.user);
      const res = await call(
        routes.services.POST,
        post("http://localhost/api/provider/services", { name: "Clinic pay (synthetic)", mode: "video", duration_min: 30, fee_inr: 800, payment_mode: "at_clinic", buffer_min: 0 }),
      );
      expect(res.status).toBe(400);
      await expect(
        sql`insert into services (provider_profile_id, org_id, name, mode, duration_min, fee_inr, payment_mode)
            values (${owner.profileId}, ${owner.orgId}, 'Clinic pay (synthetic)', 'video', 30, 800, 'at_clinic')`,
      ).rejects.toThrow(/services_payment_mode_045/);
    });

    it("existing at_clinic services migrate to online (free when they had no fee), with the one-time notice flag", async () => {
      const migration = readFileSync(path.join(process.cwd(), "supabase/migrations/20261113004500_packages_family_payments.sql"), "utf8");
      const statement = migration.match(/update public\.services\s+set payment_mode = [\s\S]*?where payment_mode = 'at_clinic';/)?.[0];
      expect(statement).toBeTruthy();
      const rollback = new Error("rollback");
      await sql
        .begin(async (tx) => {
          await tx`alter table services drop constraint services_payment_mode_045`;
          const [paid] = await tx<{ id: string }[]>`
            insert into services (provider_profile_id, org_id, name, mode, duration_min, fee_inr, payment_mode)
            values (${owner.profileId}, ${owner.orgId}, 'Legacy clinic pay (synthetic)', 'video', 30, 700, 'at_clinic') returning id`;
          const [nofee] = await tx<{ id: string }[]>`
            insert into services (provider_profile_id, org_id, name, mode, duration_min, fee_inr, payment_mode)
            values (${owner.profileId}, ${owner.orgId}, 'Legacy no fee (synthetic)', 'video', 30, 0, 'at_clinic') returning id`;
          await tx.unsafe(statement as string);
          const rows = await tx<{ id: string; payment_mode: string; migrated: boolean }[]>`
            select id, payment_mode, migrated_from_at_clinic_at is not null as migrated from services where id in (${paid.id}, ${nofee.id})`;
          expect(rows.find((r) => r.id === paid.id)).toMatchObject({ payment_mode: "online", migrated: true });
          expect(rows.find((r) => r.id === nofee.id)).toMatchObject({ payment_mode: "free", migrated: true });
          const { atClinicNoticeDue } = await import("@/lib/booking/store");
          expect(typeof atClinicNoticeDue).toBe("function");
          throw rollback;
        })
        .catch((err) => {
          if (err !== rollback) throw err;
        });
      expect((await sql`select count(*)::int as n from services where payment_mode = 'at_clinic'`)[0].n).toBe(0);
    });
  });

  describe("packages catalogue (FR-7)", () => {
    it("owner adds packages; member 403; other org 404; foreign services 400", async () => {
      as(owner.user);
      const body = { name: "Speech 12 (synthetic)", session_count: 12, price_inr: 9000, validity_days: 30, service_ids: [speech] };
      const created = await call(routes.packages.POST, post(`http://localhost/api/orgs/${owner.orgId}/packages`, body), { id: owner.orgId });
      expect(created.status).toBe(201);
      pkg9000 = (created.json.package as Json).id as string;
      const second = await call(
        routes.packages.POST,
        post(`http://localhost/api/orgs/${owner.orgId}/packages`, { ...body, name: "Speech 12 at 10k (synthetic)", price_inr: 10000 }),
        { id: owner.orgId },
      );
      pkg10000 = (second.json.package as Json).id as string;
      const foreign = await world.service(outsider, { payment: "online", fee: 500 });
      expect((await call(routes.packages.POST, post(`http://localhost/api/orgs/${owner.orgId}/packages`, { ...body, service_ids: [foreign] }), { id: owner.orgId })).status).toBe(400);
      expect((await call(routes.packages.POST, post(`http://localhost/api/orgs/${owner.orgId}/packages`, { ...body, session_count: 61 }), { id: owner.orgId })).status).toBe(400);
      as(member);
      expect((await call(routes.packages.GET, new Request("http://localhost/x"), { id: owner.orgId })).status).toBe(200);
      expect((await call(routes.packages.POST, post(`http://localhost/api/orgs/${owner.orgId}/packages`, body), { id: owner.orgId })).status).toBe(403);
      expect((await call(routes.pkg.PATCH, post("http://localhost/x", { active: false }, "PATCH"), { id: owner.orgId, packageId: pkg9000 })).status).toBe(403);
      as(outsider.user);
      expect((await call(routes.packages.POST, post(`http://localhost/api/orgs/${owner.orgId}/packages`, body), { id: owner.orgId })).status).toBe(404);
      expect(
        (await sql`select count(*)::int as n from audit_events where org_id = ${owner.orgId} and action = 'fees.packages_changed'`)[0].n,
      ).toBe(2);
    });
  });

  describe("authz", () => {
    it("members who are not owner/admin get 403; other organisations 404; guardians 403; anonymous 401", async () => {
      as(member);
      expect((await offer(caseId, pkg9000)).status).toBe(403);
      expect((await call(routes.request.POST, post(feeUrl(caseId, "/request-payment")), { id: caseId })).status).toBe(403);
      expect((await call(routes.adjust.POST, post(feeUrl(caseId, "/adjustments"), { amount_inr: -100, reason: "Goodwill" }), { id: caseId })).status).toBe(403);
      expect((await call(routes.refund.POST, post(feeUrl(caseId, "/refunds"), { kind: "session", appointment_id: randomUUID(), reason: "Test" }), { id: caseId })).status).toBe(403);
      expect((await call(routes.account.GET, new Request("http://localhost/x"), { id: caseId })).status).toBe(200);
      as(outsider.user);
      expect((await offer(caseId, pkg9000)).status).toBe(404);
      expect((await call(routes.account.GET, new Request("http://localhost/x"), { id: caseId })).status).toBe(404);
      as(family.user);
      expect((await offer(caseId, pkg9000)).status).toBe(403);
      as(null);
      expect((await offer(caseId, pkg9000)).status).toBe(401);
      as(owner.user);
      expect((await offer(caseId, randomUUID())).status).toBe(404);
    });
  });

  describe("E-1 package at the desk (FR-3, FR-6)", () => {
    let paymentId: string;
    let childPackageId: string;

    it("Offer package -> pending package + payment link (short URL only) + payment request to the guardian; QR for staff", async () => {
      as(owner.user);
      const res = await offer(caseId, pkg9000);
      expect(res.status).toBe(201);
      expect(res.json.amount_paise).toBe(900000);
      paymentId = res.json.payment_id as string;
      childPackageId = res.json.child_package_id as string;
      expect(res.json.url).toMatch(new RegExp(`^${APP}/pay/demo/plink_DEMO[0-9a-f]{14}$`));
      expect(String(res.json.url)).not.toContain("synthetic");
      const [cp] = await sql`select status, sessions_total, sessions_used, price_paise, offer_expires_at > now() + interval '6 days' as week from child_packages where id = ${childPackageId}`;
      expect(cp).toMatchObject({ status: "pending_payment", sessions_total: 12, sessions_used: 0, price_paise: 900000, week: true });
      const events = await sql`select topic, payload from outbox_events where aggregate_type = 'payment' and aggregate_id = ${paymentId}`;
      expect(events.map((e) => e.topic)).toEqual(["fees.payment_request"]);
      expect(events[0].payload).toEqual({ payment_id: paymentId, child_id: family.childId, kind: "package" });
      // A second offer of the same package while the first is open -> 409.
      expect((await offer(caseId, pkg9000)).json.code).toBe("offer_pending");
      // Show QR: staff with case access (also the assigned member), not other organisations.
      const qr = await call(routes.qr.GET, new Request("http://localhost/x"), { id: paymentId });
      expect(qr.status).toBe(200);
      expect(qr.res.headers.get("content-type")).toBe("image/svg+xml");
      as(outsider.user);
      expect((await call(routes.qr.GET, new Request("http://localhost/x"), { id: paymentId })).status).toBe(404);
    });

    it("webhook payment_link.paid: tampered -> 401; valid -> active + charge + payment + receipt; replay -> duplicate", async () => {
      const link = await linkOf(paymentId);
      const pay = newPaymentId();
      const body = linkPaidBody(link.razorpay_payment_link_id, pay, 900000);
      const tampered = await call(
        routes.webhook.POST,
        webhookRequest(body.replace('"amount":900000', '"amount":100'), { signature: createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex") }),
      );
      expect(tampered.status).toBe(401);
      expect((await linkOf(paymentId)).status).toBe("created");
      const eventId = `evt_t045${randomUUID().replace(/-/g, "").slice(0, 16)}`;
      const first = await webhook(body, { eventId });
      expect(first.status).toBe(200);
      expect(first.json.outcome).toBe("package_active");
      const replay = await webhook(body, { eventId });
      expect(replay.json).toEqual({ received: true, duplicate: true });
      // The same payment through the signed redirect is idempotent too.
      const again = await fees.applyLinkPaid({ linkId: link.razorpay_payment_link_id, paymentId: pay, source: "callback" });
      expect(again.outcome).toBe("already_captured");

      const [cp] = await sql`select status, starts_on::text as starts_on, expires_on - starts_on as days, payment_id from child_packages where id = ${childPackageId}`;
      expect(cp).toMatchObject({ status: "active", days: 29, payment_id: paymentId });
      const after = await linkOf(paymentId);
      expect(after.status).toBe("captured");
      expect(after.receipt_no).toMatch(/^DNM\/\d{4}-\d{2}\/\d{6}$/);
      const rows = await ledger(family.childId);
      expect(rows.map((r) => [r.kind, r.amount_paise, r.note])).toEqual([
        ["charge", 900000, "package"],
        ["payment", 900000, "package"],
      ]);
      expect(rows[1].receipt_no).toBe(after.receipt_no);
      expect(await balance(family.childId)).toBe(0);
      // One audit row for the capture; the stored webhook payload has no contact / VPA.
      expect((await sql`select count(*)::int as n from audit_events where action = 'payment.captured' and entity_id = ${paymentId}`)[0].n).toBe(1);
      const [stored] = await sql`select payload from payment_events where razorpay_event_id = ${eventId}`;
      expect(JSON.stringify(stored.payload)).not.toMatch(/9876543210|okbank/);
      // The guardian's receipt notification (FR-6).
      const receipt = await sql`select topic, payload from outbox_events where dedup_key = ${`payment:${paymentId}:receipt`}`;
      expect(receipt).toHaveLength(1);
      expect(receipt[0].payload).toEqual({ payment_id: paymentId, child_id: family.childId });
    });

    it("receipt PDF reads 'on behalf of <centre>': guardian and staff yes, another guardian / other org 404", async () => {
      const [org] = await sql<{ name: string }[]>`select name from organizations where id = ${owner.orgId}`;
      as(family.user);
      const res = await call(routes.receipt.GET, new Request("http://localhost/x"), { id: paymentId });
      expect(res.status).toBe(200);
      expect(res.res.headers.get("content-type")).toBe("application/pdf");
      const text = pdfText(new Uint8Array(await res.res.arrayBuffer()));
      expect(text).toContain(`Paid to DoctorNearMe on behalf of ${org.name}`);
      expect(text).toContain((await linkOf(paymentId)).receipt_no as string);
      expect(text).toContain("Speech 12 (synthetic)");
      expect(text).not.toContain("child (synthetic)");
      as(owner.user);
      expect((await call(routes.receipt.GET, new Request("http://localhost/x"), { id: paymentId })).status).toBe(200);
      as(family2.user);
      expect((await call(routes.receipt.GET, new Request("http://localhost/x"), { id: paymentId })).status).toBe(404);
      as(outsider.user);
      expect((await call(routes.receipt.GET, new Request("http://localhost/x"), { id: paymentId })).status).toBe(404);
    });

    it("E-2: 3 present sessions -> 9 sessions left, each consultation 75000 paise; absent (not billable) uses nothing", async () => {
      as(owner.user);
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        const id = await appt(speech, family.childId, caseId, family.user.id);
        const r = await mark(id, "present");
        expect(r.status).toBe(200);
        expect(r.json.billable).toBe(true);
        ids.push(id);
      }
      const absent = await appt(speech, family.childId, caseId, family.user.id);
      expect((await mark(absent, "absent")).json.billable).toBe(false);
      const amounts = await sql<{ consultation_amount_paise: number | null; child_package_id: string | null }[]>`
        select consultation_amount_paise, child_package_id from appointments where id in ${sql([...ids, absent])} order by lower(slot) desc`;
      expect(amounts.slice(0, 3).map((a) => a.consultation_amount_paise)).toEqual([75000, 75000, 75000]);
      expect(amounts.slice(0, 3).every((a) => a.child_package_id === childPackageId)).toBe(true);
      expect(amounts[3]).toEqual({ consultation_amount_paise: null, child_package_id: null });
      const [cp] = await sql`select sessions_used, status from child_packages where id = ${childPackageId}`;
      expect(cp).toEqual({ sessions_used: 3, status: "active" });
      const account = await fees.loadAccount(owner.orgId, family.childId);
      expect(account.packages[0].sessions_total - account.packages[0].sessions_used).toBe(9);
      // A service the package does not cover is charged instead.
      const ot = await appt(otherService, family.childId, caseId, family.user.id);
      await mark(ot, "present");
      expect((await sql`select consultation_amount_paise as a, child_package_id from appointments where id = ${ot}`)[0]).toEqual({ a: 60000, child_package_id: null });
      expect(await balance(family.childId)).toBe(60000);
      // Correction present -> absent: the package session comes back, then present again uses it again.
      expect((await mark(ids[0], "absent", "Marked the wrong child")).status).toBe(200);
      expect((await sql`select sessions_used from child_packages where id = ${childPackageId}`)[0].sessions_used).toBe(2);
      expect((await mark(ids[0], "present", "It was the right child after all")).status).toBe(200);
      expect((await sql`select sessions_used from child_packages where id = ${childPackageId}`)[0].sessions_used).toBe(3);
      // Correcting the OT charge away (not paid yet) -> a credit cancels it.
      expect((await mark(ot, "absent", "Did not come")).status).toBe(200);
      expect(await balance(family.childId)).toBe(0);
      expect(await openItemsTotal(family.childId)).toBe(0);
      // 046 seam: the package sessions are funded by the package payment.
      const seam = await fees.listConsultations({ orgId: owner.orgId });
      const mine = seam.filter((c) => ids.includes(c.appointment_id));
      expect(mine).toHaveLength(3);
      expect(mine.every((c) => c.source === "package" && c.payment_id === paymentId && c.consultation_amount_paise === 75000 && c.razorpay_payment_id?.startsWith("pay_T045"))).toBe(true);
    });

    it("FR-9 refund of unused sessions: 900000 - 3 x 75000 = 675000 (refund job, ledger refund row, balance unchanged)", async () => {
      as(owner.user);
      const res = await call(routes.refund.POST, post(feeUrl(caseId, "/refunds"), { kind: "package", child_package_id: childPackageId, reason: "Family moved away" }), { id: caseId });
      expect(res.status).toBe(201);
      expect(res.json).toMatchObject({ amount_paise: 675000, payment_id: paymentId, via: "fee_refund" });
      expect((await sql`select status from child_packages where id = ${childPackageId}`)[0].status).toBe("cancelled");
      // A second refund of the same package -> nothing to refund.
      expect((await call(routes.refund.POST, post(feeUrl(caseId, "/refunds"), { kind: "package", child_package_id: childPackageId, reason: "Again" }), { id: caseId })).status).toBe(409);
      const run = await jobs.runFeeJobs({ refundIds: [res.json.fee_refund_id as string] });
      expect(run.refunds.processed).toBe(1);
      const [r] = await sql`select status, razorpay_refund_id from fee_refunds where id = ${res.json.fee_refund_id as string}`;
      expect(r.status).toBe("processed");
      expect(r.razorpay_refund_id).toMatch(/^rfnd_DEMO/);
      const rows = await ledger(family.childId);
      expect(rows.filter((x) => x.kind === "refund").map((x) => x.amount_paise)).toEqual([675000]);
      expect(await balance(family.childId)).toBe(0);
      expect((await sql`select count(*)::int as n from audit_events where action = 'fees.refund_requested' and org_id = ${owner.orgId}`)[0].n).toBe(1);
      const seam = await fees.listConsultations({ orgId: owner.orgId });
      expect(seam.find((c) => c.payment_id === paymentId)?.refunded_paise).toBe(675000);
    });
  });

  describe("FR-4 package remainder and used_up", () => {
    it("12 present sessions on ₹10,000 / 12 -> used_up; 83333 x 11 + 83337; the 13th is charged", async () => {
      as(owner.user);
      const res = await offer(case2, pkg10000);
      expect(res.status).toBe(201);
      const link = await linkOf(res.json.payment_id as string);
      expect((await webhook(linkPaidBody(link.razorpay_payment_link_id, newPaymentId(), 1000000))).json.outcome).toBe("package_active");
      const ids: string[] = [];
      for (let i = 0; i < 12; i++) {
        const id = await appt(speech, family2.childId, case2, family2.user.id);
        expect((await mark(id, "present")).status).toBe(200);
        ids.push(id);
        // FR-8: with 2 sessions left the package reminder is due (once).
        if (i === 9) {
          await jobs.runFeeJobs();
          await jobs.runFeeJobs();
        }
      }
      const rows = await sql<{ a: number }[]>`select consultation_amount_paise as a from appointments where id in ${sql(ids)} order by attendance_marked_at, id`;
      const amounts = rows.map((r) => r.a).sort((x, y) => x - y);
      expect(amounts.slice(0, 11)).toEqual(Array(11).fill(83333));
      expect(amounts[11]).toBe(83337);
      expect(amounts.reduce((s, n) => s + n, 0)).toBe(1000000);
      const [cp] = await sql`select status, sessions_used from child_packages where id = ${res.json.child_package_id as string}`;
      expect(cp).toEqual({ status: "used_up", sessions_used: 12 });
      const extra = await appt(speech, family2.childId, case2, family2.user.id);
      await mark(extra, "present");
      expect((await sql`select consultation_amount_paise as a from appointments where id = ${extra}`)[0].a).toBe(80000);
      expect(await balance(family2.childId)).toBe(80000);
    });
  });

  describe("E-3 per-session charge and pay the balance (FR-4, FR-5)", () => {
    it("a billable session without a package -> a charge + a balance link; paying it (demo page + signed redirect) -> balance 0", async () => {
      as(owner.user);
      const id = await appt(speech, family3.childId, case3, family3.user.id);
      expect((await mark(id, "present")).json.billable).toBe(true);
      const rows = await ledger(family3.childId);
      expect(rows.map((r) => [r.kind, r.amount_paise, r.appointment_id])).toEqual([["charge", 80000, id]]);
      expect(await balance(family3.childId)).toBe(80000);
      await jobs.runFeeJobs();
      const account = await fees.loadAccount(owner.orgId, family3.childId);
      expect(account.balance_paise).toBe(80000);
      expect(account.balance_link?.amount_paise).toBe(80000);
      const linkPayment = account.balance_link?.payment_id as string;
      expect((await sql`select ledger_id::text from fee_link_items where payment_id = ${linkPayment}`).map((r) => r.ledger_id)).toEqual([rows[0].id]);
      // A second session is added to the open balance: the link is replaced by one for 1600.
      const id2 = await appt(speech, family3.childId, case3, family3.user.id);
      await mark(id2, "present");
      await jobs.runFeeJobs();
      const account2 = await fees.loadAccount(owner.orgId, family3.childId);
      expect(account2.balance_link?.amount_paise).toBe(160000);
      expect((await linkOf(linkPayment)).status).toBe("failed");
      // Request payment (owner) reuses the open link and notifies the guardian.
      const requested = await call(routes.request.POST, post(feeUrl(case3, "/request-payment")), { id: case3 });
      expect(requested.status).toBe(200);
      expect(requested.json.payment_id).toBe(account2.balance_link?.payment_id);
      // The guardian pays on the (demo) payment page: success -> signed redirect -> callback -> captured.
      const linkId = (await linkOf(account2.balance_link?.payment_id as string)).razorpay_payment_link_id;
      as(null);
      const demo = await call(routes.demo.POST, post("http://localhost/api/payments/links/demo", { link_id: linkId, outcome: "success" }));
      expect(demo.status).toBe(200);
      const url = new URL(demo.json.callback_url as string, "http://localhost");
      const forged = new URL(url);
      forged.searchParams.set("razorpay_payment_link_status", "paid");
      forged.searchParams.set("razorpay_payment_id", newPaymentId());
      const bad = await routes.callback.GET(new Request(forged.toString()));
      expect(bad.headers.get("location")).toContain("/pay/done?state=invalid");
      as(family3.user);
      const done = await routes.callback.GET(new Request(url.toString()));
      expect(done.status).toBe(303);
      expect(done.headers.get("location")).toBe(`${APP}/family/children/${family3.childId}/payments?paid=1`);
      expect(await balance(family3.childId)).toBe(0);
      expect(await openItemsTotal(family3.childId)).toBe(0);
      const after = await ledger(family3.childId);
      expect(after.filter((r) => r.kind === "payment").map((r) => [r.amount_paise, r.note])).toEqual([[160000, "balance"]]);
      expect(after.find((r) => r.kind === "payment")?.receipt_no).toMatch(/^DNM\//);
      // 046 seam: both sessions are funded by the balance payment.
      const seam = (await fees.listConsultations({ orgId: owner.orgId })).filter((c) => [id, id2].includes(c.appointment_id));
      expect(seam.map((c) => [c.source, c.consultation_amount_paise, c.payment_id])).toEqual([
        ["per_session", 80000, account2.balance_link?.payment_id],
        ["per_session", 80000, account2.balance_link?.payment_id],
      ]);
      // A paid session made non-billable later -> refunded from that payment (not a credit).
      as(owner.user);
      expect((await mark(id2, "absent", "Was a make-up session")).status).toBe(200);
      const [fr] = await sql`select amount_paise, reason, payment_id from fee_refunds where appointment_id = ${id2}`;
      expect(fr).toEqual({ amount_paise: 80000, reason: "not_billable", payment_id: account2.balance_link?.payment_id });
      await jobs.runFeeJobs();
      expect((await ledger(family3.childId)).filter((r) => r.kind === "refund").map((r) => r.amount_paise)).toEqual([80000]);
      expect(await balance(family3.childId)).toBe(0);
    });

    it("adjustments: reason required, signed, audited; the balance link follows", async () => {
      as(owner.user);
      expect((await call(routes.adjust.POST, post(feeUrl(case3, "/adjustments"), { amount_inr: 250 }), { id: case3 })).status).toBe(400);
      const res = await call(routes.adjust.POST, post(feeUrl(case3, "/adjustments"), { amount_inr: 250, reason: "Assessment booklet (synthetic)" }), { id: case3 });
      expect(res.status).toBe(201);
      expect(res.json.balance_paise).toBe(25000);
      await jobs.runFeeJobs();
      expect((await fees.loadAccount(owner.orgId, family3.childId)).balance_link?.amount_paise).toBe(25000);
      const credit = await call(routes.adjust.POST, post(feeUrl(case3, "/adjustments"), { amount_inr: -250, reason: "Booklet waived" }), { id: case3 });
      expect(credit.json.balance_paise).toBe(0);
      await jobs.runFeeJobs();
      expect((await fees.loadAccount(owner.orgId, family3.childId)).balance_link).toBeNull();
      expect((await sql`select count(*)::int as n from audit_events where action = 'fees.adjustment_added' and org_id = ${owner.orgId}`)[0].n).toBe(2);
    });
  });

  describe("D-3 / FR-10 the ledger is append-only", () => {
    it("updates and deletes raise", async () => {
      const [row] = await sql<{ id: string }[]>`select id::text from family_ledger where org_id = ${owner.orgId} limit 1`;
      await expect(sql`update family_ledger set amount_paise = 1 where id = ${row.id}`).rejects.toThrow(/append-only/);
      await expect(sql`delete from family_ledger where id = ${row.id}`).rejects.toThrow(/append-only/);
      await expect(sql`truncate family_ledger`).rejects.toThrow();
    });
  });

  describe("NFR-2 receipts", () => {
    it("gap-free under 20 parallel captures; the financial year rolls over on 1 April", async () => {
      await sql`delete from platform_receipt_counters where fy in ('2001-02', '2002-03')`;
      const links: string[] = [];
      for (let i = 0; i < 22; i++) {
        const linkId = `plink_T045r${randomUUID().replace(/-/g, "").slice(0, 12)}`;
        await sql`
          insert into payments (purpose, org_id, child_id, gateway, razorpay_payment_link_id, payment_link_url, amount_paise, status)
          values ('balance', ${owner.orgId}, null, 'demo', ${linkId}, ${`https://rzp.io/i/${linkId.slice(6)}`}, 100, 'created')`;
        links.push(linkId);
      }
      // 20 captures at once on separate connections, all in FY 2001-02 (the gateway's payment time). No child on these
      // rows, so no ledger rows or receipt messages (they would only add noise to the shared outbox).
      const at = new Date("2001-06-01T10:00:00+05:30");
      const results = await Promise.all(
        links.slice(0, 20).map((linkId) =>
          sql.begin((tx) => tx<{ r: { receipt_no: string } }[]>`select public.fees_apply_link_paid(${linkId}, ${newPaymentId()}, null, ${at}) as r`),
        ),
      );
      const numbers = results.map((r) => r[0].r.receipt_no).sort();
      expect(numbers).toEqual(Array.from({ length: 20 }, (_, i) => `DNM/2001-02/${String(i + 1).padStart(6, "0")}`));
      // A capture that rolls back gives its number back (gap-free).
      await sql
        .begin(async (tx) => {
          await tx`select public.fees_apply_link_paid(${links[20]}, ${newPaymentId()}, null, ${new Date("2002-03-31T23:59:00+05:30")})`;
          throw new Error("rollback");
        })
        .catch(() => undefined);
      const [last] = await sql<{ r: { receipt_no: string } }[]>`
        select public.fees_apply_link_paid(${links[20]}, ${newPaymentId()}, null, ${new Date("2002-03-31T23:59:00+05:30")}) as r`;
      expect(last.r.receipt_no).toBe("DNM/2001-02/000021");
      const [april] = await sql<{ r: { receipt_no: string } }[]>`
        select public.fees_apply_link_paid(${links[21]}, ${newPaymentId()}, null, ${new Date("2002-04-01T00:00:30+05:30")}) as r`;
      expect(april.r.receipt_no).toBe("DNM/2002-03/000001");
    });
  });

  describe("prepaid one-offs (031) in the ledger", () => {
    it("capture -> charge + payment with a receipt; absent and not billable -> refunded in full (billable decides)", async () => {
      const id = await appt(prepaid, family2.childId, case2, family2.user.id);
      const orderId = `order_T045${randomUUID().replace(/-/g, "").slice(0, 12)}`;
      await sql`insert into payments (appointment_id, gateway, razorpay_order_id, amount_paise, status) values (${id}, 'demo', ${orderId}, 90000, 'created')`;
      const { applyPaymentCaptured } = await import("@/lib/payments/store");
      const r = await applyPaymentCaptured({ orderId, paymentId: newPaymentId(), source: "demo" });
      expect(r.outcome).toBe("already_confirmed");
      const [p] = await sql`select id, status, receipt_no from payments where razorpay_order_id = ${orderId}`;
      expect(p.receipt_no).toMatch(/^DNM\//);
      const rows = (await ledger(family2.childId)).filter((x) => x.payment_id === p.id);
      expect(rows.map((x) => [x.kind, x.amount_paise])).toEqual([
        ["charge", 90000],
        ["payment", 90000],
      ]);
      as(owner.user);
      expect((await mark(id, "absent")).json.billable).toBe(false);
      const [after] = await sql`select status, refund_reason from payments where id = ${p.id}`;
      expect(after).toEqual({ status: "refund_pending", refund_reason: "not_billable" });
      const { runPaymentJobs } = await import("@/lib/payments/jobs");
      await runPaymentJobs({ paymentIds: [p.id as string] });
      const refunded = (await ledger(family2.childId)).filter((x) => x.payment_id === p.id && x.kind === "refund");
      expect(refunded.map((x) => x.amount_paise)).toEqual([90000]);
    });
  });

  describe("FR-8 reminders and FR-3 offer expiry", () => {
    it("one balance reminder 3 days after an unpaid session; an unpaid offer expires after 7 days", async () => {
      as(owner.user);
      const old = await appt(speech, family2.childId, case2, family2.user.id, -4 * 24 * HOUR);
      await mark(old, "present");
      await jobs.runFeeJobs();
      await jobs.runFeeJobs();
      const reminders = await sql`select dedup_key from outbox_events where topic = 'fees.balance_reminder' and payload ->> 'child_id' = ${family2.childId}`;
      expect(reminders).toHaveLength(1);
      const pkgReminders = await sql`select dedup_key from outbox_events where topic = 'fees.package_reminder' and payload ->> 'child_id' = ${family2.childId}`;
      expect(pkgReminders).toHaveLength(1);
      expect((await fees.listBalancesDue([owner.orgId])).find((r) => r.child_id === family2.childId)?.overdue).toBe(true);

      const res = await offer(case2, pkg9000);
      expect(res.status).toBe(201);
      await sql`update child_packages set offer_expires_at = now() - interval '1 minute' where id = ${res.json.child_package_id as string}`;
      const run = await jobs.runFeeJobs();
      expect(run.expired_offers).toBeGreaterThanOrEqual(1);
      expect((await sql`select status from child_packages where id = ${res.json.child_package_id as string}`)[0].status).toBe("cancelled");
      expect((await linkOf(res.json.payment_id as string)).status).toBe("failed");
      // The balance identity holds on every account of the suite.
      for (const child of [family.childId, family2.childId, family3.childId]) {
        expect(await balance(child)).toBe(await openItemsTotal(child));
      }
    });
  });
});
