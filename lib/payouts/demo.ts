// Ticket 046: DEMO_MODE fakes Razorpay Route end to end. The demo gateway (lib/payments/razorpay.ts) answers transfer,
// release and reversal calls; this module fakes the webhooks Razorpay would send for transfers - a Razorpay-shaped
// event body, signed with the (demo) webhook secret, verified and handled exactly like a delivery to
// /api/webhooks/razorpay (dedup by event id included). `transfer.failed` for linked accounts whose id contains FAIL,
// `transfer.processed` otherwise.
import { createHash } from "node:crypto";
import { handleWebhookEvent, type WebhookResult } from "@/lib/payments/store";
import { hmacSha256Hex, razorpaySettings, verifyWebhookSignature } from "@/lib/payments/razorpay";
import { parseWebhook } from "@/lib/payments/webhook";

export type DemoTransfer = {
  transferId: string;
  /** The source payment (pay_...). */
  source: string | null;
  recipient: string;
  amountPaise: number;
  onHold: boolean;
  payoutTransfer: string;
};

export function demoTransferOutcome(recipient: string): "transfer.processed" | "transfer.failed" {
  return /FAIL/.test(recipient) ? "transfer.failed" : "transfer.processed";
}

export function demoTransferEventBody(event: "transfer.processed" | "transfer.failed", t: DemoTransfer, now = new Date()): string {
  const at = Math.floor(now.getTime() / 1000);
  const failed = event === "transfer.failed";
  return JSON.stringify({
    entity: "event",
    account_id: "acc_DEMOPLATFORM01",
    event,
    contains: ["transfer"],
    payload: {
      transfer: {
        entity: {
          id: t.transferId,
          entity: "transfer",
          status: failed ? "failed" : "processed",
          source: t.source,
          recipient: t.recipient,
          amount: t.amountPaise,
          currency: "INR",
          amount_reversed: 0,
          notes: { payout_transfer: t.payoutTransfer },
          on_hold: t.onHold,
          processed_at: failed ? null : at,
          created_at: at,
          error: failed
            ? { code: "BAD_REQUEST_ERROR", description: "Linked account cannot receive transfers (demo)", reason: "linked_account_inactive" }
            : { code: null, description: null, reason: null },
        },
      },
    },
    created_at: at,
  });
}

/** Signs and delivers a fake Razorpay webhook to the same handler the route uses (DEMO_MODE only). */
export async function deliverDemoWebhook(raw: string): Promise<WebhookResult> {
  const settings = razorpaySettings();
  if (settings.mode !== "demo" || !settings.webhookSecret) throw new Error("demo webhooks only in DEMO_MODE");
  const signature = hmacSha256Hex(settings.webhookSecret, raw);
  if (!verifyWebhookSignature(raw, signature, settings.webhookSecret)) throw new Error("demo webhook signature mismatch");
  const eventId = `evt_DEMO${createHash("sha256").update(raw).digest("hex").slice(0, 20)}`;
  return handleWebhookEvent(eventId, parseWebhook(raw));
}
