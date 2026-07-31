"use client";
import { suggestedCompletionDate } from "@/lib/programme-duration";
import { branchesForEntity, Field, FormActions } from "./student-operations-form-shared";
export function IntakeForm({ form, setForm, programmes, branches, entities, errors, onSubmit, onCancel, busy }) {
const programme = programmes.find((item) => item.id === form.programme_id);
const branchOptions = programme ? branchesForEntity(branches, entities, programme.entity_id) : [];
function applyCompletionSuggestion(next) {
const selectedProgramme = programmes.find((item) => item.id === next.programme_id);
const suggestion = suggestedCompletionDate(next.start_date, selectedProgramme);
if (!suggestion)
return next;
if (next._completion_manual && next.expected_completion_date && next.expected_completion_date !== suggestion) {
const confirmed = window.confirm("The current expected completion date was entered manually. Recalculate it from the programme duration?");
if (!confirmed)
return next;
}
return {
...next,
expected_completion_date: suggestion,
original_expected_completion_date: next.id ? next.original_expected_completion_date : suggestion,
_completion_manual: false,
};
}
return (<form onSubmit={onSubmit} noValidate>
<p className="form-guidance wide">Planning intakes may be saved without scheduling details. A start date becomes required when the intake is activated.</p>
<Field name="programme_id" label="Programme" required error={errors.programme_id}><select value={form.programme_id} onChange={(event) => { const selected = programmes.find((item) => item.id === event.target.value); const nextBranches = selected ? branchesForEntity(branches, entities, selected.entity_id) : []; const branchId = nextBranches.some((branch) => branch.id === form.branch_id) ? form.branch_id : (nextBranches[0]?.id || ""); setForm(applyCompletionSuggestion({ ...form, programme_id: event.target.value, entity_id: selected?.entity_id || "", branch_id: branchId })); }}><option value="">Choose programme</option>{programmes.map((programmeRow) => <option key={programmeRow.id} value={programmeRow.id}>{programmeRow.programme_code} - {programmeRow.programme_name}</option>)}</select></Field>
<Field name="branch_id" label="Branch" required error={errors.branch_id}><select value={form.branch_id} onChange={(event) => setForm({ ...form, branch_id: event.target.value })}><option value="">Choose branch</option>{branchOptions.map((branch) => <option key={branch.id} value={branch.id}>{branch.branch_code} - {branch.branch_name}</option>)}</select></Field>
<Field name="intake_code" label="Intake code" required error={errors.intake_code}><input value={form.intake_code} onChange={(event) => setForm({ ...form, intake_code: event.target.value.toUpperCase() })}/></Field>
<Field name="intake_name" label="Intake name" optional error={errors.intake_name}><input value={form.intake_name || ""} onChange={(event) => setForm({ ...form, intake_name: event.target.value })} placeholder="Generated automatically if blank"/></Field>
<Field name="status" label="Operational status" error={errors.status}><select value={form.status} onChange={(event) => setForm({ ...form, status: event.target.value })}>{["planning", "open", "closed", "in_progress", "completed", "cancelled", "inactive"].map((status) => <option key={status} value={status}>{status}</option>)}</select></Field>
<Field name="start_date" label="Start date" required={form.status !== "planning"} optional={form.status === "planning"} error={errors.start_date}><input type="date" value={form.start_date || ""} onChange={(event) => setForm(applyCompletionSuggestion({ ...form, start_date: event.target.value }))}/></Field>
<Field name="original_expected_completion_date" label="Original expected completion" optional error={errors.original_expected_completion_date}><input type="date" value={form.original_expected_completion_date || ""} readOnly/></Field>
<Field name="expected_completion_date" label="Current expected completion" optional error={errors.expected_completion_date}><input type="date" value={form.expected_completion_date || ""} onChange={(event) => setForm({ ...form, expected_completion_date: event.target.value, _completion_manual: true })}/></Field>
<p className="help">Suggested from the programme duration and remains editable. For a duration range, the maximum duration is used.</p>
<Field name="application_closing_date" label="Application closing" optional error={errors.application_closing_date}><input type="date" value={form.application_closing_date || ""} onChange={(event) => setForm({ ...form, application_closing_date: event.target.value })}/></Field>
<Field name="capacity" label="Capacity" optional error={errors.capacity}><input type="number" min="0" step="1" value={form.capacity || ""} onChange={(event) => setForm({ ...form, capacity: event.target.value })}/></Field>
<Field name="completion_timing" label="Completion timing / result" optional error={errors.completion_timing}><select value={form.completion_timing || "not_applicable"} onChange={(event) => setForm({ ...form, completion_timing: event.target.value })}>{["not_applicable", "on_time", "prolonged", "shortened", "partially_completed", "discontinued"].map((timing) => <option key={timing} value={timing}>{timing}</option>)}</select></Field>
<Field name="actual_completion_date" label="Actual completion date" optional error={errors.actual_completion_date}><input type="date" value={form.actual_completion_date || ""} onChange={(event) => setForm({ ...form, actual_completion_date: event.target.value })}/></Field>
<Field name="completion_reason" label="Revision or completion reason" optional error={errors.completion_reason} wide><textarea value={form.completion_reason || ""} onChange={(event) => setForm({ ...form, completion_reason: event.target.value })}/></Field>
{form.revised_at && <p className="help">Last revised {new Date(form.revised_at).toLocaleString("en-MY")}.</p>}
<Field name="remarks" label="Remarks" optional error={errors.remarks} wide><textarea value={form.remarks || ""} onChange={(event) => setForm({ ...form, remarks: event.target.value })}/></Field>
<FormActions busy={busy} onCancel={onCancel}/>
</form>);
}
