// Ticket 050: parent-first home page at `/`, the therapist / centre landing at `/for-centres`, Indian statistics.
import type { ReactElement } from "react";
import { prerender } from "react-dom/static";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "@/messages/en.json";
import hi from "@/messages/hi.json";
import te from "@/messages/te.json";
import { flattenMessages } from "@/lib/i18n/review";
import { withI18n } from "./helpers/i18n";

const m = vi.hoisted(() => ({ locale: "en" as "en" | "hi" | "te" }));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "dnm_locale" ? { name, value: m.locale } : undefined),
    getAll: () => [{ name: "dnm_locale", value: m.locale }],
  }),
  headers: async () => new Headers(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
  usePathname: () => "/",
}));
// next/font and next/image static imports need the Next.js compiler; they are presentation only.
vi.mock("@/components/landing/fonts", () => ({ fontVars: "" }));
vi.mock("next/image", async () => {
  const { createElement } = await import("react");
  return { default: ({ alt }: { alt: string }) => createElement("img", { alt }) };
});
vi.mock("@elevenlabs/react", () => ({
  ConversationProvider: ({ children }: { children: unknown }) => children,
  useConversation: () => ({ status: "disconnected", isSpeaking: false, startSession: vi.fn(), endSession: vi.fn() }),
}));
vi.mock("@/lib/auth", () => ({ getAuthenticatedUser: vi.fn(async () => null), getUserRole: vi.fn() }));

import { INDIAN_STAT_SOURCES } from "@/components/landing/IndianStats";
import ParentHome, { generateMetadata as parentMetadata } from "@/app/page";
import ForCentres, { generateMetadata as centresMetadata } from "@/app/for-centres/page";

async function html(page: () => Promise<ReactElement>): Promise<string> {
  const { prelude } = await prerender(withI18n(await page(), m.locale));
  return new Response(prelude).text();
}

const hrefs = (markup: string) => [...markup.matchAll(/<a [^>]*href="([^"]+)"/g)].map((x) => x[1].replaceAll("&amp;", "&"));
const decode = (s: string) => s.replaceAll("&#x27;", "'").replaceAll("&amp;", "&").replaceAll("&quot;", '"');

beforeEach(() => {
  m.locale = "en";
  vi.stubEnv("ELEVENLABS_AGENT_ID", "");
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://doctornearme.example");
});
afterEach(() => vi.unstubAllEnvs());

describe("/ (parents)", () => {
  it("renders the parent hero with the check-in, find and clinic-code links", async () => {
    const markup = await html(ParentHome);
    const text = decode(markup);
    expect(text).toContain("Worried about your child's speech, play or development?");
    const links = hrefs(markup);
    expect(links).toContain("/screen");
    expect(links).toContain("/find");
    expect(links).toContain("/family/children/claim");
    expect(links).toContain("/for-centres");
    // FR-6 / 051: the free tap check-in is the main action; voice needs a sign-in that returns to /screen?voice=1.
    const hero = markup.slice(markup.indexOf('id="parent-hero-title"'));
    expect(hero.indexOf('href="/screen"')).toBeGreaterThan(0);
    expect(hero.indexOf('href="/screen"')).toBeLessThan(hero.indexOf('href="/find"'));
    expect(links).toContain("/family/login?next=%2Fscreen%3Fvoice%3D1");
    expect(text).toContain("Prefer to talk? Sign in to use voice (free)");
    // The parents' page is not the therapist pitch.
    expect(text).not.toContain("For early intervention therapists");
    // Only the footer's "For centres" column links to the demo booking.
    expect(hrefs(markup.slice(0, markup.indexOf("<footer")))).not.toContain("/book-demo");
  });

  it("has the How it works strip, the trust row and the Indian statistics with their sources", async () => {
    const text = decode(await html(ParentHome));
    for (const step of ["Check-in", "Find", "Visit", "Practise at home"]) expect(text).toContain(`>${step}</h3>`);
    for (const trust of ["Verified providers", "No ads or tracking on child pages", "Your data stays yours"]) expect(text).toContain(trust);
    for (const value of ["1 in 100", "1 in 8", "4.6 years", "~15,000"]) expect(text).toContain(value);
    expect(text).toContain("Sources:");
    for (const url of Object.values(INDIAN_STAT_SOURCES)) expect(text).toContain(`href="${url}"`);
  });

  it("E-1: renders in Telugu", async () => {
    m.locale = "te";
    const text = decode(await html(ParentHome));
    expect(text).toContain(te.landing.parents.title);
    expect(text).toContain(te.landing.parents.checkIn);
    expect(text).toContain(te.landing.parents.find);
    expect(text).toContain(te.landing.stats.sources);
    expect(text).not.toContain(en.landing.parents.title);
  });

  it("FR-4: title for parents in Hyderabad, canonical /", async () => {
    const meta = await parentMetadata();
    expect(meta.title).toBe("DoctorNearMe – child development check-in and therapists near you (Hyderabad)");
    expect(meta.alternates?.canonical).toBe("https://doctornearme.example/");
  });
});

describe("/for-centres (the former landing)", () => {
  it("renders the therapist landing with Book a demo, Indian statistics and the For centres nav item", async () => {
    const markup = await html(ForCentres);
    const text = decode(markup);
    expect(text).toContain(en.landing.hero.badge);
    expect(text).toContain(">Book a demo");
    expect(hrefs(markup)).toContain("/book-demo");
    const current = [...markup.matchAll(/<a [^>]*>/g)].map((x) => x[0]).filter((a) => a.includes('aria-current="page"'));
    expect(current.length).toBeGreaterThan(0);
    for (const a of current) expect(a).toContain('href="/for-centres"');
    for (const url of Object.values(INDIAN_STAT_SOURCES)) expect(text).toContain(`href="${url}"`);
    for (const banned of ["CDC", "Höfer", "German", "Deutsch", "Harstad", "Dawson"]) expect(text).not.toContain(banned);
    // FR-6: signed-out visitors get the recorded sample, never the live tab.
    expect(text).toContain("sample-intake-call.mp3");
  });

  it("keeps its title", async () => {
    const meta = await centresMetadata();
    expect(meta.title).toBe(en.landing.meta.title);
    expect(meta.alternates?.canonical).toBe("https://doctornearme.example/for-centres");
  });

  it("the parents' nav also links to For centres", async () => {
    const markup = await html(ParentHome);
    expect(markup).toMatch(/<a [^>]*href="\/for-centres"/);
    expect(decode(markup)).toContain(">For centres<");
  });
});

describe("landing copy (FR-3)", () => {
  it.each([
    ["en", en],
    ["hi", hi],
    ["te", te],
  ] as const)("%s: no US / German statistics remain in the landing keys", (_locale, catalogue) => {
    const landing = flattenMessages({ landing: catalogue.landing, footer: catalogue.footer, nav: catalogue.nav });
    for (const [key, value] of Object.entries(landing)) {
      expect(value, key).not.toMatch(/CDC|Höfer|German|Deutsch|जर्मन|జర్మన్|Germany|जर्मनी|జర్మనీ|Harstad|Dawson|\bUS\b|अमेरिक|అమెరికా/);
    }
  });
});
