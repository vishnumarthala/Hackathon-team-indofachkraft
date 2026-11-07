import { NextResponse } from "next/server";
import type { z } from "zod";

export function ok<T>(data: T, status = 200) {
  return NextResponse.json(data, { status });
}

export function fail(status: number, error: string, details?: unknown) {
  return NextResponse.json(details === undefined ? { error } : { error, details }, { status });
}

export function fieldErrors(error: z.ZodError): Record<string, string> {
  const details: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.length > 0 ? String(issue.path[0]) : "body";
    details[key] ??= issue.message;
  }
  return details;
}

export async function parseJson<S extends z.ZodType>(
  req: Request,
  schema: S,
): Promise<{ data: z.output<S> } | { response: NextResponse }> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return { response: fail(400, "Invalid request", { body: "Body must be JSON" }) };
  }
  const result = schema.safeParse(body);
  if (!result.success) return { response: fail(400, "Invalid request", fieldErrors(result.error)) };
  return { data: result.data };
}
