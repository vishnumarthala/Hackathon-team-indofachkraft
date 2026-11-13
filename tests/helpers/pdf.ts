// 045: text drawn on PDF pages (pdf-lib writes hex strings into Flate-compressed content streams), for receipt tests.
import { inflateSync } from "node:zlib";

export function pdfText(bytes: Uint8Array): string {
  const buf = Buffer.from(bytes);
  const raw = buf.toString("latin1");
  let text = "";
  for (const m of raw.matchAll(/stream\r?\n/g)) {
    const start = (m.index ?? 0) + m[0].length;
    const end = raw.indexOf("endstream", start);
    try {
      const out = inflateSync(buf.subarray(start, end)).toString("latin1");
      for (const h of out.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)) text += `${Buffer.from(h[1], "hex").toString("latin1")}\n`;
    } catch {
      // not a content stream
    }
  }
  return text;
}
