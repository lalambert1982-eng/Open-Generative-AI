# Replicate Creator Studio: UI follow-up design

Status: proposed for review, updated for the delivered backend contract.
No UI implementation has started.

Base: `rebuild/creator-studio-replicate`, backend complete through `887a858`
(including the accepted-job error contract).
Parent design: `2026-10-08-creator-studio-replicate-design.md`.
The backend handoff rulings and subsequent storage/spend fixes remain binding.

## Outcome and constraints

Continue the existing Creator Studio so its Image and Video destinations can
use the new Replicate backend, save into an owned Project, and reopen results.
Replicate is the default provider; MuAPI remains an explicit selectable option
through its existing authenticated server flow. Mock mode must clearly show
that no paid generation occurred.

Keep this increment local. No real provider or Blob calls, real credentials,
new npm dependencies, deployment, push, PR, merge, or changes to another branch.
Preserve legacy proxies, Electron, submodules, and other Studio capabilities.
Their removal is a separate task. Webhooks remain deferred.

The user asked to continue the verification and UI-planning steps while Claude
works. Claude's exact current scope is not yet confirmed. New verification and
design files can proceed independently; shared backend and shell edits need
agreed ownership before implementation.

## Current evidence

- `StandaloneShell.js` sends Image and Video to the packaged `CreatorStudio`.
- `CreatorStudio.jsx` currently submits both through the MuAPI media flow and
  fetches the existing `providers` endpoint. It does not use Replicate routes.
- `CreatorHome.js` offers navigation and Selena input, without recent Project
  generations or a Replicate model list.
- Projects and Assets already use the authenticated durable Project API.
- Replicate completion already adds its Asset to the Project on the server.
  The existing shell's generic completion callback also posts an Asset; the
  new flow must use a Project refresh instead of that callback.
- The new localhost HTTP smoke script passed 11/11 checks with real route
  dispatch and handlers, injected stores/provider fetch, and zero external
  calls. This verifies the API flow, not Next middleware or the browser UI.
- Mock video currently produces a PNG Asset of type `graphic`. Preview it as
  an image with a mock-placeholder label, not as an MP4 or playable video.

## Approach

Recommended: add a focused local media wrapper and Replicate component. The
wrapper owns the explicit provider selector. Replicate uses a small client
controller and registry-driven form; MuAPI renders the existing `CreatorStudio`
with its current secure props and callbacks. Switch only the existing Image
and Video destination cases to this wrapper.

The alternative is to add every Replicate state and setting to the large
packaged `CreatorStudio`. That would mix the new lifecycle with Selena,
publishing, Storyboard, and agent logic, and enlarge the shared edit surface.
A general provider framework is unnecessary for this increment.

Proposed file responsibilities:

| File | Responsibility |
| --- | --- |
| `src/lib/replicateStudioClient.js` | Same-origin requests, structured errors, quote invalidation, job polling/cancel and submission guards; injectable fetch/time for tests |
| `components/CreatorMediaStudio.js` | Explicit Replicate/MuAPI selection and existing Project/auth props |
| `components/ReplicateStudio.js` | Model settings, quote review, progress, persisted preview, download and saved-Project receipt |
| `components/StandaloneShell.js` | Wire existing Image/Video routes and refresh the originating Project safely |
| `components/CreatorHome.js` | Recent owned Project Assets and enabled featured models; retain Selena prompt entry |
| `tests/replicateStudioClient.test.js` | Behavioral tests for the client lifecycle with injected dependencies |
| `scripts/replicate-http-smoke.mjs` | Reproducible API smoke verification already implemented |

## API contract

| Endpoint | Request | Client use |
| --- | --- | --- |
| `GET replicate/models` | Authenticated session | Read authoritative mode, readiness, caps, enabled models and input specs |
| `POST replicate/quote` | `{ model, input }` | Read estimated price, signed token, expiry and per-job cap |
| `POST replicate/generate` | `{ model, input, projectId, quoteToken? }` | Submit once; handle terminal 200 or queued 202 |
| `GET replicate/status?id=...` | Known owned job ID | Poll or resume checking the same job |
| `POST replicate/cancel` | `{ id }` | Request cancellation; show the returned state |
| `GET projects/:id` | Originating Project ID | Refresh server-persisted Assets after completion |

Use credentials `same-origin` and JSON request bodies. Never import server
provider code or access provider environment variables in browser code.
Quotes are held only in memory. Clients never supply owner identity, price,
refund data, persistence records, provider URLs, or a mode override.

Only `job.asset.url` is a result URL. Do not display or invent `outputUrl`.
The models response supplies caps, not the owner's remaining daily balance;
the UI must not fabricate a remaining-budget value.

## User flow

1. Authenticate with the existing Creator session and select or create an
   owned Project. Disable generation until an owned Project is loaded.
2. Replicate is selected initially. Load server readiness and models, filter
   by image/video kind, and render only the selected model's declared inputs.
3. Use enum selectors, bounded numeric fields, toggles, prompt limits, and
   current-Project image/graphic Asset pickers for image references. Required
   references must be selected before quote or submission. No arbitrary
   provider payload editor or safety-bypass options.
4. Show an estimate and an explicit mock/live badge. In live mode, request a
   signed quote, show its price and expiry, and require a separate explicit
   confirmation. Changing model, inputs, or Project invalidates review; an
   expired quote must be refreshed and confirmed again. Formatting must retain
   small values such as `$0.003`, rather than rounding them to `$0.00`.
   An estimate above the returned per-job cap cannot submit; offer model or
   setting changes instead. The existing server applies that cap in mock mode
   too, so the default Video model must have settings within the configured cap.
5. Submit once with a synchronous in-flight guard before the first await.
   Freeze owner, Project, model and input context for the job. Never retry a
   create automatically or fall back to another model/provider.
6. Handle immediate completion and queued/processing jobs. Poll only the known
   job ID, with bounded scheduling. A status-read failure offers “Check status”
   for the same job; it does not submit another generation. A polling deadline
   does not itself establish provider failure or cancellation.
7. Cancel sends the known job ID. Show “Cancel requested” while still pending,
   and “Canceled” only on a confirmed returned state. Do not promise a cash
   refund; the server ledger tracks estimated reservations, not billing truth.
8. Completion shows the persisted Asset, download link, and “Saved to Project”
   receipt. Refresh Project data; do not post the same Asset again. The API
   requires a Project before generation and saves automatically, so a second
   manual Save action would misrepresent this behavior.
9. Reopening the Project shows the same Asset ID and URL. If selection changed
   during the job, update its originating Project summary without switching the
   user's current Project or inserting Assets into another Project's view.

Provider switching is explicit and disabled during an active/uncertain submit.
MuAPI uses its existing configuration policy; its `sandbox` label is not a
promise of Replicate-style zero-network mock behavior. No live MuAPI testing
or credential setup is included here. Selena may prefill a draft or navigate
to a Studio, but must not submit a generation.

## Error handling

- Authentication loss stops polling and clears owner-specific job/result state.
  A newly signed-in owner must not inherit another owner's pending UI state.
- Unknown submit outcomes (`outcomeUnknown: true`) retain their reservation.
  Keep an explicit uncertain state; no automatic resubmission. When no job ID
  is known, the UI cannot honestly offer a working status check or declare that
  nothing was generated. Require operator review before another submission.
- Temporary persistence errors preserve spend and remain recoverable by status
  when the job ID is known. Permanent invalid output fails without refunding a
  successful paid prediction.
- Disabled/unconfigured providers show readiness guidance and disable Generate.
  There is no silent mock or cross-provider fallback.

### Accepted-job error contract (backend delivered in `94e8049`, `887a858`)

If Replicate accepted the job but the job record or Asset could not be stored,
`generate` returns the original `error`, `code` and HTTP status plus:
`generationAccepted: true`, `jobId` (server-produced), `jobRecordState`
(`"confirmed"` | `"unconfirmed"`), `statusRecoveryAvailable` (boolean) and
`retryable: false`. These fields are absent on pre-submit failures, definite
provider rejections, and unknown submits with no provider ID (those carry
`outcomeUnknown: true` instead). Full contract: `docs/SECURITY_CONFIGURATION.md`.

Client rules:

- Branch on `generationAccepted` before the HTTP status. A 404 or 409 can
  accompany a valid `jobId`.
- `statusRecoveryAvailable: true`: adopt `jobId` as the active job and poll
  status. Show a saving-problem notice, not a failure. Never POST again.
- `generationAccepted: true` with `statusRecoveryAvailable: false`: show the
  `jobId` and an explicit uncertain state. Offer one "Check status" action
  that may return 404; treat 404 as "not recorded", not "nothing generated".
  Keep Generate disabled for that request until the user acknowledges the
  uncertainty, and say operator review is needed before resubmitting. The
  spend reservation is kept and the server duplicate lock lapses after 60s.
- `retryable: false` means there is no Retry-generation control anywhere.
- `outcomeUnknown: true` without a `jobId`: no status check is possible.
  Same uncertain-state rules as above, without a job ID shown.
- A confirmed job whose record is later found failed or refunded displays the
  server's returned state; the UI does not infer spend or refund itself.
- Known limitation: an unconfirmed job leaves no server-side trace and cannot
  be polled or cancelled later.

## Acceptance and verification

Use TDD for new client behavior. Cover quote expiry/input changes, two rapid
Generate clicks, immediate and queued success, confirmation requirements,
unknown outcomes with/without IDs, status recovery without another POST,
confirmed cancel, teardown, sign-out/owner switch, and Project changes during
completion. Assert requests and resulting user-visible state, not source text.

Browser verification must run through local fixtures that serve the real app
and route handlers with injected stores/provider responses. Fulfill fake Asset
URLs from memory and block other external requests before rendering media.
A local proxy and test-only service worker can provide that boundary without
new dependencies. Verify keyboard use, status/error announcements, mobile
layout, model settings, price review, mock image/video preview, saved receipt,
and Project reopen. Do not authenticate against real GitHub or fetch real Blob
media for this test.

API smoke reproduction on Node 24:

```sh
node --experimental-test-module-mocks scripts/replicate-http-smoke.mjs
```

The script uses fabricated credentials and in-memory stores. The two queued /
unknown-outcome scenarios enable live configuration only inside injected
fixtures; they do not call a real provider. Sandbox environments may require
permission to bind the localhost listener.

Before finishing implementation, rerun security, creator-shell, top-level and
integration tests, lint, build, and the relevant browser smoke. Record actual
counts and warnings. Live model IDs, schemas, enums, prices, provider billing,
and multi-instance atomicity remain unverified/deferred.

## Next implementation sequence, after design review

1. Agree on Claude/Codex file ownership (the known-job error contract is now delivered).
2. Write the detailed TDD plan for the client/controller and schema form.
3. Implement Image and Video using the shared focused component.
4. Wire Project refresh/receipt and guard against selection/owner changes.
5. Add Home's recent Assets and model entry points using the same data sources.
6. Run mocked browser/API verification and the complete regression/build checks.

Navigation removal, legacy cleanup, live smoke tests, and deployment are not
part of this sequence and require separate authorization.
