// FR-6 WhatsApp channel: Meta WhatsApp Cloud API, approved templates only (no free-form text, no inbound).
// Until a token, a phone number id and approved templates exist (human task, docs/notifications.md), and always in
// DEMO_MODE, deliveries are `skipped` with `whatsapp_not_configured`; they never fail the domain action.
import { env } from "@/lib/env";
import { NotifyError, type SendOutcome, type WhatsAppContent } from "./types";

export type WhatsAppConfig = {
  token?: string;
  phoneNumberId?: string;
  apiVersion: string;
  demoMode: boolean;
};

export function whatsappConfig(): WhatsAppConfig {
  return {
    token: env.WHATSAPP_TOKEN,
    phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID,
    apiVersion: env.WHATSAPP_API_VERSION,
    demoMode: env.DEMO_MODE,
  };
}

export function isWhatsAppConfigured(config: WhatsAppConfig): boolean {
  return !config.demoMode && Boolean(config.token) && Boolean(config.phoneNumberId);
}

export type WhatsAppJob = {
  notificationId: string;
  /** Verified phone (019), E.164 digits without '+', e.g. 919000000001. */
  phone: string | null;
  /** The recipient's `whatsapp` preference (opt-in, default off). */
  enabled: boolean;
  content: WhatsAppContent | undefined;
};

export type WhatsAppDeps = { fetch: typeof fetch; config: WhatsAppConfig };

export function buildWhatsAppRequest(config: WhatsAppConfig, job: WhatsAppJob & { phone: string; content: WhatsAppContent }) {
  const url = `https://graph.facebook.com/${config.apiVersion}/${encodeURIComponent(config.phoneNumberId ?? "")}/messages`;
  const body = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: job.phone,
    type: "template",
    // Echoed in delivery webhooks (not built yet) so a status can be matched to the notification.
    biz_opaque_callback_data: `notification:${job.notificationId}`,
    template: {
      name: job.content.name,
      language: { code: job.content.language },
      components: job.content.params.length
        ? [{ type: "body", parameters: job.content.params.map((text) => ({ type: "text", text })) }]
        : [],
    },
  };
  return {
    url,
    init: {
      method: "POST",
      headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    } satisfies RequestInit,
  };
}

// Meta error codes that will not succeed on retry: undeliverable / not on WhatsApp, recipient opted out or blocked,
// invalid parameters, template missing / paused / disabled / parameter mismatch.
const PERMANENT_CODES = new Set([
  100, 131008, 131009, 131026, 131030, 131050, 131051, 132000, 132001, 132005, 132007, 132012, 132015, 132016,
  132068, 133010,
]);
// Throttling and temporary platform errors.
const TRANSIENT_CODES = new Set([1, 2, 4, 80007, 130429, 131000, 131016, 131048, 131056, 133004]);

export function classifyWhatsAppError(status: number, code: number | undefined): boolean {
  if (code !== undefined && TRANSIENT_CODES.has(code)) return false;
  if (code !== undefined && PERMANENT_CODES.has(code)) return true;
  if (status === 429 || status >= 500) return false;
  // 401/403 (token) needs an operator, not a different message: keep retrying until it is fixed.
  if (status === 401 || status === 403) return false;
  return status >= 400;
}

export async function deliverWhatsApp(
  job: WhatsAppJob,
  deps: WhatsAppDeps = { fetch: (...args) => fetch(...args), config: whatsappConfig() },
): Promise<SendOutcome> {
  if (!isWhatsAppConfigured(deps.config)) return { status: "skipped", reason: "whatsapp_not_configured" };
  if (!job.enabled) return { status: "skipped", reason: "opted_out" };
  if (!job.phone) return { status: "skipped", reason: "no_phone" };
  if (!job.content) return { status: "skipped", reason: "no_content" };

  const { url, init } = buildWhatsAppRequest(deps.config, { ...job, phone: job.phone, content: job.content });
  let res: Response;
  try {
    res = await deps.fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
  } catch (err) {
    throw new NotifyError("whatsapp_network", false, err instanceof Error ? err.message : String(err));
  }
  const data = (await res.json().catch(() => null)) as
    | { messages?: { id?: string }[]; error?: { code?: number; message?: string } }
    | null;
  if (!res.ok || data?.error) {
    const code = data?.error?.code;
    throw new NotifyError(
      `whatsapp_${code ?? res.status}`,
      classifyWhatsAppError(res.status, code),
      `WhatsApp ${res.status}${code ? ` (${code})` : ""}: ${data?.error?.message ?? "request failed"}`,
    );
  }
  return { status: "sent", providerMessageId: data?.messages?.[0]?.id ?? null };
}
