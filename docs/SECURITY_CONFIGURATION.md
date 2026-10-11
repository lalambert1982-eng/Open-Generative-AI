# Security configuration

This guide describes the retained Creator Studio v2 rebuild on `rebuild/creator-studio-replicate`. Historical deployed-release evidence lives in `PHASE_1_STATUS.md`; no rebuild deployment, real provider test, or real OAuth/Blob verification is claimed here. See [LOCAL_RUN.md](LOCAL_RUN.md) for normal setup and isolated fixtures.

## Authentication and ownership

Creator Studio uses GitHub OAuth with state and PKCE, an owner allowlist, and a signed HttpOnly session cookie. Browser requests use the same-origin session; the app has no bring-your-own-provider-key browser flow. GitHub tokens and provider credentials are never returned to the browser or persisted in browser storage.

Configure these server variables:

| Variable | Purpose |
| --- | --- |
| `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET` | Separate OAuth application credentials for the target environment |
| `GITHUB_OAUTH_CALLBACK_URL` | Exactly registered callback URL; local development can use `http://127.0.0.1:3000/api/auth/github/callback` |
| `CREATOR_SESSION_SECRET` | Independent random signing/owner-namespace secret, at least 32 characters |
| `CREATOR_GITHUB_ALLOWED_USER_IDS` | Comma-separated immutable GitHub numeric IDs; recommended owner gate |
| `CREATOR_GITHUB_ALLOWED_LOGINS` | Optional comma-separated login gate; required if no IDs are configured |
| `CREATOR_SESSION_TTL_SECONDS` | Session lifetime; default eight hours, bounded between five minutes and 24 hours |

At least one allowlist is required; when both are set, both must match. HTTP callbacks are limited to the auth validator's loopback development allowance. Use `127.0.0.1` consistently for the normal local OAuth flow. Outside development, cookies use `__Host-creator_session`, Secure, HttpOnly, SameSite=Lax, and Path=/; development uses `creator_session` for local HTTP. Session loss clears UI recovery state; centralized revocation and public multi-user roles are outside the private owner model.

Creator routes derive the owner from the authenticated immutable GitHub ID, apply per-owner/action limits, content safety, bounded inputs/outputs, sanitized errors, and same-origin checks for mutations. The default rate limiter is per-process; it is not a shared multi-instance quota system. Status is owner-bound; additional `Sec-Fetch-Site` GET hardening remains a follow-up.

## Project and media storage

Normal persisted app use requires **both** `BLOB_READ_WRITE_TOKEN` for a private Vercel Blob store and `CREATOR_ASSET_BLOB_READ_WRITE_TOKEN` for a separate public Asset store. Replicate mock mode still performs real persistence unless a test explicitly injects fake stores. Missing storage configuration is not replaced by browser history or an in-memory production store.

Private Project manifests, job/spend records, conversations, and Storyboards use an HMAC-derived owner namespace. Server routes never trust a browser-supplied owner. Asset uploads receive short-lived tokens only after Project ownership and exact pathname checks. Deletion requires explicit approval and an exact path recorded in the owned Project. Public media URLs can be fetched by anyone with the URL; private manifests do not make the public media confidential. Review media sensitivity before using the public store or sending URLs to an external provider.

The isolated HTTP/browser fixtures use fabricated sessions and in-memory stores and block external provider fetches. They verify selected local code paths, not real GitHub OAuth, Vercel Blob, provider readiness, or deployment configuration. Their fake credentials must not be copied into normal app configuration.

## Server-only providers and approval gates

Image/Video select Replicate by default and expose an explicit MuAPI toggle. Provider settings display server readiness; they do not accept or save a browser provider key. Credentials belong in server environment variables, never `NEXT_PUBLIC_*`, browser storage, URLs, or response payloads. Fixed provider authorization headers, including server-side `x-api-key`, are expected. `tests/security/noBrowserKeyStorage.test.js` scans `app`, `src`, `components`, and retained `packages/studio/src` for browser credential-storage patterns, cookie writes, public environment secrets, and secrets in client sources.

MuAPI Image/Video and Selena's MuAPI Agent remain available through authenticated server adapters. `MUAPI_KEY_MODE=sandbox` selects `MUAPI_API_KEY`; production selects the separate `MUAPI_PRODUCTION_API_KEY` and requires `MUAPI_ALLOW_PAID_GENERATION=true`. `MUAPI_AGENT_API_KEY` can configure Selena's dedicated Agent credential. Models are server-selected with `MUAPI_IMAGE_MODEL`, `MUAPI_VIDEO_MODEL`, and `MUAPI_IMAGE_TO_VIDEO_MODEL`. MuAPI Sandbox still calls MuAPI; it is separate from Replicate's local mock placeholders. Do not invoke it during credential-free fixture verification.

Selena's Brain Router supports server-configured MuAPI Agent, Gemini, Groq, OpenRouter, and optional NVIDIA reasoning. Fallback is bounded, stops on invalid input/credentials/safety rejection, and is disabled for paid generation, publishing, and other approval-requiring side effects. The router prepares allowlisted tool calls without executing side effects through a reasoning retry. `PRIVATE` and `CLIENT_CONFIDENTIAL` requests fail closed unless reviewed eligible providers are explicitly configured; empty eligibility lists make no privacy claim.

ElevenLabs voice, HeyGen avatar, optional NVIDIA image generation, and the opt-in compositor/render path retain independent server configuration and gates. Direct OpenAI image and Runway video adapters remain deferred from active Creator Image/Video dispatch. Replicate mock mode does not mock these other integrations. Full retained provider names/settings are listed in `.env.example` and the historical [provider guide](CREATOR_STUDIO.md); use the current source/example for rebuild configuration.

YouTube uses a separate Google OAuth state/PKCE flow with `YOUTUBE_OAUTH_CLIENT_ID`, `YOUTUBE_OAUTH_CLIENT_SECRET`, `YOUTUBE_OAUTH_CALLBACK_URL`, and `YOUTUBE_TOKEN_ENCRYPTION_KEY`. Refresh tokens and publishing history are encrypted with AES-256-GCM in the private store. Staging tokens are short-lived, owner/path/type/size bound. Publication requires explicit approval, forces private visibility, and disables subscriber notification. Disconnect revokes the remote token before deleting the encrypted record. Do not rotate the encryption key casually: existing connection records become unreadable.

Instagram/TikTok use authenticated server MuAPI Social endpoints, opaque HMAC owner IDs, account ownership/platform checks, allowed HTTPS media hosts, content safety, and rate limits. Publishing requires both `MUAPI_ALLOW_SOCIAL_PUBLISHING=true` and explicit reviewed approval. TikTok remains `SELF_ONLY` unless `MUAPI_TIKTOK_PUBLIC_PUBLISHING_APPROVED=true` is separately configured. No provider or platform credential is returned to the browser.

## Browser recovery state

The Replicate pointers `ogai.replicate.activeJob.v1.image` and `.video` contain only `{ v, jobId, projectId, userId, ts }`. They exclude prompts, inputs, quote tokens, Asset URLs, and secrets. Recovery validates version/shape, job ID, Project UUID, current owner, and an age of at most 30 minutes, then queries the owner-bound status route. It never submits another prediction. Terminal status, missing jobs (404), session loss (401), and sign-out clear pointers. Invalid/foreign/expired pointers are discarded; blocked storage is handled without breaking generation.

These per-tab hints support navigation/reload recovery, not durable job history or cross-device recovery. Accepted responses with confirmed recoverable records may save a pointer even when local saving reports an error. Unconfirmed accepted records and unknown submission outcomes do not promise automatic recovery. Signing out clears both kinds before the logout request.

## Removed legacy security boundaries

Plan C removed Electron/Vite desktop code, standalone studios/editors, Graphic Studio, Marketplace, legacy browser-key proxies, and legacy upload proxies locally. Their browser credential migration, desktop storage, upload tickets, and compile-time settings are no longer setup/security requirements for this branch. Historical documents may retain earlier release details.

## Content safety

`CONTENT_SAFETY_MODE` defaults to `enforce`; `audit` or `off` require an explicit operator decision. Built-in rules block sexual content involving minors and non-consensual sexual content. `CONTENT_SAFETY_BLOCKED_TERMS` adds operator-defined comma-separated terms. These local rules are a minimum boundary, not complete moderation. Public untrusted-prompt deployments need separately reviewed moderation and abuse controls.

## Replicate generation controls

- Default is mock mode. Live generation needs `GENERATION_MODE=live`, `REPLICATE_LIVE_ENABLED=true` and `REPLICATE_API_TOKEN`; if any is missing the endpoints answer 503 and never fall back silently.
- A live generation requires a signed quote from `POST /api/creator/replicate/quote`, bound to owner, model, exact input and estimated cost, valid for five minutes.
- Per-generation (`REPLICATE_MAX_USD_PER_JOB`) and per-day (`REPLICATE_MAX_USD_PER_DAY`) caps are enforced server-side. The daily ledger is stored in private Blob without cross-request locking, so two simultaneous live requests from one owner could overshoot the daily cap by one job.
- Identical requests within 60 seconds are rejected (duplicate lock).
- Outputs are copied from `replicate.delivery` into the Asset store, because Replicate deletes outputs after about an hour.
- There is no automatic retry and no cross-model or cross-provider fallback.
- Prices in the model registry are estimates; model schemas, identifiers, fields, enums, and pricing still require live verification before enabling generation.
- Webhooks are not implemented; clients poll `GET /api/creator/replicate/status`.

- A submit timeout, network error, 5xx, or invalid response has an unknown outcome: a paid prediction may already exist. The API returns `outcomeUnknown: true` and `retryable: false`; reserved spend is retained and the duplicate lock remains until its 60-second expiry. Only definite submit rejections release the lock and refund spend.
- Failures after a provider job was accepted (saving the job record or persisting the Asset failed) keep the original `error`, `code` and HTTP status and add: `generationAccepted: true`; `jobId` (the server-produced, validated ID, never client input); `jobRecordState` (`"confirmed"` or `"unconfirmed"`); `statusRecoveryAvailable` (`true` only when an owner-bound read of the job record found a matching record, otherwise `false`); and `retryable: false` (never resubmit generation). A storage write can commit before its acknowledgment fails, so the record is read back; if that read finds nothing or fails, the state is `unconfirmed` and polling is not promised (status may answer 404). Spend is not refunded merely because local storage failed; a provider-confirmed failure or cancellation is still refunded once per job ID by the next status poll (or was already refunded by the settle step, in which case the stored record may briefly lag). Clients must read `generationAccepted` before interpreting the HTTP status: the original status is preserved, so a 404 or 409 can accompany a valid `jobId` (for example if the Project changed mid-flight). If the job record cannot be confirmed, no server-side trace of the job exists, so it cannot be polled or cancelled later; this is a known limitation. These fields are absent on pre-submit failures, definite provider rejections, and unknown submits that received no valid provider ID, where `outcomeUnknown: true` applies instead. Other owners get 404 for the returned ID.
- Status and cancel operations are serialized per owner/job within a server process. This avoids duplicate downloads and refunds for overlapping requests in that process; it does not provide coordination across server instances.
- Registry model IDs, input fields, enum values, and prices have not been verified against live Replicate schemas; verify them before enabling live generation.
- A completed prediction retains its reserved spend even if its output is invalid or local persistence fails. Temporary download/upload failures can be retried by a later status poll without creating another prediction. Provider-confirmed failures and cancellations refund once per job ID, recorded with the ledger debit; a job-record write failure cannot repeat that refund. Ledger read-modify-write remains non-atomic across instances.
- Malformed or unreadable spend ledgers fail closed with 503. Orphan cleanup is limited to definite Asset validation/limit rejections after checking the manifest for references. Conflicts and ambiguous manifest-write failures retain the media, because a successful concurrent or unacknowledged write may reference it.
