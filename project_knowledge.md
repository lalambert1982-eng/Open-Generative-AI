# Creator Studio v2 project context

Updated 2026-10-10 for the local `rebuild/creator-studio-replicate` branch in `/Users/abl2525/ogai-creator-studio-v2`. This describes the retained rebuild, not the historical Production release.

## Architecture

The app uses Next.js App Router, React, Node 24, Tailwind CSS v3, and the retained `packages/studio` npm workspace. The workspace exports CreatorStudio and SocialPublishStudio from source. Setup is `npm ci`; development is `npm run dev`. See [LOCAL_RUN.md](docs/LOCAL_RUN.md) for required identity/storage setup and isolated test alternatives.

| Area | Main sources |
| --- | --- |
| Routing and shell | `app/studio`, `components/StandaloneShell.js`, `src/lib/studioNavigation.js` |
| Creator tools and social UI | `packages/studio/src/components/CreatorStudio.jsx`, `SocialPublishStudio.jsx` |
| Replicate Image/Video UI | `components/CreatorMediaStudio.js`, `ReplicateStudio.js`, `src/lib/replicateStudio*.js` |
| Resume pointer | `src/lib/replicateResume.js` |
| Authentication and route boundary | `src/lib/creatorAuth.js`, `creatorProviderGateway.js`, `app/api/auth`, `app/api/creator` |
| Projects and Assets | `src/lib/creatorProjectStore.js`, `creatorProjectRoutes.js`, `components/ProjectsStudio.js`, `StudioAssets.js` |
| Replicate backend | `src/lib/replicateGateway.js`, `replicateProvider.js`, `replicatePersist.js`, `replicateModelRegistry.js`, `generationGuard.js` |
| Selena reasoning | `src/lib/brainRouter.js`, `creatorAgentGateway.js`, `muapiAgents.js` |
| Test fixtures | `scripts/replicate-http-smoke.mjs`, `replicate-ui-fixture-server.mjs` |

Creator core includes Home, Selena, Image/Video, voice, avatar, Storyboard, Music Video, Workflow Run, Agent Team, Projects, Assets, and explicitly reviewed publishing. A visible tool does not guarantee its external provider is configured or verified. Workflow Run and Agent Team retain Creator-owned engine/routes; they do not depend on the removed standalone editors.

## Identity, persistence, and provider boundaries

GitHub OAuth uses state/PKCE and an owner allowlist. The signed session is HttpOnly; the server derives ownership from the authenticated GitHub user ID. Provider credentials stay in server environment variables. Browser requests authenticate with the session rather than a user-entered provider key. Server `x-api-key` headers sent to fixed MuAPI/provider hosts are expected and allowed.

Private Vercel Blob holds Project manifests, job/spend records, and encrypted publishing records. A separate public Blob store holds reusable generated/uploaded media. Normal persisted use, including Replicate mock mode, needs `BLOB_READ_WRITE_TOKEN`, `CREATOR_ASSET_BLOB_READ_WRITE_TOKEN`, owner OAuth/session configuration, and their corresponding stores. Test fixtures inject fabricated sessions and in-memory stores; their success does not verify real OAuth or Blob.

Replicate is selected by default in Image/Video. Mock mode returns placeholders and never calls Replicate; mock Video is a PNG graphic. MuAPI remains selectable, with server-selected models and server credentials; its Sandbox still contacts MuAPI and is separate from Replicate's local mocks. Optional brain, voice, avatar, render, and social paths have independent configuration and approval gates.

Live Replicate requires all live-mode gates and a server token, plus an owner/input/model-bound signed quote. Default caps are $1 per job and $5 per owner/day. Submissions are not automatically retried; accepted jobs with recoverable server records use status polling. Unknown submissions and unconfirmed accepted records must preserve uncertainty without duplicate creation. Per-process job serialization and private Blob accounting do not provide distributed atomic accounting or exactly-once guarantees.

## Navigation and reload recovery

Separate Image/Video session pointers use `ogai.replicate.activeJob.v1.image` and `.video`. The only serialized fields are `{ v, jobId, projectId, userId, ts }`; prompts, input values, media URLs, quotes, and credentials are excluded. A valid pointer is at most 30 minutes old, belongs to the current owner, and contains validated job and Project IDs. Navigation or same-tab reload recovers through the owner-bound status route and keeps the originating Project context. Terminal status, 404, session loss, and sign-out clear the pointer. Unavailable browser storage is handled as a best-effort recovery failure.

Default mock jobs can finish in the create response. Use the held-job browser fixture to verify a pending job across navigation/reload. A tab pointer is not long-term job history and cannot reconstruct an unconfirmed record.

## Removed module families and continuation

Plan C removed the Electron/Vite app, orphan browser components/libraries, legacy studios, Graphic Studio, standalone Workflow Builder, Agent Blueprints editor, Marketplace, legacy browser-key/upload proxies, and the `Vibe-Workflow`, `Open-Poe-AI`, and `Open-AI-Design-Agent` submodules locally. The retained `muapiProxy.js` URL builder is still a server dependency; its filename does not restore the removed browser proxy flow.

Read `AGENTS.md`, [the Plan C design](docs/superpowers/specs/2026-10-10-legacy-cleanup-and-job-resume-design.md), and [the implementation plan](docs/superpowers/plans/2026-10-10-legacy-cleanup-and-job-resume.md). Current work reports are under `.superpowers/sdd/2026-10-10-legacy-cleanup-and-job-resume/`; the final verification record is `docs/superpowers/handoff/2026-10-10-cleanup-and-resume-verification.md` when written. Do not infer full-suite, review, or deployment completion from this context file.

No live provider call, real credential use, rebuild deployment, push, PR, or merge is claimed. Live model/schema/price verification, real identity/storage checks, Preview deployment, distributed accounting, `Sec-Fetch-Site` status hardening, and CSP narrowing remain separate work.
