# Phase 2 UAT Checklist

Use this checklist after migration `supabase/migrations/0005_phase2_usability_vouchers_and_demo_data.sql` has been applied and Vercel has deployed the matching application code.

DEMO records are hidden from normal dashboards by default. Use `Suppliers > Load Phase 2 Demo Data` only when owner test data is needed.

| Area | Prerequisite | Exact action | Expected result | Pass/Fail | Screenshot | Known limitation |
|---|---|---|---|---|---|---|
| A. Suppliers | Owner logged in | Open `/suppliers`, create a supplier linked to IETA, then edit it | Supplier appears in active supplier lists for IETA only; edit saves changes |  | Yes | Supplier management is basic, not a full vendor master |
| A. Suppliers | Owner logged in | Archive and reactivate supplier | Archived supplier leaves active dropdowns; reactivated supplier returns |  | Yes | Archive is soft status only |
| A. Suppliers | Owner logged in | Click Load Phase 2 Demo Data | DEMO supplier, bill, recurring obligation, draft voucher and linked invoice document are created and marked DEMO |  | Yes | Demo PDF is placeholder evidence for workflow testing |
| A. Suppliers | DEMO data loaded | Click Remove Phase 2 Demo Data | Only DEMO records are removed; real records remain unchanged |  | Yes | Storage cleanup removes known DEMO files only |
| B. Supplier Bills | Active supplier exists | Open `/bills`, select entity, supplier, bill details and invoice document, then save | Bill saves and selected PDF/image uploads to that bill |  | Yes | No OCR or auto extraction |
| B. Supplier Bills | Bill exists | Open bill row | Bill detail shows linked document filename and evidence status |  | Yes | Detail view reuses the same Phase 2 workspace layout |
| C. Document Upload | Bill or voucher exists | Open `/documents`, choose entity, linked type, valid record, files, then click Upload Documents | Progress text appears, success message appears, document list refreshes immediately |  | Yes | Upload requires an existing linked record |
| C. Document Upload | No records exist | Open `/documents` and select Supplier Bill link type | Record dropdown explains no supplier bills are available and links to create bill |  | Yes | Unlinked documents are not allowed in Version 1 |
| C. Document Upload | Desktop browser | Review Phone Camera field | Field says it is for supported mobile devices only |  | No | Desktop browsers normally show a file picker |
| C. Document Upload | Mobile browser | Tap Phone Camera field | Device may offer rear camera capture and photo library |  | Yes | Exact camera behavior depends on browser/device |
| D. Recurring Obligations | Active supplier exists | Create recurring obligation | Obligation is saved and visible in monthly drafts panel |  | Yes | Monthly frequency only |
| E. Monthly Draft Generation | Recurring obligation due for generation | Click Generate Monthly Drafts | One monthly supplier bill is generated; duplicate monthly bill is blocked by database uniqueness |  | Yes | No Vercel Cron yet |
| E. Monthly Draft Generation | Recurring obligation has auto PV enabled | Generate monthly drafts | Draft voucher is created without final voucher number |  | Yes | User must issue voucher manually |
| F. Payment Vouchers | Bill exists | Open `/payment-vouchers`, click Create PV Draft on a bill | Draft form is prefilled with entity, payee, bill description, category and amount |  | Yes | User must review before saving |
| F. Payment Vouchers | Draft details ready | Save voucher draft | Draft voucher appears with no voucher number |  | Yes | Final number is intentionally blank until issue |
| F. Payment Vouchers | Draft voucher exists | Click Issue Voucher | Voucher receives `{ENTITY_CODE}/PV{YY}-{MM}/{SEQUENCE}` and status becomes issued |  | Yes | Issued voucher edits are limited; cancellation UI is not yet expanded |
| F. Payment Vouchers | No bills exist | Open voucher page | Page says no supplier bills are available and manual voucher can still be created |  | Yes | Manual form is still Phase 2, not approval workflow |
| F. Payment Vouchers | Voucher exists | Print voucher | Print view shows company, voucher number/date, payee, purpose, item rows, categories, total, payment method, bank reference, prepared by, remarks and documents |  | Yes | Browser print/save-to-PDF only |
| G. Missing Documents | Bills/payments with incomplete evidence exist | Open `/missing-documents` | Missing invoice, partial evidence, paid bill without payment slip and payment without bank match counts are visible |  | Yes | Report is operational, not a full audit pack |
| H. Permissions | Staff/read-only test users exist | Try restricted actions | RLS/API blocks unauthorized changes; staff still cannot access bank balances |  | Yes | Requires separate non-owner accounts |
| I. Private Download | Document exists | Click Download | File opens through signed URL; bucket remains private |  | Yes | Signed URL expires |
| J. Audit Logs | Upload/issue/demo actions completed | Check `audit_logs` in Supabase | Upload, issue, demo load/remove actions are recorded |  | Optional | No dedicated audit-log UI yet |

Phase 2 should not be marked complete until the live application passes this checklist.
