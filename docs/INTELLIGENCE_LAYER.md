# Intelligence Layer

## Messy Inputs
- Bank statement description: `"GRAB*TRIP SG 15JUN"` vs receipt merchant: `"Grab"`
- Amount near-miss: invoice MYR 960.00 vs bank row MYR 962.50 (bank charges included)
- Date offset: invoice due 30 Jun, bank debit processed 2 Jul

## Auto-Structure (rule-based, no AI)
For each bank row the system produces a candidate list:
```json
{
  "bank_tx_id": "uuid",
  "candidates": [
    {
      "type": "invoice",
      "record_id": "uuid",
      "amount_delta": 0.00,
      "date_delta_days": 1,
      "score": 0.97,
      "source": "system",
      "confidence": 0.97,
      "review_status": "unreviewed"
    }
  ]
}
```

## Scoring Rules (v1 — deterministic)
| Condition | Score contribution |
|---|---|
| Exact amount match | +0.60 |
| Date within ±1 day | +0.30 |
| Date within ±3 days | +0.20 |
| Date within ±7 days | +0.10 |
| Vendor name substring match | +0.10 |
- Score ≥ 0.80 → auto-match (system, no review needed)
- Score 0.50–0.79 → AI fuzzy suggestion (review required)
- Score < 0.50 → unmatched

## Events Tracked
- Bank row imported, auto-match fired, AI suggestion generated, suggestion accepted/rejected, manual match created, CSV exported

## v1 vs Later
**v1:** Rule-based scoring only; all weights are constants in code. 
**Later (Sprint 4):** OpenAI call for description similarity scoring; confidence stored in `match_value_confidence`; user feedback trains weight adjustments.
