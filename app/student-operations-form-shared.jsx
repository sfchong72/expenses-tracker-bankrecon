"use client";
export const NATIONALITIES = ["Malaysian", "Japanese", "Korean", "Chinese", "Indonesian", "Vietnamese", "Filipino", "Thai", "Singaporean", "Kazakhstani"];
export const EDUCATION_LEVELS = ["SPM", "UEC", "O Level", "A Level", "STPM", "Certificate", "Diploma", "Advanced Diploma", "Degree", "Master's Degree", "Other"];
export const MALAYSIAN_STATES = ["Johor", "Kedah", "Kelantan", "Melaka", "Negeri Sembilan", "Pahang", "Perak", "Perlis", "Pulau Pinang", "Sabah", "Sarawak", "Selangor", "Terengganu", "Kuala Lumpur", "Labuan", "Putrajaya"];
const IETA_STUDENT_BRANCH_CODES = ["KL", "PG"];
export function branchesForEntity(branches, entities, entityId) {
const entity = entities.find((item) => item.id === entityId);
return branches.filter((branch) => branch.entity_id === entityId
&& (entity?.short_code !== "IETA" || IETA_STUDENT_BRANCH_CODES.includes(branch.branch_code)));
}
export function Field({ name, label, error, required = false, optional = false, wide = false, children }) {
return (<label data-field={name} className={`${wide ? "wide " : ""}${error ? "field-invalid" : ""}`}>
<span>{label}{required && <span className="required-mark" aria-hidden="true"> *</span>}{optional && <span className="optional-mark"> Optional</span>}</span>
{children}
{error && <span className="field-error" role="alert">{error}</span>}
</label>);
}
export function FormActions({ busy, onCancel }) {
return (<div className="form-actions">
<button type="submit" name="action" value="draft" className="neutral" disabled={busy}>Save Draft</button>
<button type="submit" name="action" value="continue" disabled={busy}>Save &amp; Continue</button>
<button type="button" className="neutral" onClick={onCancel} disabled={busy}>Cancel</button>
</div>);
}
