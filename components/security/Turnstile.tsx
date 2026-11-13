"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// Ticket 051 FR-8: Cloudflare Turnstile widget (bot check, not analytics). Rendered only when the server passes a site
// key (TURNSTILE_SITE_KEY + TURNSTILE_SECRET_KEY set); otherwise nothing loads and the token stays null. Allowlisted
// in lib/privacy/third-party-allowlist.ts and lib/csp.ts for /family/login, /screen and /find only. Tokens are
// single-use: callers `reset()` after each request that used one.

const SCRIPT_URL = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

type TurnstileApi = {
  render: (
    el: HTMLElement,
    opts: {
      sitekey: string;
      callback: (token: string) => void;
      "expired-callback": () => void;
      "error-callback": () => void;
      appearance?: "always" | "execute" | "interaction-only";
      language?: string;
    },
  ) => string;
  reset: (id: string) => void;
  remove: (id: string) => void;
};

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let loader: Promise<TurnstileApi> | null = null;

function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  loader ??= new Promise<TurnstileApi>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = SCRIPT_URL;
    script.async = true;
    script.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error("turnstile missing")));
    script.onerror = () => {
      loader = null;
      reject(new Error("turnstile failed to load"));
    };
    document.head.appendChild(script);
  });
  return loader;
}

function TurnstileWidget({ siteKey, onToken, resetKey }: { siteKey: string; onToken: (token: string | null) => void; resetKey: number }) {
  const box = useRef<HTMLDivElement>(null);
  const widgetId = useRef<string | null>(null);
  const tokenCallback = useRef(onToken);
  useEffect(() => {
    tokenCallback.current = onToken;
  }, [onToken]);

  useEffect(() => {
    let cancelled = false;
    void loadTurnstile()
      .then((api) => {
        if (cancelled || !box.current) return;
        widgetId.current = api.render(box.current, {
          sitekey: siteKey,
          appearance: "interaction-only",
          callback: (token) => tokenCallback.current(token),
          "expired-callback": () => tokenCallback.current(null),
          "error-callback": () => tokenCallback.current(null),
        });
      })
      .catch(() => tokenCallback.current(null));
    return () => {
      cancelled = true;
      if (widgetId.current) window.turnstile?.remove(widgetId.current);
      widgetId.current = null;
    };
  }, [siteKey]);

  useEffect(() => {
    if (resetKey === 0 || !widgetId.current) return;
    window.turnstile?.reset(widgetId.current);
  }, [resetKey]);

  return <div ref={box} className="min-h-0" data-testid="turnstile" />;
}

/**
 * `token` is null until the check passes (or always, when the check is off). `ready` is true when a request may be
 * sent: the check is off, or a token is available. Render `widget` near the button that sends the request.
 */
export function useTurnstile(siteKey: string | null | undefined) {
  const [token, setToken] = useState<string | null>(null);
  const [resetKey, setResetKey] = useState(0);
  const reset = useCallback(() => {
    setToken(null);
    setResetKey((k) => k + 1);
  }, []);
  const widget = siteKey ? <TurnstileWidget siteKey={siteKey} onToken={setToken} resetKey={resetKey} /> : null;
  return { token, ready: !siteKey || token !== null, widget, reset };
}
