# Plan C: Legacy cleanup, job-resume, and local run — design

Date: 2026-10-10. Branch: `rebuild/creator-studio-replicate` (local only).
Inputs: graphify map of the repo, Dependency Cartographer report, Security Auditor baseline, owner decisions below.

## Intent

Finish the Creator Studio v2 rebuild so it runs locally in mock mode, with the legacy bulk removed and in-flight Replicate jobs surviving in-app navigation. Success = a clean tree where `npm ci`, all test suites, lint and `npm run build` pass, the app runs locally in mock mode, and the security invariants below still hold.

**Owner decisions (2026-10-10):** do the full legacy cleanup; cut Graphic Studio, Workflows, Agent Blueprints and Marketplace; no live Replicate verification or paid calls yet; no push, PR, or Preview deploy.

**Assumptions I made (flag if wrong):**
- `packages/studio` stays as a workspace package, pruned to what Creator uses. Inlining it is a later option.
- `components/LegacyProviderSettings.js` loses its browser-stored `muapi_key` flow. MuAPI stays selectable but server-side only.
- Session-authed `app/api/v1/{creative-agent,upload-binary,get_upload_url}` are removed with Graphic Studio.

## Scope

### In
1. Move the agent functions from `studio/src/muapi.js` to `src/lib/muapiAgents.js` (protected-core dependency of `creatorAgentGateway.js`).
2. Remove Electron/Vite code, `src/components`, orphaned `src/lib` modules, and their tests/scripts/deps.
3. Prune `components/StandaloneShell.js` and `packages/studio` to the Creator core; delete legacy studios; remove `muapi_key` browser storage.
4. Remove `app/api/{workflow,agents}`, `app/{workflow,agents,assistant}`, and the BYO-key and upload proxies with their libs and tests. Keep `src/lib/muapiProxy.js` (`buildMuapiUrl` is still used).
5. Remove the three submodules and all workspace, build, Docker, CI and CodeQL references; regenerate `package-lock.json`.
6. Consolidate Tailwind to the root v3 config.
7. Update README, `project_knowledge.md`, `docs/SECURITY_CONFIGURATION.md`, add a local-run guide.
8. Job-resume persistence (below).

### Out
Live Replicate verification, paid runs, push/PR/merge, Preview deploy, CSP narrowing (separate follow-up), Phase 2 modules, distributed daily-cap accounting.

## Protected core (must not change behaviour)
`src/lib/creator*`, `generation*`, `replicate*` (gateway, guard, persist, provider), `app/api/creator`, `app/studio`, `middleware.js`. `authorizeCreatorRequest()` and `creatorJson()` are the graph's hub nodes; any diff there needs explicit review.

## Removal order (each step leaves tests, lint and build green; one or more commits per step)
1. Extract `muapiAgents.js`; repoint `creatorAgentGateway.js:17`; update its test mocks.
2. Electron/Vite + `src/components` + orphaned libs. Delete the four local-inference/wan2gp tests; rewrite `contentSafety.test.js`.
3. Prune shell + studio: cut legacy cases, `getUserBalance`, `muapi_key` code, nav entries (`studioNavigation.js`); trim `packages/studio/src/index.js`; delete legacy studios, `models.js`, `persistKey.js`, `formatError.js`, old `muapi.js`; rewrite `creatorShellIntegration`, `authRegression`, `creativeCanvasProxy` as needed.
4. Remove legacy routes and BYO/upload proxies and libs/tests; trim `proxySecurity.test.js`. Verify no catch-all shadowing.
5. Remove submodules (`git rm` gitlinks, `.gitmodules`), edit `package.json`, `next.config.mjs` (`transpilePackages`), `jsconfig.json`, `packages/studio/package.json`, `Dockerfile`, `ci.yml`, `codeql.yml`; regenerate lockfile. Confirm `next build` works without `packages/studio/dist` and drop `build:studio` from `prebuild` if so.
6. Tailwind: delete studio-local configs/CSS; trim root content globs; compare CSS output before/after.
7. Docs and local-run guide.

## Job-resume design (from the security baseline)
- Store only `{ v:1, jobId, projectId, userId, ts }` in `sessionStorage` under `ogai.replicate.activeJob.v1`. Never the prompt, inputs, asset URLs, quote token or any key. All access in try/catch.
- Write on 2xx accept, and on error responses with `generationAccepted:true` and `statusRecoveryAvailable:true`. No auto-retry (`retryable:false`).
- On read: validate `jobId` against `/^[A-Za-z0-9_-]{3,60}$/`, `projectId` as UUID, `userId` equals the current user, and age under 30 minutes. Otherwise discard.
- Resume only via the owner-bound `GET replicate/status?id=`. Clear the entry on 404/401, any terminal status, and logout (before the logout POST). One poll loop per id, with backoff.
- Optional hardening (owner to accept or drop): a `Sec-Fetch-Site` check on the status route, since GETs skip the same-origin check and a status poll can settle/refund an owned job.
- Implemented test-first inside `lib/replicateStudio*` and `ReplicateStudio`, without touching the gateway contract.

## Security invariants (re-verified after every step; baseline commands from the auditor)
- I1 no key in browser storage: `grep -rnE "muapi_key|x-api-key|setItem\(.*[Kk]ey" app src components` empty; add this as a permanent test.
- I2 no client-visible provider token; no `NEXT_PUBLIC_*` secrets.
- I3 every handler in `app/api/**/route.js` calls `authorizeCreatorRequest` or is justified (logout does its own same-origin check).
- I4 `git diff <base> -- src/lib/replicateGateway.js generationGuard.js replicatePersist.js replicateProvider.js` empty, except where explicitly reviewed.
- I5 caps $1/job, $5/day. I6 mock is default; nothing sets `GENERATION_MODE=live`.

## Test baselines to hold or consciously change
Security 318, creator-shell 25, replicate-ui 65, top-level 111, integration 6, HTTP smoke 11/11. Deleting legacy code will lower some counts; each reduction must be listed with the reason in the ledger.

## Agent roles (7, model `sonnet`)
1 Architect/Planner (writes the plan), 2 Dependency Cartographer (done), 3 Cleanup Engineer, 4 Job-Resume Engineer (own worktree), 5 Test Engineer, 6 Security Auditor (baseline done; re-audits after steps 4 and 7), 7 Reviewer + Local-Run Verifier. Per-task review before the next task; progress ledger in `.superpowers/sdd/`.

## Risks
- Shell edits can miss a `case` and break compilation; many tests are source-string assertions.
- Removing `v1/[[...path]]` catch-alls changes routing.
- Pruned Tailwind globs can drop classes.
- Lockfile regeneration needs network access for `npm install`.

## Verification of done
`npm ci`, `npm run test:security`, `test:creator-shell`, `test:replicate-ui`, `node --test tests/*.test.js`, integration tests, HTTP smoke, lint, `npm run build`, headless-Chrome mock checklist including the new resume scenarios, I1-I6 checks, and a local-run guide that works from a clean clone.
