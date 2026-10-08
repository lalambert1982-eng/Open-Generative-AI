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
