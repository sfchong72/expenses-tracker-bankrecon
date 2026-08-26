import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const tokenHash = url.searchParams.get("token_hash");
  const type = url.searchParams.get("type");
  const requestedNext = url.searchParams.get("next") || "/reset-password";
  const next = requestedNext.startsWith("/") && !requestedNext.startsWith("//") ? requestedNext : "/reset-password";
  const supabase = await createClient();

  // Recovery emails use a token hash in the query string. Unlike an implicit
  // access-token fragment, it is retained when Vercel authenticates a visitor
  // before returning them to this Preview deployment.
  if (tokenHash && type === "recovery") {
    const verified = await supabase.auth.verifyOtp({
      token_hash: tokenHash,
      type: "recovery",
    });
    if (!verified.error) return NextResponse.redirect(new URL(next, url.origin));
  }

  if (code) {
    const exchanged = await supabase.auth.exchangeCodeForSession(code);
    if (!exchanged.error) return NextResponse.redirect(new URL(next, url.origin));
  }

  return NextResponse.redirect(new URL("/login?error=reset_link", url.origin));
}

