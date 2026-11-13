// Building blocks for notification templates (FR-3). Templates are pure: payload + locale + role in, text out.
// Content rule (D-5, DPDP minimisation): email/WhatsApp never carry clinical content or a child's name; the
// default wording is "your child". Links always point to the signed-in app page.
import type { Locale } from "@/lib/i18n/config";
import type { IcsInvite, Rendered, Template, TemplateContext } from "../types";

export type TemplateStrings = { title: string; body: string };

/** Shared email wording per locale (hi/te are drafts awaiting native review, see docs/notifications.md). */
export const COMMON: Record<Locale, { open: string; footer: string }> = {
  en: {
    open: "Open DoctorNearMe",
    footer: "You get this message because you have a DoctorNearMe account. Change email and WhatsApp alerts in Settings.",
  },
  hi: {
    open: "DoctorNearMe खोलें",
    footer: "आपको यह संदेश इसलिए मिला क्योंकि आपका DoctorNearMe खाता है। ईमेल और WhatsApp सूचनाएँ सेटिंग्स में बदलें।",
  },
  te: {
    open: "DoctorNearMe తెరవండి",
    footer: "మీకు DoctorNearMe ఖాతా ఉన్నందున ఈ సందేశం వచ్చింది. ఇమెయిల్, WhatsApp హెచ్చరికలను సెట్టింగ్స్‌లో మార్చండి.",
  },
};

/** Meta WhatsApp template language codes for our UI locales. */
export const WHATSAPP_LANGUAGE: Record<Locale, string> = { en: "en", hi: "hi", te: "te" };

export function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
  );
}

export function absoluteUrl(appUrl: string, link: string): string {
  return `${appUrl.replace(/\/+$/, "")}${link}`;
}

/** Recipient-specific app page: guardians land in the family portal, providers in their workspace. */
export function roleLink<P>(ctx: TemplateContext<P>, family: string, provider: string): string {
  return ctx.role === "guardian" ? family : provider;
}

/** A uuid-like payload value or null (payloads are validated at enqueue; templates still read defensively). */
export function idOf(payload: unknown, key: string): string | null {
  const value = (payload as Record<string, unknown> | null)?.[key];
  return typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value) ? value : null;
}

type Definition<P> = {
  name: string;
  strings: Record<Locale, TemplateStrings>;
  link(ctx: TemplateContext<P>): string;
  ics?(ctx: TemplateContext<P>): IcsInvite | undefined;
  /** false = in-app and email only (no approved WhatsApp template). */
  whatsapp?: boolean;
};

export function defineTemplate<P = Record<string, unknown>>(def: Definition<P>): Template<P> {
  return {
    name: def.name,
    render(ctx) {
      const { title, body } = def.strings[ctx.locale] ?? def.strings.en;
      const common = COMMON[ctx.locale] ?? COMMON.en;
      const link = def.link(ctx);
      const url = absoluteUrl(ctx.appUrl, link);
      const ics = def.ics?.(ctx);
      const rendered: Rendered = {
        title,
        body,
        link,
        email: {
          subject: title,
          text: `${body}\n\n${common.open}: ${url}\n\n--\n${common.footer}\n`,
          html:
            `<p>${escapeHtml(body)}</p>` +
            `<p><a href="${escapeHtml(url)}">${escapeHtml(common.open)}</a></p>` +
            `<hr><p style="color:#64748b;font-size:12px">${escapeHtml(common.footer)}</p>`,
          ...(ics ? { ics } : {}),
        },
      };
      if (def.whatsapp !== false) {
        rendered.whatsapp = { name: def.name, language: WHATSAPP_LANGUAGE[ctx.locale], params: [url] };
      }
      return rendered;
    },
  };
}
