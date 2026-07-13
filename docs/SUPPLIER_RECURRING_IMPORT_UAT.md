# Supplier & Recurring Obligation Import UAT

Migration: `supabase/migrations/0006_supplier_recurring_imports.sql`

Page: `/suppliers/import`

## Workflow

1. Download the import template from `/suppliers/import`.
2. Upload a CSV or XLSX file.
3. If an XLSX file has multiple sheets, select the worksheet to preview.
4. Review and adjust the column mapping.
5. Review every preview row before confirming.
6. Correct supplier/payee, description, category, due day, amount and account/reference details where needed.
7. Exclude rows that should not be imported.
8. Resolve duplicate warnings with skip, update existing or import as new.
9. Confirm uncertain supplier/payee classifications.
10. Click Confirm Import.
11. Export the import result.
12. Review batch history.
13. Test Revert Import Batch for a batch that has not yet been used by bills, vouchers, documents or payments.

## Test Checklist

| Test | Expected result | Pass/Fail |
| --- | --- | --- |
| Download template | CSV template downloads and opens in Excel | |
| Upload CSV | Rows preview before import; no supplier/recurring records are created yet | |
| Upload XLSX | XLSX parses and previews rows | |
| XLSX with multiple worksheets | Worksheet selector appears and chosen sheet previews | |
| Blank rows | Blank rows are ignored | |
| Heading/merged-like rows | First useful row is treated as heading; unrelated blank rows are ignored | |
| Master Expenses columns | Company, Subject & Due Date, Account Details & Number, Amount, Fixed Bill, Variable Bills and Remarks map or can be mapped manually | |
| RM-formatted amount | `RM7,212.80` parses as expected amount | |
| Variable bill with blank amount | Row may import as variable with expected amount 0 | |
| Due text | `Due 15th` resolves to due day 15 | |
| Unknown entity | Row is flagged and cannot import until corrected | |
| Missing supplier | Row is flagged and cannot import until corrected | |
| Ambiguous supplier | User must confirm supplier/payee before import | |
| Existing supplier duplicate | Existing supplier is shown and decision is required | |
| Existing recurring duplicate | Existing obligation is shown and decision is required | |
| Skip duplicate | Row is marked skipped; no production record is changed | |
| Update existing | Existing record updates; it is not owned by the import batch for revert deletion | |
| Import as new | New supplier/obligation is created with `data_origin = imported` | |
| Create category | Category is created only when row-level create is checked | |
| Leave uncategorised | Row imports with no category when no category is selected/created | |
| Partial failures | Batch completes with completed_with_errors and failed row messages | |
| Repeated confirmation | Completed batch cannot be confirmed again | |
| Export result | CSV result includes success, skipped and failed rows | |
| Batch history | Batch appears with counts and status | |
| Safe revert | Revert removes only records created by the batch and reports blocked records | |
| Staff permission | Non-owner cannot access owner import actions | |

## Known Limitation

The current implementation includes a lightweight server-side CSV/XLSX parser because the sandbox could not fetch a new npm dependency. Replace it with a pinned maintained spreadsheet library when dependency installation is available.
