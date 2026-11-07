// Browser Supabase client (anon/publishable key only); session cookies are managed by @supabase/ssr.
// Never import server env or the service role key here (NFR-2).
import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";

let client: SupabaseClient | null = null;

export function supabaseBrowser(): SupabaseClient {
  // Literal `process.env.NEXT_PUBLIC_*` reads are what Next.js inlines into the browser bundle.
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  // Newer Supabase projects call the anon key the publishable key; both names work.
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !anonKey) throw new Error("Upload is not configured");
  client ??= createBrowserClient(url, anonKey);
  return client;
}
