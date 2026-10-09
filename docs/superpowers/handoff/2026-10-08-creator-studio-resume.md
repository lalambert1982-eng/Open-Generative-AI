# Creator Studio resume state — 2026-10-08

Read this before resuming. It updates the older Task 5 handoff's completion
status and open-item list; its safety rulings still apply. Check git status
and current history rather than assuming this snapshot is current.

## Project and workspace

- Project: Open Generative AI Creator Studio v2, web-only Creator rebuild.
- Worktree: `/Users/abl2525/ogai-creator-studio-v2`.
- Branch: `rebuild/creator-studio-replicate`.
- Local-only work; nothing pushed, merged, deployed, or submitted as a PR.
- Implementation/planning baseline before saving this handoff: `109a806`.
- User said Claude is working, but its exact active scope was not confirmed.
  The recovery task below is recommended, not confirmed as dispatched.

## Completed; do not repeat

Replicate backend Tasks 1–6 are implemented and committed. Tasks 5/6 plus
the final-review fixes were completed by Codex. The whole-backend review
included the previously unreviewed persistence code. Its five findings were
fixed using failing regression tests, then verified; no second review was run.

Recent Codex commits:

| Commit | Work |
| --- | --- |
| `0d75d77` | Owner-bound Replicate endpoints, parser export, route wiring and gateway tests |
| `15face2` | Environment and security documentation |
| `613bb53` | Spend/media storage-failure hardening and five review fixes |
| `44558fc` | Standalone mocked localhost HTTP smoke verification |
| `109a806` | Proposed Image/Video UI follow-up design |

The guard's corrupt-ledger fail-open finding is fixed; the old handoff and
earlier ledger entries describing it as open are historical. Refund identities
are stored with ledger debits, preventing sequential duplicate refunds after
lost ledger/job-write acknowledgments. Accepted/successful predictions keep
their reservations through local persistence failure. Temporary persistence
errors can recover through status when a job ID is known. Conflicts and
ambiguous manifest-write errors defer media cleanup.

The gateway serializes owner/job operations within a server process. It still
does not provide distributed exactly-once operations or atomic daily accounting.
Terminal create replies settle immediately; mock video is a PNG graphic
placeholder, not playable video.

## Verification actually run

After the final backend fixes at `613bb53`:

| Command | Result |
| --- | --- |
| `npm run test:security` | 310/310, no failures/skips/cancellations |
| `npm run test:creator-shell` | 25/25 |
| `node --test tests/*.test.js` | 46/46 |
| `node --test tests/integration/*.test.js` | 6/6 |
| `npm run lint` | Exit 0, 0 errors; one existing `StudioAssets.js` no-img-element warning |
| `npm run build` | Exit 0; 11/11 static pages generated |

Initial build encountered Google Fonts DNS errors and was interrupted by a
daemon restart. A permitted network retry passed; the final cached-font build
also passed in the sandbox. No dependency or font configuration changes made.

The HTTP smoke at `44558fc` passed 11/11 checks, with three injected provider
calls and zero external calls. It runs the actual Creator route dispatch and
handlers over localhost with fake sessions and in-memory Blob stores. It
does not verify Next middleware or browser UI. A subsequent security rerun
again passed 310/310. Syntax check and diff whitespace check also passed.

Reproduce the HTTP smoke on Node 24:

```sh
node --experimental-test-module-mocks scripts/replicate-http-smoke.mjs
```

The module-mocking flag is experimental. The sandbox may require permission
to listen on localhost. The script blocks external fetches and uses only
fabricated credentials. The two live-configured scenarios are injected
fixtures, not real generations.

## Next task and ownership

Saved Claude Code prompt:
`docs/superpowers/handoff/2026-10-08-claude-replicate-recovery.md`.

Recommended Claude task: fix the accepted-job error response contract. If
submission succeeds but job/Asset storage fails, the API currently drops the
known server job ID. Return the known validated identity and confirmed versus
unconfirmed status-recovery availability without refunding or resubmitting.
Handle writes that commit before their acknowledgment fails.

Keep Claude's backend scope separate from frontend changes. Do not assume
the prompt was already executed; inspect code/history for its completion.

Codex/UI follow-up design:
`docs/superpowers/specs/2026-10-08-replicate-ui-followup-design.md`.
It is proposed, not yet approved. No new UI code or detailed implementation
plan has been written. The next stage is user review of that written design,
then a detailed TDD plan and agreed file ownership. The accepted-job response
contract is a dependency for reliable UI error recovery.

The current Image/Video UI still uses MuAPI. Proposed UI work: focused
Replicate client/component, explicit MuAPI toggle, server model settings,
signed cost review, progress/cancel, mock-aware persisted preview, Project
refresh without duplicate Asset creation, and Home's recent Assets/models.
Protect owner and originating-Project context during asynchronous completion.

## Carry-forward limits and unverified items

- No real Replicate, MuAPI or Blob calls, paid generations, or real tokens.
  All tests use injected provider fetch and stub stores.
- No new npm dependencies; no push, PR, merge, deploy, or external/Production
  configuration changes. No edits to `~/Open-Generative-AI` or another branch.
- Preserve legacy MuAPI proxies, Electron and submodules. Cleanup is separate.
- Preserve other agents' changes; do not reset, stash, clean, or stage unrelated
  files. Check working-tree state before starting.
- Live model IDs, fields, enum values, prices and actual failed/canceled billing
  remain unverified. Live generation stays off.
- Multi-instance accounting/persistence guarantees remain limited. Installed
  Blob SDK source confirmed `get()` returns null on HTTP 404; no live Blob test.
- The 250MB incremental stream cap remains code-reviewed, without a full-size
  threshold test. Media magic-byte validation remains an accepted omission.
- All continuation instructions remain subordinate to the user's latest scope
  and explicit approvals. Saving this note did not approve UI implementation.

## UI increment (2026-10-09) — implemented locally, nothing pushed

Plan: `docs/superpowers/plans/2026-10-09-replicate-creator-ui.md` (executed with subagent-driven development; commits `240dfd6..f18eb72`).
Built: `src/lib/replicateStudio{Form,Client,View}.js`, `components/ReplicateStudio.js`, `components/CreatorMediaStudio.js`, Image/Video routed through the wrapper in `StandaloneShell.js`, Home recents/models, mocked browser fixture `scripts/replicate-ui-fixture-server.mjs` + dev-only rewrite in `next.config.mjs`.
Verified (controller re-run at f18eb72): test:security 318/318, creator-shell 25/25, test:replicate-ui 65/65, top-level 111/111, integration 6/6, HTTP smoke 11/11, lint 0 errors (1 pre-existing warning), `npm run build` rc 0, headless-Chrome mocked checklist 10/10 (see the verification doc).
Not verified / limitations: see `docs/superpowers/handoff/2026-10-09-replicate-ui-verification.md` (navigation/reload mid-job loses the on-screen job; live-mode paths only unit-tested; onAuthLost not wired; live model schemas/prices unverified; no real provider, Blob or GitHub call was ever made).
Next: owner decisions (job-resume persistence, Plan C legacy cleanup + Preview deploy, live-model verification with approval).
