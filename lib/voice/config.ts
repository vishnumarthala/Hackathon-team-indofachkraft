// Ticket 051: voice cost guard configuration (server). Every value is env-configurable with the rd.md defaults;
// the platform caps can also be overridden at runtime by a platform admin (`voice_settings`, /admin/ops).
import { env } from "@/lib/env";
import type { VoiceAgent } from "./constants";

export type VoiceQuota = { day: number | null; month: number | null };

export const DEFAULT_QUOTAS: Record<VoiceAgent, VoiceQuota> = {
  screen: { day: 2, month: 4 },
  booking: { day: 3, month: 10 },
  followup: { day: 5, month: 30 },
  intake_demo: { day: 1, month: null },
};

export const DEFAULT_DAILY_MINUTES_CAP = 300;
export const DEFAULT_MONTHLY_MINUTES_CAP = 4000;
export const DEFAULT_COST_PER_MINUTE_USD = 0.1;
export const DEFAULT_USD_INR_RATE = 84;

const QUOTA_ENV: Record<VoiceAgent, { day: string; month: string | null }> = {
  screen: { day: "VOICE_QUOTA_SCREEN_DAY", month: "VOICE_QUOTA_SCREEN_30D" },
  booking: { day: "VOICE_QUOTA_BOOKING_DAY", month: "VOICE_QUOTA_BOOKING_30D" },
  followup: { day: "VOICE_QUOTA_FOLLOWUP_DAY", month: "VOICE_QUOTA_FOLLOWUP_30D" },
  intake_demo: { day: "VOICE_QUOTA_INTAKE_DEMO_DAY", month: null },
};

function envNumber(raw: string | undefined, fallback: number, opts: { min: number; integer?: boolean }): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < opts.min) return fallback;
  return opts.integer ? Math.floor(n) : n;
}

export function voiceQuota(agent: VoiceAgent): VoiceQuota {
  const names = QUOTA_ENV[agent];
  const d = DEFAULT_QUOTAS[agent];
  return {
    day: d.day === null ? null : envNumber(process.env[names.day], d.day, { min: 0, integer: true }),
    month: names.month === null || d.month === null ? d.month : envNumber(process.env[names.month], d.month, { min: 0, integer: true }),
  };
}

/** Env caps in minutes (before the admin override). */
export function envVoiceCaps(): { dailyMinutes: number; monthlyMinutes: number } {
  return {
    dailyMinutes: envNumber(env.VOICE_DAILY_MINUTES_CAP, DEFAULT_DAILY_MINUTES_CAP, { min: 0, integer: true }),
    monthlyMinutes: envNumber(env.VOICE_MONTHLY_MINUTES_CAP, DEFAULT_MONTHLY_MINUTES_CAP, { min: 0, integer: true }),
  };
}

export function voiceCostRates(): { usdPerMinute: number; usdInr: number } {
  return {
    usdPerMinute: envNumber(env.VOICE_COST_PER_MINUTE_USD, DEFAULT_COST_PER_MINUTE_USD, { min: 0 }),
    usdInr: envNumber(env.USD_INR_RATE, DEFAULT_USD_INR_RATE, { min: 0 }),
  };
}
