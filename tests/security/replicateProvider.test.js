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

const fox = { modelId: 'black-forest-labs/flux-2-pro', input: { prompt: 'fox' } };
const throwingFetch = async () => {
    throw new Error('fetch must not be called');
};
const ref = { jobId: predictionId, modelId: 'black-forest-labs/flux-schnell' };

function livePrepared() {
    const prepared = prepareReplicateRequest(fox, { env: liveEnv, assetUrl });
    assert.equal(prepared.ok, true);
    return prepared;
}

function submitWith(fetchImpl) {
    return submitReplicateJob(livePrepared(), { env: liveEnv, fetchImpl });
}

test('unconfigured live mode: prepare refuses and a live-prepared submit never reaches fetch', async () => {
    const env = { GENERATION_MODE: 'live', REPLICATE_API_TOKEN: token };
    const prepared = prepareReplicateRequest(fox, { env, assetUrl });
    assert.equal(prepared.ok, false);
    assert.equal(prepared.status, 503);
    const submitted = await submitReplicateJob(livePrepared(), { env, fetchImpl: throwingFetch });
    assert.equal(submitted.ok, false);
    assert.equal(submitted.status, 503);
});

test('get and cancel with unconfigured env return 503 without calling fetch', async () => {
    const env = { GENERATION_MODE: 'live' };
    assert.equal((await getReplicateJob(ref, { env, fetchImpl: throwingFetch })).status, 503);
    assert.equal((await cancelReplicateJob(ref, { env, fetchImpl: throwingFetch })).status, 503);
});

test('submit timeout is outcome-unknown and not retryable', async () => {
    const result = await submitWith(async () => {
        const error = new Error('timed out');
        error.name = 'TimeoutError';
        throw error;
    });
    assert.equal(result.status, 504);
    assert.equal(result.retryable, false);
    assert.equal(result.outcomeUnknown, true);
});

test('submit network error and 5xx are outcome-unknown and not retryable', async () => {
    const down = await submitWith(async () => { throw new Error('reset'); });
    assert.equal(down.retryable, false);
    assert.equal(down.outcomeUnknown, true);
    const server = await submitWith(async () => jsonResponse({}, 503));
    assert.equal(server.retryable, false);
    assert.equal(server.outcomeUnknown, true);
});

test('mid-body failure is normalized, not thrown', async () => {
    const stream = new ReadableStream({
        start(controller) {
            controller.enqueue(new TextEncoder().encode('{"id":'));
            controller.error(new Error('connection reset'));
        },
    });
    const submitted = await submitWith(async () => new Response(stream, { status: 201 }));
    assert.equal(submitted.ok, false);
    assert.equal(submitted.outcomeUnknown, true);
    assert.equal(submitted.retryable, false);
    const brokenText = { ok: true, status: 200, text: async () => { throw new Error('reset'); } };
    const got = await getReplicateJob(ref, { env: liveEnv, fetchImpl: async () => brokenText });
    assert.equal(got.ok, false);
    assert.equal(got.status, 502);
    const cancelled = await cancelReplicateJob(ref, { env: liveEnv, fetchImpl: async () => brokenText });
    assert.equal(cancelled.ok, false);
});

test('oversized bodies are rejected incrementally and via content-length', async () => {
    const big = 'x'.repeat(2 * 1024 * 1024 + 10);
    const streamed = await submitWith(async () => new Response(big, { status: 201 }));
    assert.equal(streamed.ok, false);
    assert.equal(streamed.outcomeUnknown, true);
    const declared = await submitWith(async () => new Response('{}', { status: 201, headers: { 'content-length': String(big.length) } }));
    assert.equal(declared.ok, false);
    assert.equal(declared.outcomeUnknown, true);
    const got = await getReplicateJob(ref, { env: liveEnv, fetchImpl: async () => new Response(big, { status: 200 }) });
    assert.equal(got.ok, false);
});

test('non-JSON 200 and 2xx without a valid id are outcome-unknown failures', async () => {
    const html = await submitWith(async () => new Response('<html>', { status: 200 }));
    assert.equal(html.ok, false);
    assert.equal(html.outcomeUnknown, true);
    assert.equal(html.retryable, false);
    const noId = await submitWith(async () => jsonResponse({ status: 'starting' }, 201));
    assert.equal(noId.ok, false);
    assert.equal(noId.outcomeUnknown, true);
    assert.equal(noId.retryable, false);
});

test('error details never leak the token or r8_ strings', async () => {
    for (const status of [429, 422]) {
        const result = await submitWith(async () => jsonResponse({ detail: `denied ${token} and r8_otherSecretValue99` }, status));
        const text = JSON.stringify(result);
        assert.equal(text.includes(token), false);
        assert.equal(text.includes('r8_'), false);
        assert.equal(result.outcomeUnknown, false);
    }
    const limited = await submitWith(async () => jsonResponse({}, 429));
    assert.equal(limited.retryable, false);
});

test('definite rejections are not outcome-unknown', async () => {
    const credit = await submitWith(async () => jsonResponse({}, 402));
    assert.equal(credit.outcomeUnknown, false);
    const auth = await submitWith(async () => jsonResponse({}, 401));
    assert.equal(auth.outcomeUnknown, false);
});

test('get keeps retryable semantics for transient failures', async () => {
    const got = await getReplicateJob(ref, { env: liveEnv, fetchImpl: async () => { throw new Error('boom'); } });
    assert.equal(got.retryable, true);
});
