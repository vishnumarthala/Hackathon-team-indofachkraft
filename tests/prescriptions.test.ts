// Ticket 039: e-prescriptions for verified prescribers.
// Pure checks: item schema limits (FR-2), allergy matching, document wording (allergy status never "none" when not
// recorded), deterministic markdown/hash and PDF bytes with every required field in the PDF text (FR-4, NFR-2).
// Database checks (real route handlers, local Supabase): prescriber gate matrix (verified / suspended / pending /
// non-prescriber types / non-medical council), E-1 draft from the 038 rx_draft -> edit -> sign -> PDF -> guardian
// (+ notification without drug names), E-2 allergy match needs an override reason, immutability trigger, void, E-3
// authz negatives (SLP 403, other org 404, guardian_b 404, suspended between draft and sign 403 at all three layers),
// strict audit failure -> 503 and nothing signed, and the 041 privacy registry entry. Synthetic data only.
import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";
import { loadEnvConfig } from "@next/env";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { STRICT_ACTIONS } from "@/lib/audit/strict-actions";
import { contentHash } from "@/lib/clinical/publish";
import { REGISTRY } from "@/lib/privacy/registry";
import { ageOn, allergyLine, formatIst, prescriptionMarkdown, type RxDocument } from "@/lib/rx/document";
import { renderPrescriptionPdf } from "@/lib/rx/pdf";
import { RxItemSchema, RxPatchSchema, RxSignSchema, allergyMatches, signIssues, type RxItem } from "@/lib/rx/schema";
import { createWorld, ctx, post, type TestUser } from "./helpers/world";

loadEnvConfig(process.cwd(), false, { info: () => {}, error: () => {} });
const enabled = Boolean(process.env.DATABASE_URL) && process.env.SKIP_DB_TESTS !== "1";

const session = vi.hoisted(() => ({ user: null as null | { id: string; email: string } }));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, getAuthenticatedUser: vi.fn(async () => session.user) };
});

type AnyRow = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Text drawn on the pages of a pdf-lib PDF (standard fonts write hex strings). */
function pdfText(bytes: Uint8Array): string {
  const raw = Buffer.from(bytes).toString("latin1");
  let content = "";
  for (const m of raw.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    let body = Buffer.from(m[1], "latin1");
    try {
      body = inflateSync(body);
    } catch {
      // not compressed
    }
    content += body.toString("latin1");
  }
  return [...content.matchAll(/<([0-9A-Fa-f]+)> Tj/g)].map((x) => Buffer.from(x[1], "hex").toString("latin1")).join("\n");
}

const ITEM: RxItem = {
  drug: "Synthetic-paracetamol",
  strength: "120 mg/5 ml",
  form: "syrup",
  dose: "5 ml",
  frequency: "three times a day",
  duration_days: 3,
  route: "oral",
  instructions: "After food",
};

const DOC: RxDocument = {
  child: { name: "Asha (synthetic)", age: "4 years 2 months", date_of_birth: "2022-09-01" },
  prescriber: {
    name: "Dr Synthetic Paed",
    qualifications: "MBBS, MD",
    provider_type: "pediatrician",
    council: "NMC",
    council_state: null,
    registration_number: "SYN-0039",
    org: "Synthetic Centre",
    address: "1 Test Road, Banjara Hills, Hyderabad 500034",
  },
  allergies: { status: "not_recorded", allergies: [], medications: [], health_profile_version: 0, matches: [], override_reason: null },
  items: [ITEM],
  advice: "Plenty of fluids.",
  follow_up: "Review in 1 week",
  signed_at: "2026-11-13T04:00:00.000Z",
  version: 1,
};

describe("FR-2 item schema and request bodies", () => {
  it("validates drug name, form, duration and at most 15 items; drafts may leave dose empty but signing may not", () => {
    expect(RxItemSchema.safeParse(ITEM).success).toBe(true);
    expect(RxItemSchema.safeParse({ ...ITEM, drug: "" }).success).toBe(false);
    expect(RxItemSchema.safeParse({ ...ITEM, drug: "x".repeat(121) }).success).toBe(false);
    expect(RxItemSchema.safeParse({ ...ITEM, form: "injection" }).success).toBe(false);
    expect(RxItemSchema.safeParse({ ...ITEM, duration_days: 0 }).success).toBe(false);
    expect(RxItemSchema.safeParse({ ...ITEM, duration_days: 366 }).success).toBe(false);
    expect(RxItemSchema.safeParse({ ...ITEM, citations: [] }).success).toBe(false);
    expect(RxPatchSchema.safeParse({ items: Array(15).fill(ITEM), advice: null, follow_up: null, version: 1 }).success).toBe(true);
    expect(RxPatchSchema.safeParse({ items: Array(16).fill(ITEM), advice: null, follow_up: null, version: 1 }).success).toBe(false);
    const draft = RxItemSchema.parse({ drug: "Synthetic-zinc", form: "tablet", duration_days: 5 });
    expect(signIssues([draft])).toEqual({
      "items.0.dose": "Enter the dose",
      "items.0.frequency": "Enter how often",
      "items.0.route": "Enter the route",
    });
    expect(signIssues([ITEM])).toEqual({});
    // The confirmation is required and must be literally true (no client flag can stand in for it).
    expect(RxSignSchema.safeParse({}).success).toBe(false);
    expect(RxSignSchema.safeParse({ confirm: "true" }).success).toBe(false);
    expect(RxSignSchema.safeParse({ confirm: true, can_prescribe: true }).success).toBe(false);
  });

  it("allergy matching ignores case and punctuation, needs whole words, and reports every match", () => {
    const allergies = [
      { substance: "Synthetic-drug-X", severity: "severe" },
      { substance: "Peanut", severity: "mild" },
    ];
    expect(allergyMatches([{ drug: "synthetic drug x" }], allergies)).toEqual([
      { item_index: 0, drug: "synthetic drug x", substance: "Synthetic-drug-X", severity: "severe" },
    ]);
    expect(allergyMatches([{ drug: "Paracetamol" }, { drug: "SYNTHETIC-DRUG-X 5 mg" }], allergies).map((m) => m.item_index)).toEqual([1]);
    expect(allergyMatches([{ drug: "Synthetic-drug-XY" }], allergies)).toEqual([]);
    expect(allergyMatches([{ drug: "Peanut oil drops" }], allergies)).toHaveLength(1);
    expect(allergyMatches([{ drug: "Anything" }], [])).toEqual([]);
  });
});

describe("FR-4 / NFR-2 document and PDF", () => {
  it("allergy wording: unknown is never 'none'; NKA and listed allergies are explicit", () => {
    expect(allergyLine(DOC.allergies)).toMatch(/NOT RECORDED - allergy status unknown/);
    expect(allergyLine(DOC.allergies)).not.toMatch(/no known|none/i);
    expect(allergyLine({ ...DOC.allergies, status: "none_known" })).toBe("No known allergies (as recorded by the family)");
    expect(
      allergyLine({ ...DOC.allergies, status: "listed", allergies: [{ substance: "Synthetic-drug-X", reaction: "rash", severity: "severe" }] }),
    ).toBe("Synthetic-drug-X (severe, rash)");
  });

  it("IST timestamps and ages are computed by hand (no runtime locale data)", () => {
    expect(formatIst("2026-11-12T20:00:00.000Z")).toBe("13 Nov 2026, 01:30 IST");
    expect(ageOn("2022-09-14", new Date("2026-11-13T04:00:00Z"))).toBe("4 years 1 month");
    expect(ageOn("2026-01-20", new Date("2026-11-13T04:00:00Z"))).toBe("9 months");
    expect(ageOn(null, new Date(), 30)).toBe("2 years 6 months");
    expect(ageOn(null, new Date())).toBeNull();
  });

  it("the markdown and the PDF bytes are deterministic; the PDF carries every required field and the footer", async () => {
    const md = prescriptionMarkdown(DOC);
    expect(prescriptionMarkdown(structuredClone(DOC))).toBe(md);
    const hash = contentHash(md);
    expect(hash).toBe(createHash("sha256").update(md, "utf8").digest("hex"));
    const a = await renderPrescriptionPdf(DOC, hash);
    const b = await renderPrescriptionPdf(structuredClone(DOC), hash);
    expect(Buffer.compare(Buffer.from(a), Buffer.from(b))).toBe(0);
    expect(Buffer.from(a).subarray(0, 5).toString()).toBe("%PDF-");
    const text = pdfText(a);
    for (const expected of [
      "Dr Synthetic Paed",
      "National Medical Commission (NMC) - Registration No. SYN-0039",
      "13 Nov 2026, 09:30 IST",
      "Asha (synthetic), 4 years 2 months",
      "NOT RECORDED - allergy status unknown",
      "Synthetic-paracetamol 120 mg/5 ml syrup - 5 ml, three times a day, for 3 days (oral)",
      "Instructions: After food",
      "Plenty of fluids.",
      "Review in 1 week",
      "Digitally generated on DoctorNearMe; signed by Dr Synthetic Paed on 13 Nov 2026, 09:30 IST.",
      `Content hash (SHA-256): ${hash}`,
      "AI drafts are reviewed and signed by the prescriber. Generated by DoctorNearMe.",
    ]) {
      expect(text, expected).toContain(expected);
    }
    // Text outside the standard font (e.g. Telugu) cannot break rendering.
    const telugu = await renderPrescriptionPdf({ ...DOC, child: { ...DOC.child, name: "ఆశ (synthetic)" } }, hash);
    expect(pdfText(telugu)).toContain("? (synthetic)");
    // 15 long items wrap and continue on a second page with the footer on each page.
    const long = await renderPrescriptionPdf({ ...DOC, items: Array(15).fill({ ...ITEM, instructions: "x ".repeat(140) }) }, hash);
    expect(pdfText(long)).toContain("Page 2 of");
  });

  it("rx.signed and rx.voided are strict audit actions; prescriptions are in the privacy registry", () => {
    expect(STRICT_ACTIONS.find((a) => a.action === "rx.signed")).toMatchObject({ call: "signPrescription", impl: { kind: "auditStrict", module: "lib/rx/index.ts" } });
    expect(STRICT_ACTIONS.find((a) => a.action === "rx.voided")).toMatchObject({ call: "voidPrescription" });
    const entry = REGISTRY.find((c) => c.key === "prescriptions");
    expect(entry).toMatchObject({ tables: ["prescriptions", "prescription_versions"], buckets: ["prescriptions"] });
    expect(entry?.erase?.scopes).toEqual(["everything"]);
    expect(typeof entry?.export).toBe("function");
  });
});

describe.skipIf(!enabled)("prescriptions (database)", () => {
  let sql: Sql;
  let db: ReturnType<typeof import("@/lib/db").supabaseAdmin>;
  let world: ReturnType<typeof createWorld>;
  let owner: TestUser;
  let providerRx: TestUser;
  let providerA: TestUser;
  let providerB: TestUser;
  let matrixUser: TestUser;
  let guardianA: TestUser;
  let guardianB: TestUser;
  let orgA: string;
  let caseA: string;
  let childA: string;
  let caseB: string;
  let rxDraftReport: string;
  const profiles: string[] = [];
  const pdfPaths: string[] = [];

  const as = (u: TestUser | null) => {
    session.user = u ? { id: u.id, email: u.email } : null;
  };
  const routes = async () => ({
    list: await import("@/app/api/cases/[id]/prescriptions/route"),
    one: await import("@/app/api/prescriptions/[id]/route"),
    sign: await import("@/app/api/prescriptions/[id]/sign/route"),
    voids: await import("@/app/api/prescriptions/[id]/void/route"),
    pdf: await import("@/app/api/prescriptions/[id]/pdf/route"),
    familyPdf: await import("@/app/api/family/prescriptions/[id]/pdf/route"),
    familyList: await import("@/app/api/family/children/[id]/prescriptions/route"),
  });
  type Res = { status: number; body: AnyRow };
  const json = async (res: Response): Promise<Res> => ({ status: res.status, body: await res.json().catch(() => ({})) });
  const listRx = async (caseId: string) => json(await (await routes()).list.GET(post("http://x", undefined, "GET"), ctx({ id: caseId })));
  const create = async (caseId: string, body: Record<string, unknown> = {}) => json(await (await routes()).list.POST(post("http://x", body), ctx({ id: caseId })));
  const getRx = async (id: string) => json(await (await routes()).one.GET(post("http://x", undefined, "GET"), ctx({ id })));
  const patch = async (id: string, body: Record<string, unknown>) => json(await (await routes()).one.PATCH(post("http://x", body, "PATCH"), ctx({ id })));
  const sign = async (id: string, body: Record<string, unknown> = { confirm: true }) => json(await (await routes()).sign.POST(post("http://x", body), ctx({ id })));
  const voidRx = async (id: string, body: Record<string, unknown>) => json(await (await routes()).voids.POST(post("http://x", body), ctx({ id })));
  const pdf = async (id: string) => (await routes()).pdf.GET(post("http://x", undefined, "GET"), ctx({ id }));
  const familyPdf = async (id: string) => (await routes()).familyPdf.GET(post("http://x", undefined, "GET"), ctx({ id }));
  const familyList = async (childId: string) => json(await (await routes()).familyList.GET(post("http://x", undefined, "GET"), ctx({ id: childId })));

  async function profile(user: TestUser, type: string, council: string | null, status = "verified") {
    const [row] = await sql<{ id: string }[]>`
      insert into provider_profiles (user_id, slug, display_name, provider_type, qualifications, registration_council,
                                     registration_state, registration_number, verification_status, verified_at, claimed,
                                     is_synthetic, created_by)
      values (${user.id}, ${`t039-${type.replace(/_/g, "-")}-${user.id.slice(0, 8)}`}, ${`Dr Synthetic ${type}`}, ${type},
              ${"MBBS, MD (synthetic)"}, ${council}, ${council === "STATE_MEDICAL_COUNCIL" ? "Telangana" : null},
              ${council ? "SYN-0039" : null}, ${status}, ${status === "verified" ? new Date() : null}, true, true, ${user.id})
      returning id`;
    profiles.push(row.id);
    return row.id;
  }

  const items = (overrides: Partial<RxItem>[] = [{}]) => overrides.map((o) => ({ ...ITEM, ...o }));

  async function signedVersion(rxId: string) {
    const [row] = await sql<AnyRow[]>`
      select v.* from prescription_versions v join prescriptions p on p.id = v.prescription_id and v.version = p.current_version
      where p.id = ${rxId}`;
    return row;
  }

  beforeAll(async () => {
    sql = postgres(process.env.DATABASE_URL as string, { max: 4, prepare: false, onnotice: () => {} });
    db = (await import("@/lib/db")).supabaseAdmin();
    world = createWorld(sql, db, "t039");
    owner = await world.user("owner", "provider");
    providerRx = await world.user("paed", "provider");
    providerA = await world.user("slp", "provider");
    providerB = await world.user("otherorg", "provider");
    matrixUser = await world.user("matrix", "provider");
    guardianA = await world.user("guardian-a", "guardian");
    guardianB = await world.user("guardian-b", "guardian");
    orgA = await world.org(owner, "Centre A");
    const orgB = await world.org(providerB, "Solo B");
    for (const u of [providerRx, providerA, matrixUser]) await world.member(orgA, u);
    await profile(providerRx, "pediatrician", "NMC");
    await profile(providerA, "speech_language_pathologist", "RCI");
    await profile(providerB, "pediatrician", "NMC");
    const kaseA = await world.kase(orgA);
    caseA = kaseA.caseId;
    childA = kaseA.childId;
    await sql`update children set display_name = 'Asha Synthetic', date_of_birth = '2022-07-10' where id = ${childA}`;
    for (const u of [providerRx, providerA, matrixUser]) await sql`insert into case_assignments (case_id, user_id) values (${caseA}, ${u.id})`;
    await world.link(childA, guardianA);
    const kaseB = await world.kase(orgB);
    caseB = kaseB.caseId;
    await world.link(kaseB.childId, guardianB);
    // 021: the child's health profile with the eval's allergy.
    await sql`
      insert into child_health_profiles (child_id, allergies, medications, updated_by)
      values (${childA}, ${sql.json([{ substance: "Synthetic-drug-X", reaction: "hives", severity: "severe" }])},
              ${sql.json([{ name: "Synthetic iron drops", dose: "1 ml", frequency: "once daily" }])}, ${guardianA.id})`;
    // 038: an Rx draft from the AI scribe (RxDraftContent).
    const [rep] = await sql<{ id: string }[]>`
      insert into reports (case_id, recording_id, kind, content, content_md, status)
      values (${caseA}, ${kaseA.recordingId}, 'rx_draft', ${sql.json({
        items: [{ ...ITEM, instructions: null, citations: [{ segment_id: "s1", quote: "fever", start_sec: 0, end_sec: 5, verified: true }] }],
        advice: "Plenty of fluids.",
        follow_up: "Review in 1 week",
        health_summary: "Allergies: Synthetic-drug-X (severe, hives)",
      })}, '', 'draft')
      returning id`;
    rxDraftReport = rep.id;
  });

  afterAll(async () => {
    as(null);
    delete process.env.AUDIT_FAIL_ACTIONS;
    if (sql) {
      const rows = await sql<{ path: string }[]>`
        select v.pdf_path as path from prescription_versions v join prescriptions p on p.id = v.prescription_id
        where p.case_id in ${sql([caseA, caseB].filter(Boolean))} and v.pdf_path is not null`;
      const paths = [...new Set([...pdfPaths, ...rows.map((r) => r.path)])];
      if (paths.length) await db.storage.from("prescriptions").remove(paths);
      await sql`delete from outbox_events where aggregate_type = 'prescription' and payload ->> 'child_id' = ${childA}`;
      await sql`delete from cases where id in ${sql([caseA, caseB].filter(Boolean))}`;
      if (profiles.length) await sql`delete from provider_profiles where id in ${sql(profiles)}`;
    }
    if (world) await world.cleanup();
    await sql?.end({ timeout: 5 });
  });

  it("NFR-1 gate matrix: only verified prescriber types with a medical council (derived server-side on every call)", async () => {
    as(matrixUser);
    expect(await listRx(caseA)).toMatchObject({ status: 403, body: { error: "Only verified prescribers can write prescriptions" } });
    const combos: [string, string | null, string, number][] = [
      ["pediatrician", "NMC", "verified", 200],
      ["developmental_pediatrician", "STATE_MEDICAL_COUNCIL", "verified", 200],
      ["child_psychiatrist", "NMC", "verified", 200],
      ["pediatrician", "NMC", "suspended", 403],
      ["pediatrician", "NMC", "pending", 403],
      ["pediatrician", "NMC", "rejected", 403],
      ["pediatrician", "RCI", "verified", 403],
      ["pediatrician", "OTHER", "verified", 403],
      ["child_psychologist", "NMC", "verified", 403],
      ["occupational_therapist", "OTHER", "verified", 403],
    ];
    for (const [type, council, status, expected] of combos) {
      await sql`delete from provider_profiles where user_id = ${matrixUser.id}`;
      await profile(matrixUser, type, council, status);
      const res = await listRx(caseA);
      expect(res.status, `${type}/${council}/${status}`).toBe(expected);
    }
    // Client flags are ignored: the body cannot claim prescriber rights.
    await sql`delete from provider_profiles where user_id = ${matrixUser.id}`;
    expect((await create(caseA, { can_prescribe: true })).status).toBe(403);
  });

  let rx1: string;

  it("E-1: draft from the 038 rx_draft -> edit a dose -> sign -> version 1 with snapshots, published, audited, notified", async () => {
    as(providerRx);
    const created = await create(caseA, { from_report_id: rxDraftReport });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    rx1 = created.body.prescription.id;
    expect(created.body.prescription).toMatchObject({ status: "draft", source_report_id: rxDraftReport, child_id: childA, org_id: orgA });
    expect(created.body.current.items).toEqual([{ ...ITEM, instructions: null }]);
    expect(created.body.current).toMatchObject({ advice: "Plenty of fluids.", follow_up: "Review in 1 week", signed_at: null });
    // Opening the same AI draft again continues the same prescription.
    expect(await create(caseA, { from_report_id: rxDraftReport })).toMatchObject({ status: 200, body: { created: false, prescription: { id: rx1 } } });
    // Another case's id / a non-rx_draft report -> 404.
    expect((await create(caseA, { from_report_id: "00000000-0000-4000-8000-000000000039" })).status).toBe(404);

    const version = created.body.prescription.version as number;
    const edited = await patch(rx1, { items: items([{ dose: "4 ml" }]), advice: "Plenty of fluids.", follow_up: "Review in 1 week", version });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect(edited.body.current.items[0].dose).toBe("4 ml");
    expect(await patch(rx1, { items: items(), advice: null, follow_up: null, version })).toMatchObject({ status: 409 });

    expect((await sign(rx1, {})).status).toBe(400);
    const signed = await sign(rx1);
    expect(signed.status, JSON.stringify(signed.body)).toBe(200);
    expect(signed.body.version).toMatchObject({ version: 1, signed_by: providerRx.id });
    const v = await signedVersion(rx1);
    expect(v.signed_at).toBeInstanceOf(Date);
    expect(v.content_hash).toBe(createHash("sha256").update(v.content_md, "utf8").digest("hex"));
    expect(v.child_snapshot).toMatchObject({ name: "Asha Synthetic", date_of_birth: "2022-07-10" });
    expect(v.child_snapshot.age).toMatch(/^4 years/);
    expect(v.prescriber_snapshot).toMatchObject({ name: "Dr Synthetic pediatrician", council: "NMC", registration_number: "SYN-0039" });
    expect(v.allergies_snapshot).toMatchObject({
      status: "listed",
      allergies: [{ substance: "Synthetic-drug-X", severity: "severe" }],
      medications: [{ name: "Synthetic iron drops" }],
      health_profile_version: 1,
      matches: [],
      override_reason: null,
    });
    expect(v.content_md).toContain("4 ml, three times a day, for 3 days");
    expect(v.pdf_path).toBe(`${caseA}/${rx1}/v1.pdf`);
    const [p] = await sql`select status, prescriber_profile_id from prescriptions where id = ${rx1}`;
    expect(p.status).toBe("signed");
    const [pub] = await sql`select version, content_md, content_hash, visible_to_guardian, published_by from published_versions where entity_type = 'prescription' and entity_id = ${rx1}`;
    expect(pub).toMatchObject({ version: 1, content_md: v.content_md, content_hash: v.content_hash, visible_to_guardian: true, published_by: providerRx.id });
    const audits = await sql`select actor_user_id, details from audit_events where action = 'rx.signed' and entity_id = ${rx1}`;
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actor_user_id: providerRx.id, details: { version: 1, content_hash: v.content_hash, allergy_override: false } });

    // Signed is read-only and cannot be signed twice.
    expect(await sign(rx1)).toMatchObject({ status: 409 });
    expect(await patch(rx1, { items: items(), advice: null, follow_up: null, version: version + 2 })).toMatchObject({ status: 409, body: { error: "Signed prescriptions cannot be changed" } });

    // PDF for the prescriber, with the footer details.
    const res = await pdf(rx1);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const text = pdfText(new Uint8Array(await res.arrayBuffer()));
    expect(text).toContain("Dr Synthetic pediatrician - National Medical Commission (NMC) - Reg. No. SYN-0039");
    expect(text).toContain("Digitally generated on DoctorNearMe; signed by Dr Synthetic pediatrician on");
    expect(text).toContain(`Content hash (SHA-256): ${v.content_hash}`);
    expect(text).toContain("Allergies: ");
    expect(text).toContain("Synthetic-drug-X (severe, hives)");

    // Guardian: listed and downloadable.
    as(guardianA);
    const list = await familyList(childA);
    expect(list.status).toBe(200);
    expect(list.body.prescriptions).toEqual([expect.objectContaining({ id: rx1, status: "signed", pdf_url: `/api/family/prescriptions/${rx1}/pdf` })]);
    const gp = await familyPdf(rx1);
    expect(gp.status).toBe(200);
    expect(pdfText(new Uint8Array(await gp.arrayBuffer()))).toContain("Asha Synthetic, 4 years");

    // Notification: outbox event with ids only; in-app + email without drug names (032 content rule).
    const [event] = await sql<{ id: string; payload: Record<string, unknown> }[]>`
      select id, payload from outbox_events where topic = 'prescription.signed' and aggregate_id = ${rx1}`;
    expect(event.payload).toEqual({ prescription_id: rx1, child_id: childA, case_id: caseA });
    const emails: string[] = [];
    const { runOutbox } = await import("@/lib/notify/worker");
    await runOutbox({
      sql,
      eventIds: [String(event.id)],
      appUrl: "https://app.test",
      senders: {
        email: async ({ rendered }) => {
          emails.push(JSON.stringify(rendered.email));
          return { status: "sent", providerMessageId: "mock" };
        },
        whatsapp: async () => ({ status: "sent", providerMessageId: "mock" }),
      },
    });
    const notes = await sql<{ channel: string; recipient_user_id: string; title: string; body: string; link: string }[]>`
      select channel, recipient_user_id, title, body, link from notifications where event_id = ${event.id} order by channel`;
    expect(notes.map((n) => [n.channel, n.recipient_user_id])).toEqual([
      ["email", guardianA.id],
      ["in_app", guardianA.id],
    ]);
    expect(notes[1]).toMatchObject({ title: "New prescription", link: `/family/children/${childA}/prescriptions` });
    expect(emails).toHaveLength(1);
    for (const out of [...emails, ...notes.map((n) => `${n.title} ${n.body}`)]) {
      expect(out).not.toMatch(/Synthetic-paracetamol|paracetamol|4 ml|Asha/i);
    }
    expect(emails[0]).toContain(`https://app.test/family/children/${childA}/prescriptions`);
  });

  it("NFR-2: regenerating a signed version gives the same content_hash and the same PDF bytes as stored", async () => {
    const { documentOf, prescriptionPdfBytes, signedVersionOf } = await import("@/lib/rx");
    const found = await signedVersionOf(rx1);
    expect(found).not.toBeNull();
    const doc = documentOf(found!.version);
    expect(contentHash(prescriptionMarkdown(doc))).toBe(found!.version.content_hash);
    const { data } = await db.storage.from("prescriptions").download(found!.version.pdf_path!);
    const stored = Buffer.from(await data!.arrayBuffer());
    const regenerated = Buffer.from(await renderPrescriptionPdf(doc, found!.version.content_hash!));
    expect(Buffer.compare(stored, regenerated)).toBe(0);
    // A missing object is regenerated (and re-stored) from the snapshots.
    await db.storage.from("prescriptions").remove([found!.version.pdf_path!]);
    expect(Buffer.compare(Buffer.from(await prescriptionPdfBytes(found!.version)), stored)).toBe(0);
  });

  let rx2: string;

  it("E-2: a drug matching a recorded allergy -> 422 with matches; with an override reason -> signed and the reason stored", async () => {
    as(providerRx);
    const created = await create(caseA);
    expect(created.status).toBe(201);
    rx2 = created.body.prescription.id;
    expect(created.body.current.items).toEqual([]);
    expect(await sign(rx2)).toMatchObject({ status: 422, body: { error: "Add at least one medicine before signing" } });
    const incomplete = await patch(rx2, { items: [{ drug: "Synthetic-zinc", form: "tablet", duration_days: 5 }], advice: null, follow_up: null, version: created.body.prescription.version });
    expect(incomplete.status).toBe(200);
    expect(await sign(rx2)).toMatchObject({ status: 422, body: { details: { "items.0.dose": "Enter the dose" } } });
    const withAllergy = await patch(rx2, {
      items: items([{}, { drug: "Synthetic-drug-X", strength: "5 mg", form: "tablet", dose: "1 tablet", frequency: "once daily" }]),
      advice: null,
      follow_up: null,
      version: incomplete.body.prescription.version,
    });
    expect(withAllergy.status).toBe(200);
    const blocked = await sign(rx2);
    expect(blocked.status).toBe(422);
    expect(blocked.body.details.matches).toEqual([{ item_index: 1, drug: "Synthetic-drug-X", substance: "Synthetic-drug-X", severity: "severe" }]);
    expect((await signedVersion(rx2)).signed_at).toBeNull();

    const ok = await sign(rx2, { confirm: true, allergy_override_reason: "Tolerated under supervision (synthetic)" });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const v = await signedVersion(rx2);
    expect(v.allergies_snapshot).toMatchObject({ override_reason: "Tolerated under supervision (synthetic)", matches: [{ substance: "Synthetic-drug-X" }] });
    expect(v.content_md).toContain("**Allergy override:** Synthetic-drug-X - Tolerated under supervision (synthetic)");
    const [audit] = await sql`select details from audit_events where action = 'rx.signed' and entity_id = ${rx2}`;
    expect(audit.details).toMatchObject({ allergy_override: true });
    expect(JSON.stringify(audit.details)).not.toContain("supervision");
  });

  it("FR-1: signed versions are immutable in the database; prescriptions only move forward", async () => {
    const v = await signedVersion(rx2);
    await expect(sql`update prescription_versions set advice = 'changed' where id = ${v.id}`).rejects.toThrow(/immutable/);
    await expect(sql`update prescription_versions set items = '[]'::jsonb where id = ${v.id}`).rejects.toThrow(/immutable/);
    await expect(sql`delete from prescription_versions where id = ${v.id}`).rejects.toThrow(/immutable/);
    await expect(sql`update prescriptions set status = 'draft' where id = ${rx2}`).rejects.toThrow(/cannot change/);
    await expect(sql`delete from prescriptions where id = ${rx2}`).rejects.toThrow(/cannot be deleted/);
    await expect(sql`update prescriptions set status = 'void' where id = ${rx2}`).rejects.toThrow(/prescriptions_void_needs_reason/);
    await expect(sql`truncate prescription_versions cascade`).rejects.toThrow(/cannot be truncated/);
  });

  it("E-2: Void needs a reason, creates no new version; guardians see it cancelled and cannot download it", async () => {
    as(providerRx);
    expect((await voidRx(rx2, {})).status).toBe(400);
    expect((await voidRx(rx2, { reason: "  " })).status).toBe(400);
    const res = await voidRx(rx2, { reason: "Wrong dose (synthetic)" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.prescription).toMatchObject({ status: "void", void_reason: "Wrong dose (synthetic)", voided_by: providerRx.id });
    expect(await voidRx(rx2, { reason: "again" })).toMatchObject({ status: 409 });
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from prescription_versions where prescription_id = ${rx2}`;
    expect(n).toBe(1);
    const pubs = await sql`select version, content_md from published_versions where entity_type = 'prescription' and entity_id = ${rx2} order by version`;
    expect(pubs.map((p) => p.version)).toEqual([1, 2]);
    expect(pubs[1].content_md).toMatch(/^# Prescription cancelled/);
    expect(pubs[1].content_md).not.toContain("Wrong dose");
    expect((await sql`select 1 from audit_events where action = 'rx.voided' and entity_id = ${rx2}`).length).toBe(1);
    // The prescriber can still download the signed PDF; the guardian cannot.
    expect((await pdf(rx2)).status).toBe(200);

    as(guardianA);
    const list = await familyList(childA);
    expect(list.body.prescriptions.find((p: { id: string }) => p.id === rx2)).toMatchObject({ status: "void", pdf_url: null });
    expect((await familyPdf(rx2)).status).toBe(404);
    const [ev] = await sql`select payload from outbox_events where topic = 'prescription.voided' and aggregate_id = ${rx2}`;
    expect(ev.payload).toEqual({ prescription_id: rx2, child_id: childA, case_id: caseA });

    // A draft cannot be voided.
    as(providerRx);
    const draft = await create(caseA);
    expect(await voidRx(draft.body.prescription.id, { reason: "x" })).toMatchObject({ status: 409, body: { error: "Only a signed prescription can be cancelled" } });
  });

  it("E-3: SLP 403, other org 404, guardians 403 on provider APIs, guardian_b 404, anonymous 401", async () => {
    as(providerA);
    expect(await listRx(caseA)).toMatchObject({ status: 403, body: { error: "Only verified prescribers can write prescriptions" } });
    expect((await create(caseA, { from_report_id: rxDraftReport })).status).toBe(403);
    expect((await getRx(rx1)).status).toBe(403);
    expect((await patch(rx1, { items: items(), advice: null, follow_up: null, version: 1 })).status).toBe(403);
    expect((await sign(rx1)).status).toBe(403);
    expect((await pdf(rx1)).status).toBe(403);
    expect((await voidRx(rx1, { reason: "x" })).status).toBe(403);
    const { userCanPrescribe } = await import("@/lib/rx");
    expect(await userCanPrescribe(providerA.id)).toBe(false);
    expect(await userCanPrescribe(providerRx.id)).toBe(true);

    as(providerB); // a verified prescriber of another organisation
    expect((await listRx(caseA)).status).toBe(404);
    expect((await create(caseA)).status).toBe(404);
    expect((await getRx(rx1)).status).toBe(404);
    expect((await sign(rx1)).status).toBe(404);
    expect((await pdf(rx1)).status).toBe(404);
    expect((await getRx("not-a-uuid")).status).toBe(404);

    as(guardianA);
    expect((await listRx(caseA)).status).toBe(403);
    expect((await pdf(rx1)).status).toBe(403);

    as(guardianB);
    expect((await familyPdf(rx1)).status).toBe(404);
    expect((await familyList(childA)).status).toBe(404);

    as(providerRx);
    expect((await familyPdf(rx1)).status).toBe(403);

    as(null);
    expect((await listRx(caseA)).status).toBe(401);
    expect((await familyPdf(rx1)).status).toBe(401);
  });

  it("E-3: suspended between draft and sign -> 403 (route gate, signing transaction and database trigger)", async () => {
    as(providerRx);
    const created = await create(caseA);
    const id = created.body.prescription.id as string;
    expect((await patch(id, { items: items(), advice: null, follow_up: null, version: created.body.prescription.version })).status).toBe(200);
    await sql`update provider_profiles set verification_status = 'suspended', listed = false where user_id = ${providerRx.id}`;
    try {
      expect(await sign(id)).toMatchObject({ status: 403, body: { error: "Only verified prescribers can write prescriptions" } });
      // The signing transaction re-checks on its own (e.g. a suspension right after the route's gate).
      const { signPrescription } = await import("@/lib/rx");
      expect(await signPrescription({ prescriptionId: id, actorUserId: providerRx.id, allergyOverrideReason: null })).toMatchObject({ ok: false, status: 403 });
      // And the database refuses a signature by a non-prescriber whatever the caller.
      await expect(sql`
        update prescription_versions set signed_by = ${providerRx.id}, signed_at = now(), content_md = 'x',
          content_hash = ${"0".repeat(64)}, pdf_path = 'x', allergies_snapshot = '{}', child_snapshot = '{}', prescriber_snapshot = '{}'
        where prescription_id = ${id}`).rejects.toThrow(/only verified prescribers/);
      const [p] = await sql`select status from prescriptions where id = ${id}`;
      expect(p.status).toBe("draft");
    } finally {
      await sql`update provider_profiles set verification_status = 'verified' where user_id = ${providerRx.id}`;
    }
  });

  it("041: strict audit failure -> 503, nothing signed, published, stored or enqueued", async () => {
    as(providerRx);
    const created = await create(caseA);
    const id = created.body.prescription.id as string;
    await patch(id, { items: items(), advice: null, follow_up: null, version: created.body.prescription.version });
    process.env.AUDIT_FAIL_ACTIONS = "rx.signed";
    try {
      expect(await sign(id)).toMatchObject({ status: 503, body: { error: "Could not save. Please try again." } });
    } finally {
      delete process.env.AUDIT_FAIL_ACTIONS;
    }
    const v = await signedVersion(id);
    expect([v.signed_at, v.content_md, v.pdf_path]).toEqual([null, null, null]);
    expect((await sql`select status from prescriptions where id = ${id}`)[0].status).toBe("draft");
    expect(await sql`select 1 from published_versions where entity_type = 'prescription' and entity_id = ${id}`).toHaveLength(0);
    expect(await sql`select 1 from outbox_events where aggregate_type = 'prescription' and aggregate_id = ${id}`).toHaveLength(0);
    const { data } = await db.storage.from("prescriptions").list(`${caseA}/${id}`);
    expect(data ?? []).toHaveLength(0);
    // The same draft signs once the audit log works again.
    expect((await sign(id)).status).toBe(200);
  });

  it("041 export: the guardian's copy has the signed prescriptions (PDF only while not cancelled), never drafts", async () => {
    const entry = REGISTRY.find((c) => c.key === "prescriptions")!;
    const section = await entry.export!({ sql, childId: childA, guardianUserId: guardianA.id });
    const data = section!.data as { id: string; status: string; file: string | null }[];
    expect(data.map((d) => d.id)).toContain(rx1);
    expect(data.find((d) => d.id === rx2)).toMatchObject({ status: "cancelled", file: null });
    const [draft] = await sql<{ id: string }[]>`select id from prescriptions where case_id = ${caseA} and status = 'draft' limit 1`;
    expect(data.map((d) => d.id)).not.toContain(draft.id);
    expect(section!.files?.map((f) => f.objectPath)).toContain(`${caseA}/${rx1}/v1.pdf`);
    const objects = await entry.erase!.objects!(sql, { childId: childA, requestId: "x", scope: "everything", requestedBy: guardianA.id, caseIds: [caseA] });
    expect(objects).toContainEqual({ bucket: "prescriptions", path: `${caseA}/${rx1}/v1.pdf` });
  });
});
