# Plan C cleanup and job-recovery verification

Local work on `rebuild/creator-studio-replicate`, continued on 2026-10-10 from `d4af462`. This report covers the legacy cleanup and recovery changes in the combined working tree. No push, merge, deployment, paid generation, real OAuth, or real Blob verification was performed.

## Changes

- Removed the legacy Electron/Vite app, Graphic Studio, Workflow/Agent Blueprint/Marketplace surfaces, old proxy/upload routes, and three legacy workspace gitlinks. Shared Git module storage and other worktrees were preserved.
- Extracted retained MuAPI agent helpers into a server-owned module. Removed browser key storage. Kept the Creator core and existing authenticated provider gateways.
- Consolidated the retained Studio workspace, Next build, Tailwind, Docker and CI configuration. Lockfile package entries decreased from 1,208 to 441 without upgrading retained dependency versions.
- Added separate owner-bound Image/Video recovery pointers and minimal uncertainty markers. Navigation/reload uses status checks rather than repeating generation; a resumed missing job remains uncertain until acknowledgment. Logout and confirmed auth loss clear both kinds of markers. Storage remains best effort, with a 30-minute validation limit.
- Fixed stale asynchronous replies and ambiguous submission/status handling. Final review also reproduced and fixed two defects: temporary session-check failures cleared recovery state, and manual checks could overlap automatic status polling. Unknown session results now preserve markers and block generation; status reads are serialized per job/epoch.
- Added the uncertainty-store suite to `test:replicate-ui` and corrected the local-run guide's outdated missing-job behavior.

## Fresh local verification

| Check | Result |
| --- | --- |
| Locked install | `npm ci --ignore-scripts --no-audit --no-fund`: exit 0, 381 packages installed |
| Security | 299/299 passed |
| Top-level tests | 205/205 passed |
| Creator shell | 26/26 passed |
| Replicate UI/recovery | 178/178 passed, independently repeated by reviewer |
| Integration defaults | 6/6 passed |
| HTTP smoke | 11/11 checks passed; 3 injected provider calls, 0 external calls |
| Lint | Exit 0; one existing `StudioAssets.js` native-image warning |
| Production build | Exit 0; credential-free temporary source copy, same final application files |
| Removed routes | No `/workflow`, `/agents`, `/assistant`, `/api/v1`, `/api/workflow`, or `/api/agents` entries in built app manifest |
| Compiled CSS | 43,079 bytes versus 223,513-byte pre-cleanup baseline; retained cyan-button utility present |
| Independent security/code review | No Critical or Important findings in reviewed cleanup, auth, recovery, and polling changes |
| Mocked browser | Final execution pending; see continuation below |

Suite counts overlap; do not sum them as unique tests. Compared with the recorded baseline, security changed from 318 to 299: 24 previous test names were removed/replaced and 5 added, covering removal of obsolete BYOK/upload/Canvas/Electron paths and stronger retained guards. Top-level tests changed from 111 to 205: 29 names removed/replaced and 123 added across recovery, submission uncertainty, race handling, fixture, and cleanup guards. Shell changed from 25 to 26; UI changed from 65 to 178, including the newly registered uncertainty-store tests. Integration and HTTP counts remain 6 and 11.

The first offline install failed because a locked package was absent from npm's cache. Approved registry access restored the install. Local HTTP tests initially encountered sandbox `listen EPERM`; their approved loopback reruns passed. The initial build could not reach Google Fonts; its approved network rerun downloaded the existing Inter font and passed. No application/provider secrets were used. Existing module-type, experimental module-mocking, and outdated Browserslist warnings remain non-failing.

## Review and evidence

Ignored local working records are under `.superpowers/sdd/2026-10-10-legacy-cleanup-and-job-resume/`: `resume-final-report.md`, `security-final-review.md`, and `progress.md`. The recovery report records failing regression tests before each fix. The independent reviewer checked browser credential guards, route authorization and exceptions, import/navigation pruning, owner/kind/time validation, and the final session/poll fixes.

The protected Replicate gateway, generation guard, persistence, provider, Creator authentication, Creator routes, middleware and Studio route have no behavioral diff from the Plan C starting point. The scoped agent-gateway extraction only changes its import target/comments. Replicate still defaults to mock with $1/job and $5/owner/day caps.

## Remaining scope

Live model/schema/pricing verification, paid Replicate calls, real owner OAuth and Blob tests, Preview/production deployment, `Sec-Fetch-Site` hardening, CSP narrowing, and distributed accounting remain separate follow-ups. Normal persisted mock app use still requires owner OAuth and both Blob stores. The credential-free fixture uses fabricated sessions and in-memory stores. See [the local-run guide](../../LOCAL_RUN.md).
