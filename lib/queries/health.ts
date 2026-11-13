// Ticket 021: health profile reads and the versioned save. Server only. Callers MUST gate access first:
// guardians with requireChildGuardian(), providers with requireCaseAccess() for a case of the child (rule 2).
// No caching: every call reads the database (NFR-1).
import { isUuid } from "@/lib/cases/validation";
import { supabaseAdmin } from "@/lib/db";
import {
  emptyHealthProfile,
  hasNoKnownAllergies,
  listedAllergies,
  type Allergy,
  type HealthProfile,
  type HealthProfileFields,
  type Medication,
} from "@/lib/health/schema";

if (typeof window !== "undefined") {
  throw new Error("lib/queries/health is server-only");
}

const COLUMNS =
  "child_id, blood_group, allergies, medications, conditions, birth_history, developmental_history, emergency_contact_name, emergency_contact_phone, version, updated_by, updated_at";

type ProfileRow = Omit<HealthProfile, "allergies" | "medications" | "conditions"> & {
  allergies: unknown;
  medications: unknown;
  conditions: unknown;
};

const list = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);

function toProfile(row: ProfileRow): HealthProfile {
  return {
    child_id: row.child_id,
    blood_group: row.blood_group ?? null,
    allergies: list(row.allergies),
    medications: list(row.medications),
    conditions: list(row.conditions),
    birth_history: row.birth_history ?? null,
    developmental_history: row.developmental_history ?? null,
    emergency_contact_name: row.emergency_contact_name ?? null,
    emergency_contact_phone: row.emergency_contact_phone ?? null,
    version: row.version,
    updated_by: row.updated_by ?? null,
    updated_at: row.updated_at ?? null,
  };
}

/** The child's saved profile, or null if the guardian has not saved one. */
export async function getHealthProfile(childId: string): Promise<HealthProfile | null> {
  if (!isUuid(childId)) return null;
  const { data, error } = await supabaseAdmin().from("child_health_profiles").select(COLUMNS).eq("child_id", childId).maybeSingle();
  if (error) throw new Error(`Could not load health profile: ${error.message}`);
  return data ? toProfile(data as ProfileRow) : null;
}

/** FR-3: the saved profile or the empty one (`version: 0`). */
export async function getHealthProfileOrEmpty(childId: string): Promise<HealthProfile> {
  return (await getHealthProfile(childId)) ?? emptyHealthProfile(childId);
}

/** FR-5: the profile of the case's child (null = no profile or no such case). Gate with requireCaseAccess first. */
export async function getHealthProfileForCase(caseId: string): Promise<HealthProfile | null> {
  if (!isUuid(caseId)) return null;
  const { data, error } = await supabaseAdmin().from("cases").select("child_id").eq("id", caseId).maybeSingle();
  if (error) throw new Error(`Could not load case: ${error.message}`);
  const childId = (data as { child_id: string | null } | null)?.child_id;
  return childId ? getHealthProfile(childId) : null;
}

export type PrescribingHealthFacts = {
  /** False when the guardian has not saved a profile: allergies are then UNKNOWN, not "none". */
  recorded: boolean;
  noKnownAllergies: boolean;
  allergies: Allergy[];
  medications: Medication[];
  version: number;
  updatedAt: string | null;
};

/**
 * Typed read for the e-prescription allergy/current-medicine check (039) and pre-consult briefs (035).
 * Gate access first (requireCaseAccess for the case of this child).
 */
export async function getPrescribingHealthFacts(childId: string): Promise<PrescribingHealthFacts> {
  const profile = await getHealthProfile(childId);
  if (!profile) {
    return { recorded: false, noKnownAllergies: false, allergies: [], medications: [], version: 0, updatedAt: null };
  }
  return {
    recorded: true,
    noKnownAllergies: hasNoKnownAllergies(profile),
    allergies: listedAllergies(profile),
    medications: profile.medications,
    version: profile.version,
    updatedAt: profile.updated_at,
  };
}

export type SaveHealthResult =
  | { result: "saved"; profile: HealthProfile; fields: string[] }
  | { result: "conflict" }
  | { result: "not_found" };

/**
 * FR-3: optimistic save through `save_child_health_profile` (one transaction: row + history trigger + audit
 * `health_profile.updated` with field names only). `expectedVersion` 0 = create.
 */
export async function saveHealthProfile(
  childId: string,
  userId: string,
  fields: HealthProfileFields,
  expectedVersion: number,
): Promise<SaveHealthResult> {
  const { data, error } = await supabaseAdmin().rpc("save_child_health_profile", {
    p_child: childId,
    p_user: userId,
    p_expected_version: expectedVersion,
    p_profile: fields,
  });
  if (error || !data) throw new Error(`Could not save the health profile: ${error?.message ?? "no result"}`);
  const out = data as { result: string; profile?: ProfileRow; fields?: string[] };
  if (out.result === "saved" && out.profile) return { result: "saved", profile: toProfile(out.profile), fields: out.fields ?? [] };
  if (out.result === "not_found") return { result: "not_found" };
  return { result: "conflict" };
}

export type HealthHistoryEntry = {
  version: number;
  changed_fields: string[];
  changed_by: string | null;
  changed_by_name: string | null;
  changed_at: string;
};

/** Display names for "Last updated ... by <name>" (null when unknown or no name set). */
export async function displayNames(userIds: (string | null)[]): Promise<Map<string, string>> {
  const ids = [...new Set(userIds.filter((id): id is string => Boolean(id)))];
  if (ids.length === 0) return new Map();
  const { data, error } = await supabaseAdmin().from("user_profiles").select("id, display_name").in("id", ids);
  if (error) throw new Error(`Could not load names: ${error.message}`);
  return new Map(
    ((data ?? []) as { id: string; display_name: string | null }[])
      .filter((r) => r.display_name)
      .map((r) => [r.id, r.display_name as string]),
  );
}

/** FR-6: versions, newest first. Guardians only (gate with requireChildGuardianPage). */
export async function listHealthHistory(childId: string): Promise<HealthHistoryEntry[]> {
  if (!isUuid(childId)) return [];
  const { data, error } = await supabaseAdmin()
    .from("child_health_profile_history")
    .select("version, changed_fields, changed_by, changed_at")
    .eq("child_id", childId)
    .order("version", { ascending: false });
  if (error) throw new Error(`Could not load health profile history: ${error.message}`);
  const rows = (data ?? []) as Omit<HealthHistoryEntry, "changed_by_name">[];
  const names = await displayNames(rows.map((r) => r.changed_by));
  return rows.map((r) => ({ ...r, changed_by_name: r.changed_by ? (names.get(r.changed_by) ?? null) : null }));
}

/** FR-6: one past version as a read-only profile, or null. */
export async function getHealthHistoryVersion(
  childId: string,
  version: number,
): Promise<{ profile: HealthProfile; entry: HealthHistoryEntry } | null> {
  if (!isUuid(childId) || !Number.isInteger(version) || version < 1) return null;
  const { data, error } = await supabaseAdmin()
    .from("child_health_profile_history")
    .select("version, snapshot, changed_fields, changed_by, changed_at")
    .eq("child_id", childId)
    .eq("version", version)
    .maybeSingle();
  if (error) throw new Error(`Could not load health profile version: ${error.message}`);
  if (!data) return null;
  const row = data as Omit<HealthHistoryEntry, "changed_by_name"> & { snapshot: Omit<ProfileRow, "child_id"> };
  const names = await displayNames([row.changed_by]);
  return {
    profile: toProfile({ ...row.snapshot, child_id: childId }),
    entry: {
      version: row.version,
      changed_fields: row.changed_fields,
      changed_by: row.changed_by,
      changed_by_name: row.changed_by ? (names.get(row.changed_by) ?? null) : null,
      changed_at: row.changed_at,
    },
  };
}
