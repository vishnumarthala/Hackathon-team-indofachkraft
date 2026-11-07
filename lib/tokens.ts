import { randomBytes } from "node:crypto";

export function newToken(): string {
  return randomBytes(32).toString("base64url");
}
