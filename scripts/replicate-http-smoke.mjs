// Standalone fixture verification; requires Node 24 and experimental module mocks.
// Run: node --experimental-test-module-mocks scripts/replicate-http-smoke.mjs
// All credentials are fabricated. Real provider/storage calls are blocked.

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mock } from 'node:test';

import { createCreatorSession, creatorCookieSettings } from '../src/lib/creatorAuth.js';
import { creatorProjectStoreForTests } from '../src/lib/creatorProjectStore.js';
import { resetRateLimitStore } from '../src/lib/rateLimit.js';

const gatewayUrl = new URL('../src/lib/replicateGateway.js', import.meta.url);
const projectRoutesUrl = new URL('../src/lib/creatorProjectRoutes.js', import.meta.url);
const realGateway = await import(gatewayUrl);
const realProjects = await import(projectRoutesUrl);
const nativeFetch = globalThis.fetch;
const env = {
    NODE_ENV: 'development',
    BLOB_READ_WRITE_TOKEN: 'private-blob-smoke-test-token-only',
    CREATOR_ASSET_BLOB_READ_WRITE_TOKEN: 'public-blob-smoke-test-token-only',
    CREATOR_SESSION_SECRET: 'creator-smoke-test-session-secret-over-thirty-two-characters',
    CREATOR_GITHUB_ALLOWED_USER_IDS: '12345678,87654321',
    CREATOR_GITHUB_ALLOWED_LOGINS: 'smoke-owner,other-owner',
    CREATOR_STUDIO_RATE_LIMIT: '200',
    CREATOR_STUDIO_STATUS_RATE_LIMIT: '200',
    CONTENT_SAFETY_MODE: 'enforce',
    GENERATION_MODE: 'mock',
    REPLICATE_LIVE_ENABLED: 'false',
};
const owner = { id: 12345678, login: 'smoke-owner' };
const other = { id: 87654321, login: 'other-owner' };
const blobStore = creatorProjectStoreForTests(new Map());
const media = new Map();
let uploadUnavailable = false;
const assetBlobStore = {
    async put(pathname, body, options) {
        if (uploadUnavailable) throw new Error('injected upload outage');
        assert.equal(options.token, env.CREATOR_ASSET_BLOB_READ_WRITE_TOKEN);
        assert.equal(options.access, 'public');
        media.set(pathname, Buffer.from(body));
        return { pathname, url: `https://creator.public.blob.vercel-storage.com/${pathname}` };
    },
    async del(pathname) { media.delete(pathname); },
};
let counter = 0;
let stubCalls = 0;
let forbiddenFetches = 0;
let providerBehavior = 'never';
const predictionId = 'abc123def456ghi789jkl012mn';
const ctx = {
    env, blobStore, assetBlobStore,
    idGenerator() {
        counter += 1;
        return `11111111-1111-4111-8111-${String(counter).padStart(12, '0')}`;
    },
    async fetchImpl(url, options = {}) {
        stubCalls += 1;
        if (providerBehavior === 'timeout') throw new DOMException('injected timeout', 'TimeoutError');
        if (providerBehavior === 'queued') {
            assert.ok(url.startsWith('https://api.replicate.com/v1/'));
            const status = url.endsWith('/cancel') ? 'canceled' : 'starting';
            return new Response(JSON.stringify({ id: predictionId, status }), { status: options.method === 'POST' && !url.endsWith('/cancel') ? 201 : 200 });
        }
        throw new Error('mock mode reached the injected provider fetch');
    },
};

// Only the dependency boundary is replaced. Dispatch, auth, validation,
// provider, guard, persistence and Project handlers are the real implementation.
mock.module(gatewayUrl.href, {
    cache: true,
    namedExports: Object.fromEntries(Object.entries(realGateway).map(([name, handler]) => [name,
        (request, options = {}) => handler(request, { ...ctx, ...options }),
    ])),
});
mock.module(projectRoutesUrl.href, {
    cache: true,
    namedExports: {
        handleCreatorProjectRoute: (request, options = {}) => realProjects.handleCreatorProjectRoute(request, { ...ctx, ...options }),
    },
});
const route = await import(new URL('../app/api/creator/[[...path]]/route.js', import.meta.url));
resetRateLimitStore();
let origin;
globalThis.fetch = async (url, options) => {
    if (!origin || new URL(url instanceof Request ? url.url : String(url)).origin !== origin) {
        forbiddenFetches += 1;
        throw new Error('external fetch blocked by smoke harness');
    }
    return nativeFetch(url, options);
};
const server = createServer(async (incoming, outgoing) => {
    try {
        const bytes = [];
        for await (const chunk of incoming) bytes.push(chunk);
        const method = incoming.method;
        const request = new Request(`${origin}${incoming.url}`, {
            method, headers: incoming.headers,
            ...(['GET', 'HEAD'].includes(method) ? {} : { body: Buffer.concat(bytes) }),
        });
        const pathname = new URL(request.url).pathname;
        const path = pathname.split('/').slice(3);
        if (!pathname.startsWith('/api/creator/') || !['projects', 'replicate'].includes(path[0]) || typeof route[method] !== 'function') {
            outgoing.writeHead(404, { 'content-type': 'application/json' });
            outgoing.end(JSON.stringify({ error: 'Not a smoke-harness route.' }));
            return;
        }
        const response = await route[method](request, { params: Promise.resolve({ path }) });
        outgoing.writeHead(response.status, Object.fromEntries(response.headers));
        outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
        outgoing.writeHead(500, { 'content-type': 'application/json' });
        outgoing.end(JSON.stringify({ error: error.message }));
    }
});

let checks = 0;
async function check(name, operation) {
    await operation();
    checks += 1;
    console.log(`PASS ${name}`);
}
function client(fetchImpl, user = owner) {
    return async (path, { method = 'GET', body, signedIn = true, requestOrigin = origin } = {}) => {
        const cookie = `${creatorCookieSettings(env).sessionName}=${createCreatorSession(user, { env })}`;
        const response = await fetchImpl(`${origin}/api/creator/${path}`, {
            method,
            headers: {
                ...(signedIn ? { cookie } : {}),
                ...(body === undefined ? {} : { 'content-type': 'application/json', origin: requestOrigin, 'sec-fetch-site': 'same-origin' }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const value = await response.json();
        for (const token of [env.BLOB_READ_WRITE_TOKEN, env.CREATOR_ASSET_BLOB_READ_WRITE_TOKEN, env.CREATOR_SESSION_SECRET, ctx.env.REPLICATE_API_TOKEN].filter(Boolean)) {
            assert.equal(JSON.stringify(value).includes(token), false);
        }
        return { response, value };
    };
}

try {
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    origin = `http://127.0.0.1:${server.address().port}`;
    const request = client(globalThis.fetch);
    let projectId;
    let imageJob;
    await check('authentication and all five dispatch routes', async () => {
        for (const [path, method, body] of [
            ['replicate/models', 'GET'],
            ['replicate/quote', 'POST', {}],
            ['replicate/generate', 'POST', {}],
            ['replicate/status?id=abc12345', 'GET'],
            ['replicate/cancel', 'POST', { id: 'abc12345' }],
        ]) {
            assert.equal((await request(path, { method, body, signedIn: false })).response.status, 401);
        }
        assert.equal((await request('replicate/generate')).response.status, 404);
        const { response, value } = await request('replicate/models');
        assert.equal(response.status, 200);
        assert.equal(value.mode, 'mock');
        assert.equal(value.models.length, 8);
    });
    await check('create an owned Project through the route', async () => {
        const { response, value } = await request('projects', { method: 'POST', body: { name: 'Mock smoke Project' } });
        assert.equal(response.status, 201);
        projectId = value.project.id;
    });
    await check('quote and generate a persisted mock image', async () => {
        const model = 'black-forest-labs/flux-schnell';
        const input = { prompt: 'a red fox' };
        const quoted = await request('replicate/quote', { method: 'POST', body: { model, input } });
        assert.equal(quoted.response.status, 200);
        assert.equal(quoted.value.mode, 'mock');
        assert.equal(quoted.value.estimateUsd, 0.003);
        assert.ok(quoted.value.quoteToken);
        const { response, value } = await request('replicate/generate', { method: 'POST', body: { model, input, projectId } });
        assert.equal(response.status, 200);
        imageJob = value.job;
        assert.equal(imageJob.status, 'completed');
        assert.equal(imageJob.mock, true);
        assert.equal(imageJob.asset.type, 'graphic');
        assert.equal(Object.hasOwn(imageJob, 'outputUrl'), false);
        assert.equal(media.size, 1);
        assert.deepEqual([...media.values()][0].subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    });
    await check('poll, completed cancel and duplicate protection retain one image Asset', async () => {
        assert.equal((await request(`replicate/status?id=${imageJob.jobId}`)).value.job.asset.id, imageJob.asset.id);
        assert.equal((await request('replicate/cancel', { method: 'POST', body: { id: imageJob.jobId } })).value.job.asset.id, imageJob.asset.id);
        assert.equal((await request('replicate/generate', { method: 'POST', body: { model: 'black-forest-labs/flux-schnell', input: { prompt: 'a red fox' }, projectId } })).response.status, 409);
        assert.equal(media.size, 1);
    });
    await check('mock video persists its documented graphic placeholder', async () => {
        const { response, value } = await request('replicate/generate', { method: 'POST', body: { model: 'google/veo-3.1-fast', input: { prompt: 'a fox walking through snow' }, projectId } });
        assert.equal(response.status, 200);
        assert.equal(value.job.kind, 'video');
        assert.equal(value.job.mock, true);
        assert.equal(value.job.asset.type, 'graphic');
        assert.equal(media.size, 2);
    });
    await check('reopen and list the Project with the same persisted Assets', async () => {
        const { response, value } = await request(`projects/${projectId}`);
        assert.equal(response.status, 200);
        assert.equal(value.project.assets.length, 2);
        assert.ok(value.project.assets.some((asset) => asset.id === imageJob.asset.id));
        assert.equal((await request('projects')).value.projects.find((project) => project.id === projectId).assetCount, 2);
        assert.equal([...blobStore.records.keys()].some((path) => path.includes('/ledger/')), false);
        assert.equal(stubCalls, 0);
    });
    await check('foreign ownership and cross-origin mutation fail closed', async () => {
        const foreign = client(globalThis.fetch, other);
        assert.equal((await foreign(`projects/${projectId}`)).response.status, 404);
        assert.equal((await foreign(`replicate/status?id=${imageJob.jobId}`)).response.status, 404);
        assert.equal((await foreign('replicate/cancel', { method: 'POST', body: { id: imageJob.jobId } })).response.status, 404);
        assert.equal((await request('replicate/generate', { method: 'POST', body: { projectId }, requestOrigin: 'https://foreign.test' })).response.status, 403);
    });
    await check('unknown models and hostile input are rejected before persistence', async () => {
        for (const body of [
            { model: 'unknown/model', input: { prompt: 'fox' }, projectId },
            { model: 'black-forest-labs/flux-schnell', input: { prompt: 'fox', disable_safety_checker: true }, projectId },
            { model: 'black-forest-labs/flux-schnell', input: { prompt: 'fox' }, projectId: 'invalid' },
        ]) assert.equal((await request('replicate/generate', { method: 'POST', body })).response.status, 400);
        assert.equal(media.size, 2);
    });
    await check('mock upload outage recovers by status without resubmission', async () => {
        uploadUnavailable = true;
        const failed = await request('replicate/generate', { method: 'POST', body: { model: 'black-forest-labs/flux-schnell', input: { prompt: 'recoverable fox' }, projectId } });
        assert.equal(failed.response.status, 502);
        assert.equal(failed.value.code, 'upload_failed');
        assert.equal(failed.value.generationAccepted, true);
        assert.equal(failed.value.jobRecordState, 'confirmed');
        assert.equal(failed.value.statusRecoveryAvailable, true);
        assert.equal(failed.value.retryable, false);
        const jobId = failed.value.jobId;
        assert.match(jobId, /^mock_/);
        uploadUnavailable = false;
        const recovered = await request(`replicate/status?id=${jobId}`);
        assert.equal(recovered.response.status, 200);
        assert.equal(recovered.value.job.jobId, jobId);
        assert.ok(recovered.value.job.asset.id);
        assert.equal((await client(globalThis.fetch, other)(`replicate/status?id=${jobId}`)).response.status, 404);
        assert.equal(media.size, 3);
        assert.equal(stubCalls, 0);
    });
    await check('queued prediction cancellation using an injected provider only', async () => {
        ctx.env = { ...env, GENERATION_MODE: 'live', REPLICATE_LIVE_ENABLED: 'true', REPLICATE_API_TOKEN: 'r8_smoke_test_token_not_real_123456' };
        providerBehavior = 'queued';
        const model = 'black-forest-labs/flux-schnell';
        const input = { prompt: 'stubbed queued prediction' };
        const quote = (await request('replicate/quote', { method: 'POST', body: { model, input } })).value;
        const created = await request('replicate/generate', { method: 'POST', body: { model, input, projectId, quoteToken: quote.quoteToken } });
        assert.equal(created.response.status, 202);
        const canceled = await request('replicate/cancel', { method: 'POST', body: { id: predictionId } });
        assert.equal(canceled.response.status, 200);
        assert.equal(canceled.value.job.status, 'canceled');
        const callsAfterCancel = stubCalls;
        assert.equal((await request('replicate/cancel', { method: 'POST', body: { id: predictionId } })).value.job.status, 'canceled');
        assert.equal(stubCalls, callsAfterCancel);
    });
    await check('unknown injected submit outcome retains spend and blocks duplicates', async () => {
        providerBehavior = 'timeout';
        const model = 'black-forest-labs/flux-schnell';
        const input = { prompt: 'unknown stubbed prediction' };
        const quote = (await request('replicate/quote', { method: 'POST', body: { model, input } })).value;
        const body = { model, input, projectId, quoteToken: quote.quoteToken };
        const failed = await request('replicate/generate', { method: 'POST', body });
        assert.equal(failed.response.status, 504);
        assert.equal(failed.value.outcomeUnknown, true);
        assert.equal(failed.value.retryable, false);
        const callsAfterFailure = stubCalls;
        assert.equal((await request('replicate/generate', { method: 'POST', body })).response.status, 409);
        assert.equal(stubCalls, callsAfterFailure);
        const ledgerRecord = [...blobStore.records.values()].find((record) => record.pathname.includes('/ledger/'));
        assert.equal(JSON.parse(ledgerRecord.bytes).spentUsd, 0.003);
    });
    assert.equal(forbiddenFetches, 0);
    console.log(`HTTP smoke: ${checks}/${checks} checks passed; ${stubCalls} injected provider calls; 0 external calls.`);
} finally {
    globalThis.fetch = nativeFetch;
    if (server.listening) {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    }
    mock.restoreAll();
}
