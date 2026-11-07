import { supabaseAdmin } from "@/lib/db";
import { env } from "@/lib/env";
import { isUuid } from "@/lib/cases/validation";
import { getCase } from "@/lib/queries/cases";
import { parsePacket, pickReferralSession, type IntakeFlags, type PacketFact, type ReferralPacket } from "@/lib/referral/packet";
import { BriefSchema, type Brief, type CaseRow, type FactRow, type RecordingRow, type ReferralRow } from "@/lib/types";

const BUCKET = "recordings";
const SIGNED_URL_SECONDS = 60 * 60;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{20,128}$/;

export type ReferralSession = Pick<RecordingRow, "id" | "session_number" | "status" | "kind" | "created_at">;

export type ReferralContext = {
  caseRow: CaseRow;
  session: ReferralSession | null;
  isaaFacts: PacketFact[];
  brief: Brief | null;
  intakeFlags: IntakeFlags;
};

export type ReferralListItem = Pick<
  ReferralRow,
  "id" | "specialist_name" | "specialist_email" | "status" | "created_at" | "share_token"
>;

export function specialistUrl(token: string): string {
  let base = "";
  try {
    base = env.NEXT_PUBLIC_APP_URL.replace(/\/+$/, "");
  } catch {
    base = "";
  }
  return `${base}/specialist/${token}`;
}

async function latestBrief(caseId: string): Promise<Brief | null> {
  const { data, error } = await supabaseAdmin()
    .from("reports")
    .select("content")
    .eq("case_id", caseId)
    .eq("kind", "pre_session_brief")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`Could not load brief: ${error.message}`);
  const parsed = BriefSchema.safeParse(data?.content);
  return parsed.success ? parsed.data : null;
}

async function intakeFlags(caseId: string): Promise<IntakeFlags> {
  const { data, error } = await supabaseAdmin()
    .from("facts")
    .select("item_id, value, created_at")
    .eq("case_id", caseId)
    .eq("instrument", "CASE_SHEET")
    .in("item_id", ["lost_speech", "self_injury"])
    .order("created_at", { ascending: false });
  if (error) throw new Error(`Could not load intake answers: ${error.message}`);
  const flags: IntakeFlags = {};
  for (const row of (data ?? []) as Pick<FactRow, "item_id" | "value">[]) {
    const key = row.item_id as keyof IntakeFlags;
    if (flags[key] === undefined) flags[key] = row.value === true;
  }
  return flags;
}

/** Everything the Referral tab and the refer route need, for the same (latest extracted) session. */
export async function getReferralContext(caseId: string): Promise<ReferralContext | null> {
  const caseRow = await getCase(caseId);
  if (!caseRow) return null;
  const db = supabaseAdmin();

  const { data: recordings, error } = await db
    .from("recordings")
    .select("id, session_number, status, kind, created_at")
    .eq("case_id", caseId)
    .eq("kind", "session");
  if (error) throw new Error(`Could not load sessions: ${error.message}`);
  const session = pickReferralSession((recordings ?? []) as ReferralSession[]);

  let isaaFacts: PacketFact[] = [];
  if (session) {
    const { data, error: factsError } = await db
      .from("facts")
      .select("id, item_id, value, status, evidence, confirmed_at")
      .eq("recording_id", session.id)
      .eq("instrument", "ISAA");
    if (factsError) throw new Error(`Could not load facts: ${factsError.message}`);
    isaaFacts = (data ?? []) as PacketFact[];
  }

  const [brief, flags] = await Promise.all([latestBrief(caseId), intakeFlags(caseId)]);
  return { caseRow, session, isaaFacts, brief, intakeFlags: flags };
}

export async function listReferrals(caseId: string): Promise<ReferralListItem[]> {
  if (!isUuid(caseId)) return [];
  const { data, error } = await supabaseAdmin()
    .from("referrals")
    .select("id, specialist_name, specialist_email, status, created_at, share_token")
    .eq("case_id", caseId)
    .order("created_at", { ascending: false });
  if (error) throw new Error(`Could not load referrals: ${error.message}`);
  return (data ?? []) as ReferralListItem[];
}

export type SharedReferral = { referral: Omit<ReferralRow, "packet">; packet: ReferralPacket };

/** Share-token lookup: null for unknown, malformed or revoked tokens (and unreadable packets). */
export async function getReferralByToken(token: string): Promise<SharedReferral | null> {
  if (!TOKEN_PATTERN.test(token)) return null;
  const { data, error } = await supabaseAdmin().from("referrals").select("*").eq("share_token", token).maybeSingle();
  if (error) throw new Error(`Could not load referral: ${error.message}`);
  const row = data as ReferralRow | null;
  if (!row || row.status === "revoked") return null;
  const { packet: rawPacket, ...referral } = row;
  const packet = parsePacket(rawPacket);
  return packet ? { referral, packet } : null;
}

/** First view only: sent -> viewed. Returns true when this call made the change. */
export async function markReferralViewed(referralId: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin()
    .from("referrals")
    .update({ status: "viewed", viewed_at: new Date().toISOString() })
    .eq("id", referralId)
    .eq("status", "sent")
    .select("id");
  if (error) throw new Error(`Could not update referral: ${error.message}`);
  return (data ?? []).length > 0;
}

/**
 * Signed playback URLs (valid 1 hour) for every recording of the case, keyed by recording id.
 * Recordings without audio (or whose object cannot be signed) map to null.
 */
export async function getAudioUrls(caseId: string): Promise<Record<string, string | null>> {
  const db = supabaseAdmin();
  const { data, error } = await db.from("recordings").select("id, storage_path").eq("case_id", caseId);
  if (error) throw new Error(`Could not load recordings: ${error.message}`);
  const rows = (data ?? []) as Pick<RecordingRow, "id" | "storage_path">[];
  const entries = await Promise.all(
    rows.map(async (row): Promise<[string, string | null]> => {
      if (!row.storage_path) return [row.id, null];
      const { data: signed, error: signError } = await db.storage
        .from(BUCKET)
        .createSignedUrl(row.storage_path, SIGNED_URL_SECONDS);
      return [row.id, signError || !signed?.signedUrl ? null : signed.signedUrl];
    }),
  );
  return Object.fromEntries(entries);
}
