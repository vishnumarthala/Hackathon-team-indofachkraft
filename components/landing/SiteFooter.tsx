import Link from "next/link";
import { getT } from "@/lib/i18n/server";
import { Logo } from "./ui";

export async function SiteFooter() {
  const t = await getT();
  const cols = [
    {
      title: t("footer.product"),
      links: [
        { href: "/#voice-demo", label: t("nav.intakeCall") },
        { href: "/#how", label: t("nav.howItWorks") },
        { href: "/#features", label: t("footer.features") },
        { href: "/#trust", label: t("footer.trust") },
        { href: "/#faq", label: t("nav.faq") },
      ],
    },
    {
      title: t("footer.getStarted"),
      links: [
        { href: "/book-demo", label: t("nav.bookDemo") },
        { href: "/login", label: t("nav.logIn") },
      ],
    },
  ];

  return (
    <footer className="border-t border-[#0b1f1d]/10 bg-[#f8f6f1]">
      <div className="mx-auto grid w-full max-w-6xl gap-10 px-4 py-14 sm:px-6 md:grid-cols-[1.4fr_1fr_1fr]">
        <div>
          <Logo />
          <p className="mt-4 max-w-xs text-sm leading-relaxed text-slate-600">{t("footer.tagline")}</p>
        </div>
        {cols.map((c) => (
          <div key={c.title}>
            <p className="mb-4 text-sm font-semibold text-[#0b1f1d]">{c.title}</p>
            <ul className="space-y-2.5">
              {c.links.map((l) => (
                <li key={l.href}>
                  <Link href={l.href} className="text-sm text-slate-600 transition-colors hover:text-teal-800">
                    {l.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div className="border-t border-[#0b1f1d]/10">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-2 px-4 py-6 text-xs text-slate-500 sm:flex-row sm:justify-between sm:px-6">
          <p>{t("footer.copyright")}</p>
          <p>{t("footer.builtOn")}</p>
        </div>
      </div>
    </footer>
  );
}
