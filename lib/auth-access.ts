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
    pathname === "/api/webhooks/elevenlabs" ||
    /^\/api\/cases\/[^/]+\/ask$/.test(pathname) ||
    pathname.startsWith("/api/intake/") ||
    pathname.startsWith("/api/dev/simulate-intake/")
  );
}

export function isProtectedPath(pathname: string): boolean {
  if (pathname === "/dashboard" || pathname.startsWith("/dashboard/")) return true;
  if (pathname === "/cases" || pathname.startsWith("/cases/")) return true;
  if (pathname === "/admin" || pathname.startsWith("/admin/")) return true;
  return pathname.startsWith("/api/") && !isPublicApiPath(pathname);
}
