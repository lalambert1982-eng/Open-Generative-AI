# Legacy Cleanup, Job-Resume, and Local Run Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the legacy bulk from the Creator Studio v2 rebuild, make in-flight Replicate jobs survive in-app navigation, and leave the app runnable locally in mock mode.

**Architecture:** Cleanup is sequenced so tests, lint and build stay green after every task: first extract the one protected-core dependency out of `packages/studio`, then delete outward (Electron/Vite, legacy studios, legacy routes/proxies, submodules, duplicate Tailwind). Job-resume is a small pure store module plus controller hooks; it never touches the server gateway. The two workstreams touch different files except one logout line (Task 9).

**Tech Stack:** Next.js (app router), React, Node 24 `node --test`, Tailwind v3, npm workspaces.

**Spec:** `docs/superpowers/specs/2026-10-10-legacy-cleanup-and-job-resume-design.md`
(Refinement vs. spec: the resume key is per kind, `ogai.replicate.activeJob.v1.image` / `.video`, so an Image job and a Video job cannot overwrite each other. Everything else in the spec's resume design is unchanged. The optional `Sec-Fetch-Site` hardening is NOT in this plan; it awaits an owner decision.)

## Global Constraints

- Worktree: `/Users/abl2525/ogai-creator-studio-v2`, branch `rebuild/creator-studio-replicate`. Local only: no push, PR, merge, deploy.
- No live Replicate call, no paid call, no network provider call. Mock mode is the default and must stay so (`GENERATION_MODE=live` never set anywhere).
- Protected core, behaviour unchanged: `src/lib/creator*`, `generation*`, `replicate*` (gateway, guard, persist, provider, modelRegistry), `app/api/creator`, `app/studio`, `middleware.js`. After every task: `git diff 108b238 -- src/lib/replicateGateway.js src/lib/generationGuard.js src/lib/replicatePersist.js src/lib/replicateProvider.js` prints nothing.
- Accepted-job contract (`generationAccepted/jobId/jobRecordState/statusRecoveryAvailable/retryable:false/outcomeUnknown`) and caps ($1/job, $5/day) unchanged.
- Test baselines (record exact current numbers in Task 1): security 318, creator-shell 25, replicate-ui 65, top-level 111, integration 6, HTTP smoke 11/11. Deleting legacy code may lower counts; every reduction is written in the ledger with the reason.
- Never use bare `git stash`. Commit small; end every commit message with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Subagent model alias: only `sonnet` works in this setup.
- Progress ledger (git-ignored): `.superpowers/sdd/2026-10-10-legacy-cleanup/progress.md`.

## Review Focus

Failure modes the spec implies but no task's obvious tests exercise; each is pinned by a test inside the owning task.
- A tampered or foreign `sessionStorage` entry (bad `jobId`, non-UUID `projectId`, other `userId`, wrong `v`, array/null JSON) must be discarded silently, never crash the studio. (Task 7)
- `sessionStorage` throwing (private mode, quota, disabled) must not break generation. (Task 7)
- Resume must not double-submit: a resumed job never calls `generate`, only `status`. (Task 8)
- A stale entry whose job is gone (404) must clear and return the form to idle, not leave a stuck "running" state. (Task 8)
- Logout and session loss must clear any resumable job so a second user on the same tab never sees it. (Tasks 8, 9)
- The `muapi_key` browser-storage pattern must not come back anywhere in `app`, `src`, `components`. (Task 10)

## File Structure

Create:
- `src/lib/muapiAgents.js` — server-side MuAPI Agent Blueprint calls, moved out of `packages/studio/src/muapi.js`.
- `src/lib/replicateResume.js` — pure resume store (validate/save/load/clear) plus `createBrowserResume(kind)`.
- `tests/replicateResume.test.js` — store tests.
- `tests/security/noBrowserKeyStorage.test.js` — permanent I1 guard.
- `docs/LOCAL_RUN.md` — local mock-mode run guide.

Modify (resume): `src/lib/replicateStudioClient.js`, `components/ReplicateStudio.js`, `packages/studio/src/components/CreatorStudio.jsx` (one line), `tests/replicateStudioController.test.js`, `tests/replicateStudioWiring.test.js`.

Delete/prune (cleanup): listed per task.

---

### Task 1: Baseline ledger and agent-function extraction

**Files:**
- Create: `src/lib/muapiAgents.js`, `.superpowers/sdd/2026-10-10-legacy-cleanup/progress.md`
- Modify: `src/lib/creatorAgentGateway.js:17`, `tests/security/creatorAgentGateway.test.js` (only if it imports/mocks `studio/src/muapi.js`)
- Test: `tests/security/creatorAgentGateway.test.js`

**Interfaces:**
- Produces: `src/lib/muapiAgents.js` exporting `getUserAgents(apiKey)`, `getAgentConversation(apiKey, agentSlug, conversationId)`, `sendAgentChatMessage(apiKey, agentSlug, { message, conversationId, attachments })`, `pollAgentChatResult(apiKey, requestId, { maxAttempts, interval })`, `createAgent(apiKey, payload)`. Same behaviour as today's server-side path (`BASE_URL = 'https://api.muapi.ai'`).

- [ ] **Step 1: Record the baseline**

Run each and write the exact pass counts into the ledger:
```bash
npm run test:security
npm run test:creator-shell
npm run test:replicate-ui
node --test tests/*.test.js
node --test tests/integration/*.test.js
node --experimental-test-module-mocks scripts/replicate-http-smoke.mjs
npm run lint
```
Expected: matches the Global Constraints baselines (security 318, creator-shell 25, replicate-ui 65, top-level 111, integration 6, smoke 11/11, lint exit 0). If a number differs, record the real number and continue; it is the new baseline.

- [ ] **Step 2: Check how the existing test reaches the functions**

Run: `grep -n "muapi\|studio/src" tests/security/creatorAgentGateway.test.js | head -20`
The gateway test stubs `globalThis.fetch`; confirm no test imports `studio/src/muapi.js` directly. If one does, change that import to `../../src/lib/muapiAgents.js` in Step 5.

- [ ] **Step 3: Create `src/lib/muapiAgents.js`**

```js
// Server-side MuAPI Agent Blueprint calls used by creatorAgentGateway.js.
// Moved verbatim from packages/studio/src/muapi.js so the Creator core no longer
// depends on the legacy studio package. Server-only: the key is supplied by the
// gateway from server configuration and never reaches the browser.
const BASE_URL = 'https://api.muapi.ai';

function headers(apiKey) {
    return { 'Content-Type': 'application/json', 'x-api-key': apiKey };
}

export async function getUserAgents(apiKey) {
    const response = await fetch(`${BASE_URL}/agents/user/agents`, { headers: headers(apiKey) });
    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Failed to fetch user agents: ${response.status} - ${errText.slice(0, 100)}`);
    }
    const data = await response.json();
    return Array.isArray(data) ? data : (data.agents || data.items || []);
}

// GET /agents/by-slug/{slug}/{conversationId} — chat history for one conversation.
export async function getAgentConversation(apiKey, agentSlug, conversationId) {
    const response = await fetch(`${BASE_URL}/agents/by-slug/${agentSlug}/${conversationId}`, { headers: headers(apiKey) });
    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Failed to fetch conversation: ${response.status} - ${errText.slice(0, 100)}`);
    }
    return await response.json();
}

// POST /agents/by-slug/{slug}/chat — returns {request_id, status} to poll via pollAgentChatResult.
export async function sendAgentChatMessage(apiKey, agentSlug, { message, conversationId, attachments } = {}) {
    const response = await fetch(`${BASE_URL}/agents/by-slug/${agentSlug}/chat`, {
        method: 'POST',
        headers: headers(apiKey),
        body: JSON.stringify({
            message,
            conversation_id: conversationId || null,
            attachments: attachments || null,
            stream: false,
        }),
    });
    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Failed to send message: ${response.status} - ${errText.slice(0, 100)}`);
    }
    return await response.json();
}

// Polls /api/v1/predictions/{requestId}/result until the agent turn is complete.
export async function pollAgentChatResult(apiKey, requestId, { maxAttempts = 150, interval = 2000 } = {}) {
    const url = `${BASE_URL}/api/v1/predictions/${requestId}/result`;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, interval));
        const response = await fetch(url, { headers: headers(apiKey) });
        if (response.status === 400) {
            const errBody = await response.json().catch(() => ({}));
            throw new Error(errBody?.detail?.error || 'Agent failed to respond');
        }
        if (!response.ok) {
            if (attempt === maxAttempts) throw new Error(`Poll failed: ${response.status}`);
            continue;
        }
        const data = await response.json();
        if (data.is_complete) return data;
    }
    throw new Error('Agent response timed out.');
}

// POST /agents — create a persona agent (skill_ids default to [] server-side).
export async function createAgent(apiKey, payload) {
    const response = await fetch(`${BASE_URL}/agents`, {
        method: 'POST',
        headers: headers(apiKey),
        body: JSON.stringify(payload),
    });
    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Failed to create agent: ${response.status} - ${errText.slice(0, 100)}`);
    }
    return await response.json();
}
```

- [ ] **Step 4: Repoint the gateway**

In `src/lib/creatorAgentGateway.js` change line 17 from `} from 'studio/src/muapi.js';` to `} from './muapiAgents.js';`, and update the header comment lines 2-4 to say the functions live in `src/lib/muapiAgents.js`. Also update the comment at `src/lib/creatorAgentRegistry.js:6` the same way.

- [ ] **Step 5: Run the test**

Run: `node --test tests/security/creatorAgentGateway.test.js`
Expected: PASS with the same test count as before (no `studio` import remains: `grep -n "studio/src" src/lib/creatorAgentGateway.js` prints nothing).

- [ ] **Step 6: Full regression and commit**

Run: `npm run test:security && npm run lint`
Expected: security count unchanged from the Step 1 baseline.
```bash
git add src/lib/muapiAgents.js src/lib/creatorAgentGateway.js src/lib/creatorAgentRegistry.js tests
git commit -m "refactor: move MuAPI agent calls out of the legacy studio package

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Remove Electron/Vite and orphaned `src` modules

**Files:**
- Delete: `electron/`, `vite.config.mjs`, `afterPack.js`, `build/`, `index.html`, `src/main.js`, `src/components/` (all), `src/counter.js`, `src/javascript.svg`, `src/style.css`, `src/styles/`, `scripts/stage-local-ai-binary.js`, `scripts/package-linux-deb.js`, `scripts/test_minimax_provider.js`, `tests/localInferenceAssets.test.js`, `tests/localInferencePaths.test.js`, `tests/localInferenceProgress.test.js`, `tests/wan2gpModelAvailability.test.js`
- Delete after re-verifying no importer: `src/lib/{muapi,localModels,localInferenceClient,uploadHistory,pendingJobs,i18n,promptUtils,clientContentSafety}.js`
- Modify: `package.json` (remove `main`, the `"build"` electron-builder block, scripts `vite:*`, `electron:*`, `stage:local-ai`, `package:linux:*`, devDeps `electron`, `electron-builder`, `vite`, `@tailwindcss/vite`), `tests/security/contentSafety.test.js`
- Keep for now: `src/lib/models.js` (removed in Task 3)

**Interfaces:** none produced.

- [ ] **Step 1: Re-verify each orphan lib has no importer outside the files being deleted**

For each name N in `muapi localModels localInferenceClient uploadHistory pendingJobs i18n promptUtils clientContentSafety`:
```bash
grep -rn "lib/N\|/N.js\|'./N'" app components src tests packages/studio/src middleware.js scripts \
  | grep -v "^src/components/\|^src/main.js\|^electron/"
```
Expected: no hits except tests listed for deletion/rewrite. Any other hit: do NOT delete that lib; record it in the ledger and keep it.

- [ ] **Step 2: Delete the targets**

```bash
git rm -r electron build src/components src/styles
git rm vite.config.mjs afterPack.js index.html src/main.js src/counter.js src/javascript.svg src/style.css \
  scripts/stage-local-ai-binary.js scripts/package-linux-deb.js scripts/test_minimax_provider.js \
  tests/localInferenceAssets.test.js tests/localInferencePaths.test.js tests/localInferenceProgress.test.js tests/wan2gpModelAvailability.test.js
git rm src/lib/muapi.js src/lib/localModels.js src/lib/localInferenceClient.js src/lib/uploadHistory.js src/lib/pendingJobs.js src/lib/i18n.js src/lib/promptUtils.js src/lib/clientContentSafety.js
```
(Omit any lib Step 1 told you to keep.)

- [ ] **Step 3: Edit `package.json`**

Remove: the `"main"` field, the whole `"build"` object (electron-builder), the scripts `vite:dev`, `vite:build`, `electron:dev`, `electron:build`, `electron:build:win`, `electron:build:linux`, `electron:build:linux:dir`, `electron:build:linux:arm64:dir`, `stage:local-ai`, `package:linux:deb` and any `package:linux:*`; and devDependencies `electron`, `electron-builder`, `vite`, `@tailwindcss/vite`. Keep `tailwindcss ^3.4.0`, `postcss`, `autoprefixer`.
Run: `node -e "JSON.parse(require('fs').readFileSync('package.json','utf8'))"` — Expected: no error.

- [ ] **Step 4: Rewrite `tests/security/contentSafety.test.js`**

Remove the import of `clientContentSafety.js` and every test that exercises it; keep tests of server-side content safety. Run: `node --test tests/security/contentSafety.test.js` — Expected: PASS, with the removed test names listed in the ledger.

- [ ] **Step 5: Verify**

Run:
```bash
npm run test:security && npm run test:creator-shell && node --test tests/*.test.js && npm run lint && npm run build
```
Expected: all pass. Lower counts only from the four deleted test files and the contentSafety trims; write each delta in the ledger. If `npm run build` fails because `package-lock.json` still lists removed deps, that is fine (npm ignores extra lock entries); lockfile is regenerated in Task 5.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: remove Electron, Vite and orphaned legacy src modules

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Prune the shell and `packages/studio` to the Creator core

**Files:**
- Modify: `components/StandaloneShell.js`, `components/LegacyProviderSettings.js`, `src/lib/studioNavigation.js`, `packages/studio/src/index.js`, `tests/creatorShellIntegration.test.js`, `tests/security/authRegression.test.js`, `tests/security/creativeCanvasProxy.test.js`, `tests/studioNavigation.test.js`, `package.json` (`test:creator-shell` list if a file is removed)
- Delete: `components/ApiKeyModal.js`; in `packages/studio/src/components/`: `AgentStudio, AiInfluencerStudio, AppsStudio, AudioStudio, CinemaStudio, ClippingStudio, DesignAgentStudio, DrawModal, GraphicStudio, ImageStudio, LayersStudio, LayoutStudio, LipSyncStudio, MarketingStudio, McpCliStudio, MobileGenerationActions, RecastStudio, VibeMotionStudio, VideoStudio, WorkflowStudio, WorkflowUI` (`.jsx`), `layoutStudioModel.js`, `prompt/`; `packages/studio/src/{muapi.js,models.js,persistKey.js}`, `packages/studio/src/utils/formatError.js`, `src/lib/models.js`, `tests/layoutStudio.test.js`
- Keep: `CreatorStudio.jsx`, `StoryboardWorkspace.jsx`, `storyboardWorkspaceModel.js`, `WorkflowRunPanel.jsx`, `SocialPublishStudio.jsx`

**Interfaces:**
- Consumes: Task 1's `muapiAgents.js` (so deleting `packages/studio/src/muapi.js` is safe).
- Produces: `StandaloneShell` that imports only `CreatorStudio`, `SocialPublishStudio` (and storyboard via `CreatorStudio`) from `'studio'`; `packages/studio/src/index.js` exporting only those.

- [ ] **Step 1: Write the guard test first (fails until the prune is done)**

Create `tests/legacyPrune.test.js`:
```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const exists = (path) => access(new URL(path, import.meta.url)).then(() => true, () => false);

test('shell imports only the Creator-core studio exports', async () => {
    const shell = await read('../components/StandaloneShell.js');
    const imported = shell.match(/import \{([^}]*)\} from 'studio';/)?.[1] || '';
    const names = imported.split(',').map((item) => item.trim()).filter(Boolean).sort();
    assert.deepEqual(names, ['CreatorStudio', 'SocialPublishStudio']);
});

test('legacy studio files and browser key storage are gone', async () => {
    for (const path of [
        '../components/ApiKeyModal.js',
        '../packages/studio/src/muapi.js',
        '../packages/studio/src/models.js',
        '../packages/studio/src/components/WorkflowStudio.jsx',
        '../packages/studio/src/components/GraphicStudio.jsx',
        '../packages/studio/src/components/AgentStudio.jsx',
        '../src/lib/models.js',
    ]) assert.equal(await exists(path), false, path);
    const shell = await read('../components/StandaloneShell.js');
    assert.doesNotMatch(shell, /muapi_key|getUserBalance|saveKey|clearKey/);
});
```
Run: `node --test tests/legacyPrune.test.js` — Expected: FAIL (shell still imports many studios).

- [ ] **Step 2: Edit `components/StandaloneShell.js`**

1. Replace the `from 'studio'` import (lines ~6-10) with `import { CreatorStudio, SocialPublishStudio } from 'studio';` — keep any other non-studio imports as they are.
2. Delete the `case` branches for every removed studio (cartographer map: lines ~518-519, 525-536, 538-540; keep `selena`, `image`, `video`, `audio`, `avatar`, `generator`, `scene-builder`, `music-video`, `agent-team`, `publish`, `workflow-run` cases that render `CreatorStudio`/`SocialPublishStudio`/`CreatorMediaStudio`). Unknown destinations must fall through to the existing default (Home).
3. Delete the `getUserBalance` effect (~line 273) and all `muapi_key` / `saveKey` / `clearKey` / `apiKey` state and cookie-clearing code (~lines 23, 256-289) and its prop plumbing into `LegacyProviderSettings`.
4. Remove the `ApiKeyModal` import if present.

- [ ] **Step 3: Edit `components/LegacyProviderSettings.js`**

Remove the key-entry form and any `saveKey`/`clearKey` props so the component only shows server-side provider status. If nothing meaningful remains, replace its body with a short read-only status panel ("MuAPI is configured on the server") and keep the default export so the shell import still resolves.

- [ ] **Step 4: Update `src/lib/studioNavigation.js`**

Remove destinations whose cases were removed (graphic-studio, workflows, agent-blueprints, marketplace/apps, lip-sync, cinema, etc. — exactly the ones Step 2 removed). Update `tests/studioNavigation.test.js` expectations to the new list; do not weaken assertions about the kept destinations.

- [ ] **Step 5: Trim `packages/studio/src/index.js`** to export only `CreatorStudio`, `SocialPublishStudio` (and `StoryboardWorkspace` if the shell or tests import it by name). Then delete the files listed above:
```bash
git rm components/ApiKeyModal.js src/lib/models.js tests/layoutStudio.test.js \
  packages/studio/src/muapi.js packages/studio/src/models.js packages/studio/src/persistKey.js packages/studio/src/utils/formatError.js \
  packages/studio/src/components/layoutStudioModel.js
git rm -r packages/studio/src/components/prompt
for n in AgentStudio AiInfluencerStudio AppsStudio AudioStudio CinemaStudio ClippingStudio DesignAgentStudio DrawModal GraphicStudio ImageStudio LayersStudio LayoutStudio LipSyncStudio MarketingStudio McpCliStudio MobileGenerationActions RecastStudio VibeMotionStudio VideoStudio WorkflowStudio WorkflowUI; do git rm packages/studio/src/components/$n.jsx; done
```
If `git rm` reports a file missing, skip it. Then confirm nothing left imports a removed file:
`grep -rn "from '\./\(Agent\|Workflow\|Graphic\|Image\|Video\|Layout\)Studio\|persistKey\|formatError\|/models.js\|/muapi.js" packages/studio/src components app src` — Expected: no hits (fix any that remain; `CreatorStudio.jsx` must not import deleted files).

- [ ] **Step 6: Rewrite source-string tests**

For `tests/creatorShellIntegration.test.js`, `tests/security/authRegression.test.js`, `tests/security/creativeCanvasProxy.test.js`: delete only the assertions and `read(...)` calls that reference removed files (AgentStudio line ~88, LipSyncStudio ~97, WorkflowStudio/WorkflowUI ~123-124, GraphicStudio/ImageStudio/DrawModal ~22, `DesignAgentStudio`/`GraphicStudio` in creativeCanvasProxy ~104-105, WorkflowStudio in authRegression ~48/66). Keep every assertion about retained files (CreatorStudio, Storyboard, SocialPublish, WorkflowRunPanel, shell). Remove `creativeCanvasProxy.test.js` entirely if it has no remaining retained-file assertions (Graphic Studio is cut). List each removed test name and reason in the ledger.

- [ ] **Step 7: Verify**

Run: `node --test tests/legacyPrune.test.js` — Expected: PASS.
Run: `npm run test:security && npm run test:creator-shell && npm run test:replicate-ui && node --test tests/*.test.js && npm run lint && npm run build` — Expected: all pass; build must not error on a missing import.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "chore: prune shell and studio package to the Creator core

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Remove legacy routes and BYO-key/upload proxies

**Files:**
- Delete: `app/workflow/`, `app/agents/`, `app/assistant/`, `app/api/workflow/`, `app/api/agents/`, `app/api/v1/` (all, including `creative-agent`, `upload-binary`, `get_upload_url`, `upload_file`), `app/api/api/`, `app/api/app/`, `app/api/upload-binary/`, `src/lib/{handleDirectUploadProxy,handleUploadProxy,uploadTicket,uploadCredentialProxy,uploadProxyTarget}.js`, `tests/security/{directUploadProxy,uploadProxy,uploadTicket,uploadValidation}.test.js`
- Modify: `tests/security/proxySecurity.test.js`
- Keep: `src/lib/muapiProxy.js` (`buildMuapiUrl` still used by `creatorMuapiProxy.js`, `muapiCreatorProvider.js`, `muapiSocialPublishing.js`)

**Interfaces:** Consumes the pruned studio (Task 3) — no remaining client code calls `/api/v1`, `/api/workflow`, `/api/agents`.

- [ ] **Step 1: Prove nothing calls the routes**

```bash
grep -rn "/api/v1\|/api/api/v1\|/api/app/\|/api/workflow\|/api/agents\|upload-binary\|get_upload_url\|upload_file" app components src packages/studio/src middleware.js next.config.mjs | grep -v "^app/api/\(v1\|api\|app\|workflow\|agents\|upload-binary\)/"
```
Expected: no hits (the Task 3 prune removed callers). A hit in `middleware.js`/`next.config.mjs` comments only is fine; any code hit must be resolved first.

- [ ] **Step 2: Delete**

```bash
git rm -r app/workflow app/agents app/assistant app/api/workflow app/api/agents app/api/v1 app/api/api app/api/app app/api/upload-binary
git rm src/lib/handleDirectUploadProxy.js src/lib/handleUploadProxy.js src/lib/uploadTicket.js src/lib/uploadCredentialProxy.js src/lib/uploadProxyTarget.js
git rm tests/security/directUploadProxy.test.js tests/security/uploadProxy.test.js tests/security/uploadTicket.test.js tests/security/uploadValidation.test.js
```
Then `grep -rn "handleUploadProxy\|uploadTicket\|handleDirectUploadProxy\|uploadCredentialProxy\|uploadProxyTarget\|proxyMuapi\|getApiKeyFromRequest" app src components tests` — Expected: only `src/lib/muapiProxy.js` definitions and `tests/security/proxySecurity.test.js`.

- [ ] **Step 3: Trim `src/lib/muapiProxy.js` and `proxySecurity.test.js`**

Remove the now-unused `proxyMuapi` and `getApiKeyFromRequest` exports (and helpers used only by them) from `src/lib/muapiProxy.js`, keeping `buildMuapiUrl` and anything else a retained importer uses (re-check with grep). In `tests/security/proxySecurity.test.js` delete tests for removed exports; keep `buildMuapiUrl` tests.

- [ ] **Step 4: Verify routing and security**

Run:
```bash
node --test tests/security/proxySecurity.test.js tests/security/creatorProviderGateway.test.js tests/security/replicateGateway.test.js tests/security/authRegression.test.js
grep -rLn "authorizeCreatorRequest" app/api --include=route.js
```
Expected: tests PASS. The `grep -L` list (route files that do NOT call `authorizeCreatorRequest`) must contain only `app/api/auth/*` routes and `app/api/social/*`/other routes that already authenticate another documented way; write each remaining path and its justification in the ledger. Any route that handles provider traffic without auth is a blocker: stop and report.
Run: `npm run test:security && npm run test:creator-shell && node --test tests/*.test.js && npm run lint && npm run build` — Expected: pass; the build route list must no longer show `/workflow`, `/agents`, `/assistant`, `/api/v1`.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: remove legacy routes and BYO-key upload proxies

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Remove the submodules and their build/CI/Docker wiring

**Files:**
- Delete: gitlinks `packages/Vibe-Workflow`, `packages/Open-Poe-AI`, `packages/Open-AI-Design-Agent`; `.gitmodules`
- Modify: `package.json` (workspaces, `ai-agent`/`workflow-builder` file deps, scripts `prebuild`, `build:workflow`, `build:agent`, `build:design`, `build:packages`, `setup`), `next.config.mjs` (`transpilePackages`), `jsconfig.json`, `tailwind.config.js` (content globs only if they reference removed paths; full pruning is Task 6), `packages/studio/package.json`, `Dockerfile`, `.github/workflows/ci.yml`, `.github/workflows/codeql.yml`, `package-lock.json` (regenerated)

**Interfaces:** Consumes Tasks 3-4 (no code imports `ai-agent`, `workflow-builder`, `design-agent`).

- [ ] **Step 1: Prove no importers remain**

`grep -rn "workflow-builder\|ai-agent\|design-agent\|Vibe-Workflow\|Open-Poe-AI\|Open-AI-Design-Agent" app components src packages/studio middleware.js tests scripts` — Expected: no hits. Resolve any before continuing.

- [ ] **Step 2: Remove submodules**

```bash
git submodule deinit -f packages/Vibe-Workflow packages/Open-Poe-AI packages/Open-AI-Design-Agent 2>/dev/null
git rm -f packages/Vibe-Workflow packages/Open-Poe-AI packages/Open-AI-Design-Agent .gitmodules
rm -rf .git/modules/packages 2>/dev/null; true
```
Note: if the worktree stores modules elsewhere, `git rm -f` on the gitlinks is what matters. Verify `git ls-files -s | grep ^160000` prints nothing for these paths.

- [ ] **Step 3: Edit `package.json`**

Remove the three submodule entries from `workspaces` (keep `packages/studio`), the `ai-agent` and `workflow-builder` (and any `design-agent`) `file:` dependencies, and the scripts `build:workflow`, `build:agent`, `build:design`, `build:packages`, `setup`. Set `"prebuild"` to run `build:studio` only if Step 5 shows it is required; otherwise remove `prebuild` and `build:studio`.

- [ ] **Step 4: Edit config files**

- `next.config.mjs`: `transpilePackages: ['studio']`.
- `jsconfig.json`: delete path aliases pointing at removed packages.
- `packages/studio/package.json`: remove `workflow-builder`, `ai-agent`, `design-agent` dependencies.
- `Dockerfile`: remove COPY/RUN lines referencing the three packages and `build:packages`; keep `npm ci` and `npm run build`.
- `.github/workflows/ci.yml` and `codeql.yml`: remove `submodules: recursive`.

- [ ] **Step 5: Regenerate the lockfile and test the build without `studio/dist`**

```bash
rm -rf node_modules package-lock.json packages/studio/dist
npm install
npm run build
```
Expected: install succeeds (this needs network access to the npm registry; if the sandbox blocks it, ask the owner to run `npm install` and report the result — do not skip). The build must pass with no `packages/studio/dist`; if so remove `prebuild`/`build:studio` and the studio `build` scripts, then rebuild once more.

- [ ] **Step 6: Verify**

Run: `npm ci && npm run test:security && npm run test:creator-shell && npm run test:replicate-ui && node --test tests/*.test.js && node --test tests/integration/*.test.js && node --experimental-test-module-mocks scripts/replicate-http-smoke.mjs && npm run lint && npm run build`
Expected: all pass; smoke 11/11.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore: remove submodules and their build, Docker and CI wiring

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Consolidate Tailwind

**Files:**
- Delete: `packages/studio/{tailwind.config.js,postcss.config.js,babel.config.json,src/tailwind.css}` (those that exist), studio `build`/`build:css` scripts
- Modify: `tailwind.config.js` (content globs), `packages/studio/package.json`

- [ ] **Step 1: Capture the CSS before**

```bash
npm run build
cp -r .next/static/css /tmp/claude-501/-Users-abl2525/4b316f5e-2567-4c64-9507-402667736d85/scratchpad/css-before
```

- [ ] **Step 2: Edit and delete**

In `tailwind.config.js` set `content` to only `./app/**/*.{js,jsx}`, `./components/**/*.{js,jsx}`, `./src/**/*.{js,jsx}`, `./packages/studio/src/**/*.{js,jsx}`. Delete the studio-local Tailwind/PostCSS/Babel configs and `src/tailwind.css`, and remove studio `build` / `build:css` scripts. Make `packages/studio/package.json` `"private": true`.

- [ ] **Step 3: Compare**

Run `npm run build`, then compare class coverage:
```bash
cat .next/static/css/*.css | wc -c; cat /tmp/claude-501/-Users-abl2525/4b316f5e-2567-4c64-9507-402667736d85/scratchpad/css-before/*.css | wc -c
```
Expected: the new CSS is not larger and is within roughly 40% smaller. Then run the mocked browser fixture from `docs/superpowers/handoff/2026-10-09-replicate-ui-verification.md` (or its script) and confirm the Replicate Studio still renders styled: no unstyled form, buttons keep `bg-cyan-300`. If any class used by retained components disappeared, add the missing path to `content` and rebuild.

- [ ] **Step 4: Verify and commit**

Run: `npm run lint && npm run build && npm run test:creator-shell`
```bash
git add -A
git commit -m "chore: consolidate to the root Tailwind v3 config

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Resume store (pure module, test-first)

**Files:**
- Create: `src/lib/replicateResume.js`, `tests/replicateResume.test.js`
- Modify: `package.json` (`test:replicate-ui` list: add `tests/replicateResume.test.js`)

**Interfaces:**
- Produces:
  - `RESUME_KEY_PREFIX = 'ogai.replicate.activeJob.v1'` (the stored key is `${RESUME_KEY_PREFIX}.${kind}`)
  - `RESUME_MAX_AGE_MS = 30 * 60 * 1000`
  - `createResumeStore({ storage, kind, now })` → `{ save({ jobId, projectId, userId }), load({ userId }) → { jobId, projectId } | null, clear() }`. `storage` is anything with `getItem/setItem/removeItem`, or `null` (all methods become no-ops, `load` returns `null`). Never throws.
  - `createBrowserResume(kind)` → `createResumeStore` bound to `window.sessionStorage` when available, else a no-op store.

- [ ] **Step 1: Write the failing tests**

Create `tests/replicateResume.test.js`:
```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { RESUME_KEY_PREFIX, RESUME_MAX_AGE_MS, createResumeStore } from '../src/lib/replicateResume.js';

const NOW = Date.UTC(2026, 9, 10, 12, 0, 0);
const PROJECT = '11111111-1111-4111-8111-111111111111';
const KEY = `${RESUME_KEY_PREFIX}.image`;

function memory(initial = {}) {
    const data = { ...initial };
    return {
        data,
        getItem: (key) => (key in data ? data[key] : null),
        setItem: (key, value) => { data[key] = String(value); },
        removeItem: (key) => { delete data[key]; },
    };
}
const make = (storage, clock = { now: NOW }) => createResumeStore({ storage, kind: 'image', now: () => clock.now });
const entry = (patch = {}) => JSON.stringify({ v: 1, jobId: 'abcdef123456', projectId: PROJECT, userId: '42', ts: NOW, ...patch });

test('save then load round-trips only jobId and projectId for the same user', () => {
    const storage = memory();
    const store = make(storage);
    store.save({ jobId: 'abcdef123456', projectId: PROJECT, userId: '42' });
    assert.deepEqual(Object.keys(JSON.parse(storage.data[KEY])).sort(), ['jobId', 'projectId', 'ts', 'userId', 'v']);
    assert.deepEqual(store.load({ userId: '42' }), { jobId: 'abcdef123456', projectId: PROJECT });
});

test('a different user, an old entry, or a missing userId yields null and clears the entry', () => {
    for (const [stored, userId, clock] of [
        [entry(), '43', { now: NOW }],
        [entry({ ts: NOW - RESUME_MAX_AGE_MS - 1 }), '42', { now: NOW }],
        [entry(), '', { now: NOW }],
    ]) {
        const storage = memory({ [KEY]: stored });
        assert.equal(make(storage, clock).load({ userId }), null);
        assert.equal(storage.getItem(KEY), null);
    }
});

test('tampered entries are discarded silently', () => {
    const bad = [
        entry({ jobId: '../etc/passwd' }), entry({ jobId: 'ab' }), entry({ jobId: 'x'.repeat(61) }),
        entry({ projectId: 'not-a-uuid' }), entry({ v: 2 }), entry({ ts: 'soon' }),
        'null', '[]', '"text"', '{not json', '',
    ];
    for (const stored of bad) {
        const storage = memory({ [KEY]: stored });
        assert.equal(make(storage).load({ userId: '42' }), null, stored);
        assert.equal(storage.getItem(KEY), null, stored);
    }
});

test('save rejects invalid ids and never stores extra fields', () => {
    const storage = memory();
    const store = make(storage);
    store.save({ jobId: 'bad id!', projectId: PROJECT, userId: '42' });
    store.save({ jobId: 'abcdef123456', projectId: 'nope', userId: '42' });
    store.save({ jobId: 'abcdef123456', projectId: PROJECT, userId: '' });
    assert.deepEqual(storage.data, {});
    store.save({ jobId: 'abcdef123456', projectId: PROJECT, userId: '42', prompt: 'secret', url: 'https://x' });
    assert.doesNotMatch(storage.data[KEY], /secret|https/);
});

test('image and video entries are independent and clear removes only its own', () => {
    const storage = memory();
    const image = createResumeStore({ storage, kind: 'image', now: () => NOW });
    const video = createResumeStore({ storage, kind: 'video', now: () => NOW });
    image.save({ jobId: 'imagejob1', projectId: PROJECT, userId: '42' });
    video.save({ jobId: 'videojob1', projectId: PROJECT, userId: '42' });
    image.clear();
    assert.equal(image.load({ userId: '42' }), null);
    assert.equal(video.load({ userId: '42' }).jobId, 'videojob1');
});

test('storage that throws or is missing never throws', () => {
    const throwing = {
        getItem() { throw new Error('denied'); }, setItem() { throw new Error('quota'); }, removeItem() { throw new Error('denied'); },
    };
    for (const storage of [throwing, null, undefined]) {
        const store = createResumeStore({ storage, kind: 'image', now: () => NOW });
        assert.doesNotThrow(() => store.save({ jobId: 'abcdef123456', projectId: PROJECT, userId: '42' }));
        assert.equal(store.load({ userId: '42' }), null);
        assert.doesNotThrow(() => store.clear());
    }
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/replicateResume.test.js`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/lib/replicateResume.js`**

```js
// Browser-side "resume this job" pointer. Holds only an opaque job id, the Project id and the
// owning user id so an in-progress Replicate job survives in-app navigation. Never stores a
// prompt, input, asset URL, quote token or any key. Every read is re-validated and the job is
// always re-fetched through the owner-bound status route, so a tampered value cannot reach
// another user's job.
export const RESUME_KEY_PREFIX = 'ogai.replicate.activeJob.v1';
export const RESUME_MAX_AGE_MS = 30 * 60 * 1000;

const JOB_ID = /^[A-Za-z0-9_-]{3,60}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function createResumeStore({ storage, kind, now = () => Date.now() }) {
    const key = `${RESUME_KEY_PREFIX}.${kind}`;
    const safe = (fn, fallback) => {
        try { return fn(); } catch { return fallback; }
    };
    const clear = () => { safe(() => storage?.removeItem(key)); };

    function save({ jobId, projectId, userId }) {
        if (!storage) return;
        const user = String(userId ?? '');
        if (!JOB_ID.test(String(jobId)) || !UUID.test(String(projectId)) || !user) return;
        safe(() => storage.setItem(key, JSON.stringify({ v: 1, jobId: String(jobId), projectId: String(projectId), userId: user, ts: now() })));
    }

    function load({ userId }) {
        if (!storage) return null;
        const raw = safe(() => storage.getItem(key), null);
        if (raw === null || raw === undefined) return null;
        let value = null;
        try { value = JSON.parse(raw); } catch { value = null; }
        const valid = value && typeof value === 'object' && !Array.isArray(value)
            && value.v === 1
            && JOB_ID.test(String(value.jobId))
            && UUID.test(String(value.projectId))
            && typeof value.userId === 'string' && value.userId !== '' && value.userId === String(userId ?? '')
            && Number.isFinite(value.ts) && now() - value.ts >= 0 && now() - value.ts <= RESUME_MAX_AGE_MS;
        if (!valid) { clear(); return null; }
        return { jobId: value.jobId, projectId: value.projectId };
    }

    return { save, load, clear };
}

export function createBrowserResume(kind) {
    let storage = null;
    try { storage = typeof window !== 'undefined' ? window.sessionStorage : null; } catch { storage = null; }
    return createResumeStore({ storage, kind });
}
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test tests/replicateResume.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Register in the script and commit**

Add `tests/replicateResume.test.js` to the `test:replicate-ui` list in `package.json`, run `npm run test:replicate-ui` (Expected: 65 baseline + 6, all pass).
```bash
git add src/lib/replicateResume.js tests/replicateResume.test.js package.json
git commit -m "feat: add validated session-scoped resume store for Replicate jobs

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Controller resume hooks (test-first)

**Files:**
- Modify: `src/lib/replicateStudioClient.js` (controller options, `applyJob`, `enterUncertain`, `authLost`, `pollOnce`, `load`), `tests/replicateStudioController.test.js` (harness option + new tests)

**Interfaces:**
- Consumes: Task 7 `createResumeStore` shape (`save/load/clear`).
- Produces: `createReplicateController({ ..., resume = null, userId = '' })`. State gains `resumed: boolean`. Behaviour:
  - non-terminal job accepted or polled → `resume.save({ jobId, projectId: state.jobProjectId, userId })`
  - terminal job, `authLost`, `acknowledge` of an uncertain state → `resume.clear()`
  - `load()`: when `resume` is set, state is idle with no job, and `resume.load({ userId })` returns an entry → set `phase:'running'`, `jobId`, `jobProjectId`, `resumed:true`, a notice `{ kind:'resumed', message:'Resuming your in-progress generation…' }`, then poll that job once immediately via the existing `pollOnce` (never calls `generate`).
  - a 404 from a resumed poll → `resume.clear()`, return to idle with notice `{ kind:'info', message:'The earlier generation is no longer available.' }`.

- [ ] **Step 1: Extend the test harness**

In `tests/replicateStudioController.test.js` change `function harness({ mode = 'mock', overrides = {} } = {})` to `function harness({ mode = 'mock', overrides = {}, controllerOptions = {} } = {})` and add `...controllerOptions,` as the last property inside the `createReplicateController({ ... })` call. Add at the top of the file after the existing helpers:
```js
import { createResumeStore } from '../src/lib/replicateResume.js';

function memoryStorage(initial = {}) {
    const data = { ...initial };
    return {
        data,
        getItem: (key) => (key in data ? data[key] : null),
        setItem: (key, value) => { data[key] = String(value); },
        removeItem: (key) => { delete data[key]; },
    };
}
const resumeFor = (storage) => createResumeStore({ storage, kind: 'image', now: () => NOW });
const RESUME_KEY = 'ogai.replicate.activeJob.v1.image';
```
(Keep the existing import block; add the `createResumeStore` import beside it.)

- [ ] **Step 2: Write the failing tests** (append to the same file)

```js
test('a running job writes the resume pointer and a terminal job clears it', async () => {
    const storage = memoryStorage();
    const h = harness({
        overrides: { generate: async () => ({ job: job('queued') }), status: async () => ({ job: job('completed') }) },
        controllerOptions: { resume: resumeFor(storage), userId: '42' },
    });
    await h.ready();
    await h.controller.generate();
    assert.equal(JSON.parse(storage.data[RESUME_KEY]).jobId, JOB_ID);
    assert.equal(JSON.parse(storage.data[RESUME_KEY]).projectId, PROJECT);
    await h.fire();
    assert.equal(h.controller.getState().phase, 'completed');
    assert.equal(storage.getItem(RESUME_KEY), null);
});

test('a fresh controller resumes the saved job by polling status and never calls generate', async () => {
    const storage = memoryStorage({
        [RESUME_KEY]: JSON.stringify({ v: 1, jobId: JOB_ID, projectId: PROJECT, userId: '42', ts: NOW }),
    });
    const h = harness({
        overrides: { status: async (id) => { return { job: job('completed', { jobId: id }) }; } },
        controllerOptions: { resume: resumeFor(storage), userId: '42' },
    });
    await h.controller.load();
    await new Promise((resolve) => setImmediate(resolve));
    const state = h.controller.getState();
    assert.equal(state.phase, 'completed');
    assert.equal(h.count('generate'), 0);
    assert.equal(h.count('quote'), 0);
    assert.equal(h.settled.length, 1);
    assert.equal(h.settled[0].projectId, PROJECT);
    assert.equal(storage.getItem(RESUME_KEY), null);
});

test('a resumed job that is still running keeps polling the same job id', async () => {
    const storage = memoryStorage({
        [RESUME_KEY]: JSON.stringify({ v: 1, jobId: JOB_ID, projectId: PROJECT, userId: '42', ts: NOW }),
    });
    const h = harness({
        overrides: { status: async () => ({ job: job('running') }) },
        controllerOptions: { resume: resumeFor(storage), userId: '42' },
    });
    await h.controller.load();
    await new Promise((resolve) => setImmediate(resolve));
    const state = h.controller.getState();
    assert.equal(state.phase, 'running');
    assert.equal(state.jobId, JOB_ID);
    assert.equal(state.resumed, true);
    assert.equal(h.pending().length, 1);
    assert.equal(h.count('generate'), 0);
});

test('a resumed job the server no longer knows (404) clears the pointer and returns to idle', async () => {
    const storage = memoryStorage({
        [RESUME_KEY]: JSON.stringify({ v: 1, jobId: JOB_ID, projectId: PROJECT, userId: '42', ts: NOW }),
    });
    const h = harness({
        overrides: { status: async () => { throw new ReplicateApiError('Not found', { status: 404 }); } },
        controllerOptions: { resume: resumeFor(storage), userId: '42' },
    });
    await h.controller.load();
    await new Promise((resolve) => setImmediate(resolve));
    const state = h.controller.getState();
    assert.equal(state.phase, 'idle');
    assert.equal(state.jobId, '');
    assert.equal(state.notice.kind, 'info');
    assert.equal(storage.getItem(RESUME_KEY), null);
    assert.equal(h.pending().length, 0);
});

test('a saved pointer for another user is ignored and cleared', async () => {
    const storage = memoryStorage({
        [RESUME_KEY]: JSON.stringify({ v: 1, jobId: JOB_ID, projectId: PROJECT, userId: '99', ts: NOW }),
    });
    const h = harness({ controllerOptions: { resume: resumeFor(storage), userId: '42' } });
    await h.controller.load();
    assert.equal(h.controller.getState().phase, 'idle');
    assert.equal(h.count('status'), 0);
    assert.equal(storage.getItem(RESUME_KEY), null);
});

test('losing the session (401) clears the pointer', async () => {
    const storage = memoryStorage({
        [RESUME_KEY]: JSON.stringify({ v: 1, jobId: JOB_ID, projectId: PROJECT, userId: '42', ts: NOW }),
    });
    const h = harness({
        overrides: { status: async () => { throw new ReplicateApiError('Sign in', { status: 401 }); } },
        controllerOptions: { resume: resumeFor(storage), userId: '42' },
    });
    await h.controller.load();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.counters.authLost, 1);
    assert.equal(storage.getItem(RESUME_KEY), null);
});

test('without a resume store the controller behaves exactly as before', async () => {
    const h = harness();
    await h.controller.load();
    assert.equal(h.controller.getState().phase, 'idle');
    assert.equal(h.controller.getState().resumed, false);
});
```

- [ ] **Step 3: Run to verify failure**

Run: `node --test tests/replicateStudioController.test.js`
Expected: the new tests FAIL (`resumed` undefined / pointer never written); all pre-existing tests still PASS.

- [ ] **Step 4: Implement in `src/lib/replicateStudioClient.js`**

1. `initialState`: add `resumed: false,` after `notice: null,`.
2. Controller signature: add `resume = null, userId = '',` after `onAuthLost = () => {},`.
3. Add helper after `stopPolling`:
```js
    const clearResume = () => { try { resume?.clear(); } catch { /* resume is best-effort */ } };
    const saveResume = (jobId) => {
        try { resume?.save({ jobId, projectId: state.jobProjectId, userId }); } catch { /* resume is best-effort */ }
    };
```
4. `authLost()`: call `clearResume();` as the first line.
5. `enterUncertain(...)`: call `clearResume();` (an unconfirmed record is not resumable).
6. `applyJob`: in the non-terminal branch, before `set({ job, ... })` add `saveResume(job.jobId);`. In the terminal branch, right after `stopPolling();` add `clearResume();`.
7. Accepted-with-recovery path in `doSubmit` (`error.statusRecoveryAvailable` branch): before `startPolling(error.jobId)` add `saveResume(error.jobId);`.
8. `pollOnce` catch: before `stopPolling(); set({ checkFailed: true, ... })` add:
```js
            if (error.status === 404 && state.resumed) {
                stopPolling();
                clearResume();
                set({
                    phase: 'idle', job: null, jobId: '', jobProjectId: '', resumed: false, checkFailed: false,
                    notice: { kind: 'info', message: 'The earlier generation is no longer available.' },
                });
                return;
            }
```
9. `load()`: after the successful `set({ loaded: true, ... })` inside `try`, add:
```js
            if (resume && state.phase === 'idle' && !state.jobId) {
                const saved = resume.load({ userId });
                if (saved) {
                    set({
                        phase: 'running', jobId: saved.jobId, jobProjectId: saved.projectId, resumed: true,
                        notice: { kind: 'resumed', message: 'Resuming your in-progress generation…' },
                    });
                    pollStartedAt = now();
                    await pollOnce(saved.jobId, myEpoch);
                }
            }
```
(`pollOnce` sets `timer = null` first, then schedules the next poll through `applyJob` as it does today.)
10. In `applyJob`'s terminal branch set `resumed: false` inside the `set({...})`.

- [ ] **Step 5: Run to verify pass**

Run: `node --test tests/replicateStudioController.test.js`
Expected: all pass (existing + 7 new). Then `npm run test:replicate-ui` — Expected: pass.

- [ ] **Step 6: Confirm the gateway diff is still empty and commit**

Run: `git diff 108b238 -- src/lib/replicateGateway.js src/lib/generationGuard.js src/lib/replicatePersist.js src/lib/replicateProvider.js` — Expected: no output.
```bash
git add src/lib/replicateStudioClient.js tests/replicateStudioController.test.js
git commit -m "feat: resume in-flight Replicate jobs through the owner-bound status route

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Wire resume into the component and logout

**Files:**
- Modify: `src/lib/replicateStudioClient.js` (add `fetchSessionUserId`), `components/ReplicateStudio.js`, `packages/studio/src/components/CreatorStudio.jsx` (`signOut`), `tests/replicateStudioWiring.test.js`
- Depends on: Task 3 (the studio prune), Task 8

**Interfaces:**
- Consumes: `createBrowserResume(kind)` (Task 7); controller `resume`/`userId` options (Task 8).
- Produces: `fetchSessionUserId({ fetchImpl })` in `replicateStudioClient.js` → resolves to a string user id, or `''` when unauthenticated/unavailable (never throws).

- [ ] **Step 1: Write the failing tests**

Append to `tests/replicateStudioWiring.test.js`:
```js
import { fetchSessionUserId } from '../src/lib/replicateStudioClient.js';

test('fetchSessionUserId returns the user id, or an empty string on any failure', async () => {
    const ok = async () => ({ ok: true, json: async () => ({ authenticated: true, user: { id: 42, login: 'owner' } }) });
    assert.equal(await fetchSessionUserId({ fetchImpl: ok }), '42');
    const unauth = async () => ({ ok: false, status: 401, json: async () => ({ authenticated: false }) });
    assert.equal(await fetchSessionUserId({ fetchImpl: unauth }), '');
    const broken = async () => { throw new Error('offline'); };
    assert.equal(await fetchSessionUserId({ fetchImpl: broken }), '');
    const odd = async () => ({ ok: true, json: async () => ({ authenticated: true, user: {} }) });
    assert.equal(await fetchSessionUserId({ fetchImpl: odd }), '');
});

test('ReplicateStudio wires the resume store and sign-out clears every resume pointer', async () => {
    const component = await read('../components/ReplicateStudio.js');
    assert.match(component, /createBrowserResume\(kind\)/);
    assert.match(component, /fetchSessionUserId/);
    const creator = await read('../packages/studio/src/components/CreatorStudio.jsx');
    assert.match(creator, /ogai\.replicate\.activeJob\.v1\.image/);
    assert.match(creator, /ogai\.replicate\.activeJob\.v1\.video/);
    const logoutIndex = creator.indexOf('"/api/auth/logout"');
    const clearIndex = creator.indexOf('ogai.replicate.activeJob.v1.image');
    assert.ok(clearIndex > -1 && clearIndex < logoutIndex, 'pointers are cleared before the logout request');
});

test('resume code stores no prompt, URL or key', async () => {
    const source = await read('../src/lib/replicateResume.js');
    assert.doesNotMatch(source, /prompt|quoteToken|outputUrl|apiKey|REPLICATE_API_TOKEN/i);
});
```
Run: `node --test tests/replicateStudioWiring.test.js` — Expected: FAIL (`fetchSessionUserId` is not exported).

- [ ] **Step 2: Add `fetchSessionUserId`**

Append to `src/lib/replicateStudioClient.js`:
```js
export async function fetchSessionUserId({ fetchImpl = (...args) => globalThis.fetch(...args) } = {}) {
    try {
        const response = await fetchImpl('/api/auth/session', { credentials: 'same-origin', cache: 'no-store' });
        if (!response.ok) return '';
        const value = await response.json();
        const id = value?.user?.id;
        return id === undefined || id === null || id === '' ? '' : String(id);
    } catch {
        return '';
    }
}
```

- [ ] **Step 3: Wire `components/ReplicateStudio.js`**

Change the import line to
`import { createReplicateApi, createReplicateController, fetchSessionUserId } from '@/src/lib/replicateStudioClient.js';`
and add `import { createBrowserResume } from '@/src/lib/replicateResume.js';`.
Replace the controller-creating `useEffect` with:
```js
  useEffect(() => {
    let cancelled = false;
    let next = null;
    (async () => {
      const userId = await fetchSessionUserId();
      if (cancelled) return;
      next = createReplicateController({
        api: createReplicateApi(),
        kind,
        resume: userId ? createBrowserResume(kind) : null,
        userId,
        onJobSettled: (event) => callbacks.current.onJobSettled?.(event),
        onAuthLost: () => callbacks.current.onAuthLost?.(),
      });
      setController(next);
      next.load();
    })();
    return () => { cancelled = true; next?.teardown(); };
  }, [kind]);
```

- [ ] **Step 4: Clear pointers on sign-out**

In `packages/studio/src/components/CreatorStudio.jsx` `signOut`, immediately after `generationTokenRef.current += 1;` and before the `try {` add:
```js
    try {
      window.sessionStorage.removeItem("ogai.replicate.activeJob.v1.image");
      window.sessionStorage.removeItem("ogai.replicate.activeJob.v1.video");
    } catch {}
```

- [ ] **Step 5: Verify**

Run: `node --test tests/replicateStudioWiring.test.js` — Expected: PASS.
Run: `npm run test:replicate-ui && npm run test:creator-shell && npm run test:security && npm run lint && npm run build` — Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: wire Replicate job resume into the studio and sign-out

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Permanent key-storage guard, docs, and local-run guide

**Files:**
- Create: `tests/security/noBrowserKeyStorage.test.js`, `docs/LOCAL_RUN.md`
- Modify: `README.md`, `project_knowledge.md`, `docs/SECURITY_CONFIGURATION.md`, `docs/PHASE_1_STATUS.md` (add a short "Rebuild v2 local state" note only)

- [ ] **Step 1: Write the guard test**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = new URL('../../', import.meta.url).pathname;

async function files(dir) {
    const out = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) out.push(...await files(path));
        else if (/\.(js|jsx|mjs)$/.test(entry.name)) out.push(path);
    }
    return out;
}

test('no browser storage of provider keys and no document.cookie writes in app, src, components', async () => {
    const offenders = [];
    for (const dir of ['app', 'src', 'components']) {
        for (const file of await files(join(ROOT, dir))) {
            const source = await readFile(file, 'utf8');
            if (/muapi_key|setItem\(\s*['"`][^'"`]*[Kk]ey['"`]/.test(source) || /document\.cookie\s*=/.test(source)) offenders.push(file);
        }
    }
    assert.deepEqual(offenders, []);
});

test('no NEXT_PUBLIC secrets and no Replicate token in client components', async () => {
    for (const file of await files(join(ROOT, 'components'))) {
        const source = await readFile(file, 'utf8');
        assert.doesNotMatch(source, /REPLICATE_API_TOKEN|NEXT_PUBLIC_[A-Z_]*(KEY|TOKEN|SECRET)/, file);
    }
});
```
Run: `node --test tests/security/noBrowserKeyStorage.test.js`
Expected: PASS. If it fails, the offender list shows a surviving file: fix that file (remove the key storage), not the test. (Known candidate: `components/StandaloneShell.js` remnants and `packages`-free `src/` files; Task 3 should have removed them.)

- [ ] **Step 2: Write `docs/LOCAL_RUN.md`**

Content (real commands only):
```markdown
# Run Creator Studio locally (mock mode)

No Replicate token, no paid calls. Mock mode is the default.

1. Node 24 and npm. From the repo root: `npm ci`.
2. Copy `.env.example` to `.env.local` and set the owner-session variables documented in
   `docs/SECURITY_CONFIGURATION.md` (GitHub OAuth app for localhost, `CREATOR_SESSION_SECRET`, the
   allowed GitHub identity). Leave `GENERATION_MODE` unset (mock). Do NOT set `REPLICATE_API_TOKEN`.
3. `npm run dev`, open http://localhost:3000/studio and sign in.
4. Image and Video tabs: pick the Replicate provider, enter a prompt, Generate. Results are mock
   placeholders (video is a PNG graphic) saved to the current Project.
5. Resume check: start a generation, switch to Home and back; the job continues. Sign out and the
   pointer is cleared.
6. Without OAuth, run the mocked HTTP smoke instead:
   `node --experimental-test-module-mocks scripts/replicate-http-smoke.mjs` (expects 11/11).
```
After writing it, check every variable name against `.env.example` and `docs/SECURITY_CONFIGURATION.md` and correct the file to the real names.

- [ ] **Step 3: Update docs**

In `README.md` remove sections about Electron, Vite, submodules, `npm run setup`, `build:packages`, MuAPI BYO-key proxies (cartographer pointers: README lines ~58, 86, 126, 425-510, 552-557), and link to `docs/LOCAL_RUN.md`. Fix `project_knowledge.md` (~63-65, 85) and `docs/SECURITY_CONFIGURATION.md` (~43) the same way. Add to `docs/PHASE_1_STATUS.md` one dated paragraph: legacy removed locally on `rebuild/creator-studio-replicate`, not merged or deployed, no live provider test.

- [ ] **Step 4: Verify and commit**

Run: `grep -rn "electron\|Vibe-Workflow\|Open-Poe-AI\|Open-AI-Design-Agent\|build:packages\|npm run setup" README.md docs project_knowledge.md` — Expected: only historical mentions explicitly labelled as removed.
Run: `npm run test:security && npm run lint`
```bash
git add -A
git commit -m "docs: add local-run guide, document the cleanup, and guard against browser key storage

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Whole-branch verification, security re-audit, and review

**Files:**
- Create: `docs/superpowers/handoff/2026-10-10-cleanup-and-resume-verification.md`
- Modify: `.superpowers/sdd/2026-10-10-legacy-cleanup/progress.md`

- [ ] **Step 1: Full suite from a clean install**

```bash
rm -rf node_modules .next && npm ci
npm run test:security && npm run test:creator-shell && npm run test:replicate-ui
node --test tests/*.test.js && node --test tests/integration/*.test.js
node --experimental-test-module-mocks scripts/replicate-http-smoke.mjs
npm run lint && npm run build
```
Expected: all pass; smoke 11/11; build route list has no `/workflow`, `/agents`, `/assistant`, `/api/v1`. Write each count next to its Task 1 baseline with the reason for any difference.

- [ ] **Step 2: Security invariants I1-I6**

```bash
grep -rnE "muapi_key|x-api-key|setItem\(.*[Kk]ey" app src components --include='*.js' --include='*.jsx'   # I1: empty
grep -rn "document.cookie" app src components                                                           # I1: empty
grep -rn "NEXT_PUBLIC_" app src components                                                              # I2: no secrets
grep -rLn "authorizeCreatorRequest" app/api --include=route.js                                         # I3: each justified
git diff 108b238 -- src/lib/replicateGateway.js src/lib/generationGuard.js src/lib/replicatePersist.js src/lib/replicateProvider.js   # I4: empty
grep -n "maxUsdPerJob\|maxUsdPerDay" src/lib/replicateProvider.js                                       # I5: defaults 1 and 5
grep -rn "GENERATION_MODE=live\|REPLICATE_LIVE_ENABLED=true" . --include='.env*' --include='*.yml' --include='Dockerfile' --exclude-dir=node_modules  # I6: empty
```
Then dispatch the `agent-skills:security-auditor` agent (read-only) to re-audit these with the auditor's baseline report and the spec; fix anything it reports as Critical/High before continuing.

- [ ] **Step 3: Browser check in mock mode (headless Chrome via CDP, as in the 2026-10-09 handoff)**

Reuse the mocked fixture documented in `docs/superpowers/handoff/2026-10-09-replicate-ui-verification.md` and add three scenarios: (a) start a job (status stays `running`), navigate Home and back, the job resumes and later completes with no second `generate` request; (b) clear the status fixture to 404, reload, the form returns to idle with "no longer available"; (c) sign out, the `sessionStorage` pointer keys are gone. Record results in the verification handoff doc. Do not make any real network provider call.

- [ ] **Step 4: Whole-branch review**

Run the `superpowers:requesting-code-review` flow with the `agent-skills:code-reviewer` agent over `git diff origin/main...HEAD` limited to files changed since `108b238` plus Tasks 1-10 commits. Fix Critical/Important findings with a failing test first; list Minor findings in the handoff doc.

- [ ] **Step 5: Hand back**

Write the verification handoff (commands run, counts, deltas, review result, anything not done). Update the project memory file `project_ogai_replicate_creator_studio_rebuild.md` with the new state. Commit:
```bash
git add docs/superpowers/handoff/2026-10-10-cleanup-and-resume-verification.md
git commit -m "docs: record cleanup and job-resume verification

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```
Report to the owner: branch state, what was verified, and the still-open decisions (push/PR, Preview deploy, live Replicate verification, `Sec-Fetch-Site` hardening, CSP narrowing). Do not push.

---

## Agent roles (if run subagent-driven)

| Role | Tasks |
|---|---|
| Architect/Planner | this plan (done) |
| Dependency Cartographer | consulted for Tasks 2-5 (report already incorporated); re-run read-only `graphify update` after Task 5 |
| Cleanup Engineer | 1, 2, 3, 4, 5, 6 (sequential; one agent so the build stays green) |
| Job-Resume Engineer | 7, 8 in its own worktree off the same branch; 9 after Task 3 lands |
| Test Engineer | reviews each task's test deltas against the Task 1 baseline; owns Task 10 Step 1 |
| Security Auditor | gate after Task 4 (route auth list) and Task 11 Step 2 |
| Reviewer + Local-Run Verifier | Task 11 Steps 3-4, plus a per-task spec/quality review |

Order: 1 → 2 → 3 → 4 → 5 → 6 on the Cleanup track; 7 → 8 in parallel on the Job-Resume track; 9 after both 3 and 8; 10 after 6 and 9; 11 last.
