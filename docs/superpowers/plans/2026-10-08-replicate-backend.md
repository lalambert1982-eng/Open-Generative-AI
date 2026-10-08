# Replicate Backend (Plan A of 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a server-side Replicate provider (model registry, mock-by-default adapter, cost/duplicate guard, persistent output copy, owner-bound job API) to the existing Creator route layer, fully testable with mocked fetch and no spend.

**Architecture:** New files in `src/lib/` mirror the existing MuAPI adapter style (`env` and `fetchImpl` injected, normalized job objects, never throw past the route). A thin `replicateGateway.js` exposes five handlers wired into `app/api/creator/[[...path]]/route.js` under `replicate/*`, reusing `authorizeCreatorRequest`, `parseCreatorJson`, the private-Blob JSON pattern and `addCreatorAsset`. Generation defaults to mock mode; live needs two env switches plus a signed per-request cost quote.

**Tech Stack:** Node ESM, `node:test`, Next.js route handlers, `@vercel/blob` (already installed). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-08-creator-studio-replicate-design.md` (research in `docs/superpowers/research/`).

**Scope of this plan:** backend only. Plan B (written after this lands) covers: Image/Video Studio UI + Home + Projects wiring against these endpoints, removal of the legacy browser-key MuAPI proxies, Electron/Vite/submodule cleanup, and Vercel Preview. Webhooks are deferred (polling only); the spec allows this ("poll initially").

## Global Constraints

- Tests: `node --test` (ESM, `import test from 'node:test'`, `assert from 'node:assert/strict'`), files in `tests/security/` named `*.test.js` (picked up by `npm run test:security`).
- Code style: 4-space indent, single quotes, semicolons, named exports, matches `src/lib/muapiCreatorProvider.js`.
- No new npm dependencies. No network in tests (inject `fetchImpl`). No live Replicate call at any point in this plan.
- `REPLICATE_API_TOKEN` is server-only: never `NEXT_PUBLIC_`, never returned in any response or error.
- Generation default is `mock`. Live requires `GENERATION_MODE=live` AND `REPLICATE_LIVE_ENABLED=true` AND a valid token.
- Existing suites must stay green: `npm run test:security` (235 before this plan), `npm run test:creator-shell` (25), `node --test tests/*.test.js` (46), `node --test tests/integration/*.test.js` (5).
- Do not modify Production config, push, merge, or deploy. Work only on branch `rebuild/creator-studio-replicate` in `~/ogai-creator-studio-v2`.
- Commit trailer: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

## Review Focus

1. `GENERATION_MODE=live` set but flag or token missing: must report unconfigured (503), never silently fall back to mock or send a request. (Task 2)
2. Replicate says `succeeded` but output is empty, non-HTTPS, or on a host other than `replicate.delivery`: job fails, nothing is persisted. (Tasks 4, 5)
3. Two overlapping polls of one finished job: exactly one Asset is created and the output is downloaded once. (Task 5)
4. A second owner probing the first owner's job id or Project id gets 404 with no data. (Tasks 3, 5)
5. Extra or hostile input keys (`disable_safety_checker`, `__proto__`), non-string or oversized prompts, and reference-image URLs on non-allowed hosts are rejected before any spend. (Task 1)

---

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/replicateModelRegistry.js` (create) | Static model definitions, input-schema validation, cost estimate |
| `src/lib/replicateProvider.js` (create) | Config/mode, prepare + submit + get + cancel against Replicate API, mock jobs |
| `src/lib/generationGuard.js` (create) | Owner key, signed quotes, per-job/day caps, duplicate lock, job records |
| `src/lib/replicatePersist.js` (create) | Copy provider output (or mock placeholder) to asset Blob and add Project Asset |
| `src/lib/replicateGateway.js` (create) | Five route handlers composing the above |
| `src/lib/creatorProviderGateway.js` (modify) | Export `parseCreatorJson` |
| `src/lib/creatorProjectStore.js` (modify) | Export `defaultBlobStore` |
| `app/api/creator/[[...path]]/route.js` (modify) | Route `replicate/*` |
| `.env.example` (modify) | Document new env vars |
| `tests/security/replicate*.test.js`, `tests/security/generationGuard.test.js` (create) | Unit and integration tests |

---

### Task 1: Model registry and input validation

**Files:**
- Create: `src/lib/replicateModelRegistry.js`
- Test: `tests/security/replicateModelRegistry.test.js`

**Interfaces:**
- Produces:
  - `REPLICATE_MODELS` (frozen array of model definitions)
  - `getReplicateModel(id: string): object | null`
  - `listReplicateModels(): Array<{id,kind,task,label,pricing,inputs,enabled}>` (client-safe view)
  - `validateReplicateInput(model, raw, { assetUrl }): { value } | { error }` where `assetUrl(url: string): string` returns a permitted URL or throws
  - `estimateReplicateUsd(model, input): number`

- [ ] **Step 1: Write the failing test**

```js
import assert from 'node:assert/strict';
import test from 'node:test';

import {
    REPLICATE_MODELS,
    estimateReplicateUsd,
    getReplicateModel,
    listReplicateModels,
    validateReplicateInput,
} from '../../src/lib/replicateModelRegistry.js';

const assetUrl = (url) => {
    if (!url.startsWith('https://creator.public.blob.vercel-storage.com/')) throw new Error('blocked');
    return url;
};

test('every registry entry is well formed', () => {
    assert.ok(REPLICATE_MODELS.length >= 8);
    for (const model of REPLICATE_MODELS) {
        assert.match(model.id, /^[a-z0-9-]+\/[a-z0-9._-]+$/);
        assert.ok(['image', 'video'].includes(model.kind));
        assert.equal(model.provider, 'replicate');
        assert.equal(model.inputs.prompt.required, true);
        assert.ok(['flat', 'perSecond'].includes(model.pricing.mode));
        assert.ok(model.pricing.usd > 0);
    }
});

test('listReplicateModels exposes no internal-only fields', () => {
    const [first] = listReplicateModels();
    assert.deepEqual(Object.keys(first).sort(), ['enabled', 'id', 'inputs', 'kind', 'label', 'pricing', 'task']);
});

test('defaults are applied and only registry fields are produced', () => {
    const model = getReplicateModel('black-forest-labs/flux-schnell');
    const result = validateReplicateInput(model, { prompt: '  a red fox  ' }, { assetUrl });
    assert.deepEqual(result.value, { prompt: 'a red fox', aspect_ratio: '1:1' });
});

test('unknown or hostile keys are rejected', () => {
    const model = getReplicateModel('black-forest-labs/flux-schnell');
    assert.match(validateReplicateInput(model, { prompt: 'x', disable_safety_checker: true }, { assetUrl }).error, /Unsupported setting/);
    const hostile = JSON.parse('{"prompt":"x","__proto__":{"polluted":true}}');
    assert.match(validateReplicateInput(model, hostile, { assetUrl }).error, /Unsupported setting/);
    assert.equal(validateReplicateInput(model, 'nope', { assetUrl }).error, 'Input must be an object.');
});

test('prompt and enum checks', () => {
    const model = getReplicateModel('black-forest-labs/flux-schnell');
    assert.equal(validateReplicateInput(model, {}, { assetUrl }).error, 'prompt is required.');
    assert.equal(validateReplicateInput(model, { prompt: 42 }, { assetUrl }).error, 'prompt must be text.');
    assert.match(validateReplicateInput(model, { prompt: 'x'.repeat(4001) }, { assetUrl }).error, /4000/);
    assert.match(validateReplicateInput(model, { prompt: 'x', aspect_ratio: '7:5' }, { assetUrl }).error, /aspect_ratio/);
});

test('reference-image URLs must pass the asset allowlist and required fields are enforced', () => {
    const edit = getReplicateModel('black-forest-labs/flux-kontext-pro');
    assert.equal(validateReplicateInput(edit, { prompt: 'make it night' }, { assetUrl }).error, 'input_image is required.');
    assert.match(
        validateReplicateInput(edit, { prompt: 'x', input_image: 'https://attacker.test/a.png' }, { assetUrl }).error,
        /input_image/,
    );
    const ok = validateReplicateInput(edit, {
        prompt: 'make it night',
        input_image: 'https://creator.public.blob.vercel-storage.com/a.png',
    }, { assetUrl });
    assert.equal(ok.value.input_image, 'https://creator.public.blob.vercel-storage.com/a.png');
});

test('video numeric settings are bounded and priced per second', () => {
    const model = getReplicateModel('kwaivgi/kling-v3-video');
    assert.match(validateReplicateInput(model, { prompt: 'x', duration: 99 }, { assetUrl }).error, /duration/);
    const { value } = validateReplicateInput(model, { prompt: 'x', duration: '10' }, { assetUrl });
    assert.equal(value.duration, 10);
    assert.equal(estimateReplicateUsd(model, value), Number((model.pricing.usd * 10).toFixed(4)));
});

test('enum values match numerically written inputs', () => {
    const veo = getReplicateModel('google/veo-3.1-fast');
    assert.equal(validateReplicateInput(veo, { prompt: 'x', duration: '8' }, { assetUrl }).value.duration, 8);
    assert.match(validateReplicateInput(veo, { prompt: 'x', duration: 5 }, { assetUrl }).error, /duration/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/security/replicateModelRegistry.test.js`
Expected: FAIL with `Cannot find module '../../src/lib/replicateModelRegistry.js'`

- [ ] **Step 3: Write the implementation**

```js
const MAX_PROMPT_CHARACTERS = 4000;
const IMAGE_RATIOS = Object.freeze(['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3']);

const PROMPT = Object.freeze({ type: 'string', required: true, max: MAX_PROMPT_CHARACTERS });
const url = (required = false) => Object.freeze({ type: 'url', required });
const urlArray = (max) => Object.freeze({ type: 'urlArray', max });
const choice = (values, fallback) => Object.freeze({ type: 'enum', values: Object.freeze(values), default: fallback });
const integer = (min, max, fallback) => Object.freeze({ type: 'integer', min, max, default: fallback });
const toggle = (fallback = false) => Object.freeze({ type: 'boolean', default: fallback });

function model(entry) {
    return Object.freeze({
        provider: 'replicate',
        official: true,
        enabled: true,
        ...entry,
        pricing: Object.freeze(entry.pricing),
        inputs: Object.freeze(entry.inputs),
    });
}

// Field names are Replicate's own input names, copied from each official
// model's published schema (see docs/superpowers/research). Prices are the
// highest rate on the model page and are estimates, not billing truth.
export const REPLICATE_MODELS = Object.freeze([
    model({
        id: 'black-forest-labs/flux-2-pro',
        kind: 'image',
        task: 'text-to-image',
        label: 'FLUX 2 Pro',
        pricing: { mode: 'flat', usd: 0.015, display: '~$0.015 per image (estimate)' },
        inputs: { prompt: PROMPT, aspect_ratio: choice(IMAGE_RATIOS, '1:1') },
    }),
    model({
        id: 'black-forest-labs/flux-schnell',
        kind: 'image',
        task: 'text-to-image',
        label: 'FLUX Schnell (fast draft)',
        pricing: { mode: 'flat', usd: 0.003, display: '~$0.003 per image (estimate)' },
        inputs: { prompt: PROMPT, aspect_ratio: choice(IMAGE_RATIOS, '1:1') },
    }),
    model({
        id: 'google/nano-banana-2',
        kind: 'image',
        task: 'text-to-image',
        label: 'Nano Banana 2',
        pricing: { mode: 'flat', usd: 0.151, display: 'up to ~$0.151 per image (estimate)' },
        inputs: { prompt: PROMPT, aspect_ratio: choice(IMAGE_RATIOS, '1:1'), image_input: urlArray(14) },
    }),
    model({
        id: 'black-forest-labs/flux-kontext-pro',
        kind: 'image',
        task: 'image-edit',
        label: 'FLUX Kontext Pro (edit)',
        pricing: { mode: 'flat', usd: 0.04, display: '~$0.04 per image (estimate)' },
        inputs: {
            prompt: PROMPT,
            input_image: url(true),
            aspect_ratio: choice(['match_input_image', ...IMAGE_RATIOS], 'match_input_image'),
        },
    }),
    model({
        id: 'google/nano-banana-pro',
        kind: 'image',
        task: 'image-edit',
        label: 'Nano Banana Pro (edit, references)',
        pricing: { mode: 'flat', usd: 0.3, display: 'up to ~$0.30 per image (estimate)' },
        inputs: { prompt: PROMPT, aspect_ratio: choice(IMAGE_RATIOS, '1:1'), image_input: urlArray(14) },
    }),
    model({
        id: 'google/veo-3.1-fast',
        kind: 'video',
        task: 'text-to-video',
        label: 'Veo 3.1 Fast',
        pricing: { mode: 'perSecond', usd: 0.15, display: 'up to ~$0.15 per second (estimate)' },
        inputs: {
            prompt: PROMPT,
            image: url(),
            last_frame: url(),
            duration: choice([4, 6, 8], 6),
            aspect_ratio: choice(['16:9', '9:16'], '16:9'),
        },
    }),
    model({
        id: 'kwaivgi/kling-v3-video',
        kind: 'video',
        task: 'text-to-video',
        label: 'Kling v3',
        pricing: { mode: 'perSecond', usd: 0.336, display: 'up to ~$0.336 per second (estimate)' },
        inputs: {
            prompt: PROMPT,
            start_image: url(),
            end_image: url(),
            duration: integer(3, 15, 5),
            aspect_ratio: choice(['16:9', '9:16', '1:1'], '16:9'),
            mode: choice(['standard', 'pro'], 'standard'),
        },
    }),
    model({
        id: 'bytedance/seedance-1.5-pro',
        kind: 'video',
        task: 'text-to-video',
        label: 'Seedance 1.5 Pro',
        pricing: { mode: 'perSecond', usd: 0.12, display: 'up to ~$0.12 per second (estimate)' },
        inputs: {
            prompt: PROMPT,
            image: url(),
            last_frame_image: url(),
            duration: integer(2, 12, 5),
            aspect_ratio: choice(['16:9', '9:16', '1:1'], '16:9'),
            camera_fixed: toggle(false),
        },
    }),
]);

export function getReplicateModel(id) {
    return REPLICATE_MODELS.find((entry) => entry.id === id) || null;
}

export function listReplicateModels() {
    return REPLICATE_MODELS.map(({ id, kind, task, label, pricing, inputs, enabled }) => ({
        id, kind, task, label, pricing, inputs, enabled,
    }));
}

function checkField(name, spec, value, assetUrl) {
    switch (spec.type) {
        case 'string': {
            if (typeof value !== 'string') return { error: `${name} must be text.` };
            const text = value.trim();
            if (!text) return { error: `${name} is required.` };
            if (text.length > spec.max) return { error: `${name} must be ${spec.max} characters or fewer.` };
            return { value: text };
        }
        case 'enum': {
            const match = spec.values.find((candidate) => String(candidate) === String(value));
            return match === undefined ? { error: `${name} is not a supported value.` } : { value: match };
        }
        case 'integer': {
            const number = Number(value);
            if (!Number.isInteger(number) || number < spec.min || number > spec.max) {
                return { error: `${name} must be a whole number from ${spec.min} to ${spec.max}.` };
            }
            return { value: number };
        }
        case 'boolean':
            return typeof value === 'boolean' ? { value } : { error: `${name} must be true or false.` };
        case 'url':
            return checkUrl(name, value, assetUrl);
        case 'urlArray': {
            if (!Array.isArray(value) || value.length > spec.max) {
                return { error: `${name} must be a list of up to ${spec.max} image URLs.` };
            }
            const urls = [];
            for (const item of value) {
                const checked = checkUrl(name, item, assetUrl);
                if (checked.error) return checked;
                urls.push(checked.value);
            }
            return { value: urls };
        }
        default:
            return { error: `${name} has an unsupported type.` };
    }
}

function checkUrl(name, value, assetUrl) {
    if (typeof assetUrl !== 'function') return { error: `${name} references are not available.` };
    try {
        return { value: assetUrl(value) };
    } catch {
        return { error: `${name} must be a permitted HTTPS media URL.` };
    }
}

export function validateReplicateInput(modelDefinition, raw, { assetUrl } = {}) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'Input must be an object.' };
    for (const key of Object.keys(raw)) {
        if (!Object.hasOwn(modelDefinition.inputs, key)) return { error: `Unsupported setting: ${key}.` };
    }
    const out = {};
    for (const [name, spec] of Object.entries(modelDefinition.inputs)) {
        const value = raw[name];
        if (value == null || value === '') {
            if (spec.required) return { error: `${name} is required.` };
            if (spec.default !== undefined) out[name] = spec.default;
            continue;
        }
        const checked = checkField(name, spec, value, assetUrl);
        if (checked.error) return checked;
        out[name] = checked.value;
    }
    return { value: out };
}

export function estimateReplicateUsd(modelDefinition, input) {
    const { mode, usd } = modelDefinition.pricing;
    if (mode === 'flat') return usd;
    const seconds = Number(input?.duration ?? modelDefinition.inputs.duration?.default ?? 5);
    return Number((usd * seconds).toFixed(4));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/security/replicateModelRegistry.test.js`
Expected: PASS (7 tests)

- [ ] **Step 5: Verify enum values against live model pages (read-only, no spend)**

For each model in the registry run, then remove any registry enum value the page does not offer and note unverifiable ones in a code comment:

```bash
for m in black-forest-labs/flux-2-pro black-forest-labs/flux-schnell google/nano-banana-2 black-forest-labs/flux-kontext-pro google/nano-banana-pro google/veo-3.1-fast kwaivgi/kling-v3-video bytedance/seedance-1.5-pro; do
  echo "=== $m"; curl -s -H 'Accept: text/markdown' "https://replicate.com/$m/api" | grep -i -A6 -E '"(aspect_ratio|duration|mode)"' | head -40
done
```

Expected: each `aspect_ratio` / `duration` / `mode` enum in the registry appears in the page schema. If the command output is empty for a model, leave the registry entry as is and add `// enum values not re-verified` above it.

- [ ] **Step 6: Commit**

```bash
git add src/lib/replicateModelRegistry.js tests/security/replicateModelRegistry.test.js
git commit -m "feat: add Replicate model registry with strict input validation

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Replicate provider (config, prepare, submit, get, cancel, mock)

**Files:**
- Create: `src/lib/replicateProvider.js`
- Test: `tests/security/replicateProvider.test.js`

**Interfaces:**
- Consumes: Task 1 (`getReplicateModel`, `validateReplicateInput`, `estimateReplicateUsd`).
- Produces:
  - `REPLICATE_IMAGE_TOOL_ID = 'replicate_image'`, `REPLICATE_VIDEO_TOOL_ID = 'replicate_video'`
  - `replicateConfiguration(env): { mode: 'mock'|'live'|'unconfigured', requestedMode, live, configured, missing: string[], apiKey, maxUsdPerJob, maxUsdPerDay, jobTimeoutMs }`
  - `replicateProviderStatus(env): { id:'replicate', label, capability, toolIds, configured, status, mode }`
  - `prepareReplicateRequest({ modelId, input }, { env, assetUrl }): { ok:true, model, input, estimateUsd, config } | { ok:false, status, error, missing? }`
  - `submitReplicateJob(prepared, { env, fetchImpl, idGenerator, timeoutMs }): { ok:true, status, job } | { ok:false, status, error, retryable? }`
  - `getReplicateJob({ jobId, modelId }, { env, fetchImpl, timeoutMs })` and `cancelReplicateJob({ jobId, modelId }, opts)`: same result shape as submit
  - Job: `{ provider:'replicate', toolId, kind, jobId, status:'queued'|'processing'|'completed'|'failed'|'canceled', outputUrl, model, mode, mock, error }`

- [ ] **Step 0: Confirm the `Cancel-After` header format (read-only)**

Run: `curl -s -H 'Accept: text/markdown' https://replicate.com/docs/reference/http | grep -i -B2 -A6 'cancel-after'`
Expected: documentation showing the accepted duration format. If it is not `10m`-style, change the `CANCEL_AFTER` constant below to match and keep the test assertion in step 1 in sync. If the docs are unreachable, leave `10m` and note it in the commit message.

- [ ] **Step 1: Write the failing test**

```js
import assert from 'node:assert/strict';
import test from 'node:test';

import {
    cancelReplicateJob,
    getReplicateJob,
    prepareReplicateRequest,
    replicateConfiguration,
    replicateProviderStatus,
    submitReplicateJob,
} from '../../src/lib/replicateProvider.js';

const assetUrl = (url) => url;
const token = 'r8_test_token_value_1234567890';
const liveEnv = { GENERATION_MODE: 'live', REPLICATE_LIVE_ENABLED: 'true', REPLICATE_API_TOKEN: token };
const predictionId = 'abc123def456ghi789jkl012mn';

function noFetch() {
    throw new Error('fetch must not be called');
}

function jsonResponse(body, status = 200) {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

test('default configuration is mock and live fails closed when switches or token are missing', () => {
    assert.equal(replicateConfiguration({}).mode, 'mock');
    assert.equal(replicateConfiguration({}).configured, true);
    const noFlag = replicateConfiguration({ GENERATION_MODE: 'live', REPLICATE_API_TOKEN: token });
    assert.equal(noFlag.mode, 'unconfigured');
    assert.equal(noFlag.configured, false);
    assert.deepEqual(noFlag.missing, ['REPLICATE_LIVE_ENABLED=true']);
    const noToken = replicateConfiguration({ GENERATION_MODE: 'live', REPLICATE_LIVE_ENABLED: 'true' });
    assert.deepEqual(noToken.missing, ['REPLICATE_API_TOKEN']);
    assert.equal(noToken.apiKey, '');
    assert.equal(replicateConfiguration(liveEnv).mode, 'live');
    assert.equal(replicateConfiguration({ ...liveEnv, GENERATION_MODE: 'LIVE ' }).mode, 'live');
});

test('unconfigured live mode refuses to prepare a request and never calls fetch', () => {
    const prepared = prepareReplicateRequest(
        { modelId: 'black-forest-labs/flux-schnell', input: { prompt: 'fox' } },
        { env: { GENERATION_MODE: 'live', REPLICATE_API_TOKEN: token }, assetUrl },
    );
    assert.equal(prepared.ok, false);
    assert.equal(prepared.status, 503);
});

test('provider status never exposes the token and labels the mode', () => {
    assert.match(replicateProviderStatus({}).status, /Mock/);
    const status = replicateProviderStatus(liveEnv);
    assert.match(status.status, /Live/);
    assert.equal(JSON.stringify(status).includes(token), false);
});

test('unknown model and invalid input are rejected before any request', () => {
    assert.equal(prepareReplicateRequest({ modelId: 'evil/model', input: { prompt: 'x' } }, { env: liveEnv, assetUrl }).status, 400);
    const bad = prepareReplicateRequest(
        { modelId: 'black-forest-labs/flux-schnell', input: { prompt: 'x', extra: 1 } },
        { env: liveEnv, assetUrl },
    );
    assert.equal(bad.status, 400);
});

test('mock submit returns a completed mock job without calling fetch', async () => {
    const prepared = prepareReplicateRequest(
        { modelId: 'black-forest-labs/flux-schnell', input: { prompt: 'fox' } },
        { env: {}, assetUrl },
    );
    assert.equal(prepared.ok, true);
    const result = await submitReplicateJob(prepared, { env: {}, fetchImpl: noFetch, idGenerator: () => '11111111-1111-4111-8111-111111111111' });
    assert.equal(result.ok, true);
    assert.equal(result.job.mock, true);
    assert.equal(result.job.status, 'completed');
    assert.equal(result.job.jobId, 'mock_11111111-1111-4111-8111-111111111111');
    assert.equal(result.job.outputUrl, null);
});

test('live submit posts only validated input to the official-model endpoint', async () => {
    const calls = [];
    const fetchImpl = async (url, options) => {
        calls.push({ url, options });
        return jsonResponse({ id: predictionId, status: 'starting' }, 201);
    };
    const prepared = prepareReplicateRequest(
        { modelId: 'black-forest-labs/flux-2-pro', input: { prompt: 'fox' } },
        { env: liveEnv, assetUrl },
    );
    const result = await submitReplicateJob(prepared, { env: liveEnv, fetchImpl });
    assert.equal(result.ok, true);
    assert.equal(result.status, 202);
    assert.equal(result.job.status, 'queued');
    assert.equal(result.job.jobId, predictionId);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.replicate.com/v1/models/black-forest-labs/flux-2-pro/predictions');
    assert.equal(calls[0].options.method, 'POST');
    assert.equal(calls[0].options.headers.authorization, `Bearer ${token}`);
    assert.equal(calls[0].options.headers['cancel-after'], '10m');
    assert.deepEqual(JSON.parse(calls[0].options.body), { input: { prompt: 'fox', aspect_ratio: '1:1' } });
    assert.equal(JSON.stringify(result).includes(token), false);
});

test('provider failures are normalized and never leak the token', async () => {
    const prepared = prepareReplicateRequest(
        { modelId: 'black-forest-labs/flux-2-pro', input: { prompt: 'fox' } },
        { env: liveEnv, assetUrl },
    );
    const rejected = await submitReplicateJob(prepared, {
        env: liveEnv,
        fetchImpl: async () => jsonResponse({ detail: `bad token ${token}` }, 401),
    });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.status, 502);
    assert.equal(JSON.stringify(rejected).includes(token), false);
    const credit = await submitReplicateJob(prepared, { env: liveEnv, fetchImpl: async () => jsonResponse({}, 402) });
    assert.equal(credit.status, 402);
    const down = await submitReplicateJob(prepared, { env: liveEnv, fetchImpl: async () => { throw new Error('boom'); } });
    assert.equal(down.status, 502);
    assert.equal(down.retryable, true);
});

test('get maps terminal states and takes the first array output', async () => {
    const done = await getReplicateJob(
        { jobId: predictionId, modelId: 'black-forest-labs/flux-schnell' },
        {
            env: liveEnv,
            fetchImpl: async (url) => {
                assert.equal(url, `https://api.replicate.com/v1/predictions/${predictionId}`);
                return jsonResponse({ id: predictionId, status: 'succeeded', output: ['https://replicate.delivery/x/out.webp'] });
            },
        },
    );
    assert.equal(done.job.status, 'completed');
    assert.equal(done.job.outputUrl, 'https://replicate.delivery/x/out.webp');
    const failed = await getReplicateJob(
        { jobId: predictionId, modelId: 'black-forest-labs/flux-schnell' },
        { env: liveEnv, fetchImpl: async () => jsonResponse({ id: predictionId, status: 'failed', error: 'NSFW content detected' }) },
    );
    assert.equal(failed.job.status, 'failed');
    assert.match(failed.job.error, /NSFW/);
    const noOutput = await getReplicateJob(
        { jobId: predictionId, modelId: 'black-forest-labs/flux-schnell' },
        { env: liveEnv, fetchImpl: async () => jsonResponse({ id: predictionId, status: 'succeeded', output: null }) },
    );
    assert.equal(noOutput.job.status, 'failed');
});

test('get and cancel reject mock ids and malformed ids without calling fetch', async () => {
    for (const jobId of ['mock_11111111-1111-4111-8111-111111111111', '../etc/passwd', '']) {
        const got = await getReplicateJob({ jobId, modelId: 'black-forest-labs/flux-schnell' }, { env: liveEnv, fetchImpl: noFetch });
        assert.equal(got.ok, false);
        assert.equal(got.status, 400);
        const cancelled = await cancelReplicateJob({ jobId, modelId: 'black-forest-labs/flux-schnell' }, { env: liveEnv, fetchImpl: noFetch });
        assert.equal(cancelled.status, 400);
    }
});

test('cancel posts to the cancel endpoint and maps canceled', async () => {
    const result = await cancelReplicateJob(
        { jobId: predictionId, modelId: 'black-forest-labs/flux-schnell' },
        {
            env: liveEnv,
            fetchImpl: async (url, options) => {
                assert.equal(url, `https://api.replicate.com/v1/predictions/${predictionId}/cancel`);
                assert.equal(options.method, 'POST');
                return jsonResponse({ id: predictionId, status: 'canceled' });
            },
        },
    );
    assert.equal(result.job.status, 'canceled');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/security/replicateProvider.test.js`
Expected: FAIL with `Cannot find module '../../src/lib/replicateProvider.js'`

- [ ] **Step 3: Write the implementation**

```js
import { randomUUID } from 'node:crypto';

import {
    estimateReplicateUsd,
    getReplicateModel,
    validateReplicateInput,
} from './replicateModelRegistry.js';

export const REPLICATE_IMAGE_TOOL_ID = 'replicate_image';
export const REPLICATE_VIDEO_TOOL_ID = 'replicate_video';

const API_BASE = 'https://api.replicate.com/v1';
const CANCEL_AFTER = '10m';
const MAX_PROVIDER_JSON_BYTES = 2 * 1024 * 1024;
const PREDICTION_ID_PATTERN = /^[a-z0-9]{8,40}$/;
const STATUS = Object.freeze({
    starting: 'queued',
    processing: 'processing',
    succeeded: 'completed',
    failed: 'failed',
    canceled: 'canceled',
    aborted: 'canceled',
});

function normalizedString(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function configuredToken(value) {
    const key = normalizedString(value);
    if (!/^[\x21-\x7E]{8,4096}$/.test(key)) return false;
    return !/^(?:<.*>|change-?me|placeholder|your[-_]?api[-_]?token)$/i.test(key);
}

function boundedNumber(value, fallback, minimum, maximum) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(maximum, Math.max(minimum, parsed));
}

function safeText(value, secrets = []) {
    if (typeof value !== 'string') return '';
    let text = value.replace(/[\u0000-\u001F\u007F]/g, ' ');
    for (const secret of secrets) {
        if (typeof secret === 'string' && secret.length >= 3) text = text.split(secret).join('[redacted]');
    }
    return text.replace(/\br8_[A-Za-z0-9_-]{8,}\b/g, '[redacted]').trim().slice(0, 400);
}

export function replicateConfiguration(env = process.env) {
    const requestedMode = normalizedString(env.GENERATION_MODE).toLowerCase() === 'live' ? 'live' : 'mock';
    const liveEnabled = normalizedString(env.REPLICATE_LIVE_ENABLED).toLowerCase() === 'true';
    const apiKey = normalizedString(env.REPLICATE_API_TOKEN);
    const missing = [];
    if (requestedMode === 'live') {
        if (!liveEnabled) missing.push('REPLICATE_LIVE_ENABLED=true');
        if (!configuredToken(apiKey)) missing.push('REPLICATE_API_TOKEN');
    }
    const live = requestedMode === 'live' && missing.length === 0;
    return {
        mode: live ? 'live' : (requestedMode === 'mock' ? 'mock' : 'unconfigured'),
        requestedMode,
        live,
        configured: requestedMode === 'mock' || live,
        missing,
        apiKey: live ? apiKey : '',
        maxUsdPerJob: boundedNumber(env.REPLICATE_MAX_USD_PER_JOB, 1, 0.01, 100),
        maxUsdPerDay: boundedNumber(env.REPLICATE_MAX_USD_PER_DAY, 5, 0.01, 1000),
        jobTimeoutMs: boundedNumber(env.REPLICATE_JOB_TIMEOUT_MS, 20 * 60 * 1000, 60 * 1000, 30 * 60 * 1000),
    };
}

export function replicateProviderStatus(env = process.env) {
    const config = replicateConfiguration(env);
    const label = config.mode === 'live'
        ? 'Live · paid generation enabled'
        : config.mode === 'mock'
            ? 'Mock · no spend'
            : 'Setup Required';
    return {
        id: 'replicate',
        label: 'Replicate',
        capability: 'Image, image-edit and video generation',
        toolIds: [REPLICATE_IMAGE_TOOL_ID, REPLICATE_VIDEO_TOOL_ID],
        configured: config.configured,
        status: label,
        mode: config.mode,
    };
}

export function prepareReplicateRequest({ modelId, input }, { env = process.env, assetUrl } = {}) {
    const config = replicateConfiguration(env);
    if (!config.configured) {
        return { ok: false, status: 503, error: 'Replicate is not configured.', missing: config.missing };
    }
    const model = getReplicateModel(modelId);
    if (!model || !model.enabled) return { ok: false, status: 400, error: 'Unknown or disabled model.' };
    const checked = validateReplicateInput(model, input, { assetUrl });
    if (checked.error) return { ok: false, status: 400, error: checked.error };
    return {
        ok: true,
        model,
        input: checked.value,
        estimateUsd: estimateReplicateUsd(model, checked.value),
        config,
    };
}

async function fetchWithTimeout(fetchImpl, url, options, timeoutMs) {
    try {
        return await fetchImpl(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
        const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
        return { networkError: timedOut ? 'timeout' : 'unavailable' };
    }
}

async function readJson(response) {
    const raw = await response.text();
    if (new TextEncoder().encode(raw).byteLength > MAX_PROVIDER_JSON_BYTES) return { error: 'too_large' };
    try {
        return { value: JSON.parse(raw) };
    } catch {
        return { error: 'invalid' };
    }
}

function networkFailure(result) {
    return {
        ok: false,
        status: result.networkError === 'timeout' ? 504 : 502,
        error: result.networkError === 'timeout' ? 'Replicate request timed out.' : 'Replicate is temporarily unavailable.',
        retryable: true,
    };
}

function providerFailure(response, value, apiKey) {
    const detail = safeText(value?.detail || value?.title || '', [apiKey]);
    const extra = detail ? { detail } : {};
    if (response.status === 401 || response.status === 403) {
        return { ok: false, status: 502, error: 'Replicate rejected the configured API credentials.', retryable: false };
    }
    if (response.status === 402) {
        return { ok: false, status: 402, error: 'Replicate account has insufficient credit.', retryable: false };
    }
    if (response.status === 429) {
        return { ok: false, status: 429, error: 'Replicate rate limit reached.', retryable: true, ...extra };
    }
    if ([400, 404, 409, 422].includes(response.status)) {
        return { ok: false, status: 422, error: 'Replicate rejected the generation request.', retryable: false, ...extra };
    }
    return { ok: false, status: 502, error: 'Replicate is temporarily unavailable.', retryable: true, ...extra };
}

function firstOutputUrl(output) {
    const candidate = Array.isArray(output) ? output[0] : output;
    if (typeof candidate !== 'string' || candidate.length > 4096) return null;
    try {
        const parsed = new URL(candidate);
        return parsed.protocol === 'https:' && !parsed.username && !parsed.password ? parsed.toString() : null;
    } catch {
        return null;
    }
}

function toolIdFor(model) {
    return model.kind === 'image' ? REPLICATE_IMAGE_TOOL_ID : REPLICATE_VIDEO_TOOL_ID;
}

function publicJob(model, value, apiKey) {
    const id = normalizedString(value?.id);
    let status = STATUS[normalizedString(value?.status).toLowerCase()] || 'queued';
    const outputUrl = status === 'completed' ? firstOutputUrl(value?.output) : null;
    let error = null;
    if (status === 'completed' && !outputUrl) {
        status = 'failed';
        error = 'Replicate finished without a usable output.';
    } else if (status === 'failed') {
        error = safeText(value?.error, [apiKey]) || 'Replicate generation failed.';
    }
    return {
        provider: 'replicate',
        toolId: toolIdFor(model),
        kind: model.kind,
        jobId: PREDICTION_ID_PATTERN.test(id) ? id : null,
        status,
        outputUrl,
        model: model.id,
        mode: 'live',
        mock: false,
        error,
    };
}

export async function submitReplicateJob(prepared, {
    env = process.env,
    fetchImpl = fetch,
    idGenerator = randomUUID,
    timeoutMs = 30_000,
} = {}) {
    const { model, input, config } = prepared;
    if (config.mode === 'mock') {
        return {
            ok: true,
            status: 200,
            job: {
                provider: 'replicate',
                toolId: toolIdFor(model),
                kind: model.kind,
                jobId: `mock_${idGenerator()}`,
                status: 'completed',
                outputUrl: null,
                model: model.id,
                mode: 'mock',
                mock: true,
                error: null,
            },
        };
    }
    const liveConfig = replicateConfiguration(env);
    if (!liveConfig.live) {
        return { ok: false, status: 503, error: 'Replicate is not configured.', missing: liveConfig.missing };
    }
    const result = await fetchWithTimeout(fetchImpl, `${API_BASE}/models/${model.id}/predictions`, {
        method: 'POST',
        headers: {
            authorization: `Bearer ${liveConfig.apiKey}`,
            'content-type': 'application/json',
            'cancel-after': CANCEL_AFTER,
        },
        body: JSON.stringify({ input }),
    }, timeoutMs);
    if (result.networkError) return networkFailure(result);
    const decoded = await readJson(result);
    if (decoded.error) return { ok: false, status: 502, error: 'Replicate returned an invalid response.', retryable: true };
    if (!result.ok) return providerFailure(result, decoded.value, liveConfig.apiKey);
    const job = publicJob(model, decoded.value, liveConfig.apiKey);
    if (!job.jobId) return { ok: false, status: 502, error: 'Replicate returned no valid prediction ID.' };
    return { ok: true, status: job.status === 'completed' ? 200 : 202, job };
}

async function predictionRequest({ jobId, modelId }, suffix, method, { env, fetchImpl, timeoutMs }) {
    const config = replicateConfiguration(env);
    if (!config.live) {
        return { ok: false, status: 503, error: 'Replicate is not configured.', missing: config.missing, retryable: false };
    }
    const model = getReplicateModel(modelId);
    if (!model) return { ok: false, status: 400, error: 'Unknown model.', retryable: false };
    if (typeof jobId !== 'string' || !PREDICTION_ID_PATTERN.test(jobId)) {
        return { ok: false, status: 400, error: 'A valid Replicate prediction ID is required.', retryable: false };
    }
    const result = await fetchWithTimeout(fetchImpl, `${API_BASE}/predictions/${jobId}${suffix}`, {
        method,
        headers: { authorization: `Bearer ${config.apiKey}` },
    }, timeoutMs);
    if (result.networkError) return networkFailure(result);
    const decoded = await readJson(result);
    if (decoded.error) return { ok: false, status: 502, error: 'Replicate returned an invalid response.', retryable: true };
    if (!result.ok) return providerFailure(result, decoded.value, config.apiKey);
    return { ok: true, status: 200, job: publicJob(model, decoded.value, config.apiKey) };
}

export function getReplicateJob(ref, { env = process.env, fetchImpl = fetch, timeoutMs = 30_000 } = {}) {
    return predictionRequest(ref, '', 'GET', { env, fetchImpl, timeoutMs });
}

export function cancelReplicateJob(ref, { env = process.env, fetchImpl = fetch, timeoutMs = 30_000 } = {}) {
    return predictionRequest(ref, '/cancel', 'POST', { env, fetchImpl, timeoutMs });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/security/replicateProvider.test.js`
Expected: PASS (9 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/replicateProvider.js tests/security/replicateProvider.test.js
git commit -m "feat: add mock-by-default Replicate provider adapter

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Generation guard (quotes, caps, duplicate lock, job records)

**Files:**
- Create: `src/lib/generationGuard.js`
- Test: `tests/security/generationGuard.test.js`

**Interfaces:**
- Consumes: a `blobStore` with the `{ get, put }` shape of `creatorProjectStoreForTests()` (exported from `src/lib/creatorProjectStore.js`).
- Produces:
  - `class GenerationGuardError extends Error { code, status }`
  - `generationOwnerKey(user, env): string`
  - `requestFingerprint(ownerKey, modelId, input): string`
  - `issueQuote({ user, env, modelId, input, estimateUsd, now }): { token, estimateUsd, expiresAt }`
  - `verifyQuote(token, { user, env, modelId, input, estimateUsd, now }): boolean`
  - `reserveGeneration({ user, env, blobStore, mode, modelId, input, estimateUsd, quoteToken, limits, now }): { ownerKey, fingerprint, lockPath, ledgerDay, estimateUsd }` (throws `GenerationGuardError`)
  - `releaseGeneration({ user, env, blobStore, reservation, now }): Promise<void>` (expires lock, refunds spend)
  - `refundSpend({ user, env, blobStore, ledgerDay, estimateUsd }): Promise<void>`
  - `saveJobRecord(user, record, { env, blobStore })` / `loadJobRecord(user, jobId, { env, blobStore }): record | null`

- [ ] **Step 1: Write the failing test**

```js
import assert from 'node:assert/strict';
import test from 'node:test';

import { creatorProjectStoreForTests } from '../../src/lib/creatorProjectStore.js';
import {
    GenerationGuardError,
    issueQuote,
    loadJobRecord,
    refundSpend,
    releaseGeneration,
    requestFingerprint,
    reserveGeneration,
    saveJobRecord,
    verifyQuote,
    generationOwnerKey,
} from '../../src/lib/generationGuard.js';

const env = {
    BLOB_READ_WRITE_TOKEN: 'vercel-blob-test-token-that-is-long-enough',
    CREATOR_SESSION_SECRET: 'creator-project-test-secret-that-is-longer-than-thirty-two-characters',
};
const owner = { id: 12345678, login: 'a' };
const other = { id: 87654321, login: 'b' };
const limits = { maxUsdPerJob: 1, maxUsdPerDay: 1 };
const model = 'black-forest-labs/flux-2-pro';
const now = Date.UTC(2026, 9, 8, 12, 0, 0);

async function expectCode(promise, code, status) {
    await assert.rejects(promise, (error) => error instanceof GenerationGuardError && error.code === code && error.status === status);
}

test('owner keys are stable per user and differ across users', () => {
    assert.equal(generationOwnerKey(owner, env), generationOwnerKey(owner, env));
    assert.notEqual(generationOwnerKey(owner, env), generationOwnerKey(other, env));
    assert.throws(() => generationOwnerKey({ id: 'abc' }, env), GenerationGuardError);
});

test('fingerprints ignore key order and differ when inputs differ', () => {
    const key = generationOwnerKey(owner, env);
    assert.equal(
        requestFingerprint(key, model, { prompt: 'a', aspect_ratio: '1:1' }),
        requestFingerprint(key, model, { aspect_ratio: '1:1', prompt: 'a' }),
    );
    assert.notEqual(requestFingerprint(key, model, { prompt: 'a' }), requestFingerprint(key, model, { prompt: 'b' }));
});

test('quotes bind owner, model, input, estimate and expiry', () => {
    const input = { prompt: 'fox' };
    const quote = issueQuote({ user: owner, env, modelId: model, input, estimateUsd: 0.015, now });
    const check = (overrides = {}) => verifyQuote(quote.token, { user: owner, env, modelId: model, input, estimateUsd: 0.015, now: now + 1000, ...overrides });
    assert.equal(check(), true);
    assert.equal(check({ user: other }), false);
    assert.equal(check({ input: { prompt: 'cat' } }), false);
    assert.equal(check({ modelId: 'black-forest-labs/flux-schnell' }), false);
    assert.equal(check({ estimateUsd: 0.02 }), false);
    assert.equal(check({ now: now + 6 * 60 * 1000 }), false);
    assert.equal(verifyQuote('garbage', { user: owner, env, modelId: model, input, estimateUsd: 0.015, now }), false);
    assert.equal(verifyQuote(undefined, { user: owner, env, modelId: model, input, estimateUsd: 0.015, now }), false);
});

test('live reservation requires a valid quote and respects the per-job cap', async () => {
    const blobStore = creatorProjectStoreForTests(new Map());
    const input = { prompt: 'fox' };
    await expectCode(
        reserveGeneration({ user: owner, env, blobStore, mode: 'live', modelId: model, input, estimateUsd: 0.015, limits, now }),
        'confirmation_required',
        428,
    );
    const quote = issueQuote({ user: owner, env, modelId: model, input, estimateUsd: 1.5, now });
    await expectCode(
        reserveGeneration({ user: owner, env, blobStore, mode: 'live', modelId: model, input, estimateUsd: 1.5, quoteToken: quote.token, limits, now }),
        'job_limit',
        402,
    );
});

test('duplicate submissions are blocked until the lock expires', async () => {
    const blobStore = creatorProjectStoreForTests(new Map());
    const args = { user: owner, env, blobStore, mode: 'mock', modelId: model, input: { prompt: 'fox' }, estimateUsd: 0.015, limits };
    await reserveGeneration({ ...args, now });
    await expectCode(reserveGeneration({ ...args, now: now + 1000 }), 'duplicate_submission', 409);
    await reserveGeneration({ ...args, input: { prompt: 'different' }, now: now + 1000 });
    await reserveGeneration({ ...args, now: now + 61_000 });
});

test('releaseGeneration frees the lock immediately', async () => {
    const blobStore = creatorProjectStoreForTests(new Map());
    const args = { user: owner, env, blobStore, mode: 'mock', modelId: model, input: { prompt: 'fox' }, estimateUsd: 0.015, limits };
    const reservation = await reserveGeneration({ ...args, now });
    await releaseGeneration({ user: owner, env, blobStore, reservation, now: now + 10 });
    await reserveGeneration({ ...args, now: now + 20 });
});

test('mock mode never touches the spend ledger', async () => {
    const records = new Map();
    const blobStore = creatorProjectStoreForTests(records);
    const reservation = await reserveGeneration({ user: owner, env, blobStore, mode: 'mock', modelId: model, input: { prompt: 'fox' }, estimateUsd: 0.5, limits, now });
    assert.equal(reservation.ledgerDay, null);
    assert.equal([...records.keys()].some((key) => key.includes('/ledger/')), false);
});

test('daily cap is enforced for live spend and refunds restore headroom', async () => {
    const blobStore = creatorProjectStoreForTests(new Map());
    const reserve = (prompt, estimateUsd) => {
        const input = { prompt };
        const quote = issueQuote({ user: owner, env, modelId: model, input, estimateUsd, now });
        return reserveGeneration({ user: owner, env, blobStore, mode: 'live', modelId: model, input, estimateUsd, quoteToken: quote.token, limits, now });
    };
    const first = await reserve('one', 0.6);
    assert.equal(first.ledgerDay, '2026-10-08');
    await expectCode(reserve('two', 0.6), 'daily_limit', 402);
    await refundSpend({ user: owner, env, blobStore, ledgerDay: first.ledgerDay, estimateUsd: 0.6 });
    await reserve('two', 0.6);
    await refundSpend({ user: owner, env, blobStore, ledgerDay: first.ledgerDay, estimateUsd: 99 });
    await reserve('three', 1);
});

test('job records are owner-bound and ids are validated', async () => {
    const blobStore = creatorProjectStoreForTests(new Map());
    await saveJobRecord(owner, { jobId: 'abc123def456ghi789jkl012mn', status: 'queued' }, { env, blobStore });
    assert.equal((await loadJobRecord(owner, 'abc123def456ghi789jkl012mn', { env, blobStore })).status, 'queued');
    assert.equal(await loadJobRecord(other, 'abc123def456ghi789jkl012mn', { env, blobStore }), null);
    assert.equal(await loadJobRecord(owner, '../../creator-projects/x', { env, blobStore }), null);
    await assert.rejects(saveJobRecord(owner, { jobId: '../x' }, { env, blobStore }), GenerationGuardError);
});

test('unconfigured storage fails closed', async () => {
    const blobStore = creatorProjectStoreForTests(new Map());
    await expectCode(
        reserveGeneration({ user: owner, env: { CREATOR_SESSION_SECRET: env.CREATOR_SESSION_SECRET }, blobStore, mode: 'mock', modelId: model, input: { prompt: 'x' }, estimateUsd: 0.01, limits, now }),
        'unconfigured',
        503,
    );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/security/generationGuard.test.js`
Expected: FAIL with `Cannot find module '../../src/lib/generationGuard.js'`

- [ ] **Step 3: Write the implementation**

```js
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

const ROOT = 'creator-generation';
const LOCK_TTL_MS = 60 * 1000;
const QUOTE_TTL_MS = 5 * 60 * 1000;
const JOB_ID_PATTERN = /^[A-Za-z0-9_-]{3,60}$/;

export class GenerationGuardError extends Error {
    constructor(code, message, status = 400) {
        super(message);
        this.name = 'GenerationGuardError';
        this.code = code;
        this.status = status;
    }
}

function normalized(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function sessionSecret(env) {
    const secret = normalized(env.CREATOR_SESSION_SECRET);
    if (secret.length < 32) {
        throw new GenerationGuardError('unconfigured', 'Generation controls are not configured.', 503);
    }
    return secret;
}

export function generationOwnerKey(user, env = process.env) {
    const subject = String(user?.id ?? '').trim();
    if (!/^\d+$/.test(subject)) throw new GenerationGuardError('invalid_owner', 'Creator owner identity is invalid.', 403);
    return createHmac('sha256', sessionSecret(env)).update(`generation-owner:${subject}`, 'utf8').digest('hex').slice(0, 40);
}

function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
    }
    return value;
}

export function requestFingerprint(ownerKey, modelId, input) {
    return createHash('sha256').update(JSON.stringify([ownerKey, modelId, canonical(input)])).digest('hex');
}

function quoteSignature(env, payload) {
    return createHmac('sha256', sessionSecret(env)).update(`generation-quote:${payload}`, 'utf8').digest('base64url');
}

function quotePayload({ user, env, modelId, input, estimateUsd }, expiresAt) {
    const fingerprint = requestFingerprint(generationOwnerKey(user, env), modelId, input);
    return `${fingerprint}.${Number(estimateUsd).toFixed(4)}.${expiresAt}`;
}

export function issueQuote({ user, env, modelId, input, estimateUsd, now = Date.now() }) {
    const expiresAt = now + QUOTE_TTL_MS;
    const signature = quoteSignature(env, quotePayload({ user, env, modelId, input, estimateUsd }, expiresAt));
    return { token: `${expiresAt}.${signature}`, estimateUsd, expiresAt };
}

export function verifyQuote(token, { user, env, modelId, input, estimateUsd, now = Date.now() }) {
    if (typeof token !== 'string') return false;
    const separator = token.indexOf('.');
    if (separator < 1) return false;
    const expiresAtText = token.slice(0, separator);
    const given = token.slice(separator + 1);
    if (!/^\d{10,16}$/.test(expiresAtText)) return false;
    const expiresAt = Number(expiresAtText);
    if (expiresAt < now) return false;
    const expected = quoteSignature(env, quotePayload({ user, env, modelId, input, estimateUsd }, expiresAt));
    const a = Buffer.from(given);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
}

function storeAccess(env, blobStore) {
    const token = normalized(env.BLOB_READ_WRITE_TOKEN);
    if (token.length < 20) throw new GenerationGuardError('unconfigured', 'Generation storage is not configured.', 503);
    return {
        async read(pathname) {
            let result;
            try {
                result = await blobStore.get(pathname, { token, access: 'private', useCache: false });
            } catch {
                throw new GenerationGuardError('storage_unavailable', 'Generation storage is temporarily unavailable.', 503);
            }
            if (!result) return null;
            let text = '';
            if (typeof result.text === 'function') text = await result.text();
            else if (result.stream) text = await new Response(result.stream).text();
            else if (result.body) text = await new Response(result.body).text();
            try {
                return JSON.parse(text);
            } catch {
                return null;
            }
        },
        async write(pathname, value, { overwrite = true } = {}) {
            try {
                await blobStore.put(pathname, JSON.stringify(value), {
                    token,
                    access: 'private',
                    addRandomSuffix: false,
                    allowOverwrite: overwrite,
                    contentType: 'application/json',
                });
            } catch (error) {
                if (!overwrite) throw error;
                throw new GenerationGuardError('storage_unavailable', 'Generation storage is temporarily unavailable.', 503);
            }
        },
    };
}

function round4(value) {
    return Math.round(value * 10_000) / 10_000;
}

export async function reserveGeneration({
    user,
    env,
    blobStore,
    mode,
    modelId,
    input,
    estimateUsd,
    quoteToken,
    limits,
    now = Date.now(),
}) {
    const ownerKey = generationOwnerKey(user, env);
    if (estimateUsd > limits.maxUsdPerJob) {
        throw new GenerationGuardError('job_limit', 'Estimated cost exceeds the per-generation limit.', 402);
    }
    if (mode === 'live' && !verifyQuote(quoteToken, { user, env, modelId, input, estimateUsd, now })) {
        throw new GenerationGuardError('confirmation_required', 'Review the estimated cost and confirm before generating.', 428);
    }
    const store = storeAccess(env, blobStore);

    let ledgerDay = null;
    let ledger = null;
    let ledgerPath = null;
    if (mode === 'live') {
        ledgerDay = new Date(now).toISOString().slice(0, 10);
        ledgerPath = `${ROOT}/${ownerKey}/ledger/${ledgerDay}.json`;
        ledger = (await store.read(ledgerPath)) || { day: ledgerDay, spentUsd: 0, jobs: 0 };
        if (round4(ledger.spentUsd + estimateUsd) > limits.maxUsdPerDay) {
            throw new GenerationGuardError('daily_limit', 'Daily generation spend limit reached.', 402);
        }
    }

    const fingerprint = requestFingerprint(ownerKey, modelId, input);
    const lockPath = `${ROOT}/${ownerKey}/locks/${fingerprint}.json`;
    const existing = await store.read(lockPath);
    if (existing && existing.expiresAt > now) {
        throw new GenerationGuardError('duplicate_submission', 'An identical generation was just submitted. Please wait.', 409);
    }
    try {
        await store.write(lockPath, { expiresAt: now + LOCK_TTL_MS }, { overwrite: Boolean(existing) });
    } catch {
        throw new GenerationGuardError('duplicate_submission', 'An identical generation was just submitted. Please wait.', 409);
    }

    if (ledger) {
        ledger.spentUsd = round4(ledger.spentUsd + estimateUsd);
        ledger.jobs += 1;
        await store.write(ledgerPath, ledger);
    }
    return { ownerKey, fingerprint, lockPath, ledgerDay, estimateUsd };
}

export async function refundSpend({ user, env, blobStore, ledgerDay, estimateUsd }) {
    if (!ledgerDay) return;
    const store = storeAccess(env, blobStore);
    const path = `${ROOT}/${generationOwnerKey(user, env)}/ledger/${ledgerDay}.json`;
    const ledger = await store.read(path);
    if (!ledger) return;
    ledger.spentUsd = Math.max(0, round4(ledger.spentUsd - estimateUsd));
    await store.write(path, ledger);
}

export async function releaseGeneration({ user, env, blobStore, reservation, now = Date.now() }) {
    const store = storeAccess(env, blobStore);
    await store.write(reservation.lockPath, { expiresAt: now - 1 });
    await refundSpend({ user, env, blobStore, ledgerDay: reservation.ledgerDay, estimateUsd: reservation.estimateUsd });
}

function jobPath(user, jobId, env) {
    return `${ROOT}/${generationOwnerKey(user, env)}/jobs/${jobId}.json`;
}

export async function saveJobRecord(user, record, { env, blobStore }) {
    if (!JOB_ID_PATTERN.test(String(record?.jobId ?? ''))) {
        throw new GenerationGuardError('invalid_job', 'A valid job ID is required.', 400);
    }
    await storeAccess(env, blobStore).write(jobPath(user, record.jobId, env), record);
}

export async function loadJobRecord(user, jobId, { env, blobStore }) {
    if (!JOB_ID_PATTERN.test(String(jobId ?? ''))) return null;
    return storeAccess(env, blobStore).read(jobPath(user, jobId, env));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/security/generationGuard.test.js`
Expected: PASS (9 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/generationGuard.js tests/security/generationGuard.test.js
git commit -m "feat: add generation guard with signed quotes, spend caps and duplicate lock

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Persist generated media to the Asset library

**Files:**
- Create: `src/lib/replicatePersist.js`
- Test: `tests/security/replicatePersist.test.js`

**Interfaces:**
- Consumes: `addCreatorAsset`, `creatorAssetStorageConfiguration`, `creatorAssetUploadPrefix`, `CreatorProjectError` from `src/lib/creatorProjectStore.js`.
- Produces:
  - `class PersistError extends Error { code, status }`
  - `isReplicateDeliveryUrl(value: string): boolean`
  - `persistGeneratedAsset({ user, projectId, record, outputUrl, env, fetchImpl, assetBlobStore, blobStore, now, idGenerator }): Promise<{ asset, created }>` where `record` has `{ jobId, kind, model, mock, prompt }`. Mock records store a 1x1 PNG placeholder typed as `graphic`; live records download `outputUrl`.

- [ ] **Step 1: Write the failing test**

```js
import assert from 'node:assert/strict';
import test from 'node:test';

import {
    createCreatorProject,
    creatorProjectStoreForTests,
    getCreatorProject,
} from '../../src/lib/creatorProjectStore.js';
import { PersistError, isReplicateDeliveryUrl, persistGeneratedAsset } from '../../src/lib/replicatePersist.js';

const env = {
    BLOB_READ_WRITE_TOKEN: 'vercel-blob-test-token-that-is-long-enough',
    CREATOR_ASSET_BLOB_READ_WRITE_TOKEN: 'creator-public-blob-test-token-that-is-long-enough',
    CREATOR_SESSION_SECRET: 'creator-project-test-secret-that-is-longer-than-thirty-two-characters',
};
const owner = { id: 12345678, login: 'a' };
const other = { id: 87654321, login: 'b' };
const projectId = '11111111-1111-4111-8111-111111111111';
const record = { jobId: 'abc123def456ghi789jkl012mn', kind: 'image', model: 'black-forest-labs/flux-schnell', mock: false, prompt: 'a red fox' };

function assetStore() {
    const puts = [];
    return {
        puts,
        async put(pathname, body, options) {
            puts.push({ pathname, size: body.length, options });
            return { url: `https://creator.public.blob.vercel-storage.com/${pathname}`, pathname };
        },
        async del() {},
    };
}

async function setup() {
    const blobStore = creatorProjectStoreForTests(new Map());
    await createCreatorProject(owner, { name: 'P' }, { env, blobStore, idGenerator: () => projectId });
    return { blobStore, assetBlobStore: assetStore() };
}

function mediaResponse(type, bytes = Buffer.from('fake-media')) {
    return new Response(bytes, { status: 200, headers: { 'content-type': type, 'content-length': String(bytes.length) } });
}

test('only replicate.delivery HTTPS URLs are downloadable', () => {
    assert.equal(isReplicateDeliveryUrl('https://replicate.delivery/xezq/a/out.png'), true);
    assert.equal(isReplicateDeliveryUrl('https://pbxt.replicate.delivery/a.png'), true);
    for (const bad of ['http://replicate.delivery/a.png', 'https://evil.test/a.png', 'https://replicate.delivery.evil.test/a.png', 'https://user:pw@replicate.delivery/a.png', 'https://127.0.0.1/a.png', 'not a url']) {
        assert.equal(isReplicateDeliveryUrl(bad), false, bad);
    }
});

test('live output is downloaded once, stored publicly at a deterministic path and added as an Asset', async () => {
    const { blobStore, assetBlobStore } = await setup();
    let downloads = 0;
    const fetchImpl = async (url, options) => {
        downloads += 1;
        assert.equal(url, 'https://replicate.delivery/xezq/a/out.png');
        assert.equal(options.redirect, 'error');
        return mediaResponse('image/png');
    };
    const args = { user: owner, projectId, record, outputUrl: 'https://replicate.delivery/xezq/a/out.png', env, fetchImpl, assetBlobStore, blobStore, idGenerator: () => '22222222-2222-4222-8222-222222222222' };
    const first = await persistGeneratedAsset(args);
    assert.equal(first.created, true);
    assert.equal(first.asset.type, 'image');
    assert.equal(first.asset.source, 'replicate');
    assert.equal(first.asset.provider.requestId, record.jobId);
    assert.equal(assetBlobStore.puts[0].pathname, `creator-assets/${projectId}/replicate-${record.jobId}.png`);
    assert.equal(assetBlobStore.puts[0].options.access, 'public');
    const second = await persistGeneratedAsset(args);
    assert.equal(second.created, false);
    assert.equal(second.asset.id, first.asset.id);
    assert.equal((await getCreatorProject(owner, projectId, { env, blobStore })).assets.length, 1);
    assert.equal(downloads, 2);
});

test('mock records store a placeholder PNG typed as a graphic with no download', async () => {
    const { blobStore, assetBlobStore } = await setup();
    const result = await persistGeneratedAsset({
        user: owner,
        projectId,
        record: { ...record, jobId: 'mock_11111111-1111-4111-8111-111111111111', mock: true },
        outputUrl: null,
        env,
        fetchImpl: () => { throw new Error('no download in mock mode'); },
        assetBlobStore,
        blobStore,
    });
    assert.equal(result.asset.type, 'graphic');
    assert.equal(assetBlobStore.puts[0].options.contentType, 'image/png');
    assert.ok(assetBlobStore.puts[0].size > 20);
});

test('unsafe or unusable outputs are rejected and nothing is stored', async () => {
    const { blobStore, assetBlobStore } = await setup();
    const base = { user: owner, projectId, record, env, assetBlobStore, blobStore };
    await assert.rejects(persistGeneratedAsset({ ...base, outputUrl: 'https://evil.test/a.png', fetchImpl: () => { throw new Error('must not fetch'); } }), (e) => e instanceof PersistError && e.status === 502);
    await assert.rejects(persistGeneratedAsset({ ...base, outputUrl: 'https://replicate.delivery/a.html', fetchImpl: async () => mediaResponse('text/html') }), (e) => e instanceof PersistError && e.code === 'unexpected_media_type');
    await assert.rejects(persistGeneratedAsset({ ...base, outputUrl: 'https://replicate.delivery/a.mp4', fetchImpl: async () => mediaResponse('video/mp4') }), (e) => e instanceof PersistError && e.code === 'unexpected_media_type');
    await assert.rejects(persistGeneratedAsset({ ...base, outputUrl: 'https://replicate.delivery/a.png', fetchImpl: async () => new Response('x', { status: 500 }) }), (e) => e instanceof PersistError && e.status === 502);
    await assert.rejects(persistGeneratedAsset({ ...base, outputUrl: 'https://replicate.delivery/a.png', fetchImpl: async () => { throw new Error('net'); } }), (e) => e instanceof PersistError && e.code === 'download_failed');
    const huge = new Response('x', { status: 200, headers: { 'content-type': 'image/png', 'content-length': String(300 * 1024 * 1024) } });
    await assert.rejects(persistGeneratedAsset({ ...base, outputUrl: 'https://replicate.delivery/a.png', fetchImpl: async () => huge }), (e) => e instanceof PersistError && e.status === 413);
    assert.equal(assetBlobStore.puts.length, 0);
});

test('missing asset storage configuration and foreign Projects fail without storing', async () => {
    const { blobStore, assetBlobStore } = await setup();
    const fetchImpl = async () => mediaResponse('image/png');
    const outputUrl = 'https://replicate.delivery/a.png';
    const { CREATOR_ASSET_BLOB_READ_WRITE_TOKEN: _omit, ...noAssetEnv } = env;
    await assert.rejects(persistGeneratedAsset({ user: owner, projectId, record, outputUrl, env: noAssetEnv, fetchImpl, assetBlobStore, blobStore }), (e) => e instanceof PersistError && e.status === 503);
    await assert.rejects(persistGeneratedAsset({ user: other, projectId, record, outputUrl, env, fetchImpl, assetBlobStore, blobStore }), (e) => e.status === 404);
    assert.equal(assetBlobStore.puts.length, 0);
});
```

Note on the last test: the foreign-Project check must run before the upload. Step 3 implements this by calling `getCreatorProject(user, projectId, ...)` first.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/security/replicatePersist.test.js`
Expected: FAIL with `Cannot find module '../../src/lib/replicatePersist.js'`

- [ ] **Step 3: Write the implementation**

Also export the default store in `src/lib/creatorProjectStore.js` (line 41): change `const defaultBlobStore = {` to `export const defaultBlobStore = {`.

```js
import { isIP } from 'node:net';

import {
    addCreatorAsset,
    creatorAssetStorageConfiguration,
    creatorAssetUploadPrefix,
    defaultBlobStore,
    getCreatorProject,
} from './creatorProjectStore.js';

const MAX_MEDIA_BYTES = 250 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 60 * 1000;
const EXTENSIONS = Object.freeze({
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'video/mp4': 'mp4',
    'video/webm': 'webm',
});
// 1x1 PNG used as the stored output of mock generations.
const MOCK_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
);

export class PersistError extends Error {
    constructor(code, message, status = 502) {
        super(message);
        this.name = 'PersistError';
        this.code = code;
        this.status = status;
    }
}

export function isReplicateDeliveryUrl(value) {
    if (typeof value !== 'string' || value.length > 4096) return false;
    try {
        const url = new URL(value);
        const host = url.hostname.toLowerCase();
        return url.protocol === 'https:'
            && !url.username
            && !url.password
            && isIP(host) === 0
            && (host === 'replicate.delivery' || host.endsWith('.replicate.delivery'));
    } catch {
        return false;
    }
}

async function downloadOutput(outputUrl, kind, fetchImpl) {
    if (!isReplicateDeliveryUrl(outputUrl)) {
        throw new PersistError('output_not_allowed', 'The generated output is not on an allowed host.');
    }
    let response;
    try {
        response = await fetchImpl(outputUrl, { redirect: 'error', signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    } catch {
        throw new PersistError('download_failed', 'Could not download the generated output.');
    }
    if (!response.ok) throw new PersistError('download_failed', 'The generated output is no longer available.');
    const tooLarge = new PersistError('output_too_large', 'The generated output is too large.', 413);
    if (Number(response.headers?.get?.('content-length') || 0) > MAX_MEDIA_BYTES) throw tooLarge;
    const contentType = String(response.headers?.get?.('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!EXTENSIONS[contentType] || !contentType.startsWith(`${kind}/`)) {
        throw new PersistError('unexpected_media_type', 'The generated output has an unexpected media type.');
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_MEDIA_BYTES) throw tooLarge;
    return { bytes, contentType };
}

export async function persistGeneratedAsset({
    user,
    projectId,
    record,
    outputUrl,
    env = process.env,
    fetchImpl = fetch,
    assetBlobStore = defaultBlobStore,
    blobStore = defaultBlobStore,
    now = Date.now(),
    idGenerator,
}) {
    const assetConfiguration = creatorAssetStorageConfiguration(env);
    if (!assetConfiguration.configured) {
        throw new PersistError('asset_storage_unconfigured', 'Asset storage is not configured.', 503);
    }
    // Ownership check first: throws a 404 CreatorProjectError for foreign or missing Projects.
    await getCreatorProject(user, projectId, { env, blobStore });

    const media = record.mock
        ? { bytes: MOCK_PNG, contentType: 'image/png' }
        : await downloadOutput(outputUrl, record.kind, fetchImpl);
    const storagePath = `${creatorAssetUploadPrefix(projectId)}replicate-${record.jobId}.${EXTENSIONS[media.contentType]}`;
    let uploaded;
    try {
        uploaded = await assetBlobStore.put(storagePath, media.bytes, {
            token: assetConfiguration.blobToken,
            access: 'public',
            addRandomSuffix: false,
            allowOverwrite: true,
            contentType: media.contentType,
        });
    } catch {
        throw new PersistError('upload_failed', 'The generated output could not be stored.');
    }
    return addCreatorAsset(user, projectId, {
        type: record.mock ? 'graphic' : record.kind,
        title: String(record.prompt || 'Generated asset').slice(0, 160),
        url: uploaded.url,
        storagePath,
        source: 'replicate',
        mimeType: media.contentType,
        size: media.bytes.length,
        provider: { provider: 'replicate', model: record.model, jobId: record.jobId },
    }, { env, blobStore, now, ...(idGenerator ? { idGenerator } : {}) });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/security/replicatePersist.test.js`
Expected: PASS (5 tests). If the second persist call in the "downloaded once" test shows `downloads === 2`, that is correct: persistence is idempotent at the Asset level (same path, same URL), while the *gateway* in Task 5 avoids the second download by checking `record.asset`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/replicatePersist.js src/lib/creatorProjectStore.js tests/security/replicatePersist.test.js
git commit -m "feat: copy Replicate outputs into persistent Asset storage

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Gateway handlers and route wiring

**Files:**
- Create: `src/lib/replicateGateway.js`
- Modify: `src/lib/creatorProviderGateway.js:163` (`async function parseCreatorJson` becomes `export async function parseCreatorJson`)
- Modify: `app/api/creator/[[...path]]/route.js` (import the five handlers; add five `case` lines before `default:`)
- Test: `tests/security/replicateGateway.test.js`

**Interfaces:**
- Consumes: Tasks 1-4, `authorizeCreatorRequest`, `creatorJson`, `parseCreatorJson` from `creatorProviderGateway.js`, `getCreatorProject`, `safeCreatorAssetUrl`, `CreatorProjectError`, `defaultBlobStore` from `creatorProjectStore.js`.
- Produces handlers `(request, { env, fetchImpl, blobStore, assetBlobStore, now, idGenerator }) => Response`:
  - `handleReplicateModels` (`GET replicate/models`) returns `{ mode, provider, models }`
  - `handleReplicateQuote` (`POST replicate/quote`, body `{ model, input }`) returns `{ estimateUsd, display, quoteToken, expiresAt, mode, maxUsdPerJob }`
  - `handleReplicateGenerate` (`POST replicate/generate`, body `{ model, input, projectId, quoteToken? }`) returns `{ job }` (200 mock complete, 202 live queued)
  - `handleReplicateStatus` (`GET replicate/status?id=`) returns `{ job }`
  - `handleReplicateCancel` (`POST replicate/cancel`, body `{ id }`) returns `{ job }`
  - Client job shape: `{ provider, toolId, kind, jobId, status, model, mode, mock, error, estimateUsd, asset: {id,url,type} | null }` (never `outputUrl`).
  - Job record shape (stored): `{ jobId, model, kind, mock, status, projectId, userId, prompt, estimateUsd, ledgerDay, refunded, asset, error, createdAt, updatedAt }`.

- [ ] **Step 1: Write the failing test**

```js
import assert from 'node:assert/strict';
import test from 'node:test';

import { createCreatorSession, creatorCookieSettings } from '../../src/lib/creatorAuth.js';
import { createCreatorProject, creatorProjectStoreForTests, getCreatorProject } from '../../src/lib/creatorProjectStore.js';
import {
    handleReplicateCancel,
    handleReplicateGenerate,
    handleReplicateModels,
    handleReplicateQuote,
    handleReplicateStatus,
} from '../../src/lib/replicateGateway.js';
import { resetRateLimitStore } from '../../src/lib/rateLimit.js';

const baseEnv = {
    BLOB_READ_WRITE_TOKEN: 'vercel-blob-test-token-that-is-long-enough',
    CREATOR_ASSET_BLOB_READ_WRITE_TOKEN: 'creator-public-blob-test-token-that-is-long-enough',
    CREATOR_SESSION_SECRET: 'creator-project-test-secret-that-is-longer-than-thirty-two-characters',
    CREATOR_GITHUB_ALLOWED_USER_IDS: '12345678,87654321',
    CREATOR_GITHUB_ALLOWED_LOGINS: 'lalambert1982-eng,other-owner',
    CREATOR_STUDIO_RATE_LIMIT: '200',
    CREATOR_STUDIO_STATUS_RATE_LIMIT: '200',
    CONTENT_SAFETY_MODE: 'enforce',
};
const liveEnv = { ...baseEnv, GENERATION_MODE: 'live', REPLICATE_LIVE_ENABLED: 'true', REPLICATE_API_TOKEN: 'r8_test_token_value_1234567890' };
const owner = { id: 12345678, login: 'lalambert1982-eng' };
const other = { id: 87654321, login: 'other-owner' };
const projectId = '11111111-1111-4111-8111-111111111111';
const predictionId = 'abc123def456ghi789jkl012mn';
const cookieName = creatorCookieSettings(baseEnv).sessionName;
const model = 'black-forest-labs/flux-schnell';

function call(path, body, user = owner) {
    const session = createCreatorSession(user, { env: baseEnv });
    return new Request(`https://local.test/api/creator/${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
            cookie: `${cookieName}=${session}`,
            ...(body === undefined ? {} : { 'content-type': 'application/json', origin: 'https://local.test', 'sec-fetch-site': 'same-origin' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
}

function assetStore() {
    const puts = [];
    return {
        puts,
        async put(pathname, body, options) {
            puts.push({ pathname, options });
            return { url: `https://creator.public.blob.vercel-storage.com/${pathname}`, pathname };
        },
        async del() {},
    };
}

async function setup(env) {
    resetRateLimitStore();
    const blobStore = creatorProjectStoreForTests(new Map());
    await createCreatorProject(owner, { name: 'P' }, { env, blobStore, idGenerator: () => projectId });
    return { blobStore, assetBlobStore: assetStore(), env };
}

function replicateFetch({ onDownload, status = 'succeeded', output = ['https://replicate.delivery/x/out.png'] } = {}) {
    const log = { creates: 0, gets: 0, cancels: 0, downloads: 0 };
    const fetchImpl = async (url, options = {}) => {
        if (url.endsWith('/predictions') && options.method === 'POST') {
            log.creates += 1;
            return new Response(JSON.stringify({ id: predictionId, status: 'starting' }), { status: 201 });
        }
        if (url.endsWith('/cancel')) {
            log.cancels += 1;
            return new Response(JSON.stringify({ id: predictionId, status: 'canceled' }), { status: 200 });
        }
        if (url.startsWith('https://api.replicate.com/v1/predictions/')) {
            log.gets += 1;
            return new Response(JSON.stringify({ id: predictionId, status, output, error: status === 'failed' ? 'boom' : null }), { status: 200 });
        }
        if (url.startsWith('https://replicate.delivery/')) {
            log.downloads += 1;
            if (onDownload) await onDownload();
            return new Response(Buffer.from('png-bytes'), { status: 200, headers: { 'content-type': 'image/png' } });
        }
        throw new Error(`unexpected fetch ${url}`);
    };
    return { fetchImpl, log };
}

test('models endpoint requires sign-in and lists the registry without secrets', async () => {
    const ctx = await setup(liveEnv);
    const denied = await handleReplicateModels(new Request('https://local.test/api/creator/replicate/models'), { env: liveEnv });
    assert.equal(denied.status, 401);
    const response = await handleReplicateModels(call('replicate/models'), { env: liveEnv });
    const text = await response.text();
    assert.equal(response.status, 200);
    assert.equal(text.includes(liveEnv.REPLICATE_API_TOKEN), false);
    assert.ok(JSON.parse(text).models.length >= 8);
    assert.equal(JSON.parse(text).mode, 'live');
    assert.ok(ctx);
});

test('mock generation completes, persists a placeholder Asset and blocks duplicates', async () => {
    const { blobStore, assetBlobStore, env } = await setup(baseEnv);
    const fetchImpl = () => { throw new Error('mock mode must not use the network'); };
    const opts = { env, fetchImpl, blobStore, assetBlobStore, idGenerator: () => '33333333-3333-4333-8333-333333333333' };
    const body = { model, projectId, input: { prompt: 'a red fox' } };
    const first = await handleReplicateGenerate(call('replicate/generate', body), opts);
    const payload = await first.json();
    assert.equal(first.status, 200);
    assert.equal(payload.job.mock, true);
    assert.equal(payload.job.status, 'completed');
    assert.equal(payload.job.asset.type, 'graphic');
    assert.equal(Object.hasOwn(payload.job, 'outputUrl'), false);
    assert.equal(assetBlobStore.puts.length, 1);
    const duplicate = await handleReplicateGenerate(call('replicate/generate', body), opts);
    assert.equal(duplicate.status, 409);
    const status = await handleReplicateStatus(call(`replicate/status?id=${payload.job.jobId}`), opts);
    assert.equal((await status.json()).job.asset.id, payload.job.asset.id);
});

test('live generation without a quote is refused with no provider call and no spend', async () => {
    const { blobStore, assetBlobStore, env } = await setup(liveEnv);
    const { fetchImpl, log } = replicateFetch();
    const response = await handleReplicateGenerate(
        call('replicate/generate', { model, projectId, input: { prompt: 'fox' } }),
        { env, fetchImpl, blobStore, assetBlobStore },
    );
    assert.equal(response.status, 428);
    assert.equal(log.creates, 0);
});

test('quote then generate then poll persists exactly once, even for overlapping polls', async () => {
    const { blobStore, assetBlobStore, env } = await setup(liveEnv);
    const { fetchImpl, log } = replicateFetch();
    const opts = { env, fetchImpl, blobStore, assetBlobStore };
    const input = { prompt: 'fox' };
    const quote = await (await handleReplicateQuote(call('replicate/quote', { model, input }), opts)).json();
    assert.ok(quote.quoteToken);
    assert.equal(quote.mode, 'live');
    const created = await handleReplicateGenerate(call('replicate/generate', { model, projectId, input, quoteToken: quote.quoteToken }), opts);
    assert.equal(created.status, 202);
    const createdJob = (await created.json()).job;
    assert.equal(createdJob.status, 'queued');
    assert.equal(log.creates, 1);

    const [a, b] = await Promise.all([
        handleReplicateStatus(call(`replicate/status?id=${predictionId}`), opts),
        handleReplicateStatus(call(`replicate/status?id=${predictionId}`), opts),
    ]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    const project = await getCreatorProject(owner, projectId, { env, blobStore });
    assert.equal(project.assets.length, 1);
    assert.equal(project.assets[0].source, 'replicate');
    const downloadsAfterOverlap = log.downloads;

    const later = await (await handleReplicateStatus(call(`replicate/status?id=${predictionId}`), opts)).json();
    assert.equal(later.job.status, 'completed');
    assert.equal(later.job.asset.url, project.assets[0].url);
    assert.equal(log.downloads, downloadsAfterOverlap);
});

test('a quote cannot be reused for a different prompt', async () => {
    const { blobStore, assetBlobStore, env } = await setup(liveEnv);
    const { fetchImpl, log } = replicateFetch();
    const opts = { env, fetchImpl, blobStore, assetBlobStore };
    const quote = await (await handleReplicateQuote(call('replicate/quote', { model, input: { prompt: 'cheap' } }), opts)).json();
    const response = await handleReplicateGenerate(
        call('replicate/generate', { model, projectId, input: { prompt: 'different' }, quoteToken: quote.quoteToken }),
        opts,
    );
    assert.equal(response.status, 428);
    assert.equal(log.creates, 0);
});

test('a second owner cannot read, cancel or generate into the first owner\'s job or Project', async () => {
    const { blobStore, assetBlobStore, env } = await setup(liveEnv);
    const { fetchImpl, log } = replicateFetch();
    const opts = { env, fetchImpl, blobStore, assetBlobStore };
    const input = { prompt: 'fox' };
    const quote = await (await handleReplicateQuote(call('replicate/quote', { model, input }), opts)).json();
    await handleReplicateGenerate(call('replicate/generate', { model, projectId, input, quoteToken: quote.quoteToken }), opts);

    assert.equal((await handleReplicateStatus(call(`replicate/status?id=${predictionId}`, undefined, other), opts)).status, 404);
    assert.equal((await handleReplicateCancel(call('replicate/cancel', { id: predictionId }, other), opts)).status, 404);
    const otherQuote = await (await handleReplicateQuote(call('replicate/quote', { model, input }, other), opts)).json();
    const foreign = await handleReplicateGenerate(call('replicate/generate', { model, projectId, input, quoteToken: otherQuote.quoteToken }, other), opts);
    assert.equal(foreign.status, 404);
    assert.equal(log.creates, 1);
    assert.equal(log.cancels, 0);
});

test('failed provider jobs are reported once and refund the reserved spend', async () => {
    const { blobStore, assetBlobStore, env } = await setup({ ...liveEnv, REPLICATE_MAX_USD_PER_DAY: '0.004', REPLICATE_MAX_USD_PER_JOB: '1' });
    const dayEnv = { ...liveEnv, REPLICATE_MAX_USD_PER_DAY: '0.004' };
    const { fetchImpl } = replicateFetch({ status: 'failed', output: null });
    const opts = { env: dayEnv, fetchImpl, blobStore, assetBlobStore };
    const quoteOf = async (prompt) => (await (await handleReplicateQuote(call('replicate/quote', { model, input: { prompt } }), opts)).json()).quoteToken;
    const first = await handleReplicateGenerate(call('replicate/generate', { model, projectId, input: { prompt: 'one' }, quoteToken: await quoteOf('one') }), opts);
    assert.equal(first.status, 202);
    const blocked = await handleReplicateGenerate(call('replicate/generate', { model, projectId, input: { prompt: 'two' }, quoteToken: await quoteOf('two') }), opts);
    assert.equal(blocked.status, 402);
    const polled = await (await handleReplicateStatus(call(`replicate/status?id=${predictionId}`), opts)).json();
    assert.equal(polled.job.status, 'failed');
    await handleReplicateStatus(call(`replicate/status?id=${predictionId}`), opts);
    const again = await handleReplicateGenerate(call('replicate/generate', { model, projectId, input: { prompt: 'two' }, quoteToken: await quoteOf('two') }), opts);
    assert.equal(again.status, 202);
    assert.ok(env);
});

test('a succeeded job with a foreign-host output fails without persisting', async () => {
    const { blobStore, assetBlobStore, env } = await setup(liveEnv);
    const { fetchImpl, log } = replicateFetch({ output: ['https://evil.test/out.png'] });
    const opts = { env, fetchImpl, blobStore, assetBlobStore };
    const input = { prompt: 'fox' };
    const quote = await (await handleReplicateQuote(call('replicate/quote', { model, input }), opts)).json();
    await handleReplicateGenerate(call('replicate/generate', { model, projectId, input, quoteToken: quote.quoteToken }), opts);
    const polled = await (await handleReplicateStatus(call(`replicate/status?id=${predictionId}`), opts)).json();
    assert.equal(polled.job.status, 'failed');
    assert.equal(assetBlobStore.puts.length, 0);
    assert.equal(log.downloads, 0);
});

test('cancel stops a live job once and bad requests are rejected', async () => {
    const { blobStore, assetBlobStore, env } = await setup(liveEnv);
    const { fetchImpl, log } = replicateFetch();
    const opts = { env, fetchImpl, blobStore, assetBlobStore };
    const input = { prompt: 'fox' };
    const quote = await (await handleReplicateQuote(call('replicate/quote', { model, input }), opts)).json();
    await handleReplicateGenerate(call('replicate/generate', { model, projectId, input, quoteToken: quote.quoteToken }), opts);
    const cancelled = await (await handleReplicateCancel(call('replicate/cancel', { id: predictionId }), opts)).json();
    assert.equal(cancelled.job.status, 'canceled');
    assert.equal(log.cancels, 1);
    assert.equal((await handleReplicateCancel(call('replicate/cancel', { id: '../x' }), opts)).status, 404);
    assert.equal((await handleReplicateGenerate(call('replicate/generate', { model: 'evil/model', projectId, input: { prompt: 'x' } }), opts)).status, 400);
    assert.equal((await handleReplicateGenerate(call('replicate/generate', { model, projectId: 'not-a-uuid', input: { prompt: 'x' } }), opts)).status, 400);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/security/replicateGateway.test.js`
Expected: FAIL with `Cannot find module '../../src/lib/replicateGateway.js'`

- [ ] **Step 3: Write the implementation**

First edit `src/lib/creatorProviderGateway.js` line 163 to `export async function parseCreatorJson(request, ...`.

```js
import { randomUUID } from 'node:crypto';

import { authorizeCreatorRequest, creatorJson, parseCreatorJson } from './creatorProviderGateway.js';
import {
    CreatorProjectError,
    defaultBlobStore,
    getCreatorProject,
    safeCreatorAssetUrl,
} from './creatorProjectStore.js';
import {
    GenerationGuardError,
    issueQuote,
    loadJobRecord,
    refundSpend,
    releaseGeneration,
    reserveGeneration,
    saveJobRecord,
} from './generationGuard.js';
import { listReplicateModels } from './replicateModelRegistry.js';
import { PersistError, persistGeneratedAsset } from './replicatePersist.js';
import {
    cancelReplicateJob,
    getReplicateJob,
    prepareReplicateRequest,
    replicateConfiguration,
    replicateProviderStatus,
    submitReplicateJob,
} from './replicateProvider.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TERMINAL = new Set(['completed', 'failed', 'canceled']);

function errorResponse(error) {
    if (error instanceof GenerationGuardError || error instanceof CreatorProjectError || error instanceof PersistError) {
        return creatorJson({ error: error.message, code: error.code }, error.status);
    }
    return creatorJson({ error: 'Generation request failed.' }, 500);
}

function clientJob(record) {
    return {
        provider: 'replicate',
        toolId: record.kind === 'image' ? 'replicate_image' : 'replicate_video',
        kind: record.kind,
        jobId: record.jobId,
        status: record.status,
        model: record.model,
        mode: record.mock ? 'mock' : 'live',
        mock: record.mock,
        error: record.error || null,
        estimateUsd: record.estimateUsd,
        asset: record.asset || null,
    };
}

function failureResponse(result) {
    return creatorJson({
        error: result.error,
        ...(result.missing ? { missing: result.missing } : {}),
        ...(result.retryable !== undefined ? { retryable: result.retryable } : {}),
    }, result.status || 502);
}

function assetUrlChecker(env) {
    return (value) => safeCreatorAssetUrl(value, { env });
}

async function authedJson(request, { env, action }) {
    const auth = authorizeCreatorRequest(request, { env, action });
    if (auth.response) return { response: auth.response };
    const parsed = await parseCreatorJson(request, { env });
    if (parsed.response) return { response: parsed.response };
    return { user: auth.user, body: parsed.value };
}

export async function handleReplicateModels(request, { env = process.env } = {}) {
    const auth = authorizeCreatorRequest(request, { env, action: 'replicate-models', statusRequest: true });
    if (auth.response) return auth.response;
    const config = replicateConfiguration(env);
    return creatorJson({
        mode: config.mode,
        provider: replicateProviderStatus(env),
        limits: { maxUsdPerJob: config.maxUsdPerJob, maxUsdPerDay: config.maxUsdPerDay },
        models: listReplicateModels(),
    });
}

export async function handleReplicateQuote(request, { env = process.env } = {}) {
    const ctx = await authedJson(request, { env, action: 'replicate-quote' });
    if (ctx.response) return ctx.response;
    const prepared = prepareReplicateRequest(
        { modelId: ctx.body.model, input: ctx.body.input },
        { env, assetUrl: assetUrlChecker(env) },
    );
    if (!prepared.ok) return failureResponse(prepared);
    try {
        const quote = issueQuote({
            user: ctx.user,
            env,
            modelId: prepared.model.id,
            input: prepared.input,
            estimateUsd: prepared.estimateUsd,
        });
        return creatorJson({
            estimateUsd: prepared.estimateUsd,
            display: prepared.model.pricing.display,
            quoteToken: quote.token,
            expiresAt: quote.expiresAt,
            mode: prepared.config.mode,
            maxUsdPerJob: prepared.config.maxUsdPerJob,
        });
    } catch (error) {
        return errorResponse(error);
    }
}

const PERSIST_ATTEMPTS = 3;

// Overlapping polls can both reach the Asset write; the Project store rejects
// the loser with `project_conflict`. Retrying is safe because the stored path
// and URL are deterministic per job, so the retry finds the winner's Asset.
async function persistIfComplete(user, record, outputUrl, { env, fetchImpl, blobStore, assetBlobStore, now }) {
    for (let attempt = 1; ; attempt += 1) {
        try {
            const { asset } = await persistGeneratedAsset({
                user,
                projectId: record.projectId,
                record,
                outputUrl,
                env,
                fetchImpl,
                assetBlobStore,
                blobStore,
                now,
            });
            return { id: asset.id, url: asset.url, type: asset.type };
        } catch (error) {
            const conflict = error instanceof CreatorProjectError && error.code === 'project_conflict';
            if (!conflict || attempt >= PERSIST_ATTEMPTS) throw error;
        }
    }
}

export async function handleReplicateGenerate(request, {
    env = process.env,
    fetchImpl = fetch,
    blobStore = defaultBlobStore,
    assetBlobStore = defaultBlobStore,
    now = Date.now(),
    idGenerator = randomUUID,
} = {}) {
    const ctx = await authedJson(request, { env, action: 'replicate-generate' });
    if (ctx.response) return ctx.response;
    const { user, body } = ctx;

    const projectId = typeof body.projectId === 'string' ? body.projectId.trim() : '';
    if (!UUID_PATTERN.test(projectId)) return creatorJson({ error: 'A valid Project ID is required.' }, 400);

    const prepared = prepareReplicateRequest(
        { modelId: body.model, input: body.input },
        { env, assetUrl: assetUrlChecker(env) },
    );
    if (!prepared.ok) return failureResponse(prepared);

    let reservation;
    try {
        await getCreatorProject(user, projectId, { env, blobStore });
        reservation = await reserveGeneration({
            user,
            env,
            blobStore,
            mode: prepared.config.mode,
            modelId: prepared.model.id,
            input: prepared.input,
            estimateUsd: prepared.estimateUsd,
            quoteToken: body.quoteToken,
            limits: { maxUsdPerJob: prepared.config.maxUsdPerJob, maxUsdPerDay: prepared.config.maxUsdPerDay },
            now,
        });
    } catch (error) {
        return errorResponse(error);
    }

    const submitted = await submitReplicateJob(prepared, { env, fetchImpl, idGenerator });
    if (!submitted.ok) {
        await releaseGeneration({ user, env, blobStore, reservation, now }).catch(() => {});
        return failureResponse(submitted);
    }

    const job = submitted.job;
    const record = {
        jobId: job.jobId,
        model: job.model,
        kind: job.kind,
        mock: job.mock,
        status: job.status,
        projectId,
        userId: String(user.id),
        prompt: String(prepared.input.prompt).slice(0, 200),
        estimateUsd: prepared.estimateUsd,
        ledgerDay: reservation.ledgerDay,
        refunded: false,
        asset: null,
        error: null,
        createdAt: now,
        updatedAt: now,
    };
    try {
        await saveJobRecord(user, record, { env, blobStore });
        if (job.mock) {
            record.asset = await persistIfComplete(user, record, null, { env, fetchImpl, blobStore, assetBlobStore, now });
            record.updatedAt = now;
            await saveJobRecord(user, record, { env, blobStore });
        }
    } catch (error) {
        return errorResponse(error);
    }
    return creatorJson({ job: clientJob(record) }, job.mock ? 200 : 202);
}

async function settle(user, record, providerJob, { env, fetchImpl, blobStore, assetBlobStore, now }) {
    const next = { ...record, status: providerJob.status, updatedAt: now };
    if (providerJob.status === 'completed' && !record.asset) {
        try {
            next.asset = await persistIfComplete(user, next, providerJob.outputUrl, { env, fetchImpl, blobStore, assetBlobStore, now });
        } catch (error) {
            if (!(error instanceof PersistError) || error.status === 503) throw error;
            next.status = 'failed';
            next.error = error.message;
        }
    } else if (providerJob.status === 'failed') {
        next.error = providerJob.error || 'Generation failed.';
    }
    if ((next.status === 'failed' || next.status === 'canceled') && !next.refunded) {
        await refundSpend({ user, env, blobStore, ledgerDay: next.ledgerDay, estimateUsd: next.estimateUsd });
        next.refunded = true;
    }
    await saveJobRecord(user, next, { env, blobStore });
    return next;
}

export async function handleReplicateStatus(request, {
    env = process.env,
    fetchImpl = fetch,
    blobStore = defaultBlobStore,
    assetBlobStore = defaultBlobStore,
    now = Date.now(),
} = {}) {
    const auth = authorizeCreatorRequest(request, { env, action: 'replicate-status', statusRequest: true });
    if (auth.response) return auth.response;
    const jobId = new URL(request.url).searchParams.get('id') || '';
    try {
        const record = await loadJobRecord(auth.user, jobId, { env, blobStore });
        if (!record) return creatorJson({ error: 'Generation job not found.' }, 404);
        if (TERMINAL.has(record.status) && (record.asset || record.status !== 'completed')) {
            return creatorJson({ job: clientJob(record) });
        }
        if (record.mock) return creatorJson({ job: clientJob(record) });

        const config = replicateConfiguration(env);
        const timedOut = now - record.createdAt > config.jobTimeoutMs;
        const polled = timedOut
            ? await cancelReplicateJob({ jobId, modelId: record.model }, { env, fetchImpl })
            : await getReplicateJob({ jobId, modelId: record.model }, { env, fetchImpl });
        if (!polled.ok) return failureResponse(polled);
        const providerJob = timedOut && !TERMINAL.has(polled.job.status)
            ? { ...polled.job, status: 'failed', error: 'Generation timed out.' }
            : polled.job;
        const next = await settle(auth.user, record, providerJob, { env, fetchImpl, blobStore, assetBlobStore, now });
        return creatorJson({ job: clientJob(next) });
    } catch (error) {
        return errorResponse(error);
    }
}

export async function handleReplicateCancel(request, {
    env = process.env,
    fetchImpl = fetch,
    blobStore = defaultBlobStore,
    assetBlobStore = defaultBlobStore,
    now = Date.now(),
} = {}) {
    const ctx = await authedJson(request, { env, action: 'replicate-cancel' });
    if (ctx.response) return ctx.response;
    try {
        const record = await loadJobRecord(ctx.user, String(ctx.body.id ?? ''), { env, blobStore });
        if (!record) return creatorJson({ error: 'Generation job not found.' }, 404);
        if (TERMINAL.has(record.status) || record.mock) return creatorJson({ job: clientJob(record) });
        const cancelled = await cancelReplicateJob({ jobId: record.jobId, modelId: record.model }, { env, fetchImpl });
        if (!cancelled.ok) return failureResponse(cancelled);
        const next = await settle(ctx.user, record, cancelled.job, { env, fetchImpl, blobStore, assetBlobStore, now });
        return creatorJson({ job: clientJob(next) });
    } catch (error) {
        return errorResponse(error);
    }
}
```

Then edit `app/api/creator/[[...path]]/route.js`: add to the import list from the new module and add these cases before `default:`:

```js
import {
    handleReplicateCancel,
    handleReplicateGenerate,
    handleReplicateModels,
    handleReplicateQuote,
    handleReplicateStatus,
} from '../../../../src/lib/replicateGateway.js';
```

```js
        case 'GET:replicate/models':
            return handleReplicateModels(request);
        case 'POST:replicate/quote':
            return handleReplicateQuote(request);
        case 'POST:replicate/generate':
            return handleReplicateGenerate(request);
        case 'GET:replicate/status':
            return handleReplicateStatus(request);
        case 'POST:replicate/cancel':
            return handleReplicateCancel(request);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/security/replicateGateway.test.js`
Expected: PASS (9 tests). The "overlapping polls" test depends on the `project_conflict` retry in `persistIfComplete`: the loser's retry finds the winner's Asset by URL (`created: false`). If it fails with a 409 or two Assets, debug that retry first, not the test.

- [ ] **Step 5: Run the affected existing suites**

Run: `npm run test:security`
Expected: all pass (235 existing + the new Replicate tests).

- [ ] **Step 6: Commit**

```bash
git add src/lib/replicateGateway.js src/lib/creatorProviderGateway.js "app/api/creator/[[...path]]/route.js" tests/security/replicateGateway.test.js
git commit -m "feat: add owner-bound Replicate generation endpoints

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Configuration docs, full verification

**Files:**
- Modify: `.env.example` (append block)
- Modify: `docs/SECURITY_CONFIGURATION.md` (append "Replicate generation controls" section)

**Interfaces:** none.

- [ ] **Step 1: Append to `.env.example`**

```bash
# --- Replicate (primary generation provider) ---
# Server-only. Never prefix with NEXT_PUBLIC_.
REPLICATE_API_TOKEN=
# mock (default): returns local placeholder media, never contacts Replicate, spends nothing.
# live: real, PAID generations. Also requires REPLICATE_LIVE_ENABLED=true and a token.
GENERATION_MODE=mock
REPLICATE_LIVE_ENABLED=false
# Spend guards (USD). Defaults shown. The per-day total is tracked per owner in private Blob.
REPLICATE_MAX_USD_PER_JOB=1
REPLICATE_MAX_USD_PER_DAY=5
# Cancel and mark failed any generation still running after this long (ms; 60000-1800000).
REPLICATE_JOB_TIMEOUT_MS=1200000
```

- [ ] **Step 2: Append a "Replicate generation controls" section to `docs/SECURITY_CONFIGURATION.md`**

```markdown
## Replicate generation controls

- Default is mock mode. Live generation needs `GENERATION_MODE=live`, `REPLICATE_LIVE_ENABLED=true` and `REPLICATE_API_TOKEN`; if any is missing the endpoints answer 503 and never fall back silently.
- A live generation requires a signed quote from `POST /api/creator/replicate/quote`, bound to owner, model, exact input and estimated cost, valid for five minutes.
- Per-generation (`REPLICATE_MAX_USD_PER_JOB`) and per-day (`REPLICATE_MAX_USD_PER_DAY`) caps are enforced server-side. The daily ledger is stored in private Blob without cross-request locking, so two simultaneous live requests from one owner could overshoot the daily cap by one job.
- Identical requests within 60 seconds are rejected (duplicate lock).
- Outputs are copied from `replicate.delivery` into the Asset store, because Replicate deletes outputs after about an hour.
- There is no automatic retry and no cross-model or cross-provider fallback.
- Prices in the model registry are estimates taken from model pages.
- Webhooks are not implemented; clients poll `GET /api/creator/replicate/status`.
```

- [ ] **Step 3: Run the full verification**

Run each and record the counts:

```bash
npm run test:security
npm run test:creator-shell
node --test tests/*.test.js
node --test tests/integration/*.test.js
npm run lint
npm run build
```

Expected: security suite passes with the new tests added to the 235 baseline; creator-shell 25, top-level 46, integration 5; lint exits 0; build succeeds. If `npm run build` fails because submodules are not initialised, run `git submodule update --init --recursive && npm ci` once and retry; record that in the commit message. Do not skip a failing suite: report failures with their output.

- [ ] **Step 4: Confirm no secret or network leak (read-only check)**

Run: `grep -rn "NEXT_PUBLIC_REPLICATE\|r8_" src app components packages/studio/src 2>/dev/null | grep -v "tests/"`
Expected: no output (the `r8_` token prefix appears only in the redaction regex in `src/lib/replicateProvider.js`; if that single match is the only output, that is correct).

- [ ] **Step 5: Commit**

```bash
git add .env.example docs/SECURITY_CONFIGURATION.md
git commit -m "docs: document Replicate configuration and spend controls

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Self-Review Notes

- **Spec coverage:** model registry (T1), Replicate adapter with mock default (T2), cost approval via signed quote, per-user/per-job caps, duplicate prevention (T3), persistence of expiring outputs (T4), owner-bound status, cancel, timeout, idempotent completion, error reporting (T5), env/docs (T6). Not in this plan, by design: UI studios, Home, Selena wiring, MuAPI as a selectable provider in the new UI, legacy proxy removal, Electron/submodule cleanup, webhooks, Preview deploy. These belong to Plan B.
- **Known limitation recorded in docs:** the daily ledger is a blob read-modify-write, not atomic across instances.
- **Interface consistency:** job record fields (`jobId, model, kind, mock, status, projectId, userId, prompt, estimateUsd, ledgerDay, refunded, asset, error, createdAt, updatedAt`) are written in Task 5 and read only in Task 5. `reservation` fields (`ownerKey, fingerprint, lockPath, ledgerDay, estimateUsd`) are produced in Task 3 and consumed by `releaseGeneration` in Tasks 3 and 5.
