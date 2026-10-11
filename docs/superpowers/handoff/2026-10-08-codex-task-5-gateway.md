# Codex handoff: Task 5 (Replicate gateway + route wiring), then Task 6

Repo: `~/ogai-creator-studio-v2` (git worktree), branch `rebuild/creator-studio-replicate`, local only, nothing pushed.
Plan: `docs/superpowers/plans/2026-10-08-replicate-backend.md` (Tasks 5 and 6 are yours; Tasks 1-4 are done).
Spec: `docs/superpowers/specs/2026-10-08-creator-studio-replicate-design.md`.

## State when handed off

| Task | Status | Commits |
|---|---|---|
| 1 Model registry | complete, reviewed | a2e9278 |
| 2 Provider | complete, reviewed after 1 fix round | 46069da, 8b8d8d0, cc7a575 |
| 3 Generation guard | complete, reviewed | b3c98fa, 7196840 |
| 4 Persist | implemented + hardened, **task review NOT yet run** | d4219e0, 97566e8 |
| 5 Gateway + route | **your task** | - |
| 6 Docs + full verification | yours after 5 | - |

Setup if starting fresh: `git submodule update --init --recursive && npm ci` (already done in this worktree).

## Your task: implement Task 5 exactly as written in the plan, with these binding rulings

The plan's Task 5 code predates four rulings made during review. The rulings win over the plan text.

1. **Submit failures carry `outcomeUnknown`** (from Task 2). `submitReplicateJob` now returns `{ ok:false, retryable:false, outcomeUnknown:true }` for timeouts, network errors, 5xx, bad/oversized/unreadable bodies and a 2xx with no valid id (a billed prediction may exist). It returns `outcomeUnknown:false` (or the field absent, for the 503 unconfigured case) for definite rejections (400/401/402/403/404/409/422/429).
   In `handleReplicateGenerate`, **call `releaseGeneration` (lock release + spend refund) only when `outcomeUnknown` is not true.** When it is true, keep the reservation (the 60s lock lapses on its own) and return the failure (`failureResponse` should also pass `outcomeUnknown` through so the UI can say "outcome unknown, check status before retrying"). Add a test: a timed-out live submit does NOT refund the ledger and does not allow an immediate duplicate; a 422 rejection DOES refund.
2. **Guard hardening** (Task 3): `reserveGeneration` only accepts `mode` `'live'|'mock'`, requires finite `estimateUsd >= 0`, validated `limits`. `releaseGeneration`/`refundSpend` need a server-held reservation; never build a reservation from client input. `refundSpend` rejects a malformed `ledgerDay`.
3. **Persist hardening** (Task 4): `persistGeneratedAsset` validates `record.jobId` (`/^[A-Za-z0-9_-]{3,60}$/`), `record.kind` (`image|video`) and requires `record.mock === jobId.startsWith('mock_')`. **Build the record only from server-side data** (the provider job and stored job record), never from client input. It streams downloads with a 250MB cap and deletes an orphaned blob if the Asset write fails.
4. **Overlapping polls:** `addCreatorAsset` can throw `CreatorProjectError` code `project_conflict` (409) when two polls race. The plan's `persistIfComplete` retry loop handles it; keep it and its test ("quote then generate then poll persists exactly once, even for overlapping polls").

Everything else in the plan's Task 5 stays as written: five handlers, the `parseCreatorJson` export, the `defaultBlobStore` import (already exported by Task 4), the five `case` lines in `app/api/creator/[[...path]]/route.js`, and the nine tests.

## Definition of done for Task 5

- `node --test tests/security/replicateGateway.test.js` passes; all earlier Replicate suites still pass.
- `npm run test:security` passes (baseline 235 plus the new Replicate tests).
- Commit with the trailer `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` (or your own attribution).
- Then do Task 6 as written (env docs + the full verification run: security, creator-shell 25, top-level 46, integration 5, lint, build). Report real counts and any failure honestly.

## Hard limits (do not do any of these)

- No live Replicate call, no real token, no paid generation. All tests use injected `fetchImpl`.
- Do not push, open a PR, merge, or deploy. Do not touch Production or any Vercel/Replicate/Blob configuration.
- Do not modify `~/Open-Generative-AI` or other branches.
- Do not remove the legacy MuAPI proxies, Electron code or submodules (that is Plan B).

## Known open items (for the final reviewer, not blockers for Task 5)

- Task 1 left model ids, input field names, enum values and prices **unverified** against live Replicate schemas (`replicate.com/*/api` returned stubs; the Replicate MCP needs a token). Must be verified before any live run.
- Task 3 minors: ledger read fails open on corrupt data (`generationGuard.js` ~115-123, 181-182); a corrupt lock blob causes a permanent 409; a bare `catch` maps lock-write outages to 409; quote binds the estimate to 4 decimals. Consider hardening in a follow-up.
- Task 3/4 assume real `@vercel/blob` `get()` returns `null` for a missing blob (same assumption the existing project store makes).
- Daily spend cap can be overshot by one job under simultaneous live requests (documented limitation, non-atomic Blob read-modify-write).
- Task 4's incremental 250MB cap is verified by reading the code, not by a test.
- Run the Task 4 task review (spec + quality) over `d4219e0^..97566e8` if you have capacity; none has been done.
