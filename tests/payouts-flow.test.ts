// Ticket 046 against the real database through the route handlers (DEMO_MODE: the fake gateway also fakes Route
// transfers, reversals and their signed webhooks):
//   * FR-2 / FR-8 / E-3: org B (pending_kyc) cannot publish an online service or a package (409), its paid services are
//     hidden from booking; the admin activates the account, the owner accepts the fee (once per version); the waiver
//     makes the fee 0;
//   * FR-3 / NFR-1 / E-1: a ₹9,000 / 12 package -> one payout item per present session (₹750: fee ₹75, GST ₹13.50,
//     net ₹661.50), exactly one under 3 retries, transferred; transfers never exceed the payment (NFR-3);
//   * FR-4 / E-2: a ₹1,000 one-off transfers only once delivered (fee ₹100, GST ₹18, net ₹882); a provider no-show -> no
//     transfer, refunded by 031;
//   * FR-5: refunds after a transfer reverse it first (045 session refund, 031 full refund);
//   * FR-6: package expiry pay_centre vs refund_family;
//   * transfer.failed webhooks -> retries with back-off -> admins alerted and see it in /admin/payouts -> Retry;
//   * FR-10 reconciliation flags a mismatch; FR-7 / E-4 the monthly invoice DNM-INV/2026-27/<n> (+ PDF, CSV);
//   * members 403 (API and page), other organisations 404, non-admins 403 on /api/admin/payouts.
// Synthetic users only; skipped without DATABASE_URL.
import { createHmac, randomUUID } from "node:crypto";
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
  return {
    ...actual,
    getAuthenticatedUser: vi.fn(async () => session.user),
    requirePageUser: vi.fn(async () => {
      if (!session.user) throw new Error("NEXT_REDIRECT");
      return session.user;
    }),
  };
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
const WEBHOOK_SECRET = "t046_webhook_secret_synthetic";
const APP = "http://localhost:3999";
const ACC_A = "acc_T046orgA0001";
const ACC_B = "acc_T046orgB0001";
const ACC_FAIL = "acc_T046FAIL0001";

async function call(handler: (req: Request, c: never) => Promise<Response>, req: Request, params?: Record<string, string>) {
  const res = await handler(req, (params ? ctx(params) : undefined) as never);
  return { status: res.status, json: (await res.clone().json().catch(() => ({}))) as Json, res };
}

/** The last day of the current month in Asia/Kolkata (YYYY-MM-DD). */
function endOfMonthIst(): string {
  const [y, m] = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit" }).format(new Date()).split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${y}-${String(m).padStart(2, "0")}-${String(last).padStart(2, "0")}`;
}

type Item = {
  id: string;
  appointment_id: string | null;
  kind: string;
  payment_id: string;
  consultation_paise: number;
  fee_paise: number;
  gst_paise: number;
  net_paise: number;
  status: string;
  fee_waived: boolean;
  attempts: number;
  razorpay_transfer_id: string | null;
  reverse_reason: string | null;
  failure_reason: string | null;
};

describe.skipIf(!enabled)("payouts and the platform fee (database, route handlers)", { timeout: 300_000 }, () => {
  let sql: Sql;
  let world: ReturnType<typeof bookingWorld>;
  let orgA: TestProvider;
  let orgB: TestProvider;
  let outsider: TestProvider;
  let admin: TestUser;
  let member: TestUser;
  let speechA: string; // online ₹800 (package service)
  let oneOffA: string; // online ₹1,000 (prepaid one-off)
  let famA: { user: TestUser; childId: string };
  let famA2: { user: TestUser; childId: string };
  let famA3: { user: TestUser; childId: string };
  let famB: { user: TestUser; childId: string };
  let caseA: string;
  let caseA2: string;
  let caseA3: string;
  let caseB: string;
  let pkg9000: string;
  let counterBefore: number | null = null;
  let pastCursor = -2 * HOUR;
  const past = () => (pastCursor -= HOUR);
  let routes: {
    offer: typeof import("@/app/api/cases/[id]/fees/offer/route");
    refund: typeof import("@/app/api/cases/[id]/fees/refunds/route");
    packages: typeof import("@/app/api/orgs/[id]/packages/route");
    mark: typeof import("@/app/api/appointments/[id]/attendance/route");
    webhook: typeof import("@/app/api/webhooks/razorpay/route");
    services: typeof import("@/app/api/provider/services/route");
    hold: typeof import("@/app/api/appointments/hold/route");
    payouts: typeof import("@/app/api/orgs/[id]/payouts/route");
    accept: typeof import("@/app/api/orgs/[id]/payouts/accept/route");
    settings: typeof import("@/app/api/orgs/[id]/payouts/settings/route");
    exportCsv: typeof import("@/app/api/orgs/[id]/payouts/export/route");
    invoicePdf: typeof import("@/app/api/orgs/[id]/payouts/invoices/[invoiceId]/pdf/route");
    adminOverview: typeof import("@/app/api/admin/payouts/route");
    adminAccount: typeof import("@/app/api/admin/payouts/orgs/[orgId]/account/route");
    adminPolicy: typeof import("@/app/api/admin/payouts/orgs/[orgId]/policy/route");
    adminRetry: typeof import("@/app/api/admin/payouts/items/[id]/retry/route");
  };
  let payoutJobs: typeof import("@/lib/payouts/jobs");
  let feeJobs: typeof import("@/lib/fees/jobs");
  let paymentJobs: typeof import("@/lib/payments/jobs");

  const as = (user: TestUser | null) => {
    session.user = user;
    session.cookies.clear();
    session.cookies.set("dnm_tz", TZ);
  };
  const mark = (id: string, attendance: string, reason?: string) =>
    call(routes.mark.POST, post(`http://localhost/api/appointments/${id}/attendance`, { attendance, ...(reason ? { reason } : {}) }), { id });
  const run = (orgIds: string[] = [orgA.orgId, orgB.orgId]) => payoutJobs.runPayoutJobs({ sql, orgIds });
  const items = (orgId: string) =>
    sql<Item[]>`select id, appointment_id, kind, payment_id, consultation_paise, fee_paise, gst_paise, net_paise, status, fee_waived, attempts,
                       razorpay_transfer_id, reverse_reason, failure_reason
                from payout_items where org_id = ${orgId} order by created_at, unit_no nulls first`;
  const itemFor = async (appointmentId: string) => (await sql<Item[]>`select * from payout_items where appointment_id = ${appointmentId}`)[0];
  const setAccount = (orgId: string, body: Json) =>
    call(routes.adminAccount.PUT, post(`http://localhost/api/admin/payouts/orgs/${orgId}/account`, body, "PUT"), { orgId });
  const setPolicy = (orgId: string, body: Json) =>
    call(routes.adminPolicy.PUT, post(`http://localhost/api/admin/payouts/orgs/${orgId}/policy`, body, "PUT"), { orgId });
  const payoutsOf = (orgId: string) => call(routes.payouts.GET, new Request("http://localhost/x"), { id: orgId });
  const acceptCurrent = async (orgId: string) => {
    const [row] = await sql<{ version: number }[]>`select version from platform_fee_policies where org_id = ${orgId}`;
    const version = row?.version ?? 0;
    return call(routes.accept.POST, post(`http://localhost/api/orgs/${orgId}/payouts/accept`, { policy_version: version }), { id: orgId });
  };

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

  const newPaymentId = () => `pay_T046${randomUUID().replace(/-/g, "").slice(0, 14)}`;
  function linkPaidBody(linkId: string, paymentId: string, amount: number) {
    return JSON.stringify({
      event: "payment_link.paid",
      created_at: Math.floor(Date.now() / 1000),
      payload: {
        payment_link: { entity: { id: linkId, entity: "payment_link", amount, amount_paid: amount, status: "paid", reference_id: "ref" } },
        payment: { entity: { id: paymentId, entity: "payment", amount, order_id: `order_${paymentId.slice(4)}`, status: "captured" } },
      },
    });
  }
  function webhook(body: string) {
    const headers = {
      "x-razorpay-event-id": `evt_t046${randomUUID().replace(/-/g, "").slice(0, 16)}`,
      "x-razorpay-signature": createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex"),
    };
    return call(routes.webhook.POST, new Request("http://localhost/api/webhooks/razorpay", { method: "POST", headers, body }));
  }

  /** Offer + pay a package (signed payment_link.paid webhook): returns the child package and payments row ids. */
  async function buyPackage(c: string, packageId: string, price: number): Promise<{ childPackageId: string; paymentId: string }> {
    as(orgA.user);
    const res = await call(routes.offer.POST, post(`http://localhost/api/cases/${c}/fees/offer`, { package_id: packageId }), { id: c });
    expect(res.status).toBe(201);
    const paymentId = res.json.payment_id as string;
    const [link] = await sql<{ razorpay_payment_link_id: string }[]>`select razorpay_payment_link_id from payments where id = ${paymentId}`;
    expect((await webhook(linkPaidBody(link.razorpay_payment_link_id, newPaymentId(), price))).json.outcome).toBe("package_active");
    return { childPackageId: res.json.child_package_id as string, paymentId };
  }

  /** A prepaid one-off appointment, captured through 031. */
  async function prepaidOneOff(serviceId: string, fam: { user: TestUser; childId: string }, c: string, amount: number): Promise<{ id: string; paymentId: string }> {
    const id = await appt(serviceId, fam.childId, c, fam.user.id);
    const orderId = `order_T046${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    await sql`insert into payments (appointment_id, gateway, razorpay_order_id, amount_paise, status) values (${id}, 'demo', ${orderId}, ${amount}, 'created')`;
    const { applyPaymentCaptured } = await import("@/lib/payments/store");
    await applyPaymentCaptured({ orderId, paymentId: newPaymentId(), source: "demo" });
    const [p] = await sql<{ id: string; status: string }[]>`select id, status from payments where razorpay_order_id = ${orderId}`;
    expect(p.status).toBe("captured");
    return { id, paymentId: p.id };
  }

  beforeAll(async () => {
    vi.stubEnv("DEMO_MODE", "true");
    vi.stubEnv("RAZORPAY_KEY_ID", "");
    vi.stubEnv("RAZORPAY_KEY_SECRET", "t046_key_secret_synthetic");
    vi.stubEnv("RAZORPAY_WEBHOOK_SECRET", WEBHOOK_SECRET);
    vi.stubEnv("NEXT_PUBLIC_APP_URL", APP);
    vi.stubEnv("PLATFORM_FEE_DEFAULT_BPS", "1000");
    vi.stubEnv("PLATFORM_GST_BPS", "1800");
    vi.stubEnv("PLATFORM_GSTIN", "36AAAAA0000A1Z5");
    sql = postgres(process.env.DATABASE_URL as string, { max: 12, prepare: false, onnotice: () => {} });
    const db = (await import("@/lib/db")).supabaseAdmin();
    world = bookingWorld(sql, db, "t046");
    orgA = await world.provider("pa");
    orgB = await world.provider("pb");
    outsider = await world.provider("px");
    admin = await world.user("adm", "platform_admin");
    member = await world.user("mem", "provider");
    await world.member(orgA.orgId, member);
    speechA = await world.service(orgA, { payment: "online", fee: 800, name: "Speech therapy (synthetic)" });
    oneOffA = await world.service(orgA, { payment: "online", fee: 1000, name: "Online consult (synthetic)" });
    famA = await world.guardian("ga");
    famA2 = await world.guardian("gb");
    famA3 = await world.guardian("gc");
    famB = await world.guardian("gd");
    caseA = (await world.kase(orgA.orgId, { childId: famA.childId })).caseId;
    caseA2 = (await world.kase(orgA.orgId, { childId: famA2.childId })).caseId;
    caseA3 = (await world.kase(orgA.orgId, { childId: famA3.childId })).caseId;
    caseB = (await world.kase(orgB.orgId, { childId: famB.childId })).caseId;
    const [c] = await sql<{ next: number }[]>`select next from platform_invoice_counters where fy = '2026-27'`;
    counterBefore = c?.next ?? null;
    payoutJobs = await import("@/lib/payouts/jobs");
    feeJobs = await import("@/lib/fees/jobs");
    paymentJobs = await import("@/lib/payments/jobs");
    routes = {
      offer: await import("@/app/api/cases/[id]/fees/offer/route"),
      refund: await import("@/app/api/cases/[id]/fees/refunds/route"),
      packages: await import("@/app/api/orgs/[id]/packages/route"),
      mark: await import("@/app/api/appointments/[id]/attendance/route"),
      webhook: await import("@/app/api/webhooks/razorpay/route"),
      services: await import("@/app/api/provider/services/route"),
      hold: await import("@/app/api/appointments/hold/route"),
      payouts: await import("@/app/api/orgs/[id]/payouts/route"),
      accept: await import("@/app/api/orgs/[id]/payouts/accept/route"),
      settings: await import("@/app/api/orgs/[id]/payouts/settings/route"),
      exportCsv: await import("@/app/api/orgs/[id]/payouts/export/route"),
      invoicePdf: await import("@/app/api/orgs/[id]/payouts/invoices/[invoiceId]/pdf/route"),
      adminOverview: await import("@/app/api/admin/payouts/route"),
      adminAccount: await import("@/app/api/admin/payouts/orgs/[orgId]/account/route"),
      adminPolicy: await import("@/app/api/admin/payouts/orgs/[orgId]/policy/route"),
      adminRetry: await import("@/app/api/admin/payouts/items/[id]/retry/route"),
    };
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    if (sql && orgA) {
      const orgIds = [orgA.orgId, orgB.orgId, outsider.orgId];
      const payments = (await sql<{ id: string }[]>`
        select p.id from payments p left join appointments a on a.id = p.appointment_id
        where p.org_id in ${sql(orgIds)} or a.org_id in ${sql(orgIds)}`).map((r) => r.id);
      const itemIds = (await sql<{ id: string }[]>`select id from payout_items where org_id in ${sql(orgIds)}`).map((r) => r.id);
      if (payments.length) {
        await sql`delete from outbox_events where aggregate_type = 'payment' and aggregate_id in ${sql(payments)}`;
        await sql`delete from payout_reconciliation_flags where payment_id in ${sql(payments)}`;
      }
      if (itemIds.length) await sql`delete from outbox_events where aggregate_type = 'payout_item' and aggregate_id in ${sql(itemIds)}`;
      await sql`delete from outbox_events where aggregate_type in ('platform_invoice', 'payout_reconciliation') and dedup_key like 'payouts:%'
                and created_at > now() - interval '1 hour'`;
      await sql`delete from outbox_events where aggregate_type in ('child', 'child_package', 'fee_refund')
                and payload ->> 'child_id' in ${sql([famA.childId, famA2.childId, famA3.childId, famB.childId])}`;
      await purgeTestAudit(sql, (tx) => tx`delete from audit_events where org_id in ${tx(orgIds)} or (entity = 'payout_item' and entity_id in ${tx(itemIds.length ? itemIds : [randomUUID()])})`);
      await sql`delete from payout_items where org_id in ${sql(orgIds)}`;
      await sql`delete from platform_invoices where org_id in ${sql(orgIds)}`;
      if (counterBefore === null) await sql`delete from platform_invoice_counters where fy = '2026-27'`;
      else await sql`update platform_invoice_counters set next = ${counterBefore} where fy = '2026-27'`;
    }
    await world?.cleanup();
    await sql?.end({ timeout: 5 });
  });

  describe("authorisation", () => {
    it("members 403, other organisations 404, families never; /api/admin/payouts is platform admins only", async () => {
      as(member);
      expect((await payoutsOf(orgA.orgId)).status).toBe(403);
      expect((await call(routes.exportCsv.GET, new Request("http://localhost/x"), { id: orgA.orgId })).status).toBe(403);
      // The page gate (/dashboard/payouts): members get forbidden() (403).
      const { requirePayoutsPage } = await import("@/lib/payouts/authz");
      // (Under vitest the experimental authInterrupts flag from next.config.ts is not loaded: either error means 403.)
      await expect(requirePayoutsPage(orgA.orgId)).rejects.toThrow(/NEXT_HTTP_ERROR_FALLBACK;403|forbidden\(\)/);
      as(orgA.user);
      expect((await requirePayoutsPage(orgA.orgId)).org.id).toBe(orgA.orgId);
      as(member);
      as(outsider.user);
      expect((await payoutsOf(orgA.orgId)).status).toBe(404);
      expect((await payoutsOf("not-a-uuid")).status).toBe(404);
      as(famA.user);
      expect((await payoutsOf(orgA.orgId)).status).toBe(403);
      as(null);
      expect((await payoutsOf(orgA.orgId)).status).toBe(401);
      as(orgA.user);
      expect((await call(routes.adminOverview.GET, new Request("http://localhost/x"))).status).toBe(403);
      expect((await setAccount(orgA.orgId, { status: "active", razorpay_account_id: ACC_A })).status).toBe(403);
      as(admin);
      expect((await call(routes.adminOverview.GET, new Request("http://localhost/x"))).status).toBe(200);
    });
  });

  describe("setup: org A active 10% (min ₹20); org B pending_kyc flat ₹60 waived to the end of the month", () => {
    it("admin sets accounts and policies (new version per change, audited)", async () => {
      as(admin);
      // DEMO_MODE fakes the linked account id when none is given (live mode: 400 account_id_required).
      const demoAccount = await setAccount(orgA.orgId, { status: "active" });
      expect((demoAccount.json.account as Json).razorpay_account_id).toMatch(/^acc_DEMO/);
      expect((await setAccount(orgA.orgId, { status: "active", razorpay_account_id: ACC_A, legal_name: "Org A Pvt Ltd (synthetic)" })).status).toBe(200);
      const p1 = await setPolicy(orgA.orgId, { kind: "percent", percent_bps: 1200, min_paise: 2000 });
      expect(p1.status).toBe(200);
      const p2 = await setPolicy(orgA.orgId, { kind: "percent", percent_bps: 1000, min_paise: 2000 });
      expect((p2.json.policy as Json).version).toBe(((p1.json.policy as Json).version as number) + 1);
      expect((await setPolicy(orgA.orgId, { kind: "percent", percent_bps: 3001 })).status).toBe(400);
      expect((await setAccount(orgB.orgId, { status: "pending_kyc" })).status).toBe(200);
      expect((await setPolicy(orgB.orgId, { kind: "flat", flat_paise: 6000, waived_until: endOfMonthIst() })).status).toBe(200);
      const audits = await sql<{ action: string }[]>`select action from audit_events where org_id in (${orgA.orgId}, ${orgB.orgId}) and action like 'payouts.%'`;
      expect(audits.filter((a) => a.action === "payouts.account_changed")).toHaveLength(3);
      expect(audits.filter((a) => a.action === "payouts.fee_policy_changed")).toHaveLength(3);
      // Org A's owner accepts the fee (the owner only; a stale version -> 409 policy_changed).
      as(member);
      expect((await acceptCurrent(orgA.orgId)).status).toBe(403);
      as(orgA.user);
      const stale = await call(routes.accept.POST, post(`http://localhost/api/orgs/${orgA.orgId}/payouts/accept`, { policy_version: 1 }), { id: orgA.orgId });
      expect(stale.json.code).toBe("policy_changed");
      const accepted = await acceptCurrent(orgA.orgId);
      expect(accepted.status).toBe(200);
      expect((accepted.json.readiness as Json).canPublish).toBe(true);
      // A package at org A: ₹9,000 / 12 sessions.
      const created = await call(
        routes.packages.POST,
        post(`http://localhost/api/orgs/${orgA.orgId}/packages`, { name: "Speech 12 (synthetic)", session_count: 12, price_inr: 9000, validity_days: 30, service_ids: [speechA] }),
        { id: orgA.orgId },
      );
      expect(created.status).toBe(201);
      pkg9000 = (created.json.package as Json).id as string;
    });
  });

  describe("E-3 payout setup gate and waiver (FR-2, FR-8)", () => {
    let paidB: string;

    it("org B: online service / package 409 payout_account_inactive; free still works; existing paid services hidden", async () => {
      as(orgB.user);
      const body = { name: "Paid video (synthetic)", mode: "video", duration_min: 30, fee_inr: 800, payment_mode: "online", buffer_min: 0 };
      const refused = await call(routes.services.POST, post("http://localhost/api/provider/services", body));
      expect(refused.status).toBe(409);
      expect(refused.json.code).toBe("payout_account_inactive");
      expect(refused.json.error).toBe("Finish payout setup to accept payments.");
      const free = await call(routes.services.POST, post("http://localhost/api/provider/services", { ...body, name: "Free video (synthetic)", fee_inr: 0, payment_mode: "free" }));
      expect(free.status).toBe(201);
      const pkg = await call(
        routes.packages.POST,
        post(`http://localhost/api/orgs/${orgB.orgId}/packages`, { name: "B pack (synthetic)", session_count: 4, price_inr: 3000, validity_days: 30, service_ids: [(free.json.service as Json).id] }),
        { id: orgB.orgId },
      );
      expect(pkg.status).toBe(409);
      expect(pkg.json.code).toBe("payout_account_inactive");
      // An existing paid service (from before 046) is hidden from booking until the account is active.
      paidB = await world.service(orgB, { payment: "online", fee: 800, name: "Legacy paid (synthetic)" });
      const { listServices } = await import("@/lib/booking/store");
      expect((await listServices(orgB.profileId, { activeOnly: true })).map((s) => s.id)).not.toContain(paidB);
      expect((await listServices(orgB.profileId, { activeOnly: true })).map((s) => s.id)).toContain((free.json.service as Json).id);
      as(famB.user);
      const hold = await call(routes.hold.POST, post("http://localhost/api/appointments/hold", { service_id: paidB, start: new Date(Date.now() + 86_400_000).toISOString(), idempotency_key: `k-${randomUUID()}` }));
      expect(hold.status).toBe(404);
      // The statement shows the setup notice state.
      as(orgB.user);
      const r = (await payoutsOf(orgB.orgId)).json.readiness as Json;
      expect(r).toMatchObject({ canCharge: false, canPublish: false, block: "payout_account_inactive" });
    });

    it("admin activates -> owner must accept the fee first -> then paid services go live and the fee is 0 while waived", async () => {
      as(admin);
      expect((await setAccount(orgB.orgId, { status: "active", razorpay_account_id: ACC_B })).status).toBe(200);
      as(orgB.user);
      const body = { name: "Paid video 2 (synthetic)", mode: "video", duration_min: 30, fee_inr: 800, payment_mode: "online", buffer_min: 0 };
      expect((await call(routes.services.POST, post("http://localhost/api/provider/services", body))).json.code).toBe("fee_policy_not_accepted");
      const readiness = (await payoutsOf(orgB.orgId)).json.readiness as { policy: Json; block: string };
      expect(readiness.policy).toMatchObject({ kind: "flat", flat_paise: 6000, waived_until: endOfMonthIst() });
      expect((await acceptCurrent(orgB.orgId)).status).toBe(200);
      expect((await call(routes.services.POST, post("http://localhost/api/provider/services", body))).status).toBe(201);
      const { listServices } = await import("@/lib/booking/store");
      expect((await listServices(orgB.profileId, { activeOnly: true })).map((s) => s.id)).toContain(paidB);
      // A session this month: fee 0, net = consultation.
      const { id } = await prepaidOneOff(paidB, famB, caseB, 80000);
      expect((await mark(id, "present")).status).toBe(200);
      await run([orgB.orgId]);
      expect(await itemFor(id)).toMatchObject({ consultation_paise: 80000, fee_paise: 0, gst_paise: 0, net_paise: 80000, fee_waived: true, status: "transferred" });
    });
  });

  describe("E-1 package paid out per session (FR-3, NFR-1, NFR-3, FR-7)", () => {
    let pkgPayment: string;
    const sessions: string[] = [];

    it("each present session -> one item: ₹750, fee ₹75, GST ₹13.50, net ₹661.50; exactly one under 3 retries; transferred", async () => {
      const bought = await buyPackage(caseA, pkg9000, 900000);
      pkgPayment = bought.paymentId;
      as(orgA.user);
      for (let i = 0; i < 3; i++) {
        const id = await appt(speechA, famA.childId, caseA, famA.user.id);
        expect((await mark(id, "present")).json.billable).toBe(true);
        sessions.push(id);
      }
      // 3 runs at once and 2 more after: still exactly one item per consultation.
      await Promise.all([run([orgA.orgId]), run([orgA.orgId]), run([orgA.orgId])]);
      await run([orgA.orgId]);
      await run([orgA.orgId]);
      const rows = (await items(orgA.orgId)).filter((r) => sessions.includes(r.appointment_id ?? ""));
      expect(rows).toHaveLength(3);
      for (const r of rows) {
        expect(r).toMatchObject({ consultation_paise: 75000, fee_paise: 7500, gst_paise: 1350, net_paise: 66150, status: "transferred", payment_id: pkgPayment });
        expect(r.razorpay_transfer_id).toMatch(/^trf_DEMO/);
      }
      const transfers = await sql<{ n: number; total: number }[]>`
        select count(*)::int as n, coalesce(sum(amount_paise), 0)::int as total from payout_transfers where payment_id = ${pkgPayment} and status = 'processed'`;
      expect(transfers[0]).toEqual({ n: 3, total: 3 * 66150 });
      // The signed transfer.processed webhooks were stored allowlisted (no notes).
      const [ev] = await sql<{ payload: Json }[]>`select payload from payment_events where payload ->> 'event' = 'transfer.processed' and payload -> 'transfer' ->> 'source' =
        (select razorpay_payment_id from payments where id = ${pkgPayment}) limit 1`;
      expect(JSON.stringify(ev.payload)).not.toContain("payout_transfer");
    });

    it("NFR-3: a transfer larger than what is left of the payment is refused in SQL", async () => {
      const [{ left }] = await sql<{ left: number }[]>`select public.payouts_untransferred(${pkgPayment})::int as left`;
      expect(left).toBe(900000 - 3 * 66150);
      // A forged item that would overdraw the payment (consultation of another, unpaid session).
      const extra = await appt(speechA, famA.childId, caseA, famA.user.id);
      const [forged] = await sql<{ id: string }[]>`
        insert into payout_items (org_id, appointment_id, payment_id, consultation_on, consultation_paise, fee_paise, gst_paise, net_paise)
        values (${orgA.orgId}, ${extra}, ${pkgPayment}, current_date, ${left + 100}, 0, 0, ${left + 100}) returning id`;
      await payoutJobs.runTransfers(sql, null, { itemId: forged.id, orgIds: [orgA.orgId] });
      const [row] = await sql<Item[]>`select * from payout_items where id = ${forged.id}`;
      expect(row).toMatchObject({ status: "failed", failure_reason: "exceeds_payment" });
      expect((await sql`select count(*)::int as n from payout_transfers where payout_item_id = ${forged.id}`)[0].n).toBe(0);
      await sql`delete from payout_items where id = ${forged.id}`;
      await sql`delete from appointments where id = ${extra}`;
    });

    it("FR-7: the statement and CSV show the items (owner/admin)", async () => {
      as(orgA.user);
      const res = await payoutsOf(orgA.orgId);
      expect(res.status).toBe(200);
      const statement = res.json.statement as { month: { consultations: number; gross_paise: number; fee_gst_paise: number; paid_out_paise: number } };
      expect(statement.month.consultations).toBeGreaterThanOrEqual(3);
      expect(statement.month.fee_gst_paise).toBeGreaterThanOrEqual(3 * 8850);
      expect(statement.month.paid_out_paise).toBeGreaterThanOrEqual(3 * 66150);
      const csv = await call(routes.exportCsv.GET, new Request(`http://localhost/x`), { id: orgA.orgId });
      expect(csv.status).toBe(200);
      expect(csv.res.headers.get("content-type")).toContain("text/csv");
      const text = await csv.res.text();
      expect(text.split("\n").filter((l) => l.includes("661.50")).length).toBeGreaterThanOrEqual(3);
    });

    it("FR-5: a correction (present -> absent) after the transfer reverses it; present again -> paid out again", async () => {
      as(orgA.user);
      const target = sessions[0];
      // Correction: present -> absent (not billable) -> the package session comes back (045); the transfer is reversed.
      expect((await mark(target, "absent", "Marked the wrong child")).status).toBe(200);
      await run([orgA.orgId]);
      const item = await itemFor(target);
      expect(item).toMatchObject({ status: "reversed", reverse_reason: "not_billable" });
      const [tr] = await sql<{ status: string; razorpay_reversal_id: string | null; reversed_paise: number }[]>`
        select status, razorpay_reversal_id, reversed_paise from payout_transfers where payout_item_id = ${item.id}`;
      expect(tr).toMatchObject({ status: "reversed", reversed_paise: 66150 });
      expect(tr.razorpay_reversal_id).toMatch(/^rvrsl_DEMO/);
      // Present again -> a fresh payout (same item, reopened) and a fresh transfer.
      expect((await mark(target, "present", "It was the right child after all")).status).toBe(200);
      await run([orgA.orgId]);
      expect(await itemFor(target)).toMatchObject({ status: "transferred" });

    });
  });

  describe("E-2 one-off booking (FR-4) and a 031 full refund after a transfer (FR-5)", () => {
    it("₹1,000 one-off: no transfer before delivery; completed -> fee ₹100, GST ₹18, ₹882 transferred", async () => {
      const { id } = await prepaidOneOff(oneOffA, famA2, caseA2, 100000);
      await run([orgA.orgId]);
      expect(await itemFor(id)).toBeUndefined();
      as(orgA.user);
      expect((await mark(id, "present")).json.billable).toBe(true);
      await run([orgA.orgId]);
      expect(await itemFor(id)).toMatchObject({ consultation_paise: 100000, fee_paise: 10000, gst_paise: 1800, net_paise: 88200, status: "transferred" });
      // Reconciliation: this payment balances (transferred + platform share = captured).
      const recon = await payoutJobs.runReconciliation(sql, { orgId: orgA.orgId });
      expect(recon.flags.map((f) => f.payment_id)).not.toContain((await itemFor(id)).payment_id);
    });

    it("provider no-show (cancelled by the centre) -> no transfer; the family is refunded by 031", async () => {
      const { id, paymentId } = await prepaidOneOff(oneOffA, famA2, caseA2, 100000);
      as(orgA.user);
      expect((await mark(id, "cancelled_centre")).json.billable).toBe(false);
      await run([orgA.orgId]);
      expect(await itemFor(id)).toBeUndefined();
      await paymentJobs.runPaymentJobs({ paymentIds: [paymentId] });
      expect((await sql`select status from payments where id = ${paymentId}`)[0].status).toBe("refunded");
      expect((await sql`select count(*)::int as n from payout_transfers where payment_id = ${paymentId}`)[0].n).toBe(0);
    });

    it("031 full refund after a transfer: the transfer is reversed before the refund", async () => {
      const { id, paymentId } = await prepaidOneOff(oneOffA, famA3, caseA3, 100000);
      as(orgA.user);
      await mark(id, "present");
      await run([orgA.orgId]);
      expect((await itemFor(id)).status).toBe("transferred");
      // The payment goes to refund (031: e.g. an admin refund) while the money already moved to the centre.
      await sql`update payments set status = 'refund_pending', refund_reason = 'provider_cancelled', refund_next_attempt_at = now() where id = ${paymentId}`;
      await paymentJobs.runPaymentJobs({ paymentIds: [paymentId] });
      const [p] = await sql<{ status: string; refunded_at: Date }[]>`select status, refunded_at from payments where id = ${paymentId}`;
      expect(p.status).toBe("refunded");
      const item = await itemFor(id);
      expect(item.status).toBe("reversed");
      const [tr] = await sql<{ reversed_at: Date }[]>`select reversed_at from payout_transfers where payout_item_id = ${item.id} and status = 'reversed'`;
      expect(tr.reversed_at.getTime()).toBeLessThanOrEqual(p.refunded_at.getTime());
    });
  });

  describe("transfer.failed -> retries with back-off -> admin (FR-3, FR-9)", () => {
    it("a failing linked account: 4 attempts (3 retries), then an admin alert and the item in /admin/payouts; Retry pays it", async () => {
      as(admin);
      expect((await setAccount(orgA.orgId, { status: "active", razorpay_account_id: ACC_FAIL })).status).toBe(200);
      const { id } = await prepaidOneOff(oneOffA, famA2, caseA2, 100000);
      as(orgA.user);
      await mark(id, "present");
      await run([orgA.orgId]);
      let item = await itemFor(id);
      expect(item).toMatchObject({ status: "failed", attempts: 1 });
      expect(item.failure_reason).toMatch(/linked_account_inactive|transfer_failed/);
      for (let n = 2; n <= 4; n++) {
        await sql`update payout_items set next_attempt_at = now() - interval '1 second' where id = ${item.id} and next_attempt_at is not null`;
        await run([orgA.orgId]);
        item = await itemFor(id);
        expect(item).toMatchObject({ status: "failed", attempts: n });
      }
      expect((await sql`select next_attempt_at from payout_items where id = ${item.id}`)[0].next_attempt_at).toBeNull();
      const alerts = await sql`select topic from outbox_events where aggregate_type = 'payout_item' and aggregate_id = ${item.id}`;
      expect(alerts.map((a) => a.topic)).toEqual(["payouts.transfer_failed"]);
      as(admin);
      const overview = await call(routes.adminOverview.GET, new Request("http://localhost/x"));
      expect(JSON.stringify(overview.json)).toContain(item.id);
      // The admin fixes the account and presses Retry (audited): transferred.
      expect((await setAccount(orgA.orgId, { status: "active", razorpay_account_id: ACC_A })).status).toBe(200);
      as(orgA.user);
      expect((await call(routes.adminRetry.POST, post("http://localhost/x"), { id: item.id })).status).toBe(403);
      as(admin);
      expect((await call(routes.adminRetry.POST, post("http://localhost/x"), { id: item.id })).status).toBe(200);
      await run([orgA.orgId]);
      expect(await itemFor(id)).toMatchObject({ status: "transferred" });
      expect((await sql`select count(*)::int as n from audit_events where action = 'payouts.transfer_retried' and entity_id = ${item.id}`)[0].n).toBe(1);
    });
  });

  describe("FR-6 package expiry", () => {
    let payCentrePayment: string;

    it("pay_centre (default): the unused sessions are paid out with the fee applied", async () => {
      const { childPackageId, paymentId } = await buyPackage(caseA2, pkg9000, 900000);
      payCentrePayment = paymentId;
      as(orgA.user);
      for (let i = 0; i < 2; i++) {
        const id = await appt(speechA, famA2.childId, caseA2, famA2.user.id);
        await mark(id, "present");
      }
      await sql`update child_packages set status = 'expired', starts_on = current_date - 40, expires_on = current_date - 10 where id = ${childPackageId}`;
      const res = await run([orgA.orgId]);
      expect(res.expiry.items).toBe(10);
      const rows = (await items(orgA.orgId)).filter((r) => r.kind === "package_expiry" && r.payment_id === paymentId);
      expect(rows).toHaveLength(10);
      expect(rows.every((r) => r.consultation_paise === 75000 && r.fee_paise === 7500 && r.gst_paise === 1350 && r.status === "transferred")).toBe(true);
      expect((await sql`select expiry_outcome from child_packages where id = ${childPackageId}`)[0].expiry_outcome).toBe("pay_centre");
      // Settled once: another run adds nothing.
      expect((await run([orgA.orgId])).expiry.items).toBe(0);
      const [{ left }] = await sql<{ left: number }[]>`select public.payouts_untransferred(${paymentId})::int as left`;
      expect(left).toBe(12 * 8850);
    });

    it("FR-5: refunding the expired package's unused sessions after they were paid out reverses those transfers first (045 path)", async () => {
      const [cp] = await sql<{ id: string; child_id: string }[]>`select id, child_id from child_packages where payment_id = ${payCentrePayment}`;
      as(orgA.user);
      const res = await call(routes.refund.POST, post(`http://localhost/api/cases/${caseA2}/fees/refunds`, { kind: "package", child_package_id: cp.id, reason: "Family moved away (synthetic)" }), { id: caseA2 });
      expect(res.status).toBe(201);
      expect(res.json.amount_paise).toBe(10 * 75000);
      const refundId = res.json.fee_refund_id as string;
      const out = await feeJobs.runFeeJobs({ refundIds: [refundId] });
      expect(out.refunds.processed).toBe(1);
      const expiry = (await items(orgA.orgId)).filter((r) => r.kind === "package_expiry" && r.payment_id === payCentrePayment);
      expect(expiry.every((r) => r.status === "reversed" && r.reverse_reason === "refund")).toBe(true);
      const [order] = await sql<{ last_reversal: Date; processed_at: Date; reversals: number }[]>`
        select max(t.reversed_at) as last_reversal, count(t.razorpay_reversal_id)::int as reversals, r.processed_at
        from payout_transfers t join payout_items i on i.id = t.payout_item_id, fee_refunds r
        where i.payment_id = ${payCentrePayment} and i.kind = 'package_expiry' and t.status = 'reversed' and r.id = ${refundId}
        group by r.processed_at`;
      expect(order.reversals).toBe(10);
      expect(order.last_reversal.getTime()).toBeLessThanOrEqual(order.processed_at.getTime());
      // The delivered sessions stay paid out.
      expect((await items(orgA.orgId)).filter((r) => r.kind === "consultation" && r.payment_id === payCentrePayment).every((r) => r.status === "transferred")).toBe(true);
    });

    it("refund_family: the unused amount is refunded through the 045 refund path", async () => {
      as(orgA.user);
      const s = await call(routes.settings.PUT, post(`http://localhost/api/orgs/${orgA.orgId}/payouts/settings`, { package_expiry_policy: "refund_family" }, "PUT"), { id: orgA.orgId });
      expect(s.status).toBe(200);
      const { childPackageId, paymentId } = await buyPackage(caseA3, pkg9000, 900000);
      const id = await appt(speechA, famA3.childId, caseA3, famA3.user.id);
      await mark(id, "present");
      await sql`update child_packages set status = 'expired', starts_on = current_date - 40, expires_on = current_date - 10 where id = ${childPackageId}`;
      const res = await run([orgA.orgId]);
      expect(res.expiry).toMatchObject({ refunds: 1, items: 0 });
      const [fr] = await sql<{ amount_paise: number; reason: string; status: string }[]>`
        select amount_paise, reason, status from fee_refunds where child_package_id = ${childPackageId}`;
      expect(fr).toMatchObject({ amount_paise: 900000 - 75000, reason: "package_unused", status: "processed" });
      expect((await items(orgA.orgId)).filter((r) => r.kind === "package_expiry" && r.payment_id === paymentId)).toHaveLength(0);
      await call(routes.settings.PUT, post(`http://localhost/api/orgs/${orgA.orgId}/payouts/settings`, { package_expiry_policy: "pay_centre" }, "PUT"), { id: orgA.orgId });
    });

    it("FR-10 reconciliation flags a mismatch on a settled payment (admins alerted), and resolves once it balances", async () => {
      expect((await payoutJobs.runReconciliation(sql, { orgId: orgA.orgId })).flags.map((f) => f.payment_id)).not.toContain(payCentrePayment);
      const [tr] = await sql<{ id: string }[]>`select id from payout_transfers where payment_id = ${payCentrePayment} and status = 'processed' limit 1`;
      await sql`update payout_transfers set amount_paise = amount_paise - 100 where id = ${tr.id}`;
      const flagged = await payoutJobs.runReconciliation(sql, { orgId: orgA.orgId });
      expect(flagged.flags).toContainEqual({ payment_id: payCentrePayment, org_id: orgA.orgId, diff_paise: -100 }); // accounted - captured
      expect(flagged.new_flags).toBeGreaterThanOrEqual(1);
      expect((await sql`select count(*)::int as n from outbox_events where topic = 'payouts.reconciliation_alert' and created_at > now() - interval '5 minutes'`)[0].n).toBeGreaterThanOrEqual(1);
      await sql`update payout_transfers set amount_paise = amount_paise + 100 where id = ${tr.id}`;
      const fixed = await payoutJobs.runReconciliation(sql, { orgId: orgA.orgId });
      expect(fixed.resolved).toBeGreaterThanOrEqual(1);
      expect((await sql`select count(*)::int as n from payout_reconciliation_flags where payment_id = ${payCentrePayment} and resolved_at is null`)[0].n).toBe(0);
    });
  });

  describe("E-4 monthly platform-fee invoice (FR-7)", () => {
    it("the cron run on the 1st invoices last month's fees: DNM-INV/2026-27/<n>, idempotent; PDF for the centre only", async () => {
      // Last month's consultations (the payout items were made before the 1st's run).
      await sql`update payout_items set consultation_on = '2026-10-15', created_at = '2026-10-15T12:00:00+05:30' where org_id = ${orgA.orgId}`;
      const [totals] = await sql<{ fee: number; gst: number }[]>`
        select sum(fee_paise)::int as fee, sum(gst_paise)::int as gst from payout_items where org_id = ${orgA.orgId} and status <> 'reversed' and fee_paise > 0`;
      const now = new Date("2026-11-01T01:00:00+05:30");
      const first = await payoutJobs.issueMonthlyInvoices(sql, { now, orgId: orgA.orgId });
      const expected = `DNM-INV/2026-27/${String(counterBefore ?? 1).padStart(4, "0")}`;
      expect(first).toEqual({ issued: [expected], month: "2026-10-01" });
      expect((await payoutJobs.issueMonthlyInvoices(sql, { now, orgId: orgA.orgId })).issued).toEqual([]);
      const [inv] = await sql<{ id: string; fee_paise: number; gst_paise: number; centre: Json; platform: Json }[]>`
        select id, fee_paise, gst_paise, centre, platform from platform_invoices where org_id = ${orgA.orgId}`;
      expect(inv).toMatchObject({ fee_paise: totals.fee, gst_paise: totals.gst });
      expect(inv.platform.gstin).toBe("36AAAAA0000A1Z5");
      as(orgA.user);
      const pdf = await call(routes.invoicePdf.GET, new Request("http://localhost/x"), { id: orgA.orgId, invoiceId: inv.id });
      expect(pdf.status).toBe(200);
      expect(pdf.res.headers.get("content-type")).toBe("application/pdf");
      expect(pdfText(new Uint8Array(await pdf.res.arrayBuffer()))).toContain(expected);
      as(outsider.user);
      expect((await call(routes.invoicePdf.GET, new Request("http://localhost/x"), { id: orgA.orgId, invoiceId: inv.id })).status).toBe(404);
      as(member);
      expect((await call(routes.invoicePdf.GET, new Request("http://localhost/x"), { id: orgA.orgId, invoiceId: inv.id })).status).toBe(403);
    });
  });
});
