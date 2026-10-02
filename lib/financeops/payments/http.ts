import type { StatementMapping } from "./bank-import";
import type { RegisterMapping } from "./register-import";
import type { RegisterImportInput, StatementImportInput } from "./services";
import { ENTITY_CODES, type EntityCode } from "./types";

/** Reading multipart forms for the import screens (server only). Nothing here is trusted beyond what RLS re-checks. */

function jsonField<T>(form: FormData, name: string): T | undefined {
  const raw = form.get(name);
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

const str = (form: FormData, name: string): string => (typeof form.get(name) === "string" ? (form.get(name) as string) : "");

export async function readStatementForm(form: FormData): Promise<{ input: StatementImportInput; bankName: string | null }> {
  const file = form.get("file");
  const pasted = str(form, "pasted_text");
  const isPasted = !(file instanceof File) && pasted.trim() !== "";
  const name = file instanceof File ? file.name : "pasted rows";
  const fileType: "csv" | "xlsx" | "pasted" = isPasted ? "pasted" : /\.xlsx$/i.test(name) ? "xlsx" : "csv";
  return {
    input: {
      entityId: str(form, "entity_id"),
      companyAccountRef: str(form, "company_account_ref"),
      filename: name,
      fileType,
      bytes: file instanceof File ? Buffer.from(await file.arrayBuffer()) : null,
      pastedText: pasted,
      sheetName: str(form, "sheet") || undefined,
      mapping: jsonField<StatementMapping>(form, "mapping"),
      includeDuplicates: str(form, "include_duplicates") === "true",
    },
    bankName: str(form, "bank_name").trim() || null,
  };
}

export async function readRegisterForm(form: FormData): Promise<RegisterImportInput | null> {
  const file = form.get("file");
  if (!(file instanceof File)) return null;
  const def = str(form, "default_entity").toUpperCase();
  const map = jsonField<Record<string, string>>(form, "account_entity_map") ?? {};
  const accountEntityMap: Record<string, EntityCode> = {};
  for (const [k, v] of Object.entries(map)) {
    if ((ENTITY_CODES as readonly string[]).includes(String(v).toUpperCase())) accountEntityMap[k.replace(/\D+/g, "")] = String(v).toUpperCase() as EntityCode;
  }
  return {
    bytes: Buffer.from(await file.arrayBuffer()),
    fileType: /\.xlsx$/i.test(file.name) ? "xlsx" : "csv",
    sheetName: str(form, "sheet") || undefined,
    mapping: jsonField<RegisterMapping>(form, "mapping"),
    defaultEntity: (ENTITY_CODES as readonly string[]).includes(def) ? (def as EntityCode) : null,
    accountEntityMap,
    waiveDocuments: str(form, "waive_documents") === "true",
    overrides: jsonField<RegisterImportInput["overrides"]>(form, "overrides"),
  };
}
