import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { FAMILY_LOGIN_PATH, isInvalidSessionError, isProtectedPath, pageRedirect, type AppRole } from "@/lib/auth-access";
import { createNonce, familyCsp, needsFamilyCsp } from "@/lib/csp";
import { env } from "@/lib/env";
import { PATH_HEADER } from "@/lib/i18n/config";

const CSP_HEADER = "Content-Security-Policy";

export async function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  // Locale resolution (lib/i18n/server.ts) reads the path from this header; any client value is overwritten.
  request.headers.set(PATH_HEADER, pathname);

  // 019 NFR-2: family pages get a nonce CSP (Next.js reads the nonce from the request header).
  const csp = needsFamilyCsp(pathname)
    ? familyCsp({
        pathname,
        nonce: createNonce(),
        supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
        isDev: process.env.NODE_ENV === "development",
      })
    : null;
  if (csp) request.headers.set(CSP_HEADER, csp);
  const withCsp = <R extends NextResponse>(res: R): R => {
    if (csp) res.headers.set(CSP_HEADER, csp);
    return res;
  };

  const isFamilyLogin = pathname === FAMILY_LOGIN_PATH || pathname.startsWith(`${FAMILY_LOGIN_PATH}/`);
  if (!isProtectedPath(pathname) && !isFamilyLogin) return withCsp(NextResponse.next({ request }));

  let response = NextResponse.next({ request });
  const supabase = createServerClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  const { data, error } = await supabase.auth.getUser();
  if (error && !isInvalidSessionError(error)) {
    throw new Error(`Could not verify Supabase session: ${error.message}`);
  }
  if (!data.user && pathname.startsWith("/api/")) {
    const unauthorized = NextResponse.json({ error: "Authentication required" }, { status: 401 });
    for (const cookie of response.cookies.getAll()) unauthorized.cookies.set(cookie);
    return unauthorized;
  }
  if (pathname.startsWith("/api/")) return response;

  // 019 FR-4: role-aware page routing (a convenience; pages and APIs enforce access themselves).
  let role: AppRole | null = null;
  if (data.user) {
    // RLS lets a signed-in user read only their own profile row.
    const profile = await supabase.from("user_profiles").select("role").eq("id", data.user.id).maybeSingle();
    role = (profile.data?.role as AppRole | undefined) ?? null;
    if (!role) return withCsp(response);
  }
  const target = pageRedirect(pathname, request.nextUrl.search, role);
  if (target) {
    const redirectResponse = NextResponse.redirect(new URL(target, request.url));
    for (const cookie of response.cookies.getAll()) redirectResponse.cookies.set(cookie);
    return redirectResponse;
  }

  return withCsp(response);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};
