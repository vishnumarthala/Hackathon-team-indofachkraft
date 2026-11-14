// Ticket 053 FR-1: components/ui primitives render the Figma variants, the 44 px target, the focus ring and the
// disabled/loading states (aria-disabled / aria-busy); the link variant renders <a>.
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Alert, Badge, Button, buttonClasses, Card, EmptyState, Select, TextField } from "@/components/ui";

const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);
const classOf = (markup: string) => (markup.match(/class="([^"]*)"/)?.[1] ?? "").split(" ");

describe("Button", () => {
  it("primary is teal with the 44 px target and the teal focus ring", () => {
    const out = html(h(Button, null, "Book"));
    expect(out.startsWith("<button")).toBe(true);
    expect(out).toContain('type="button"');
    const cls = classOf(out);
    for (const c of ["bg-teal-700", "hover:bg-teal-800", "text-white", "min-h-11", "focus-visible:ring-2", "focus-visible:ring-teal-600", "focus-visible:ring-offset-2"]) {
      expect(cls).toContain(c);
    }
    expect(cls).not.toContain("bg-slate-900");
  });

  it.each([
    ["secondary", ["border-slate-300", "bg-white", "text-slate-800"]],
    ["ghost", ["text-teal-700", "hover:bg-teal-50"]],
    ["danger", ["bg-red-700", "text-white", "hover:bg-red-800"]],
  ] as const)("%s variant classes", (variant, expected) => {
    const cls = classOf(html(h(Button, { variant }, "x")));
    for (const c of expected) expect(cls).toContain(c);
    expect(cls).not.toContain("bg-teal-700");
  });

  it("sizes keep the 44 px minimum; lg is 48 px", () => {
    expect(classOf(html(h(Button, { size: "sm" }, "x")))).toEqual(expect.arrayContaining(["min-h-11", "px-3", "py-1"]));
    expect(classOf(html(h(Button, { size: "md" }, "x")))).toEqual(expect.arrayContaining(["min-h-11", "px-4", "py-2"]));
    expect(classOf(html(h(Button, { size: "lg" }, "x")))).toEqual(expect.arrayContaining(["min-h-12", "text-base"]));
  });

  it("keeps type=submit, forwards props and appends layout classes", () => {
    const out = html(h(Button, { type: "submit", name: "go", className: "w-full", "aria-describedby": "hint" }, "Save"));
    expect(out).toContain('type="submit"');
    expect(out).toContain('name="go"');
    expect(out).toContain('aria-describedby="hint"');
    expect(classOf(out)).toContain("w-full");
  });

  it("disabled sets disabled + aria-disabled and an AA-contrast disabled style", () => {
    const out = html(h(Button, { disabled: true }, "Save"));
    expect(out).toContain('disabled=""');
    expect(out).toContain('aria-disabled="true"');
    expect(out).not.toContain(" aria-busy=");
    expect(classOf(out)).toEqual(expect.arrayContaining(["disabled:bg-slate-200", "disabled:text-slate-600"]));
  });

  it("loading sets aria-busy, aria-disabled and disabled, and shows a spinner", () => {
    const out = html(h(Button, { loading: true }, "Saving"));
    expect(out).toContain('aria-busy="true"');
    expect(out).toContain('aria-disabled="true"');
    expect(out).toContain('disabled=""');
    expect(out).toContain("animate-spin");
    expect(out).toContain("Saving");
  });

  it("an enabled button has no aria-disabled/aria-busy", () => {
    const out = html(h(Button, null, "Go"));
    expect(out).not.toContain(" aria-disabled=");
    expect(out).not.toContain(" aria-busy=");
  });

  it("href renders an <a> link with the button classes", () => {
    const out = html(h(Button, { href: "/find" }, "Find"));
    expect(out).toMatch(/^<a [^>]*href="\/find"/);
    expect(classOf(out)).toContain("bg-teal-700");
  });

  it("a disabled link renders <a> without href and with aria-disabled", () => {
    const out = html(h(Button, { href: "/find", disabled: true }, "Find"));
    expect(out.startsWith("<a")).toBe(true);
    expect(out).not.toContain("href=");
    expect(out).toContain('aria-disabled="true"');
  });

  it("asChild merges the classes onto the child element", () => {
    const out = html(h(Button, { asChild: true, variant: "secondary" }, h("a", { href: "/x.pdf", download: true, className: "shrink-0" }, "PDF")));
    expect(out).toMatch(/^<a [^>]*href="\/x.pdf"/);
    expect(out).toContain('download=""');
    expect(classOf(out)).toEqual(expect.arrayContaining(["border-slate-300", "shrink-0", "min-h-11"]));
  });

  it("the icon is decorative", () => {
    const out = html(h(Button, { icon: h("svg", { "data-icon": "plus" }) }, "Add"));
    expect(out).toContain('<span aria-hidden="true" class="inline-flex shrink-0"><svg data-icon="plus"></svg></span>Add');
  });

  it("buttonClasses matches the component", () => {
    expect(classOf(html(h(Button, { variant: "danger", size: "sm" }, "x")))).toEqual(buttonClasses({ variant: "danger", size: "sm" }).split(" "));
  });
});

describe("Badge, Alert, Card, EmptyState, TextField, Select", () => {
  it.each([
    ["neutral", "bg-slate-100", "text-slate-700"],
    ["brand", "bg-teal-50", "text-teal-800"],
    ["success", "bg-emerald-50", "text-emerald-800"],
    ["warning", "bg-amber-50", "text-amber-900"],
    ["danger", "bg-red-50", "text-red-700"],
    ["info", "bg-sky-50", "text-sky-900"],
  ] as const)("Badge %s", (tone, bg, text) => {
    const out = html(h(Badge, { tone }, "Booked"));
    expect(out.startsWith("<span")).toBe(true);
    expect(classOf(out)).toEqual(expect.arrayContaining([bg, text, "rounded-full", "text-xs"]));
  });

  it.each([
    ["info", "border-sky-200", "bg-sky-50", "text-sky-900"],
    ["success", "border-emerald-200", "bg-emerald-50", "text-emerald-800"],
    ["warning", "border-amber-200", "bg-amber-50", "text-amber-900"],
    ["danger", "border-red-200", "bg-red-50", "text-red-700"],
  ] as const)("Alert %s", (tone, border, bg, text) => {
    const out = html(h(Alert, { tone, role: "status", title: "Heads up" }, "Body"));
    expect(classOf(out)).toEqual(expect.arrayContaining([border, bg, text]));
    expect(out).toContain('role="status"');
    expect(out).toContain("<strong");
  });

  it("Alert has no live-region role unless asked and can render as <p>", () => {
    const out = html(h(Alert, { as: "p" }, "Note"));
    expect(out.startsWith("<p")).toBe(true);
    expect(out).not.toContain("role=");
  });

  it("Card renders the surface on the chosen element", () => {
    const out = html(h(Card, { as: "section", "aria-labelledby": "t" }, "x"));
    expect(out.startsWith("<section")).toBe(true);
    expect(classOf(out)).toEqual(expect.arrayContaining(["rounded-lg", "border-slate-200", "bg-white"]));
  });

  it("EmptyState shows title, description and action", () => {
    const out = html(h(EmptyState, { title: "No visits yet", description: "Book one", action: h(Button, { href: "/find" }, "Find") }));
    expect(out).toContain("No visits yet");
    expect(out).toContain("Book one");
    expect(out).toContain('href="/find"');
  });

  it("TextField labels the input and wires hint and error", () => {
    const out = html(h(TextField, { id: "pin", label: "PIN code", hint: "6 digits", error: "Enter 6 digits", name: "pin" }));
    expect(out).toContain('<label for="pin"');
    expect(out).toContain('aria-invalid="true"');
    expect(out).toContain('aria-describedby="pin-hint pin-error"');
    expect(classOf(out.slice(out.indexOf("<input")))).toEqual(expect.arrayContaining(["min-h-11", "focus-visible:ring-teal-600"]));
  });

  it("Select labels the native select", () => {
    const out = html(h(Select, { label: "Language", name: "lang" }, h("option", { value: "te" }, "Telugu")));
    const id = out.match(/<label for="([^"]+)"/)?.[1];
    expect(id).toBeTruthy();
    expect(out).toContain(`<select id="${id}"`);
    expect(out).not.toContain(" aria-invalid=");
  });
});
