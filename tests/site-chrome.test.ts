// Site chrome per route: parent-facing pages share the parents' navigation and footer with `/`; link-only pages get
// a minimal header; the clinician app keeps its own bar. The demo banner shows only in DEMO_MODE.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { withI18n } from "./helpers/i18n";

const nav = vi.hoisted(() => ({ pathname: "/screen" }));
vi.mock("next/navigation", () => ({ usePathname: () => nav.pathname, useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

describe("site chrome", () => {
  it("picks the header per route", async () => {
    const { chromeFor } = await import("@/components/SiteChrome");
    for (const p of ["/screen", "/find", "/find/hyderabad/centres", "/p/dr-x", "/c/sunrise", "/book/abc", "/book/abc/pay/x", "/privacy", "/pay/done"]) {
      expect(chromeFor(p), p).toBe("parents");
    }
    expect(chromeFor("/join")).toBe("centres");
    for (const p of ["/intake/tok", "/specialist/tok", "/invite/tok", "/claim/tok"]) expect(chromeFor(p), p).toBe("link");
    for (const p of ["/dashboard", "/cases/1", "/admin/ops", "/notifications"]) expect(chromeFor(p), p).toBe("app");
    for (const p of ["/", "/for-centres", "/book-demo", "/login", "/family", "/family/login"]) expect(chromeFor(p), p).toBe("none");
    // Prefixes do not leak into look-alike routes.
    expect(chromeFor("/screening")).toBe("app");
    expect(chromeFor("/pricing")).toBe("app");
  });

  it("parent pages get the parents' nav and the footer, never the clinician bar; the banner only in demo mode", async () => {
    const { SiteChrome } = await import("@/components/SiteChrome");
    const render = (pathname: string, demo: boolean) => {
      nav.pathname = pathname;
      return renderToStaticMarkup(
        withI18n(createElement(SiteChrome, { demo, footer: createElement("footer", null, "FOOTER"), fontVars: "fv" }, createElement("p", null, "PAGE"))),
      );
    };
    const screen = render("/screen", false);
    expect(screen).toContain("lp-nav");
    expect(screen).toContain('href="/family/login"');
    expect(screen).toContain("FOOTER");
    expect(screen).not.toContain('href="/dashboard"');
    expect(screen).not.toContain('role="note"');
    expect(render("/screen", true)).toContain('role="note"');
    const app = render("/dashboard", false);
    expect(app).toContain('href="/dashboard"');
    expect(app).not.toContain("FOOTER");
    const link = render("/intake/tok", false);
    expect(link).not.toContain('href="/dashboard"');
    expect(link).not.toContain("lp-nav");
  });
});
