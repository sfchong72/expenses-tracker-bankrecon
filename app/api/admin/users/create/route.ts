import { createClient as createAdminClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

const staffRoles = new Set(["finance_manager", "finance_staff", "data_entry", "read_only"]);
const genericCreateError = "Could not create the staff login. Check the email address and try again.";

type PermissionPayload = {
  can_view_documents?: boolean;
  can_upload_documents?: boolean;
  can_manage_documents?: boolean;
  can_view_bank_balances?: boolean;
  can_manage_recurring_bills?: boolean;
  can_generate_payment_vouchers?: boolean;
};

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

  if (profile.error || profile.data?.role !== "owner" || !profile.data?.active_status) {
    return NextResponse.json({ error: "Owner access is required to create staff logins." }, { status: 403 });
  }

  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url || !serviceKey) {
    return NextResponse.json({
      error: "SUPABASE_SERVICE_ROLE_KEY is not configured in Vercel. Create the Auth user manually in Supabase, or add this server-only env var to enable in-app staff login creation.",
    }, { status: 501 });
  }

  const body = await request.json();
  const email = String(body.email ?? "").trim().toLowerCase();
  const password = String(body.password ?? "");
  const displayName = String(body.displayName ?? "").trim();
  const role = String(body.role ?? "finance_staff");
  const entityIds: string[] = Array.isArray(body.entityIds) ? body.entityIds.map(String).filter(Boolean) : [];
  const permissions = (body.permissions ?? {}) as PermissionPayload;

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return NextResponse.json({ error: "Valid staff email is required." }, { status: 400 });
  if (!staffRoles.has(role)) return NextResponse.json({ error: "Choose a staff role, not owner." }, { status: 400 });
  if (password.length < 8) return NextResponse.json({ error: "Temporary password must be at least 8 characters." }, { status: 400 });
  if (entityIds.length !== new Set(entityIds).size) return NextResponse.json({ error: "Entity assignments contain duplicates." }, { status: 400 });

  const existingProfiles = await supabase.from("app_profiles").select("id, email").limit(1000);
  if (existingProfiles.error) return NextResponse.json({ error: "Could not validate staff email." }, { status: 400 });
  if ((existingProfiles.data ?? []).some((row) => String(row.email ?? "").toLowerCase() === email)) {
    return NextResponse.json({ error: "A user profile already exists for this email." }, { status: 409 });
  }

  if (entityIds.length) {
    const entityCheck = await supabase.from("entities").select("id").in("id", entityIds).eq("active_status", true);
    if (entityCheck.error) return NextResponse.json({ error: "Could not validate entity assignments." }, { status: 400 });
    const validIds = new Set((entityCheck.data ?? []).map((row) => row.id));
    if (entityIds.some((id) => !validIds.has(id))) {
      return NextResponse.json({ error: "One or more selected entities are not valid." }, { status: 400 });
    }
  }

  const admin = createAdminClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const created = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { display_name: displayName || email.split("@")[0] },
  });

  if (created.error || !created.data.user) {
    const status = created.error?.message?.toLowerCase().includes("already") ? 409 : 400;
    return NextResponse.json({ error: status === 409 ? "A login already exists for this email." : genericCreateError }, { status });
  }

  const staffUserId = created.data.user.id;
  const profileUpsert = await supabase.from("app_profiles").upsert({
    id: staffUserId,
    email,
    display_name: displayName || email.split("@")[0],
    role,
    active_status: true,
  });
  if (profileUpsert.error) return await rollbackCreatedUser(admin, staffUserId, "Could not save the staff profile.");

  const permissionUpsert = await supabase.from("finance_user_permissions").upsert({
    user_id: staffUserId,
    can_view_documents: permissions.can_view_documents ?? true,
    can_upload_documents: permissions.can_upload_documents ?? role !== "read_only",
    can_manage_documents: permissions.can_manage_documents ?? role === "finance_manager",
    can_view_bank_balances: false,
    can_manage_recurring_bills: permissions.can_manage_recurring_bills ?? role === "finance_manager",
    can_generate_payment_vouchers: permissions.can_generate_payment_vouchers ?? role === "finance_manager",
  });
  if (permissionUpsert.error) return await rollbackCreatedUser(admin, staffUserId, "Could not save staff permissions.");

  if (entityIds.length) {
    const accessRows = entityIds.map((entityId) => ({
      user_id: staffUserId,
      entity_id: entityId,
      role,
      can_manage_bills: ["finance_manager", "finance_staff", "data_entry"].includes(role),
      can_import_bank: false,
      can_reconcile: false,
      can_view_sensitive_balances: false,
      active_status: true,
    }));
    const accessInsert = await supabase.from("user_entity_access").upsert(accessRows, { onConflict: "user_id,entity_id" });
    if (accessInsert.error) return await rollbackCreatedUser(admin, staffUserId, "Could not save entity assignments.");
  }

  await supabase.from("audit_logs").insert({
    actor_user_id: userData.user.id,
    action: "staff_login_created",
    entity_type: "app_profile",
    entity_id: staffUserId,
    payload: { email, role, entity_count: entityIds.length },
  });

  return NextResponse.json({ user_id: staffUserId, email, role });
}

async function rollbackCreatedUser(admin: { auth: { admin: { deleteUser: (userId: string) => Promise<unknown> } } }, userId: string, error: string) {
  await admin.auth.admin.deleteUser(userId).catch(() => undefined);
  return NextResponse.json({ error }, { status: 400 });
}
