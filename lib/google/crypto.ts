// 037 FR-2 / NFR-1: AES-256-GCM for stored OAuth refresh tokens and the sealed OAuth state cookie.
// Key: TOKEN_ENCRYPTION_KEY = 32 random bytes, base64. Blob layout: version (1 byte) || iv (12) || auth tag (16) ||
// ciphertext. The additional authenticated data (AAD) binds a ciphertext to its purpose and row (e.g. the provider
// profile id), so a token copied to another row, or any changed byte, fails to decrypt.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { env } from "@/lib/env";

const VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export class TokenKeyError extends Error {
  constructor(message = "TOKEN_ENCRYPTION_KEY must be 32 bytes, base64") {
    super(message);
    this.name = "TokenKeyError";
  }
}

/** Decryption failed: wrong key, wrong AAD (row) or tampered bytes. */
export class TokenDecryptError extends Error {
  constructor() {
    super("token_unreadable");
    this.name = "TokenDecryptError";
  }
}

export function parseEncryptionKey(value: string | undefined): Buffer {
  if (!value) throw new TokenKeyError("TOKEN_ENCRYPTION_KEY is not set");
  const key = Buffer.from(value.trim(), "base64");
  if (key.length !== 32) throw new TokenKeyError();
  return key;
}

export function encryptionKeyConfigured(): boolean {
  try {
    parseEncryptionKey(env.TOKEN_ENCRYPTION_KEY);
    return true;
  } catch {
    return false;
  }
}

export function encryptSecret(plain: string, aad: string, key: Buffer = parseEncryptionKey(env.TOKEN_ENCRYPTION_KEY)): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), body]);
}

export function decryptSecret(blob: Uint8Array, aad: string, key: Buffer = parseEncryptionKey(env.TOKEN_ENCRYPTION_KEY)): string {
  const buf = Buffer.from(blob);
  if (buf.length < 1 + IV_BYTES + TAG_BYTES + 1 || buf[0] !== VERSION) throw new TokenDecryptError();
  try {
    const iv = buf.subarray(1, 1 + IV_BYTES);
    const tag = buf.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES);
    const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(buf.subarray(1 + IV_BYTES + TAG_BYTES)), decipher.final()]).toString("utf8");
  } catch {
    throw new TokenDecryptError();
  }
}

/** JSON sealed for a cookie (base64url). */
export function sealJson(value: unknown, aad: string, key?: Buffer): string {
  return encryptSecret(JSON.stringify(value), aad, key).toString("base64url");
}

/** Opens a sealed value; null when missing, tampered, sealed for another purpose or not JSON. */
export function openJson<T>(sealed: string | undefined | null, aad: string, key?: Buffer): T | null {
  if (!sealed || sealed.length > 4096) return null;
  try {
    return JSON.parse(decryptSecret(Buffer.from(sealed, "base64url"), aad, key)) as T;
  } catch {
    return null;
  }
}

/** AAD of a provider's stored refresh token. */
export const refreshTokenAad = (providerProfileId: string) => `google-refresh-token:v1:${providerProfileId}`;
