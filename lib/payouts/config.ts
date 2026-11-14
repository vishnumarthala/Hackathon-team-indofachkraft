// Ticket 046: payout configuration from env (lazy; defaults when unset or invalid).
import { env } from "@/lib/env";
import { DEFAULT_FEE_BPS, DEFAULT_GST_BPS, MAX_FEE_BPS } from "./fees";

function intIn(raw: string | undefined, min: number, max: number, fallback: number): number {
  if (raw === undefined || !/^\d+$/.test(raw.trim())) return fallback;
  const n = Number(raw.trim());
  return n >= min && n <= max ? n : fallback;
}

export type PayoutConfig = {
  defaultFeeBps: number;
  gstBps: number;
  platform: { legal_name: string; gstin: string | null; address: string | null };
  demo: boolean;
};

export function payoutConfig(): PayoutConfig {
  const gstin = env.PLATFORM_GSTIN?.trim().toUpperCase() ?? null;
  return {
    defaultFeeBps: intIn(env.PLATFORM_FEE_DEFAULT_BPS, 0, MAX_FEE_BPS, DEFAULT_FEE_BPS),
    gstBps: intIn(env.PLATFORM_GST_BPS, 0, 2800, DEFAULT_GST_BPS),
    platform: {
      legal_name: env.PLATFORM_LEGAL_NAME?.trim() || "DoctorNearMe",
      gstin: gstin && /^[0-9]{2}[A-Z0-9]{13}$/.test(gstin) ? gstin : null,
      address: env.PLATFORM_ADDRESS?.trim() || null,
    },
    demo: env.DEMO_MODE,
  };
}
