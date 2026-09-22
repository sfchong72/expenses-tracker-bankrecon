import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

type CookieToSet = {
  name: string;
  value: string;
  options?: Parameters<NextResponse["cookies"]["set"]>[2];
};

function safeInternalPath(value: string | null) {
  return value?.startsWith("/") && !value.startsWith("//") ? value : "/";
}

export async function updateSession(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  const isLogin = pathname === "/login";
  const isMfa = pathname === "/mfa";
  const isAccessDenied = pathname === "/access-denied";
  const isApi = pathname.startsWith("/api/");
  const supabaseResponse = NextResponse.next({ request });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  // If Supabase isn't configured, skip the auth refresh and pass through.
  // Without this guard createServerClient throws "Your project's URL and Key
  // are required", crashing the edge middleware on every route (500
  // MIDDLEWARE_INVOCATION_FAILED).
  if (!url || !anonKey) {
    return supabaseResponse;
  }

  try {
    let response = supabaseResponse;
    const supabase = createServerClient(url, anonKey, {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet: CookieToSet[]) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          );
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          );
        },
      },
    });

    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      if (isLogin) return response;
      if (isApi) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }

      const redirectUrl = request.nextUrl.clone();
      redirectUrl.pathname = "/login";
      redirectUrl.searchParams.set("next", pathname);
      return NextResponse.redirect(redirectUrl);
    }

    const { data: profile, error: profileError } = await supabase
      .from("app_profiles")
      .select("id, role, active_status")
      .eq("id", user.id)
      .maybeSingle();

    if (profileError || !profile) {
      if (isLogin) return response;
      if (isApi) {
        return NextResponse.json({ error: "No active application profile" }, { status: 403 });
      }

      const redirectUrl = request.nextUrl.clone();
      redirectUrl.pathname = "/login";
      redirectUrl.searchParams.set("error", "no_profile");
      return NextResponse.redirect(redirectUrl);
    }

    if (!profile.active_status) {
      if (isLogin) return response;
      if (isApi) {
        return NextResponse.json({ error: "Account inactive" }, { status: 403 });
      }

      const redirectUrl = request.nextUrl.clone();
      redirectUrl.pathname = "/login";
      redirectUrl.searchParams.set("error", "inactive");
      return NextResponse.redirect(redirectUrl);
    }

    const allowedRoles = new Set(["owner", "finance_manager", "finance_staff", "management", "data_entry"]);
    if (!allowedRoles.has(profile.role)) {
      if (isApi) return NextResponse.json({ error: "Application access is not assigned" }, { status: 403 });
      if (isAccessDenied) return response;
      const redirectUrl = request.nextUrl.clone();
      redirectUrl.pathname = "/access-denied";
      redirectUrl.search = "";
      return NextResponse.redirect(redirectUrl);
    }

    if (["owner", "finance_manager"].includes(profile.role)) {
      const { data: assurance, error: assuranceError } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
      if (assuranceError || assurance?.currentLevel !== "aal2") {
        if (isMfa) return response;
        if (isApi) return NextResponse.json({ error: "MFA assurance level 2 is required" }, { status: 403 });
        const redirectUrl = request.nextUrl.clone();
        redirectUrl.pathname = "/mfa";
        redirectUrl.searchParams.set("next", pathname === "/login" ? "/" : pathname);
        return NextResponse.redirect(redirectUrl);
      }
    } else if (isMfa) {
      const redirectUrl = request.nextUrl.clone();
      redirectUrl.pathname = "/";
      redirectUrl.search = "";
      return NextResponse.redirect(redirectUrl);
    }

    if (isMfa) {
      const redirectUrl = request.nextUrl.clone();
      redirectUrl.pathname = safeInternalPath(request.nextUrl.searchParams.get("next"));
      redirectUrl.search = "";
      return NextResponse.redirect(redirectUrl);
    }

    if (isLogin) {
      const redirectUrl = request.nextUrl.clone();
      redirectUrl.pathname = "/";
      redirectUrl.search = "";
      return NextResponse.redirect(redirectUrl);
    }

    if (pathname.startsWith("/settings") && profile.role !== "owner") {
      const redirectUrl = request.nextUrl.clone();
      redirectUrl.pathname = "/access-denied";
      redirectUrl.search = "";
      return NextResponse.redirect(redirectUrl);
    }

    if (isAccessDenied) return response;

    return response;
  } catch {
    if (isLogin) return supabaseResponse;
    if (isApi) return NextResponse.json({ error: "Authorization check unavailable" }, { status: 503 });
    const redirectUrl = request.nextUrl.clone();
    redirectUrl.pathname = "/login";
    redirectUrl.searchParams.set("error", "auth_check_failed");
    return NextResponse.redirect(redirectUrl);
  }
}
