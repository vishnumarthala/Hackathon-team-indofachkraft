// Ticket 019 FR-3/FR-4/NFR-2: role-aware routing (redirect matrix through proxy.ts), safe `next`, and the
// family CSP. Supabase is mocked: the proxy only sees a session user and that user's profile role.
import { NextRequest } from "next/server";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  homeForRole,
  isProtectedPath,
  isPublicApiPath,
  pageRedirect,
  postSignInPath,
  safeRelativePath,
  type AppRole,
} from "@/lib/auth-access";
import { familyCsp } from "@/lib/csp";

const auth = vi.hoisted(() => ({ role: null as null | "guardian" | "provider" | "platform_admin" }));
vi.mock("@supabase/ssr", () => ({
  createServerClient: () => {
    const query = {
      select: () => query,
      eq: () => query,
      maybeSingle: async () => ({ data: auth.role ? { role: auth.role } : null, error: null }),
    };
    return {
      auth: {
        getUser: async () =>
          auth.role
            ? { data: { user: { id: "00000000-0000-4000-8000-0000000000aa" } }, error: null }
            : { data: { user: null }, error: { name: "AuthSessionMissingError", status: 400, message: "no session" } },
      },
      from: () => query,
    };
  },
}));

let proxy: typeof import("@/proxy").proxy;

beforeAll(async () => {
  process.env.NEXT_PUBLIC_SUPABASE_URL ??= "http://127.0.0.1:54321";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "anon-key";
  proxy = (await import("@/proxy")).proxy;
});

beforeEach(() => {
  auth.role = null;
});

async function visit(path: string, role: AppRole | null) {
  auth.role = role;
  const res = await proxy(new NextRequest(`http://localhost:3000${path}`));
  const location = res.headers.get("location");
  return { status: res.status, location: location ? location.replace("http://localhost:3000", "") : null, res };
}

const CASE = "/cases/00000000-0000-4000-8000-000000000001";

describe("redirect matrix (FR-3, FR-4)", () => {
  const cases: Array<[AppRole | null, string, string | null]> = [
    // anonymous
    [null, "/family", "/family/login?next=%2Ffamily"],
    [null, "/family/settings?tab=1", "/family/login?next=%2Ffamily%2Fsettings%3Ftab%3D1"],
    [null, "/family/login", null],
    [null, CASE, `/login?next=${encodeURIComponent(CASE)}`],
    [null, "/dashboard", "/login?next=%2Fdashboard"],
    [null, "/admin", "/login?next=%2Fadmin"],
    // guardian
    ["guardian", "/family", null],
    ["guardian", "/family/settings", null],
    ["guardian", "/family/login", "/family"],
    ["guardian", CASE, "/family"],
    ["guardian", "/dashboard", "/family"],
    ["guardian", "/dashboard/team", "/family"],
    ["guardian", "/admin", "/family"],
    ["guardian", "/admin/users", "/family"],
    // provider
    ["provider", "/family", "/dashboard"],
    ["provider", "/family/children", "/dashboard"],
    ["provider", "/family/login", "/dashboard"],
    ["provider", CASE, null],
    ["provider", "/dashboard", null],
    ["provider", "/admin", null],
    // platform admin
    ["platform_admin", "/family", "/admin"],
    ["platform_admin", "/family/login", "/admin"],
    ["platform_admin", CASE, null],
    ["platform_admin", "/dashboard", null],
    ["platform_admin", "/admin", null],
  ];

  it.each(cases)("%s visiting %s -> %s", async (role, path, expected) => {
    const { status, location } = await visit(path, role);
    if (expected === null) {
      expect(location, `${role} ${path}`).toBeNull();
      expect(status).toBe(200);
    } else {
      expect(status).toBe(307);
      expect(location).toBe(expected);
    }
    const [pathname, search = ""] = path.split("?");
    expect(pageRedirect(pathname, search ? `?${search}` : "", role)).toBe(expected);
  });

  it("protected APIs answer 401 JSON instead of redirecting; public phone sign-in routes stay open", async () => {
    const { status, res } = await visit("/api/family/profile", null);
    expect(status).toBe(401);
    expect(await res.json()).toEqual({ error: "Authentication required" });
    expect(isPublicApiPath("/api/auth/phone/send")).toBe(true);
    expect(isPublicApiPath("/api/auth/phone/verify")).toBe(true);
    expect(isProtectedPath("/api/family/profile")).toBe(true);
    expect(isProtectedPath("/family")).toBe(true);
    expect(isProtectedPath("/family/login")).toBe(false);
    expect(isProtectedPath("/familyx")).toBe(false);
  });

  it("homes per role", () => {
    expect(homeForRole("guardian")).toBe("/family");
    expect(homeForRole("provider")).toBe("/dashboard");
    expect(homeForRole("platform_admin")).toBe("/admin");
  });
});

describe("safe `next` (FR-3)", () => {
  it.each(["//evil.com", "https://evil.com", "/\\evil", "/\\/evil.com", "http:/evil.com", "javascript:alert(1)", "evil", "", "/\nevil"])(
    "rejects %j",
    (value) => {
      expect(safeRelativePath(value)).toBeNull();
      expect(postSignInPath("guardian", value)).toBe("/family");
      expect(postSignInPath("provider", value)).toBe("/dashboard");
    },
  );

  it("keeps same-origin paths inside the user's own area", () => {
    expect(postSignInPath("guardian", "/family/settings?x=1")).toBe("/family/settings?x=1");
    expect(postSignInPath("guardian", "/dashboard")).toBe("/family");
    expect(postSignInPath("guardian", "/family/login")).toBe("/family");
    expect(postSignInPath("provider", "/family")).toBe("/dashboard");
    expect(postSignInPath("provider", "/invite/abc")).toBe("/invite/abc");
    expect(postSignInPath("platform_admin", null)).toBe("/admin");
  });
});

describe("family CSP (NFR-2)", () => {
  it("family pages get script-src 'self' with a per-request nonce; other pages get no CSP from this ticket", async () => {
    const first = (await visit("/family/login", null)).res.headers.get("content-security-policy");
    const second = (await visit("/family/login", null)).res.headers.get("content-security-policy");
    expect(first).toContain("script-src 'self' 'nonce-");
    expect(first).toContain("frame-ancestors 'none'");
    expect(first).toContain("object-src 'none'");
    expect(first).not.toBe(second);
    expect((await visit("/family", "guardian")).res.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect((await visit("/", null)).res.headers.get("content-security-policy")).toBeNull();
  });

  it("allows no third-party script origins and only Supabase for connections", () => {
    const csp = familyCsp({ pathname: "/family", nonce: "abc", supabaseUrl: "https://x.supabase.co/", isDev: false });
    const script = csp.split("; ").find((d) => d.startsWith("script-src"))!;
    expect(script).toBe("script-src 'self' 'nonce-abc' 'strict-dynamic'");
    expect(csp).toContain("connect-src 'self' https://x.supabase.co");
    expect(csp).not.toMatch(/googletagmanager|google-analytics|facebook|doubleclick/);
  });
});
