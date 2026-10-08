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
import { generationOwnerKey } from '../../src/lib/generationGuard.js';

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

function ledger(blobStore, env, now) {
    const day = new Date(now).toISOString().slice(0, 10);
    const path = `creator-generation/${generationOwnerKey(owner, env)}/ledger/${day}.json`;
    return JSON.parse(blobStore.records.get(path).bytes.toString());
}

test('a timed-out live submit preserves spend and blocks an immediate duplicate', async () => {
    const ctx = await setup(liveEnv);
    const now = Date.now();
    let creates = 0;
    const fetchImpl = async () => {
        creates += 1;
        throw new DOMException('timeout', 'TimeoutError');
    };
    const opts = { ...ctx, now, fetchImpl };
    const input = { prompt: 'uncertain fox' };
    const quote = await (await handleReplicateQuote(call('replicate/quote', { model, input }), opts)).json();
    const body = { model, input, projectId, quoteToken: quote.quoteToken };
    const response = await handleReplicateGenerate(call('replicate/generate', body), opts);
    assert.equal(response.status, 504);
    const payload = await response.json();
    assert.equal(payload.outcomeUnknown, true);
    assert.equal(payload.retryable, false);
    assert.equal(ledger(ctx.blobStore, ctx.env, now).spentUsd, 0.003);
    assert.equal((await handleReplicateGenerate(call('replicate/generate', body), opts)).status, 409);
    assert.equal(creates, 1);
    assert.equal(ledger(ctx.blobStore, ctx.env, now).spentUsd, 0.003);
});

test('a definite 422 submit rejection refunds spend and permits a fresh submission', async () => {
    const ctx = await setup(liveEnv);
    const now = Date.now();
    let creates = 0;
    const fetchImpl = async () => {
        creates += 1;
        return new Response(JSON.stringify({ detail: 'invalid input' }), { status: 422 });
    };
    const opts = { ...ctx, now, fetchImpl };
    const input = { prompt: 'rejected fox' };
    const quote = await (await handleReplicateQuote(call('replicate/quote', { model, input }), opts)).json();
    const body = { model, input, projectId, quoteToken: quote.quoteToken };
    const response = await handleReplicateGenerate(call('replicate/generate', body), opts);
    assert.equal(response.status, 422);
    assert.equal((await response.json()).outcomeUnknown, false);
    assert.equal(ledger(ctx.blobStore, ctx.env, now).spentUsd, 0);
    assert.equal((await handleReplicateGenerate(call('replicate/generate', body), opts)).status, 422);
    assert.equal(creates, 2);
    assert.equal(ledger(ctx.blobStore, ctx.env, now).spentUsd, 0);
});

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
    assert.equal(downloadsAfterOverlap, 1);

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
    const model = 'black-forest-labs/flux-2-pro';
    const { blobStore, assetBlobStore, env } = await setup({ ...liveEnv, REPLICATE_MAX_USD_PER_DAY: '0.02', REPLICATE_MAX_USD_PER_JOB: '1' });
    const dayEnv = { ...liveEnv, REPLICATE_MAX_USD_PER_DAY: '0.02' };
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

test('a successful paid job keeps spend through an upload outage and can persist on a later poll', async () => {
    const ctx = await setup(liveEnv);
    const now = Date.now();
    const { fetchImpl, log } = replicateFetch();
    const opts = { ...ctx, now, fetchImpl };
    const input = { prompt: 'recoverable fox' };
    const quote = await (await handleReplicateQuote(call('replicate/quote', { model, input }), opts)).json();
    await handleReplicateGenerate(call('replicate/generate', { model, projectId, input, quoteToken: quote.quoteToken }), opts);
    const put = ctx.assetBlobStore.put;
    ctx.assetBlobStore.put = async () => { throw new Error('temporary upload outage'); };
    const unavailable = await handleReplicateStatus(call(`replicate/status?id=${predictionId}`), opts);
    assert.equal(unavailable.status, 502);
    assert.equal((await unavailable.json()).code, 'upload_failed');
    assert.equal(ledger(ctx.blobStore, ctx.env, now).spentUsd, 0.003);
    ctx.assetBlobStore.put = put;
    const recovered = await handleReplicateStatus(call(`replicate/status?id=${predictionId}`), opts);
    assert.equal(recovered.status, 200);
    const job = (await recovered.json()).job;
    assert.equal(job.status, 'completed');
    assert.ok(job.asset.url);
    assert.equal(ledger(ctx.blobStore, ctx.env, now).spentUsd, 0.003);
    assert.equal(log.creates, 1);
});

test('succeeded predictions with unusable outputs retain paid spend without persisting', async () => {
    for (const output of [null, [], ['http://replicate.delivery/out.png'], ['https://evil.test/out.png']]) {
        const ctx = await setup(liveEnv);
        const now = Date.now();
        const { fetchImpl, log } = replicateFetch({ output });
        const opts = { ...ctx, now, fetchImpl };
        const input = { prompt: 'invalid output fox' };
        const quote = await (await handleReplicateQuote(call('replicate/quote', { model, input }), opts)).json();
        await handleReplicateGenerate(call('replicate/generate', { model, projectId, input, quoteToken: quote.quoteToken }), opts);
        const job = (await (await handleReplicateStatus(call(`replicate/status?id=${predictionId}`), opts)).json()).job;
        assert.equal(job.status, 'failed');
        assert.equal(ledger(ctx.blobStore, ctx.env, now).spentUsd, 0.003);
        assert.equal(ctx.assetBlobStore.puts.length, 0);
        assert.equal(log.downloads, 0);
    }
});

test('a refund is not repeated when saving the settled job record fails', async () => {
    const ctx = await setup(liveEnv);
    const now = Date.now();
    const { fetchImpl: providerFetch } = replicateFetch({ status: 'failed', output: null });
    let creates = 0;
    const fetchImpl = async (url, options = {}) => {
        if (url.endsWith('/predictions') && options.method === 'POST') {
            creates += 1;
            return new Response(JSON.stringify({ id: `${predictionId}${creates}`, status: 'starting' }), { status: 201 });
        }
        return providerFetch(url, options);
    };
    const opts = { ...ctx, now, fetchImpl };
    for (const prompt of ['one reservation', 'another reservation']) {
        const input = { prompt };
        const quote = await (await handleReplicateQuote(call('replicate/quote', { model, input }), opts)).json();
        assert.equal((await handleReplicateGenerate(call('replicate/generate', { model, projectId, input, quoteToken: quote.quoteToken }), opts)).status, 202);
    }
    assert.equal(ledger(ctx.blobStore, ctx.env, now).spentUsd, 0.006);
    const put = ctx.blobStore.put;
    let fail = true;
    ctx.blobStore.put = async (pathname, body, options) => {
        if (fail && pathname.includes('/jobs/') && JSON.parse(body).refunded === true) {
            fail = false;
            throw new Error('job save failed');
        }
        return put(pathname, body, options);
    };
    const request = () => call(`replicate/status?id=${predictionId}1`);
    assert.equal((await handleReplicateStatus(request(), opts)).status, 503);
    assert.equal(ledger(ctx.blobStore, ctx.env, now).spentUsd, 0.003);
    assert.equal((await handleReplicateStatus(request(), opts)).status, 200);
    assert.equal(ledger(ctx.blobStore, ctx.env, now).spentUsd, 0.003);
});

test('terminal live submit results settle immediately with errors, refunds, and persisted assets', async () => {
    for (const status of ['failed', 'canceled', 'succeeded']) {
        const ctx = await setup(liveEnv);
        const now = Date.now();
        const fetchImpl = async (url, options = {}) => {
            if (url.endsWith('/predictions') && options.method === 'POST') {
                return new Response(JSON.stringify({ id: predictionId, status, error: status === 'failed' ? 'provider failed' : null, output: status === 'succeeded' ? ['https://replicate.delivery/out.png'] : null }), { status: 201 });
            }
            assert.equal(url, 'https://replicate.delivery/out.png');
            return new Response('png-bytes', { headers: { 'content-type': 'image/png' } });
        };
        const opts = { ...ctx, now, fetchImpl };
        const input = { prompt: 'terminal fox' };
        const quote = await (await handleReplicateQuote(call('replicate/quote', { model, input }), opts)).json();
        const response = await handleReplicateGenerate(call('replicate/generate', { model, projectId, input, quoteToken: quote.quoteToken }), opts);
        assert.equal(response.status, 200);
        const job = (await response.json()).job;
        assert.equal(job.status, status === 'succeeded' ? 'completed' : status);
        if (status === 'failed') assert.equal(job.error, 'provider failed');
        assert.equal(Boolean(job.asset), status === 'succeeded');
        assert.equal(ledger(ctx.blobStore, ctx.env, now).spentUsd, status === 'succeeded' ? 0.003 : 0);
    }
});

test('mock persistence can recover from an upload outage without any provider fetch', async () => {
    const ctx = await setup(baseEnv);
    const put = ctx.assetBlobStore.put;
    ctx.assetBlobStore.put = async () => { throw new Error('temporary upload outage'); };
    const opts = { ...ctx, idGenerator: () => '33333333-3333-4333-8333-333333333333', fetchImpl: () => { throw new Error('no network in mock mode'); } };
    const response = await handleReplicateGenerate(call('replicate/generate', { model, projectId, input: { prompt: 'mock recovery' } }), opts);
    assert.equal(response.status, 502);
    ctx.assetBlobStore.put = put;
    const recovered = await handleReplicateStatus(call('replicate/status?id=mock_33333333-3333-4333-8333-333333333333'), opts);
    assert.equal(recovered.status, 200);
    assert.ok((await recovered.json()).job.asset.url);
});

test('a timeout cancellation that still reports processing retains reserved spend', async () => {
    const ctx = await setup({ ...liveEnv, REPLICATE_JOB_TIMEOUT_MS: '60000' });
    const now = Date.now();
    const { fetchImpl: providerFetch } = replicateFetch();
    const fetchImpl = async (url, options) => url.endsWith('/cancel')
        ? new Response(JSON.stringify({ id: predictionId, status: 'processing' }))
        : providerFetch(url, options);
    const opts = { ...ctx, now, fetchImpl };
    const input = { prompt: 'pending cancellation' };
    const quote = await (await handleReplicateQuote(call('replicate/quote', { model, input }), opts)).json();
    await handleReplicateGenerate(call('replicate/generate', { model, projectId, input, quoteToken: quote.quoteToken }), opts);
    const response = await handleReplicateStatus(call(`replicate/status?id=${predictionId}`), { ...opts, now: now + 61_000 });
    assert.equal(response.status, 200);
    assert.equal(ledger(ctx.blobStore, ctx.env, now).spentUsd, 0.003);
});

// --- Accepted-job recovery metadata (create succeeded, local storage failed) ---

const isJobPath = (pathname) => pathname.includes('/jobs/');

async function liveGenerateBody(opts, prompt, extra = {}) {
    const input = { prompt };
    const quote = await (await handleReplicateQuote(call('replicate/quote', { model, input }), opts)).json();
    return { model, input, projectId, quoteToken: quote.quoteToken, ...extra };
}

function assertNoAcceptedMetadata(payload) {
    for (const key of ['generationAccepted', 'jobId', 'jobRecordState', 'statusRecoveryAvailable']) {
        assert.equal(Object.hasOwn(payload, key), false, `${key} must be absent`);
    }
}

test('a mock upload failure returns a recoverable server job ID that polling can persist', async () => {
    const ctx = await setup(baseEnv);
    const put = ctx.assetBlobStore.put;
    ctx.assetBlobStore.put = async () => { throw new Error('temporary upload outage'); };
    const opts = { ...ctx, idGenerator: () => '44444444-4444-4444-8444-444444444444', fetchImpl: () => { throw new Error('no network in mock mode'); } };
    const response = await handleReplicateGenerate(call('replicate/generate', { model, projectId, input: { prompt: 'mock recovery id' } }), opts);
    assert.equal(response.status, 502);
    const payload = await response.json();
    assert.equal(payload.code, 'upload_failed');
    assert.equal(payload.generationAccepted, true);
    assert.equal(payload.jobRecordState, 'confirmed');
    assert.equal(payload.statusRecoveryAvailable, true);
    assert.equal(payload.retryable, false);
    assert.match(payload.jobId, /^mock_/);
    ctx.assetBlobStore.put = put;
    const recovered = await handleReplicateStatus(call(`replicate/status?id=${payload.jobId}`), opts);
    assert.equal(recovered.status, 200);
    const job = (await recovered.json()).job;
    assert.equal(job.jobId, payload.jobId);
    assert.ok(job.asset.url);
});

test('an initial job-record write that never commits returns the accepted ID as unconfirmed and keeps spend', async () => {
    const ctx = await setup(liveEnv);
    const now = Date.now();
    const { fetchImpl, log } = replicateFetch();
    const opts = { ...ctx, now, fetchImpl };
    const body = await liveGenerateBody(opts, 'unsaved record fox');
    const put = ctx.blobStore.put;
    ctx.blobStore.put = async (pathname, ...rest) => {
        if (isJobPath(pathname)) throw new Error('job store down');
        return put(pathname, ...rest);
    };
    const response = await handleReplicateGenerate(call('replicate/generate', body), opts);
    assert.equal(response.status, 503);
    const payload = await response.json();
    assert.equal(payload.code, 'storage_unavailable');
    assert.equal(payload.generationAccepted, true);
    assert.equal(payload.jobId, predictionId);
    assert.equal(payload.jobRecordState, 'unconfirmed');
    assert.equal(payload.statusRecoveryAvailable, false);
    assert.equal(payload.retryable, false);
    assert.equal(ledger(ctx.blobStore, ctx.env, now).spentUsd, 0.003);
    assert.equal((await handleReplicateGenerate(call('replicate/generate', body), opts)).status, 409);
    assert.equal(log.creates, 1);
    // No record exists, so the honest answer from status is still 404.
    assert.equal((await handleReplicateStatus(call(`replicate/status?id=${payload.jobId}`), opts)).status, 404);
});

test('a job-record write that commits then throws is confirmed by an owner-bound read and can be polled', async () => {
    const ctx = await setup(liveEnv);
    const now = Date.now();
    const { fetchImpl, log } = replicateFetch();
    const opts = { ...ctx, now, fetchImpl };
    const body = await liveGenerateBody(opts, 'unacknowledged record fox');
    const put = ctx.blobStore.put;
    let armed = true;
    ctx.blobStore.put = async (pathname, ...rest) => {
        const result = await put(pathname, ...rest);
        if (armed && isJobPath(pathname)) {
            armed = false;
            throw new Error('acknowledgment lost');
        }
        return result;
    };
    const response = await handleReplicateGenerate(call('replicate/generate', body), opts);
    assert.equal(response.status, 503);
    const payload = await response.json();
    assert.equal(payload.generationAccepted, true);
    assert.equal(payload.jobId, predictionId);
    assert.equal(payload.jobRecordState, 'confirmed');
    assert.equal(payload.statusRecoveryAvailable, true);
    assert.equal(payload.retryable, false);
    assert.equal(ledger(ctx.blobStore, ctx.env, now).spentUsd, 0.003);
    const polled = await handleReplicateStatus(call(`replicate/status?id=${payload.jobId}`), opts);
    assert.equal(polled.status, 200);
    const job = (await polled.json()).job;
    assert.equal(job.status, 'completed');
    assert.ok(job.asset.url);
    assert.equal(log.creates, 1);
    assert.equal(ledger(ctx.blobStore, ctx.env, now).spentUsd, 0.003);
});

test('a failing recovery read makes no recovery promise and leaks no storage detail', async () => {
    const ctx = await setup(liveEnv);
    const { fetchImpl } = replicateFetch();
    const opts = { ...ctx, fetchImpl };
    const body = await liveGenerateBody(opts, 'unreadable record fox');
    const put = ctx.blobStore.put;
    const get = ctx.blobStore.get;
    const secret = 'SECRET-STORAGE-DETAIL-https://private.test/creator-generation';
    ctx.blobStore.put = async (pathname, ...rest) => {
        const result = await put(pathname, ...rest);
        if (isJobPath(pathname)) throw new Error(secret);
        return result;
    };
    ctx.blobStore.get = async (pathname, ...rest) => {
        if (isJobPath(pathname)) throw new Error(secret);
        return get(pathname, ...rest);
    };
    const response = await handleReplicateGenerate(call('replicate/generate', body), opts);
    const text = await response.text();
    const payload = JSON.parse(text);
    assert.equal(payload.generationAccepted, true);
    assert.equal(payload.jobId, predictionId);
    assert.equal(payload.jobRecordState, 'unconfirmed');
    assert.equal(payload.statusRecoveryAvailable, false);
    assert.equal(payload.retryable, false);
    for (const sensitive of [secret, 'SECRET-STORAGE-DETAIL', liveEnv.BLOB_READ_WRITE_TOKEN, liveEnv.REPLICATE_API_TOKEN]) {
        assert.equal(text.includes(sensitive), false);
    }
});

test('unknown and pre-submit failures never carry accepted-job metadata or echo a client job ID', async () => {
    const ctx = await setup(liveEnv);
    const now = Date.now();
    const clientClaims = { jobId: 'client_chosen_id', generationAccepted: true, statusRecoveryAvailable: true };

    // Unknown submit outcome: no valid provider ID was received.
    const timeoutOpts = { ...ctx, now, fetchImpl: async () => { throw new DOMException('timeout', 'TimeoutError'); } };
    const unknown = await handleReplicateGenerate(call('replicate/generate', await liveGenerateBody(timeoutOpts, 'unknown fox', clientClaims)), timeoutOpts);
    assert.equal(unknown.status, 504);
    const unknownPayload = await unknown.json();
    assert.equal(unknownPayload.outcomeUnknown, true);
    assertNoAcceptedMetadata(unknownPayload);

    // A 2xx with no usable prediction ID is also unknown.
    const noIdOpts = { ...ctx, now, fetchImpl: async () => new Response(JSON.stringify({ status: 'starting' }), { status: 201 }) };
    const noId = await handleReplicateGenerate(call('replicate/generate', await liveGenerateBody(noIdOpts, 'no id fox', clientClaims)), noIdOpts);
    assert.equal(noId.status, 502);
    const noIdPayload = await noId.json();
    assert.equal(noIdPayload.outcomeUnknown, true);
    assertNoAcceptedMetadata(noIdPayload);

    // Definite provider rejection.
    const rejectOpts = { ...ctx, now, fetchImpl: async () => new Response(JSON.stringify({ detail: 'bad' }), { status: 422 }) };
    const rejected = await handleReplicateGenerate(call('replicate/generate', await liveGenerateBody(rejectOpts, 'rejected fox', clientClaims)), rejectOpts);
    assert.equal(rejected.status, 422);
    assertNoAcceptedMetadata(await rejected.json());

    // Pre-submit failures: validation, missing Project, missing quote.
    const { fetchImpl } = replicateFetch();
    const opts = { ...ctx, now, fetchImpl };
    for (const body of [
        { model, projectId: 'not-a-uuid', input: { prompt: 'x' }, ...clientClaims },
        { model, projectId: '22222222-2222-4222-8222-222222222222', input: { prompt: 'x' }, ...clientClaims },
        { model, projectId, input: { prompt: 'x' }, ...clientClaims },
    ]) {
        const response = await handleReplicateGenerate(call('replicate/generate', body), opts);
        assert.ok(response.status >= 400);
        assertNoAcceptedMetadata(await response.json());
    }
});

test('a second owner cannot use a returned recovery ID', async () => {
    const ctx = await setup(liveEnv);
    const { fetchImpl, log } = replicateFetch();
    const opts = { ...ctx, fetchImpl };
    const body = await liveGenerateBody(opts, 'owner bound fox');
    const put = ctx.blobStore.put;
    let armed = true;
    ctx.blobStore.put = async (pathname, ...rest) => {
        const result = await put(pathname, ...rest);
        if (armed && isJobPath(pathname)) {
            armed = false;
            throw new Error('acknowledgment lost');
        }
        return result;
    };
    const payload = await (await handleReplicateGenerate(call('replicate/generate', body), opts)).json();
    assert.equal(payload.statusRecoveryAvailable, true);
    assert.equal((await handleReplicateStatus(call(`replicate/status?id=${payload.jobId}`, undefined, other), opts)).status, 404);
    assert.equal((await handleReplicateCancel(call('replicate/cancel', { id: payload.jobId }, other), opts)).status, 404);
    assert.equal(log.cancels, 0);
    assert.equal((await handleReplicateStatus(call(`replicate/status?id=${payload.jobId}`), opts)).status, 200);
});

test('a live download failure after acceptance returns a confirmed recoverable job and keeps spend', async () => {
    const ctx = await setup(liveEnv);
    const now = Date.now();
    const fetchImpl = async (url, options = {}) => {
        if (url.endsWith('/predictions') && options.method === 'POST') {
            return new Response(JSON.stringify({ id: predictionId, status: 'succeeded', output: ['https://replicate.delivery/out.png'] }), { status: 201 });
        }
        throw new Error('output host down');
    };
    const opts = { ...ctx, now, fetchImpl };
    const response = await handleReplicateGenerate(call('replicate/generate', await liveGenerateBody(opts, 'download outage fox')), opts);
    assert.equal(response.status, 502);
    const payload = await response.json();
    assert.equal(payload.code, 'download_failed');
    assert.equal(payload.generationAccepted, true);
    assert.equal(payload.jobId, predictionId);
    assert.equal(payload.jobRecordState, 'confirmed');
    assert.equal(payload.statusRecoveryAvailable, true);
    assert.equal(payload.retryable, false);
    assert.equal(ledger(ctx.blobStore, ctx.env, now).spentUsd, 0.003);
});

test('a refund followed by a failed settled-record save stays recoverable and refunds only once', async () => {
    const ctx = await setup(liveEnv);
    const now = Date.now();
    const fetchImpl = async (url, options = {}) => {
        if (url.endsWith('/predictions') && options.method === 'POST') {
            return new Response(JSON.stringify({ id: predictionId, status: 'failed', error: 'provider failed' }), { status: 201 });
        }
        return new Response(JSON.stringify({ id: predictionId, status: 'failed', error: 'provider failed' }), { status: 200 });
    };
    const opts = { ...ctx, now, fetchImpl };
    const body = await liveGenerateBody(opts, 'refunded then unsaved fox');
    const put = ctx.blobStore.put;
    let armed = true;
    ctx.blobStore.put = async (pathname, data, options) => {
        if (armed && isJobPath(pathname) && JSON.parse(data).refunded === true) {
            armed = false;
            throw new Error('settled save failed');
        }
        return put(pathname, data, options);
    };
    const response = await handleReplicateGenerate(call('replicate/generate', body), opts);
    assert.equal(response.status, 503);
    const payload = await response.json();
    assert.equal(payload.generationAccepted, true);
    assert.equal(payload.jobId, predictionId);
    assert.equal(payload.statusRecoveryAvailable, true);
    assert.equal(ledger(ctx.blobStore, ctx.env, now).spentUsd, 0);
    const polled = await handleReplicateStatus(call(`replicate/status?id=${payload.jobId}`), opts);
    assert.equal(polled.status, 200);
    assert.equal((await polled.json()).job.status, 'failed');
    assert.equal(ledger(ctx.blobStore, ctx.env, now).spentUsd, 0);
});
