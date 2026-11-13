export function isInvalidSessionError(error: { name?: string; status?: number } | null): boolean {
  return (
    error === null ||
    error.name === "AuthSessionMissingError" ||
    error.status === 400 ||
    error.status === 401
  );
}

export function isPublicApiPath(pathname: string): boolean {
  return (
    pathname === "/api/pilot-signups" ||
    pathname === "/api/locale" ||
    pathname === "/api/demo/voice-token" ||
    pathname === "/api/providers/join" ||
    pathname === "/api/public/providers" ||
    // 030: free slots and holds work before sign-in (the hold route allows guardians or an anonymous booking session).
    /^\/api\/public\/providers\/[^/]+\/slots$/.test(pathname) ||
    pathname === "/api/appointments/hold" ||
    pathname === "/api/webhooks/elevenlabs" ||
    // 041 FR-12: public health check (no data).
    pathname === "/api/health" ||
    pathname === "/api/auth/phone/send" ||
    pathname === "/api/auth/phone/verify" ||
    /^\/api\/cases\/[^/]+\/ask$/.test(pathname) ||
    pathname.startsWith("/api/intake/") ||
    // 032: cron workers authenticate with `Authorization: Bearer <CRON_SECRET>` inside the handler.
    pathname.startsWith("/api/cron/") ||
    pathname.startsWith("/api/dev/simulate-intake/")
  );
}

export function isProtectedPath(pathname: string): boolean {
  if (pathname === "/dashboard" || pathname.startsWith("/dashboard/")) return true;
  if (pathname === "/cases" || pathname.startsWith("/cases/")) return true;
  if (pathname === "/admin" || pathname.startsWith("/admin/")) return true;
  if (isFamilyPortalPath(pathname)) return true;
  return pathname.startsWith("/api/") && !isPublicApiPath(pathname);
}

// ---------- 019: guardian portal and role-aware routing (convenience only; authz is in lib/authz.ts) ----------

export type AppRole = "platform_admin" | "provider" | "guardian";

export const FAMILY_LOGIN_PATH = "/family/login";

const ROLE_HOME: Record<AppRole, string> = { guardian: "/family", provider: "/dashboard", platform_admin: "/admin" };

export function homeForRole(role: AppRole): string {
  return ROLE_HOME[role];
}

function underPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

export function isFamilyPath(pathname: string): boolean {
  return underPrefix(pathname, "/family");
}

/** `/family/**` pages that need a session (everything except the sign-in page). */
export function isFamilyPortalPath(pathname: string): boolean {
  return isFamilyPath(pathname) && !underPrefix(pathname, FAMILY_LOGIN_PATH);
}

function isProviderAreaPath(pathname: string): boolean {
  return ["/dashboard", "/cases", "/admin"].some((prefix) => underPrefix(pathname, prefix));
}

/**
 * A same-origin relative path or null. Rejects protocol-relative (`//x`), absolute URLs, backslashes
 * (`/\x` is `//x` in browsers) and control characters.
 */
export function safeRelativePath(value: string | null | undefined): string | null {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) return null;
  if (value.includes("\\") || /[\u0000-\u001f\u007f]/.test(value)) return null;
  try {
    const base = "http://same-origin.invalid";
    const url = new URL(value, base);
    if (url.origin !== base) return null;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return null;
  }
}

// 028: provider onboarding pages (`/join`, `/claim/<token>`) are open to every role, because a new account is
// a guardian until POST /api/providers/register or a claim promotes it server-side.
function isProviderOnboardingPath(pathname: string): boolean {
  return pathname === "/join" || pathname.startsWith("/claim/");
}

/** 030: the public booking flow (`/book/<profileId>`); a guardian signing in mid-booking returns there. */
export function isBookingPath(pathname: string): boolean {
  return pathname.startsWith("/book/");
}

/** Where a signed-in user goes after sign-in (FR-3): `next` only when it belongs to the user's area. */
export function postSignInPath(role: AppRole, next: string | null | undefined): string {
  const safe = safeRelativePath(next);
  if (!safe) return homeForRole(role);
  const path = safe.split(/[?#]/)[0];
  if (isProviderOnboardingPath(path)) return safe;
  if (role === "guardian") return isFamilyPortalPath(path) || isBookingPath(path) ? safe : homeForRole(role);
  return isFamilyPath(path) ? homeForRole(role) : safe;
}

/**
 * FR-4 page routing for the proxy. `role` is null for anonymous visitors. Returns the redirect target,
 * or null to continue. Pages and APIs still enforce access themselves (requireGuardian, requireProvider*).
 */
export function pageRedirect(pathname: string, search: string, role: AppRole | null): string | null {
  if (underPrefix(pathname, FAMILY_LOGIN_PATH)) return role ? homeForRole(role) : null;
  if (isFamilyPortalPath(pathname)) {
    if (!role) return `${FAMILY_LOGIN_PATH}?next=${encodeURIComponent(`${pathname}${search}`)}`;
    return role === "guardian" ? null : homeForRole(role);
  }
  if (isProviderAreaPath(pathname)) {
    if (!role) return `/login?next=${encodeURIComponent(`${pathname}${search}`)}`;
    return role === "guardian" ? homeForRole(role) : null;
  }
  return null;
}
