# Open Generative AI 2.0: Replicate Creator Studio (Phase 1 Design)

Status: DRAFT for approval. Nothing implemented. Sources: audit-report.md, research-report.md (same folder).

## 1. Understanding (please correct)

**Outcome:** a reliable, web-only Creator Studio where a signed-in user can generate images and videos through Replicate (MuAPI selectable), save results to Projects/Assets, and reopen them, with zero unexpected spend.

**Said by you:** Next.js/Tailwind on Vercel; Replicate primary, MuAPI additional; reuse auth and Project/Asset infrastructure; mock mode by default; no paid calls, destructive changes, Production deploys without approval; Electron deferred; Selena lightweight; no runtime subagents.

**My assumptions:**
- "Rebuild" means a clean branch from `origin/main` (4a9e508) that keeps working auth/Project/Asset/MuAPI code and removes legacy bulk. It does not mean a rewrite from the Replicate starter.
- Phase 1 = Home, Image Studio, Video Studio, Projects/Assets. Phase 2 modules are out of scope for this spec.
- Single owner today (GitHub allowlist). "Per-user limits" are built per owner id so multi-user works later.

**Success criteria:** build passes from a clean clone; sign-in works; Projects create/reopen; Image and Video flows work end to end against a mock Replicate; live Replicate is off by default and gated; MuAPI still selectable; Replicate outputs copied to our storage; Vercel Preview verified; no paid request occurs during development.

## 2. Findings that shape the design

- Base: `origin/main` 4a9e508 already contains NVIDIA, compositor, Layout mode, lint config. Optionally cherry-pick `.vercelignore` (4012517) from the integration worktree.
- KEEP: `creatorAuth.js` + `/api/auth/github/*`; `authorizeCreatorRequest`; `creatorProjectStore.js` (private Blob manifest per owner, ownership checks, revisions); `muapiCreatorProvider.js`; content safety; Selena action registry.
- REMOVE: legacy MuAPI BYO-key proxies (`app/api/v1`, `app/api/api/v1`, `app/api/app`, upload proxies; they keep a user key in browser `localStorage`, violating the token rule); Electron/Vite code; ~25 legacy studio components; three third-party submodules (Vibe-Workflow, Open-Poe-AI, Open-AI-Design-Agent) plus `.gitmodules`, workspace entries, `transpilePackages`; duplicate Tailwind v3/v4.
- SIMPLIFY: `brainRouter.js`, `StandaloneShell.js` (about 30 destinations down to Phase 1 nav), in-memory `rateLimit.js`.
- DEFER: storyboard, compositor, workflow engine, social publishing, agent-team gateway, HeyGen/ElevenLabs/OpenAI/Runway/NVIDIA.
- Gaps to build: model registry, Replicate adapter, default mock mode, spend ledger and per-job limits, duplicate-submission lock, server-enforced approval on generation routes, owner-bound job status (today any job id is accepted), webhook verification, persist-remote-asset step.
- Replicate facts: official models use `POST /v1/models/{owner}/{name}/predictions` (no version pin); outputs and inputs are deleted after 1 hour; no documented idempotency key; webhook signature is Standard-Webhooks style (`webhook-id`, `webhook-timestamp`, `webhook-signature`, HMAC-SHA256 over `id.timestamp.body`); 600 creates/min.

## 3. Approaches

**A (recommended): Adapter + registry on the existing Creator route layer.** Add `replicateCreatorProvider.js` mirroring the MuAPI adapter's shape (`xConfiguration`, `xProviderStatus`, normalize input, `createXImageJob`/`createXVideoJob`, `getXGenerationJob` with injected `env`/`fetchImpl`), plus a static `modelRegistry.js`. Route through `app/api/creator/[[...path]]`. Smallest change, reuses auth and testing seams.
**B:** Adopt Replicate's starter structure and port auth/projects into it. More churn, loses audited security code. Not recommended.
**C:** New generic provider framework. Over-engineered for two providers. Not recommended.

## 4. Design (approach A)

**Provider layer.** `src/lib/providers/replicate.js` (adapter), `src/lib/modelRegistry.js` (entries: provider, owner/name, kind, capabilities, input schema with exact field names, output type, settings, verified price string or `null`, `enabled`). MuAPI is registered in the same registry through its existing adapter. Provider failure returns a normalized error job; it never throws past the route.

**Initial registry (official models, schemas verified from model pages by research):**
- Image: `black-forest-labs/flux-2-pro`, `black-forest-labs/flux-schnell`, `google/nano-banana-2`.
- Edit: `black-forest-labs/flux-kontext-pro`, `google/nano-banana-pro`.
- Video: `google/veo-3.1-fast`, `kwaivgi/kling-v3-video`, `bytedance/seedance-1.5-pro`; image-to-video with `image`/`start_image` fields; first/last frame only where the schema has it.
- `openai/gpt-image-2` excluded until its `openai_api_key` input requirement is understood. Prices are shown only as the model page's stated string, flagged "estimate, verify".

**Prediction lifecycle.** validate request (registry schema) → authorize owner → check mode/limits/approval → duplicate lock (hash of owner+model+inputs, short TTL) → create prediction with `Cancel-After` → store `{predictionId, owner, projectId, model, status}` → poll via owner-bound status route (webhook optional, signature-verified, dedupe on `webhook-id`) → on `succeeded`, idempotently `persistRemoteAsset` (server-side download, upload to Blob, allowlist `replicate.delivery`, add Asset) → UI shows persisted URL only. Cancel route and timeout (30 min Replicate limit, our own lower cap) included.

**Cost protection.** `GENERATION_MODE=mock|live`, default `mock`; mock adapter returns deterministic local placeholder media with no network. Live requires `REPLICATE_LIVE_ENABLED=true` plus a per-request explicit confirm token from the UI after showing estimated price. Per-owner daily and per-job caps stored in Blob (the in-memory limiter is not sufficient on Vercel). No automatic retries and no cross-model or cross-provider fallback. Approval is enforced server-side, not just in the registry flag.

**Security.** `REPLICATE_API_TOKEN` and `REPLICATE_WEBHOOK_SECRET` server-only (never `NEXT_PUBLIC_`); remove browser-key proxies; job status bound to owner; CSP nonce middleware kept.

**UI (Phase 1 shell).** Nav: Home, Image, Video, Projects. Home shows recent generations and featured models. Studios have a model picker, settings generated from the registry schema, provider toggle (Replicate/MuAPI), mock/live badge, cost estimate, explicit Generate, status panel, preview, download, Save to Project. Selena kept as a prompt helper that only prepares settings; it cannot submit a generation.

**Phase 2 notes (not built now):** Cinema Studio is prompt-template UI over Video Studio (no inspected Replicate schema exposes pan/zoom/lens; real controls are start/end frame, reference images, `camera_fixed` on seedance-1.5-pro, `multi_prompt` on kling-v3). The UI will label these controls "prompt guidance" unless mapped to a real parameter. Effects = prompt templates first. Character = reference-image organization, feasible early. Marketing = later. Canvas = single-image edit now, free-form canvas later, real-time co-editing not supported.

## 5. Testing
Mocked-fetch unit tests for adapter, registry validation, duplicate lock, limits, approval enforcement, webhook signature, idempotent persist; owner-isolation tests for status/asset routes; existing security (235), creator-shell and top-level suites stay green; production build from a clean clone. Live Replicate smoke test only with your explicit approval and a spend cap.

## 6. Implementation order (maps to your Steps 2-9)
1 branch from origin/main → 2 remove submodules/Electron/legacy proxies, fix build → 3 registry + mock Replicate adapter → 4 persist + limits + approval + webhook → 5 Image Studio → 6 Video Studio → 7 Projects/Assets verification → 8 full tests + build → 9 Preview deploy after approval.

## 7. Decisions (taken by the assistant under the user's "decide what you think is best", 2026-10-08; user may override)
1. Base: `origin/main` 4a9e508; cherry-pick `.vercelignore` (4012517) only if still wanted. Rebuild branch: `rebuild/creator-studio-replicate`.
2. Auth: keep single-owner GitHub allowlist for Phase 1; all limits keyed by owner id so multi-user is a later policy change.
3. Model set: initial registry as listed in section 4.
4. Spend caps: configurable defaults of $1 per job and $5 per day per owner. These are config only; no live run happens without separate explicit approval.
5. Production Selena 503 (missing brain env vars): out of scope here; flagged for a separate decision. Do not touch Production config.
