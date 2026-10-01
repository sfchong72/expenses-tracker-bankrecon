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

const applicationRoles = new Set([
  "owner",
  "finance_manager",
  "finance_staff",
  "management",
  "data_entry",
  "read_only",
  "branch_manager",
  "counsellor",
  "marketing",
  "student_services",
  "trainer",
]);

const highRiskExactPaths = new Set([
  "/api/bank-imports/confirm",
  "/api/bank-imports/export",
  "/api/bank-reports/monthly",
  "/api/claims/export",
  "/api/claims/prepare-voucher",
  "/api/claims/status",
  "/api/payment-vouchers/delete",
  "/api/payment-vouchers/generate",
  "/api/payment-vouchers/issue",
  "/api/payment-vouchers/void",
  "/api/reconciliation/confirm-match",
  "/api/reconciliation/unmatch",
]);

function requiresAal2(pathname: string) {
  return highRiskExactPaths.has(pathname)
    || pathname.startsWith("/api/admin/")
    || pathname.startsWith("/api/bank-imports/")
    || pathname.startsWith("/api/bank-reports/")
    || pathname.startsWith("/api/reconciliation/")
    || /^\/api\/documents\/[^/]+\/delete$/.test(pathname)
    || pathname === "/bank-transactions"
    || pathname.startsWith("/bank-imports")
    || pathname.startsWith("/payment-vouchers")
    || pathname.startsWith("/reconcile")
    || pathname.startsWith("/reports/bank-reconciliation")
    || pathname === "/settings/users"
    || pathname.startsWith("/settings/users/");
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

    if (!applicationRoles.has(profile.role)) {
      if (isApi) return NextResponse.json({ error: "Application access is not assigned" }, { status: 403 });
      if (isAccessDenied) return response;
      const redirectUrl = request.nextUrl.clone();
      redirectUrl.pathname = "/access-denied";
      redirectUrl.search = "";
      return NextResponse.redirect(redirectUrl);
    }

    if (isMfa) {
      const { data: assurance } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
      if (assurance?.currentLevel !== "aal2") return response;

      const redirectUrl = request.nextUrl.clone();
      redirectUrl.pathname = safeInternalPath(request.nextUrl.searchParams.get("next"));
      redirectUrl.search = "";
      return NextResponse.redirect(redirectUrl);
    }

    if (requiresAal2(pathname)) {
      const { data: assurance, error: assuranceError } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
      if (assuranceError || assurance?.currentLevel !== "aal2") {
        if (isMfa) return response;
        if (isApi) {
          return NextResponse.json(
            { error: "MFA assurance level 2 is required", code: "MFA_REQUIRED" },
            { status: 403 },
          );
        }
        const redirectUrl = request.nextUrl.clone();
        redirectUrl.pathname = "/mfa";
        redirectUrl.searchParams.set("next", pathname === "/login" ? "/" : pathname);
        return NextResponse.redirect(redirectUrl);
      }
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
