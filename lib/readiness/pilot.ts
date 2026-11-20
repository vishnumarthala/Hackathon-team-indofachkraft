// Ticket 056: pilot go/no-go for platform admins (/admin/ops). Pure checks over the deployment's configuration, so the
// first real pilot centre never runs on demo settings, demo listings, a draft privacy notice or a missing cron secret.
// Payments and licences are deliberately "deferred": the first pilot is free (055) and M-CHAT-R/F stays off (048).
import { DEFAULT_EMAIL_FROM } from "@/lib/env";

export type ReadinessLevel = "block" | "warn" | "deferred";

export const READINESS_CHECK_IDS = [
  "demoModeOff",
  "syntheticHidden",
  "appUrlHttps",
  "cronSecret",
  "email",
  "privacyReviewed",
  "grievanceOfficer",
  "familySignIn",
  "intakeVoice",
  "aiNotes",
  "paymentsConsistent",
  "whatsapp",
  "phoneSignIn",
  "voiceLanguages",
  "botCheck",
  "syntheticSeedOff",
  "dedicatedSecrets",
  "paymentsDeferred",
  "mchatDeferred",
] as const;
export type ReadinessCheckId = (typeof READINESS_CHECK_IDS)[number];
export type ReadinessCheck = { id: ReadinessCheckId; level: ReadinessLevel; ok: boolean };

export type ReadinessInput = {
  env: Record<string, string | undefined>;
  googleSignIn: boolean;
  phoneSignIn: boolean;
};

const set = (v: string | undefined) => v !== undefined && v !== "";
const hasTelugu = (v: string | undefined) => (v ?? "").split(",").map((s) => s.trim()).includes("te");

export function pilotReadiness({ env: e, googleSignIn, phoneSignIn }: ReadinessInput): ReadinessCheck[] {
  const paymentsOn = e.PAYMENTS_ENABLED === "true";
  const emailFrom = set(e.EMAIL_FROM) ? e.EMAIL_FROM : DEFAULT_EMAIL_FROM;
  const checks: Record<ReadinessCheckId, [ReadinessLevel, boolean]> = {
    demoModeOff: ["block", e.DEMO_MODE !== "true"],
    syntheticHidden: ["block", e.SHOW_SYNTHETIC_LISTINGS === "false"],
    appUrlHttps: ["block", (e.NEXT_PUBLIC_APP_URL ?? "").startsWith("https://")],
    cronSecret: ["block", set(e.CRON_SECRET)],
    // Resend's onboarding sender only delivers to the Resend account owner, never to families or therapists.
    email: ["block", set(e.RESEND_API_KEY) && emailFrom !== DEFAULT_EMAIL_FROM],
    privacyReviewed: ["block", e.PRIVACY_NOTICE_REVIEWED === "true"],
    grievanceOfficer: ["block", set(e.GRIEVANCE_OFFICER_EMAIL)],
    familySignIn: ["block", googleSignIn || phoneSignIn],
    intakeVoice: ["block", set(e.ELEVENLABS_API_KEY) && set(e.ELEVENLABS_AGENT_ID) && set(e.ELEVENLABS_WEBHOOK_SECRET)],
    aiNotes: ["block", set(e.GEMINI_API_KEY)],
    paymentsConsistent: [
      "block",
      !paymentsOn || (set(e.RAZORPAY_KEY_ID) && set(e.RAZORPAY_KEY_SECRET) && set(e.RAZORPAY_WEBHOOK_SECRET)),
    ],
    whatsapp: ["warn", set(e.WHATSAPP_TOKEN) && set(e.WHATSAPP_PHONE_NUMBER_ID)],
    phoneSignIn: ["warn", phoneSignIn],
    voiceLanguages: ["warn", hasTelugu(e.ELEVENLABS_SCREEN_LANGUAGES) && hasTelugu(e.ELEVENLABS_GENERIC_INTAKE_LANGUAGES)],
    botCheck: ["warn", set(e.TURNSTILE_SITE_KEY) && set(e.TURNSTILE_SECRET_KEY)],
    syntheticSeedOff: ["warn", e.ALLOW_SYNTHETIC_SEED !== "true"],
    dedicatedSecrets: ["warn", set(e.INTAKE_LINK_SECRET) && set(e.CONSENT_IP_SALT) && set(e.TOKEN_ENCRYPTION_KEY)],
    paymentsDeferred: ["deferred", !paymentsOn],
    mchatDeferred: ["deferred", e.MCHAT_LICENSED !== "true"],
  };
  return READINESS_CHECK_IDS.map((id) => ({ id, level: checks[id][0], ok: checks[id][1] }));
}

/** Ready for real families when no blocker fails; warnings are shown but do not stop the pilot. */
export function pilotVerdict(checks: ReadinessCheck[]): "ready" | "blocked" {
  return checks.some((c) => c.level === "block" && !c.ok) ? "blocked" : "ready";
}
