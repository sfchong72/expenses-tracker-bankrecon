"use client";

import Link from "next/link";
import { FormEvent, useEffect, useMemo, useState } from "react";
import { AuthBar } from "@/app/auth-bar";
import { createClient } from "@/lib/supabase/client";
import { suggestedCompletionDate } from "@/lib/programme-duration";

type Row = Record<string, any>;
type Mode = "dashboard" | "students" | "student-form" | "student-detail" | "programmes" | "intakes" | "enrolments" | "enrolment-form";

const today = new Date().toISOString().slice(0, 10);
const NATIONALITIES = ["Malaysian", "Japanese", "Korean", "Chinese", "Indonesian", "Vietnamese", "Filipino", "Thai", "Singaporean", "Kazakhstani"];
const EDUCATION_LEVELS = ["SPM", "UEC", "O Level", "A Level", "STPM", "Certificate", "Diploma", "Advanced Diploma", "Degree", "Master's Degree", "Other"];
const MALAYSIAN_STATES = ["Johor", "Kedah", "Kelantan", "Melaka", "Negeri Sembilan", "Pahang", "Perak", "Perlis", "Pulau Pinang", "Sabah", "Sarawak", "Selangor", "Terengganu", "Kuala Lumpur", "Labuan", "Putrajaya"];
const IETA_STUDENT_BRANCH_CODES = ["KL", "PG"];

const blankStudent = {
  id: "",
  entity_id: "",
  full_name: "",
  preferred_name: "",
  identity_document_type: "ic",
  identity_number_protected: "",
  nationality: "Malaysian",
  _nationality_other: false,
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
  qualification_details: "",
  education_institution: "",
  field_of_study: "",
  graduation_year: "",
  home_branch_id: "",
  city: "",
  state: "",
  postcode: "",
  country: "Malaysia",
  height_cm: "",
  weight_kg: "",
  uniform_size: "",
  measurement_date: "",
  measurement_remarks: "",
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
  duration_value: "",
  duration_max_value: "",
  duration_unit: "months",
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
  original_expected_completion_date: "",
  application_closing_date: "",
  actual_completion_date: "",
  capacity: "",
  status: "open",
  completion_timing: "not_applicable",
  completion_reason: "",
  _completion_manual: false,
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

function branchesForEntity(branches: Row[], entities: Row[], entityId: string) {
  const entity = entities.find((item) => item.id === entityId);
  return branches.filter((branch) =>
    branch.entity_id === entityId
    && (entity?.short_code !== "IETA" || IETA_STUDENT_BRANCH_CODES.includes(branch.branch_code)),
  );
}

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
      console.error("Student Operations load failed", firstError);
      setError("Student Operations could not be loaded. Please refresh after applying the latest migration.");
      setMessage("Apply migrations through 0015 before testing the Stage 1A UAT repair.");
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
    const ieta = nextEntities.find((entity) => entity.short_code === "IETA") || nextEntities[0];
    const entityId = ieta?.id || "";
    const studentBranches = branchesForEntity(nextBranches, nextEntities, entityId);
    const firstBranch = studentBranches.find((branch) => branch.branch_code === "KL")?.id || studentBranches[0]?.id || "";
    setFilters((current) => current.entity_id ? current : { ...current, entity_id: entityId });
    setStudentForm((form) => form.entity_id ? form : { ...form, entity_id: entityId, home_branch_id: firstBranch });
    setProgrammeForm((form) => form.entity_id ? form : { ...form, entity_id: entityId });
    setIntakeForm((form) => form.entity_id ? form : { ...form, entity_id: entityId, branch_id: firstBranch });
    setEnrolmentForm((form) => form.entity_id ? form : { ...form, entity_id: entityId, branch_id: firstBranch });
  }

  const scopedBranches = filters.entity_id
    ? branchesForEntity(branches, entities, filters.entity_id)
    : branches.filter((branch) => {
      const entity = entities.find((item) => item.id === branch.entity_id);
      return entity?.short_code !== "IETA" || IETA_STUDENT_BRANCH_CODES.includes(branch.branch_code);
    });
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
    const ieta = entities.find((entity) => entity.short_code === "IETA") || entities[0];
    const branchOptions = branchesForEntity(branches, entities, ieta?.id || "");
    setStudentForm({ ...blankStudent, entity_id: ieta?.id || "", home_branch_id: branchOptions.find((branch) => branch.branch_code === "KL")?.id || branchOptions[0]?.id || "" });
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
    setError("");
    const res = await fetch("/api/programmes/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(programmeForm),
    });
    const json = await res.json();
    setBusy(false);
    if (!res.ok) {
      setError(json.error || "Programme could not be saved. Please review the highlighted fields.");
      return;
    }
    setMessage("Programme saved.");
    setProgrammeForm({ ...blankProgramme, entity_id: programmeForm.entity_id });
    await load();
  }

  async function saveIntake(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const res = await fetch("/api/intakes/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(intakeForm),
    });
    const json = await res.json();
    setBusy(false);
    if (!res.ok) {
      setError(json.error || "Intake could not be saved. Please review the highlighted fields.");
      return;
    }
    setMessage("Intake saved.");
    setIntakeForm({ ...blankIntake, entity_id: intakeForm.entity_id, branch_id: intakeForm.branch_id });
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
                <li><strong>Create branch intake</strong><span>Use intake/offering to record the current IETA student branches: KL or Penang.</span></li>
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
            <Table rows={filteredProgrammes} empty="No programmes yet." columns={[["programme_code", "Code"], ["programme_name", "Programme"], ["programme_type", "Type"], ["duration_text", "Duration"], ["indicative_standard_fee", "Indicative Tuition Fee"], ["active_status", "Active"]]} action={(row) => <button className="neutral" onClick={() => setProgrammeForm({ ...blankProgramme, ...row, duration_value: row.duration_value || row.duration_min_value || "", duration_max_value: row.duration_max_value || "" })}>Edit</button>} />
          </Panel>
        </section>
      )}

      {mode === "intakes" && (
        <section className="split-grid">
          <Panel title="Programme Intake / Offering">
            <IntakeForm form={intakeForm} setForm={setIntakeForm} programmes={programmes} branches={branches} entities={entities} onSubmit={saveIntake} busy={busy} />
          </Panel>
          <Panel title="Intakes">
            <button className="neutral" onClick={() => exportRows("intakes-stage1a.csv", filteredIntakes.map((row) => ({ ...row, programme: programmeLabel(row.programme_id), branch: branchLabel(row.branch_id) })), ["programme", "branch", "intake_code", "start_date", "original_expected_completion_date", "expected_completion_date", "actual_completion_date", "status", "completion_timing", "capacity"])}>Export CSV</button>
            <Table rows={filteredIntakes} empty="No intakes yet." columns={[["intake_code", "Intake"], ["start_date", "Start"], ["expected_completion_date", "Current Completion"], ["status", "Operational Status"], ["completion_timing", "Completion Timing"], ["capacity", "Capacity"]]} action={(row) => <button className="neutral" onClick={() => setIntakeForm({ ...blankIntake, ...row, capacity: row.capacity || "", _completion_manual: true })}>Edit</button>} />
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
            <EnrolmentForm form={enrolmentForm} setForm={setEnrolmentForm} students={students} programmes={programmes} intakes={intakes} branches={branches} entities={entities} profiles={profiles} onSubmit={saveEnrolment} busy={busy} />
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
  const entityBranches = branchesForEntity(branches, entities, form.entity_id);
  const nationalityOption = form._nationality_other || (form.nationality && !NATIONALITIES.includes(form.nationality)) ? "Other" : (form.nationality || "Malaysian");
  return (
    <form onSubmit={onSubmit}>
      <label>Entity<select value={form.entity_id} onChange={(event) => { const entityId = event.target.value; const nextBranches = branchesForEntity(branches, entities, entityId); setForm({ ...form, entity_id: entityId, home_branch_id: nextBranches[0]?.id || "" }); }} required><option value="">Choose entity</option>{entities.map((entity) => <option key={entity.id} value={entity.id}>{entity.short_code}</option>)}</select></label>
      <label>Home branch<select value={form.home_branch_id || ""} onChange={(event) => setForm({ ...form, home_branch_id: event.target.value })}><option value="">No home branch</option>{entityBranches.map((branch) => <option key={branch.id} value={branch.id}>{branch.branch_code} - {branch.branch_name}</option>)}</select></label>
      <label>Full name<input value={form.full_name} onChange={(event) => setForm({ ...form, full_name: event.target.value })} required /></label>
      <label>Preferred name<input value={form.preferred_name || ""} onChange={(event) => setForm({ ...form, preferred_name: event.target.value })} /></label>
      <label>IC/passport type<select value={form.identity_document_type || ""} onChange={(event) => setForm({ ...form, identity_document_type: event.target.value })}><option value="">Not recorded</option><option value="ic">IC</option><option value="passport">Passport</option><option value="other">Other</option></select></label>
      <label>IC/passport number<input value={form.identity_number_protected || ""} onChange={(event) => setForm({ ...form, identity_number_protected: event.target.value })} placeholder={form.id ? "Leave blank to keep unchanged" : ""} /></label>
      <label>Nationality<select value={nationalityOption} onChange={(event) => setForm({ ...form, _nationality_other: event.target.value === "Other", nationality: event.target.value === "Other" ? "" : event.target.value })}>{NATIONALITIES.map((nationality) => <option key={nationality} value={nationality}>{nationality}</option>)}<option value="Other">Other</option></select></label>
      {nationalityOption === "Other" && <label>Other nationality<input value={form.nationality || ""} onChange={(event) => setForm({ ...form, nationality: event.target.value })} required /></label>}
      <label>Date of birth<input type="date" value={form.date_of_birth || ""} onChange={(event) => setForm({ ...form, date_of_birth: event.target.value })} /></label>
      <label>Gender<select value={form.gender || ""} onChange={(event) => setForm({ ...form, gender: event.target.value })}><option value="">Choose</option><option value="female">Female</option><option value="male">Male</option></select></label>
      <label>Phone<input value={form.phone || ""} onChange={(event) => setForm({ ...form, phone: event.target.value })} /></label>
      <label>Email<input type="email" value={form.email || ""} onChange={(event) => setForm({ ...form, email: event.target.value })} /></label>
      <label>Education level<select value={form.education_level || ""} onChange={(event) => setForm({ ...form, education_level: event.target.value })}><option value="">Choose</option>{EDUCATION_LEVELS.map((level) => <option key={level} value={level}>{level}</option>)}</select></label>
      <label>Qualification details<input value={form.qualification_details || ""} onChange={(event) => setForm({ ...form, qualification_details: event.target.value })} placeholder="Diploma in Business" /></label>
      <label>Institution or school<input value={form.education_institution || ""} onChange={(event) => setForm({ ...form, education_institution: event.target.value })} /></label>
      <label>Field of study<input value={form.field_of_study || ""} onChange={(event) => setForm({ ...form, field_of_study: event.target.value })} /></label>
      <label>Completion or graduation year<input type="number" min="1900" max="2100" value={form.graduation_year || ""} onChange={(event) => setForm({ ...form, graduation_year: event.target.value })} /></label>
      <label>Emergency contact name<input value={form.emergency_contact_name || ""} onChange={(event) => setForm({ ...form, emergency_contact_name: event.target.value })} /></label>
      <label>Emergency contact phone<input value={form.emergency_contact_phone || ""} onChange={(event) => setForm({ ...form, emergency_contact_phone: event.target.value })} /></label>
      <label>Relationship<input value={form.emergency_contact_relationship || ""} onChange={(event) => setForm({ ...form, emergency_contact_relationship: event.target.value })} /></label>
      <label className="wide">Address<textarea value={form.address || ""} onChange={(event) => setForm({ ...form, address: event.target.value })} required /></label>
      <label>City<input value={form.city || ""} onChange={(event) => setForm({ ...form, city: event.target.value })} required /></label>
      <label>State{form.country === "Malaysia"
        ? <select value={form.state || ""} onChange={(event) => setForm({ ...form, state: event.target.value })} required><option value="">Choose state</option>{MALAYSIAN_STATES.map((state) => <option key={state} value={state}>{state}</option>)}</select>
        : <input value={form.state || ""} onChange={(event) => setForm({ ...form, state: event.target.value })} required />}</label>
      <label>Postcode<input value={form.postcode || ""} onChange={(event) => setForm({ ...form, postcode: event.target.value })} required /></label>
      <label>Country<input value={form.country || ""} onChange={(event) => setForm({ ...form, country: event.target.value, state: "" })} required /></label>
      <label>Height (cm)<input type="number" min="0" step="0.01" value={form.height_cm || ""} onChange={(event) => setForm({ ...form, height_cm: event.target.value })} /></label>
      <label>Weight (kg)<input type="number" min="0" step="0.01" value={form.weight_kg || ""} onChange={(event) => setForm({ ...form, weight_kg: event.target.value })} /></label>
      <label>Uniform size<input value={form.uniform_size || ""} onChange={(event) => setForm({ ...form, uniform_size: event.target.value })} /></label>
      <label>Measurement date<input type="date" value={form.measurement_date || ""} onChange={(event) => setForm({ ...form, measurement_date: event.target.value })} /></label>
      <label className="wide">Measurement remarks<textarea value={form.measurement_remarks || ""} onChange={(event) => setForm({ ...form, measurement_remarks: event.target.value })} /></label>
      <label className="wide">Remarks<textarea value={form.remarks || ""} onChange={(event) => setForm({ ...form, remarks: event.target.value })} /></label>
      <label className="inline"><input type="checkbox" checked={Boolean(form.active_status)} onChange={(event) => setForm({ ...form, active_status: event.target.checked })} /> Active student</label>
      <button disabled={busy}>{form.id ? "Save Student" : "Create Student"}</button>
    </form>
  );
}

function ProgrammeForm({ form, setForm, entities, onSubmit, busy }: { form: Row; setForm: (next: Row) => void; entities: Row[]; onSubmit: (event: FormEvent) => void; busy: boolean }) {
  return (
    <form onSubmit={onSubmit}>
      <label>Entity<select value={form.entity_id} onChange={(event) => setForm({ ...form, entity_id: event.target.value })} required><option value="">Choose entity</option>{entities.map((entity) => <option key={entity.id} value={entity.id}>{entity.short_code}</option>)}</select></label>
      <label>Programme code<input value={form.programme_code} onChange={(event) => setForm({ ...form, programme_code: event.target.value.toUpperCase() })} required /></label>
      <label>Programme name<input value={form.programme_name} onChange={(event) => setForm({ ...form, programme_name: event.target.value })} required /></label>
      <label>Programme type<input value={form.programme_type || ""} onChange={(event) => setForm({ ...form, programme_type: event.target.value })} /></label>
      <label>Duration / minimum value<input type="number" min="0.01" step="0.01" value={form.duration_value || ""} onChange={(event) => setForm({ ...form, duration_value: event.target.value })} required /></label>
      <label>Maximum duration (optional)<input type="number" min="0.01" step="0.01" value={form.duration_max_value || ""} onChange={(event) => setForm({ ...form, duration_max_value: event.target.value })} /></label>
      <label>Duration unit<select value={form.duration_unit || ""} onChange={(event) => setForm({ ...form, duration_unit: event.target.value })} required>{["days", "weeks", "months", "years"].map((unit) => <option key={unit} value={unit}>{unit}</option>)}</select></label>
      <label>Indicative tuition fee only<input type="number" min="0" step="0.01" value={form.indicative_standard_fee || ""} onChange={(event) => setForm({ ...form, indicative_standard_fee: event.target.value })} /></label>
      <p className="help">Optional planning figure only. The final student fee agreement will be introduced in Stage 1B.</p>
      <label className="wide">Description<textarea value={form.description || ""} onChange={(event) => setForm({ ...form, description: event.target.value })} /></label>
      <label className="inline"><input type="checkbox" checked={Boolean(form.active_status)} onChange={(event) => setForm({ ...form, active_status: event.target.checked })} /> Active programme</label>
      <button disabled={busy}>Save Programme</button>
    </form>
  );
}

function IntakeForm({ form, setForm, programmes, branches, entities, onSubmit, busy }: { form: Row; setForm: (next: Row) => void; programmes: Row[]; branches: Row[]; entities: Row[]; onSubmit: (event: FormEvent) => void; busy: boolean }) {
  const programme = programmes.find((item) => item.id === form.programme_id);
  const branchOptions = programme ? branchesForEntity(branches, entities, programme.entity_id) : [];

  function applyCompletionSuggestion(next: Row) {
    const selectedProgramme = programmes.find((item) => item.id === next.programme_id);
    const suggestion = suggestedCompletionDate(next.start_date, selectedProgramme);
    if (!suggestion) return next;
    if (next._completion_manual && next.expected_completion_date && next.expected_completion_date !== suggestion) {
      const confirmed = window.confirm("The current expected completion date was entered manually. Recalculate it from the programme duration?");
      if (!confirmed) return next;
    }
    return {
      ...next,
      expected_completion_date: suggestion,
      original_expected_completion_date: next.id ? next.original_expected_completion_date : suggestion,
      _completion_manual: false,
    };
  }

  return (
    <form onSubmit={onSubmit}>
      <label>Programme<select value={form.programme_id} onChange={(event) => { const selected = programmes.find((item) => item.id === event.target.value); const nextBranches = selected ? branchesForEntity(branches, entities, selected.entity_id) : []; const branchId = nextBranches.some((branch) => branch.id === form.branch_id) ? form.branch_id : (nextBranches[0]?.id || ""); setForm(applyCompletionSuggestion({ ...form, programme_id: event.target.value, entity_id: selected?.entity_id || "", branch_id: branchId })); }} required><option value="">Choose programme</option>{programmes.map((programmeRow) => <option key={programmeRow.id} value={programmeRow.id}>{programmeRow.programme_code} - {programmeRow.programme_name}</option>)}</select></label>
      <label>Branch<select value={form.branch_id} onChange={(event) => setForm({ ...form, branch_id: event.target.value })} required><option value="">Choose</option>{branchOptions.map((branch) => <option key={branch.id} value={branch.id}>{branch.branch_code} - {branch.branch_name}</option>)}</select></label>
      <label>Intake code<input value={form.intake_code} onChange={(event) => setForm({ ...form, intake_code: event.target.value.toUpperCase() })} required /></label>
      <label>Intake name<input value={form.intake_name || ""} onChange={(event) => setForm({ ...form, intake_name: event.target.value })} /></label>
      <label>Start date<input type="date" value={form.start_date} onChange={(event) => setForm(applyCompletionSuggestion({ ...form, start_date: event.target.value }))} required /></label>
      <label>Original expected completion<input type="date" value={form.original_expected_completion_date || ""} readOnly /></label>
      <label>Current expected completion<input type="date" value={form.expected_completion_date || ""} onChange={(event) => setForm({ ...form, expected_completion_date: event.target.value, _completion_manual: true })} /></label>
      <p className="help">Suggested from the programme duration and remains editable. For a duration range, the maximum duration is used.</p>
      <label>Application closing<input type="date" value={form.application_closing_date || ""} onChange={(event) => setForm({ ...form, application_closing_date: event.target.value })} /></label>
      <label>Capacity<input type="number" min="0" step="1" value={form.capacity || ""} onChange={(event) => setForm({ ...form, capacity: event.target.value })} /></label>
      <label>Operational status<select value={form.status} onChange={(event) => setForm({ ...form, status: event.target.value })}>{["planning", "open", "closed", "in_progress", "completed", "cancelled", "inactive"].map((status) => <option key={status} value={status}>{status}</option>)}</select></label>
      <label>Completion timing / result<select value={form.completion_timing || "not_applicable"} onChange={(event) => setForm({ ...form, completion_timing: event.target.value })}>{["not_applicable", "on_time", "prolonged", "shortened", "partially_completed", "discontinued"].map((timing) => <option key={timing} value={timing}>{timing}</option>)}</select></label>
      <label>Actual completion date<input type="date" value={form.actual_completion_date || ""} onChange={(event) => setForm({ ...form, actual_completion_date: event.target.value })} /></label>
      <label className="wide">Revision or completion reason<textarea value={form.completion_reason || ""} onChange={(event) => setForm({ ...form, completion_reason: event.target.value })} /></label>
      {form.revised_at && <p className="help">Last revised {new Date(form.revised_at).toLocaleString("en-MY")}.</p>}
      <label className="wide">Remarks<textarea value={form.remarks || ""} onChange={(event) => setForm({ ...form, remarks: event.target.value })} /></label>
      <button disabled={busy}>Save Intake</button>
    </form>
  );
}

function EnrolmentForm({ form, setForm, students, programmes, intakes, branches, entities, profiles, onSubmit, busy }: { form: Row; setForm: (next: Row) => void; students: Row[]; programmes: Row[]; intakes: Row[]; branches: Row[]; entities: Row[]; profiles: Row[]; onSubmit: (event: FormEvent) => void; busy: boolean }) {
  const entityStudents = students.filter((student) => !form.entity_id || student.entity_id === form.entity_id);
  const entityProgrammes = programmes.filter((programme) => !form.entity_id || programme.entity_id === form.entity_id);
  const programmeIntakes = intakes.filter((intake) => !form.programme_id || intake.programme_id === form.programme_id);
  const entityBranches = branchesForEntity(branches, entities, form.entity_id);
  return (
    <form onSubmit={onSubmit}>
      <label>Student<select value={form.student_id} onChange={(event) => { const student = students.find((item) => item.id === event.target.value); setForm({ ...form, student_id: event.target.value, entity_id: student?.entity_id || form.entity_id, programme_id: "", intake_id: "", branch_id: "" }); }} required><option value="">Choose student</option>{entityStudents.map((student) => <option key={student.id} value={student.id}>{student.student_number} - {student.full_name}</option>)}</select></label>
      <label>Programme<select value={form.programme_id} onChange={(event) => { const programme = programmes.find((item) => item.id === event.target.value); setForm({ ...form, programme_id: event.target.value, entity_id: programme?.entity_id || form.entity_id, intake_id: "", branch_id: "" }); }} required><option value="">Choose programme</option>{entityProgrammes.map((programme) => <option key={programme.id} value={programme.id}>{programme.programme_code} - {programme.programme_name}</option>)}</select></label>
      <label>Intake<select value={form.intake_id} onChange={(event) => { const intake = intakes.find((item) => item.id === event.target.value); setForm({ ...form, intake_id: event.target.value, entity_id: intake?.entity_id || form.entity_id, branch_id: intake?.branch_id || form.branch_id, expected_completion_date: intake?.expected_completion_date || form.expected_completion_date }); }} required><option value="">Choose</option>{programmeIntakes.map((intake) => <option key={intake.id} value={intake.id}>{intake.intake_code} - {branches.find((branch) => branch.id === intake.branch_id)?.branch_code || ""}</option>)}</select></label>
      <label>Branch<select value={form.branch_id} onChange={(event) => setForm({ ...form, branch_id: event.target.value })} required disabled={Boolean(form.intake_id)}><option value="">Choose branch</option>{entityBranches.map((branch) => <option key={branch.id} value={branch.id}>{branch.branch_code} - {branch.branch_name}</option>)}</select></label>
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
