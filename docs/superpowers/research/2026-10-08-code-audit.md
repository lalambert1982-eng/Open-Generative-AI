# Existing Code Audit: Open-Generative-AI (read-only)

Inspected: the integration worktree `~/ogai-integration-2026-10` (HEAD 6dd896b) and the `origin/main` ref in `/Users/abl2525/Open-Generative-AI`. Nothing was run, built or fetched. All claims below are from reading code. Tests were not run.

All file paths are relative to the repo root.

## 0. Branch/base finding (important)

- The local `origin/main` ref is **4a9e508**, "Merge pull request #24 ... integration/consolidate-2026-10". It already contains the NVIDIA provider, timeline compositor, Layout mode, ESLint flat config and opt-in defaults (log: 2fb5b74, 4a87b16, 5cb5d03, 88b13d0, ba29380).
- 4aea67a (the SHA you cited) is not a known object here (not verified; probably a stale or mistyped SHA, or newer than my last fetch).
- The integration worktree is only **4 commits ahead** of that ref, not ~15 (`git log origin/main..integration/consolidate-2026-10`):
  - cca068e Storyboard exports wired to render
  - 4012517 `.vercelignore`
  - 3410c6d preview verification doc
  - 6dd896b session checkpoint
- Changed in those 4 commits: `components/StandaloneShell.js`, `packages/studio/src/components/StoryboardWorkspace.jsx`, `storyboardWorkspaceModel.js`, `tests/storyboardRender.test.js`, `.vercelignore`, `ci.yml`, docs. They are small and not pushed.
- Also: the main checkout is on `recovery/creator-studio-2026-09-29`, not `main`.

## 1. Module classification

| Area | Verdict | Key files and reason |
|---|---|---|
| GitHub OAuth + signed session | KEEP | `src/lib/creatorAuth.js:122-221` (HMAC cookie, `CREATOR_SESSION_SECRET`, TTL clamps, same-origin mutation check at :199). `app/api/auth/github/{start,callback}/route.js` use PKCE-style verifier/state cookies and `timingSafeEqual`. Caveat: it is a **single-owner allowlist** (`CREATOR_GITHUB_ALLOWED_LOGINS` / `_USER_IDS`, `creatorAuth.js:107-120`), so multi-user signup needs a policy change. |
| Project/Asset store | KEEP, extend | `src/lib/creatorProjectStore.js` (896 lines) and `creatorProjectRoutes.js`. Details in sections 5 and 6. |
| `authorizeCreatorRequest` (auth + CSRF + rate limit) | KEEP | `creatorProviderGateway.js:118-162`. Reuse as the guard for new Replicate routes. |
| Rate limiter | SIMPLIFY | `src/lib/rateLimit.js` is an in-memory `globalThis` Map (:1-5), so it is per-serverless-instance and not a real limit on Vercel. Replace it with a durable store (KV/Redis) for per-user and per-job caps. |
| Selena orchestrator | KEEP (lightweight) | `src/lib/selenaOrchestrator.js`. Static action registry with `requiresApproval` (:8-35, only 3 available actions), plan schema (:38-70), bounded context (:~150). It only suggests actions and does not execute. Add replicate action ids here. |
| brainRouter | SIMPLIFY | `src/lib/brainRouter.js` (976 lines). Provider chain muapi-agent, gemini, groq, openrouter, nvidia, with privacy-eligibility lists. Far heavier than "lightweight Selena" needs. Keep one provider (or a 2-provider fallback). Returns 503 `provider_configuration_missing` when keys are absent (:906-942). |
| `creatorAgentGateway` / `creatorAgentRegistry` | DEFER | Agent-team delegation (MuAPI Agent Blueprint). Imports `studio/src/muapi.js` (`creatorAgentGateway.js:17`), which is a coupling to the studio package. |
| MuAPI creator provider | KEEP | `src/lib/muapiCreatorProvider.js` is a clean server-side adapter (section 2). |
| `muapiProxy.js` / `app/api/v1/**` / `app/api/api/v1/**` / `app/api/app/**` / `upload_file` / `get_upload_url` / `upload-binary` / `handleUploadProxy` / `uploadTicket` | DEFER or REMOVE | Legacy BYO-key proxy: the browser holds the user's MuAPI key (`localStorage` `muapi_key`, `StandaloneShell.js:22`; `x-api-key` set in `packages/studio/src/muapi.js:23-391`). It violates "token never in browser" for Replicate. The proxy itself is decently hardened (header blocklist, `muapiProxy.js:4-35`). Not needed for Phase 1. |
| ImageStudio / VideoStudio | SIMPLIFY or REPLACE | `packages/studio/src/components/{ImageStudio,VideoStudio}.jsx` are legacy BYO-key components using `muapi.js` direct calls. The current shell routes Image/Video to `CreatorStudio` with `allowedToolIds` (`StandaloneShell.js:500-501`), which calls `/api/creator/*` (`CreatorStudio.jsx:991`). `CreatorStudio.jsx` is large and multi-tool. A fresh, small Image/Video Studio on the `/api/creator` pattern is cleaner. `src/components/*.js` is a duplicate legacy Vite/Electron UI. |
| Storyboard | DEFER | `StoryboardWorkspace.jsx`, `storyboardWorkspaceModel.js`, `creatorTimeline.js`, `creatorCompositor.js` (ffmpeg), `renderCreatorTimeline` in the store. Gated by `CREATOR_RENDER_ENABLED=false`. Not Phase 1. |
| Workflow engine | DEFER | `creatorWorkflowEngine.js` (696 lines). Sequential approved nodes, a `waiting_for_approval` state and `MAX_WORKFLOW_RUNS=20` (:63) are good patterns, but it is hard-wired to MuAPI/HeyGen (:9-18). |
| Social publishing | DEFER | `muapiSocialPublishing.js`, `youtubePublishing.js` (1055 lines), `app/api/social/**`. Off by default (`MUAPI_ALLOW_SOCIAL_PUBLISHING=false`). |
| Other providers | DEFER | `heygenProvider.js`, ElevenLabs/OpenAI/Runway handlers in the gateway, `nvidiaCreatorProvider.js`. Already tagged `deferred` in `deferredGenerationProviderStatuses` (`creatorProviderGateway.js:358`). |
| Content safety | KEEP | `contentSafety.js` (`evaluateJsonSafety`), `CONTENT_SAFETY_MODE=enforce`. |
| Graphic/Layout, Agents UI, Workflow UI, Cinema, LipSync, Apps and the rest | REMOVE or DEFER | Dozens of legacy studios in `packages/studio` (about 25 components). |
| `StandaloneShell.js` | SIMPLIFY | 591 lines, 6 nav groups and about 30 destinations. Rebuild the shell to Home/Image/Video/Projects/Assets only. |

## 2. Provider-adapter pattern (where Replicate plugs in)

There is **no provider registry or model registry**. Providers are hand-wired:

- Tool ids: `src/lib/creatorToolRegistry.js:1-11` (`MUAPI_IMAGE_TOOL_ID` etc., frozen descriptors with `accepts` / `returns`).
- Status list: `generationProviderStatuses` (`creatorProviderGateway.js:324`).
- Route switch: `app/api/creator/[[...path]]/route.js` (a literal `switch` over `GET:providers`, `POST:image`, `POST:video`, `GET:muapi/status`, ...).
- The MuAPI model is chosen from env (`MUAPI_IMAGE_MODEL`, `MUAPI_VIDEO_MODEL`, `MUAPI_IMAGE_TO_VIDEO_MODEL`). There is no catalog. NVIDIA has `nvidiaImageModelRegistry()` (`nvidiaCreatorProvider.js:60`). The static `models_dump.json` and `packages/studio/src/models.js` are legacy MuAPI catalogs.

Adapter shape (`src/lib/muapiCreatorProvider.js`) to mirror for a `replicateCreatorProvider.js`:

```js
muapiConfiguration(env) -> {configured, missing[], apiKey, keyMode, paidGenerationAllowed, imageModel, ...}   // :243
muapiProviderStatus(env) -> {id,label,capability,toolIds,configured,status,model,...}                       // :266
normalizeMuapiImageInput(value,{env}) -> {value:{kind,model,payload}} | {error,missing?}                    // :286
normalizeMuapiVideoInput(value,{env})                                                                       // :313
createMuapiImageJob(value, {env,fetchImpl,timeoutMs}) -> {ok,status,job}|{ok:false,status,error,missing?}   // :382
createMuapiVideoJob(value, options)                                                                         // :395
getMuapiGenerationJob(jobId, kind, {env,fetchImpl,timeoutMs}) -> {ok,status,job}                            // :408
// public job: {provider,toolId,kind,jobId,status,url,model,keyMode,error}   (publicJob, :223)
```

Gateway handlers follow `handleX(request,{env,fetchImpl})` as `authorizeCreatorRequest`, then `parseCreatorJson`, then provider call, then `muapiResultResponse` (`creatorProviderGateway.js:593-625`).

Good traits to copy:
- Dependency-injected `env` and `fetchImpl`, which makes mock testing trivial.
- The status shape is already `queued/completed/failed`-style (`normalizedStatus`, :135).

Suggested plug-in:
- `src/lib/replicateCreatorProvider.js` with the same function set.
- New tool ids in the registry.
- New cases `POST:replicate/image|video` and `GET:replicate/status`, plus webhook.
- A small `providers/index.js` registry keyed by provider id.

## 3. Dependencies, duplicates, Electron, submodules, build

- **Submodules** (`.gitmodules`, gitlinks mode 160000):
  - `packages/Vibe-Workflow` (SamurAIGPT/Vibe-Workflow) provides `workflow-builder`, used by `studio`.
  - `packages/Open-Poe-AI` (Anil-matcha/Open-Poe-AI) provides `ai-agent`, used by `app/agents/**` (`AgentChatClient.js:3` etc.).
  - `packages/Open-AI-Design-Agent` provides `design-agent`, used by `DesignAgentStudio.jsx:3` (`CreativeCanvas`).
  - All three are third-party sibling projects, wired through root `workspaces` and `file:` deps (`package.json`).
  - They are **not needed** by the Creator core (`src/lib`, `app/api/creator`), except indirectly, because `studio` depends on all three (`packages/studio/package.json`).
  - In the worktree they currently appear populated (each has `.git`, `dist`/`node_modules` for agents). `ci.yml` uses `submodules: recursive`, and the Dockerfile copies their package.json files.
  - Build blocker: `prebuild` = `build:packages`, which builds workflow, agent, design and studio. Any missing submodule breaks `next build`.
  - **Recommendation**: do not carry them into the rebuild. Drop `.gitmodules`, the `workspaces` entries and `transpilePackages` (`next.config.mjs`).
- **Workspace**: `packages/studio` (Babel plus Tailwind v3 CLI, outputs `dist`; has its own `package-lock.json`). Root `workspaces` has 4 entries. Rebuild: a flat Next app with no `packages/`.
- **Electron/Vite** (REMOVE or DEFER as requested): `electron/**` (7 files incl. local inference/wan2gp), `afterPack.js`, `build/`, `vite.config.mjs`, `index.html`, `src/main.js`, `src/components/*.js`, `src/lib/localInference*`, `localModels.js`. In `package.json`: `electron`, `electron-builder`, `vite`, `@tailwindcss/vite`, the `electron:*` / `vite:*` / `package:linux:*` / `stage:local-ai` scripts, and the `"build"` electron-builder block and `"main"`. Also `scripts/package-linux-deb.js`, `stage-local-ai-binary.js`, `Dockerfile`, `docker-compose.yml`.
- **Other deps**: `@ffmpeg-installer/ffmpeg` is only for the compositor (DEFER). `axios` is probably used only in legacy code (not verified). `react-hot-toast` is used in the legacy UI (not verified).
- **Lint/test**: `lint` = `eslint app components src middleware.js` (flat `eslint.config.mjs`). Note `next lint` was replaced. Tests are Node's built-in runner: `test:security` (`tests/security/*.test.js`, about 20 files), `tests/*.test.js`, `test:integration`. CI is `.github/workflows/ci.yml` (Node 22, `npm ci --ignore-scripts`, security tests, tests, integration, build). Tests were not run.
- **Repo bloat**: `docs/` is 16 MB (videos, images), `public/` is 3 MB, `models_dump.json` is 72 KB, and there are root PNGs (thumbnails).
- Tailwind is v3 (`tailwind.config.js`, `postcss.config.js`) plus a v4 `@tailwindcss/vite` devDep. This mismatch should be reconciled.

## 4. Mock/test mode and cost protection vs the requirement

Existing:
- MuAPI **sandbox mode** (`MUAPI_KEY_MODE=sandbox`) uses a MuAPI-side $0 mock, not a local mock (`muapiCreatorProvider.js:266-275`).
- `MUAPI_ALLOW_PAID_GENERATION` must be `true` with `MUAPI_KEY_MODE=production` or the provider reports "missing" and returns 503 (:243-258). The same flag gates the brain's paid agent path (`brainRouter.js:57-75`, :185).
- `requiresApproval` in the Selena registry is advisory UI metadata only (`selenaOrchestrator.js:8-35`, :328). It is not enforced server-side.
- The workflow engine does enforce a node-level `approved` flag server-side (`creatorWorkflowEngine.js:456`, `approveWorkflowNode` :634) and caps active runs at 20.
- Rate limit: 30 requests/min default (`DEFAULT_REQUEST_LIMIT`, `creatorProviderGateway.js:~55`), but in-memory and per-instance. `.env.example` shows 5, so the default in code and the example disagree.
- Asset limits: 500 assets per project, 100 projects, 1 MB manifest.

Gaps for the requirement (needs to be built):
- **Local mock Replicate by default**: none exists (a fetch-injectable adapter makes it easy). Add `REPLICATE_MODE=mock|live` with default `mock`.
- **Per-user and per-job spending limits**: no ledger. The only limit is per-minute request counts. Need a durable usage store (Blob JSON would race; use KV/DB).
- **Duplicate-submission prevention**: no idempotency key anywhere (grep for idempotency/dedup found only workflow-run caps and UI `busy`). Need a client-generated idempotency key plus a server-side in-flight lock keyed by user and hash(prompt, model).
- Server-enforced approval on direct `/api/creator/image|video` calls: none. The gate is only an env flag.

## 5. Security posture

- **Token never to browser (creator path)**: yes. Provider keys are read from server env in route handlers, and responses carry sanitized fields (`publicJob`, `safeProviderText` strips secrets, `muapiCreatorProvider.js:66`). Strict CSP with a per-request nonce (`middleware.js`). But `connect-src` allows only `muapi.ai` and `*.blob.vercel-storage.com`, so `replicate.delivery` needs `img-src`/`media-src` (these already allow `https:`) but not `connect-src` if fetched client-side.
- **Legacy path leaks the pattern**: the MuAPI user key lives in the browser, and `StandaloneShell` clears a `muapi_key` cookie (:246). Remove it from the rebuild.
- **Media ownership**:
  - Projects are Blob-private, with the path `creator-projects/<HMAC(owner)>/<projectId>.json` where the owner comes from `HMAC-SHA256(CREATOR_SESSION_SECRET, github id)` (`creatorProjectStore.js:166-181`). `readProject` also verifies `ownerSubject` and `id` inside the record (:380-385). Optimistic concurrency uses `revision` (`commitProjectPatch`).
  - Asset uploads: `handleUpload` with `onBeforeGenerateToken` checks `uploadPathAllowed(pathname, project.id)` plus content-type and size allowlists (`creatorProjectRoutes.js:86-140`).
  - Weakness: asset blobs live under `creator-assets/<projectId>/` in a separate **public** asset store (`CREATOR_ASSET_BLOB_READ_WRITE_TOKEN`; the code comment calls renders "public"). The path is not scoped by owner, so project-id secrecy (a UUID) is the only protection. Treat this as not fully verified.
  - **Provider job status has no ownership binding**: `handleMuapiStatus` accepts any `id` and `kind` (`creatorProviderGateway.js:615-625`). For Replicate, persist a job record `{userId, projectId, predictionId}` and check ownership on status/webhook.
- **Webhook verification**: **no existing pattern**. `grep` for webhook/signature/hmac found nothing in providers (HeyGen and MuAPI are polled). HMAC and `timingSafeEqual` exist only for sessions and OAuth state. The rebuild must implement Replicate webhook verification (Standard Webhooks style: `webhook-id`, `webhook-timestamp`, `webhook-signature` with the `whsec_` secret, replay window) and note that `middleware` matches `/api/*`, so the route must remain unauthenticated but signature-checked.
- **Env handling**: `.env.example` is thorough, documents secrets and uses `replace-with-...` placeholders. Config helpers validate length/format (`configuredSecret`, `isConfigured`). `.vercelignore` blocks `**/.env*` except examples. `SECURITY.md` and `docs/SECURITY_CONFIGURATION.md` exist. `REPLICATE_API_TOKEN` and `REPLICATE_WEBHOOK_SECRET` need adding. Several secrets are named but optional.
- **Outbound URL safety**: `safeCreatorAssetUrl` (https only, no IP/localhost, host allowlist, `creatorProjectStore.js:104-129`) and `redirect: 'error'` on fetches. The default allowlist excludes `replicate.delivery`.
- **Same-origin CSRF**: `isSameOriginMutation` (`creatorAuth.js:199`) on every mutation.

## 6. Asset persistence

- Store: `@vercel/blob` 2.8.0 (`creatorProjectStore.js:9`). Two Blob stores: private project manifests (`BLOB_READ_WRITE_TOKEN`, JSON, `access: 'private'`) and an asset store (`CREATOR_ASSET_BLOB_READ_WRITE_TOKEN`). The whole project, including assets, storyboard, conversation and workflow runs, is **one JSON blob capped at 1 MB**.
- `addCreatorAsset` (`:525-542`) stores only a **URL** (must be on the allowlisted hosts) plus metadata (`normalizeAssetInput` :250). It **does not copy** remote media.
- The only server-side download-and-upload is the render pipeline: `downloadRenderSource` (:656) fetches remote media (limit 250 MB, `redirect: 'error'`, timeout 60 s) to a temp file, and `produceRender` (:703) uploads the output with `putBlob`. This is reusable as a template.
- **Replicate output URLs expire (about 1 h)**, so a new `persistRemoteAsset(user, projectId, url)` is needed:
  - Fetch with size and content-type checks.
  - `put` into `creator-assets/<projectId>/...` (or, better, owner-scoped).
  - Record `storagePath` and the Blob URL.
  - Add `replicate.delivery` / `*.replicate.delivery` to the allowlist for the fetch step only.
  - Run it at webhook/poll completion, not at view time.
- Also scale: 500 assets in a 1 MB JSON is tight. Consider a per-asset record or a real DB for the rebuild.

## 7. Recommended base and risks

**Recommendation**: branch from **origin/main (4a9e508 or newer)**, which already includes the consolidated work, and cherry-pick nothing by default. Reasons:
- The 4 extra integration commits are Storyboard-export and Preview-verification work, which is out of Phase 1 scope.
- They are unpushed.
- They touch `StandaloneShell.js`, which the rebuild will heavily rewrite.

Optionally cherry-pick `4012517` (`.vercelignore`), which is useful for Vercel uploads. Verify with `git fetch` first (not done here, as it is read-only) that `origin/main` is not newer than 4a9e508.

Then take the section 1 KEEP set and delete or defer the rest on the new branch.

Risks:
1. **Prod Selena 503**: the brain returns 503 unless a provider key and env are set (`brainRouter.js:906-942`; defaults `BRAIN_PROVIDER=muapi-agent` need `MUAPI_AGENT_API_KEY` or a sandbox/production MuAPI key). The Home page's "ask Selena" would show errors. Keep a graceful degraded state or default to one provider.
2. **Auth is single-owner**: GitHub allowlist (`CREATOR_GITHUB_ALLOWED_LOGINS=lalambert1982-eng` in `.env.example`). Sessions fail closed with 503 if unset.
3. **Submodule/`prebuild` coupling** breaks fresh clones and Vercel builds unless removed.
4. **In-memory rate limiting** gives no real cost protection on serverless.
5. **No webhook, idempotency or spend ledger** exist, so the Replicate core is net-new (see section 4).
6. **Whole-project single-blob store**: concurrent writes yield 409 conflicts, and size limits apply.
7. **Dual UI trees** (`src/components` legacy Vite vs `packages/studio` vs `components/`) risk accidental coupling.
8. **Tailwind v3 vs v4**, and `studio` being a prebuilt Babel `dist` package, complicate Tailwind in a plain Next app.
9. Mismatch between the CI test glob and any new test directories.
10. The integration branch and `recovery/creator-studio-2026-09-29` have diverging, unpushed local work. Confirm nothing valuable is lost before pruning.
