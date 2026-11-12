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
};
