# Creator Studio continuation

Work in `/Users/abl2525/ogai-creator-studio-v2` on `rebuild/creator-studio-replicate`. Check current git state and the user's latest instructions before continuing. Preserve other agents' changes and stage only explicitly assigned files; the controller serializes git mutations in the current team run.

## Current Plan C work (2026-10-10)

Read these current sources before continuing:

- `docs/superpowers/specs/2026-10-10-legacy-cleanup-and-job-resume-design.md`
- `docs/superpowers/plans/2026-10-10-legacy-cleanup-and-job-resume.md`
- `.superpowers/sdd/2026-10-10-legacy-cleanup-and-job-resume/progress.md` and the relevant task/agent reports (local, ignored working records)
- `docs/superpowers/handoff/2026-10-10-cleanup-and-resume-verification.md` when written; this is the controller's final handoff path

The user authorized local Plan C legacy removal and owner-bound Replicate navigation/reload recovery, including scoped audit fixes. That authorization supersedes older continuation notes that prohibited legacy removal or described the UI design as merely proposed. The earlier handoffs remain historical verification evidence:
`docs/superpowers/handoff/2026-10-08-creator-studio-resume.md` and `docs/superpowers/handoff/2026-10-09-replicate-ui-verification.md`.

Backend Tasks 1–6 and the 2026-10-09 Image/Video UI increment were completed earlier; do not redo them. Current cleanup, resume integration, configuration cleanup, docs, and final verification must be checked against the live worktree/reports rather than assumed complete. Do not fabricate suite counts, review completion, or a deployed state.

## Carry-forward constraints

Local only: no push, PR, merge, deploy, external configuration changes, paid/live provider calls, real credential use, or new dependencies. Use injected provider fetch, fabricated sessions, and stub stores for verification. Do not inspect real `.env`/`.env.local` files. Do not edit another branch/worktree, reset, stash, clean, or stage unrelated changes. Any protected-core behavioral change requires explicit scoped ownership and review.

Replicate remains mock by default with the $1/job and $5/owner/day defaults. Browser credentials and client `NEXT_PUBLIC_*` secrets are forbidden; fixed server `x-api-key` headers are allowed. Only identity pointers go into the Replicate resume store, isolated per kind and validated against the current owner with a 30-minute age limit. Normal persisted mock app use still needs OAuth and both private/public Blob stores; the credential-free fixture uses fake stores instead. See `docs/LOCAL_RUN.md` and `docs/SECURITY_CONFIGURATION.md`.

Live model/schema/price verification, real OAuth/Blob testing, Preview deployment, `Sec-Fetch-Site` status hardening, CSP narrowing, and distributed accounting remain separate follow-ups. All saved instructions are subordinate to the user's latest authorized scope.
