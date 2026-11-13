// Scratch E2E for ticket 035 against the dev server (synthetic data; removed after the run).
import { createHmac } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import postgres from "postgres";
import { chromium } from "playwright-core";

const BASE = `http://localhost:${process.env.DNM_DEV_PORT}`;
const EVIDENCE = "specs/tickets/035-appointment-intake/evidence";
mkdirSync(EVIDENCE, { recursive: true });
const ids = JSON.parse(readFileSync(".e2e-035/ids.json", "utf8"));
const seed = JSON.parse(readFileSync(".e2e-seed.json", "utf8"));
const sql = postgres(process.env.DATABASE_URL, { max: 2, onnotice: () => {} });
const log = [];
const say = (...a) => {
  const line = a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ");
  log.push(line);
  console.log(line);
};
const check = (name, ok, detail = "") => {
  say(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` - ${detail}` : ""}`);
  if (!ok) process.exitCode = 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const IST = 330 * 60_000;
let hours = 26;
function nextStart() {
  hours += 3;
  const step = 30 * 60_000;
  const local = Date.now() + hours * 3_600_000 + IST;
  const day = Math.floor(local / 86_400_000) * 86_400_000;
  return new Date(day + Math.ceil((local - day) / step) * step - IST).toISOString();
}

async function login(context, email, password) {
  const page = await context.newPage();
  await page.goto(`${BASE}/login`);
  await page.fill('input[type="email"]', email);
  await page.fill("#login-password", password);
  await Promise.all([page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 30_000 }), page.click('button[type="submit"]')]);
  say(`signed in ${email.split("@")[0]} -> ${new URL(page.url()).pathname}`);
  return page;
}

async function api(page, method, path, body) {
  const res = await page.request.fetch(`${BASE}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    data: body ? JSON.stringify(body) : undefined,
  });
  let json = {};
  try {
    json = await res.json();
  } catch {}
  return { status: res.status(), json };
}

async function book(page, serviceId, childId) {
  const start = nextStart();
  const h = await api(page, "POST", "/api/appointments/hold", { service_id: serviceId, start, idempotency_key: `e035-${Math.random()}` });
  if (h.status !== 201) throw new Error(`hold ${h.status} ${JSON.stringify(h.json)}`);
  const c = await api(page, "POST", `/api/appointments/${h.json.appointment_id}/confirm`, { child_id: childId });
  if (c.status !== 200) throw new Error(`confirm ${c.status} ${JSON.stringify(c.json)}`);
  return { id: h.json.appointment_id, start };
}

async function cron() {
  const res = await fetch(`${BASE}/api/cron/outbox`, { method: "POST", headers: { Authorization: "Bearer test-3050" } });
  return res.json();
}

async function waitFor(fn, label) {
  for (let i = 0; i < 40; i++) {
    const v = await fn();
    if (v) return v;
    await sleep(500);
  }
  throw new Error(`timeout: ${label}`);
}

const attemptsOf = (id) => sql`select id, status, agent_kind, expires_at, revoked_reason, case_id from intake_attempts where appointment_id = ${id} order by created_at`;
const guardianNote = (topic, id) => sql`
  select n.title, n.body, n.channel, n.status from notifications n join outbox_events e on e.id = n.event_id
  where e.topic = ${topic} and e.payload ->> 'appointment_id' = ${id} and n.recipient_user_id = ${ids.guardian} order by n.channel`;
const linkIn = (text) => text.match(/https?:\/\/[^\s]+\/intake\/a\/[A-Za-z0-9_-]{43}/)?.[0] ?? null;

async function main() {
  const browser = await chromium.launch();
  const viewport = { width: 375, height: 812 };
  const gctx = await browser.newContext({ viewport });
  const pctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const guardian = await login(gctx, seed.users.guardian_a.email, seed.users.guardian_a.password);

  // ---------------- E-1 Child-Dev ----------------
  say("\n[E-1] Child-Dev: book 'Development consult (synthetic)' for e035 Anaya (consented)");
  const a1 = await book(guardian, ids.childDevA, ids.anaya);
  say("appointment", a1.id, a1.start);
  const caseRow = await waitFor(async () => (await sql`select a.case_id, c.org_id, c.child_id, c.child_alias, c.status from appointments a join cases c on c.id = a.case_id where a.id = ${a1.id}`)[0], "case link (after() drain)");
  say("case:", caseRow);
  check("E-1 case created in org A for the child", caseRow.org_id === ids.orgA && caseRow.child_id === ids.anaya);
  const team = await sql`select user_id, care_role from case_assignments where case_id = ${caseRow.case_id} and removed_at is null`;
  say("care team:", team);
  check("E-1 provider assigned to the case", team.some((t) => t.user_id === ids.providerA));
  const notes1 = await waitFor(async () => { const r = await guardianNote("appointment.confirmed", a1.id); return r.length ? r : null; }, "confirmation");
  for (const n of notes1) say(`  ${n.channel} [${n.status}] ${n.title} | ${n.body}`);
  const url1 = linkIn(notes1.find((n) => n.channel === "in_app").body);
  check("E-1 confirmation (in-app + email) includes /intake/a/<token>", Boolean(url1) && notes1.filter((n) => n.channel !== "whatsapp").every((n) => n.body.includes(url1)));
  const [att1] = await attemptsOf(a1.id);
  say("attempt:", att1);
  check("E-1 attempt expires at the appointment start", new Date(att1.expires_at).toISOString() === a1.start);

  const fam = await gctx.newPage();
  await fam.goto(`${BASE}/family/appointments`);
  await fam.screenshot({ path: `${EVIDENCE}/family-appointments-link-375.png`, fullPage: true });
  check("E-1 /family/appointments shows the intake call button", (await fam.locator('[data-testid="intake-link"]').count()) >= 1);

  const intake = await gctx.newPage();
  await intake.goto(url1.replace(/^https?:\/\/[^/]+/, BASE));
  const options = await intake.locator("#intake-language option").allTextContents();
  say("language options:", options);
  check("E-1 language select en/hi/te", options.length === 3);
  await intake.screenshot({ path: `${EVIDENCE}/intake-child-dev-375.png`, fullPage: true });
  await intake.selectOption("#intake-language", "te");
  await intake.locator('input[type="checkbox"]').check();
  await intake.getByRole("button", { name: /Start call|కాల్ ప్రారంభించండి|कॉल शुरू करें/ }).click();
  await intake.locator("#demo-actions button").waitFor();
  await intake.locator("#demo-actions button").click();
  await intake.getByText(/Call ended|కాల్ ముగిసింది|कॉल खत्म/).first().waitFor({ timeout: 30_000 });
  await intake.screenshot({ path: `${EVIDENCE}/intake-child-dev-done-375.png`, fullPage: true });
  const rec1 = await sql`select r.id, r.appointment_id, r.case_id, r.external_id, rep.kind, rep.appointment_id as report_appointment from recordings r left join reports rep on rep.recording_id = r.id where r.appointment_id = ${a1.id}`;
  say("recording + report:", rec1);
  check("E-1 brief on the case, recording has appointment_id", rec1.length === 1 && rec1[0].kind === "pre_session_brief" && rec1[0].case_id === caseRow.case_id);

  // ---------------- E-2 generic ----------------
  say("\n[E-2] Generic: book 'Knee physio review (synthetic)' for e035 Anaya");
  const a2 = await book(guardian, ids.genericA, ids.anaya);
  const notes2 = await waitFor(async () => { const r = await guardianNote("appointment.confirmed", a2.id); return r.length ? r : null; }, "confirmation 2");
  const url2 = linkIn(notes2.find((n) => n.channel === "in_app").body);
  const [att2] = await attemptsOf(a2.id);
  say("attempt:", att2, "link:", Boolean(url2));
  const g = await gctx.newPage();
  await g.goto(url2.replace(/^https?:\/\/[^/]+/, BASE));
  check("E-2 generic link opens without language select", (await g.locator("#intake-language").count()) === 0 && (await g.locator('[data-agent-kind="generic"]').count()) === 1);
  await g.screenshot({ path: `${EVIDENCE}/intake-generic-375.png`, fullPage: true });
  await g.locator('input[type="checkbox"]').check();
  await g.getByRole("button", { name: /Start call/ }).click();
  await g.locator("#demo-actions button").click();
  await g.getByText(/Call ended/).first().waitFor({ timeout: 30_000 });
  const rep2 = await sql`select rep.id, rep.kind, rep.content -> 'health_check' as health_check, r.external_id from reports rep join recordings r on r.id = rep.recording_id where rep.appointment_id = ${a2.id}`;
  say("generic report:", rep2.map((r) => ({ kind: r.kind, health_check: r.health_check })));
  check("E-2 one generic_intake_brief", rep2.length === 1 && rep2[0].kind === "generic_intake_brief");
  const replay = {
    type: "post_call_transcription",
    data: {
      ...JSON.parse(readFileSync("demo/fixtures/elevenlabs-generic-post-call.json", "utf8")).data,
      agent_id: "agent_generic_e2e",
      conversation_id: rep2[0].external_id,
      conversation_initiation_client_data: { dynamic_variables: { intake_attempt_id: att2.id } },
    },
  };
  const body = JSON.stringify(replay);
  const t = Math.floor(Date.now() / 1000);
  const sig = `t=${t},v0=${createHmac("sha256", "whsec-e2e-035").update(`${t}.${body}`).digest("hex")}`;
  const wh = await fetch(`${BASE}/api/webhooks/elevenlabs`, { method: "POST", headers: { "elevenlabs-signature": sig }, body });
  const whJson = await wh.json();
  say("webhook replay:", wh.status, whJson);
  const count2 = await sql`select count(*)::int as n from reports where appointment_id = ${a2.id}`;
  check("E-2 replay -> duplicate: true, no second report", wh.status === 200 && whJson.duplicate === true && count2[0].n === 1);

  // ---------------- E-3 consent and expiry ----------------
  say("\n[E-3] Consent: book 'Development consult (synthetic)' for e035 Ravi (no ai_intake_call consent)");
  const a3 = await book(guardian, ids.childDevA, ids.ravi);
  const notes3 = await waitFor(async () => { const r = await guardianNote("appointment.confirmed", a3.id); return r.length ? r : null; }, "confirmation 3");
  for (const n of notes3) say(`  ${n.channel} [${n.status}] ${n.title} | ${n.body}`);
  check("E-3 confirmation has the consent text and no link", notes3.every((n) => n.body.includes("Allow the AI intake call in your DoctorNearMe app to prepare for this visit.") && !n.body.includes("/intake/a/")));
  await fam.goto(`${BASE}/family/appointments`);
  await fam.screenshot({ path: `${EVIDENCE}/family-appointments-consent-375.png`, fullPage: true });
  check("E-3 /family/appointments shows the consent hint", (await fam.locator('[data-testid="intake-consent"]').count()) >= 1);
  const [doc] = await sql`select id from consent_documents where feature = 'ai_intake_call' and locale = 'en' order by version desc limit 1`;
  const grant = await api(guardian, "POST", `/api/family/children/${ids.ravi}/consents`, { feature: "ai_intake_call", consent_document_id: doc.id, agree: true });
  say("grant consent:", grant.status);
  say("cron run 1:", await cron());
  say("cron run 2:", await cron());
  const notes3b = await waitFor(async () => { const r = await guardianNote("appointment.intake_link", a3.id); return r.length ? r : null; }, "intake link notification");
  for (const n of notes3b) say(`  ${n.channel} [${n.status}] ${n.title} | ${n.body}`);
  const url3 = linkIn(notes3b.find((n) => n.channel === "in_app").body);
  check("E-3 grant consent -> link issued (notification)", Boolean(url3));
  const cancel = await api(guardian, "POST", `/api/appointments/${a3.id}/cancel`, {});
  say("cancel:", cancel.status, (await attemptsOf(a3.id))[0]);
  const exp = await gctx.newPage();
  await exp.goto(url3.replace(/^https?:\/\/[^/]+/, BASE));
  const expiredText = await exp.locator('[data-testid="intake-expired"]').textContent();
  await exp.screenshot({ path: `${EVIDENCE}/intake-expired-375.png`, fullPage: true });
  const token3 = url3.split("/").pop();
  const start3 = await api(guardian, "POST", `/api/intake/a/${token3}/start`, { language: "en" });
  say("start after cancel:", start3.status, start3.json, "| page:", expiredText);
  check("E-3 cancelled appointment -> link expired (410)", start3.status === 410 && start3.json.error === "This link has expired");

  // ---------------- E-4 case reuse and authz ----------------
  say("\n[E-4] Second booking in org A for Anaya, one in org B");
  const a4 = await book(guardian, ids.childDevA, ids.anaya);
  const a5 = await book(guardian, ids.childDevB, ids.anaya);
  const caseOf = async (id) => (await waitFor(async () => (await sql`select case_id from appointments where id = ${id} and case_id is not null`)[0], `case ${id}`)).case_id;
  const c4 = await caseOf(a4.id);
  const c5 = await caseOf(a5.id);
  say("cases:", { first: caseRow.case_id, second_same_org: c4, other_org: c5 });
  check("E-4 second booking in the same org -> same case", c4 === caseRow.case_id);
  check("E-4 booking in another org -> a separate case", c5 !== caseRow.case_id);
  const provider = await login(pctx, seed.users.provider_a.email, seed.users.provider_a.password);
  const otherOrg = await provider.goto(`${BASE}/cases/${c5}/brief`);
  check("E-4 org B's case not visible to org A's provider (404)", otherOrg.status() === 404, `status ${otherOrg.status()}`);
  const own = await api(provider, "GET", `/api/cases/${c5}/health`);
  check("E-4 org B case API -> 404 for org A", own.status === 404);
  const [att5] = await attemptsOf(a5.id);
  const token5 = (await import("node:crypto")).createHmac("sha256", "e2e-intake-link-secret-035").update(`doctornearme:intake-attempt:v1:${att5.id}`).digest("base64url");
  const cross = await fetch(`${BASE}/api/intake/a/${token5}/complete`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ conversation_id: rec1[0].external_id }) });
  const crossJson = await cross.json();
  say("complete appointment B with appointment A's conversation:", cross.status, crossJson);
  check("E-4 token of another appointment cannot complete this one", cross.status === 403 && (await sql`select 1 from recordings where appointment_id = ${a5.id}`).length === 0);

  // ---------------- FR-6 provider views ----------------
  say("\n[FR-6] Provider agenda + case brief");
  await provider.goto(`${BASE}/dashboard/schedule?view=week`);
  const rows = await provider.locator('[data-testid="agenda-intake"]').allTextContents();
  say("agenda intake rows:", rows);
  check("FR-6 agenda shows Intake: completed / not started", rows.some((r) => r.includes("Intake: completed")) && rows.some((r) => r.includes("Intake: not started")));
  await provider.screenshot({ path: `${EVIDENCE}/schedule-agenda-intake.png`, fullPage: true });
  await provider.locator('[data-testid="agenda-intake"] a').first().click();
  await provider.waitForURL(/\/cases\/.+\/brief/);
  say("Open brief ->", new URL(provider.url()).pathname + new URL(provider.url()).hash);
  const kinds = await provider.locator("[data-report-kind]").evaluateAll((els) => els.map((e) => e.getAttribute("data-report-kind")));
  say("case brief tab report kinds:", kinds);
  check("FR-6 brief in the case (both kinds listed)", kinds.includes("pre_session_brief") && kinds.includes("generic_intake_brief"));
  await provider.screenshot({ path: `${EVIDENCE}/case-brief-appointment-intakes.png`, fullPage: true });
  const mobile = await browser.newContext({ viewport });
  const pm = await login(mobile, seed.users.provider_a.email, seed.users.provider_a.password);
  await pm.goto(`${BASE}/cases/${caseRow.case_id}/brief`);
  const overflow = await pm.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  await pm.screenshot({ path: `${EVIDENCE}/case-brief-375.png`, fullPage: true });
  check("375 px: case brief tab has no horizontal scroll", !overflow);
  for (const p of [fam]) {
    await p.goto(`${BASE}/family/appointments`);
    check("375 px: /family/appointments no horizontal scroll", !(await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)));
  }

  await browser.close();
  writeFileSync(`${EVIDENCE}/acceptance.txt`, log.join("\n") + "\n");
  await sql.end();
}

main().catch(async (err) => {
  say("ERROR", String(err?.stack ?? err));
  writeFileSync(`${EVIDENCE}/acceptance.txt`, log.join("\n") + "\n");
  await sql.end();
  process.exit(1);
});
