import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { passwordResetRedirectUrl } from "@/lib/auth/password-reset-url";

type LifecycleAction = "eligibility" | "send_password_reset" | "deactivate" | "reactivate" | "delete";

const protectedReferences: Array<{ table: string; columns: string[] }> = [
  { table: "audit_logs", columns: ["user_id", "actor_user_id"] },
  { table: "bank_import_batches", columns: ["uploaded_by", "archived_by", "discarded_by"] },
  { table: "bank_internal_transfers", columns: ["confirmed_by"] },
  { table: "bank_manual_exceptions", columns: ["created_by"] },
  { table: "bank_reconciliation_allocations", columns: ["confirmed_by", "reversed_by"] },
  { table: "bank_reconciliation_events", columns: ["actor_user_id"] },
  { table: "bill_payments", columns: ["created_by"] },
  { table: "claim_advances", columns: ["created_by"] },
  { table: "claim_import_batches", columns: ["uploaded_by"] },
  { table: "claim_reimbursements", columns: ["created_by"] },
  { table: "claim_review_actions", columns: ["actor_user_id"] },
  { table: "claim_status_history", columns: ["changed_by"] },
  { table: "claims", columns: ["claimant_user_id", "created_by", "updated_by", "submitted_by", "checked_by", "approved_by", "approval_exception_by"] },
  { table: "document_links", columns: ["created_by"] },
  { table: "documents", columns: ["uploaded_by", "archived_by", "deleted_by"] },
  { table: "enrolment_counsellor_history", columns: ["changed_by", "from_counsellor_user_id", "to_counsellor_user_id"] },
  { table: "enrolments", columns: ["counsellor_user_id", "created_by", "updated_by"] },
  { table: "import_batches", columns: ["uploaded_by", "archived_by", "discarded_by", "last_action_by"] },
  { table: "payment_vouchers", columns: ["prepared_by", "cancelled_by"] },
  { table: "programme_intakes", columns: ["created_by", "updated_by", "revised_by"] },
  { table: "programmes", columns: ["created_by", "updated_by"] },
  { table: "recurring_obligations", columns: ["created_by"] },
  { table: "student_duplicate_reviews", columns: ["reviewed_by"] },
  { table: "student_import_batches", columns: ["uploaded_by", "confirmed_by", "reverted_by"] },
  { table: "student_legacy_records", columns: ["created_by"] },
  { table: "student_merge_events", columns: ["merged_by"] },
  { table: "students", columns: ["created_by", "updated_by"] },
  { table: "supplier_bills", columns: ["created_by"] },
  { table: "uat_feedback", columns: ["submitted_by", "resolved_by"] },
  { table: "user_branch_access", columns: ["created_by"] },
];

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const owner = await supabase
    .from("app_profiles")
    .select("role, active_status")
    .eq("id", userData.user.id)
    .maybeSingle();
  if (owner.error || owner.data?.role !== "owner" || !owner.data?.active_status) {
    return NextResponse.json({ error: "Owner access is required to manage staff accounts." }, { status: 403 });
  }

  const body = await request.json().catch(() => ({}));
  const action = String(body.action ?? "") as LifecycleAction;
  const targetUserId = String(body.userId ?? "").trim();
  if (!targetUserId) return NextResponse.json({ error: "Choose a staff account." }, { status: 400 });
  if (!["eligibility", "send_password_reset", "deactivate", "reactivate", "delete"].includes(action)) {
    return NextResponse.json({ error: "Unsupported account action." }, { status: 400 });
  }

  let admin;
  try {
    admin = createAdminClient();
  } catch {
    return NextResponse.json({ error: "Server-side Supabase administration is not configured." }, { status: 501 });
  }

  const [authResult, profileResult] = await Promise.all([
    admin.auth.admin.getUserById(targetUserId),
    admin.from("app_profiles").select("id, email, display_name, role, active_status").eq("id", targetUserId).maybeSingle(),
  ]);
  if (authResult.error || !authResult.data.user || profileResult.error || !profileResult.data) {
    return NextResponse.json({ error: "The selected staff account could not be found in both Auth and the application profile." }, { status: 404 });
  }
  const target = profileResult.data;

  if (action === "eligibility") {
    const eligibility = await deletionEligibility(admin, targetUserId, target.role);
    return NextResponse.json(eligibility);
  }

  if (action === "send_password_reset") {
    const email = authResult.data.user.email;
    if (!email) return NextResponse.json({ error: "The selected Auth user has no email address." }, { status: 400 });
    const redirectTo = passwordResetRedirectUrl(request);
    const reset = await admin.auth.resetPasswordForEmail(email, { redirectTo });
    if (reset.error) return NextResponse.json({ error: "Password reset instructions could not be sent. Check Supabase email and redirect settings." }, { status: 400 });
    await writeAudit(admin, userData.user.id, "staff_password_reset_sent", targetUserId, { email });
    return NextResponse.json({ message: `Password reset instructions were sent to ${email}.` });
  }

  if (targetUserId === userData.user.id) {
    return NextResponse.json({ error: "Use Account settings to manage your own owner login." }, { status: 400 });
  }

  if (action === "deactivate") {
    if (target.role === "owner" && await activeOwnerCount(admin) <= 1) {
      return NextResponse.json({ error: "The last active owner account cannot be deactivated." }, { status: 400 });
    }
    const banned = await admin.auth.admin.updateUserById(targetUserId, { ban_duration: "876000h" });
    if (banned.error) return NextResponse.json({ error: "The Auth login could not be deactivated." }, { status: 400 });
    const updated = await admin.from("app_profiles").update({ active_status: false }).eq("id", targetUserId);
    if (updated.error) {
      await admin.auth.admin.updateUserById(targetUserId, { ban_duration: "0s" });
      return NextResponse.json({ error: "The application profile could not be deactivated." }, { status: 400 });
    }
    await writeAudit(admin, userData.user.id, "staff_login_deactivated", targetUserId, { email: target.email, role: target.role });
    return NextResponse.json({ message: "Staff login deactivated. Historical records were preserved." });
  }

  if (action === "reactivate") {
    const unbanned = await admin.auth.admin.updateUserById(targetUserId, { ban_duration: "0s" });
    if (unbanned.error) return NextResponse.json({ error: "The Auth login could not be reactivated." }, { status: 400 });
    const updated = await admin.from("app_profiles").update({ active_status: true }).eq("id", targetUserId);
    if (updated.error) {
      await admin.auth.admin.updateUserById(targetUserId, { ban_duration: "876000h" });
      return NextResponse.json({ error: "The application profile could not be reactivated." }, { status: 400 });
    }
    await writeAudit(admin, userData.user.id, "staff_login_reactivated", targetUserId, { email: target.email, role: target.role });
    return NextResponse.json({ message: "Staff login reactivated. Existing role and entity assignments were preserved." });
  }

  const eligibility = await deletionEligibility(admin, targetUserId, target.role);
  if (!eligibility.eligible) {
    return NextResponse.json({ error: eligibility.reason }, { status: 409 });
  }
  const deleted = await admin.auth.admin.deleteUser(targetUserId);
  if (deleted.error) return NextResponse.json({ error: "The test account could not be deleted safely." }, { status: 400 });
  await writeAudit(admin, userData.user.id, "staff_test_account_deleted", targetUserId, { email: target.email, role: target.role });
  return NextResponse.json({ message: "Eligible test account deleted. No historical business records were removed." });
}

async function deletionEligibility(admin: ReturnType<typeof createAdminClient>, userId: string, role: string) {
  if (role === "owner") {
    return { eligible: false, dependencyCount: 0, reason: "Owner accounts cannot be deleted from this screen." };
  }

  let dependencyCount = 0;
  for (const reference of protectedReferences) {
    const filter = reference.columns.map((column) => `${column}.eq.${userId}`).join(",");
    const result = await admin.from(reference.table).select("*", { count: "exact", head: true }).or(filter);
    if (result.error) {
      return { eligible: false, dependencyCount, reason: "Deletion eligibility could not be verified safely. Deactivate the account instead." };
    }
    dependencyCount += result.count ?? 0;
  }

  return dependencyCount > 0
    ? { eligible: false, dependencyCount, reason: "This user cannot be deleted because historical records depend on this account. Deactivate the account instead." }
    : { eligible: true, dependencyCount: 0, reason: "No protected historical dependencies were found." };
}

async function activeOwnerCount(admin: ReturnType<typeof createAdminClient>) {
  const result = await admin.from("app_profiles").select("id", { count: "exact", head: true }).eq("role", "owner").eq("active_status", true);
  return result.error ? 1 : result.count ?? 1;
}

async function writeAudit(admin: ReturnType<typeof createAdminClient>, actorUserId: string, action: string, targetUserId: string, payload: Record<string, unknown>) {
  await admin.from("audit_logs").insert({
    actor_user_id: actorUserId,
    action,
    entity_type: "app_profile",
    entity_id: targetUserId,
    is_demo: false,
    data_origin: "manual",
    payload,
  });
}
