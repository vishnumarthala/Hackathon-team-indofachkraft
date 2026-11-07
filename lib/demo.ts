import { readFileSync } from "node:fs";
import path from "node:path";
import type { z } from "zod";
import { env } from "@/lib/env";

export function isDemoMode(): boolean {
  return env.DEMO_MODE;
}

// Read from disk on every call (no cache) so evals can break one fixture in a per-worker copy.
export function loadFixture<T = unknown>(relPath: string, schema?: z.ZodType<T>): T {
  const file = path.resolve(process.cwd(), env.DEMO_FIXTURES_DIR, relPath);
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    throw new Error(`Missing fixture ${relPath}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid fixture ${relPath}: not valid JSON`);
  }
  if (!schema) return json as T;
  const result = schema.safeParse(json);
  if (!result.success) throw new Error(`Invalid fixture ${relPath}: ${result.error.issues[0]?.message ?? "invalid"}`);
  return result.data;
}
