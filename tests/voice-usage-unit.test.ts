// Ticket 051: voice cost guard, pure parts (no database): the silence watch (FR-6), refusal mapping, budget alert
// levels (FR-5), env configuration (FR-4/FR-5/FR-10), call lengths (FR-6), the Turnstile check (FR-8) and the CSP /
// allowlist entries for it.
import { afterEach, describe, expect, it, vi } from "vitest";
import { familyCsp } from "@/lib/csp";
import { allowedOriginsFor, scriptAllowed } from "@/lib/privacy/third-party-allowlist";
import { TURNSTILE_VERIFY_URL, turnstileSiteKey, verifyTurnstile } from "@/lib/turnstile";
import { callSeconds, reportVoiceEnd, SilenceWatch, TURNSTILE_HEADER } from "@/lib/voice/client";
import { DEFAULT_QUOTAS, envVoiceCaps, voiceCostRates, voiceQuota } from "@/lib/voice/config";
import { SILENCE_TIMEOUT_SECONDS, VOICE_MAX_SECONDS, voiceRefusal, voiceSignInHref } from "@/lib/voice/constants";
import { budgetAlertFor, budgetAlertKey, indiaDay, stableUuid } from "@/lib/voice/usage";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("FR-6: call lengths and the silence timeout", () => {
  it("reserves 6 / 4 / 10 / 3 minutes and ends after 30 s of silence", () => {
    expect(VOICE_MAX_SECONDS).toEqual({ screen: 360, booking: 240, followup: 600, intake_demo: 180 });
    expect(SILENCE_TIMEOUT_SECONDS).toBe(30);
  });

  it("silence counts only while the agent is not speaking; user speech resets it", () => {
    const w = new SilenceWatch(0);
    expect(w.silent(29_999)).toBe(false);
    expect(w.silent(30_000)).toBe(true);
    w.heard(30_000);
    expect(w.silent(59_000)).toBe(false);
    // The agent talks for a minute: never "silent" while it speaks, and the clock restarts when it stops.
    w.speaking(true, 40_000);
    expect(w.silent(100_000)).toBe(false);
    w.speaking(false, 100_000);
    expect(w.silent(129_000)).toBe(false);
    expect(w.silent(130_000)).toBe(true);
  });

  it("call seconds are whole and never negative", () => {
    expect(callSeconds(null, 5000)).toBe(0);
    expect(callSeconds(1000, 62_400)).toBe(61);
    expect(callSeconds(5000, 1000)).toBe(0);
  });
});

describe("refusal mapping and the sign-in link", () => {
  it("maps status + error code to the UI message key (anything else is not a cost-guard refusal)", () => {
    expect(voiceRefusal(401, { error: "sign_in_required" })).toBe("signIn");
    expect(voiceRefusal(503, { error: "voice_paused" })).toBe("paused");
    expect(voiceRefusal(429, { error: "quota_day" })).toBe("quotaDay");
    expect(voiceRefusal(429, { error: "quota_month" })).toBe("quotaMonth");
    expect(voiceRefusal(429, { error: "concurrent" })).toBe("concurrent");
    expect(voiceRefusal(400, { error: "bot_check_failed" })).toBe("botCheck");
    expect(voiceRefusal(403, { error: "live_demo_not_allowed" })).toBe("notAllowed");
    expect(voiceRefusal(429, { error: "Too many check-ins" })).toBeNull();
    expect(voiceRefusal(500, { error: "quota_day" })).toBeNull();
    expect(voiceRefusal(429, null)).toBeNull();
  });

  it("sign-in returns to the same voice step", () => {
    expect(voiceSignInHref("/screen?voice=1")).toBe("/family/login?next=%2Fscreen%3Fvoice%3D1");
  });

  it("the end report never throws and sends the duration and conversation id", async () => {
    const fetchFn = vi.fn(async () => Response.json({ status: "ended" }));
    expect(await reportVoiceEnd(fetchFn as unknown as typeof fetch, "u1", 61.4, "conv_1")).toBe(true);
    expect(fetchFn).toHaveBeenCalledWith("/api/voice/usage/u1/end", expect.objectContaining({ method: "POST", keepalive: true }));
    const [, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ duration_seconds: 61, conversation_id: "conv_1" });
    expect(await reportVoiceEnd(fetchFn as unknown as typeof fetch, null, 5)).toBe(false);
    expect(await reportVoiceEnd((async () => Promise.reject(new TypeError("offline"))) as unknown as typeof fetch, "u1", 5)).toBe(false);
  });
});

describe("FR-5: budget alert levels", () => {
  const base = { status: "ok" as const, dayCapSeconds: 1000, monthCapSeconds: 10_000, monthUsedSeconds: 0 };
  it("none below 80%, 80 from 80%, 100 when used up or a start was refused for budget", () => {
    expect(budgetAlertFor({ ...base, dayUsedSeconds: 799 })).toBeNull();
    expect(budgetAlertFor({ ...base, dayUsedSeconds: 800 })).toEqual({ level: 80, period: "day" });
    expect(budgetAlertFor({ ...base, dayUsedSeconds: 1000 })).toEqual({ level: 100, period: "day" });
    expect(budgetAlertFor({ ...base, dayUsedSeconds: 10, status: "budget" })).toEqual({ level: 100, period: "day" });
    expect(budgetAlertFor({ ...base, dayUsedSeconds: 10, monthUsedSeconds: 8500 })).toEqual({ level: 80, period: "month" });
    expect(budgetAlertFor({ ...base, dayCapSeconds: 0, dayUsedSeconds: 0 })).toEqual({ level: 100, period: "day" });
  });

  it("one dedup key per India day and level; a stable uuid aggregate", () => {
    expect(indiaDay(new Date("2026-11-13T19:00:00Z"))).toBe("2026-11-14");
    expect(budgetAlertKey(80, "2026-11-14")).toBe("voice.budget_alert:2026-11-14:80");
    expect(stableUuid("a")).toBe(stableUuid("a"));
    expect(stableUuid("a")).not.toBe(stableUuid("b"));
    expect(stableUuid("a")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe("FR-4 / FR-5 / FR-10: configuration", () => {
  it("defaults from rd.md", () => {
    expect(DEFAULT_QUOTAS).toEqual({
      screen: { day: 2, month: 4 },
      booking: { day: 3, month: 10 },
      followup: { day: 5, month: 30 },
      intake_demo: { day: 1, month: null },
    });
    vi.stubEnv("VOICE_DAILY_MINUTES_CAP", "");
    vi.stubEnv("VOICE_MONTHLY_MINUTES_CAP", "");
    vi.stubEnv("VOICE_COST_PER_MINUTE_USD", "");
    vi.stubEnv("USD_INR_RATE", "");
    expect(envVoiceCaps()).toEqual({ dailyMinutes: 300, monthlyMinutes: 4000 });
    expect(voiceCostRates()).toEqual({ usdPerMinute: 0.1, usdInr: 84 });
  });

  it("env overrides; invalid values fall back to the default", () => {
    vi.stubEnv("VOICE_QUOTA_SCREEN_DAY", "5");
    vi.stubEnv("VOICE_QUOTA_SCREEN_30D", "nope");
    vi.stubEnv("VOICE_DAILY_MINUTES_CAP", "120");
    vi.stubEnv("VOICE_MONTHLY_MINUTES_CAP", "-1");
    vi.stubEnv("VOICE_COST_PER_MINUTE_USD", "0.08");
    expect(voiceQuota("screen")).toEqual({ day: 5, month: 4 });
    expect(voiceQuota("intake_demo")).toEqual({ day: 1, month: null });
    expect(envVoiceCaps()).toEqual({ dailyMinutes: 120, monthlyMinutes: 4000 });
    expect(voiceCostRates().usdPerMinute).toBe(0.08);
  });
});

describe("FR-8: Cloudflare Turnstile", () => {
  const req = (token?: string) =>
    new Request("http://x/api/screen/sessions", { method: "POST", headers: { "x-forwarded-for": "203.0.113.9", ...(token ? { [TURNSTILE_HEADER]: token } : {}) } });

  it("off (keys unset): no check, no network, no site key for pages", async () => {
    vi.stubEnv("TURNSTILE_SITE_KEY", "");
    vi.stubEnv("TURNSTILE_SECRET_KEY", "");
    const fetchFn = vi.fn();
    expect(await verifyTurnstile(req(), fetchFn as unknown as typeof fetch)).toBe(true);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(turnstileSiteKey()).toBeNull();
    vi.stubEnv("TURNSTILE_SITE_KEY", "site-only");
    expect(turnstileSiteKey()).toBeNull();
  });

  it("on: missing, invalid or unverifiable tokens fail; a valid one passes (secret, token and IP sent)", async () => {
    vi.stubEnv("TURNSTILE_SITE_KEY", "site-key-test");
    vi.stubEnv("TURNSTILE_SECRET_KEY", "secret-key-test");
    expect(turnstileSiteKey()).toBe("site-key-test");
    const fetchFn = vi.fn(async (_url: string, init: RequestInit) => {
      const form = init.body as URLSearchParams;
      return Response.json({ success: form.get("response") === "good" && form.get("secret") === "secret-key-test" && form.get("remoteip") === "203.0.113.9" });
    });
    const f = fetchFn as unknown as typeof fetch;
    expect(await verifyTurnstile(req(), f)).toBe(false);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(await verifyTurnstile(req("bad"), f)).toBe(false);
    expect(await verifyTurnstile(req("good"), f)).toBe(true);
    expect(fetchFn.mock.calls[0][0]).toBe(TURNSTILE_VERIFY_URL);
    expect(await verifyTurnstile(req("good"), (async () => Promise.reject(new Error("down"))) as unknown as typeof fetch)).toBe(false);
    expect(await verifyTurnstile(req("good"), (async () => new Response("x", { status: 500 })) as unknown as typeof fetch)).toBe(false);
  });

  it("CSP and allowlist: challenges.cloudflare.com only on the sign-in page, /screen and /find", () => {
    for (const route of ["/family/login", "/screen", "/find"]) {
      expect(allowedOriginsFor(route)).toContain("https://challenges.cloudflare.com");
      expect(scriptAllowed("https://challenges.cloudflare.com/turnstile/v0/api.js", route, "http://localhost:3000")).toBe(true);
    }
    const login = familyCsp({ pathname: "/family/login", nonce: "n", isDev: false });
    expect(login).toContain("frame-src https://challenges.cloudflare.com");
    expect(login).toMatch(/script-src [^;]*https:\/\/challenges\.cloudflare\.com/);
    const screen = familyCsp({ pathname: "/screen", nonce: "n", isDev: false });
    expect(screen).toMatch(/connect-src [^;]*wss:\/\/livekit\.rtc\.elevenlabs\.io[^;]*https:\/\/challenges\.cloudflare\.com/);
    for (const route of ["/family", "/family/children/x", "/family/settings"]) {
      expect(familyCsp({ pathname: route, nonce: "n", isDev: false })).not.toContain("cloudflare");
      expect(scriptAllowed("https://challenges.cloudflare.com/turnstile/v0/api.js", route, "http://localhost:3000")).toBe(false);
    }
  });
});
