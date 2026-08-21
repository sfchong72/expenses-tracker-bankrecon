import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

const neutralMessage = "If this email belongs to an active account, password reset instructions have been sent.";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const email = String(body.email ?? "").trim().toLowerCase();

  if (email && email.length <= 320) {
    try {
      const admin = createAdminClient();
      const redirectTo = `${new URL(request.url).origin}/auth/callback?next=/reset-password`;
      await admin.auth.resetPasswordForEmail(email, { redirectTo });
    } catch {
      // Keep the same neutral response for missing accounts, rate limits,
      // email-provider failures, and unavailable server configuration.
    }
  }

  return NextResponse.json({ message: neutralMessage });
}
