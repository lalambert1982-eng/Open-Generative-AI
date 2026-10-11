# Replicate Creator Studio UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the existing Creator Studio Image and Video destinations generate through the finished Replicate backend, save into the owned Project, and reopen results, with MuAPI kept as an explicit alternative.

**Architecture:** Browser logic lives in three small, dependency-injected ES modules under `src/lib/` (form helpers, API client + lifecycle controller, view model) that are unit-tested with `node --test`. Two thin React components (`ReplicateStudio`, `CreatorMediaStudio`) only render controller state. `StandaloneShell` swaps the Image/Video cases to the wrapper and refreshes the originating Project after a job settles. Home gains recent Assets and enabled models.

**Tech Stack:** Next.js 15 / React 19 (plain `.js` JSX components), Node 24 `node:test`, Tailwind classes already used by the shell. No new npm dependencies.

**Spec:** `docs/superpowers/specs/2026-10-08-replicate-ui-followup-design.md` (APPROVED 2026-10-09). Backend contract: `docs/SECURITY_CONFIGURATION.md` "Replicate generation controls".

## Global Constraints

- Local only: no push, PR, merge, deploy, real credentials, real Replicate/Blob/GitHub calls, paid generation, or new npm dependencies.
- Replicate is the default provider; MuAPI stays selectable only through the existing `CreatorStudio` element passed in by the shell. No cross-provider or cross-model fallback; never auto-retry a create.
- Browser code uses `credentials: 'same-origin'` and JSON bodies; it never imports server provider code or reads provider environment variables, and never sends owner identity, price, refund data, provider URLs, or a mode override.
- The only result URL is `job.asset.url`. Do not read or display any other output-URL field. Do not fabricate a remaining-daily-budget value.
- Branch on `generationAccepted` before the HTTP status (a 404/409 can carry a valid `jobId`). `retryable: false` means no Retry-generation control anywhere.
- Mock video is a PNG `graphic` Asset: preview it as an image with a "Mock placeholder" label, never as a playable video.
- The server replaces the generic completion callback: the new flow must NOT call `recordAsset`/`onGenerationComplete`; it refreshes the originating Project instead.
- Format prices so `0.003` shows as `$0.003`, not `$0.00`.
- Claude solely owns `components/*`, `src/lib/replicateStudio*.js` and `StandaloneShell.js` for this plan. Stage only files belonging to the current task. Preserve legacy MuAPI proxies, Electron, submodules, and other Studios. Do not edit the backend (`src/lib/replicate{Gateway,Provider,ModelRegistry,Persist}.js`) or another worktree/branch.
- Browser files import repo modules with the `@/src/lib/<file>.js` alias (as `StandaloneShell.js` does). `src/lib` files import each other with relative paths so `node --test` can load them.
- Commit trailer: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` (second `-m`).

## Review Focus

Failure modes the spec implies that a user is most likely to hit; each has a test in the owning task:

1. Double-clicking Generate / Confirm sends exactly one create request (Task 2).
2. A live quote that expires between "Review price" and "Confirm" must not submit; the user is told to review again (Task 2).
3. An accepted job whose create call returned HTTP 404/409 plus a valid `jobId` is adopted and polled, never re-POSTed (Task 2).
4. Mock video renders as an image placeholder, not a `<video>` (Task 3).
5. Switching Project while a job runs refreshes only the originating Project and never inserts the Asset into the newly selected Project's view (Tasks 2 and 5).
6. A 401 mid-poll clears owner-specific job/result state and stops polling; unmounting stops polling (Task 2).

---

## File Structure

| File | Action | Responsibility |
| --- | --- | --- |
| `src/lib/replicateStudioForm.js` | Create | Pure helpers: price formatting, default values, input building, validation, default model, Asset choices |
| `src/lib/replicateStudioClient.js` | Create | `ReplicateApiError`, `createReplicateApi`, `createReplicateController` (lifecycle state machine; injectable api/time) |
| `src/lib/replicateStudioView.js` | Create | `deriveView(state)`: everything the component needs to decide (buttons, banners, preview kind) |
| `components/ReplicateStudio.js` | Create | Renders controller state: model, settings form, price review, progress, preview, receipt |
| `components/CreatorMediaStudio.js` | Create | Replicate/MuAPI selector wrapper |
| `components/StandaloneShell.js` | Modify | Image/Video cases use the wrapper; originating-Project refresh |
| `components/CreatorHome.js` | Modify | Recent Project Assets and enabled models |
| `tests/replicateStudioForm.test.js` | Create | Form helper tests |
| `tests/replicateStudioClient.test.js` | Create | API layer tests |
| `tests/replicateStudioController.test.js` | Create | Lifecycle tests |
| `tests/replicateStudioView.test.js` | Create | View-model tests |
| `tests/replicateStudioWiring.test.js` | Create | Source-level wiring and no-secret assertions (house style of `tests/creatorShellIntegration.test.js`) |
| `scripts/replicate-ui-fixture-server.mjs` | Create | Local fixture API (real handlers, in-memory stores) for browser verification |
| `next.config.mjs` | Modify | Dev-only rewrite to the fixture server, active only when `CREATOR_UI_FIXTURE_ORIGIN` is set |
| `package.json` | Modify | `test:replicate-ui` script |

(`replicateStudioClient.js` in the spec's file table is split into form/client/view modules so each file holds one responsibility; ownership is unchanged.)

---

### Task 1: Form helpers

**Files:**
- Create: `src/lib/replicateStudioForm.js`
- Test: `tests/replicateStudioForm.test.js`

**Interfaces:**
- Produces:
  - `formatUsd(value: number): string`
  - `defaultValues(model): Record<string, unknown>`
  - `buildInput(model, values): Record<string, unknown>`
  - `validationErrors(model, values): Record<string, string>` (empty object = valid)
  - `pickDefaultModel(models, kind): model | null`
  - `assetChoices(assets): Array<{ url: string, title: string, id: string }>`
  - `fieldLabel(name: string): string`
  - A model is the object from `GET replicate/models`: `{ id, kind, task, label, pricing, inputs, enabled }`; each `inputs[name]` is `{ type: 'string'|'url'|'urlArray'|'enum'|'integer'|'boolean', required?, max?, min?, values?, default? }`.

- [ ] **Step 1: Write the failing tests**

```js
// tests/replicateStudioForm.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    assetChoices, buildInput, defaultValues, fieldLabel, formatUsd, pickDefaultModel, validationErrors,
} from '../src/lib/replicateStudioForm.js';

const model = {
    id: 'vendor/video', kind: 'video', enabled: true,
    inputs: {
        prompt: { type: 'string', required: true, max: 10 },
        image: { type: 'url' },
        refs: { type: 'urlArray', max: 2 },
        duration: { type: 'enum', values: [4, 6, 8], default: 6 },
        steps: { type: 'integer', min: 1, max: 5, default: 3 },
        fixed: { type: 'boolean', default: false },
    },
};

test('formatUsd keeps small values and pads whole cents', () => {
    assert.equal(formatUsd(0.003), '$0.003');
    assert.equal(formatUsd(0.015), '$0.015');
    assert.equal(formatUsd(0.3), '$0.30');
    assert.equal(formatUsd(1), '$1.00');
    assert.equal(formatUsd(0.151), '$0.151');
});

test('defaultValues copies declared defaults only', () => {
    assert.deepEqual(defaultValues(model), { duration: 6, steps: 3, fixed: false });
});

test('buildInput trims, drops empties, and maps enum strings back to declared values', () => {
    const input = buildInput(model, { prompt: '  a fox ', image: '', refs: ['', 'https://x/y.png'], duration: '8', steps: '4', fixed: true });
    assert.deepEqual(input, { prompt: 'a fox', refs: ['https://x/y.png'], duration: 8, steps: 4, fixed: true });
});

test('validationErrors reports required, length, range, and array limits', () => {
    assert.deepEqual(Object.keys(validationErrors(model, { prompt: '' })), ['prompt']);
    assert.ok(validationErrors(model, { prompt: 'x'.repeat(11) }).prompt);
    assert.ok(validationErrors(model, { prompt: 'ok', steps: 9 }).steps);
    assert.ok(validationErrors(model, { prompt: 'ok', steps: 2.5 }).steps);
    assert.ok(validationErrors(model, { prompt: 'ok', refs: ['a', 'b', 'c'] }).refs);
    assert.deepEqual(validationErrors(model, { prompt: 'ok', steps: 2 }), {});
});

test('required url field is enforced', () => {
    const edit = { inputs: { prompt: { type: 'string', required: true, max: 50 }, input_image: { type: 'url', required: true } } };
    assert.ok(validationErrors(edit, { prompt: 'ok' }).input_image);
});

test('pickDefaultModel returns the first enabled model of the kind', () => {
    const models = [{ id: 'a', kind: 'image', enabled: false }, { id: 'b', kind: 'image', enabled: true }, { id: 'c', kind: 'video', enabled: true }];
    assert.equal(pickDefaultModel(models, 'image').id, 'b');
    assert.equal(pickDefaultModel(models, 'audio'), null);
});

test('assetChoices offers only image and graphic Assets that have a url', () => {
    const choices = assetChoices([
        { id: '1', type: 'image', url: 'https://a/1.png', title: 'One' },
        { id: '2', type: 'graphic', url: 'https://a/2.png', title: 'Two' },
        { id: '3', type: 'video', url: 'https://a/3.mp4', title: 'Three' },
        { id: '4', type: 'image', title: 'No url' },
    ]);
    assert.deepEqual(choices.map((item) => item.id), ['1', '2']);
});

test('fieldLabel humanizes provider field names', () => {
    assert.equal(fieldLabel('aspect_ratio'), 'Aspect ratio');
    assert.equal(fieldLabel('prompt'), 'Prompt');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/replicateStudioForm.test.js`
Expected: FAIL (`Cannot find module '../src/lib/replicateStudioForm.js'`).

- [ ] **Step 3: Implement**

```js
// src/lib/replicateStudioForm.js
// Pure helpers for the Replicate settings form. No browser or server APIs.

export function formatUsd(value) {
    const cents = value.toFixed(2);
    if (Math.abs(Number(cents) - value) < 1e-9) return `$${cents}`;
    return `$${Number(value.toFixed(4))}`;
}

export function fieldLabel(name) {
    const text = String(name).replace(/_/g, ' ');
    return text.charAt(0).toUpperCase() + text.slice(1);
}

export function defaultValues(model) {
    const values = {};
    for (const [name, spec] of Object.entries(model?.inputs || {})) {
        if (spec.default !== undefined) values[name] = spec.default;
    }
    return values;
}

export function pickDefaultModel(models, kind) {
    return (models || []).find((item) => item.kind === kind && item.enabled !== false) || null;
}

export function assetChoices(assets) {
    return (assets || [])
        .filter((asset) => ['image', 'graphic'].includes(asset?.type) && typeof asset.url === 'string' && asset.url)
        .map((asset) => ({ id: asset.id, url: asset.url, title: asset.title || asset.id }));
}

function blank(value) {
    return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
}

export function buildInput(model, values) {
    const input = {};
    for (const [name, spec] of Object.entries(model?.inputs || {})) {
        const value = values?.[name];
        switch (spec.type) {
            case 'string': {
                if (!blank(value)) input[name] = String(value).trim();
                break;
            }
            case 'url': {
                if (!blank(value)) input[name] = String(value);
                break;
            }
            case 'urlArray': {
                const list = (Array.isArray(value) ? value : []).filter((item) => !blank(item));
                if (list.length) input[name] = list;
                break;
            }
            case 'enum': {
                const match = (spec.values || []).find((candidate) => String(candidate) === String(value));
                if (match !== undefined) input[name] = match;
                break;
            }
            case 'integer': {
                if (!blank(value) && Number.isFinite(Number(value))) input[name] = Number(value);
                break;
            }
            case 'boolean': {
                if (value !== undefined) input[name] = Boolean(value);
                break;
            }
            default:
        }
    }
    return input;
}

export function validationErrors(model, values) {
    const errors = {};
    for (const [name, spec] of Object.entries(model?.inputs || {})) {
        const value = values?.[name];
        if (spec.type === 'string') {
            if (spec.required && blank(value)) errors[name] = 'Required.';
            else if (!blank(value) && String(value).trim().length > spec.max) errors[name] = `Use ${spec.max} characters or fewer.`;
        } else if (spec.type === 'url') {
            if (spec.required && blank(value)) errors[name] = 'Select an Asset from this Project.';
        } else if (spec.type === 'urlArray') {
            const list = (Array.isArray(value) ? value : []).filter((item) => !blank(item));
            if (spec.max && list.length > spec.max) errors[name] = `Select at most ${spec.max}.`;
        } else if (spec.type === 'integer' && !blank(value)) {
            const number = Number(value);
            if (!Number.isInteger(number) || number < spec.min || number > spec.max) {
                errors[name] = `Enter a whole number from ${spec.min} to ${spec.max}.`;
            }
        }
    }
    return errors;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test tests/replicateStudioForm.test.js`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/replicateStudioForm.js tests/replicateStudioForm.test.js
git commit -m "feat: add Replicate Studio form helpers" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: API client and lifecycle controller

**Files:**
- Create: `src/lib/replicateStudioClient.js`
- Test: `tests/replicateStudioClient.test.js`, `tests/replicateStudioController.test.js`

**Interfaces:**
- Consumes (Task 1): `buildInput`, `defaultValues`, `pickDefaultModel`, `validationErrors`, `formatUsd` from `./replicateStudioForm.js`.
- Produces:
  - `class ReplicateApiError extends Error` with `status, code, generationAccepted, jobId, jobRecordState, statusRecoveryAvailable, retryable, outcomeUnknown`.
  - `createReplicateApi({ fetchImpl?, base? })` returning `{ models(), quote({model,input}), generate({model,input,projectId,quoteToken}), status(id), cancel(id) }`.
  - `POLL_INTERVAL_MS = 2500`, `POLL_DEADLINE_MS = 21 * 60 * 1000`.
  - `createReplicateController({ api, kind, now?, setTimer?, clearTimer?, onJobSettled?, onAuthLost? })` returning `{ subscribe, getState, load, selectModel, setValue, setProject, generate, confirm, checkStatus, cancel, acknowledge, teardown }`.
  - `onJobSettled({ projectId, job })` is called once when a job completes with an Asset; `projectId` is the **originating** Project.
  - State (`getState()`): `{ kind, loaded, loadError, mode, configured, limits, models, modelId, values, fieldErrors, projectId, quote, overCap, phase, job, jobId, jobProjectId, cancelRequested, checkFailed, deadlineReached, notice, error, uncertain, authLost }`.
  - `phase` ∈ `idle | quoting | quoted | submitting | running | completed | failed | canceled | uncertain`.
  - `quote` = `{ estimateUsd, display, quoteToken, expiresAt, mode, maxUsdPerJob, modelId, projectId, input }`.
  - `notice` = `null | { kind: 'saving-problem' | 'expired' | 'cancel-requested' | 'info', message }`.
  - `uncertain` = `null | { jobId: string | null, message: string, acknowledged: boolean }`.

- [ ] **Step 1: Write the failing API-layer tests**

```js
// tests/replicateStudioClient.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { ReplicateApiError, createReplicateApi } from '../src/lib/replicateStudioClient.js';

function fakeFetch(handler) {
    const calls = [];
    const fetchImpl = async (url, options) => {
        calls.push({ url, options });
        return handler(url, options);
    };
    return { fetchImpl, calls };
}
const json = (status, value) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

test('requests are same-origin, uncached JSON against the Creator route', async () => {
    const { fetchImpl, calls } = fakeFetch(() => json(200, { models: [] }));
    const api = createReplicateApi({ fetchImpl });
    await api.models();
    await api.quote({ model: 'a/b', input: { prompt: 'x' } });
    assert.equal(calls[0].url, '/api/creator/replicate/models');
    assert.equal(calls[0].options.credentials, 'same-origin');
    assert.equal(calls[0].options.cache, 'no-store');
    assert.equal(calls[1].url, '/api/creator/replicate/quote');
    assert.equal(calls[1].options.method, 'POST');
    assert.deepEqual(JSON.parse(calls[1].options.body), { model: 'a/b', input: { prompt: 'x' } });
});

test('generate sends only model, input, projectId, and the quote token', async () => {
    const { fetchImpl, calls } = fakeFetch(() => json(202, { job: { jobId: 'j' } }));
    await createReplicateApi({ fetchImpl }).generate({ model: 'a/b', input: { prompt: 'x' }, projectId: 'p', quoteToken: 't' });
    assert.deepEqual(JSON.parse(calls[0].options.body), { model: 'a/b', input: { prompt: 'x' }, projectId: 'p', quoteToken: 't' });
});

test('status ids are URL-encoded and cancel posts the id', async () => {
    const { fetchImpl, calls } = fakeFetch(() => json(200, { job: {} }));
    const api = createReplicateApi({ fetchImpl });
    await api.status('a b');
    await api.cancel('job1');
    assert.equal(calls[0].url, '/api/creator/replicate/status?id=a%20b');
    assert.deepEqual(JSON.parse(calls[1].options.body), { id: 'job1' });
});

test('accepted-job failure fields survive on the thrown error', async () => {
    const { fetchImpl } = fakeFetch(() => json(404, {
        error: 'Project changed.', code: 'project_not_found', generationAccepted: true,
        jobId: 'abcdef123456', jobRecordState: 'confirmed', statusRecoveryAvailable: true, retryable: false,
    }));
    await assert.rejects(createReplicateApi({ fetchImpl }).generate({ model: 'a/b', input: {}, projectId: 'p' }), (error) => {
        assert.ok(error instanceof ReplicateApiError);
        assert.equal(error.status, 404);
        assert.equal(error.generationAccepted, true);
        assert.equal(error.jobId, 'abcdef123456');
        assert.equal(error.statusRecoveryAvailable, true);
        assert.equal(error.retryable, false);
        return true;
    });
});

test('outcomeUnknown from the server is preserved', async () => {
    const { fetchImpl } = fakeFetch(() => json(502, { error: 'Timed out.', retryable: false, outcomeUnknown: true }));
    await assert.rejects(createReplicateApi({ fetchImpl }).generate({ model: 'a/b', input: {}, projectId: 'p' }), (error) => error.outcomeUnknown === true && error.generationAccepted === false);
});

test('a network failure during generate is an unknown outcome, but not during status', async () => {
    const api = createReplicateApi({ fetchImpl: async () => { throw new TypeError('network'); } });
    await assert.rejects(api.generate({ model: 'a/b', input: {}, projectId: 'p' }), (error) => error.outcomeUnknown === true && error.status === 0);
    await assert.rejects(api.status('job1'), (error) => error.outcomeUnknown === false && error.status === 0);
});

test('non-JSON error bodies fall back to a status message', async () => {
    const { fetchImpl } = fakeFetch(() => new Response('<html>', { status: 500 }));
    await assert.rejects(createReplicateApi({ fetchImpl }).models(), /Request failed \(500\)/);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/replicateStudioClient.test.js`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement the API layer** (controller is added in Step 5; create the file with this content first)

```js
// src/lib/replicateStudioClient.js
import {
    buildInput, defaultValues, pickDefaultModel, validationErrors,
} from './replicateStudioForm.js';

const BASE = '/api/creator/replicate';
export const POLL_INTERVAL_MS = 2500;
export const POLL_DEADLINE_MS = 21 * 60 * 1000;
const TERMINAL = new Set(['completed', 'failed', 'canceled']);

export class ReplicateApiError extends Error {
    constructor(message, details = {}) {
        super(message);
        this.name = 'ReplicateApiError';
        this.status = details.status ?? 0;
        this.code = details.code;
        this.generationAccepted = details.generationAccepted === true;
        this.jobId = typeof details.jobId === 'string' ? details.jobId : null;
        this.jobRecordState = details.jobRecordState || null;
        this.statusRecoveryAvailable = details.statusRecoveryAvailable === true;
        this.retryable = details.retryable;
        this.outcomeUnknown = details.outcomeUnknown === true;
    }
}

export function createReplicateApi({ fetchImpl = (...args) => globalThis.fetch(...args), base = BASE } = {}) {
    async function call(path, { method = 'GET', body, unknownOnNetworkFailure = false } = {}) {
        let response;
        try {
            response = await fetchImpl(`${base}/${path}`, {
                method,
                credentials: 'same-origin',
                cache: 'no-store',
                headers: body === undefined ? undefined : { 'content-type': 'application/json' },
                body: body === undefined ? undefined : JSON.stringify(body),
            });
        } catch {
            throw new ReplicateApiError('The connection was lost before the server answered.', {
                status: 0, outcomeUnknown: unknownOnNetworkFailure,
            });
        }
        const value = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw new ReplicateApiError(value.error || `Request failed (${response.status}).`, { ...value, status: response.status });
        }
        return value;
    }
    return {
        models: () => call('models'),
        quote: ({ model, input }) => call('quote', { method: 'POST', body: { model, input } }),
        generate: ({ model, input, projectId, quoteToken }) => call('generate', {
            method: 'POST',
            body: { model, input, projectId, ...(quoteToken ? { quoteToken } : {}) },
            unknownOnNetworkFailure: true,
        }),
        status: (id) => call(`status?id=${encodeURIComponent(id)}`),
        cancel: (id) => call('cancel', { method: 'POST', body: { id } }),
    };
}

// CONTROLLER_PLACEHOLDER_REMOVED_IN_STEP_5
```

(Step 5 replaces the last comment line with the controller. Do not commit the comment.)

- [ ] **Step 4: Run to verify pass**

Run: `node --test tests/replicateStudioClient.test.js`
Expected: PASS (7 tests).

- [ ] **Step 5: Write the failing controller tests**

```js
// tests/replicateStudioController.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    POLL_DEADLINE_MS, ReplicateApiError, createReplicateController,
} from '../src/lib/replicateStudioClient.js';

const NOW = Date.UTC(2026, 9, 9, 12, 0, 0);
const PROJECT = '11111111-1111-4111-8111-111111111111';
const OTHER_PROJECT = '22222222-2222-4222-8222-222222222222';
const JOB_ID = 'abcdef123456';
const MODELS = [{
    id: 'vendor/fast', kind: 'image', task: 'text-to-image', label: 'Fast', enabled: true,
    pricing: { display: '~$0.003' },
    inputs: { prompt: { type: 'string', required: true, max: 100 }, aspect_ratio: { type: 'enum', values: ['1:1', '16:9'], default: '1:1' } },
}];

function job(status, extra = {}) {
    return {
        provider: 'replicate', kind: 'image', jobId: JOB_ID, status, model: 'vendor/fast', mode: 'mock', mock: true,
        error: null, estimateUsd: 0.003,
        asset: status === 'completed' ? { id: 'asset-1', url: 'https://creator.public.blob.vercel-storage.com/a.png', type: 'graphic' } : null,
        ...extra,
    };
}

function harness({ mode = 'mock', overrides = {} } = {}) {
    const calls = [];
    const timers = [];
    const settled = [];
    const counters = { authLost: 0 };
    let clock = NOW;
    const api = {
        models: async () => ({ mode, provider: { configured: true }, limits: { maxUsdPerJob: 1, maxUsdPerDay: 5 }, models: MODELS }),
        quote: async (body) => {
            calls.push(['quote', body]);
            return { estimateUsd: 0.003, display: '~$0.003', quoteToken: 'tok', expiresAt: new Date(clock + 300000).toISOString(), mode, maxUsdPerJob: 1 };
        },
        generate: async (body) => { calls.push(['generate', body]); return { job: job('completed') }; },
        status: async (id) => { calls.push(['status', id]); return { job: job('completed') }; },
        cancel: async (id) => { calls.push(['cancel', id]); return { job: job('canceled') }; },
        ...overrides,
    };
    const controller = createReplicateController({
        api, kind: 'image', now: () => clock,
        setTimer: (fn, ms) => { const timer = { fn, ms, cleared: false, fired: false }; timers.push(timer); return timer; },
        clearTimer: (timer) => { timer.cleared = true; },
        onJobSettled: (event) => settled.push(event),
        onAuthLost: () => { counters.authLost += 1; },
    });
    return {
        controller, calls, timers, settled, counters,
        advance: (ms) => { clock += ms; },
        count: (name) => calls.filter((call) => call[0] === name).length,
        pending: () => timers.filter((timer) => !timer.cleared && !timer.fired),
        async fire() { const timer = timers.find((item) => !item.cleared && !item.fired); timer.fired = true; await timer.fn(); },
        async ready() {
            await controller.load();
            controller.setProject(PROJECT);
            controller.setValue('prompt', 'a red fox');
        },
    };
}
const accepted = (extra = {}) => new ReplicateApiError('Could not save the job.', {
    status: 500, generationAccepted: true, jobId: JOB_ID, jobRecordState: 'confirmed', statusRecoveryAvailable: true, retryable: false, ...extra,
});
const queuedJob = () => ({ job: job('queued') });

test('load selects the first enabled model of the kind with defaults', async () => {
    const h = harness();
    await h.controller.load();
    const state = h.controller.getState();
    assert.equal(state.modelId, 'vendor/fast');
    assert.deepEqual(state.values, { aspect_ratio: '1:1' });
    assert.equal(state.mode, 'mock');
    assert.equal(state.configured, true);
});

test('generate needs a Project and valid settings before any request', async () => {
    const h = harness();
    await h.controller.load();
    await h.controller.generate();
    assert.match(h.controller.getState().error, /Project/);
    h.controller.setProject(PROJECT);
    await h.controller.generate();
    assert.ok(h.controller.getState().fieldErrors.prompt);
    assert.equal(h.calls.length, 0);
});

test('mock mode quotes then submits once and settles the originating Project', async () => {
    const h = harness();
    await h.ready();
    await h.controller.generate();
    assert.equal(h.count('quote'), 1);
    assert.equal(h.count('generate'), 1);
    assert.deepEqual(h.calls.find((call) => call[0] === 'generate')[1], {
        model: 'vendor/fast', input: { prompt: 'a red fox', aspect_ratio: '1:1' }, projectId: PROJECT, quoteToken: 'tok',
    });
    assert.equal(h.controller.getState().phase, 'completed');
    assert.deepEqual(h.settled.map((event) => event.projectId), [PROJECT]);
    assert.equal(h.settled[0].job.asset.id, 'asset-1');
});

test('two rapid Generate clicks send exactly one create request', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const h = harness({ overrides: { generate: async (body) => { h.calls.push(['generate', body]); await gate; return { job: job('completed') }; } } });
    await h.ready();
    const first = h.controller.generate();
    const second = h.controller.generate();
    release();
    await Promise.all([first, second]);
    assert.equal(h.count('generate'), 1);
    assert.equal(h.count('quote'), 1);
});

test('live mode only quotes on the first click and submits on explicit confirmation', async () => {
    const h = harness({ mode: 'live' });
    await h.ready();
    await h.controller.generate();
    assert.equal(h.controller.getState().phase, 'quoted');
    assert.equal(h.count('generate'), 0);
    await h.controller.confirm();
    assert.equal(h.count('generate'), 1);
    assert.equal(h.controller.getState().phase, 'completed');
});

test('two rapid Confirm clicks send exactly one create request', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const h = harness({ mode: 'live', overrides: { generate: async (body) => { h.calls.push(['generate', body]); await gate; return { job: job('completed') }; } } });
    await h.ready();
    await h.controller.generate();
    const first = h.controller.confirm();
    const second = h.controller.confirm();
    release();
    await Promise.all([first, second]);
    assert.equal(h.count('generate'), 1);
});

test('an expired live quote is not submitted and asks for a new review', async () => {
    const h = harness({ mode: 'live' });
    await h.ready();
    await h.controller.generate();
    h.advance(300001);
    await h.controller.confirm();
    const state = h.controller.getState();
    assert.equal(h.count('generate'), 0);
    assert.equal(state.phase, 'idle');
    assert.equal(state.quote, null);
    assert.equal(state.notice.kind, 'expired');
});

test('editing settings after a quote invalidates the review', async () => {
    const h = harness({ mode: 'live' });
    await h.ready();
    await h.controller.generate();
    h.controller.setValue('prompt', 'a blue fox');
    assert.equal(h.controller.getState().phase, 'idle');
    assert.equal(h.controller.getState().quote, null);
    await h.controller.confirm();
    assert.equal(h.count('generate'), 0);
});

test('changing Project or model after a quote also invalidates the review', async () => {
    const h = harness({ mode: 'live' });
    await h.ready();
    await h.controller.generate();
    h.controller.setProject(OTHER_PROJECT);
    assert.equal(h.controller.getState().phase, 'idle');
    await h.controller.generate();
    h.controller.selectModel('vendor/fast');
    assert.equal(h.controller.getState().phase, 'idle');
});

test('an estimate above the per-job cap cannot be submitted', async () => {
    const h = harness({
        mode: 'live',
        overrides: { quote: async (body) => { h.calls.push(['quote', body]); return { estimateUsd: 1.5, display: 'x', quoteToken: 'tok', expiresAt: new Date(NOW + 300000).toISOString(), mode: 'live', maxUsdPerJob: 1 }; } },
    });
    await h.ready();
    await h.controller.generate();
    assert.equal(h.controller.getState().overCap, true);
    await h.controller.confirm();
    assert.equal(h.count('generate'), 0);
});

test('a queued job is polled by its id until it completes', async () => {
    let statusCalls = 0;
    const h = harness({
        overrides: {
            generate: async (body) => { h.calls.push(['generate', body]); return queuedJob(); },
            status: async (id) => { h.calls.push(['status', id]); statusCalls += 1; return { job: job(statusCalls < 2 ? 'processing' : 'completed') }; },
        },
    });
    await h.ready();
    await h.controller.generate();
    assert.equal(h.controller.getState().phase, 'running');
    assert.equal(h.pending().length, 1);
    await h.fire();
    assert.equal(h.controller.getState().phase, 'running');
    await h.fire();
    assert.equal(h.controller.getState().phase, 'completed');
    assert.deepEqual(h.calls.filter((call) => call[0] === 'status').map((call) => call[1]), [JOB_ID, JOB_ID]);
    assert.equal(h.count('generate'), 1);
    assert.equal(h.settled.length, 1);
});

test('an accepted job with an HTTP 404 and a recoverable id is adopted and polled, never re-posted', async () => {
    const h = harness({
        overrides: {
            generate: async (body) => { h.calls.push(['generate', body]); throw accepted({ status: 404 }); },
            status: async (id) => { h.calls.push(['status', id]); return { job: job('completed') }; },
        },
    });
    await h.ready();
    await h.controller.generate();
    let state = h.controller.getState();
    assert.equal(state.phase, 'running');
    assert.equal(state.jobId, JOB_ID);
    assert.equal(state.notice.kind, 'saving-problem');
    await h.fire();
    state = h.controller.getState();
    assert.equal(state.phase, 'completed');
    assert.equal(h.count('generate'), 1);
});

test('an accepted job without recoverable status is uncertain and blocks Generate until acknowledged', async () => {
    const h = harness({
        overrides: {
            generate: async (body) => { h.calls.push(['generate', body]); throw accepted({ statusRecoveryAvailable: false, jobRecordState: 'unconfirmed' }); },
            status: async (id) => { h.calls.push(['status', id]); throw new ReplicateApiError('Generation job not found.', { status: 404 }); },
        },
    });
    await h.ready();
    await h.controller.generate();
    let state = h.controller.getState();
    assert.equal(state.phase, 'uncertain');
    assert.equal(state.uncertain.jobId, JOB_ID);
    assert.equal(state.uncertain.acknowledged, false);
    assert.equal(h.pending().length, 0);

    await h.controller.generate();
    assert.equal(h.count('quote'), 1, 'no new quote or create while uncertain');
    assert.equal(h.count('generate'), 1);

    await h.controller.checkStatus();
    state = h.controller.getState();
    assert.equal(state.phase, 'uncertain');
    assert.match(state.uncertain.message, /not recorded/i);

    h.controller.acknowledge();
    state = h.controller.getState();
    assert.equal(state.phase, 'idle');
    assert.equal(state.uncertain.acknowledged, true);
});

test('an unknown outcome with no job id offers no status check and no resubmission', async () => {
    const h = harness({
        overrides: { generate: async (body) => { h.calls.push(['generate', body]); throw new ReplicateApiError('Timed out.', { status: 502, outcomeUnknown: true, retryable: false }); } },
    });
    await h.ready();
    await h.controller.generate();
    const state = h.controller.getState();
    assert.equal(state.phase, 'uncertain');
    assert.equal(state.uncertain.jobId, null);
    await h.controller.checkStatus();
    assert.equal(h.count('status'), 0);
    await h.controller.generate();
    assert.equal(h.count('generate'), 1);
});

test('a network failure during create is an unknown outcome, not a failure', async () => {
    const h = harness({
        overrides: { generate: async (body) => { h.calls.push(['generate', body]); throw new ReplicateApiError('lost', { status: 0, outcomeUnknown: true }); } },
    });
    await h.ready();
    await h.controller.generate();
    assert.equal(h.controller.getState().phase, 'uncertain');
});

test('a definite rejection returns to idle with the message and no uncertainty', async () => {
    const h = harness({
        overrides: { generate: async (body) => { h.calls.push(['generate', body]); throw new ReplicateApiError('An identical request is already in progress.', { status: 409 }); } },
    });
    await h.ready();
    await h.controller.generate();
    const state = h.controller.getState();
    assert.equal(state.phase, 'idle');
    assert.match(state.error, /identical request/);
    assert.equal(state.uncertain, null);
});

test('a status read failure stops polling and offers a check of the same job without another create', async () => {
    let fail = true;
    const h = harness({
        overrides: {
            generate: async (body) => { h.calls.push(['generate', body]); return queuedJob(); },
            status: async (id) => {
                h.calls.push(['status', id]);
                if (fail) throw new ReplicateApiError('Server error.', { status: 500 });
                return { job: job('completed') };
            },
        },
    });
    await h.ready();
    await h.controller.generate();
    await h.fire();
    let state = h.controller.getState();
    assert.equal(state.phase, 'running');
    assert.equal(state.checkFailed, true);
    assert.equal(h.pending().length, 0);
    fail = false;
    await h.controller.checkStatus();
    state = h.controller.getState();
    assert.equal(state.phase, 'completed');
    assert.equal(h.count('generate'), 1);
});

test('reaching the polling deadline keeps the job running and offers a manual check', async () => {
    const h = harness({
        overrides: {
            generate: async (body) => { h.calls.push(['generate', body]); return queuedJob(); },
            status: async (id) => { h.calls.push(['status', id]); return { job: job('processing') }; },
        },
    });
    await h.ready();
    await h.controller.generate();
    h.advance(POLL_DEADLINE_MS);
    await h.fire();
    const state = h.controller.getState();
    assert.equal(state.phase, 'running');
    assert.equal(state.deadlineReached, true);
    assert.equal(h.pending().length, 0);
});

test('cancel shows a confirmed cancellation, or "requested" while still pending', async () => {
    const h = harness({
        overrides: { generate: async (body) => { h.calls.push(['generate', body]); return queuedJob(); } },
    });
    await h.ready();
    await h.controller.generate();
    await h.controller.cancel();
    assert.equal(h.controller.getState().phase, 'canceled');
    assert.equal(h.settled.length, 0);

    const pending = harness({
        overrides: {
            generate: async (body) => { pending.calls.push(['generate', body]); return queuedJob(); },
            cancel: async (id) => { pending.calls.push(['cancel', id]); return { job: job('processing') }; },
        },
    });
    await pending.ready();
    await pending.controller.generate();
    await pending.controller.cancel();
    const state = pending.controller.getState();
    assert.equal(state.phase, 'running');
    assert.equal(state.cancelRequested, true);
    assert.equal(state.notice.kind, 'cancel-requested');
    assert.equal(pending.pending().length, 1, 'polling continues until a confirmed state');
});

test('switching Project while a job runs settles the originating Project only', async () => {
    const h = harness({
        overrides: { generate: async (body) => { h.calls.push(['generate', body]); return queuedJob(); } },
    });
    await h.ready();
    await h.controller.generate();
    h.controller.setProject(OTHER_PROJECT);
    assert.equal(h.controller.getState().phase, 'running');
    await h.fire();
    assert.deepEqual(h.settled.map((event) => event.projectId), [PROJECT]);
    assert.equal(h.controller.getState().projectId, OTHER_PROJECT);
});

test('teardown clears the timer and ignores a late response', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const h = harness({
        overrides: {
            generate: async (body) => { h.calls.push(['generate', body]); return queuedJob(); },
            status: async () => { await gate; return { job: job('completed') }; },
        },
    });
    await h.ready();
    await h.controller.generate();
    const timer = h.timers[0];
    const inFlight = h.fire();
    h.controller.teardown();
    release();
    await inFlight;
    assert.equal(h.settled.length, 0);
    assert.equal(h.controller.getState().phase, 'running');
    h.controller.teardown();
    assert.equal(timer.fired, true);
});

test('teardown cancels a scheduled poll', async () => {
    const h = harness({
        overrides: { generate: async (body) => { h.calls.push(['generate', body]); return queuedJob(); } },
    });
    await h.ready();
    await h.controller.generate();
    assert.equal(h.pending().length, 1);
    h.controller.teardown();
    assert.equal(h.pending().length, 0);
});

test('a 401 mid-poll clears owner-specific state and stops polling', async () => {
    const h = harness({
        overrides: {
            generate: async (body) => { h.calls.push(['generate', body]); return queuedJob(); },
            status: async () => { throw new ReplicateApiError('Sign in required.', { status: 401 }); },
        },
    });
    await h.ready();
    await h.controller.generate();
    await h.fire();
    const state = h.controller.getState();
    assert.equal(state.authLost, true);
    assert.equal(state.job, null);
    assert.equal(state.jobId, '');
    assert.equal(state.phase, 'idle');
    assert.equal(h.pending().length, 0);
    assert.equal(h.counters.authLost, 1);
});

test('starting a new generation clears the previous result and uncertainty', async () => {
    const h = harness();
    await h.ready();
    await h.controller.generate();
    assert.equal(h.controller.getState().job.jobId, JOB_ID);
    h.controller.setValue('prompt', 'another fox');
    await h.controller.generate();
    assert.equal(h.count('generate'), 2);
});
```

- [ ] **Step 6: Run to verify failure**

Run: `node --test tests/replicateStudioController.test.js`
Expected: FAIL (`createReplicateController is not a function` / not exported).

- [ ] **Step 7: Implement the controller** (replace the `CONTROLLER_PLACEHOLDER_REMOVED_IN_STEP_5` comment line at the end of `src/lib/replicateStudioClient.js` with exactly this)

```js
const LOCKED = new Set(['quoting', 'submitting', 'running', 'uncertain']);
const UNKNOWN_MESSAGE = 'The server did not confirm whether a generation was started. It may have been, and may be billed. Operator review is needed before generating this request again.';

function initialState(kind) {
    return {
        kind, loaded: false, loadError: '', mode: null, configured: false,
        limits: { maxUsdPerJob: null, maxUsdPerDay: null },
        models: [], modelId: '', values: {}, fieldErrors: {}, projectId: '',
        quote: null, overCap: false, phase: 'idle',
        job: null, jobId: '', jobProjectId: '',
        cancelRequested: false, checkFailed: false, deadlineReached: false,
        notice: null, error: '', uncertain: null, authLost: false,
    };
}

const isAuthError = (error) => error?.status === 401;

export function createReplicateController({
    api,
    kind,
    now = () => Date.now(),
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (id) => clearTimeout(id),
    onJobSettled = () => {},
    onAuthLost = () => {},
}) {
    let state = initialState(kind);
    const listeners = new Set();
    let epoch = 0;
    let inFlight = false;
    let cancelling = false;
    let timer = null;
    let pollStartedAt = 0;

    const set = (patch) => {
        state = { ...state, ...patch };
        listeners.forEach((listener) => listener());
    };
    const locked = () => LOCKED.has(state.phase);
    const currentModel = () => state.models.find((item) => item.id === state.modelId) || null;

    function stopPolling() {
        if (timer) clearTimer(timer);
        timer = null;
    }

    function invalidate() {
        if (state.phase === 'quoted' || state.phase === 'quoting') {
            set({ phase: 'idle', quote: null, overCap: false });
        }
    }

    function authLost() {
        epoch += 1;
        stopPolling();
        set({
            ...initialState(kind),
            loaded: state.loaded, mode: state.mode, configured: state.configured, limits: state.limits,
            models: state.models, modelId: state.modelId, values: state.values, projectId: state.projectId,
            authLost: true,
        });
        onAuthLost();
    }

    function enterUncertain({ jobId, message }) {
        stopPolling();
        set({
            phase: 'uncertain', jobId: jobId || '', quote: null, overCap: false,
            uncertain: { jobId: jobId || null, message, acknowledged: false },
        });
    }

    function schedule(jobId) {
        stopPolling();
        const myEpoch = epoch;
        timer = setTimer(() => { pollOnce(jobId, myEpoch); }, POLL_INTERVAL_MS);
    }

    function startPolling(jobId) {
        pollStartedAt = now();
        set({ checkFailed: false, deadlineReached: false });
        schedule(jobId);
    }

    function applyJob(job, { polled = false } = {}) {
        if (!TERMINAL.has(job.status)) {
            set({ job, jobId: job.jobId, phase: 'running', checkFailed: false, uncertain: null });
            if (!polled) startPolling(job.jobId);
            else if (now() - pollStartedAt >= POLL_DEADLINE_MS) set({ deadlineReached: true });
            else schedule(job.jobId);
            return;
        }
        stopPolling();
        const phase = job.status === 'completed' ? 'completed' : job.status === 'canceled' ? 'canceled' : 'failed';
        const missingAsset = phase === 'completed' && !job.asset;
        set({
            job, jobId: job.jobId, phase, quote: null, overCap: false, uncertain: null,
            cancelRequested: false, checkFailed: false, deadlineReached: false,
            notice: missingAsset ? { kind: 'info', message: 'The generation finished but no saved Asset was returned.' } : null,
            error: phase === 'failed' ? (job.error || 'Generation failed.') : '',
        });
        if (phase === 'completed' && job.asset) onJobSettled({ projectId: state.jobProjectId, job });
    }

    async function pollOnce(jobId, myEpoch) {
        timer = null;
        if (myEpoch !== epoch) return;
        try {
            const value = await api.status(jobId);
            if (myEpoch !== epoch) return;
            applyJob(value.job, { polled: true });
        } catch (error) {
            if (myEpoch !== epoch) return;
            if (isAuthError(error)) { authLost(); return; }
            stopPolling();
            set({ checkFailed: true, error: error.message });
        }
    }

    async function load() {
        const myEpoch = epoch;
        try {
            const value = await api.models();
            if (myEpoch !== epoch) return;
            const models = (value.models || []).filter((item) => item.kind === kind && item.enabled !== false);
            const keep = models.find((item) => item.id === state.modelId);
            const chosen = keep || pickDefaultModel(models, kind);
            set({
                loaded: true, loadError: '', mode: value.mode || null,
                configured: value.provider?.configured === true,
                limits: value.limits || state.limits, models,
                modelId: chosen?.id || '', values: keep ? state.values : (chosen ? defaultValues(chosen) : {}),
            });
        } catch (error) {
            if (myEpoch !== epoch) return;
            if (isAuthError(error)) { authLost(); return; }
            set({ loaded: true, loadError: error.message });
        }
    }

    function selectModel(id) {
        if (locked()) return;
        const model = state.models.find((item) => item.id === id);
        if (!model) return;
        set({ modelId: id, values: defaultValues(model), fieldErrors: {}, error: '' });
        invalidate();
    }

    function setValue(name, value) {
        if (locked()) return;
        set({ values: { ...state.values, [name]: value }, fieldErrors: { ...state.fieldErrors, [name]: undefined }, error: '' });
        invalidate();
    }

    function setProject(projectId) {
        if (projectId === state.projectId) return;
        set({ projectId });
        invalidate();
    }

    async function doReview() {
        const model = currentModel();
        if (!model) return false;
        if (!state.projectId) { set({ error: 'Open a Project before generating.' }); return false; }
        if (!state.configured) { set({ error: 'Replicate is not configured on this server.' }); return false; }
        const problems = validationErrors(model, state.values);
        if (Object.keys(problems).length) {
            set({ fieldErrors: problems, error: 'Fix the highlighted settings before generating.' });
            return false;
        }
        const myEpoch = epoch;
        const input = buildInput(model, state.values);
        const projectId = state.projectId;
        set({
            phase: 'quoting', error: '', fieldErrors: {}, notice: null, uncertain: null,
            job: null, jobId: '', cancelRequested: false, checkFailed: false, deadlineReached: false,
        });
        try {
            const value = await api.quote({ model: model.id, input });
            if (myEpoch !== epoch || state.phase !== 'quoting' || state.projectId !== projectId) return false;
            const cap = Number(value.maxUsdPerJob);
            const overCap = Number.isFinite(cap) && value.estimateUsd > cap;
            set({
                phase: 'quoted', overCap,
                quote: {
                    estimateUsd: value.estimateUsd, display: value.display, quoteToken: value.quoteToken,
                    expiresAt: value.expiresAt, mode: value.mode, maxUsdPerJob: value.maxUsdPerJob,
                    modelId: model.id, projectId, input,
                },
            });
            return !overCap;
        } catch (error) {
            if (myEpoch !== epoch) return false;
            if (isAuthError(error)) { authLost(); return false; }
            set({ phase: 'idle', error: error.message });
            return false;
        }
    }

    async function doSubmit() {
        const { quote } = state;
        if (state.phase !== 'quoted' || !quote || state.overCap) return;
        if (state.mode === 'live' && now() >= Date.parse(quote.expiresAt)) {
            set({
                phase: 'idle', quote: null, overCap: false,
                notice: { kind: 'expired', message: 'The price quote expired. Review the price again.' },
            });
            return;
        }
        const myEpoch = epoch;
        set({ phase: 'submitting', error: '', notice: null, jobProjectId: quote.projectId });
        try {
            const value = await api.generate({
                model: quote.modelId, input: quote.input, projectId: quote.projectId, quoteToken: quote.quoteToken,
            });
            if (myEpoch !== epoch) return;
            if (!value?.job?.jobId) { enterUncertain({ jobId: null, message: UNKNOWN_MESSAGE }); return; }
            applyJob(value.job);
        } catch (error) {
            if (myEpoch !== epoch) return;
            if (isAuthError(error) && !error.generationAccepted) { authLost(); return; }
            if (error.generationAccepted && error.jobId) {
                if (error.statusRecoveryAvailable) {
                    set({
                        phase: 'running', jobId: error.jobId,
                        notice: { kind: 'saving-problem', message: 'The generation started, but saving its record had a problem. Checking the same job; it will not be submitted again.' },
                    });
                    startPolling(error.jobId);
                } else {
                    enterUncertain({
                        jobId: error.jobId,
                        message: `The generation was accepted (job ${error.jobId}) but its record could not be confirmed, so progress cannot be tracked. It may be billed. Operator review is needed before generating this request again.`,
                    });
                }
            } else if (error.outcomeUnknown) {
                enterUncertain({ jobId: null, message: UNKNOWN_MESSAGE });
            } else {
                set({ phase: 'idle', quote: null, overCap: false, error: error.message });
            }
        }
    }

    // Synchronous in-flight guard: set before the first await so two rapid clicks cannot both pass.
    async function generate() {
        if (inFlight || locked()) return;
        inFlight = true;
        try {
            if (state.phase === 'quoted') return;
            const reviewed = await doReview();
            if (reviewed && state.mode !== 'live') await doSubmit();
        } finally {
            inFlight = false;
        }
    }

    async function confirm() {
        if (inFlight || state.phase !== 'quoted') return;
        inFlight = true;
        try {
            await doSubmit();
        } finally {
            inFlight = false;
        }
    }

    async function checkStatus() {
        const jobId = state.phase === 'uncertain' ? state.uncertain?.jobId : state.jobId;
        if (!jobId || inFlight) return;
        inFlight = true;
        const myEpoch = epoch;
        try {
            const value = await api.status(jobId);
            if (myEpoch !== epoch) return;
            applyJob(value.job);
        } catch (error) {
            if (myEpoch !== epoch) return;
            if (isAuthError(error)) { authLost(); return; }
            if (state.phase === 'uncertain') {
                const message = error.status === 404
                    ? `Job ${jobId} is not recorded on the server. That does not prove nothing was generated; it may still have been billed. Operator review is needed before generating this request again.`
                    : error.message;
                set({ uncertain: { ...state.uncertain, message } });
            } else {
                set({ checkFailed: true, error: error.message });
            }
        } finally {
            inFlight = false;
        }
    }

    async function cancel() {
        if (state.phase !== 'running' || !state.jobId || cancelling) return;
        cancelling = true;
        const myEpoch = epoch;
        try {
            const value = await api.cancel(state.jobId);
            if (myEpoch !== epoch) return;
            set({ cancelRequested: true });
            applyJob(value.job, { polled: true });
            if (state.phase === 'running') {
                set({ notice: { kind: 'cancel-requested', message: 'Cancel requested. Waiting for the provider to confirm.' } });
            }
        } catch (error) {
            if (myEpoch !== epoch) return;
            if (isAuthError(error)) { authLost(); return; }
            set({ error: error.message });
        } finally {
            cancelling = false;
        }
    }

    function acknowledge() {
        if (state.phase !== 'uncertain') return;
        set({ phase: 'idle', uncertain: { ...state.uncertain, acknowledged: true } });
    }

    function teardown() {
        epoch += 1;
        stopPolling();
        listeners.clear();
    }

    return {
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
        getState: () => state,
        load, selectModel, setValue, setProject, generate, confirm, checkStatus, cancel, acknowledge, teardown,
    };
}
```

- [ ] **Step 8: Run to verify pass**

Run: `node --test tests/replicateStudioClient.test.js tests/replicateStudioController.test.js`
Expected: PASS (all). If a controller test fails, fix the controller, not the test, unless the test contradicts the spec.

- [ ] **Step 9: Commit**

```bash
git add src/lib/replicateStudioClient.js tests/replicateStudioClient.test.js tests/replicateStudioController.test.js
git commit -m "feat: add Replicate Studio API client and lifecycle controller" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: View model

**Files:**
- Create: `src/lib/replicateStudioView.js`
- Test: `tests/replicateStudioView.test.js`

**Interfaces:**
- Consumes (Task 2): controller `state` shape; (Task 1) `formatUsd`.
- Produces: `deriveView(state)` returning
  `{ locked, badge: { tone, text }, disabledReason, primary: { action: 'generate'|'confirm', label, enabled }, price: { text, expiresAt } | null, overCapMessage, showCancel, showCheckStatus, showAcknowledge, providerSwitchDisabled, banners: Array<{ tone: 'error'|'warn'|'info'|'ok', text }>, progressText, result: null | { kind: 'image'|'video', url, assetId, mockPlaceholder, alt } }`.

- [ ] **Step 1: Write the failing tests**

```js
// tests/replicateStudioView.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveView } from '../src/lib/replicateStudioView.js';

const base = {
    kind: 'image', loaded: true, loadError: '', mode: 'mock', configured: true,
    limits: { maxUsdPerJob: 1 }, models: [{ id: 'm' }], modelId: 'm', values: {}, fieldErrors: {},
    projectId: 'p', quote: null, overCap: false, phase: 'idle', job: null, jobId: '', jobProjectId: '',
    cancelRequested: false, checkFailed: false, deadlineReached: false, notice: null, error: '', uncertain: null, authLost: false,
};
const state = (patch) => ({ ...base, ...patch });

test('mock mode shows a no-charge badge and a one-click Generate', () => {
    const view = deriveView(state({}));
    assert.match(view.badge.text, /Mock/);
    assert.equal(view.primary.action, 'generate');
    assert.match(view.primary.label, /no charge/i);
    assert.equal(view.primary.enabled, true);
});

test('live mode asks for price review, then an explicit confirmation showing the price', () => {
    assert.equal(deriveView(state({ mode: 'live' })).primary.label, 'Review price');
    const quoted = deriveView(state({
        mode: 'live', phase: 'quoted',
        quote: { estimateUsd: 0.003, display: '~$0.003 per image (estimate)', expiresAt: '2026-10-09T12:05:00.000Z' },
    }));
    assert.equal(quoted.primary.action, 'confirm');
    assert.match(quoted.primary.label, /\$0\.003/);
    assert.equal(quoted.price.expiresAt, '2026-10-09T12:05:00.000Z');
});

test('Generate is disabled without a Project, models, or configuration, with a reason', () => {
    assert.equal(deriveView(state({ projectId: '' })).primary.enabled, false);
    assert.match(deriveView(state({ projectId: '' })).disabledReason, /Project/);
    assert.match(deriveView(state({ configured: false })).disabledReason, /not configured/i);
    assert.equal(deriveView(state({ modelId: '', models: [] })).primary.enabled, false);
});

test('an estimate above the cap cannot be confirmed and suggests changes', () => {
    const view = deriveView(state({
        mode: 'live', phase: 'quoted', overCap: true,
        quote: { estimateUsd: 1.5, display: 'x', expiresAt: 'z', maxUsdPerJob: 1 },
    }));
    assert.equal(view.primary.enabled, false);
    assert.match(view.overCapMessage, /\$1\.00/);
});

test('uncertain state blocks Generate and shows acknowledge, plus check status only with a job id', () => {
    const withId = deriveView(state({ phase: 'uncertain', jobId: 'job1', uncertain: { jobId: 'job1', message: 'm', acknowledged: false } }));
    assert.equal(withId.primary.enabled, false);
    assert.equal(withId.showAcknowledge, true);
    assert.equal(withId.showCheckStatus, true);
    const noId = deriveView(state({ phase: 'uncertain', uncertain: { jobId: null, message: 'm', acknowledged: false } }));
    assert.equal(noId.showCheckStatus, false);
    assert.equal(noId.showAcknowledge, true);
    assert.ok(noId.banners.some((banner) => banner.tone === 'warn' && banner.text === 'm'));
});

test('an acknowledged uncertainty stays visible but Generate is available again', () => {
    const view = deriveView(state({ phase: 'idle', uncertain: { jobId: null, message: 'm', acknowledged: true } }));
    assert.equal(view.primary.enabled, true);
    assert.equal(view.showAcknowledge, false);
    assert.ok(view.banners.some((banner) => banner.text === 'm'));
});

test('running shows Cancel, locks provider switching, and shows Check status after a failed poll or deadline', () => {
    const running = deriveView(state({ phase: 'running', jobId: 'job1', job: { status: 'processing' } }));
    assert.equal(running.showCancel, true);
    assert.equal(running.providerSwitchDisabled, true);
    assert.equal(running.showCheckStatus, false);
    assert.equal(deriveView(state({ phase: 'running', jobId: 'job1', checkFailed: true })).showCheckStatus, true);
    assert.equal(deriveView(state({ phase: 'running', jobId: 'job1', deadlineReached: true })).showCheckStatus, true);
});

test('cancel is reported as requested until a confirmed canceled state', () => {
    const requested = deriveView(state({ phase: 'running', jobId: 'job1', cancelRequested: true, notice: { kind: 'cancel-requested', message: 'Cancel requested.' } }));
    assert.ok(requested.banners.some((banner) => /Cancel requested/.test(banner.text)));
    const canceled = deriveView(state({ phase: 'canceled', job: { status: 'canceled' } }));
    assert.ok(canceled.banners.some((banner) => /Canceled/.test(banner.text)));
});

test('a completed mock image is an image with a mock-placeholder label', () => {
    const view = deriveView(state({ phase: 'completed', job: { status: 'completed', mock: true, asset: { id: 'a', url: 'https://x/a.png', type: 'graphic' } } }));
    assert.deepEqual({ kind: view.result.kind, mock: view.result.mockPlaceholder, id: view.result.assetId }, { kind: 'image', mock: true, id: 'a' });
});

test('a mock VIDEO job is previewed as an image placeholder, never as playable video', () => {
    const view = deriveView(state({ kind: 'video', phase: 'completed', job: { status: 'completed', mock: true, asset: { id: 'a', url: 'https://x/a.png', type: 'graphic' } } }));
    assert.equal(view.result.kind, 'image');
    assert.equal(view.result.mockPlaceholder, true);
});

test('a live video Asset is playable video', () => {
    const view = deriveView(state({ kind: 'video', mode: 'live', phase: 'completed', job: { status: 'completed', mock: false, asset: { id: 'a', url: 'https://x/a.mp4', type: 'video' } } }));
    assert.equal(view.result.kind, 'video');
    assert.equal(view.result.mockPlaceholder, false);
});

test('saving-problem and auth-loss are reported', () => {
    const saving = deriveView(state({ phase: 'running', jobId: 'j', notice: { kind: 'saving-problem', message: 'saving' } }));
    assert.ok(saving.banners.some((banner) => banner.tone === 'warn' && banner.text === 'saving'));
    const auth = deriveView(state({ authLost: true }));
    assert.ok(auth.banners.some((banner) => /sign in/i.test(banner.text)));
});

test('failed jobs show the server message; no Retry control exists in the view', () => {
    const view = deriveView(state({ phase: 'failed', error: 'Model rejected the prompt.', job: { status: 'failed' } }));
    assert.ok(view.banners.some((banner) => banner.tone === 'error' && /rejected/.test(banner.text)));
    assert.equal(Object.hasOwn(view, 'showRetry'), false);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/replicateStudioView.test.js`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```js
// src/lib/replicateStudioView.js
import { formatUsd } from './replicateStudioForm.js';

const LOCKED = new Set(['quoting', 'submitting', 'running', 'uncertain']);
const PROGRESS = { queued: 'Queued…', processing: 'Generating…', running: 'Generating…' };

export function deriveView(state) {
    const locked = LOCKED.has(state.phase);
    const live = state.mode === 'live';
    const unacknowledged = state.phase === 'uncertain';

    const badge = state.mode === 'live'
        ? { tone: 'live', text: 'Live · paid generation' }
        : state.mode === 'mock'
            ? { tone: 'mock', text: 'Mock · no paid generation' }
            : { tone: 'setup', text: 'Setup required' };

    let disabledReason = '';
    if (!state.loaded) disabledReason = 'Loading models…';
    else if (state.loadError) disabledReason = state.loadError;
    else if (!state.configured) disabledReason = 'Replicate is not configured on this server.';
    else if (!state.modelId) disabledReason = 'No models are available for this workspace.';
    else if (!state.projectId) disabledReason = 'Open a Project to generate.';
    else if (unacknowledged) disabledReason = 'Acknowledge the uncertain request before generating again.';
    const ready = disabledReason === '';

    const quoted = state.phase === 'quoted' && state.quote;
    const overCapMessage = quoted && state.overCap
        ? `This estimate (${formatUsd(state.quote.estimateUsd)}) is above the per-generation limit of ${formatUsd(Number(state.quote.maxUsdPerJob))}. Choose a different model or shorter/smaller settings.`
        : '';

    let primary;
    if (state.phase === 'quoting' || state.phase === 'submitting') {
        primary = { action: 'generate', label: 'Working…', enabled: false };
    } else if (quoted && live) {
        primary = { action: 'confirm', label: `Confirm and generate · ${formatUsd(state.quote.estimateUsd)}`, enabled: ready && !state.overCap };
    } else if (live) {
        primary = { action: 'generate', label: 'Review price', enabled: ready && !locked };
    } else {
        primary = { action: 'generate', label: 'Generate (mock — no charge)', enabled: ready && !locked && !(quoted && state.overCap) };
    }

    const price = quoted
        ? { text: `${formatUsd(state.quote.estimateUsd)} · ${state.quote.display}`, expiresAt: state.quote.expiresAt }
        : null;

    const banners = [];
    if (state.authLost) banners.push({ tone: 'warn', text: 'Your session ended. Sign in again to continue; nothing was carried over.' });
    if (state.error && state.phase !== 'failed') banners.push({ tone: 'error', text: state.error });
    if (state.phase === 'failed') banners.push({ tone: 'error', text: state.error || 'Generation failed.' });
    if (state.phase === 'canceled') banners.push({ tone: 'info', text: 'Canceled. The provider confirmed the cancellation.' });
    if (state.notice) {
        const tone = state.notice.kind === 'info' ? 'info' : 'warn';
        banners.push({ tone, text: state.notice.message });
    }
    if (state.uncertain) banners.push({ tone: 'warn', text: state.uncertain.message });
    if (overCapMessage) banners.push({ tone: 'warn', text: overCapMessage });

    let result = null;
    const asset = state.job?.asset;
    if (state.phase === 'completed' && asset) {
        const mockPlaceholder = state.job.mock === true;
        result = {
            kind: asset.type === 'video' && !mockPlaceholder ? 'video' : 'image',
            url: asset.url,
            assetId: asset.id,
            mockPlaceholder,
            alt: mockPlaceholder ? `Mock placeholder for a ${state.kind}` : `Generated ${state.kind}`,
        };
    }

    return {
        locked,
        badge,
        disabledReason,
        primary,
        price,
        overCapMessage,
        showCancel: state.phase === 'running' && Boolean(state.jobId),
        showCheckStatus: (state.phase === 'running' && (state.checkFailed || state.deadlineReached))
            || (state.phase === 'uncertain' && Boolean(state.uncertain?.jobId)),
        showAcknowledge: unacknowledged,
        providerSwitchDisabled: locked,
        banners,
        progressText: state.phase === 'running' ? (PROGRESS[state.job?.status] || 'Working…') : '',
        result,
    };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test tests/replicateStudioView.test.js`
Expected: PASS (13 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/replicateStudioView.js tests/replicateStudioView.test.js
git commit -m "feat: add Replicate Studio view model" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Replicate component and provider wrapper

**Files:**
- Create: `components/ReplicateStudio.js`, `components/CreatorMediaStudio.js`
- Test: `tests/replicateStudioWiring.test.js` (component assertions only in this task)

**Interfaces:**
- Consumes: Task 1–3 exports.
- Produces:
  - `ReplicateStudio({ kind: 'image'|'video', project, assets, onJobSettled, onAuthLost, onBusyChange })` (default export).
  - `CreatorMediaStudio({ kind, workspaceLabel, project, assets, onJobSettled, onAuthLost, muapiWorkspace })` (default export). `muapiWorkspace` is a React element rendered only when MuAPI is selected.

- [ ] **Step 1: Write the failing source-level tests** (house style: read source, assert structure and the absence of secrets)

```js
// tests/replicateStudioWiring.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

const BROWSER_FILES = [
    '../components/ReplicateStudio.js',
    '../components/CreatorMediaStudio.js',
    '../src/lib/replicateStudioClient.js',
    '../src/lib/replicateStudioForm.js',
    '../src/lib/replicateStudioView.js',
];

test('browser Replicate files never touch server code, environment, tokens, or non-Asset output URLs', async () => {
    for (const file of BROWSER_FILES) {
        const source = await read(file);
        assert.doesNotMatch(source, /process\.env/, file);
        assert.doesNotMatch(source, /REPLICATE_API_TOKEN|BLOB_READ_WRITE_TOKEN|CREATOR_SESSION_SECRET/, file);
        assert.doesNotMatch(source, /replicateGateway|replicateProvider|replicatePersist|replicateModelRegistry|generationGuard/, file);
        assert.doesNotMatch(source, /outputUrl/, file);
    }
});

test('ReplicateStudio renders controller state, one Generate path, and no Retry-generation control', async () => {
    const source = await read('../components/ReplicateStudio.js');
    assert.match(source, /createReplicateController/);
    assert.match(source, /useSyncExternalStore/);
    assert.match(source, /deriveView/);
    assert.match(source, /controller\.teardown\(\)/);
    assert.match(source, /aria-live="polite"/);
    assert.match(source, /role="alert"/);
    assert.doesNotMatch(source, /Retry/);
    assert.match(source, /Saved to Project/);
    assert.match(source, /Mock placeholder/);
});

test('CreatorMediaStudio keeps Replicate default and MuAPI behind an explicit selector', async () => {
    const source = await read('../components/CreatorMediaStudio.js');
    assert.match(source, /useState\('replicate'\)/);
    assert.match(source, /muapiWorkspace/);
    assert.match(source, /role="radiogroup"/);
    assert.match(source, /providerSwitchDisabled|busy/);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/replicateStudioWiring.test.js`
Expected: FAIL (ENOENT for the components).

- [ ] **Step 3: Implement `components/ReplicateStudio.js`**

```jsx
'use client';

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { AlertTriangle, CheckCircle2, Download, Loader2 } from 'lucide-react';
import { createReplicateApi, createReplicateController } from '@/src/lib/replicateStudioClient.js';
import { assetChoices, fieldLabel } from '@/src/lib/replicateStudioForm.js';
import { deriveView } from '@/src/lib/replicateStudioView.js';

const BADGE_CLASS = {
  mock: 'border-emerald-300/25 bg-emerald-300/[0.08] text-emerald-100',
  live: 'border-amber-300/30 bg-amber-300/[0.1] text-amber-100',
  setup: 'border-red-300/25 bg-red-300/[0.08] text-red-100',
};
const BANNER_CLASS = {
  error: 'border-red-300/25 bg-red-300/[0.07] text-red-100',
  warn: 'border-amber-300/25 bg-amber-300/[0.07] text-amber-100',
  info: 'border-white/15 bg-white/[0.04] text-white/70',
  ok: 'border-emerald-300/25 bg-emerald-300/[0.07] text-emerald-100',
};
const inputClass = 'w-full rounded-xl border border-white/[0.1] bg-black/30 px-3 py-2.5 text-sm text-white outline-none focus:border-cyan-300/40 disabled:opacity-40';

function Field({ name, spec, value, error, disabled, choices, onChange }) {
  const id = `replicate-${name}`;
  const label = <label htmlFor={id} className="mb-1.5 block text-[11px] font-bold uppercase tracking-wider text-white/45">{fieldLabel(name)}{spec.required ? ' *' : ''}</label>;
  const message = error ? <p id={`${id}-error`} className="mt-1 text-xs text-red-200">{error}</p> : null;
  const describedBy = error ? `${id}-error` : undefined;

  if (spec.type === 'string') {
    return (
      <div>{label}
        <textarea id={id} rows={4} maxLength={spec.max} value={value ?? ''} disabled={disabled} aria-invalid={Boolean(error)} aria-describedby={describedBy}
          onChange={(event) => onChange(event.target.value)} className={`${inputClass} resize-y`} />
        <p className="mt-1 text-right text-[10px] text-white/25">{(value ?? '').length}/{spec.max}</p>{message}
      </div>
    );
  }
  if (spec.type === 'enum') {
    return (
      <div>{label}
        <select id={id} value={String(value ?? '')} disabled={disabled} onChange={(event) => onChange(spec.values.find((item) => String(item) === event.target.value))} className={inputClass}>
          {spec.values.map((item) => <option key={String(item)} value={String(item)}>{String(item)}</option>)}
        </select>{message}
      </div>
    );
  }
  if (spec.type === 'integer') {
    return (
      <div>{label}
        <input id={id} type="number" min={spec.min} max={spec.max} step={1} value={value ?? ''} disabled={disabled} aria-invalid={Boolean(error)} aria-describedby={describedBy}
          onChange={(event) => onChange(event.target.value)} className={inputClass} />{message}
      </div>
    );
  }
  if (spec.type === 'boolean') {
    return (
      <div className="flex items-center gap-3">
        <input id={id} type="checkbox" checked={Boolean(value)} disabled={disabled} onChange={(event) => onChange(event.target.checked)} className="h-4 w-4" />
        <label htmlFor={id} className="text-sm text-white/70">{fieldLabel(name)}</label>
      </div>
    );
  }
  if (spec.type === 'url') {
    return (
      <div>{label}
        <select id={id} value={value ?? ''} disabled={disabled} aria-invalid={Boolean(error)} aria-describedby={describedBy} onChange={(event) => onChange(event.target.value)} className={inputClass}>
          <option value="">{spec.required ? 'Select a Project image…' : 'None'}</option>
          {choices.map((choice) => <option key={choice.id} value={choice.url}>{choice.title}</option>)}
        </select>
        {choices.length === 0 && <p className="mt-1 text-xs text-white/35">This Project has no image Assets yet. Upload one in Assets.</p>}{message}
      </div>
    );
  }
  if (spec.type === 'urlArray') {
    const selected = Array.isArray(value) ? value : [];
    return (
      <fieldset disabled={disabled}>
        <legend className="mb-1.5 text-[11px] font-bold uppercase tracking-wider text-white/45">{fieldLabel(name)} (up to {spec.max})</legend>
        <div className="max-h-40 space-y-1 overflow-y-auto rounded-xl border border-white/[0.08] p-2">
          {choices.length === 0 && <p className="text-xs text-white/35">No image Assets in this Project.</p>}
          {choices.map((choice) => (
            <label key={choice.id} className="flex items-center gap-2 text-xs text-white/70">
              <input type="checkbox" checked={selected.includes(choice.url)}
                onChange={(event) => onChange(event.target.checked ? [...selected, choice.url] : selected.filter((item) => item !== choice.url))} />
              {choice.title}
            </label>
          ))}
        </div>{message}
      </fieldset>
    );
  }
  return null;
}

export default function ReplicateStudio({ kind, project, assets = [], onJobSettled, onAuthLost, onBusyChange }) {
  const [controller, setController] = useState(null);
  const callbacks = useRef({});
  callbacks.current = { onJobSettled, onAuthLost };

  useEffect(() => {
    const next = createReplicateController({
      api: createReplicateApi(),
      kind,
      onJobSettled: (event) => callbacks.current.onJobSettled?.(event),
      onAuthLost: () => callbacks.current.onAuthLost?.(),
    });
    setController(next);
    next.load();
    return () => next.teardown();
  }, [kind]);

  const subscribe = useCallback((listener) => (controller ? controller.subscribe(listener) : () => {}), [controller]);
  const getSnapshot = useCallback(() => (controller ? controller.getState() : null), [controller]);
  const state = useSyncExternalStore(subscribe, getSnapshot, () => null);

  useEffect(() => { controller?.setProject(project?.id || ''); }, [controller, project?.id]);

  const view = state ? deriveView(state) : null;
  useEffect(() => { onBusyChange?.(Boolean(view?.locked)); }, [view?.locked, onBusyChange]);

  if (!state || !view) return <div className="p-8 text-sm text-white/40">Loading Replicate models…</div>;

  const model = state.models.find((item) => item.id === state.modelId);
  const choices = assetChoices(assets);
  const editable = !view.locked;
  const onPrimary = () => (view.primary.action === 'confirm' ? controller.confirm() : controller.generate());

  return (
    <div className="h-full overflow-y-auto bg-[#050506] px-5 py-8 text-white sm:px-8">
      <div className="mx-auto grid max-w-6xl gap-8 lg:grid-cols-[minmax(0,26rem)_1fr]">
        <section aria-label="Generation settings" className="space-y-5">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight">{kind === 'video' ? 'Video' : 'Image'} · Replicate</h1>
            <span className={`rounded-full border px-3 py-1 text-[11px] font-bold ${BADGE_CLASS[view.badge.tone]}`}>{view.badge.text}</span>
          </div>
          <p className="text-xs text-white/35">{project ? <>Results are saved to <strong className="text-white/60">{project.name}</strong>.</> : 'Open a Project to save results.'}</p>

          {state.models.length > 0 && (
            <div>
              <label htmlFor="replicate-model" className="mb-1.5 block text-[11px] font-bold uppercase tracking-wider text-white/45">Model</label>
              <select id="replicate-model" value={state.modelId} disabled={!editable} onChange={(event) => controller.selectModel(event.target.value)} className={inputClass}>
                {state.models.map((item) => <option key={item.id} value={item.id}>{item.label} — {item.pricing?.display}</option>)}
              </select>
            </div>
          )}

          {model && Object.entries(model.inputs).map(([name, spec]) => (
            <Field key={`${model.id}:${name}`} name={name} spec={spec} value={state.values[name]} error={state.fieldErrors[name]}
              disabled={!editable} choices={choices} onChange={(value) => controller.setValue(name, value)} />
          ))}

          {view.price && (
            <div className="rounded-xl border border-white/[0.1] bg-white/[0.03] px-4 py-3 text-sm">
              <p className="font-semibold">Estimated price: {view.price.text}</p>
              <p className="mt-1 text-xs text-white/35">Estimate only, not billing truth. Quote expires {new Date(view.price.expiresAt).toLocaleTimeString()}.</p>
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={onPrimary} disabled={!view.primary.enabled}
              className="rounded-xl bg-cyan-300 px-5 py-3 text-sm font-black text-black disabled:cursor-not-allowed disabled:opacity-30">
              {view.primary.label}
            </button>
            {view.showCancel && <button type="button" onClick={() => controller.cancel()} className="rounded-xl border border-white/[0.15] px-4 py-3 text-sm font-bold">Cancel</button>}
            {view.showCheckStatus && <button type="button" onClick={() => controller.checkStatus()} className="rounded-xl border border-white/[0.15] px-4 py-3 text-sm font-bold">Check status</button>}
            {view.showAcknowledge && <button type="button" onClick={() => controller.acknowledge()} className="rounded-xl border border-amber-300/40 px-4 py-3 text-sm font-bold text-amber-100">I understand</button>}
          </div>
          {view.disabledReason && !view.primary.enabled && <p className="text-xs text-white/35">{view.disabledReason}</p>}
        </section>

        <section aria-label="Result" className="space-y-4">
          <div aria-live="polite" className="min-h-[1.5rem] text-sm text-white/60">
            {view.progressText && <span className="inline-flex items-center gap-2"><Loader2 size={14} className="animate-spin" />{view.progressText}</span>}
          </div>
          {view.banners.map((banner, index) => (
            <div key={`${banner.tone}-${index}`} role={banner.tone === 'error' || banner.tone === 'warn' ? 'alert' : 'status'}
              className={`flex gap-3 rounded-2xl border px-4 py-3 text-sm ${BANNER_CLASS[banner.tone]}`}>
              <AlertTriangle size={16} className="mt-0.5 shrink-0" /><p>{banner.text}</p>
            </div>
          ))}
          {view.result && (
            <figure className="overflow-hidden rounded-2xl border border-white/[0.08] bg-black">
              {view.result.kind === 'video'
                ? <video src={view.result.url} controls className="w-full" />
                // eslint-disable-next-line @next/next/no-img-element
                : <img src={view.result.url} alt={view.result.alt} className="w-full object-contain" />}
              <figcaption className="space-y-2 p-4 text-xs text-white/50">
                {view.result.mockPlaceholder && <p className="font-semibold text-emerald-200">Mock placeholder — nothing was generated or charged.</p>}
                <p className="flex items-center gap-2 text-emerald-100"><CheckCircle2 size={14} /> Saved to Project · Asset {view.result.assetId}</p>
                <a href={view.result.url} download target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 rounded-lg border border-white/[0.15] px-3 py-2 font-bold text-white/80">
                  <Download size={13} /> Download
                </a>
              </figcaption>
            </figure>
          )}
        </section>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Implement `components/CreatorMediaStudio.js`**

```jsx
'use client';

import { useState } from 'react';
import ReplicateStudio from './ReplicateStudio';

const PROVIDERS = [
  { id: 'replicate', label: 'Replicate' },
  { id: 'muapi', label: 'MuAPI' },
];

export default function CreatorMediaStudio({ kind, workspaceLabel, project, assets, onJobSettled, onAuthLost, muapiWorkspace }) {
  const [provider, setProvider] = useState('replicate');
  const [busy, setBusy] = useState(false);

  return (
    <div className="flex h-full flex-col bg-[#050506]">
      <div className="flex shrink-0 items-center gap-3 border-b border-white/[0.06] px-5 py-3 sm:px-8">
        <span className="text-[11px] font-black uppercase tracking-[0.2em] text-white/35">{workspaceLabel} provider</span>
        <div role="radiogroup" aria-label={`${workspaceLabel} provider`} className="flex gap-1 rounded-xl border border-white/[0.08] p-1">
          {PROVIDERS.map((item) => (
            <button key={item.id} type="button" role="radio" aria-checked={provider === item.id}
              disabled={busy && provider !== item.id}
              onClick={() => setProvider(item.id)}
              className={`rounded-lg px-3 py-1.5 text-xs font-bold disabled:cursor-not-allowed disabled:opacity-30 ${provider === item.id ? 'bg-cyan-300 text-black' : 'text-white/55 hover:text-white'}`}>
              {item.label}
            </button>
          ))}
        </div>
        {busy && <span className="text-[11px] text-white/35">Provider locked while a generation is active.</span>}
      </div>
      <div className="min-h-0 flex-1">
        {provider === 'replicate'
          ? <ReplicateStudio kind={kind} project={project} assets={assets} onJobSettled={onJobSettled} onAuthLost={onAuthLost} onBusyChange={setBusy} />
          : muapiWorkspace}
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Run tests, lint, and build the components**

Run: `node --test tests/replicateStudioWiring.test.js && npm run lint`
Expected: wiring tests PASS; lint exit 0 with no new errors (only the existing `StudioAssets.js` warning; fix any new warning you introduced).

- [ ] **Step 6: Commit**

```bash
git add components/ReplicateStudio.js components/CreatorMediaStudio.js tests/replicateStudioWiring.test.js
git commit -m "feat: add Replicate Studio and provider selector components" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Shell wiring and originating-Project refresh

**Files:**
- Modify: `components/StandaloneShell.js` (imports near line 16; callbacks near line 395; `case 'image'`/`case 'video'` at lines ~495-496)
- Modify: `package.json` (add `test:replicate-ui` script)
- Test: `tests/replicateStudioWiring.test.js` (append)

**Interfaces:**
- Consumes: `CreatorMediaStudio` (Task 4); existing `projectRequest`, `applyCurrentProject`, `setProjectSummaries`, `setProjectError`, `currentProject`, `assets`, `callbacks`, `creatorProjectProps` in the shell.
- Produces: `settleReplicateJob({ projectId })` inside the shell.

- [ ] **Step 1: Append the failing wiring tests**

```js
test('shell routes Image and Video through the wrapper and keeps MuAPI as a passed-in element', async () => {
    const shell = await read('../components/StandaloneShell.js');
    assert.match(shell, /import CreatorMediaStudio from '\.\/CreatorMediaStudio'/);
    assert.match(shell, /<CreatorMediaStudio kind="image"/);
    assert.match(shell, /<CreatorMediaStudio kind="video"/);
    assert.match(shell, /muapiWorkspace=\{<CreatorStudio[^>]*initialToolId="image"/);
    assert.match(shell, /muapiWorkspace=\{<CreatorStudio[^>]*initialToolId="video"/);
});

test('the Replicate flow refreshes the originating Project and never posts the Asset again', async () => {
    const shell = await read('../components/StandaloneShell.js');
    const block = shell.slice(shell.indexOf('const settleReplicateJob'), shell.indexOf('const settleReplicateJob') + 1400);
    assert.match(block, /projectRequest\(`\/\$\{encodeURIComponent\(projectId\)\}`\)/);
    assert.match(block, /currentProjectIdRef\.current === projectId/);
    assert.match(block, /applyCurrentProject\(value\.project\)/);
    assert.match(block, /setProjectSummaries/);
    assert.doesNotMatch(block, /recordAsset|\/assets/);
    const wrapperCalls = shell.match(/<CreatorMediaStudio[^]*?\/>/g) || [];
    for (const call of wrapperCalls) assert.doesNotMatch(call, /onGenerationComplete|recordAsset/);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/replicateStudioWiring.test.js`
Expected: the two new tests FAIL.

- [ ] **Step 3: Implement the shell changes**

1. Add the import after `import CreatorHome from './CreatorHome';`:

```js
import CreatorMediaStudio from './CreatorMediaStudio';
```

2. Immediately after the existing `applyCurrentProject` / near the other `useCallback`s that follow `openProject`, add a ref that mirrors the selected Project id and the settle callback. Place `currentProjectIdRef` after `projectMutationRef`:

```js
  const currentProjectIdRef = useRef('');
  useEffect(() => { currentProjectIdRef.current = currentProject?.id || ''; }, [currentProject?.id]);
```

and add this callback right after `createProject` (it must come after `applyCurrentProject` is defined):

```js
  // Replicate completion is saved to the Project by the server. Refresh the Project the job
  // started in; only replace the visible Project/Assets if it is still the selected one.
  const settleReplicateJob = useCallback(async ({ projectId }) => {
    try {
      const value = await projectRequest(`/${encodeURIComponent(projectId)}`);
      if (currentProjectIdRef.current === projectId) applyCurrentProject(value.project);
      else {
        setProjectSummaries((previous) => previous.map((project) => project.id === projectId
          ? { ...project, updatedAt: value.project.updatedAt, revision: value.project.revision, assetCount: value.project.assets?.length || 0 }
          : project));
      }
    } catch (refreshError) {
      if (refreshError.status !== 401) setProjectError(refreshError.message || 'Project could not be refreshed.');
    }
  }, [applyCurrentProject]);
```

3. Replace the two switch cases:

```js
      case 'image': return <CreatorMediaStudio kind="image" workspaceLabel="Image" project={currentProject} assets={assets} onJobSettled={settleReplicateJob} muapiWorkspace={<CreatorStudio {...callbacks('image')} {...creatorProjectProps} initialToolId="image" allowedToolIds={['image']} workspaceLabel="Image" />} />;
      case 'video': return <CreatorMediaStudio kind="video" workspaceLabel="Video" project={currentProject} assets={assets} onJobSettled={settleReplicateJob} muapiWorkspace={<CreatorStudio {...callbacks('video')} {...creatorProjectProps} initialToolId="video" allowedToolIds={['video']} initialAsset={handoffAsset} workspaceLabel="Video" />} />;
```

(Leave the `generator` case and all others unchanged; the AI Generator still uses the MuAPI flow, which is out of scope per the spec.)

4. Add to `package.json` scripts, after `test:storyboard`:

```json
    "test:replicate-ui": "node --test tests/replicateStudioForm.test.js tests/replicateStudioClient.test.js tests/replicateStudioController.test.js tests/replicateStudioView.test.js tests/replicateStudioWiring.test.js",
```

- [ ] **Step 4: Run to verify pass, then regression**

Run: `npm run test:replicate-ui && npm run test:creator-shell && node --test tests/*.test.js && npm run lint`
Expected: all PASS; lint exit 0.
Also run: `npm run build`
Expected: exit 0 (the Next.js build compiles the new JSX; if a lucide icon name does not exist in the installed version, substitute the closest existing icon).

- [ ] **Step 5: Commit**

```bash
git add components/StandaloneShell.js package.json tests/replicateStudioWiring.test.js
git commit -m "feat: route Image and Video through the Replicate provider selector" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Home recent Assets and models

**Files:**
- Modify: `components/CreatorHome.js`
- Modify: `components/StandaloneShell.js` (pass `recentAssets`)
- Test: `tests/replicateStudioWiring.test.js` (append)

**Interfaces:**
- Consumes: `createReplicateApi().models()` (Task 2); shell `assets` state.
- Produces: `CreatorHome({ onNavigate, onAskSelena, recentAssets })`.

- [ ] **Step 1: Append the failing tests**

```js
test('Home shows recent Project Assets and enabled models without breaking the Selena prompt', async () => {
    const home = await read('../components/CreatorHome.js');
    const shell = await read('../components/StandaloneShell.js');
    assert.match(home, /recentAssets/);
    assert.match(home, /createReplicateApi/);
    assert.match(home, /onAskSelena\?\.\(value\)/);
    assert.match(shell, /<CreatorHome onNavigate=\{navigate\} onAskSelena=\{[^}]*\} recentAssets=\{assets/);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/replicateStudioWiring.test.js`
Expected: the new test FAILS.

- [ ] **Step 3: Implement**

In `components/CreatorHome.js`:

- Change imports to: `import { useEffect, useState } from 'react';` and add `import { createReplicateApi } from '@/src/lib/replicateStudioClient.js';`.
- Change the signature to `export default function CreatorHome({ onNavigate, onAskSelena, recentAssets = [] }) {`.
- Inside the component, after the `prompt` state, add:

```js
  const [models, setModels] = useState([]);
  useEffect(() => {
    let active = true;
    createReplicateApi().models()
      .then((value) => { if (active) setModels((value.models || []).filter((item) => item.enabled !== false).slice(0, 4)); })
      .catch(() => {});
    return () => { active = false; };
  }, []);
  const recent = recentAssets.filter((asset) => asset?.url).slice(0, 4);
```

- After the closing `</div>` of the ACTIONS grid (still inside the max-w container), add:

```jsx
        {recent.length > 0 && (
          <section aria-label="Recent in this Project" className="mt-10">
            <h2 className="text-[11px] font-black uppercase tracking-[0.22em] text-white/35">Recent in this Project</h2>
            <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {recent.map((asset) => (
                <a key={asset.id} href={asset.url} target="_blank" rel="noreferrer" className="overflow-hidden rounded-2xl border border-white/[0.07] bg-white/[0.025]">
                  <div className="aspect-video bg-black">
                    {asset.type === 'video'
                      ? <video src={asset.url} muted preload="metadata" className="h-full w-full object-cover" />
                      // eslint-disable-next-line @next/next/no-img-element
                      : <img src={asset.url} alt={asset.title || 'Project Asset'} className="h-full w-full object-cover" />}
                  </div>
                  <p className="truncate p-3 text-xs font-semibold">{asset.title || asset.id}</p>
                </a>
              ))}
            </div>
          </section>
        )}
        {models.length > 0 && (
          <section aria-label="Featured models" className="mt-10">
            <h2 className="text-[11px] font-black uppercase tracking-[0.22em] text-white/35">Featured models</h2>
            <div className="mt-3 flex flex-wrap gap-2">
              {models.map((item) => (
                <button key={item.id} type="button" onClick={() => onNavigate?.(item.kind === 'video' ? '/studio/tools/video' : '/studio/tools/image')}
                  className="rounded-full border border-white/[0.1] px-4 py-2 text-xs font-bold text-white/70 hover:text-white">
                  {item.label}
                </button>
              ))}
            </div>
          </section>
        )}
```

In `StandaloneShell.js`, change the `home` case to pass assets:

```js
      case 'home': return <CreatorHome onNavigate={navigate} onAskSelena={(prompt) => { setSelenaPrompt(prompt); navigate('/studio/selena'); }} recentAssets={assets} />;
```

- [ ] **Step 4: Run to verify pass**

Run: `npm run test:replicate-ui && npm run test:creator-shell && npm run lint`
Expected: PASS; lint exit 0.

- [ ] **Step 5: Commit**

```bash
git add components/CreatorHome.js components/StandaloneShell.js tests/replicateStudioWiring.test.js
git commit -m "feat: show recent Project Assets and enabled models on Creator Home" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Local browser verification fixture

**Files:**
- Create: `scripts/replicate-ui-fixture-server.mjs`
- Modify: `next.config.mjs`
- Test: manual browser run recorded in `docs/superpowers/handoff/2026-10-09-replicate-ui-verification.md`

**Interfaces:**
- Consumes: the real route module `app/api/creator/[[...path]]/route.js` with injected stores, exactly as `scripts/replicate-http-smoke.mjs` does (reuse its `env`, in-memory `blobStore`/`assetBlobStore`, `mock.module` pattern, and `createCreatorSession` cookie).
- Produces: a localhost fixture API on a fixed port (default 4010) plus a dev-only Next rewrite so the real app UI talks to it same-origin.

No paid, real-provider, real-Blob, or real-GitHub call is possible: the fixture uses `GENERATION_MODE=mock`, fabricated credentials, in-memory stores, and blocks every non-localhost `fetch`.

- [ ] **Step 1: Add the dev-only rewrite to `next.config.mjs`**

Add to `nextConfig`:

```js
  // Local browser verification only: proxy the Creator API to the fixture server
  // (scripts/replicate-ui-fixture-server.mjs). Inactive unless the variable is set
  // and never in production.
  async rewrites() {
    const fixture = process.env.NODE_ENV !== 'production' ? process.env.CREATOR_UI_FIXTURE_ORIGIN : '';
    if (!fixture || !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(fixture)) return [];
    return { beforeFiles: [{ source: '/api/creator/:path*', destination: `${fixture}/api/creator/:path*` }] };
  },
```

- [ ] **Step 2: Write `scripts/replicate-ui-fixture-server.mjs`**

Copy the harness section of `scripts/replicate-http-smoke.mjs` (imports, `env`, `blobStore`, `media`, `assetBlobStore`, `ctx` with `idGenerator`/`fetchImpl`, the two `mock.module` calls, and the `route` import) and keep these differences:

- `env.NODE_ENV = 'development'`, `GENERATION_MODE = 'mock'` (unchanged), and the rate-limit values stay at 200.
- Do **not** call `listen(0)`; listen on `process.env.FIXTURE_PORT || 4010` at `127.0.0.1`.
- Build each `Request` URL from the browser's origin so same-origin mutation checks pass behind the rewrite: `const host = incoming.headers['x-forwarded-host'] || incoming.headers.host; const proto = incoming.headers['x-forwarded-proto'] || 'http'; new Request(`${proto}://${host}${incoming.url}`, …)`.
- Add one fixture-only route before the Creator dispatch:

```js
if (pathname === '/api/creator/__fixture/login') {
    const cookie = `${creatorCookieSettings(env).sessionName}=${createCreatorSession(owner, { env })}; Path=/; HttpOnly; SameSite=Lax`;
    outgoing.writeHead(302, { 'set-cookie': cookie, location: '/studio' });
    outgoing.end();
    return;
}
```

- Add a second fixture-only route `GET /api/creator/__fixture/media/<pathname>` that returns the bytes stored in `media` (so previews load same-origin), and change `assetBlobStore.put` to return `url: `${process.env.FIXTURE_PUBLIC_ORIGIN || 'http://localhost:3000'}/api/creator/__fixture/media/${pathname}``. If the Project store rejects that non-Blob URL (`invalid_asset_url`), fall back to the smoke script's `https://creator.public.blob.vercel-storage.com/` URL form and verify previews by their DOM `src` only; record which form was used.
- Keep the guard that counts and rejects any outbound `fetch` not addressed to the fixture origin.
- Print `Fixture API ready on http://127.0.0.1:<port>` and the Next start line to run.

- [ ] **Step 3: Start the fixture and the app**

Run (two background processes):

```bash
node --experimental-test-module-mocks scripts/replicate-ui-fixture-server.mjs
CREATOR_UI_FIXTURE_ORIGIN=http://127.0.0.1:4010 npm run dev
```

Record the real Next port from its startup output (default `3000`; Next picks another if busy).
Expected: fixture prints ready; `curl -i http://127.0.0.1:4010/api/creator/replicate/models` returns 401 (no cookie); opening `http://localhost:<port>/api/creator/__fixture/login` sets the cookie and lands on `/studio`.

- [ ] **Step 4: Browser-verify with the claude-in-chrome skill** (invoke the `claude-in-chrome` skill first). Check and record pass/fail with a screenshot reference for each:

1. `/studio/tools/image`: Replicate selected, "Mock · no paid generation" badge, model list, settings form, Generate disabled with the "Open a Project" reason until a Project exists; create a Project in `/studio/projects`, return.
2. Mock image: click Generate once; result shows the mock-placeholder label, "Saved to Project · Asset <id>", Download link; `/studio/assets` lists exactly one new Asset; reload the page and confirm the same Asset id/URL.
3. Rapid double click on Generate produces one Asset (network panel or fixture log shows one create).
4. `/studio/tools/video`: default model is the first video model; mock video shows an image placeholder with the mock label and not a video control.
5. Provider selector: switching to MuAPI renders the existing studio; switching back works; selector is disabled during a running job (use the browser dev tools to throttle if needed).
6. Keyboard: Tab through model, fields, Generate; Enter activates; status/errors announced (`aria-live`/`role=alert` present in DOM).
7. Mobile width (375px): no horizontal scroll, controls reachable.
8. Home: recent Assets and featured models appear; Selena prompt still works.
9. Sign-out simulation: delete the session cookie in dev tools and click Generate; the UI shows the session-ended message and keeps no stale job.

Fix any defect in the owning module with a failing test first (Systematic Debugging), then re-verify.

- [ ] **Step 5: Stop both processes, write the verification record, commit**

Write `docs/superpowers/handoff/2026-10-09-replicate-ui-verification.md` containing: the exact commands, the actual Next URL/port, each checklist item as PASS/FAIL with notes, the fixture URL form used for Assets, outbound-fetch count (must be 0), and anything not verified. Then:

```bash
git add scripts/replicate-ui-fixture-server.mjs next.config.mjs docs/superpowers/handoff/2026-10-09-replicate-ui-verification.md
git commit -m "test: add mocked browser fixture and record Replicate UI verification" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Full regression, simplification, and handoff

**Files:**
- Modify: `docs/superpowers/handoff/2026-10-08-creator-studio-resume.md` (append a "UI increment" section), `docs/superpowers/specs/2026-10-08-replicate-ui-followup-design.md` (status line)

- [ ] **Step 1: Run the complete verification set and record real counts**

```bash
npm run test:security
npm run test:creator-shell
npm run test:replicate-ui
node --test tests/*.test.js
node --test tests/integration/*.test.js
node --experimental-test-module-mocks scripts/replicate-http-smoke.mjs
npm run lint
npm run build
git status --short
```

Expected: security 318/318 (unchanged), creator-shell 25/25, `test:replicate-ui` all pass, top-level all pass (46 plus the new top-level test files if included by the glob), integration pass, smoke 11/11, lint exit 0 with no new warnings beyond the existing `StudioAssets.js` one, build exit 0, `git status` clean. If the build fails on Google Fonts DNS, retry with network permission and note it.

- [ ] **Step 2: Independent review gates**

Dispatch a fresh reviewer (superpowers:requesting-code-review) against the spec and this plan for the range `9d8544d..HEAD`. Fix confirmed defects with failing tests first. Then run the `ponytail` simplification review on the new files only; accept a change only if it removes demonstrated unnecessary complexity and all tests still pass. No stylistic-only edits.

- [ ] **Step 3: Update docs and commit**

Append to the resume handoff: what was built, final verified counts, actual local URL used, what was NOT verified (live model schemas/prices, real Blob media, Next middleware auth against real GitHub, multi-instance accounting, resuming an in-flight job after the page is closed), and the remaining owner decisions (Plan C: legacy cleanup, Preview deploy). Change the UI spec status line to "IMPLEMENTED locally; see verification record".

```bash
git add docs/superpowers
git commit -m "docs: record Replicate UI increment results" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Self-Review

- **Spec coverage:** shell wrapper + explicit selector (Tasks 4–5); registry-driven form incl. enum/bounded numeric/toggle/prompt limit/Asset pickers (Tasks 1, 4); mock/live badge, signed quote, separate confirm, expiry, invalidation, `$0.003` formatting, per-job cap (Tasks 1–3); synchronous submit guard, frozen context, no auto-retry (Task 2); polling bounded, status-failure "Check status", deadline not failure (Task 2); cancel semantics (Task 2); persisted preview, download, "Saved to Project", no second save (Tasks 3–5); Project refresh of originating Project only (Tasks 2, 5); provider lock during active/uncertain submit (Tasks 3–4); error handling incl. auth loss, `outcomeUnknown`, accepted-job contract, ack-gated Generate (Task 2); Home recent Assets/models (Task 6); mocked browser verification and regression/build (Tasks 7–8). Gap noted and accepted: an in-flight job is not resumed if the page is closed (no job-list endpoint; matches the spec's known limitation) — recorded in Task 8 docs.
- **Placeholder scan:** the only transient marker is the Task 2 Step 3 comment line, explicitly replaced in Step 7 and not committed in its placeholder form (the Step 3 file is never committed; Step 9 commits the final file).
- **Type consistency:** controller methods used by the component (`load, selectModel, setValue, setProject, generate, confirm, checkStatus, cancel, acknowledge, teardown, subscribe, getState`) match Task 2; view fields used by the component (`locked, badge, disabledReason, primary, price, showCancel, showCheckStatus, showAcknowledge, banners, progressText, result`) match Task 3; `result.kind/url/assetId/mockPlaceholder/alt` match; `onJobSettled({projectId, job})` matches the shell's `settleReplicateJob({ projectId })`.
- **Review Focus:** items 1–3 and 6 are tested in Task 2; 4 in Task 3; 5 in Tasks 2 and 5 (settle test + wiring assertion).
