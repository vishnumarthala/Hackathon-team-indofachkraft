// Ticket 054: paediatrician referral kit. The referral link and QR helpers, slug -> "Referred by" note on /screen (a
// verified + listed profile only, same loader and SHOW_SYNTHETIC_LISTINGS rule as /p/<slug>; anything else is ignored),
// the start request carrying `ref`, and the printable poster page. Pure / rendered with mocks; the database side
// (storing `referred_by_profile_id`, the 30-day count) is in referral-kit.db.test.ts. Synthetic data only.
import type { ReactElement } from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { prerender } from "react-dom/static";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withI18n } from "./helpers/i18n";

const m = vi.hoisted(() => ({
  locale: "en" as "en" | "hi" | "te",
  user: null as null | { id: string; email: string },
  role: "provider" as string,
  profile: null as null | Record<string, unknown>,
  count: 0,
}));
const pub = vi.hoisted(() => ({ getPublicProfile: vi.fn(), loadPublicProfile: vi.fn() }));

vi.mock("next/cache", () => ({ revalidateTag: vi.fn(), unstable_cache: (fn: () => unknown) => fn }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "dnm_locale" ? { name, value: m.locale } : undefined),
    getAll: () => [{ name: "dnm_locale", value: m.locale }],
    has: (name: string) => name === "dnm_locale",
  }),
  headers: async () => new Headers(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
  usePathname: () => "/screen",
  redirect: (to: string) => {
    throw new Error(`redirect ${to}`);
  },
}));
vi.mock("@elevenlabs/react", () => ({
  ConversationProvider: ({ children }: { children: unknown }) => children,
  useConversation: () => ({ status: "disconnected", isSpeaking: false, startSession: vi.fn(), endSession: vi.fn(), getId: () => "" }),
}));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    getAuthenticatedUser: vi.fn(async () => m.user),
    requirePageUser: vi.fn(async () => m.user),
    getUserRole: vi.fn(async () => m.role),
  };
});
vi.mock("@/lib/providers/public", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/providers/public")>();
  return {
    ...actual,
    getPublicProfile: (slug: string) => pub.getPublicProfile(slug),
    loadPublicProfile: (slug: string, show: boolean) => pub.loadPublicProfile(slug, show),
  };
});
vi.mock("@/lib/providers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/providers")>();
  return { ...actual, getProfileByUserId: vi.fn(async () => m.profile) };
});
vi.mock("@/lib/referrals", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/referrals")>();
  return { ...actual, countReferredCheckins: vi.fn(async () => m.count) };
});

import { ScreenFlow } from "@/components/screen/ScreenFlow";
import { startScreen } from "@/lib/screen/client";
import { CreateSessionSchema } from "@/lib/screen/questions";
import { loadReferrerFresh, resolveReferrer } from "@/lib/referrals";
import { parseRef, referralPath, referralUrl, shortReferralUrl } from "@/lib/referrals/link";
import { isReferralUrl, referralQrSvg } from "@/lib/referrals/qr";
import ScreenPage from "@/app/screen/page";
import ReferralPosterPage from "@/app/dashboard/profile/poster/page";

const SLUG = "dr-asha-rao-ab12cd";
const ASHA = { id: "11111111-1111-4111-8111-111111111111", slug: SLUG, display_name: "Dr Asha Rao (synthetic)", provider_type: "pediatrician" as const };
/** Stand-in for the verified + listed directory: only Asha is public; every other slug (unknown, unlisted) is null. */
const directory = async (slug: string) => (slug === SLUG ? { provider: ASHA, locations: [] } : null);

const decode = (s: string) => s.replaceAll("&#x27;", "'").replaceAll("&amp;", "&").replaceAll("&quot;", '"');
async function html(page: () => Promise<ReactElement>): Promise<string> {
  const { prelude } = await prerender(withI18n(await page(), m.locale));
  return decode(await new Response(prelude).text());
}

beforeEach(() => {
  m.locale = "en";
  m.user = null;
  m.role = "provider";
  m.profile = null;
  m.count = 0;
  pub.getPublicProfile.mockReset().mockImplementation(directory);
  pub.loadPublicProfile.mockReset().mockImplementation(directory);
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://doctornearme.example/");
  vi.stubEnv("ELEVENLABS_SCREEN_AGENT_ID", "");
  vi.stubEnv("DEMO_MODE", "false");
});
afterEach(() => vi.unstubAllEnvs());

describe("referral link and QR (FR-1, FR-4)", () => {
  it("parseRef accepts a public profile slug only (trimmed, lower-cased, first of a repeated param)", () => {
    expect(parseRef(SLUG)).toBe(SLUG);
    expect(parseRef(`  ${SLUG.toUpperCase()} `)).toBe(SLUG);
    expect(parseRef([SLUG, "other-slug"])).toBe(SLUG);
    for (const bad of [undefined, null, 42, {}, "", "ab", "-dr-x", "dr-x-", "dr x", "../admin", "dr_x", "<script>", "a".repeat(81), `${SLUG}&x=1`]) {
      expect(parseRef(bad), String(bad)).toBeNull();
    }
  });

  it("referralUrl = app base URL + /screen?ref=<slug>; bad slugs and base URLs throw", () => {
    expect(referralPath(SLUG)).toBe(`/screen?ref=${SLUG}`);
    expect(referralUrl("https://doctornearme.example/", SLUG)).toBe(`https://doctornearme.example/screen?ref=${SLUG}`);
    expect(referralUrl("http://localhost:3000", SLUG)).toBe(`http://localhost:3000/screen?ref=${SLUG}`);
    expect(shortReferralUrl(`https://doctornearme.example/screen?ref=${SLUG}`)).toBe(`doctornearme.example/screen?ref=${SLUG}`);
    expect(() => referralPath("Dr Asha")).toThrow(/slug/);
    expect(() => referralUrl("javascript:alert(1)", SLUG)).toThrow(/base URL/);
    expect(() => referralUrl("https://doctornearme.example/app", SLUG)).toThrow(/base URL/);
  });

  it("the QR code encodes a referral link and nothing else", async () => {
    const url = referralUrl("https://doctornearme.example", SLUG);
    expect(isReferralUrl(url)).toBe(true);
    const svg = await referralQrSvg(url);
    expect(svg).toMatch(/^<svg [^>]*viewBox="0 0 \d+ \d+"/);
    expect(svg.slice(0, svg.indexOf(">"))).not.toMatch(/ width=/);
    for (const bad of [
      `${url}&child=Ravi`,
      "https://doctornearme.example/screen?ref=Dr Asha",
      "https://doctornearme.example/pay/abc123",
      "javascript:alert(1)//screen?ref=dr-x-1",
      "https://evil.example/path/screen?ref=dr-x-1",
    ]) {
      expect(isReferralUrl(bad), bad).toBe(false);
      await expect(referralQrSvg(bad)).rejects.toThrow(/referral link/);
    }
  });
});

describe("slug -> referrer (FR-1)", () => {
  it("a verified + listed profile resolves; unknown or unlisted slugs (loader null) are ignored", async () => {
    expect(await resolveReferrer(SLUG, directory)).toEqual({
      profileId: ASHA.id,
      slug: SLUG,
      displayName: ASHA.display_name,
      providerType: "pediatrician",
    });
    expect(await resolveReferrer("dr-unlisted-99", directory)).toBeNull();
  });

  it("malformed refs never reach the database; a lookup error is swallowed (check-in goes on)", async () => {
    const load = vi.fn(directory);
    expect(await resolveReferrer("../../etc", load)).toBeNull();
    expect(await resolveReferrer(undefined, load)).toBeNull();
    expect(load).not.toHaveBeenCalled();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await resolveReferrer(SLUG, async () => Promise.reject(new Error("db down")))).toBeNull();
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/referral lookup failed: db down/));
    error.mockRestore();
  });

  it.each([
    ["true", true],
    ["false", false],
  ])("the fresh loader is the public-profile loader with SHOW_SYNTHETIC_LISTINGS=%s", async (flag, show) => {
    vi.stubEnv("SHOW_SYNTHETIC_LISTINGS", flag);
    await loadReferrerFresh(SLUG);
    expect(pub.loadPublicProfile).toHaveBeenCalledWith(SLUG, show);
  });
});

describe("start request (FR-3)", () => {
  it("`ref` is optional and a malformed value is dropped, never a 400", () => {
    const base = { age_band: "31-71m", mode: "form" };
    expect(CreateSessionSchema.parse({ ...base, ref: SLUG }).ref).toBe(SLUG);
    expect(CreateSessionSchema.parse(base).ref).toBeUndefined();
    expect(CreateSessionSchema.safeParse({ ...base, ref: 42 })).toMatchObject({ success: true, data: { ref: undefined } });
    expect(CreateSessionSchema.safeParse({ ...base, ref: "x".repeat(500) })).toMatchObject({ success: true, data: { ref: undefined } });
  });

  it("startScreen sends the slug only when there is a referral", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchFn = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ session_id: "s1", questions: [] }), { status: 201 });
    }) as typeof fetch;
    await startScreen("31-71m", "form", { fetchFn }, ["speech"], undefined, SLUG);
    await startScreen("31-71m", "form", { fetchFn }, []);
    expect(bodies[0]).toEqual({ age_band: "31-71m", mode: "form", concerns: ["speech"], ref: SLUG });
    expect(bodies[1]).not.toHaveProperty("ref");
  });
});

describe("/screen?ref=<slug> (FR-2)", () => {
  const page = (ref?: string | string[]) => () => ScreenPage({ searchParams: Promise.resolve(ref === undefined ? {} : { ref }) });

  it("a verified + listed profile shows the calm 'Referred by' note with the provider type", async () => {
    const text = await html(page(SLUG));
    expect(pub.getPublicProfile).toHaveBeenCalledWith(SLUG);
    expect(text).toContain('data-testid="screen-referral"');
    expect(text).toContain("Referred by Dr Asha Rao (synthetic)");
    expect(text).toContain("Paediatrician");
    // The rest of the check-in is unchanged: free tap start first.
    expect(text).toContain("Start free check-in");
  });

  it("Telugu and Hindi pages translate the note", async () => {
    m.locale = "te";
    expect(await html(page(SLUG))).toContain("Dr Asha Rao (synthetic) సిఫార్సు చేశారు");
    m.locale = "hi";
    expect(await html(page(SLUG))).toContain("Dr Asha Rao (synthetic) द्वारा रेफ़र किया गया");
  });

  it.each([["dr-unlisted-99"], ["Dr Asha!"], [""]])("ref %j: no note, no error, the check-in renders", async (ref) => {
    const text = await html(page(ref));
    expect(text).not.toContain("screen-referral");
    expect(text).not.toContain("Referred by");
    expect(text).toContain("Start free check-in");
  });

  it("without ref nothing is looked up", async () => {
    const text = await html(page());
    expect(pub.getPublicProfile).not.toHaveBeenCalled();
    expect(text).not.toContain("Referred by");
  });

  it("the voice sign-in link keeps the referral", () => {
    const markup = renderToStaticMarkup(
      withI18n(
        createElement(ScreenFlow, {
          viewer: { kind: "anonymous" },
          localities: [],
          voiceAvailable: true,
          referral: { slug: SLUG, name: "Dr Asha Rao (synthetic)", typeLabel: "Paediatrician" },
        }),
      ),
    );
    expect(decode(markup)).toContain(`/family/login?next=${encodeURIComponent(`/screen?ref=${SLUG}&voice=1`)}`);
  });
});

describe("/dashboard/profile/poster (FR-4)", () => {
  const profile = (over: Record<string, unknown> = {}) => ({
    id: ASHA.id,
    slug: SLUG,
    display_name: ASHA.display_name,
    provider_type: "pediatrician",
    verification_status: "verified",
    listed: true,
    is_synthetic: false,
    ...over,
  });

  beforeEach(() => {
    m.user = { id: "22222222-2222-4222-8222-222222222222", email: "asha@example.test" };
  });

  it("verified + listed: A4 poster in English, Telugu and Hindi with the QR code, link, referrer, footer and the 30-day count", async () => {
    m.profile = profile();
    m.count = 7;
    const text = await html(ReferralPosterPage);
    expect(pub.loadPublicProfile).toHaveBeenCalledWith(SLUG, true);
    expect(text).toContain('class="poster-sheet');
    expect(text).toContain("Worried about your child's speech, play or development?");
    expect(text).toContain("Take a free 5-minute check-in");
    expect(text).toContain("మీ పిల్లల మాటలు, ఆటలు లేదా ఎదుగుదల గురించి ఆందోళనగా ఉందా?");
    expect(text).toContain("क्या आप अपने बच्चे की बोली, खेल या विकास को लेकर चिंतित हैं?");
    expect(text).toMatch(/<div role="img" aria-label="QR code: opens the free check-in on DoctorNearMe"[^>]*><svg /);
    expect(text).toContain(`doctornearme.example/screen?ref=${SLUG}`);
    expect(text).toContain("Referred by Dr Asha Rao (synthetic)");
    expect(text).toContain("Free · no sign-in needed · Not a diagnosis · In an emergency call 108 or 112");
    expect(text).toContain("Check-ins started from your poster in the last 30 days: 7");
    expect(text).toContain("Print poster");
  });

  it.each([
    ["pending verification", { verification_status: "pending" }],
    ["unlisted", { listed: false }],
  ])("%s: no poster, an explanation instead", async (_label, over) => {
    m.profile = profile(over);
    pub.loadPublicProfile.mockResolvedValue(null);
    const text = await html(ReferralPosterPage);
    expect(text).toContain("The waiting-room poster is available once your profile is verified and listed in the directory.");
    expect(text).not.toContain("poster-sheet");
    expect(text).not.toContain("<svg");
  });

  it("no provider profile: the explanation, no lookup", async () => {
    m.profile = null;
    const text = await html(ReferralPosterPage);
    expect(text).toContain('data-testid="poster-unavailable"');
    expect(pub.loadPublicProfile).not.toHaveBeenCalled();
  });
});
