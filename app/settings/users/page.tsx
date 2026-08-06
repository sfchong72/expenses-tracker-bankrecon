"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { AuthBar } from "@/app/auth-bar";
import { createClient } from "@/lib/supabase/client";

type Row = Record<string, any>;

function friendlyProfileUpdateError(message: string) {
  const text = String(message || "");
  if (/row-level security|permission denied|not allowed|policy/i.test(text)) {
    return "Display name update requires RLS or database policy change.";
  }
  return text;
}

const staffRoles = ["finance_manager", "finance_staff", "data_entry", "read_only"];
const roleHelp: Record<string, string> = {
  finance_manager: "Manage documents, recurring bills and voucher preparation. Bank balances still hidden.",
  finance_staff: "Create and update daily finance records, upload documents, no bank balances.",
  data_entry: "Enter records and upload documents, no management settings.",
  read_only: "View permitted records and documents only.",
};

const defaultPermissions = {
  can_view_documents: true,
  can_upload_documents: true,
  can_manage_documents: false,
  can_view_bank_balances: false,
  can_manage_recurring_bills: false,
  can_generate_payment_vouchers: false,
};

export default function UserSettingsPage() {
  const db = useMemo(() => createClient(), []);
  const [profiles, setProfiles] = useState<Row[]>([]);
  const [entities, setEntities] = useState<Row[]>([]);
  const [access, setAccess] = useState<Row[]>([]);
  const [permissions, setPermissions] = useState<Row[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [message, setMessage] = useState("Loading staff access...");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [createForm, setCreateForm] = useState({
    email: "",
    displayName: "",
    password: "",
    role: "finance_staff",
    entityIds: [] as string[],
    permissions: defaultPermissions,
  });
  const [editForm, setEditForm] = useState<Row | null>(null);

  useEffect(() => { void load(); }, []);

  async function load() {
    setError("");
    const [profileRes, entityRes, accessRes, permissionRes] = await Promise.all([
      db.from("app_profiles").select("id, email, display_name, role, active_status, created_at").order("display_name"),
      db.from("entities").select("id, short_code, display_name, active_status").eq("active_status", true).order("short_code"),
      db.from("user_entity_access").select("*").order("created_at"),
      db.from("finance_user_permissions").select("*"),
    ]);
    const firstError = profileRes.error || entityRes.error || accessRes.error || permissionRes.error;
    if (firstError) {
      setError(firstError.message);
      setMessage("Only an owner can maintain staff access.");
      return;
    }
    const loadedProfiles = profileRes.data ?? [];
    setProfiles(loadedProfiles);
    setEntities(entityRes.data ?? []);
    setAccess(accessRes.data ?? []);
    setPermissions(permissionRes.data ?? []);
    setMessage("Create a separate staff tester login without changing your owner Gmail access.");
    if (!selectedId && loadedProfiles.find((profile) => profile.role !== "owner")) {
      openEdit(loadedProfiles.find((profile) => profile.role !== "owner"), accessRes.data ?? [], permissionRes.data ?? []);
    }
  }

  function roleDefaults(role: string) {
    return {
      can_view_documents: true,
      can_upload_documents: role !== "read_only",
      can_manage_documents: role === "finance_manager",
      can_view_bank_balances: false,
      can_manage_recurring_bills: role === "finance_manager",
      can_generate_payment_vouchers: role === "finance_manager",
    };
  }

  function openEdit(profile?: Row, loadedAccess = access, loadedPermissions = permissions) {
    if (!profile) return;
    setSelectedId(profile.id);
    const permission = loadedPermissions.find((row) => row.user_id === profile.id) ?? roleDefaults(profile.role);
    setEditForm({
      ...profile,
      entityIds: loadedAccess.filter((row) => row.user_id === profile.id && row.active_status).map((row) => row.entity_id),
      permissions: {
        ...roleDefaults(profile.role),
        ...permission,
        can_view_bank_balances: false,
      },
    });
  }

  function toggleCreateEntity(entityId: string) {
    setCreateForm((form) => ({ ...form, entityIds: toggleId(form.entityIds, entityId) }));
  }

  function toggleEditEntity(entityId: string) {
    if (!editForm) return;
    setEditForm({ ...editForm, entityIds: toggleId(editForm.entityIds, entityId) });
  }

  async function createStaff(event: FormEvent) {
    event.preventDefault();
    if (!createForm.email.trim() || !createForm.password || !createForm.role) {
      setError("Email, temporary password and role are required.");
      return;
    }
    setBusy(true);
    setError("");
    const res = await fetch("/api/admin/users/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(createForm),
    });
    const body = await res.json();
    setBusy(false);
    if (!res.ok) {
      setError(body.error || "Staff login creation failed.");
      return;
    }
    setMessage(`Staff login created for ${body.email}. Existing Users has been refreshed.`);
    setCreateForm({ email: "", displayName: "", password: "", role: "finance_staff", entityIds: [], permissions: defaultPermissions });
    await load();
  }

  async function saveStaff(event: FormEvent) {
    event.preventDefault();
    if (!editForm) return;
    setBusy(true);
    setError("");
    const profileUpdate = await db.from("app_profiles").update({
      display_name: editForm.display_name || null,
      role: editForm.role,
      active_status: Boolean(editForm.active_status),
    }).eq("id", editForm.id);
    if (profileUpdate.error) return finishError(friendlyProfileUpdateError(profileUpdate.error.message));

    if (editForm.role === "owner") {
      await db.from("audit_logs").insert({
        action: "owner_profile_updated",
        entity_type: "app_profile",
        entity_id: editForm.id,
        payload: { display_name: editForm.display_name || null },
      });
      setBusy(false);
      setMessage("Owner display name updated. Printed documents will use display_name where available.");
      await load();
      return;
    }

    const permissionUpdate = await db.from("finance_user_permissions").upsert({
      user_id: editForm.id,
      ...editForm.permissions,
      can_view_bank_balances: false,
    });
    if (permissionUpdate.error) return finishError(permissionUpdate.error.message);

    const accessDelete = await db.from("user_entity_access").delete().eq("user_id", editForm.id);
    if (accessDelete.error) return finishError(accessDelete.error.message);
    if (editForm.entityIds.length) {
      const rows = editForm.entityIds.map((entityId: string) => ({
        user_id: editForm.id,
        entity_id: entityId,
        role: editForm.role,
        can_manage_bills: ["finance_manager", "finance_staff", "data_entry"].includes(editForm.role),
        can_import_bank: false,
        can_reconcile: false,
        can_view_sensitive_balances: Boolean(editForm.permissions.can_view_bank_balances),
        active_status: Boolean(editForm.active_status),
      }));
      const accessInsert = await db.from("user_entity_access").insert(rows);
      if (accessInsert.error) return finishError(accessInsert.error.message);
    }
    await db.from("audit_logs").insert({
      action: "staff_access_updated",
      entity_type: "app_profile",
      entity_id: editForm.id,
      payload: { role: editForm.role, active_status: editForm.active_status, entity_count: editForm.entityIds.length },
    });
    setBusy(false);
    setMessage(editForm.active_status ? "Staff access updated." : "Staff access deactivated. Existing finance records were not deleted.");
    await load();
  }

  function finishError(text: string) {
    setBusy(false);
    setError(text);
  }

  function setCreateRole(role: string) {
    setCreateForm({ ...createForm, role, permissions: roleDefaults(role) });
  }

  function setEditRole(role: string) {
    if (!editForm) return;
    setEditForm({ ...editForm, role, permissions: roleDefaults(role) });
  }

  return (
    <main>
      <header>
        <div>
          <span>Owner Settings</span>
          <h1>Staff Access</h1>
          <p className="subtitle">Invite one or two testers safely. Your owner login remains unchanged.</p>
        </div>
        <AuthBar />
      </header>

      <section className={error ? "notice error" : "notice"}>
        <p>{error || message}</p>
        <button onClick={() => void load()}>Refresh</button>
      </section>

      <section className="grid">
        <section className="panel">
          <h2>Create Staff Tester Login</h2>
          <form onSubmit={createStaff}>
            <label>Email <span className="required-mark">*</span><input type="email" value={createForm.email} onChange={(e) => setCreateForm({ ...createForm, email: e.target.value })} required /></label>
            <label>Display name<input value={createForm.displayName} onChange={(e) => setCreateForm({ ...createForm, displayName: e.target.value })} /></label>
            <label>Temporary password <span className="required-mark">*</span><input type="password" minLength={8} value={createForm.password} onChange={(e) => setCreateForm({ ...createForm, password: e.target.value })} required /></label>
            <label>Role <span className="required-mark">*</span><select value={createForm.role} onChange={(e) => setCreateRole(e.target.value)} required>{staffRoles.map((role) => <option key={role} value={role}>{label(role)}</option>)}</select><span className="help">{roleHelp[createForm.role]}</span></label>
            <fieldset className="wide">
              <legend>Entities for testing</legend>
              <div className="checkgrid">{entities.map((entity) => <label key={entity.id} className="inline"><input type="checkbox" checked={createForm.entityIds.includes(entity.id)} onChange={() => toggleCreateEntity(entity.id)} /> {entity.short_code}</label>)}</div>
            </fieldset>
            <PermissionEditor permissions={createForm.permissions} setPermissions={(next) => setCreateForm({ ...createForm, permissions: next as typeof defaultPermissions })} />
            <button disabled={busy}>{busy ? "Creating..." : "Create Staff Login"}</button>
          </form>
          <p className="help">If this button says the service key is missing, add server-only `SUPABASE_SERVICE_ROLE_KEY` in Vercel or create the Auth user manually in Supabase first.</p>
          <p className="help">Temporary passwords are shown only while you type them here and are never displayed again. For a reset, use Supabase Auth password recovery or set a new temporary password in Supabase.</p>
        </section>

        <section className="panel">
          <h2>Existing Users</h2>
          <UserTable rows={profiles} access={access} entities={entities} onEdit={openEdit} />
        </section>
      </section>

      <section className="panel">
        <h2>Edit Staff Access</h2>
        {!editForm ? <div className="empty">Select a user to edit.</div> : (
          <form onSubmit={saveStaff}>
            <label>Email<input value={editForm.email || ""} readOnly /></label>
            <label>Display name<input value={editForm.display_name || ""} onChange={(e) => setEditForm({ ...editForm, display_name: e.target.value })} /></label>
            <label>Role<select value={editForm.role} onChange={(e) => setEditRole(e.target.value)} disabled={editForm.role === "owner"}>{editForm.role === "owner" && <option value="owner">owner</option>}{staffRoles.map((role) => <option key={role} value={role}>{label(role)}</option>)}</select><span className="help">{editForm.role === "owner" ? "Owner role is protected here. You may update the display name only." : roleHelp[editForm.role]}</span></label>
            <label className="inline"><input type="checkbox" checked={Boolean(editForm.active_status)} onChange={(e) => setEditForm({ ...editForm, active_status: e.target.checked })} /> Active login allowed</label>
            {editForm.role !== "owner" && <fieldset className="wide">
              <legend>Assigned entities</legend>
              <div className="checkgrid">{entities.map((entity) => <label key={entity.id} className="inline"><input type="checkbox" checked={editForm.entityIds.includes(entity.id)} onChange={() => toggleEditEntity(entity.id)} /> {entity.short_code}</label>)}</div>
            </fieldset>}
            {editForm.role !== "owner" && <PermissionEditor permissions={editForm.permissions} setPermissions={(next) => setEditForm({ ...editForm, permissions: next })} />}
            <button disabled={busy}>{busy ? "Saving..." : editForm.role === "owner" ? "Save Owner Display Name" : "Save Staff Access"}</button>
          </form>
        )}
      </section>
    </main>
  );
}

function PermissionEditor({ permissions, setPermissions }: { permissions: Row; setPermissions: (next: Row) => void }) {
  const rows = [
    ["can_view_documents", "View documents"],
    ["can_upload_documents", "Upload documents"],
    ["can_manage_documents", "Archive / manage documents"],
    ["can_manage_recurring_bills", "Manage recurring bills"],
    ["can_generate_payment_vouchers", "Prepare payment vouchers"],
    ["can_view_bank_balances", "View bank balances"],
  ];
  return <fieldset className="wide">
    <legend>Permissions</legend>
    <div className="checkgrid">{rows.map(([key, text]) => <label key={key} className="inline"><input type="checkbox" checked={Boolean(permissions[key])} disabled={key === "can_view_bank_balances"} onChange={(e) => setPermissions({ ...permissions, [key]: e.target.checked })} /> {text}{key === "can_view_bank_balances" ? " - kept off for staff trial" : ""}</label>)}</div>
  </fieldset>;
}

function UserTable({ rows, access, entities, onEdit }: { rows: Row[]; access: Row[]; entities: Row[]; onEdit: (row: Row) => void }) {
  if (!rows.length) return <div className="empty">No users yet.</div>;
  return <div className="table-wrap"><table><thead><tr><th>User</th><th>Role</th><th>Entities</th><th>Status</th><th /></tr></thead><tbody>{rows.map((row) => <tr key={row.id}><td>{row.display_name || "-"}<br />{row.email}{row.role !== "owner" ? <><br /><span className="tag">TRIAL ACCESS</span></> : null}</td><td>{label(row.role)}</td><td>{access.filter((item) => item.user_id === row.id && item.active_status).map((item) => entities.find((entity) => entity.id === item.entity_id)?.short_code).filter(Boolean).join(", ") || (row.role === "owner" ? "All" : "-")}</td><td>{row.active_status ? "Active" : "Inactive"}</td><td><button onClick={() => onEdit(row)}>Edit</button></td></tr>)}</tbody></table></div>;
}

function toggleId(ids: string[], id: string) {
  return ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id];
}

function label(value: unknown) {
  return String(value ?? "").replaceAll("_", " ");
}
