import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { env } from "@/lib/env";

if (typeof window !== "undefined") {
  throw new Error("lib/db.ts is server-only");
}

let client: SupabaseClient | null = null;

export function supabaseAdmin(): SupabaseClient {
  if (typeof window !== "undefined") throw new Error("lib/db.ts is server-only");
  client ??= createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
  return client;
}
