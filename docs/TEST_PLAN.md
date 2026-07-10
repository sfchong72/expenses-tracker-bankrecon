# Test Plan

## v1 Success Scenario (manual walkthrough)

### Setup
1. Open the app URL in an incognito window (no login).
2. Confirm seeded invoices and receipts are visible on their list pages.

### Invoice entry
3. Click **New Invoice** → fill vendor "Test Vendor", amount 500.00, due date 7 days from today → Save.
4. Confirm row appears in invoice list without page reload.
5. Edit the invoice: change amount to 550.00 → Save. Confirm updated value shown.

### Receipt entry
6. Click **New Receipt** → fill merchant "Grab", amount 55.00, date today, category Transport → Save.
7. Confirm row appears in receipt list.

### Bank statement import
8. Prepare a CSV with 3 rows: one debit 550.00 dated today, one debit 55.00 dated today, one debit 999.00 dated today.
9. Upload via CSV import → confirm preview shows 3 rows → click Confirm Import.
10. Verify all 3 rows appear in Bank Transactions list.

### Auto-match
11. Click **Run Auto-Match**.
12. Verify reconciliation view shows: 2 matched pairs (550.00 invoice + 55.00 receipt), 1 unmatched bank row (999.00).

### Manual match
13. Select the 999.00 bank row and any seeded unmatched invoice → click **Match** → confirm match appears in reconciliation view.

### Export
14. Click **Export CSV** → file downloads → open in spreadsheet → verify 3 matched rows with correct vendor/merchant, amount, date columns.

### Refresh check
15. Hard-refresh the page → all matches and entries still present.

---

## Empty & Error Cases
| Scenario | Expected behaviour |
|---|---|
| Invoice list with no rows | Empty-state card with "Add your first invoice" prompt |
| CSV import with wrong column headers | Error toast: "CSV format not recognised — expected: description, amount, date, direction" |
| Auto-match with no bank transactions | Toast: "Import bank transactions first" |
| Save fails (network off) | Error toast; form data not cleared; user can retry |
| Delete invoice that has an accepted match | Confirmation dialog warns match will be unlinked |
| AI Smart Match when API key missing | Graceful fallback: rule-based match runs; toast "AI unavailable, showing exact matches only" |
