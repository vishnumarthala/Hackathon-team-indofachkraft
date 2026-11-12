// Image/file sniffing and metadata stripping for provider uploads (FR-3, D-6). No dependencies: JPEG
// APPn/COM segments and PNG text/eXIf chunks are dropped byte-wise, which removes EXIF (GPS, device,
// timestamps), XMP and IPTC while leaving the pixels untouched.

export type SniffedType = "image/jpeg" | "image/png" | "application/pdf";

export function sniffType(bytes: Uint8Array): SniffedType | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (
    bytes.length >= 8 &&
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((b, i) => bytes[i] === b)
  ) {
    return "image/png";
  }
  if (bytes.length >= 5 && String.fromCharCode(...bytes.subarray(0, 5)) === "%PDF-") return "application/pdf";
  return null;
}

// Keep JFIF (APP0) and the colour profile (APP2 ICC_PROFILE); drop APP1 (EXIF/XMP), APP3-15 and comments.
function keepJpegMarker(marker: number): boolean {
  if (marker === 0xfe) return false;
  if (marker >= 0xe0 && marker <= 0xef) return marker === 0xe0 || marker === 0xe2;
  return true;
}

export function stripJpegMetadata(input: Uint8Array): Uint8Array {
  const out: Uint8Array[] = [input.subarray(0, 2)];
  let i = 2;
  while (i < input.length) {
    if (input[i] !== 0xff) throw new Error("Invalid JPEG");
    while (input[i] === 0xff && i < input.length) i++; // fill bytes
    const marker = input[i];
    const start = i - 1;
    i++;
    if (marker === 0xd9) {
      out.push(input.subarray(start, i));
      break;
    }
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      out.push(input.subarray(start, i));
      continue;
    }
    if (i + 1 >= input.length) throw new Error("Invalid JPEG");
    const length = (input[i] << 8) | input[i + 1];
    if (length < 2 || i + length > input.length) throw new Error("Invalid JPEG");
    const end = i + length;
    if (marker === 0xda) {
      // Start of scan: entropy-coded data follows; copy everything to the end verbatim.
      out.push(input.subarray(start));
      break;
    }
    if (keepJpegMarker(marker)) out.push(input.subarray(start, end));
    i = end;
  }
  return concat(out);
}

const PNG_KEEP = new Set(["IHDR", "PLTE", "IDAT", "IEND", "tRNS", "gAMA", "cHRM", "sRGB", "iCCP", "sBIT", "pHYs", "bKGD"]);

export function stripPngMetadata(input: Uint8Array): Uint8Array {
  const out: Uint8Array[] = [input.subarray(0, 8)];
  let i = 8;
  while (i + 8 <= input.length) {
    const length = ((input[i] << 24) >>> 0) + (input[i + 1] << 16) + (input[i + 2] << 8) + input[i + 3];
    const type = String.fromCharCode(...input.subarray(i + 4, i + 8));
    const end = i + 12 + length;
    if (end > input.length) throw new Error("Invalid PNG");
    if (PNG_KEEP.has(type)) out.push(input.subarray(i, end));
    i = end;
    if (type === "IEND") break;
  }
  return concat(out);
}

export function stripImageMetadata(input: Uint8Array, type: "image/jpeg" | "image/png"): Uint8Array {
  return type === "image/jpeg" ? stripJpegMetadata(input) : stripPngMetadata(input);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}
