import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "@/lib/env";

afterEach(() => vi.unstubAllEnvs());

describe("env", () => {
  it("throws a clear message for a missing required var", () => {
    vi.stubEnv("GEMINI_API_KEY", "");
    expect(() => env.GEMINI_API_KEY).toThrow("Missing env var: GEMINI_API_KEY");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", undefined as unknown as string);
    vi.stubEnv("SUPABASE_SECRET_KEY", "");
    expect(() => env.SUPABASE_SERVICE_ROLE_KEY).toThrow("Missing env var: SUPABASE_SERVICE_ROLE_KEY");
  });

  it("returns set values", () => {
    vi.stubEnv("GEMINI_API_KEY", "k");
    expect(env.GEMINI_API_KEY).toBe("k");
  });

  it("applies defaults and booleans", () => {
    vi.stubEnv("GEMINI_MODEL", "");
    vi.stubEnv("EMAIL_FROM", "");
    vi.stubEnv("DEMO_MODE", "yes");
    vi.stubEnv("DEMO_EMAIL_TO", "");
    vi.stubEnv("DEMO_FIXTURES_DIR", "");
    expect(env.GEMINI_MODEL).toBe("gemini-3.8-flash");
    expect(env.EMAIL_FROM).toBe("DoctorNearMe <onboarding@resend.dev>");
    expect(env.DEMO_MODE).toBe(false);
    expect(env.DEMO_EMAIL_TO).toBeUndefined();
    expect(env.DEMO_FIXTURES_DIR).toBe("demo/fixtures");
    vi.stubEnv("DEMO_MODE", "true");
    expect(env.DEMO_MODE).toBe(true);
  });
});

describe("Supabase key names", () => {
  it("accepts the newer publishable and secret key names", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "pub");
    vi.stubEnv("SUPABASE_SECRET_KEY", "sec");
    expect(env.NEXT_PUBLIC_SUPABASE_ANON_KEY).toBe("pub");
    expect(env.SUPABASE_SERVICE_ROLE_KEY).toBe("sec");
  });

  it("prefers the legacy names and reports the canonical name when both are missing", () => {
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "legacy");
    vi.stubEnv("SUPABASE_SECRET_KEY", "sec");
    expect(env.SUPABASE_SERVICE_ROLE_KEY).toBe("legacy");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    vi.stubEnv("SUPABASE_SECRET_KEY", "");
    expect(() => env.SUPABASE_SERVICE_ROLE_KEY).toThrow("Missing env var: SUPABASE_SERVICE_ROLE_KEY");
  });
});
