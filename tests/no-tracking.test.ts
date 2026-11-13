// Ticket 041 FR-13 / D-6: no tracking on child pages. Every `/family/**` page may load scripts only from the app's own
// origin, plus the per-route exceptions in lib/privacy/third-party-allowlist.ts (ElevenLabs SDK, Razorpay checkout);
// analytics, ads, tag managers and social pixels always fail.
//   1. allowlist and CSP rules (unit);
//   2. static scan of every module a `/family/**` page imports (no external <script>, next/script, injected scripts or
//      tracker hosts);
//   3. live crawl of the rendered pages with a synthetic guardian session: runs when NO_TRACKING_BASE_URL points at a
//      running app (e.g. `NO_TRACKING_BASE_URL=http://localhost:3050 npx vitest run tests/no-tracking.test.ts`).
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { loadEnvConfig } from "@next/env";
import { describe, expect, it } from "vitest";
import { familyCsp, FAMILY_CSP_EXCEPTIONS } from "@/lib/csp";
import { allowedOriginsFor, BANNED_SCRIPT_HOSTS, isBannedHost, scriptAllowed, THIRD_PARTY_ALLOWLIST } from "@/lib/privacy/third-party-allowlist";

loadEnvConfig(process.cwd(), false, { info: () => {}, error: () => {} });
const ROOT = process.cwd();
const APP = "http://localhost:3000";

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const FAMILY_PAGES = walk(path.join(ROOT, "app", "family")).filter((f) => /\/page\.tsx$/.test(f));

/** `/family/(portal)/children/[id]/page.tsx` -> `/family/children/[id]`. */
function routeOf(file: string): string {
  const rel = path.relative(path.join(ROOT, "app"), path.dirname(file)).split(path.sep);
  return `/${rel.filter((seg) => !/^\(.*\)$/.test(seg)).join("/")}`;
}

describe("third-party allowlist (D-6)", () => {
  it("allows the app origin, and approved origins only on their routes", () => {
    expect(scriptAllowed("/_next/static/chunks/main.js", "/family", APP)).toBe(true);
    expect(scriptAllowed(`${APP}/_next/static/x.js`, "/family/children", APP)).toBe(true);
    expect(scriptAllowed("https://checkout.razorpay.com/v1/checkout.js", "/family/appointments", APP)).toBe(true);
    expect(scriptAllowed("https://checkout.razorpay.com/v1/checkout.js", "/family/children/abc", APP)).toBe(false);
    expect(scriptAllowed("https://elevenlabs.io/sdk.js", "/family/children/abc/ask", APP)).toBe(true);
    expect(scriptAllowed("https://elevenlabs.io/sdk.js", "/family/documents", APP)).toBe(false);
    expect(scriptAllowed("https://cdn.example.com/lib.js", "/family", APP)).toBe(false);
  });

  it.each([
    "https://www.googletagmanager.com/gtm.js?id=GTM-X",
    "https://www.google-analytics.com/analytics.js",
    "https://connect.facebook.net/en_US/fbevents.js",
    "https://static.hotjar.com/c/hotjar-1.js",
    "https://www.clarity.ms/tag/abc",
    "https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js",
    "https://cdn.segment.com/analytics.js/v1/x/analytics.min.js",
  ])("never allows tracker %s, on any route", (src) => {
    for (const route of ["/family", "/family/appointments", "/family/children/x/ask"]) expect(scriptAllowed(src, route, APP)).toBe(false);
  });

  it("allowlist entries are approved vendors, scoped to /family routes (or 033's /screen, 034's /find, 031's payment page), and never trackers", () => {
    expect(THIRD_PARTY_ALLOWLIST.map((e) => e.name)).toEqual([
      "ElevenLabs SDK (voice agent)",
      "ElevenLabs SDK (developmental check-in)",
      "ElevenLabs SDK (voice booking)",
      "Razorpay checkout",
    ]);
    for (const entry of THIRD_PARTY_ALLOWLIST) {
      expect(entry.routes.length).toBeGreaterThan(0);
      // 031: Razorpay Checkout runs on the booking payment page `/book/<profileId>/pay/<appointmentId>` (rd FR-4).
      for (const route of entry.routes)
        expect(route.startsWith("/family/") || route === "/screen" || route === "/find" || (entry.name === "Razorpay checkout" && route === "/book/*/pay/*")).toBe(true);
      for (const origin of entry.origins) {
        expect(new URL(origin).origin).toBe(origin);
        expect(isBannedHost(new URL(origin).hostname)).toBe(false);
      }
    }
    expect(BANNED_SCRIPT_HOSTS).toContain("googletagmanager.com");
  });

  it("the family CSP allows only self (+nonce) and the route's allowlisted origins; lib/csp exceptions are allowlisted", () => {
    for (const file of FAMILY_PAGES) {
      const route = routeOf(file).replace(/\[[^\]]+\]/g, "x");
      const csp = familyCsp({ pathname: route, nonce: "n", supabaseUrl: "http://127.0.0.1:54321", isDev: false });
      const scriptSrc = csp.split("; ").find((d) => d.startsWith("script-src "))!.split(" ").slice(1);
      const extra = scriptSrc.filter((s) => !["'self'", "'nonce-n'", "'strict-dynamic'"].includes(s));
      for (const origin of extra) expect(allowedOriginsFor(route), `${route}: ${origin}`).toContain(origin);
    }
    for (const [prefix, allowance] of Object.entries(FAMILY_CSP_EXCEPTIONS)) {
      for (const origin of allowance.scriptSrc ?? []) {
        expect(isBannedHost(new URL(origin).hostname)).toBe(false);
        expect(allowedOriginsFor(prefix), `${prefix}: ${origin}`).toContain(origin);
      }
    }
  });
});

// ---------- static scan ----------

function resolveImport(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = path.join(ROOT, spec.slice(2));
  else if (spec.startsWith(".")) base = path.resolve(path.dirname(from), spec);
  else return null;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), path.join(base, "index.tsx")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function moduleGraph(entries: string[]): Set<string> {
  const seen = new Set<string>();
  const queue = [...entries];
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file) || !/\.(ts|tsx)$/.test(file)) continue;
    seen.add(file);
    const source = readFileSync(file, "utf8");
    for (const m of source.matchAll(/(?:import|export)\s[^'"]*?from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g)) {
      const next = resolveImport(file, m[1] ?? m[2]);
      if (next) queue.push(next);
    }
  }
  return seen;
}

describe("static scan of /family/** modules (FR-13)", () => {
  const entries = [...FAMILY_PAGES, ...walk(path.join(ROOT, "app", "family")).filter((f) => /layout\.tsx$/.test(f)), path.join(ROOT, "app", "layout.tsx")];
  const graph = moduleGraph(entries);

  it("finds the family pages and their modules", () => {
    expect(FAMILY_PAGES.length).toBeGreaterThanOrEqual(15);
    expect(graph.size).toBeGreaterThan(FAMILY_PAGES.length);
  });

  it("no external <script>, next/script, injected script tags or tracker code", () => {
    const problems: string[] = [];
    for (const file of graph) {
      const rel = path.relative(ROOT, file);
      if (rel === "lib/privacy/third-party-allowlist.ts") continue;
      const source = readFileSync(file, "utf8");
      if (/from\s+["']next\/script["']/.test(source)) problems.push(`${rel}: next/script`);
      if (/<script[^>]*\bsrc\s*=\s*\{?["'`]https?:/i.test(source)) problems.push(`${rel}: external <script src>`);
      if (/createElement\(\s*["']script["']\s*\)/.test(source)) problems.push(`${rel}: injected <script>`);
      if (/\b(gtag|fbq|dataLayer|_hsq|mixpanel|amplitude)\s*[.(]/.test(source)) problems.push(`${rel}: tracker call`);
      // Tracker hosts in browser code (server modules may call APIs such as graph.facebook.com for WhatsApp).
      const client = /^\s*["']use client["']/m.test(source);
      if (client) for (const host of BANNED_SCRIPT_HOSTS) if (source.includes(host)) problems.push(`${rel}: ${host}`);
    }
    expect(problems).toEqual([]);
  });
});

// ---------- live crawl ----------

const BASE = process.env.NO_TRACKING_BASE_URL;
const crawl = Boolean(BASE) && Boolean(process.env.DATABASE_URL);

describe.skipIf(!crawl)("rendered /family/** pages load no third-party scripts (live crawl)", { timeout: 300_000 }, () => {
  it("every family page, signed in as a synthetic guardian with a child", async () => {
    const { createClient } = await import("@supabase/supabase-js");
    const { createServerClient } = await import("@supabase/ssr");
    const postgres = (await import("postgres")).default;
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL as string;
    const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY as string, { auth: { persistSession: false } });
    const sql = postgres(process.env.DATABASE_URL as string, { max: 1, prepare: false, onnotice: () => {} });
    const email = `t041-crawl-${randomUUID().slice(0, 8)}@example.test`;
    const password = randomUUID();
    const { data: created, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (error || !created.user) throw new Error(`createUser: ${error?.message}`);
    const userId = created.user.id;
    let childId: string | null = null;
    let caseId: string | null = null;
    let profileId: string | null = null;
    try {
      await sql`update user_profiles set role = 'guardian', phone_verified_at = now() where id = ${userId}`;
      const [child] = await sql<{ id: string }[]>`
        select public.create_guardian_child(${userId}::uuid, 't041 Crawl (synthetic)', '2023-01-01'::date, null, 'mother') as id`;
      childId = child.id;
      await sql`insert into child_health_profiles (child_id, blood_group, updated_by) values (${childId}, 'O+', ${userId})`;
      // 024: a questionnaire assigned to this guardian, so /family/assessments/[id] renders.
      const [kase] = await sql<{ id: string }[]>`
        insert into cases (org_id, child_alias, parent_alias, child_id)
        values ('00000000-0000-4000-8000-00000000a001', 't041 Crawl (synthetic)', 'Parent (synthetic)', ${childId}) returning id`;
      caseId = kase.id;
      const [assessment] = await sql<{ id: string }[]>`
        insert into assessments (case_id, child_id, org_id, template_id, assigned_to)
        values (${caseId}, ${childId}, '00000000-0000-4000-8000-00000000a001', '00000000-0000-4000-8024-000000000001', ${userId})
        returning id`;

      // 030: a confirmed appointment of this guardian, so /family/appointments lists it and its reschedule page renders.
      const [profile] = await sql<{ id: string }[]>`
        insert into provider_profiles (slug, display_name, provider_type, is_synthetic)
        values (${`t041-crawl-${userId.slice(0, 8)}`}, 't041 Crawl provider (synthetic)', 'speech_language_pathologist', true) returning id`;
      profileId = profile.id;
      const [appointment] = await sql<{ id: string }[]>`
        insert into appointments (provider_profile_id, org_id, service_snapshot, guardian_user_id, child_id, slot, status)
        values (${profileId}, '00000000-0000-4000-8000-00000000a001',
                '{"name":"Crawl visit","duration_min":30,"mode":"video","fee_inr":0,"payment_mode":"free","location":null}'::jsonb,
                ${userId}, ${childId}, tstzrange(now() + interval '3 days', now() + interval '3 days 30 minutes', '[)'), 'confirmed')
        returning id`;

      // 027: a conversation on the guardian's case, so /family/messages/[threadId] renders (removed with the case).
      const [thread] = await sql<{ id: string }[]>`
        insert into message_threads (case_id, org_id, child_id, subject, created_by)
        values (${caseId}, '00000000-0000-4000-8000-00000000a001', ${childId}, 'Crawl thread (synthetic)', ${userId}) returning id`;

      const jar: { name: string; value: string }[] = [];
      const ssr = createServerClient(url, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY as string, {
        cookies: { getAll: () => jar, setAll: (cookies) => cookies.forEach((c) => jar.push({ name: c.name, value: c.value })) },
      });
      const signIn = await ssr.auth.signInWithPassword({ email, password });
      if (signIn.error) throw new Error(`sign in: ${signIn.error.message}`);
      const cookie = jar.map((c) => `${c.name}=${c.value}`).join("; ");

      const routes = FAMILY_PAGES.map(routeOf).map((r) =>
        r
          .replace("[id]", r.startsWith("/family/assessments/") ? assessment.id : r.startsWith("/family/appointments/") ? appointment.id : (childId as string))
          .replace("[version]", "1")
          .replace("[threadId]", thread.id),
      );
      const failures: string[] = [];
      const checked: string[] = [];
      for (const route of routes) {
        // The sign-in page is crawled anonymously (signed-in visitors are redirected home).
        const headers: Record<string, string> = route === "/family/login" ? {} : { cookie };
        const res = await fetch(`${BASE}${route}`, { headers, redirect: "manual" });
        if (res.status !== 200) {
          failures.push(`${route}: HTTP ${res.status}`);
          continue;
        }
        const html = await res.text();
        const srcs = [...html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]);
        for (const src of srcs) if (!scriptAllowed(src, route, BASE as string)) failures.push(`${route}: ${src}`);
        checked.push(`${route} (${srcs.length} scripts)`);
      }
      expect(failures).toEqual([]);
      expect(checked.length).toBe(routes.length);
      console.info(`[no-tracking] crawled ${checked.length} pages:\n${checked.join("\n")}`);
    } finally {
      if (profileId) await sql`delete from provider_profiles where id = ${profileId}`; // appointments cascade
      if (caseId) await sql`delete from cases where id = ${caseId}`;
      if (childId) {
        await sql.begin(async (tx) => {
          await tx`set local session_replication_role = replica`;
          await tx`delete from child_health_profile_history where child_id = ${childId}`;
          await tx`delete from child_health_profiles where child_id = ${childId}`;
          await tx`delete from guardian_links where child_id = ${childId}`;
          await tx`delete from children where id = ${childId}`;
        });
      }
      await admin.auth.admin.deleteUser(userId);
      await sql.end({ timeout: 5 });
    }
  });
});
