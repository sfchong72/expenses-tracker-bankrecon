# Test Plan

## Active UAT Scenario

1. Sign in as Owner with MFA and confirm an `aal1` session is denied until the TOTP challenge succeeds.
2. Open `/suppliers` and create or edit a supplier/payee.
3. Open `/settings/categories` and confirm expense categories load.
4. Open `/recurring` and create a recurring obligation.
5. Generate monthly drafts where required.
6. Open `/bills`, create a supplier bill, and attach a PDF or image document.
7. Open `/payment-vouchers`, create a manual voucher and a voucher from a bill.
8. Issue a voucher and confirm the printed voucher preview contains payee, purpose, item rows, amount, payment method, reference and supporting documents.
9. Open `/documents` and confirm uploaded documents appear in the private document library.
10. Open `/missing-documents` and confirm incomplete evidence is listed.
11. Open the inactive bank routes and confirm they show the SQL Accounting inactive message.
12. Exercise a fictional-role matrix for Owner, Finance Manager, Finance Staff, Management, Data Entry, disallowed staff, inactive and anonymous users.
13. Verify entity/branch isolation, claim confidentiality, self-approval prevention, bank-balance non-disclosure, document/Storage inheritance and operation-specific bill/voucher permissions.
14. Verify controlled student delete/merge, file-deletion compensation, Finance audit records and atomic rollback of invalid multi-write workflows.

## Expected Inactive Bank Routes

- `/bank-imports`
- `/bank-imports/[id]`
- `/bank-transactions`
- `/reconcile`
- `/reconcile/[statement-month]`
- `/reports/bank-reconciliation`

Expected result: no bank import, transaction entry, reconciliation, or bank report workflow is available in the active UI.

## Notes

Bank reconciliation and official accounting records are maintained in SQL Accounting. This application supports expense administration, payment preparation and supporting-document control.
