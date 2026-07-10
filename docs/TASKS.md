# Tasks & Sprints

## Sprint 1 — Database, seed data, core CRUD
**Goal:** All tables exist, seed data visible, invoices and receipts fully manageable.

- [ ] Run migration SQL; verify all tables and seed rows in Supabase dashboard
- [ ] Invoice list page: loading skeleton / empty state / populated table / error toast
- [ ] Invoice create form: vendor, amount, due_date, status, reference_number — saves to DB
- [ ] Invoice edit + delete (with confirmation dialog)
- [ ] Receipt list page: same five states
- [ ] Receipt create/edit/delete form: merchant, amount, expense_date, category
- [ ] No login wall — all pages accessible to anonymous visitors
- [ ] Deployed to Vercel preview URL

**Definition of Done:** A first-time visitor opens the app, sees seeded invoices and receipts, creates a new invoice, edits it, deletes it — all changes persist on refresh. No console errors.

---

## Sprint 2 — Bank statement entry + auto-match engine ✦ v1 functional
**Goal:** The one core workflow works end-to-end: enter statement → match → view → export.

- [ ] Bank transactions list page + manual row entry form (description, amount, date, direction)
- [ ] CSV import: parse file client-side, preview rows, confirm → bulk insert to DB
- [ ] `run_auto_match` server action: exact amount + date ±3 days → insert reconciliation_matches
- [ ] Reconciliation view: matched pairs table / unmatched invoices panel / unmatched bank rows panel
- [ ] Manual match: select an unmatched invoice/receipt + unmatched bank row → create match
- [ ] Accepted match sets `invoices.status = 'paid'`
- [ ] Export CSV button → streams joined reconciliation report
- [ ] Audit log entry on every match created and export triggered

**Definition of Done:** User imports a 6-row CSV bank statement, clicks Run Auto-Match, sees 3 matched pairs and 3 unmatched rows, manually matches one more, exports CSV with 4 matched rows — all in one session. Data intact on refresh.

---

## Sprint 3 — Polish, deadline view, report UX
**Goal:** The app looks and feels production-ready for daily internal use.

- [ ] Invoice deadline dashboard: overdue (red badge) / due this week (amber) / upcoming (green)
- [ ] Reconciliation summary header: matched count, matched MYR total, match-rate %
- [ ] Empty-state illustrations and onboarding hint text on all list pages
- [ ] Loading skeletons on every data fetch; error toasts on every failed save
- [ ] Print-friendly reconciliation report (CSS @media print)
- [ ] Mobile-responsive layout for all pages

**Definition of Done:** All five UI states (loading, empty, partial, error, ready) render correctly on Invoice, Receipt, Bank Transaction, and Reconciliation pages. Print preview shows clean table layout.

---

## Sprint 4 — AI fuzzy match suggestions
**Goal:** AI surfaces near-miss matches that the rule engine misses; user approves each one.

- [ ] "Smart Match" button calls `/api/ai-match` server route (OpenAI, never client-side)
- [ ] Server scores description similarity + amount ±5% + date ±7 days
- [ ] Suggestions stored in reconciliation_matches with `match_type='fuzzy'`, `matched_by='ai'`, `confidence`, `review_status='unreviewed'`
- [ ] Suggestion cards in reconciliation view: Accept / Reject buttons
- [ ] Accept → `review_status='accepted'`; Reject → `review_status='rejected'`; both write audit_log
- [ ] Rule-based engine remains fully functional if AI call fails (graceful fallback)

**Definition of Done:** With AI enabled, a description near-miss ("GRAB*TRIP" vs "Grab") is surfaced as a suggestion with confidence ≥ 0.7. User accepts it. Match appears in reconciliation view. Disabling the AI env var leaves the app fully functional.

---

## Sprint 5 — Lock it down (auth + per-user RLS)
**Goal:** Real users can sign up; their data is private; demo data is removed.

- [ ] Enable Supabase Auth (email + password)
- [ ] Signup and login pages at `/login`; redirect unauthenticated users
- [ ] Populate `user_id` from `auth.uid()` on every insert
- [ ] Replace all `_v1_read` / `_v1_write` RLS policies with `auth.uid() = user_id` owner policies
- [ ] Remove or archive seed demo rows
- [ ] Verify no cross-user data leakage (test with two accounts)
- [ ] Confirm no secrets in `NEXT_PUBLIC_*` env vars
- [ ] All agent tools use the authenticated user's Supabase client, not service role

**Definition of Done:** User A and User B each log in; neither can see the other's invoices, receipts, or bank transactions. Unauthenticated visit to `/invoices` redirects to `/login`. Supabase Auth logs show sessions correctly.

---

## Gantt (sprint → feature)
```
Sprint 1 │ DB schema · Invoice CRUD · Receipt CRUD
Sprint 2 │ Bank tx entry · CSV import · Auto-match · Recon view · Export  ← v1 functional
Sprint 3 │ Deadline dashboard · Summary stats · Polish · Print
Sprint 4 │ AI fuzzy match · Suggestion review UI
Sprint 5 │ Auth · Per-user RLS · Lock-down
```
