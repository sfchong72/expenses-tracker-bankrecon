import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

const financeRoles = new Set(["finance_manager", "finance_staff"]);

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const profile = await supabase
    .from("app_profiles")
    .select("role, active_status")
    .eq("id", userData.user.id)
    .maybeSingle();
  if (profile.error || !profile.data?.active_status) {
    return NextResponse.json({ error: "An active finance account is required." }, { status: 403 });
  }

  if (profile.data.role !== "owner") {
    if (!financeRoles.has(profile.data.role)) {
      return NextResponse.json({ error: "Finance or owner access is required to add expense categories." }, { status: 403 });
    }
    const access = await supabase
      .from("user_entity_access")
      .select("id")
      .eq("user_id", userData.user.id)
      .eq("active_status", true)
      .eq("can_manage_bills", true)
      .limit(1);
    if (access.error || !access.data?.length) {
      return NextResponse.json({ error: "Bill-management access is required to add expense categories." }, { status: 403 });
    }
  }

  const body = await request.json().catch(() => ({}));
  const name = String(body.name ?? "").trim().replace(/\s+/g, " ");
  if (!name) return NextResponse.json({ error: "Category name is required." }, { status: 400 });
  if (name.length > 120) return NextResponse.json({ error: "Category name must be 120 characters or fewer." }, { status: 400 });

  let admin;
  try {
    admin = createAdminClient();
  } catch {
    return NextResponse.json({ error: "Expense category creation is not configured on the server." }, { status: 501 });
  }

  const existing = await admin
    .from("categories")
    .select("id, name, active_status")
    .eq("category_type", "expense")
    .is("entity_id", null);
  if (existing.error) return NextResponse.json({ error: "Expense categories could not be checked." }, { status: 500 });

  const normalizedName = name.toLocaleLowerCase("en-MY");
  const duplicate = (existing.data ?? []).find((row) => String(row.name).trim().replace(/\s+/g, " ").toLocaleLowerCase("en-MY") === normalizedName);
  if (duplicate) {
    const suffix = duplicate.active_status ? "already exists" : "already exists but is archived";
    return NextResponse.json({ error: `Expense category “${duplicate.name}” ${suffix}.` }, { status: 409 });
  }

  const inserted = await admin
    .from("categories")
    .insert({
      entity_id: null,
      category_type: "expense",
      name,
      account_code: null,
      active_status: true,
      data_origin: "manual",
    })
    .select("id, entity_id, category_type, name, account_code, active_status, data_origin")
    .single();
  if (inserted.error) return NextResponse.json({ error: "Expense category could not be created." }, { status: 400 });

  await admin.from("audit_logs").insert({
    actor_user_id: userData.user.id,
    action: "expense_category_created",
    entity_type: "category",
    entity_id: inserted.data.id,
    is_demo: false,
    data_origin: "manual",
    payload: { name: inserted.data.name, category_type: "expense", scope: "all_entities" },
  });

  return NextResponse.json({ category: inserted.data });
}
