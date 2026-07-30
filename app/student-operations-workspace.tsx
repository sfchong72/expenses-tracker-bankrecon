"use client";

import Link from "next/link";
import { FormEvent, useEffect, useMemo, useState } from "react";
import { AuthBar } from "@/app/auth-bar";
import { createClient } from "@/lib/supabase/client";

type Row = Record<string, any>;
type Mode = "dashboard" | "students" | "student-form" | "student-detail" | "programmes" | "intakes" | "enrolments" | "enrolment-form";

const today = new Date().toISOString().slice(0, 10);

const blankStudent = {
  id: "",
  entity_id: "",
  full_name: "",
  preferred_name: "",
  identity_document_type: "ic",
  identity_number_protected: "",
  nationality: "Malaysian",
  date_of_birth: "",
  gender: "",
  phone: "",
  email: "",
  address: "",
  emergency_contact_name: "",
  emergency_contact_phone: "",
  emergency_contact_relationship: "",
  previous_school: "",
  education_level: "",
  home_branch_id: "",
  active_status: true,
  remarks: "",
};

const blankProgramme = {
  id: "",
  entity_id: "",
  programme_code: "",
  programme_name: "",
  description: "",
  programme_type: "",
  duration_text: "",
  indicative_standard_fee: "",
  active_status: true,
};

const blankIntake = {
  id: "",
  programme_id: "",
  entity_id: "",
  branch_id: "",
  intake_code: "",
  intake_name: "",
  start_date: today,
  expected_completion_date: "",
  application_closing_date: "",
  capacity: "",
  status: "open",
  remarks: "",
};

const blankEnrolment = {
  id: "",
  student_id: "",
  programme_id: "",
  intake_id: "",
  entity_id: "",
  branch_id: "",
  counsellor_user_id: "",
  enrolment_date: today,
  expected_completion_date: "",
  status: "enrolled",
  referral_source: "",
  remarks: "",
};

const csvValue = (value: unknown) => `"${String(value ?? "").replaceAll("\"", "\"\"")}"`;

export function StudentOperationsWorkspace({ mode, id }: { mode: Mode; id?: string }) {
  const db = useMemo(() => createClient(), []);
  const [message, setMessage] = useState("Loading Student Operations...");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [entities, setEntities] = useState<Row[]>([]);
  const [branches, setBranches] = useState<Row[]>([]);
  const [profiles, setProfiles] = useState<Row[]>([]);
  const [students, setStudents] = useState<Row[]>([]);
  const [programmes, setProgrammes] = useState<Row[]>([]);
  const [intakes, setIntakes] = useState<Row[]>([]);
  const [enrolments, setEnrolments] = useState<Row[]>([]);
  const [duplicates, setDuplicates] = useState<Row[]>([]);
  const [filters, setFilters] = useState({ q: "", entity_id: "", branch_id: "", status: "" });
  const [studentForm, setStudentForm] = useState<Row>(blankStudent);
  const [programmeForm, setProgrammeForm] = useState<Row>(blankProgramme);
  const [intakeForm, setIntakeForm] = useState<Row>(blankIntake);
  const [enrolmentForm, setEnrolmentForm] = useState<Row>(blankEnrolment);
  const [mergeTargetId, setMergeTargetId] = useState("");
  const [mergeReason, setMergeReason] = useState("");

  useEffect(() => { void load(); }, []);
  useEffect(() => {
    if (mode === "student-detail" && id && students.length) {
      const row = students.find((item) => item.id === id);
      if (row) setStudentForm({ ...blankStudent, ...row, identity_number_protected: "", emergency_contact_name: row.emergency_contact?.name || "", emergency_contact_phone: row.emergency_contact?.phone || "", emergency_contact_relationship: row.emergency_contact?.relationship || "" });
    }
  }, [mode, id, students]);

  async function load() {
    setError("");
    const [entityRes, branchRes, profileRes, studentRes, programmeRes, intakeRes, enrolmentRes, duplicateRes] = await Promise.all([
      db.from("entities").select("id, short_code, display_name").eq("active_status", true).order("short_code"),
      db.from("branches").select("*").eq("active_status", true).order("branch_code"),
      db.from("app_profiles").select("id, display_name, email, role").eq("active_status", true).order("display_name"),
      db.from("students_staff_safe").select("*").eq("is_demo", false).order("created_at", { ascending: false }),
      db.from("programmes").select("*").eq("is_demo", false).order("programme_code"),
      db.from("programme_intakes").select("*").eq("is_demo", false).order("start_date", { ascending: false }),
      db.from("enrolments_staff_safe").select("*").eq("is_demo", false).order("created_at", { ascending: false }),
      db.from("student_duplicate_warning_view").select("*"),
    ]);
    const firstError = entityRes.error || branchRes.error || profileRes.error || studentRes.error || programmeRes.error || intakeRes.error || enrolmentRes.error || duplicateRes.error;
    if (firstError) {
      setError(firstError.message);
      setMessage("Apply migrations 0013 and 0014 before testing Student Operations.");
      return;
    }
    setEntities(entityRes.data ?? []);
    setBranches(branchRes.data ?? []);
    setProfiles(profileRes.data ?? []);
    setStudents(studentRes.data ?? []);
    setProgrammes(programmeRes.data ?? []);
    setIntakes(intakeRes.data ?? []);
    setEnrolments(enrolmentRes.data ?? []);
    setDuplicates(duplicateRes.data ?? []);
    setMessage("Student Operations Stage 1A ready: student master, programmes, intakes and enrolments.");
    setDefaultEntity(entityRes.data ?? [], branchRes.data ?? []);
  }

  function setDefaultEntity(nextEntities: Row[], nextBranches: Row[]) {
    const firstEntity = nextEntities[0]?.id || "";
    const firstBranch = nextBranches.find((branch) => branch.entity_id === firstEntity)?.id || "";
    setStudentForm((form) => form.entity_id ? form : { ...form, entity_id: firstEntity, home_branch_id: firstBranch });
    setProgrammeForm((form) => form.entity_id ? form : { ...form, entity_id: firstEntity });
    setIntakeForm((form) => form.entity_id ? form : { ...form, entity_id: firstEntity, branch_id: firstBranch });
    setEnrolmentForm((form) => form.entity_id ? form : { ...form, entity_id: firstEntity, branch_id: firstBranch });
  }

  const scopedBranches = branches.filter((branch) => !filters.entity_id || branch.entity_id === filters.entity_id);
  const filteredStudents = students.filter((student) => matchesFilters(student, ["full_name", "student_number", "email", "phone"]));
  const filteredProgrammes = programmes.filter((programme) => matchesFilters(programme, ["programme_code", "programme_name", "programme_type"]));
  const filteredIntakes = intakes.filter((intake) => matchesFilters(intake, ["intake_code", "intake_name", "status"]));
  const filteredEnrolments = enrolments.filter((enrolment) => matchesFilters(enrolment, ["enrolment_number", "student_name", "programme_name", "intake_code", "status"]));
  const selectedStudent = id ? students.find((student) => student.id === id) : undefined;
  const selectedStudentEnrolments = selectedStudent ? enrolments.filter((row) => row.student_id === selectedStudent.id) : [];
  const selectedStudentDuplicates = selectedStudent ? duplicates.filter((row) => row.student_id === selectedStudent.id || row.possible_duplicate_student_id === selectedStudent.id) : [];

  function matchesFilters(row: Row, keys: string[]) {
    const q = filters.q.toLowerCase().trim();
    const textMatch = !q || keys.some((key) => String(row[key] || "").toLowerCase().includes(q));
    const entityMatch = !filters.entity_id || row.entity_id === filters.entity_id;
    const branchMatch = !filters.branch_id || row.branch_id === filters.branch_id || row.home_branch_id === filters.branch_id;
    const statusMatch = !filters.status || row.status === filters.status || String(row.active_status) === filters.status || row.lifecycle_status === filters.status;
    return textMatch && entityMatch && branchMatch && statusMatch;
  }

  function branchLabel(branchId: string) {
    const branch = branches.find((item) => item.id === branchId);
    return branch ? `${branch.branch_code} - ${branch.branch_name}` : "";
  }

  function programmeLabel(programmeId: string) {
    const programme = programmes.find((item) => item.id === programmeId);
    return programme ? `${programme.programme_code} - ${programme.programme_name}` : "";
  }

  function resetStudent() {
    setStudentForm({ ...blankStudent, entity_id: entities[0]?.id || "", home_branch_id: branches.find((branch) => branch.entity_id === entities[0]?.id)?.id || "" });
    setMessage("New student form ready.");
  }

  async function saveStudent(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const res = await fetch("/api/students/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...studentForm,
        emergency_contact: {
          name: studentForm.emergency_contact_name,
          phone: studentForm.emergency_contact_phone,
          relationship: studentForm.emergency_contact_relationship,
        },
      }),
    });
    const json = await res.json();
    setBusy(false);
    if (!res.ok) {
      setError(json.error || "Could not save student.");
      return;
    }
    setMessage(`Student saved${json.student_number ? ` as ${json.student_number}` : ""}. ${json.duplicate_warnings?.length ? "Duplicate warnings need review." : ""}`);
    await load();
    if (!studentForm.id) resetStudent();
  }

  async function saveProgramme(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    const payload: Row = {
      ...programmeForm,
      indicative_standard_fee: programmeForm.indicative_standard_fee ? Number(programmeForm.indicative_standard_fee) : null,
    };
    const res = programmeForm.id
      ? await db.from("programmes").update(payload).eq("id", programmeForm.id)
      : await db.from("programmes").insert(payload);
    setBusy(false);
    if (res.error) {
      setError(res.error.message);
      return;
    }
    setMessage("Programme saved.");
    setProgrammeForm({ ...blankProgramme, entity_id: programmeForm.entity_id });
    await load();
  }

  async function saveIntake(event: FormEvent) {
    event.preventDefault();
    const programme = programmes.find((item) => item.id === intakeForm.programme_id);
    const payload: Row = {
      ...intakeForm,
      entity_id: programme?.entity_id || intakeForm.entity_id,
      capacity: intakeForm.capacity ? Number(intakeForm.capacity) : null,
      expected_completion_date: intakeForm.expected_completion_date || null,
      application_closing_date: intakeForm.application_closing_date || null,
    };
    setBusy(true);
    const res = intakeForm.id
      ? await db.from("programme_intakes").update(payload).eq("id", intakeForm.id)
      : await db.from("programme_intakes").insert(payload);
    setBusy(false);
    if (res.error) {
      setError(res.error.message);
      return;
    }
    setMessage("Intake saved.");
    setIntakeForm({ ...blankIntake, entity_id: payload.entity_id, branch_id: payload.branch_id });
    await load();
  }

  async function saveEnrolment(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const res = await fetch("/api/enrolments/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(enrolmentForm),
    });
    const json = await res.json();
    setBusy(false);
    if (!res.ok) {
      setError(json.error || "Could not save enrolment.");
      return;
    }
    setMessage(`Enrolment saved${json.enrolment_number ? ` as ${json.enrolment_number}` : ""}.`);
    setEnrolmentForm({ ...blankEnrolment, entity_id: enrolmentForm.entity_id, branch_id: enrolmentForm.branch_id });
    await load();
  }

  async function mergeStudent() {
    if (!selectedStudent || !mergeTargetId || !mergeReason.trim()) {
      setError("Choose the target student and enter a merge reason first.");
      return;
    }
    if (!window.confirm("Merge this student into the selected target? The source student will be inactive, not deleted.")) return;
    setBusy(true);
    const res = await fetch("/api/students/merge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source_student_id: selectedStudent.id, target_student_id: mergeTargetId, reason: mergeReason }),
    });
    const json = await res.json();
    setBusy(false);
    if (!res.ok) {
      setError(json.error || "Could not merge students.");
      return;
    }
    setMessage("Students merged. Enrolments and document links were preserved.");
    await load();
  }

  function exportRows(filename: string, rows: Row[], columns: string[]) {
    const csv = [columns.join(","), ...rows.map((row) => columns.map((column) => csvValue(row[column])).join(","))].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <main>
      <div className="page-header">
        <div>
          <p className="eyebrow">Student Operations</p>
          <h1>{titleFor(mode)}</h1>
          <p className="subtitle">Stage 1A: student master, programmes, intakes and enrolments. Fees, collections and receipts are intentionally not active yet.</p>
        </div>
        <AuthBar />
      </div>

      <WorkspaceTabs />

      <section className={error ? "notice error" : "notice"}>
        <p>{error || message}</p>
        <button onClick={() => void load()} disabled={busy}>Refresh</button>
      </section>

      {mode === "dashboard" && (
        <>
          <section className="metric-grid">
            <Metric label="Students" value={students.length} />
            <Metric label="Programmes" value={programmes.length} />
            <Metric label="Intakes" value={intakes.length} />
            <Metric label="Enrolments" value={enrolments.length} />
          </section>
          <section className="split-grid">
            <Panel title="Stage 1A Workflow">
              <ol className="workflow-list">
                <li><strong>Create programme master</strong><span>Keep programme definitions entity-level, not permanently branch-specific.</span></li>
                <li><strong>Create branch intake</strong><span>Use intake/offering to record KL, Penang or Johor branch dates.</span></li>
                <li><strong>Create student master</strong><span>One person profile; branch participation belongs to enrolments.</span></li>
                <li><strong>Create enrolment</strong><span>Generate branch/intake enrolment number and assign counsellor.</span></li>
              </ol>
            </Panel>
            <Panel title="Attention">
              <Quick href="/students" label="Possible duplicates" detail={`${duplicates.length} warning rows`} />
              <Quick href="/enrolments" label="Active enrolments" detail={`${enrolments.filter((row) => ["enrolled", "active"].includes(row.status)).length} records`} />
              <Quick href="/programmes" label="Programmes" detail="Maintain master programme details and indicative defaults" />
            </Panel>
          </section>
        </>
      )}

      {["students", "programmes", "intakes", "enrolments"].includes(mode) && <Filters filters={filters} setFilters={setFilters} entities={entities} branches={scopedBranches} />}

      {mode === "students" && (
        <Panel title="Students">
          <div className="button-row">
            <Link className="button-link" href="/students/new">New Student</Link>
            <button className="neutral" onClick={() => exportRows("students-stage1a.csv", filteredStudents, ["entity_code", "student_number", "full_name", "preferred_name", "identity_number_masked", "phone", "email", "home_branch_code", "active_status"])}>Export CSV</button>
          </div>
          <Table rows={filteredStudents} empty="No students yet." columns={[
            ["student_number", "Student No."],
            ["full_name", "Name"],
            ["identity_number_masked", "IC/Passport"],
            ["phone", "Phone"],
            ["email", "Email"],
            ["home_branch_code", "Home Branch"],
            ["active_status", "Active"],
          ]} action={(row) => <Link href={`/students/${row.id}`}>Open</Link>} />
        </Panel>
      )}

      {(mode === "student-form" || mode === "student-detail") && (
        <section className="split-grid">
          <Panel title={selectedStudent ? "Edit Student" : "New Student"}>
            <StudentForm form={studentForm} setForm={setStudentForm} entities={entities} branches={branches} onSubmit={saveStudent} busy={busy} />
          </Panel>
          <Panel title="Student Record">
            {selectedStudent ? (
              <>
                <p><strong>{selectedStudent.student_number}</strong></p>
                <p>{selectedStudent.full_name}</p>
                <p className="help">Protected identity is shown only as {selectedStudent.identity_number_masked || "not recorded"} in normal views.</p>
                <h3>Enrolments</h3>
                <Table rows={selectedStudentEnrolments} empty="No enrolments yet." columns={[["enrolment_number", "No."], ["programme_name", "Programme"], ["intake_code", "Intake"], ["branch_code", "Branch"], ["status", "Status"]]} />
                <h3>Duplicate Review</h3>
                <Table rows={selectedStudentDuplicates} empty="No duplicate warnings." columns={[["possible_duplicate_student_number", "Possible No."], ["possible_duplicate_name", "Possible Name"], ["match_reason", "Reason"], ["match_strength", "Strength"]]} />
                <div className="mini">
                  <label>Merge this student into
                    <select value={mergeTargetId} onChange={(event) => setMergeTargetId(event.target.value)}>
                      <option value="">Choose target student</option>
                      {students.filter((row) => row.id !== selectedStudent.id).map((row) => <option key={row.id} value={row.id}>{row.student_number} - {row.full_name}</option>)}
                    </select>
                  </label>
                  <label>Merge reason<textarea value={mergeReason} onChange={(event) => setMergeReason(event.target.value)} /></label>
                  <button className="danger" onClick={() => void mergeStudent()} disabled={busy}>Merge Duplicate</button>
                </div>
              </>
            ) : (
              <p className="empty-state">Save the student first, then enrolments and duplicate review will appear here.</p>
            )}
          </Panel>
        </section>
      )}

      {mode === "programmes" && (
        <section className="split-grid">
          <Panel title="Programme Master">
            <ProgrammeForm form={programmeForm} setForm={setProgrammeForm} entities={entities} onSubmit={saveProgramme} busy={busy} />
          </Panel>
          <Panel title="Programmes">
            <button className="neutral" onClick={() => exportRows("programmes-stage1a.csv", filteredProgrammes, ["programme_code", "programme_name", "programme_type", "duration_text", "indicative_standard_fee", "active_status"])}>Export CSV</button>
            <Table rows={filteredProgrammes} empty="No programmes yet." columns={[["programme_code", "Code"], ["programme_name", "Programme"], ["programme_type", "Type"], ["duration_text", "Duration"], ["indicative_standard_fee", "Indicative Fee"], ["active_status", "Active"]]} action={(row) => <button className="neutral" onClick={() => setProgrammeForm({ ...blankProgramme, ...row })}>Edit</button>} />
          </Panel>
        </section>
      )}

      {mode === "intakes" && (
        <section className="split-grid">
          <Panel title="Programme Intake / Offering">
            <IntakeForm form={intakeForm} setForm={setIntakeForm} programmes={programmes} branches={branches} onSubmit={saveIntake} busy={busy} />
          </Panel>
          <Panel title="Intakes">
            <button className="neutral" onClick={() => exportRows("intakes-stage1a.csv", filteredIntakes.map((row) => ({ ...row, programme: programmeLabel(row.programme_id), branch: branchLabel(row.branch_id) })), ["programme", "branch", "intake_code", "start_date", "expected_completion_date", "status", "capacity"])}>Export CSV</button>
            <Table rows={filteredIntakes} empty="No intakes yet." columns={[["intake_code", "Intake"], ["start_date", "Start"], ["expected_completion_date", "Completion"], ["status", "Status"], ["capacity", "Capacity"]]} action={(row) => <button className="neutral" onClick={() => setIntakeForm({ ...blankIntake, ...row, capacity: row.capacity || "" })}>Edit</button>} />
          </Panel>
        </section>
      )}

      {mode === "enrolments" && (
        <Panel title="Enrolments">
          <div className="button-row">
            <Link className="button-link" href="/enrolments/new">New Enrolment</Link>
            <button className="neutral" onClick={() => exportRows("enrolments-stage1a.csv", filteredEnrolments, ["entity_code", "branch_code", "enrolment_number", "student_name", "programme_code", "programme_name", "intake_code", "counsellor_name", "enrolment_date", "status"])}>Export CSV</button>
          </div>
          <Table rows={filteredEnrolments} empty="No enrolments yet." columns={[["enrolment_number", "No."], ["student_name", "Student"], ["programme_name", "Programme"], ["intake_code", "Intake"], ["branch_code", "Branch"], ["counsellor_name", "Counsellor"], ["status", "Status"]]} />
        </Panel>
      )}

      {mode === "enrolment-form" && (
        <section className="split-grid">
          <Panel title="New Enrolment">
            <EnrolmentForm form={enrolmentForm} setForm={setEnrolmentForm} students={students} programmes={programmes} intakes={intakes} branches={branches} profiles={profiles} onSubmit={saveEnrolment} busy={busy} />
          </Panel>
          <Panel title="Numbering">
            <p className="help">The enrolment number is generated only when the enrolment is saved.</p>
            <p className="tag">Format: IETA-KL-ID32-26-001</p>
            <p>Student number remains permanent and does not include branch.</p>
          </Panel>
        </section>
      )}
    </main>
  );
}

function titleFor(mode: Mode) {
  if (mode === "students") return "Students";
  if (mode === "student-form") return "New Student";
  if (mode === "student-detail") return "Student Detail";
  if (mode === "programmes") return "Programmes";
  if (mode === "intakes") return "Intakes";
  if (mode === "enrolments") return "Enrolments";
  if (mode === "enrolment-form") return "New Enrolment";
  return "Student Operations Dashboard";
}

function WorkspaceTabs() {
  const tabs = [
    ["/student-operations", "Dashboard"],
    ["/students", "Students"],
    ["/programmes", "Programmes"],
    ["/intakes", "Intakes"],
    ["/enrolments", "Enrolments"],
  ];
  return <nav>{tabs.map(([href, label]) => <Link key={href} href={href}>{label}</Link>)}</nav>;
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return <div><span>{label}</span><strong>{value}</strong></div>;
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="panel"><h2>{title}</h2>{children}</section>;
}

function Quick({ href, label, detail }: { href: string; label: string; detail: string }) {
  return <Link className="inline-card" href={href}><strong>{label}</strong><span>{detail}</span><span>Open</span></Link>;
}

function Filters({ filters, setFilters, entities, branches }: { filters: Row; setFilters: (next: any) => void; entities: Row[]; branches: Row[] }) {
  return (
    <section className="panel">
      <div className="form-grid">
        <label>Search<input value={filters.q} onChange={(event) => setFilters({ ...filters, q: event.target.value })} placeholder="Name, number, intake, phone..." /></label>
        <label>Entity<select value={filters.entity_id} onChange={(event) => setFilters({ ...filters, entity_id: event.target.value, branch_id: "" })}><option value="">All entities</option>{entities.map((entity) => <option key={entity.id} value={entity.id}>{entity.short_code}</option>)}</select></label>
        <label>Branch<select value={filters.branch_id} onChange={(event) => setFilters({ ...filters, branch_id: event.target.value })}><option value="">All branches</option>{branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.branch_code} - {branch.branch_name}</option>)}</select></label>
        <label>Status<input value={filters.status} onChange={(event) => setFilters({ ...filters, status: event.target.value })} placeholder="active, enrolled, open..." /></label>
      </div>
    </section>
  );
}

function Table({ rows, columns, empty, action }: { rows: Row[]; columns: string[][]; empty: string; action?: (row: Row) => React.ReactNode }) {
  if (!rows.length) return <p className="empty-state">{empty}</p>;
  return (
    <div className="table-wrap">
      <table>
        <thead><tr>{columns.map(([key, label]) => <th key={key}>{label}</th>)}{action && <th>Action</th>}</tr></thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id || `${row.student_id}-${row.possible_duplicate_student_id}`}>
              {columns.map(([key]) => <td key={key}>{formatCell(row[key])}</td>)}
              {action && <td>{action(row)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function formatCell(value: unknown) {
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") return value.toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return String(value ?? "");
}

function StudentForm({ form, setForm, entities, branches, onSubmit, busy }: { form: Row; setForm: (next: Row) => void; entities: Row[]; branches: Row[]; onSubmit: (event: FormEvent) => void; busy: boolean }) {
  const entityBranches = branches.filter((branch) => branch.entity_id === form.entity_id);
  return (
    <form onSubmit={onSubmit}>
      <label>Entity<select value={form.entity_id} onChange={(event) => setForm({ ...form, entity_id: event.target.value, home_branch_id: "" })} required>{entities.map((entity) => <option key={entity.id} value={entity.id}>{entity.short_code}</option>)}</select></label>
      <label>Home branch<select value={form.home_branch_id || ""} onChange={(event) => setForm({ ...form, home_branch_id: event.target.value })}><option value="">No home branch</option>{entityBranches.map((branch) => <option key={branch.id} value={branch.id}>{branch.branch_code} - {branch.branch_name}</option>)}</select></label>
      <label>Full name<input value={form.full_name} onChange={(event) => setForm({ ...form, full_name: event.target.value })} required /></label>
      <label>Preferred name<input value={form.preferred_name || ""} onChange={(event) => setForm({ ...form, preferred_name: event.target.value })} /></label>
      <label>IC/passport type<select value={form.identity_document_type || ""} onChange={(event) => setForm({ ...form, identity_document_type: event.target.value })}><option value="">Not recorded</option><option value="ic">IC</option><option value="passport">Passport</option><option value="other">Other</option></select></label>
      <label>IC/passport number<input value={form.identity_number_protected || ""} onChange={(event) => setForm({ ...form, identity_number_protected: event.target.value })} placeholder={form.id ? "Leave blank to keep unchanged" : ""} /></label>
      <label>Nationality<input value={form.nationality || ""} onChange={(event) => setForm({ ...form, nationality: event.target.value })} /></label>
      <label>Date of birth<input type="date" value={form.date_of_birth || ""} onChange={(event) => setForm({ ...form, date_of_birth: event.target.value })} /></label>
      <label>Gender<select value={form.gender || ""} onChange={(event) => setForm({ ...form, gender: event.target.value })}><option value="">Choose</option><option value="female">Female</option><option value="male">Male</option><option value="other">Other</option><option value="prefer_not_to_say">Prefer not to say</option></select></label>
      <label>Phone<input value={form.phone || ""} onChange={(event) => setForm({ ...form, phone: event.target.value })} /></label>
      <label>Email<input type="email" value={form.email || ""} onChange={(event) => setForm({ ...form, email: event.target.value })} /></label>
      <label>Previous school<input value={form.previous_school || ""} onChange={(event) => setForm({ ...form, previous_school: event.target.value })} /></label>
      <label>Education level<input value={form.education_level || ""} onChange={(event) => setForm({ ...form, education_level: event.target.value })} /></label>
      <label>Emergency contact name<input value={form.emergency_contact_name || ""} onChange={(event) => setForm({ ...form, emergency_contact_name: event.target.value })} /></label>
      <label>Emergency contact phone<input value={form.emergency_contact_phone || ""} onChange={(event) => setForm({ ...form, emergency_contact_phone: event.target.value })} /></label>
      <label>Relationship<input value={form.emergency_contact_relationship || ""} onChange={(event) => setForm({ ...form, emergency_contact_relationship: event.target.value })} /></label>
      <label className="wide">Address<textarea value={form.address || ""} onChange={(event) => setForm({ ...form, address: event.target.value })} /></label>
      <label className="wide">Remarks<textarea value={form.remarks || ""} onChange={(event) => setForm({ ...form, remarks: event.target.value })} /></label>
      <label className="inline"><input type="checkbox" checked={Boolean(form.active_status)} onChange={(event) => setForm({ ...form, active_status: event.target.checked })} /> Active student</label>
      <button disabled={busy}>{form.id ? "Save Student" : "Create Student"}</button>
    </form>
  );
}

function ProgrammeForm({ form, setForm, entities, onSubmit, busy }: { form: Row; setForm: (next: Row) => void; entities: Row[]; onSubmit: (event: FormEvent) => void; busy: boolean }) {
  return (
    <form onSubmit={onSubmit}>
      <label>Entity<select value={form.entity_id} onChange={(event) => setForm({ ...form, entity_id: event.target.value })} required>{entities.map((entity) => <option key={entity.id} value={entity.id}>{entity.short_code}</option>)}</select></label>
      <label>Programme code<input value={form.programme_code} onChange={(event) => setForm({ ...form, programme_code: event.target.value.toUpperCase() })} required /></label>
      <label>Programme name<input value={form.programme_name} onChange={(event) => setForm({ ...form, programme_name: event.target.value })} required /></label>
      <label>Programme type<input value={form.programme_type || ""} onChange={(event) => setForm({ ...form, programme_type: event.target.value })} /></label>
      <label>Duration<input value={form.duration_text || ""} onChange={(event) => setForm({ ...form, duration_text: event.target.value })} /></label>
      <label>Indicative default fee<input type="number" step="0.01" value={form.indicative_standard_fee || ""} onChange={(event) => setForm({ ...form, indicative_standard_fee: event.target.value })} /></label>
      <label className="wide">Description<textarea value={form.description || ""} onChange={(event) => setForm({ ...form, description: event.target.value })} /></label>
      <label className="inline"><input type="checkbox" checked={Boolean(form.active_status)} onChange={(event) => setForm({ ...form, active_status: event.target.checked })} /> Active programme</label>
      <button disabled={busy}>Save Programme</button>
    </form>
  );
}

function IntakeForm({ form, setForm, programmes, branches, onSubmit, busy }: { form: Row; setForm: (next: Row) => void; programmes: Row[]; branches: Row[]; onSubmit: (event: FormEvent) => void; busy: boolean }) {
  const programme = programmes.find((item) => item.id === form.programme_id);
  const branchOptions = branches.filter((branch) => !programme || branch.entity_id === programme.entity_id);
  return (
    <form onSubmit={onSubmit}>
      <label>Programme<select value={form.programme_id} onChange={(event) => setForm({ ...form, programme_id: event.target.value, entity_id: programmes.find((item) => item.id === event.target.value)?.entity_id || form.entity_id })} required><option value="">Choose</option>{programmes.map((programmeRow) => <option key={programmeRow.id} value={programmeRow.id}>{programmeRow.programme_code} - {programmeRow.programme_name}</option>)}</select></label>
      <label>Branch<select value={form.branch_id} onChange={(event) => setForm({ ...form, branch_id: event.target.value })} required><option value="">Choose</option>{branchOptions.map((branch) => <option key={branch.id} value={branch.id}>{branch.branch_code} - {branch.branch_name}</option>)}</select></label>
      <label>Intake code<input value={form.intake_code} onChange={(event) => setForm({ ...form, intake_code: event.target.value.toUpperCase() })} required /></label>
      <label>Intake name<input value={form.intake_name || ""} onChange={(event) => setForm({ ...form, intake_name: event.target.value })} /></label>
      <label>Start date<input type="date" value={form.start_date} onChange={(event) => setForm({ ...form, start_date: event.target.value })} required /></label>
      <label>Expected completion<input type="date" value={form.expected_completion_date || ""} onChange={(event) => setForm({ ...form, expected_completion_date: event.target.value })} /></label>
      <label>Application closing<input type="date" value={form.application_closing_date || ""} onChange={(event) => setForm({ ...form, application_closing_date: event.target.value })} /></label>
      <label>Capacity<input type="number" value={form.capacity || ""} onChange={(event) => setForm({ ...form, capacity: event.target.value })} /></label>
      <label>Status<select value={form.status} onChange={(event) => setForm({ ...form, status: event.target.value })}>{["planning", "open", "closed", "in_progress", "completed", "cancelled", "inactive"].map((status) => <option key={status} value={status}>{status}</option>)}</select></label>
      <label className="wide">Remarks<textarea value={form.remarks || ""} onChange={(event) => setForm({ ...form, remarks: event.target.value })} /></label>
      <button disabled={busy}>Save Intake</button>
    </form>
  );
}

function EnrolmentForm({ form, setForm, students, programmes, intakes, branches, profiles, onSubmit, busy }: { form: Row; setForm: (next: Row) => void; students: Row[]; programmes: Row[]; intakes: Row[]; branches: Row[]; profiles: Row[]; onSubmit: (event: FormEvent) => void; busy: boolean }) {
  const programmeIntakes = intakes.filter((intake) => !form.programme_id || intake.programme_id === form.programme_id);
  return (
    <form onSubmit={onSubmit}>
      <label>Student<select value={form.student_id} onChange={(event) => setForm({ ...form, student_id: event.target.value })} required><option value="">Choose</option>{students.map((student) => <option key={student.id} value={student.id}>{student.student_number} - {student.full_name}</option>)}</select></label>
      <label>Programme<select value={form.programme_id} onChange={(event) => setForm({ ...form, programme_id: event.target.value, intake_id: "" })} required><option value="">Choose</option>{programmes.map((programme) => <option key={programme.id} value={programme.id}>{programme.programme_code} - {programme.programme_name}</option>)}</select></label>
      <label>Intake<select value={form.intake_id} onChange={(event) => { const intake = intakes.find((item) => item.id === event.target.value); setForm({ ...form, intake_id: event.target.value, entity_id: intake?.entity_id || form.entity_id, branch_id: intake?.branch_id || form.branch_id, expected_completion_date: intake?.expected_completion_date || form.expected_completion_date }); }} required><option value="">Choose</option>{programmeIntakes.map((intake) => <option key={intake.id} value={intake.id}>{intake.intake_code} - {branches.find((branch) => branch.id === intake.branch_id)?.branch_code || ""}</option>)}</select></label>
      <label>Branch<select value={form.branch_id} onChange={(event) => setForm({ ...form, branch_id: event.target.value })} required>{branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.branch_code} - {branch.branch_name}</option>)}</select></label>
      <label>Counsellor<select value={form.counsellor_user_id || ""} onChange={(event) => setForm({ ...form, counsellor_user_id: event.target.value })}><option value="">Not assigned</option>{profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.display_name || profile.email}</option>)}</select></label>
      <label>Enrolment date<input type="date" value={form.enrolment_date} onChange={(event) => setForm({ ...form, enrolment_date: event.target.value })} required /></label>
      <label>Expected completion<input type="date" value={form.expected_completion_date || ""} onChange={(event) => setForm({ ...form, expected_completion_date: event.target.value })} /></label>
      <label>Status<select value={form.status} onChange={(event) => setForm({ ...form, status: event.target.value })}>{["draft", "applied", "enrolled", "active", "deferred", "transferred", "completed", "withdrawn", "cancelled", "inactive"].map((status) => <option key={status} value={status}>{status}</option>)}</select></label>
      <label>Referral/source<input value={form.referral_source || ""} onChange={(event) => setForm({ ...form, referral_source: event.target.value })} /></label>
      <label className="wide">Remarks<textarea value={form.remarks || ""} onChange={(event) => setForm({ ...form, remarks: event.target.value })} /></label>
      <button disabled={busy}>Save Enrolment</button>
    </form>
  );
}
