// Ticket 023 FR-2: the stored file's real type from its first bytes. The browser-supplied type and the file
// extension are never trusted on their own. Pure; safe anywhere.
import type { DocumentMime } from "./constants";

/** Bytes to read from the start of an object to sniff its type (enough for an ISO BMFF `ftyp` box). */
export const SNIFF_BYTES = 64;

// HEIC/HEIF still images (ISO/IEC 23008-12). `mif1`/`msf1` are generic HEIF brands; AVIF (`avif`/`avis`) is
// a different format and is not accepted.
const HEIC_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs"]);
const GENERIC_HEIF_BRANDS = new Set(["mif1", "msf1"]);

const ascii = (bytes: Uint8Array, start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end));

function isHeic(bytes: Uint8Array): boolean {
  if (bytes.length < 16 || ascii(bytes, 4, 8) !== "ftyp") return false;
  const boxSize = ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;
  const major = ascii(bytes, 8, 12);
  if (HEIC_BRANDS.has(major)) return true;
  if (!GENERIC_HEIF_BRANDS.has(major)) return false;
  // Generic HEIF: one of the compatible brands (after major + minor version) must be a HEIC brand.
  const end = Math.min(boxSize, bytes.length);
  for (let i = 16; i + 4 <= end; i += 4) {
    if (HEIC_BRANDS.has(ascii(bytes, i, i + 4))) return true;
  }
  return false;
}

export function sniffDocumentType(bytes: Uint8Array): DocumentMime | null {
  if (bytes.length >= 5 && ascii(bytes, 0, 5) === "%PDF-") return "application/pdf";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((b, i) => bytes[i] === b)) {
    return "image/png";
  }
  if (isHeic(bytes)) return "image/heic";
  return null;
}
