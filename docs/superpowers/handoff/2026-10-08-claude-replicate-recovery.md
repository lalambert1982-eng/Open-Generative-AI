# Claude Code prompt: Replicate accepted-job recovery

Recommended next backend task. This prompt has been saved; it has not been
confirmed as dispatched to Claude. Paste the following into Claude Code.

```text
Working directory: ~/ogai-creator-studio-v2
Branch: rebuild/creator-studio-replicate
Local only. Work autonomously on this narrowly scoped backend fix.

Tasks 1–6 are already complete. Do not redo them.
Implementation baseline: 109a806. Check current HEAD and git status first;
later handoff-only commits may exist.

FIRST READ:
- docs/superpowers/handoff/2026-10-08-creator-studio-resume.md
- docs/superpowers/handoff/2026-10-08-codex-task-5-gateway.md
- docs/superpowers/specs/2026-10-08-replicate-ui-followup-design.md
  especially “Error handling and one backend dependency”
- docs/SECURITY_CONFIGURATION.md, Replicate section
- src/lib/replicateGateway.js
- tests/security/replicateGateway.test.js
- scripts/replicate-http-smoke.mjs

TASK

Fix handleReplicateGenerate’s error response when Replicate submission
succeeds, but saving the job record or persisting its Asset fails.

Currently the response omits the known job ID. The browser cannot recover
through status, although an owned queued record may already exist.

For failures AFTER a valid provider job has been accepted, preserve the
original error/status/code and add:

- generationAccepted: true
- jobId: the validated, server-produced job ID
- jobRecordState: "confirmed" or "unconfirmed"
- statusRecoveryAvailable: true only when an owned matching record is
  confirmed readable
- retryable: false, meaning do not retry generation submission

Use an owner-bound record read to confirm recovery availability. A storage
write can commit before its acknowledgment fails. If the read returns
nothing or fails, report unconfirmed recovery; do not promise that polling
will work.

Do not attach this metadata to pre-submit failures, definite provider
rejections, or unknown submits where no valid provider ID was received.
Never derive the job ID or recovery state from client input.

Preserve all existing spend/security behavior:
- Unknown submissions retain their reservation and duplicate lock.
- Accepted jobs are not refunded merely because local storage failed.
- Successful paid predictions with invalid outputs retain spend.
- Refunds remain idempotent by job ID.
- Ambiguous manifest failures do not delete potentially referenced media.
- Other owners still receive 404 for status/cancel/project access.
- Never automatically resubmit a prediction.

TDD

Write regression tests, observe the expected failures, then implement.
Cover:
1. Mock upload failure returns a recoverable job ID; use that response ID
   to poll and persist successfully, without deriving it from a fixture.
2. Initial job-record write fails before committing: accepted job ID is
   returned, recovery is unconfirmed, spend remains reserved.
3. Job-record write commits then throws: an owner-bound read confirms
   recovery and polling succeeds.
4. Recovery read fails: no false recovery promise or sensitive-data leak.
5. Unknown/pre-submit failures do not invent or echo a client job ID.
6. A second owner cannot use the returned recovery ID.

Update the HTTP smoke script to recover using the response’s job ID.
Document the response contract in SECURITY_CONFIGURATION.md.

SCOPE

Edit only the gateway, relevant tests, HTTP smoke script, and backend
documentation. Do not edit frontend components, the UI design, model
registry, or unrelated files. Check git status first and preserve any
other agent’s work; stage only your own files.

HARD LIMITS

No real Replicate, MuAPI, or Vercel Blob calls; no real credentials.
All provider tests use injected fetchImpl and stub stores.
No new npm dependencies.
No push, PR, merge, deploy, external configuration changes, legacy
removal, or edits to ~/Open-Generative-AI or another branch.

VERIFY

Run:
- node --test tests/security/replicateGateway.test.js
- npm run test:security
- npm run test:creator-shell
- node --test tests/*.test.js
- node --test tests/integration/*.test.js
- npm run lint
- npm run build
- node --experimental-test-module-mocks scripts/replicate-http-smoke.mjs

The smoke script binds localhost and uses fabricated credentials and
in-memory stores. Request sandbox permission if listening is blocked.

Do not skip or weaken failing tests. Fix the cause or report the blocker.
Commit locally with a clear message.

FINAL REPORT

Give the commit SHA/subject, exact response contract, actual verification
counts/results, deviations, and anything unverified. Do not claim a
check passed unless you ran it.
```
