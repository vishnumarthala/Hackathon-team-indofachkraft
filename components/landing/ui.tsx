import Link from "next/link";
import type { ReactNode } from "react";

/** CareThread mark: a thread looping through a speech bubble. */
export function Logo({ className = "", light = false }: { className?: string; light?: boolean }) {
  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      <svg viewBox="0 0 32 32" className="h-8 w-8 shrink-0" aria-hidden="true">
        <rect width="32" height="32" rx="9" fill={light ? "#ffffff" : "#0f766e"} />
        <path
          d="M8 19.5c0-5 3.6-9 8.3-9 4.4 0 7.7 3.2 7.7 7.4 0 3.6-2.6 6.1-5.8 6.1-2.9 0-4.9-2-4.9-4.6 0-2.3 1.7-4 3.9-4 1.8 0 3.1 1.2 3.1 2.9"
          fill="none"
          stroke={light ? "#0f766e" : "#ffffff"}
          strokeWidth="2.2"
          strokeLinecap="round"
        />
        <circle cx="24" cy="8.5" r="2.2" fill="#ef6f5e" />
      </svg>
      <span className={`text-[1.15rem] font-semibold tracking-tight ${light ? "text-white" : "text-[color:var(--nav-fg,#0b1f1d)]"}`}>
        CareThread
      </span>
    </span>
  );
}

export function Arrow({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg className={`lp-arrow ${className}`} viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      <path
        fillRule="evenodd"
        d="M3 10a.75.75 0 0 1 .75-.75h10.6l-3.9-3.7a.75.75 0 1 1 1.04-1.08l5.25 5a.75.75 0 0 1 0 1.08l-5.25 5a.75.75 0 1 1-1.04-1.08l3.9-3.7H3.75A.75.75 0 0 1 3 10Z"
        clipRule="evenodd"
      />
    </svg>
  );
}

export function CheckIcon({ className = "h-5 w-5 text-teal-600" }: { className?: string }) {
  return (
    <svg className={`shrink-0 ${className}`} viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      <path
        fillRule="evenodd"
        d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm3.7-9.3a1 1 0 0 0-1.4-1.4L9 10.6 7.7 9.3a1 1 0 0 0-1.4 1.4l2 2a1 1 0 0 0 1.4 0l4-4Z"
        clipRule="evenodd"
      />
    </svg>
  );
}

const base =
  "lp-btn inline-flex min-h-12 items-center justify-center gap-2 rounded-full px-6 py-3 text-[0.95rem] font-semibold focus-visible:outline-none focus-visible:ring-4";

const variants = {
  primary: `${base} bg-[#0b1f1d] text-white shadow-lg shadow-black/10 hover:bg-teal-800 hover:shadow-xl hover:shadow-teal-900/20 focus-visible:ring-teal-600/40`,
  teal: `${base} bg-teal-700 text-white shadow-lg shadow-teal-800/25 hover:bg-teal-800 focus-visible:ring-teal-600/40`,
  ghost: `${base} border border-[#0b1f1d]/15 bg-white/70 text-[#0b1f1d] backdrop-blur hover:border-[#0b1f1d]/40 hover:bg-white focus-visible:ring-teal-600/30`,
  light: `${base} bg-white text-[#0b1f1d] shadow-lg shadow-black/20 hover:bg-teal-50 focus-visible:ring-white/50`,
  outlineLight: `${base} border border-white/30 text-white hover:border-white/70 hover:bg-white/10 focus-visible:ring-white/40`,
} as const;

export function ButtonLink({
  href,
  children,
  variant = "primary",
  className = "",
}: {
  href: string;
  children: ReactNode;
  variant?: keyof typeof variants;
  className?: string;
}) {
  const cls = `${variants[variant]} ${className}`;
  if (href.startsWith("#")) {
    return (
      <a href={href} className={cls}>
        {children}
      </a>
    );
  }
  return (
    <Link href={href} className={cls}>
      {children}
    </Link>
  );
}

const EYEBROW_TONES = { teal: "text-teal-700", light: "text-teal-300", lighter: "text-teal-200" } as const;

export function Eyebrow({ children, tone = "teal" }: { children: ReactNode; tone?: keyof typeof EYEBROW_TONES }) {
  return (
    <p className={`mb-4 text-xs font-semibold uppercase tracking-[0.18em] ${EYEBROW_TONES[tone]}`}>{children}</p>
  );
}

export function Wave({ color = "#ef6f5e" }: { color?: string }) {
  return (
    <span className="lp-wave flex h-5 items-center gap-[3px]" style={{ color }} aria-hidden="true">
      {[0, 150, 300, 450, 600].map((d) => (
        <span key={d} style={{ animationDelay: `${d}ms` }} />
      ))}
    </span>
  );
}
