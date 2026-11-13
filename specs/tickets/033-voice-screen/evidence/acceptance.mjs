// Ticket 033 acceptance run against the dev server (slot 7). Synthetic accounts from `seed:users --prefix e033`.
// Usage (worktree root, env loaded): node .tmp/pw/acceptance.mjs http://localhost:3070
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const require = createRequire(path.join(ROOT, "package.json"));
const { createServerClient } = require("@supabase/ssr");
const postgresMod = require("postgres");
const postgres = postgresMod.default ?? postgresMod;
const { chromium } = createRequire(path.join(ROOT, ".tmp/pw/package.json"))("playwright-core");

const BASE = process.argv[2] ?? "http://localhost:3070";
const OUT = path.join(ROOT, "specs/tickets/033-voice-screen/evidence");
mkdirSync(OUT, { recursive: true });
const accounts = JSON.parse(readFileSync(path.join(ROOT, ".tmp/accounts.json"), "utf8")).users;
const sql = postgres(process.env.DATABASE_URL, { max: 2, onnotice: () => {} });

const log = [];
let pass = 0;
let failCount = 0;
function check(name, ok, evidence = "") {
  const line = `${ok ? "PASS" : "FAIL"} ${name}${evidence ? ` - ${evidence}` : ""}`;
  log.push(line);
  console.log(line);
  ok ? pass++ : failCount++;
}

async function cookieFor(user) {
  const jar = [];
  const client = createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    cookies: { getAll: () => jar, setAll: (cs) => cs.forEach((c) => jar.push({ name: c.name, value: c.value })) },
  });
  const { error } = await client.auth.signInWithPassword({ email: user.email, password: user.password });
  if (error) throw new Error(`sign in ${user.email}: ${error.message}`);
  return jar;
}
const header = (jar) => jar.map((c) => `${c.name}=${c.value}`).join("; ");

let ipN = 10;
const api = async (method, url, body, { jar, ip } = {}) => {
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(jar ? { cookie: header(jar) } : {}),
      "x-forwarded-for": ip ?? `203.0.113.${ipN++ % 250}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json, headers: res.headers };
};

const reverse = new Set(["q1", "q2", "q6", "q8", "q15"]);
const someConcerns = (id) => (id.startsWith("rf_") ? "no" : reverse.has(id) ? "often" : "sometimes");

async function main() {
  const admin = await cookieFor(accounts.platform_admin);
  const ga = await cookieFor(accounts.guardian_a);
  const gb = await cookieFor(accounts.guardian_b);

  // ---------- setup: synthetic directory listings + children ----------
  // Listings from earlier runs of this script are removed first (synthetic, e033 only).
  await sql`delete from provider_profiles where display_name like 'e033 %(synthetic)'`;
  await sql`delete from organizations where name like 'e033 %Clinic (synthetic)'`;
  for (const [name, type] of [
    ["e033 Dr Synthetic Devped", "developmental_pediatrician"],
    ["e033 Synthetic Speech Therapist", "speech_language_pathologist"],
  ]) {
    const r = await api("POST", "/api/admin/providers", {
      org_name: `${name} Clinic (synthetic)`,
      org_kind: "solo",
      location: { name: "Main clinic (synthetic)", address_line1: "Road 12 (synthetic)", locality: "Banjara Hills", city: "Hyderabad", state: "Telangana", pincode: "500034" },
      display_name: `${name} (synthetic)`,
      provider_type: type,
      languages: ["en", "te"],
      registration_council: "OTHER",
      registration_number: "SYN-033",
      verified: true,
      verification_note: "Synthetic demo listing for ticket 033",
      is_synthetic: true,
      offers_in_clinic: true,
    }, { jar: admin });
    check(`setup: seed ${type} listing`, r.status === 201, `HTTP ${r.status} geocoded=${r.json?.geocoded}`);
  }
  const TAG = Math.random().toString(36).slice(2, 6);
  const childA = (await api("POST", "/api/family/children", { display_name: `e033 Asha ${TAG} (synthetic)`, date_of_birth: "2022-02-01", relationship: "mother", declaration: true }, { jar: ga })).json.child;
  const childB = (await api("POST", "/api/family/children", { display_name: `e033 Bala ${TAG} (synthetic)`, date_of_birth: "2021-06-01", relationship: "father", declaration: true }, { jar: gb })).json.child;
  check("setup: guardian children", Boolean(childA?.id && childB?.id));

  // ---------- CSP / NFR-1 ----------
  const page = await fetch(`${BASE}/screen`);
  const csp = page.headers.get("content-security-policy") ?? "";
  check("NFR-1 /screen has the strict nonce CSP + ElevenLabs connect-src only", /script-src 'self' 'nonce-[^']+' 'strict-dynamic'/.test(csp) && csp.includes("wss://livekit.rtc.elevenlabs.io") && !/google|analytics/.test(csp), csp.split("; ").find((d) => d.startsWith("connect-src")));
  const html = await page.text();
  const external = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]).filter((s) => /^https?:/.test(s) && !s.startsWith(BASE));
  check("NFR-1 /screen loads no third-party <script src>", external.length === 0, `${[...html.matchAll(/<script[^>]+src=/g)].length} script tags, external: ${external.length}`);

  // ---------- E-2 API ----------
  const s1 = await api("POST", "/api/screen/sessions", { age_band: "3-5y", mode: "form" });
  check("E-2 create form session 201", s1.status === 201 && s1.json.questions[0].id === "rf_skill_regression", `HTTP ${s1.status}, first question ${s1.json?.questions?.[0]?.id}`);
  const a1 = await api("POST", `/api/screen/sessions/${s1.json.session_id}/answers`, { answers: [{ item_id: "rf_skill_regression", answer: "yes" }] });
  check("E-2 regression yes -> stop", a1.status === 200 && a1.json.stop === true, JSON.stringify(a1.json));
  const f1 = await api("POST", `/api/screen/sessions/${s1.json.session_id}/finish`);
  check("E-2 finish -> red_flag true, no band", f1.status === 200 && f1.json.red_flag === true && f1.json.result_band === null && f1.json.domains.length === 0, JSON.stringify(f1.json));
  const [row1] = await sql`select result_band, red_flag_codes from screen_sessions where id = ${s1.json.session_id}`;
  check("E-2 red_flag_codes stored", row1.red_flag_codes.join() === "skill_regression" && row1.result_band === null, JSON.stringify(row1));

  // ---------- E-3 demo voice ----------
  const v = await api("POST", "/api/screen/sessions", { age_band: "6-9y", mode: "voice" });
  check("E-3 DEMO_MODE voice -> { demo: true }, no token", v.status === 201 && v.json.demo === true && !("conversation_token" in v.json), `HTTP ${v.status} demo=${v.json?.demo}`);

  // ---------- E-4.1 ----------
  const cols = await sql`select column_name from information_schema.columns where table_schema='public' and table_name='screen_sessions' order by ordinal_position`;
  check("E-4.1 screen_sessions columns = FR-5 (no IP)", cols.map((c) => c.column_name).join(",") === "id,created_at,expires_at,age_band,mode,answers,result_band,red_flag_codes,conversation_id,saved_child_id,saved_by", cols.map((c) => c.column_name).join(","));

  // ---------- E-4.2 API ----------
  const s2 = await api("POST", "/api/screen/sessions", { age_band: "3-5y", mode: "form" });
  const answers = s2.json.questions.map((q) => ({ item_id: q.id, answer: someConcerns(q.id) }));
  await api("POST", `/api/screen/sessions/${s2.json.session_id}/answers`, { answers });
  const f2 = await api("POST", `/api/screen/sessions/${s2.json.session_id}/finish`);
  check("E-1 API some-concerns pattern -> discuss_with_professional", f2.json.result_band === "discuss_with_professional", JSON.stringify(f2.json.domains));
  const anon = await api("POST", "/api/family/screen-results", { session_id: s2.json.session_id, child_id: childA.id });
  check("E-4.2 anonymous save -> 401", anon.status === 401, `HTTP ${anon.status}`);
  const nc = await api("POST", "/api/family/screen-results", { session_id: s2.json.session_id, child_id: childA.id }, { jar: ga });
  check("E-4.2 guardian_a without consent -> 422", nc.status === 422 && nc.json.details?.feature === "screen_result_save", JSON.stringify(nc.json));
  const other = await api("POST", "/api/family/screen-results", { session_id: s2.json.session_id, child_id: childB.id }, { jar: ga });
  check("E-4.2 guardian_a -> guardian_b's child -> 404", other.status === 404, `HTTP ${other.status} ${JSON.stringify(other.json)}`);
  const docs = await sql`select id from consent_documents where feature = 'screen_result_save' and locale = 'en' order by version desc limit 1`;
  const allow = await api("POST", `/api/family/children/${childA.id}/consents`, { feature: "screen_result_save", consent_document_id: docs[0].id, agree: true }, { jar: ga });
  check("E-4.2 allow screen_result_save (020 API)", allow.status === 201, `HTTP ${allow.status}`);
  const ok = await api("POST", "/api/family/screen-results", { session_id: s2.json.session_id, child_id: childA.id }, { jar: ga });
  check("E-4.2 allow -> saved to own child", ok.status === 201 && ok.json.saved === true, `HTTP ${ok.status}`);
  const [row2] = await sql`select saved_child_id, saved_by from screen_sessions where id = ${s2.json.session_id}`;
  check("E-4.2 row linked to child and guardian", row2.saved_child_id === childA.id && row2.saved_by === accounts.guardian_a.id);

  // Rate limit (FR-4): 5 per IP per hour.
  const ip = `198.18.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
  const statuses = [];
  for (let i = 0; i < 6; i++) statuses.push((await api("POST", "/api/screen/sessions", { age_band: "3-5y", mode: "form" }, { ip })).status);
  check("FR-4 rate limit 5 sessions/hour per IP", statuses.join(",") === "201,201,201,201,201,429", statuses.join(","));

  // ---------- browser ----------
  const browser = await chromium.launch({ headless: true, args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
  const shots = [];
  const newPage = async (jar, locale) => {
    const context = await browser.newContext({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 2, extraHTTPHeaders: { "x-forwarded-for": `198.19.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` } });
    const cookies = [...(jar ?? []).map((c) => ({ name: c.name, value: c.value, url: BASE })), ...(locale ? [{ name: "dnm_locale", value: locale, url: BASE }] : [])];
    if (cookies.length) await context.addCookies(cookies);
    const p = await context.newPage();
    p.setDefaultTimeout(20_000);
    const problems = [];
    const thirdParty = [];
    p.on("console", (m) => m.type() === "error" && problems.push(m.text()));
    p.on("pageerror", (e) => problems.push(String(e)));
    p.on("request", (r) => !r.url().startsWith(BASE) && !r.url().startsWith("data:") && !r.url().startsWith("blob:") && thirdParty.push(r.url()));
    return { p, context, problems, thirdParty };
  };
  const noHScroll = (p) => p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  const answerAll = async (p, pick) => {
    for (let i = 0; i < 21; i++) {
      const item = await p.locator("fieldset[data-item]").getAttribute("data-item");
      const label = { never: "Never", sometimes: "Sometimes", often: "Often", always: "Always", yes: "Yes", no: "No" }[pick(item)];
      await p.getByRole("radio", { name: label, exact: true }).check();
      await p.waitForTimeout(150);
      if (i < 20) await p.getByRole("button", { name: "Next", exact: true }).click();
    }
    await p.getByRole("button", { name: "See my result", exact: true }).click();
  };

  // E-1
  {
    const { p, context, problems, thirdParty } = await newPage();
    await p.goto(`${BASE}/screen`);
    await p.waitForLoadState("networkidle");
    const disabled = await p.getByRole("button", { name: "Answer by tapping instead", exact: true }).isDisabled();
    const vDisabled = await p.getByRole("button", { name: "Start voice check-in", exact: true }).isDisabled();
    await p.getByRole("radio", { name: "3-5 years" }).check();
    const stillDisabled = await p.getByRole("button", { name: "Answer by tapping instead", exact: true }).isDisabled();
    await p.screenshot({ path: path.join(OUT, "screen-intro-en-375.png"), fullPage: true });
    shots.push("screen-intro-en-375.png");
    await p.getByLabel("I understand this is not a diagnosis and agree to talk to an AI assistant.").check();
    const enabled = await p.getByRole("button", { name: "Answer by tapping instead", exact: true }).isEnabled();
    check("E-1 Start disabled until ticked (both buttons)", disabled && vDisabled && stillDisabled && enabled, `before=${disabled}/${vDisabled}, age only=${stillDisabled}, ticked enabled=${enabled}`);
    await p.getByRole("button", { name: "Answer by tapping instead", exact: true }).click();
    await p.locator("fieldset[data-item]").waitFor();
    await p.screenshot({ path: path.join(OUT, "screen-form-safety-question-375.png"), fullPage: true });
    shots.push("screen-form-safety-question-375.png");
    await answerAll(p, someConcerns);
    await p.getByTestId("screen-result").waitFor();
    const text = await p.locator("main").innerText();
    check("E-1 headline 'Some areas are worth discussing with a professional'", text.includes("Some areas are worth discussing with a professional"));
    check("E-1 'not a diagnosis' line", text.includes("This is a developmental check-in, not a diagnosis."));
    const types = await p.locator("[data-testid=screen-directory] [data-type]").evaluateAll((els) => els.map((e) => e.getAttribute("data-type")));
    check("E-1 directory with suggested types", types.join(",") === "developmental_pediatrician,child_psychologist,speech_language_pathologist,occupational_therapist", types.join(","));
    await p.getByLabel("Your locality").selectOption("Banjara Hills");
    await p.getByRole("button", { name: "Show specialists", exact: true }).click();
    await p.getByText("e033 Dr Synthetic Devped (synthetic)").waitFor({ timeout: 10_000 }).catch(() => {});
    const dir = await p.getByTestId("screen-directory").innerText();
    check("E-1 nearby providers from 029 search (location prompt)", dir.includes("e033 Dr Synthetic Devped (synthetic)") && dir.includes("e033 Synthetic Speech Therapist (synthetic)") && dir.includes("km away"), dir.split("\n").filter((l) => /e033|km away/.test(l)).join(" | "));
    check("E-1 no booking from the result page", !(await p.locator("main").innerText()).match(/\bBook\b/));
    check("E-1 375 px: no horizontal scroll", await noHScroll(p));
    await p.screenshot({ path: path.join(OUT, "screen-result-some-concerns-375.png"), fullPage: true });
    shots.push("screen-result-some-concerns-375.png");
    check("E-1 no console errors, no third-party requests", problems.length === 0 && thirdParty.length === 0, `errors=${problems.length} ${problems.slice(0, 2).join(" / ")} third-party=${thirdParty.length} ${thirdParty.slice(0, 3).join(" ")}`);
    await context.close();
  }

  // E-2
  {
    const { p, context, problems } = await newPage();
    await p.goto(`${BASE}/screen`);
    await p.getByRole("radio", { name: "3-5 years" }).check();
    await p.getByLabel("I understand this is not a diagnosis and agree to talk to an AI assistant.").check();
    await p.getByRole("button", { name: "Answer by tapping instead", exact: true }).click();
    const first = await p.locator("fieldset[data-item]").getAttribute("data-item");
    await p.getByRole("radio", { name: "Yes", exact: true }).click();
    await p.getByTestId("screen-urgent").waitFor();
    const mainText = (await p.locator("main").innerText()).trim();
    // Rendered DOM only (the RSC payload in <script> tags carries the whole message catalogue as data).
    const dom = await p.evaluate(() => {
      const clone = document.body.cloneNode(true);
      clone.querySelectorAll("script, template").forEach((n) => n.remove());
      return clone.innerHTML;
    });
    const bodyText = await p.evaluate(() => document.body.innerText);
    check("E-2 regression question first and yes -> only the 108/112 message", first === "rf_skill_regression" && mainText === "Please get help now. Call 108 for an ambulance or 112 for emergencies. If your child is not in immediate danger, contact your child's doctor today.", mainText);
    check("E-2 no provider list or 'Book' anywhere in the DOM", !/screen-directory|screen-result|data-band|>Book</.test(dom) && !/\bBook\b|Find a specialist|specialist/i.test(bodyText), `elements: directory=${dom.includes("screen-directory")} result=${dom.includes("screen-result")}`);
    await p.screenshot({ path: path.join(OUT, "screen-red-flag-375.png"), fullPage: true });
    shots.push("screen-red-flag-375.png");
    await p.reload();
    await p.getByTestId("screen-urgent").waitFor();
    check("E-2 reload keeps showing only the urgent message", ((await p.locator("main").innerText()).trim()).startsWith("Please get help now."));
    check("E-2 no console errors", problems.length === 0, problems.slice(0, 2).join(" / "));
    await context.close();
  }

  // E-3 demo
  {
    const { p, context, thirdParty } = await newPage();
    await p.goto(`${BASE}/screen`);
    await p.getByRole("radio", { name: "6-9 years" }).check();
    await p.getByLabel("I understand this is not a diagnosis and agree to talk to an AI assistant.").check();
    await p.getByRole("button", { name: "Start voice check-in", exact: true }).click();
    await p.getByText("Demo mode: no live voice call. Please answer by tapping.").waitFor();
    const hasForm = await p.locator("fieldset[data-item]").count();
    check("E-3 DEMO_MODE: demo notice, tap-through form on the same session, no SDK start", hasForm === 1 && thirdParty.filter((u) => u.includes("elevenlabs")).length === 0 && (await p.getByTestId("screen-voice").count()) === 0, `elevenlabs requests=${thirdParty.filter((u) => u.includes("elevenlabs")).length}`);
    await p.screenshot({ path: path.join(OUT, "screen-voice-demo-375.png"), fullPage: true });
    shots.push("screen-voice-demo-375.png");
    await context.close();
  }

  // E-3b: live voice path with a stubbed token: the SDK starts under the /screen CSP (no CSP violation), the
  // ElevenLabs connection is aborted by the test (no real third-party traffic) and the page falls back to tapping.
  {
    const { p, context, problems } = await newPage();
    await context.grantPermissions(["microphone"], { origin: BASE });
    const elevenlabs = [];
    await p.route(/elevenlabs\.io/, (route) => {
      elevenlabs.push(route.request().url());
      return route.abort();
    });
    await p.route("**/api/screen/sessions", async (route) => {
      const response = await route.fetch();
      const json = await response.json();
      delete json.demo;
      json.conversation_token = "stub-token-for-test";
      json.dynamic_variables = { screen_session_id: json.session_id, age_band: "3-5y", questions: "1. [rf_skill_regression] ..." };
      await route.fulfill({ response, json });
    });
    await p.goto(`${BASE}/screen`);
    await p.getByRole("radio", { name: "3-5 years" }).check();
    await p.getByLabel("I understand this is not a diagnosis and agree to talk to an AI assistant.").check();
    await p.getByRole("button", { name: "Start voice check-in", exact: true }).click();
    await p.getByTestId("screen-voice").waitFor({ timeout: 10_000 }).catch(() => {});
    const sawVoice = (await p.getByTestId("screen-voice").count()) > 0;
    await p.locator("fieldset[data-item]").waitFor({ timeout: 40_000 }).catch(() => {});
    const fellBack = (await p.locator("fieldset[data-item]").count()) === 1;
    const notice = (await p.locator("main").innerText()).includes("The voice call stopped. You can continue by tapping.");
    const csp = problems.filter((m) => /Content Security Policy|Refused to/i.test(m));
    check("E-3b voice start (stub token): SDK connects only to ElevenLabs, no CSP violation, falls back to tapping", sawVoice && fellBack && csp.length === 0 && elevenlabs.length > 0, `voice panel=${sawVoice}, fallback form=${fellBack}, notice=${notice}, ElevenLabs requests (aborted)=${elevenlabs.length} ${elevenlabs.slice(0, 1).map((u) => u.split("?")[0]).join("")}, CSP errors=${csp.length} ${csp.slice(0, 1).join("")}`);
    await p.screenshot({ path: path.join(OUT, "screen-voice-fallback-375.png"), fullPage: true });
    shots.push("screen-voice-fallback-375.png");
    await context.close();
  }

  // E-4 UI: guardian_b saves with the inline Allow dialog; the child page lists it.
  {
    const { p, context, problems } = await newPage(gb);
    await p.goto(`${BASE}/screen`);
    await p.getByRole("radio", { name: "18-36 months" }).check();
    await p.getByLabel("I understand this is not a diagnosis and agree to talk to an AI assistant.").check();
    await p.getByRole("button", { name: "Answer by tapping instead", exact: true }).click();
    await answerAll(p, (id) => (id.startsWith("rf_") ? "no" : reverse.has(id) ? "always" : "never"));
    await p.getByTestId("screen-result").waitFor();
    check("E-4 UI no-concerns pattern -> 'No strong signs from this check-in'", (await p.locator("main").innerText()).includes("No strong signs from this check-in"));
    if (await p.getByLabel("Child").count()) await p.getByLabel("Child").selectOption({ label: childB.display_name });
    await p.getByRole("button", { name: `Save this result to ${childB.display_name}`, exact: true }).click();
    await p.getByTestId("screen-consent").waitFor();
    await p.screenshot({ path: path.join(OUT, "screen-save-allow-dialog-375.png"), fullPage: true });
    shots.push("screen-save-allow-dialog-375.png");
    check("E-4 UI 422 -> inline Allow dialog", (await p.getByTestId("screen-consent").innerText()).includes(`Allow saving check-ins for ${childB.display_name}`));
    await p.getByLabel("I have read this and allow it.").check();
    await p.getByRole("button", { name: "Allow and save", exact: true }).click();
    await p.getByTestId("screen-saved").waitFor();
    check("E-4 UI allow -> saved", (await p.getByTestId("screen-saved").innerText()).includes(`Saved to ${childB.display_name}'s profile.`));
    await p.goto(`${BASE}/family/children/${childB.id}`);
    const checkins = await p.getByTestId("child-checkins").innerText();
    check("FR-8 child page lists it under Check-ins (date, age band, headline)", checkins.includes("No strong signs from this check-in") && checkins.includes("Age 18-36 months"), checkins.replace(/\n/g, " | "));
    await p.getByTestId("child-checkins").screenshot({ path: path.join(OUT, "family-child-checkins-375.png") });
    shots.push("family-child-checkins-375.png");
    // The browser logs the designed 422 (consent required) of the first save attempt as a failed resource.
    const unexpected = problems.filter((m) => !m.includes("status of 422"));
    check("E-4 UI no console errors (besides the designed 422 consent answer)", unexpected.length === 0, `${problems.length} logged: ${problems.join(" / ")}`);
    await context.close();
  }

  // Anonymous save -> sign-in link back to /screen (sessionStorage resume).
  {
    const { p, context } = await newPage();
    await p.goto(`${BASE}/screen`);
    await p.getByRole("radio", { name: "10+ years" }).check();
    await p.getByLabel("I understand this is not a diagnosis and agree to talk to an AI assistant.").check();
    await p.getByRole("button", { name: "Answer by tapping instead", exact: true }).click();
    await answerAll(p, (id) => (id.startsWith("rf_") ? "no" : reverse.has(id) ? "never" : "always"));
    await p.getByTestId("screen-result").waitFor();
    const band = await p.getByTestId("screen-result").getAttribute("data-band");
    const href = await p.getByRole("link", { name: "Sign in to save" }).getAttribute("href");
    await p.reload();
    await p.getByTestId("screen-result").waitFor();
    check("FR-8 anonymous: 'Sign in to save' -> /family/login?next=/screen; result survives reload", band === "see_professional_soon" && href === "/family/login?next=%2Fscreen", `band=${band} href=${href}`);
    await context.close();
  }

  // Hindi chrome
  {
    const { p, context } = await newPage(undefined, "hi");
    await p.goto(`${BASE}/screen`);
    const h1 = await p.locator("h1").innerText();
    await p.screenshot({ path: path.join(OUT, "screen-intro-hi-375.png"), fullPage: true });
    shots.push("screen-intro-hi-375.png");
    check("FR-2 translated chrome (hi)", h1 === "विकास जाँच", h1);
    await context.close();
  }
  await browser.close();

  log.push(`Screenshots: ${shots.join(", ")}`);
  log.push(`TOTAL: ${pass} PASS, ${failCount} FAIL`);
  writeFileSync(path.join(OUT, "acceptance.txt"), `${log.join("\n")}\n`);
  console.log(`TOTAL: ${pass} PASS, ${failCount} FAIL`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => sql.end());
