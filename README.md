# Creator Studio v2

A private, web-only Creator workspace built with Next.js, React, and Tailwind CSS v3. This rebuild lives on `rebuild/creator-studio-replicate`; it has not been merged or deployed.

The retained app provides Home, Selena, Image and Video, Audio & Voice, Avatar, Scene Builder/Storyboard, Music Video, Agent Team, Workflow Run, Projects, Assets, Publish, and server provider settings. The remaining workflow and agent tools belong to the authenticated Creator core. They are separate from the removed standalone editors.

Image and Video offer Replicate by default and an explicit MuAPI option. Replicate defaults to local placeholder generation without contacting Replicate or spending provider credits. A mock Video result is a **PNG graphic**, not playable video. Other providers use their own server configuration and are not covered by Replicate mock mode. MuAPI credentials are server-side only; the app has no browser API-key entry or persistence flow.

GitHub OAuth authenticates an allowlisted owner. Projects, conversations, Storyboards, job records, and Asset manifests use private Vercel Blob; reusable generated/uploaded media uses a separate public Blob store. Normal persisted mock use requires OAuth/session configuration **and both Blob stores**. Mock generation does not replace persistence with an in-memory database.

[Run locally](docs/LOCAL_RUN.md) for Node 24, `npm ci`, normal owner-authenticated setup, and the credential-free HTTP/browser fixtures. See [security configuration](docs/SECURITY_CONFIGURATION.md) for exact server variable names and [project context](project_knowledge.md) for the retained architecture.

## Generation recovery

Accepted Replicate jobs can resume after navigation or a reload in the same tab, while the saved pointer is at most 30 minutes old and belongs to the signed-in owner. Image and Video have separate `sessionStorage` pointers containing only version, job ID, originating Project ID, owner ID, and timestamp. Recovery checks the owner-bound status route; it does not submit another generation. Terminal status, missing jobs, session loss, and sign-out clear the pointer. Browser storage restrictions can prevent recovery without preventing generation.

The pointer is a recovery hint, not a credential or a durable job database. Accepted jobs with an unconfirmed server record and submissions with an unknown outcome cannot promise automatic recovery. The UI keeps those outcomes distinct and requires review before another submission.

## Local development and verification

```sh
npm ci
npm run dev
```

Use Node 24. Configure the environment before normal app use, as described in the local-run guide. The retained `studio` workspace is consumed from source; no submodule initialization or separate package build is part of setup.

```sh
npm run test:security
npm run test:creator-shell
npm run test:replicate-ui
node --test tests/*.test.js
node --test tests/integration/*.test.js
node --experimental-test-module-mocks scripts/replicate-http-smoke.mjs
npm run lint
npm run build
```

These commands describe the verification workflow, not a claim that the current worktree has passed every check. Current Plan C verification and remaining work belong in [the cleanup/resume handoff](docs/superpowers/handoff/2026-10-10-cleanup-and-resume-verification.md); that report is written at the end of the verification pass. Earlier evidence is in [the 2026-10-09 UI handoff](docs/superpowers/handoff/2026-10-09-replicate-ui-verification.md).

## Removed locally in Plan C

Electron/Vite desktop code, standalone legacy studios, Graphic Studio, the standalone Workflow Builder, Agent Blueprints editor, Marketplace, browser-key proxies and legacy upload proxies, and the `Vibe-Workflow`, `Open-Poe-AI`, and `Open-AI-Design-Agent` submodules were removed from this rebuild. Historical documents may describe their earlier releases; those are not setup instructions for this branch.

Live Replicate schemas, model identifiers, prices, provider billing behavior, and real OAuth/Blob persistence have not been verified for this rebuild. Live generation, paid calls, push/PR/merge, Preview deployment, and Production configuration changes remain outside the current local scope. Shared accounting across server instances, `Sec-Fetch-Site` status hardening, and CSP narrowing remain follow-ups.
