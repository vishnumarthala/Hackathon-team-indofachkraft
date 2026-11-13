// Ticket 040 FR-1 / NFR-1 (design rule 9): the ONLY data the follow-up agent may answer from. Authorisation first:
// nothing is read unless the guardian's link to the child is active. Then exactly the guardian-authorised published
// versions, through the owning tickets' readers:
//   - IEP plans:        025 getGuardianPlans        (latest published plan per organisation)
//   - home programs:    026 getGuardianHomePrograms (current published program per case; this week's adherence)
//   - session notes:    038 listGuardianSessionNotes (finalized notes the clinician shared)
//   - other reports:    024 listGuardianVisible("report") for final, guardian-facing kinds (e.g. parent summaries)
//   - questionnaires:   024 listGuardianVisible("assessment") (summaries the care team shared)
//   - prescriptions:    039 listGuardianPrescriptions, signed only (a voided one's current version is the
//                       "Prescription cancelled" notice and is never presented as a current prescription)
// Never drafts, transcripts, facts, messages, guardian notes or other children's data.
import { listGuardianVisible, type PublishedVersion } from "@/lib/clinical/publish";
import { MAX_CONTEXT_CHARS } from "@/lib/ask/context";
import { getActiveGuardianLink } from "@/lib/children";
import { getGuardianHomePrograms } from "@/lib/home-program";
import { getGuardianPlans } from "@/lib/iep";
import { pg } from "@/lib/pg";
import { listGuardianPrescriptions } from "@/lib/rx";
import { listGuardianSessionNotes } from "@/lib/scribe/queries";
import { formatDate } from "@/lib/i18n/format";
import type { CitedEntityType, FollowupCitation } from "./constants";

export { MAX_CONTEXT_CHARS };

/** Prefix of the bracketed id a document gets in the prompt (`[HOME1]`), per kind of document. */
export type DocKind = "plan" | "home" | "note" | "report" | "questionnaire" | "rx";

const REF_PREFIX: Record<DocKind, string> = {
  plan: "PLAN",
  home: "HOME",
  note: "NOTE",
  report: "REPORT",
  questionnaire: "QUESTIONNAIRE",
  rx: "RX",
};

export type ContextDoc = {
  kind: DocKind;
  entity_type: CitedEntityType;
  entity_id: string;
  version: number;
  /** Short English name shown on the citation chip, e.g. `Home program: Term 1 practice (v2)`. */
  label: string;
  org_name: string;
  published_at: string;
  /** The published text (content_md), plus derived lines (home practice this week) for home programs. */
  content: string;
};

export type CitableDoc = ContextDoc & { ref: string };

export type FollowupContext = {
  /** Exactly the text sent to the model. */
  text: string;
  /** Only documents that survived truncation, by ref (`HOME1`); citations are validated against these. */
  citable: Map<string, CitableDoc>;
};

export type GuardianContext = FollowupContext & { docs: ContextDoc[] };

const TZ = "Asia/Kolkata";
const day = (iso: string) => formatDate(iso, "en", "long", TZ);
const TRUNCATED = "\n[... older part of this document left out]";
const MIN_PARTIAL = 400;

function header(doc: CitableDoc): string {
  return `[${doc.ref}] ${doc.label} - from ${doc.org_name}, version ${doc.version}, shared ${day(doc.published_at)}`;
}

/**
 * Pure. Newest first; every document gets a bracketed ref. Documents are added whole while they fit; the first one
 * that does not fit is cut (when enough room is left) and older ones are left out, so the text never exceeds
 * `maxChars` (013's 60,000).
 */
export function buildFollowupContext(docs: ContextDoc[], maxChars = MAX_CONTEXT_CHARS): FollowupContext {
  const sorted = [...docs].sort((a, b) => b.published_at.localeCompare(a.published_at));
  const counters = new Map<DocKind, number>();
  const blocks: string[] = [];
  const citable = new Map<string, CitableDoc>();
  let total = 0;
  for (const doc of sorted) {
    const n = (counters.get(doc.kind) ?? 0) + 1;
    counters.set(doc.kind, n);
    const withRef: CitableDoc = { ...doc, ref: `${REF_PREFIX[doc.kind]}${n}` };
    const head = header(withRef);
    const sep = blocks.length ? 2 : 0;
    const full = `${head}\n${doc.content.trim()}`;
    if (total + sep + full.length <= maxChars) {
      blocks.push(full);
      citable.set(withRef.ref, withRef);
      total += sep + full.length;
      continue;
    }
    const room = maxChars - total - sep - head.length - 1 - TRUNCATED.length;
    if (room >= MIN_PARTIAL) {
      const partial = `${head}\n${doc.content.trim().slice(0, room)}${TRUNCATED}`;
      blocks.push(partial);
      citable.set(withRef.ref, { ...withRef, content: doc.content.trim().slice(0, room) });
      total += sep + partial.length;
    }
    break;
  }
  return { text: blocks.join("\n\n"), citable };
}

function plain(markdown: string): string {
  return markdown
    .replace(/\\([\\`*_[\]<>#|~])/g, "$1")
    .replace(/[*_`#>|~]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** First line of real text of a document (no headings), for a chip whose quote could not be verified. */
export function leadExcerpt(content: string, max = 160): string {
  const line =
    content
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l !== "" && !l.startsWith("#") && !/^[-|:\s]+$/.test(l)) ?? "";
  const text = line.replace(/^[-*]\s+/, "").replace(/\\([\\`*_[\]<>#|~])/g, "$1").replace(/[*_`]/g, "");
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** A model quote is used as the chip excerpt only if it really is in the cited document; else the lead line. */
export function citationExcerpt(doc: Pick<ContextDoc, "content">, quote: string | undefined, max = 200): string {
  const q = (quote ?? "").trim().replace(/^["'“]+|["'”]+$/g, "");
  if (q.length >= 3 && plain(doc.content).includes(plain(q))) {
    return q.length > max ? `${q.slice(0, max - 1).trimEnd()}…` : q;
  }
  return leadExcerpt(doc.content);
}

export function toCitation(doc: CitableDoc, quote?: string): FollowupCitation {
  return {
    entity_type: doc.entity_type,
    entity_id: doc.entity_id,
    version: doc.version,
    label: doc.label,
    excerpt: citationExcerpt(doc, quote),
  };
}

const REPORT_LABELS: Record<string, string> = {
  parent_summary: "Parent summary",
  assessment: "Assessment report",
};
// Report kinds never shown to guardians through this agent, even if a version were visible.
const EXCLUDED_REPORT_KINDS = ["session_note", "rx_draft", "pre_session_brief", "generic_intake_brief"];

function adherenceLines(program: Awaited<ReturnType<typeof getGuardianHomePrograms>>[number]): string {
  if (program.activities.length === 0) return "";
  const lines = program.activities.map(
    (a) => `- ${a.title}: done ${a.this_week.done} of ${a.this_week.expected} times this week`,
  );
  return `\n\nPractice your family logged this week (${day(`${program.week_start}T12:00:00+05:30`)} to ${day(
    `${program.week_end}T12:00:00+05:30`,
  )}):\n${lines.join("\n")}`;
}

/**
 * FR-1: every document the guardian may see for this child, newest first (not yet truncated). Null when the
 * guardian has no active link to the child (revoked, left, other guardian's child, unknown id).
 */
export async function loadGuardianDocs(guardianUserId: string, childId: string, opts: { timeZone?: string; now?: Date } = {}): Promise<ContextDoc[] | null> {
  const access = await getActiveGuardianLink(childId, guardianUserId);
  if (!access) return null;
  const sql = await pg();
  const [plans, programs, notes, prescriptions, reportVersions, questionnaires] = await Promise.all([
    getGuardianPlans(childId),
    getGuardianHomePrograms(childId, opts),
    listGuardianSessionNotes(childId),
    listGuardianPrescriptions(childId),
    listGuardianVisible(sql, childId, "report"),
    listGuardianVisible(sql, childId, "assessment"),
  ]);

  const docs: ContextDoc[] = [];
  for (const p of plans) {
    docs.push({
      kind: "plan",
      entity_type: "iep_plan",
      entity_id: p.plan_id,
      version: p.version,
      label: `IEP plan: ${p.title} (v${p.version})`,
      org_name: p.org_name,
      published_at: p.published_at,
      content: p.content_md,
    });
  }
  for (const p of programs) {
    docs.push({
      kind: "home",
      entity_type: "home_program",
      entity_id: p.program_id,
      version: p.version,
      label: `Home program: ${p.title} (v${p.version})`,
      org_name: p.org_name,
      published_at: p.published_at,
      content: `${p.content_md}${adherenceLines(p)}`,
    });
  }
  for (const n of notes) {
    docs.push({
      kind: "note",
      entity_type: "report",
      entity_id: n.report_id,
      version: n.version,
      label: `Session note, ${day(n.published_at)} (v${n.version})`,
      org_name: n.org_name,
      published_at: n.published_at,
      content: n.content_md,
    });
  }
  for (const rx of prescriptions) {
    if (rx.status !== "signed" || rx.voided_at) continue;
    docs.push({
      kind: "rx",
      entity_type: "prescription",
      entity_id: rx.id,
      version: rx.version,
      label: `Prescription by ${rx.prescriber_name}, ${day(rx.signed_at)} (v${rx.version})`,
      org_name: rx.org_name,
      published_at: rx.published_at,
      content: rx.content_md,
    });
  }

  const others: PublishedVersion[] = [...reportVersions, ...questionnaires];
  if (others.length > 0) {
    const reportIds = reportVersions.map((v) => v.entity_id);
    const [kinds, orgs] = await Promise.all([
      reportIds.length
        ? sql<{ id: string; kind: string; status: string }[]>`select id, kind, status from reports where id = any(${reportIds}::uuid[])`
        : Promise.resolve([] as { id: string; kind: string; status: string }[]),
      sql<{ id: string; name: string }[]>`
        select id, coalesce(public_name, name) as name from organizations where id = any(${[...new Set(others.map((v) => v.org_id))]}::uuid[])`,
    ]);
    const kindOf = new Map(kinds.map((k) => [k.id, k]));
    const orgName = new Map(orgs.map((o) => [o.id, o.name]));
    for (const v of reportVersions) {
      const report = kindOf.get(v.entity_id);
      if (!report || report.status !== "final" || EXCLUDED_REPORT_KINDS.includes(report.kind)) continue;
      docs.push({
        kind: "report",
        entity_type: "report",
        entity_id: v.entity_id,
        version: v.version,
        label: `${REPORT_LABELS[report.kind] ?? "Report"}, ${day(v.published_at)} (v${v.version})`,
        org_name: orgName.get(v.org_id) ?? "your child's care team",
        published_at: v.published_at,
        content: v.content_md,
      });
    }
    for (const v of questionnaires) {
      docs.push({
        kind: "questionnaire",
        entity_type: "assessment",
        entity_id: v.entity_id,
        version: v.version,
        label: `Questionnaire summary, ${day(v.published_at)} (v${v.version})`,
        org_name: orgName.get(v.org_id) ?? "your child's care team",
        published_at: v.published_at,
        content: v.content_md,
      });
    }
  }
  return docs.sort((a, b) => b.published_at.localeCompare(a.published_at));
}

/** FR-1 `loadGuardianContext(guardianUserId, childId)`: the authorised documents and the prompt text built from them. */
export async function loadGuardianContext(
  guardianUserId: string,
  childId: string,
  opts: { timeZone?: string; now?: Date; maxChars?: number } = {},
): Promise<GuardianContext | null> {
  const docs = await loadGuardianDocs(guardianUserId, childId, opts);
  if (!docs) return null;
  return { ...buildFollowupContext(docs, opts.maxChars), docs };
}
