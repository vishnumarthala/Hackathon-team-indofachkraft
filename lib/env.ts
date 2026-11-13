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
  // 033: the English-only public developmental check-in agent (docs/elevenlabs-screen-agent.md). Optional: without
  // it (and outside DEMO_MODE) `/screen` offers only the tap-through form.
  get ELEVENLABS_SCREEN_AGENT_ID() {
    return read("ELEVENLABS_SCREEN_AGENT_ID");
  },
  // 034: the English-only voice booking agent on /find (docs/elevenlabs-booking-agent.md) and the shared secret its
  // server tools send as `X-Agent-Secret`. Optional: without both (and outside DEMO_MODE) /find has no voice widget;
  // without the secret every tool call is refused.
  get ELEVENLABS_BOOKING_AGENT_ID() {
    return read("ELEVENLABS_BOOKING_AGENT_ID");
  },
  // 040: the English-only follow-up agent in the family portal (docs/elevenlabs-followup-agent.md); its server tool
  // `answer_question` uses ELEVENLABS_TOOL_SECRET too. Optional: without both (and outside DEMO_MODE) the
  // `Ask by voice` button is hidden and the text chat is the only way to ask.
  get ELEVENLABS_FOLLOWUP_AGENT_ID() {
    return read("ELEVENLABS_FOLLOWUP_AGENT_ID");
  },
  get ELEVENLABS_TOOL_SECRET() {
    return read("ELEVENLABS_TOOL_SECRET");
  },
  get ELEVENLABS_WEBHOOK_SECRET() {
    return required("ELEVENLABS_WEBHOOK_SECRET");
  },
  // 035: English-only generic pre-consult intake agent (docs/elevenlabs-generic-intake-agent.md). Optional: without it
  // generic intake links work only in DEMO_MODE.
  get ELEVENLABS_GENERIC_INTAKE_AGENT_ID() {
    return read("ELEVENLABS_GENERIC_INTAKE_AGENT_ID");
  },
  // 035: HMAC key for appointment intake links (the token is derived from the attempt id, only its hash is stored).
  // Optional: falls back to the service role key. Changing it invalidates every open appointment intake link.
  get INTAKE_LINK_SECRET() {
    return read("INTAKE_LINK_SECRET");
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
  // 048 FR-3: the public check-in uses M-CHAT-R/F for 18-30 months only when this is "true" (default false: the
  // commercial digital-use licence is unverified and schemas/mchat-rf.json still holds placeholder item text).
  get MCHAT_LICENSED() {
    return process.env.MCHAT_LICENSED === "true";
  },
  // 028 NFR-1: demo (is_synthetic) provider profiles stay visible with a badge unless this is "false".
  get SHOW_SYNTHETIC_LISTINGS() {
    return process.env.SHOW_SYNTHETIC_LISTINGS !== "false";
  },
  // 042: scripts/seed-hyderabad.ts writes synthetic profiles only to a local database unless this is "true".
  get ALLOW_SYNTHETIC_SEED() {
    return process.env.ALLOW_SYNTHETIC_SEED === "true";
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
  // 031: Razorpay (test mode only; lib/payments/razorpay.ts refuses any key id that does not start with rzp_test_).
  // Optional with DEMO_MODE=true (the demo gateway simulates payments); required for real test-mode checkout.
  get RAZORPAY_KEY_ID() {
    return read("RAZORPAY_KEY_ID");
  },
  get RAZORPAY_KEY_SECRET() {
    return read("RAZORPAY_KEY_SECRET");
  },
  get RAZORPAY_WEBHOOK_SECRET() {
    return read("RAZORPAY_WEBHOOK_SECRET");
  },
  /** Dev/test hook (lib/audit.ts `auditWouldFail`); ignored in production builds. */
  get AUDIT_FAIL_ACTIONS() {
    return read("AUDIT_FAIL_ACTIONS");
  },
  // 037: Google Calendar / Meet for video appointments (docs/google-meet.md). Server-only. Without the client id and
  // secret, DEMO_MODE uses a local fake Google; otherwise `Connect Google Calendar` is unavailable.
  get GOOGLE_OAUTH_CLIENT_ID() {
    return read("GOOGLE_OAUTH_CLIENT_ID");
  },
  get GOOGLE_OAUTH_CLIENT_SECRET() {
    return read("GOOGLE_OAUTH_CLIENT_SECRET");
  },
  /** 32 random bytes, base64. Encrypts stored OAuth refresh tokens (AES-256-GCM). */
  get TOKEN_ENCRYPTION_KEY() {
    return read("TOKEN_ENCRYPTION_KEY");
  },
  // 051: voice cost guard (lib/voice/config.ts parses and defaults these; docs/voice-cost-guard.md). Platform budget in
  // minutes (reserved + actual), overridable at runtime in /admin/ops; per-user quotas per agent; cost estimate.
  get VOICE_DAILY_MINUTES_CAP() {
    return read("VOICE_DAILY_MINUTES_CAP");
  },
  get VOICE_MONTHLY_MINUTES_CAP() {
    return read("VOICE_MONTHLY_MINUTES_CAP");
  },
  get VOICE_COST_PER_MINUTE_USD() {
    return read("VOICE_COST_PER_MINUTE_USD");
  },
  get USD_INR_RATE() {
    return read("USD_INR_RATE");
  },
  // 051 FR-8: Cloudflare Turnstile. Only when both are set do voice starts on /screen and /find and the phone sign-in
  // code need a valid token; unset (local, DEMO_MODE) = no bot check. The site key is public by design.
  get TURNSTILE_SITE_KEY() {
    return read("TURNSTILE_SITE_KEY");
  },
  get TURNSTILE_SECRET_KEY() {
    return read("TURNSTILE_SECRET_KEY");
  },
};
