// Ticket 054 FR-4: the poster's QR code. It encodes the referral link (`<app>/screen?ref=<slug>`) and nothing else.
import QRCode from "qrcode";

const REFERRAL_URL = /^https?:\/\/[A-Za-z0-9.:-]+\/screen\?ref=[a-z0-9][a-z0-9-]{1,78}[a-z0-9]$/;

export function isReferralUrl(url: string): boolean {
  return REFERRAL_URL.test(url);
}

/** SVG with a viewBox only (no fixed size), so the poster's CSS sizes it for screen and print. */
export async function referralQrSvg(url: string): Promise<string> {
  if (!isReferralUrl(url)) throw new Error("not a referral link URL");
  return QRCode.toString(url, { type: "svg", errorCorrectionLevel: "M", margin: 2 });
}
