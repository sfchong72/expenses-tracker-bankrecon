import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";

export async function requireBankAccess(entityId?: string, capability: "import" | "reconcile" | "read" = "read") {
  const supabase = await createClient();
  if (process.env.BANK_RECONCILIATION_ACTIVE !== "true") {
    return {
      supabase,
      user: null,
      profile: null,
      canViewBalances: false,
      error: NextResponse.json(
        { error: "Feature inactive - bank reconciliation is handled in SQL Accounting." },
        { status: 410 },
      ),
    };
  }

  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) return { supabase, user: null, profile: null, canViewBalances: false, error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };

  const { data: profile, error: profileError } = await supabase
    .from("app_profiles")
    .select("role, active_status")
    .eq("id", userData.user.id)
    .maybeSingle();

  if (profileError || !profile?.active_status) {
    return { supabase, user: userData.user, profile, canViewBalances: false, error: NextResponse.json({ error: "Active finance profile is required" }, { status: 403 }) };
  }

  const owner = profile.role === "owner";
  const { data: permissions } = await supabase
    .from("finance_user_permissions")
    .select("can_view_bank_balances")
    .eq("user_id", userData.user.id)
    .maybeSingle();
  const canViewBalances = owner || Boolean(permissions?.can_view_bank_balances);

  if (owner || !entityId || capability === "read") {
    return { supabase, user: userData.user, profile, canViewBalances, error: null };
  }

  const column = capability === "import" ? "can_import_bank" : "can_reconcile";
  const { data: access } = await supabase
    .from("user_entity_access")
    .select("can_import_bank, can_reconcile")
    .eq("user_id", userData.user.id)
    .eq("entity_id", entityId)
    .maybeSingle();

  if (!Boolean(access?.[column as keyof typeof access])) {
    return { supabase, user: userData.user, profile, canViewBalances, error: NextResponse.json({ error: `Bank ${capability} permission is required for this entity` }, { status: 403 }) };
  }

  return { supabase, user: userData.user, profile, canViewBalances, error: null };
}

export function csvResponse(filename: string, rows: Record<string, unknown>[]) {
  const headers = Object.keys(rows[0] ?? { status: "", message: "" });
  const body = [
    headers.join(","),
    ...rows.map((row) => headers.map((header) => `"${String(row[header] ?? "").replaceAll('"', '""')}"`).join(",")),
  ].join("\n");
  return new NextResponse(body, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
    },
  });
}
