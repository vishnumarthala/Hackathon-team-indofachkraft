import { supabaseAdmin } from "@/lib/db";
import type { PilotRole } from "@/lib/pilots";

export type PilotSignupRow = {
  id: string;
  name: string;
  email: string;
  role: PilotRole;
  country: string;
  centre: string | null;
  clinicians: number | null;
  note: string | null;
  created_at: string;
};

/** All pilot sign-ups, newest first. */
export async function listPilotSignups(): Promise<PilotSignupRow[]> {
  const { data, error } = await supabaseAdmin()
    .from("pilot_signups")
    .select("id, name, email, role, country, centre, clinicians, note, created_at")
    .order("created_at", { ascending: false });
  if (error) throw new Error(`Could not load pilot sign-ups: ${error.message}`);
  return (data ?? []) as PilotSignupRow[];
}
