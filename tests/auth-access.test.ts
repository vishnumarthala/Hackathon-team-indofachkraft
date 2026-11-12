import { describe, expect, it } from "vitest";
import { isProtectedPath, isPublicApiPath } from "@/lib/auth-access";

describe("authentication route access", () => {
  it("protects the therapist app and API routes", () => {
    for (const path of [
      "/dashboard",
      "/dashboard/pilots",
      "/cases/new",
      "/cases/123/report",
      "/admin/users",
      "/api/cases",
      "/api/facts/123",
    ]) {
      expect(isProtectedPath(path), path).toBe(true);
    }
  });

  it("leaves only the documented token, webhook, and pilot routes public", () => {
    for (const path of [
      "/api/pilot-signups",
      "/api/locale",
      "/api/demo/voice-token",
      "/api/providers/join",
      "/api/webhooks/elevenlabs",
      "/api/intake/a-token/start",
      "/api/intake/a-token/complete",
      "/api/dev/simulate-intake/a-token",
      "/api/cases/123/ask",
    ]) {
      expect(isPublicApiPath(path), path).toBe(true);
      expect(isProtectedPath(path), path).toBe(false);
    }

    expect(isProtectedPath("/api/cases/123")).toBe(true);
    expect(isProtectedPath("/api/providers/register")).toBe(true);
  });

  it("does not protect public landing, login, intake, or specialist pages", () => {
    for (const path of ["/", "/login", "/intake/a-token", "/specialist/a-token"]) {
      expect(isProtectedPath(path), path).toBe(false);
    }
  });
});
