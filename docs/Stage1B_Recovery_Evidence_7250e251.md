# Stage 1B Security Draft Recovery Evidence

Captured before any file was copied from the recovered worktree.

## Source

- Source worktree: `C:\Users\USER\Documents\Codex\2026-07-30\continue-development-of-my-inter-excel\work\repo-stage1a-final-category-auth-repair`
- Branch: `agent/stage1b-0020-security-draft`
- HEAD: `7250e251a64124837885c7758e7b16aabe2fe3af`
- Commit subject: `Draft Phase 1B security preflight migration`
- Source worktree was inspected read-only and was not modified.

## Tracked working-tree changes

| File | Diff | Committed SHA-256 | Working-tree SHA-256 |
|---|---:|---|---|
| `docs/Phase1B_0020_Security_Test_Matrix.md` | +29 / -8 | `461C8849DD7C904D181B2DA1735A074EF67C4A5B5E33A3F4754E33C11EED784A` | `57B96818293126F6D3DE3F93552774B97C05C018C002A005D5F2D1E3B03687D1` |
| `supabase/migrations/0020_stage1b_preflight_security_hardening.sql` | +169 / -7 | `1A6A947118F27F1D4F2605566C2E27E1AFD5B68CB3B220BE34C566355D98E85D` | `FF5230B8680D0A906E2D285E6881C1924C2B359363C2889A3A463FA7DC0512FC` |
| `supabase/tests/0020_stage1b_preflight_security_hardening.test.sql` | +15 / -4 | `028EE49D097A52AD665CFA466DD688C0DDD6FCABDDE8E2DCB49BFC478A8C168D` | `3009F4F4F37137592B8A34467A21037DBEE7343182CFABF78F55E979FE7D1B4A` |

The complete tracked working-tree patch is stored in `Stage1B_Recovery_7250e251_Worktree.patch` beside this report.

- Patch bytes: `15019`
- Patch SHA-256: `E5FF44BFA622445B351B1FFA6E3DD6A8CE27F1912AFA04166F27A4201290B694`

## Untracked files

| File | Bytes | SHA-256 |
|---|---:|---|
| `run-0020-disposable-test.ps1` | 18136 | `8B2E55485C0C58CC1417DA955D4D1CEF4916E94904DA9B0A01C8DF2F37A5AC27` |
| `supabase/tests/0020_finance_foundation_regression.sql` | 2223 | `309D1651BFAA1F0A0519624FD25065F8D5F5AAFB011F7695EFFF03CB44894B53` |
| `supabase/tests/0020_stage1a_regression.sql` | 3996 | `708A150E1B1D7B0D755D9C24D5157F9C1A8C80A24043CFBA4FFDB9AD5D7C000B` |
| `supabase/tests/0020_stage1b_behavioural_security_matrix.sql` | 12359 | `352125EEB33B7ECA543F38766B7CC8CEECF256F4967290A5DEC15BA09DD32927` |
| `supabase/tests/support/0020_stage1b_fixtures.sql` | 16102 | `E774E71D1D68401C908991EE01E7E1550C9CA3003188AE9636D586487BE304F1` |

## Authoritative migration decision

- `0019` remains retired and is not imported, renamed, applied, or reused.
- Validated Finance reconciliation is authoritative migration `0020`.
- Validated Security hardening is authoritative migration `0021`.
- The recovered Security `0020` remains reference material only and must never be applied alongside authoritative `0021`.
