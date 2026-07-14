# Agentic Layer

Bank reconciliation and official accounting records are maintained in SQL Accounting. This application supports expense administration, payment preparation and supporting-document control.

## Allowed Automation

### Low Risk
- Show missing-document counts.
- Generate monthly recurring draft bills when required fields are complete.
- Produce payment voucher print views.

### Medium Risk
- Create draft payment vouchers from existing supplier bills.
- Import suppliers and recurring obligations after preview, validation and user confirmation.

### High Risk
- Issue a final payment voucher number.
- Archive or restore supporting documents.
- Revert confirmed import batches where safe.

## Explicitly Disabled
- Bank statement import
- Bank reconciliation matching
- Bank balance calculation
- Automatic posting to SQL Accounting

## Audit Log

Important user actions should continue writing audit log entries, especially imports, voucher issue/cancellation, document archive/restore, and demo-data actions.
