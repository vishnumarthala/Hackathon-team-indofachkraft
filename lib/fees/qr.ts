// Ticket 045 FR-3 / NFR-3: the desk QR code. It encodes the payment link's short URL and nothing else (no child name).
import QRCode from "qrcode";

export async function linkQrSvg(url: string): Promise<string> {
  if (!/^https?:\/\/[A-Za-z0-9.:-]+\/[A-Za-z0-9/_-]{1,120}$/.test(url)) throw new Error("not a payment link URL");
  return QRCode.toString(url, { type: "svg", errorCorrectionLevel: "M", margin: 2, width: 280 });
}
