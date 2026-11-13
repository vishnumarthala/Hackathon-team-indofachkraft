// Lazy env getters: nothing is read at import time, so `npm run build` works without .env.local.
// Next.js and the scripts load .env.local; this module never does.

function read(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value === "" ? undefined : value;
}

function required(name: string, ...aliases: string[]): string {
  const value = [name, ...aliases].map(read).find((v) => v !== undefined);
  if (value === undefined) throw new Error(`Missing env var: ${name}`);
  return value;
}

export const DEFAULT_GEMINI_MODEL = "gemini-3.8-flash";
export const DEFAULT_EMAIL_FROM = "DoctorNearMe <onboarding@resend.dev>";
export const DEFAULT_FIXTURES_DIR = "demo/fixtures";
export const DEFAULT_WHATSAPP_API_VERSION = "v21.0";

export const env = {
  get NEXT_PUBLIC_APP_URL() {
    return required("NEXT_PUBLIC_APP_URL");
  },
  get NEXT_PUBLIC_SUPABASE_URL() {
    return required("NEXT_PUBLIC_SUPABASE_URL");
  },
  get NEXT_PUBLIC_SUPABASE_ANON_KEY() {
    // Newer Supabase projects call the anon key the publishable key.
    return required("NEXT_PUBLIC_SUPABASE_ANON_KEY", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY");
  },
  get SUPABASE_SERVICE_ROLE_KEY() {
    // Newer Supabase projects call the service role key the secret key.
    return required("SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SECRET_KEY");
  },
  get DATABASE_URL() {
    return required("DATABASE_URL");
  },
  get ELEVENLABS_API_KEY() {
    return required("ELEVENLABS_API_KEY");
  },
  get ELEVENLABS_AGENT_ID() {
    return required("ELEVENLABS_AGENT_ID");
  },
  get ELEVENLABS_WEBHOOK_SECRET() {
    return required("ELEVENLABS_WEBHOOK_SECRET");
  },
  get GEMINI_API_KEY() {
    return required("GEMINI_API_KEY");
  },
  get RESEND_API_KEY() {
    return required("RESEND_API_KEY");
  },
  get GEMINI_MODEL() {
    return read("GEMINI_MODEL") ?? DEFAULT_GEMINI_MODEL;
  },
  get EMAIL_FROM() {
    return read("EMAIL_FROM") ?? DEFAULT_EMAIL_FROM;
  },
  get DEMO_MODE() {
    return process.env.DEMO_MODE === "true";
  },
  get DEMO_EMAIL_TO() {
    return read("DEMO_EMAIL_TO");
  },
  // 028 NFR-1: demo (is_synthetic) provider profiles stay visible with a badge unless this is "false".
  get SHOW_SYNTHETIC_LISTINGS() {
    return process.env.SHOW_SYNTHETIC_LISTINGS !== "false";
  },
  // 029: Google Maps. Server key (Geocoding API) is server-only; the browser key (Maps JavaScript, Places,
  // Static Maps) is HTTP-referrer restricted and passed to client components as a prop. Both optional:
  // without them geocoding uses the bundled Hyderabad table and /find shows the list without a map.
  get GOOGLE_MAPS_SERVER_KEY() {
    return read("GOOGLE_MAPS_SERVER_KEY");
  },
  get NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY() {
    return read("NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY");
  },
  get NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID() {
    return read("NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID");
  },
  get ELEVENLABS_VOICE_ID_EN() {
    return read("ELEVENLABS_VOICE_ID_EN");
  },
  get ELEVENLABS_VOICE_ID_HI() {
    return read("ELEVENLABS_VOICE_ID_HI");
  },
  get ELEVENLABS_VOICE_ID_TE() {
    return read("ELEVENLABS_VOICE_ID_TE");
  },
  get DEMO_FIXTURES_DIR() {
    return read("DEMO_FIXTURES_DIR") ?? DEFAULT_FIXTURES_DIR;
  },
  // 020: salt for the hashed IP stored with each consent record (falls back to the service role key).
  get CONSENT_IP_SALT() {
    return read("CONSENT_IP_SALT");
  },
  // 032: shared secret for the cron routes (`Authorization: Bearer <CRON_SECRET>`; Vercel cron sends it).
  // Unset = every cron request is refused.
  get CRON_SECRET() {
    return read("CRON_SECRET");
  },
  // 032: Meta WhatsApp Cloud API. Optional: without both values (or in DEMO_MODE) WhatsApp deliveries are
  // `skipped` with `whatsapp_not_configured` and never fail the domain action.
  get WHATSAPP_TOKEN() {
    return read("WHATSAPP_TOKEN");
  },
  get WHATSAPP_PHONE_NUMBER_ID() {
    return read("WHATSAPP_PHONE_NUMBER_ID");
  },
  get WHATSAPP_API_VERSION() {
    return read("WHATSAPP_API_VERSION") ?? DEFAULT_WHATSAPP_API_VERSION;
  },
  // 041: privacy notice (FR-10) and retention (FR-6). All optional; see .env.example.
  get GRIEVANCE_OFFICER_EMAIL() {
    return read("GRIEVANCE_OFFICER_EMAIL");
  },
  /** Only a human sets this, after legal review; until then /privacy shows the draft badge. */
  get PRIVACY_NOTICE_REVIEWED() {
    return process.env.PRIVACY_NOTICE_REVIEWED === "true";
  },
  get SUPABASE_REGION_LABEL() {
    return read("SUPABASE_REGION_LABEL");
  },
  get RETENTION_AUDIO_DAYS() {
    return read("RETENTION_AUDIO_DAYS");
  },
  /** Dev/test hook (lib/audit.ts `auditWouldFail`); ignored in production builds. */
  get AUDIT_FAIL_ACTIONS() {
    return read("AUDIT_FAIL_ACTIONS");
  },
};
