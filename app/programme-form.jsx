"use client";
import { Field, FormActions } from "./student-operations-form-shared";
export function ProgrammeForm({ form, setForm, entities, errors, onSubmit, onCancel, busy }) {
return (<form onSubmit={onSubmit} noValidate>
<p className="form-guidance wide">A programme can be saved with only the three required fields.</p>
<Field name="entity_id" label="Entity" required error={errors.entity_id}><select value={form.entity_id} onChange={(event) => setForm({ ...form, entity_id: event.target.value })}><option value="">Choose entity</option>{entities.map((entity) => <option key={entity.id} value={entity.id}>{entity.short_code}</option>)}</select></Field>
<Field name="record_status" label="Record status" error={errors.record_status}><select value={form.record_status || "draft"} onChange={(event) => setForm({ ...form, record_status: event.target.value })}>{["draft", "active", "incomplete", "inactive", "archived"].map((status) => <option key={status} value={status}>{status}</option>)}</select></Field>
<Field name="programme_code" label="Programme code" required error={errors.programme_code}><input value={form.programme_code} onChange={(event) => setForm({ ...form, programme_code: event.target.value.toUpperCase() })}/></Field>
<Field name="programme_name" label="Programme name" required error={errors.programme_name}><input value={form.programme_name} onChange={(event) => setForm({ ...form, programme_name: event.target.value })}/></Field>
<Field name="programme_type" label="Programme type" optional error={errors.programme_type}><input value={form.programme_type || ""} onChange={(event) => setForm({ ...form, programme_type: event.target.value })}/></Field>
<Field name="duration_value" label="Duration / minimum value" optional error={errors.duration_value}><input type="number" min="0.01" step="0.01" value={form.duration_value || ""} onChange={(event) => setForm({ ...form, duration_value: event.target.value })}/></Field>
<Field name="duration_max_value" label="Maximum duration" optional error={errors.duration_max_value}><input type="number" min="0.01" step="0.01" value={form.duration_max_value || ""} onChange={(event) => setForm({ ...form, duration_max_value: event.target.value })}/></Field>
<Field name="duration_unit" label="Duration unit" optional error={errors.duration_unit}><select value={form.duration_unit || "months"} onChange={(event) => setForm({ ...form, duration_unit: event.target.value })}>{["days", "weeks", "months", "years"].map((unit) => <option key={unit} value={unit}>{unit}</option>)}</select></Field>
<Field name="indicative_standard_fee" label="Indicative tuition fee only" optional error={errors.indicative_standard_fee}><input type="number" min="0" step="0.01" value={form.indicative_standard_fee || ""} onChange={(event) => setForm({ ...form, indicative_standard_fee: event.target.value })}/></Field>
<p className="help">Optional planning figure only. The final student fee agreement will be introduced in Stage 1B.</p>
<Field name="description" label="Description" optional error={errors.description} wide><textarea value={form.description || ""} onChange={(event) => setForm({ ...form, description: event.target.value })}/></Field>
<FormActions busy={busy} onCancel={onCancel}/>
</form>);
}
