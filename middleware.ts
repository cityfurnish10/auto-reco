import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, parseSessionCookie } from "@/lib/demo-auth";

const PUBLIC_PATHS = ["/login"];
const ADMIN_ONLY_PATHS = [
  "/users",
  "/system-health",
  "/analytics",
  "/email-digest",
  // Inherently cross-city: it reads per-run coverage and the movement ledger for
  // every warehouse at once, and a manager's slice of a global run's coverage
  // would mislead rather than merely restrict.
  "/stock-analyser",
];

export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request: { headers: request.headers } });
  const { pathname } = request.nextUrl;

  // Belt and braces for the face-model files. The matcher below already
  // excludes them and that is what actually fixed this; the line is kept
  // because the cost of the exclusion ever being edited away is out of all
  // proportion to a string comparison.
  //
  // WHAT WENT WRONG, because the symptom pointed nowhere near the cause.
  // public/ is NOT covered by the _next/static exclusion, so every request for
  // a model was answered with a redirect to /login. The loader then fed an HTML
  // login page to a binary parser, failed, and every check-in recorded
  // "no_face" — indistinguishable from a broken camera. Two rounds of camera
  // work were spent before anyone looked at the network.
  //
  // Anything under /models is a public static asset with nothing to protect.
  if (pathname.startsWith("/models/")) return response;
  const isPublic = PUBLIC_PATHS.some((p) => pathname.startsWith(p));

  // Demo mode: Supabase not wired up yet — sessions come from the demo
  // cookie set at login. This whole branch is deleted once Supabase lands.
  if (
    !process.env.NEXT_PUBLIC_SUPABASE_URL ||
    !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  ) {
    const user = parseSessionCookie(
      request.cookies.get(SESSION_COOKIE)?.value
    );

    if (!user && !isPublic) {
      const url = request.nextUrl.clone();
      url.pathname = "/login";
      url.searchParams.set("next", pathname);
      return NextResponse.redirect(url);
    }

    if (user && pathname === "/login") {
      const url = request.nextUrl.clone();
      url.pathname = "/dashboard";
      url.search = "";
      return NextResponse.redirect(url);
    }

    if (
      user &&
      user.role !== "ADMIN" &&
      ADMIN_ONLY_PATHS.some((p) => pathname.startsWith(p))
    ) {
      const url = request.nextUrl.clone();
      url.pathname = "/dashboard";
      url.search = "";
      return NextResponse.redirect(url);
    }

    return response;
  }

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        get(name: string) {
          return request.cookies.get(name)?.value;
        },
        set(name: string, value: string, options: CookieOptions) {
          request.cookies.set({ name, value, ...options });
          response = NextResponse.next({
            request: { headers: request.headers },
          });
          response.cookies.set({ name, value, ...options });
        },
        remove(name: string, options: CookieOptions) {
          request.cookies.set({ name, value: "", ...options });
          response = NextResponse.next({
            request: { headers: request.headers },
          });
          response.cookies.set({ name, value: "", ...options });
        },
      },
    }
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user && !isPublic) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }

  if (user && pathname === "/login") {
    const url = request.nextUrl.clone();
    url.pathname = "/dashboard";
    url.search = "";
    return NextResponse.redirect(url);
  }

  // Admin-only pages: verify the app_users role. The lookup runs ONLY on these
  // paths (not every request). RLS lets a user read only their own app_users
  // row, so this can't leak anyone else's role. Non-admins bounce to /dashboard.
  if (user && ADMIN_ONLY_PATHS.some((p) => pathname.startsWith(p))) {
    const { data: appUser } = await supabase
      .from("app_users")
      .select("role")
      .eq("auth_id", user.id)
      .single();
    if (appUser?.role !== "admin") {
      const url = request.nextUrl.clone();
      url.pathname = "/dashboard";
      url.search = "";
      return NextResponse.redirect(url);
    }
  }

  return response;
}

export const config = {
  // Protect everything except static assets and the api routes that carry their
  // own auth: cron uses CRON_SECRET, and api/gate uses a device token issued at
  // enrolment.
  //
  // `models` holds the face-recognition weights, and leaving it out cost the
  // whole feature. Static files under public/ are NOT covered by the
  // _next/static exclusion, so every request for a model was answered with a
  // redirect to /login. The app then fed an HTML login page to a model loader,
  // which failed, and every check-in recorded verdict "no_face" -- looking
  // exactly like a camera fault. It was never the camera.
  //
  // `scan` is the guard app itself, for the same reason: a guard has no
  // dashboard session, so without the exclusion the phone gets the login page
  // instead of the app. The page is only a shell — every byte of data it shows
  // comes from api/gate, which enforces the device token.
  //
  // WHY api/gate HAS TO BE HERE. Without the exclusion this middleware sees no
  // session on a device-token request and REDIRECTS it to /login — so the phone
  // receives a 307 and an HTML page instead of its sync response, and every
  // scan silently fails to land. The one route in there that does need a human
  // session, /api/gate/enrol, calls getCurrentAppUser() itself; that reads the
  // cookie-bound client directly and works whether or not middleware ran, so
  // excluding the prefix costs nothing.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|icon.svg|apple-icon.png|robots.txt|sitemap.xml|api/cron|api/gate|scan|models).*)",
  ],
};
