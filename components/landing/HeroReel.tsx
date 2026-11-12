"use client";

import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useT } from "@/lib/i18n/client";
import type { TFunction } from "@/lib/i18n/keys";
import { Arrow, ButtonLink, Wave } from "./ui";

const SCENE_MS = 6000;

const reducedMotion = () =>
  typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function Card({ children }: { children: ReactNode }) {
  return (
    <div className="w-full max-w-[360px] rounded-2xl border border-white/15 bg-white/95 p-4 text-[#0b1f1d] shadow-2xl shadow-black/40 backdrop-blur">
      {children}
    </div>
  );
}

type Scene = { video: string; poster: string; label: string; caption: string; card: ReactNode };

const SCENE_COUNT = 4;

function buildScenes(t: TFunction<"landing.reel">): Scene[] {
  return [
  {
    video: "/landing/reel-1.mp4",
    poster: "/landing/reel-1.jpg",
    label: t("intakeLabel"),
    caption: t("intakeCaption"),
    card: (
      <Card>
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-full bg-[#ef6f5e]/10">
            <Wave />
          </span>
          <div className="leading-tight">
            <p className="text-sm font-semibold">{t("intakeCardTitle")}</p>
            <p className="text-xs text-slate-500">{t("intakeCardMeta", { time: "06:12" })}</p>
          </div>
        </div>
        <p className="mt-3 rounded-xl bg-[#f8f6f1] px-3 py-2 text-[0.82rem] italic text-slate-600">
          &ldquo;{t("intakeCardQuote")}&rdquo;
        </p>
      </Card>
    ),
  },
  {
    video: "/landing/reel-2.mp4",
    poster: "/landing/reel-2.jpg",
    label: t("sessionLabel"),
    caption: t("sessionCaption"),
    card: (
      <Card>
        <div className="mb-2.5 flex items-center justify-between">
          <p className="text-[0.7rem] font-semibold uppercase tracking-wider text-teal-700">{t("sessionCardTitle")}</p>
          <span className="flex items-center gap-1.5 text-xs font-semibold text-[#ef6f5e]">
            <span className="lp-pulse h-2 w-2 rounded-full bg-[#ef6f5e]" />
            {t("sessionCardStatus")}
          </span>
        </div>
        <ul className="space-y-1.5 text-[0.82rem] text-slate-600">
          <li>
            <span className="font-mono text-xs text-slate-400">00:42</span> {t("sessionNote1")}
          </li>
          <li>
            <span className="font-mono text-xs text-slate-400">01:18</span> {t("sessionNote2")}
          </li>
          <li className="lp-caret">
            <span className="font-mono text-xs text-slate-400">02:05</span> {t("sessionNote3")}
          </li>
        </ul>
      </Card>
    ),
  },
  {
    video: "/landing/reel-3.mp4",
    poster: "/landing/reel-3.jpg",
    label: t("reviewLabel"),
    caption: t("reviewCaption"),
    card: (
      <Card>
        <div className="mb-1.5 flex items-center justify-between">
          <p className="text-[0.7rem] font-semibold uppercase tracking-wider text-teal-700">{t("reviewCardTitle")}</p>
          <span className="rounded-full bg-slate-100 px-2 py-0.5 font-mono text-[0.7rem] text-slate-600">▶ 00:42</span>
        </div>
        {/* ISAA item text: not translated (clinical instrument item). */}
        <p lang="en" className="font-semibold">Has poor eye contact</p>
        <p className="mt-1 border-l-2 border-teal-200 pl-2.5 text-sm italic text-slate-600">
          &ldquo;{t("reviewCardQuote")}&rdquo;
        </p>
        <div className="mt-3 flex items-center justify-between">
          <div className="flex gap-1">
            {[1, 2, 3, 4, 5].map((n) => (
              <span key={n} className={`flex h-6 w-6 items-center justify-center rounded-md text-xs font-semibold ${n === 4 ? "bg-teal-700 text-white" : "bg-slate-100 text-slate-500"}`}>
                {n}
              </span>
            ))}
          </div>
          <div className="relative h-8 w-[112px]">
            <span className="lp-swap-a lp-tap absolute inset-0 flex items-center justify-center rounded-full bg-teal-700 text-xs font-semibold text-white">
              {t("confirm")}
            </span>
            <span className="lp-swap-b absolute inset-0 flex items-center justify-center rounded-full bg-teal-50 text-xs font-semibold text-teal-800 ring-1 ring-teal-200">
              {t("reviewConfirmed")}
            </span>
          </div>
        </div>
      </Card>
    ),
  },
  {
    video: "/landing/reel-4.mp4",
    poster: "/landing/reel-4.jpg",
    label: t("handoffLabel"),
    caption: t("handoffCaption"),
    card: (
      <Card>
        <p className="mb-2.5 text-[0.7rem] font-semibold uppercase tracking-wider text-teal-700">{t("handoffCardTitle")}</p>
        <ul className="grid grid-cols-2 gap-1.5 text-[0.8rem] text-slate-700">
          {[t("packetIntake"), t("packetIsaa"), t("packetReport"), t("packetVoiceNote")].map((x) => (
            <li key={x} className="flex items-center gap-1.5">
              <span className="text-teal-600">✓</span>
              {x}
            </li>
          ))}
        </ul>
        <div className="mt-3 flex h-9 items-center justify-center rounded-full bg-[#0b1f1d] text-xs font-semibold text-white">
          {t("sendToSpecialist")}
        </div>
      </Card>
    ),
  },
  ];
}

/** Full-screen hero film: four scenes crossfade, each with its caption and a matching product card. */
export function HeroReel({ subtitle }: { subtitle: string }) {
  const t = useT("landing.hero");
  const tReel = useT("landing.reel");
  const SCENES = useMemo(() => buildScenes(tReel), [tReel]);
  const [active, setActive] = useState(0);
  const sectionRef = useRef<HTMLElement | null>(null);
  const bgRef = useRef<HTMLDivElement | null>(null);
  const fgRef = useRef<HTMLDivElement | null>(null);
  const videos = useRef<(HTMLVideoElement | null)[]>([]);

  // Advance scenes (stays on scene 1 under reduced motion).
  useEffect(() => {
    const id = window.setTimeout(() => {
      if (!reducedMotion()) setActive((a) => (a + 1) % SCENE_COUNT);
    }, SCENE_MS);
    return () => window.clearTimeout(id);
  }, [active]);

  // Play only the active clip.
  useEffect(() => {
    videos.current.forEach((v, i) => {
      if (!v) return;
      if (i === active && !reducedMotion()) {
        v.currentTime = 0;
        v.play().catch(() => {});
      } else if (i !== active) {
        window.setTimeout(() => v.pause(), 1200);
      }
    });
  }, [active]);

  // Parallax: the film drifts slower than the page and the copy fades out.
  useEffect(() => {
    if (reducedMotion()) return;
    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const h = sectionRef.current?.offsetHeight ?? 1;
        const p = Math.min(1, Math.max(0, window.scrollY / h));
        if (bgRef.current) bgRef.current.style.transform = `translate3d(0, ${p * 30}%, 0) scale(${1 + p * 0.05})`;
        if (fgRef.current) {
          fgRef.current.style.transform = `translate3d(0, ${p * 12}%, 0)`;
          fgRef.current.style.opacity = String(1 - Math.min(1, p * 1.4));
        }
      });
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", onScroll);
    };
  }, []);

  const scene = SCENES[active];

  return (
    <section ref={sectionRef} className="relative h-[100svh] min-h-[680px] overflow-hidden bg-[#0b1f1d] text-white">
      <div ref={bgRef} className="absolute inset-0 will-change-transform" aria-hidden="true">
        {SCENES.map((s, i) => (
          <video
            key={s.video}
            ref={(el) => {
              videos.current[i] = el;
            }}
            src={s.video}
            poster={s.poster}
            muted
            loop
            playsInline
            preload={i === 0 ? "auto" : "metadata"}
            tabIndex={-1}
            className={`absolute inset-0 h-full w-full object-cover transition-[opacity,transform] duration-[1400ms] ease-out ${
              i === active ? "scale-100 opacity-100" : "scale-[1.04] opacity-0"
            }`}
          />
        ))}
        <div className="absolute inset-0 bg-gradient-to-t from-[#0b1f1d] via-[#0b1f1d]/35 to-[#0b1f1d]/55" />
        <div className="absolute inset-0 bg-gradient-to-r from-[#0b1f1d]/85 via-[#0b1f1d]/35 to-transparent" />
      </div>

      <div ref={fgRef} className="relative mx-auto flex h-full w-full max-w-6xl flex-col justify-end px-4 pb-8 pt-28 will-change-transform sm:px-6 sm:pb-10">
        <div className="grid items-end gap-10 lg:grid-cols-[1.35fr_1fr]">
          <div>
            <p className="lp-fade-up mb-6 inline-flex items-center gap-2 rounded-full border border-white/20 bg-white/10 px-3.5 py-1.5 text-[0.82rem] font-medium text-white backdrop-blur" style={{ "--d": "0ms" } as CSSProperties}>
              <span className="h-1.5 w-1.5 rounded-full bg-teal-300" />
              {t("badge")}
            </p>
            <h1 className="lp-fade-up lp-display text-[3.1rem] leading-[1.02] sm:text-7xl lg:text-[5.4rem]" style={{ "--d": "100ms" } as CSSProperties}>
              <span className="sr-only">DoctorNearMe. </span>
              {t("title")} <em className="text-teal-200">{t("titleEm")}</em>
            </h1>
            <p className="lp-fade-up mt-6 max-w-xl text-base leading-relaxed text-white/75 sm:text-lg" style={{ "--d": "220ms" } as CSSProperties}>
              {subtitle}
            </p>
            <div className="lp-fade-up mt-8 flex flex-col gap-3 sm:flex-row" style={{ "--d": "320ms" } as CSSProperties}>
              <ButtonLink href="/book-demo" variant="light" className="w-full sm:w-auto">
                {t("bookDemo")}
                <Arrow />
              </ButtonLink>
              <ButtonLink href="#voice-demo" variant="outlineLight" className="w-full sm:w-auto">
                <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                  <path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3ZM19 11a7 7 0 0 1-14 0M12 18v3" />
                </svg>
                {t("hearCall")}
              </ButtonLink>
            </div>
          </div>

          <div className="hidden justify-end lg:flex" aria-live="polite">
            <div key={active} className="lp-panel-in w-full max-w-[360px]">
              <p className="mb-3 text-sm text-white/80">{scene.caption}</p>
              {scene.card}
            </div>
          </div>
        </div>

        {/* Scene timeline */}
        <div className="mt-10 grid grid-cols-4 gap-3 sm:gap-5">
          {SCENES.map((s, i) => (
            <button
              key={s.label}
              type="button"
              onClick={() => setActive(i)}
              aria-pressed={i === active}
              aria-label={t("showScene", { label: s.label })}
              className="group cursor-pointer text-left focus-visible:outline-none"
            >
              <span className="block h-[3px] overflow-hidden rounded-full bg-white/20 group-focus-visible:ring-2 group-focus-visible:ring-white/60">
                {i === active ? (
                  <span key={`p-${active}`} className="lp-progress block h-full rounded-full bg-white" style={{ "--dur": `${SCENE_MS}ms` } as CSSProperties} />
                ) : (
                  <span className={`block h-full rounded-full ${i < active ? "bg-white/60" : ""}`} />
                )}
              </span>
              <span className={`mt-3 hidden text-xs font-medium transition-colors sm:block ${i === active ? "text-white" : "text-white/50 group-hover:text-white/80"}`}>
                <span className="mr-1.5 font-mono text-white/40">0{i + 1}</span>
                {s.label}
              </span>
            </button>
          ))}
        </div>
        <p className="mt-3 text-sm text-white/80 sm:hidden">
          <span className="font-semibold text-white">{scene.label}.</span> {scene.caption}
        </p>
      </div>
    </section>
  );
}
