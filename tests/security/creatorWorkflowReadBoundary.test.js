import assert from 'node:assert/strict';
import test from 'node:test';

import { createCreatorSession, creatorCookieSettings } from '../../src/lib/creatorAuth.js';
import { handleCreatorWorkflowRoute } from '../../src/lib/creatorWorkflowGateway.js';
import { createCreatorProject, creatorProjectStoreForTests } from '../../src/lib/creatorProjectStore.js';
import { resetRateLimitStore } from '../../src/lib/rateLimit.js';

const baseEnv = {
    BLOB_READ_WRITE_TOKEN: 'vercel-blob-workflow-read-boundary-token-long-enough',
    CREATOR_SESSION_SECRET: 'creator-workflow-read-boundary-secret-longer-than-thirty-two-characters',
    CREATOR_GITHUB_ALLOWED_USER_IDS: '12345678',
    CREATOR_GITHUB_ALLOWED_LOGINS: 'lalambert1982-eng',
    CREATOR_STUDIO_RATE_LIMIT: '100',
    CREATOR_STUDIO_STATUS_RATE_LIMIT: '100',
    CONTENT_SAFETY_MODE: 'enforce',
    MUAPI_KEY_MODE: 'production',
    MUAPI_PRODUCTION_API_KEY: 'muapi-production-workflow-read-boundary-key',
    MUAPI_ALLOW_PAID_GENERATION: 'false',
};
const paidEnv = { ...baseEnv, MUAPI_ALLOW_PAID_GENERATION: 'true' };
const user = { id: 12345678, login: 'lalambert1982-eng' };
const projectId = '11111111-1111-4111-8111-111111111111';
const runId = '22222222-2222-4222-8222-222222222222';
const assetId = '33333333-3333-4333-8333-333333333333';

function request(path, { method = 'GET', body, env = baseEnv } = {}) {
    const session = createCreatorSession(user, { env });
    const cookieName = creatorCookieSettings(env).sessionName;
    return new Request(`https://local.test/api/creator/workflows/${path}`, {
        method,
        headers: {
            cookie: `${cookieName}=${session}`,
            origin: 'https://local.test',
            'sec-fetch-site': 'same-origin',
            ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
    });
}

test('Project Workflow catalog reads use the server key without enabling paid generation', async () => {
    resetRateLimitStore();
    let providerCalled = false;
    const response = await handleCreatorWorkflowRoute(request('catalog/templates'), {
        path: ['catalog', 'templates'],
        method: 'GET',
        env: baseEnv,
        fetchImpl: async (url, options) => {
            providerCalled = true;
            assert.equal(String(url).endsWith('/workflow/get-template-workflows'), true);
            assert.equal(options.headers['x-api-key'], baseEnv.MUAPI_PRODUCTION_API_KEY);
            return new Response(JSON.stringify([{
                workflow_id: 'launch-video-v1',
                name: 'Launch Video',
                category: 'Video',
                internal_secret: 'must-not-leak',
            }]), { status: 200, headers: { 'content-type': 'application/json' } });
        },
    });
    assert.equal(response.status, 200);
    assert.equal(providerCalled, true);
    const body = await response.json();
    assert.deepEqual(body.workflows, [{
        id: 'launch-video-v1',
        workflow_id: 'launch-video-v1',
        name: 'Launch Video',
        category: 'Video',
        user_name: null,
    }]);
    const serialized = JSON.stringify(body);
    assert.equal(serialized.includes('must-not-leak'), false);
    assert.equal(serialized.includes(baseEnv.MUAPI_PRODUCTION_API_KEY), false);
});

test('Project Workflow input-schema reads are bounded and strip credential-shaped fields', async () => {
    resetRateLimitStore();
    const response = await handleCreatorWorkflowRoute(request('inputs/launch-video-v1'), {
        path: ['inputs', 'launch-video-v1'],
        method: 'GET',
        env: baseEnv,
        fetchImpl: async (url, options) => {
            assert.equal(String(url).endsWith('/workflow/launch-video-v1/api-inputs'), true);
            assert.equal(options.headers['x-api-key'], baseEnv.MUAPI_PRODUCTION_API_KEY);
            return new Response(JSON.stringify({
                input_data: {
                    type: 'object',
                    properties: {
                        text_prompt: { type: 'string', title: 'Prompt', description: 'Describe the video.' },
                        api_key: { type: 'string', default: 'provider-secret-should-not-return' },
                    },
                },
            }), { status: 200, headers: { 'content-type': 'application/json' } });
        },
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(Object.keys(body.input_data.properties), ['text_prompt']);
    assert.equal(JSON.stringify(body).includes('provider-secret-should-not-return'), false);
});

test('paid generation switch still blocks new Workflow submission in production', async () => {
    resetRateLimitStore();
    const blobStore = creatorProjectStoreForTests();
    await createCreatorProject(user, { name: 'Read Boundary Project' }, {
        env: baseEnv,
        blobStore,
        idGenerator: () => projectId,
    });
    const prepared = await handleCreatorWorkflowRoute(request('prepare', {
        method: 'POST',
        body: { projectId, workflowId: 'launch-video-v1', inputs: {} },
    }), { path: ['prepare'], env: baseEnv, blobStore, idGenerator: () => runId });
    assert.equal(prepared.status, 201);

    let providerCalled = false;
    const run = await handleCreatorWorkflowRoute(request('run', {
        method: 'POST',
        body: { projectId, runId, confirm: true },
    }), {
        path: ['run'],
        env: baseEnv,
        blobStore,
        fetchImpl: async () => { providerCalled = true; return new Response('{}'); },
    });
    assert.equal(run.status, 503);
    assert.equal((await run.json()).code, 'workflow_provider_unconfigured');
    assert.equal(providerCalled, false);
});

test('already-approved Workflow status can finish after the paid switch is turned off', async () => {
    resetRateLimitStore();
    const blobStore = creatorProjectStoreForTests();
    await createCreatorProject(user, { name: 'Status Project' }, {
        env: paidEnv,
        blobStore,
        idGenerator: () => projectId,
    });
    const prepared = await handleCreatorWorkflowRoute(request('prepare', {
        method: 'POST', env: paidEnv,
        body: { projectId, workflowId: 'launch-video-v1', inputs: {} },
    }), { path: ['prepare'], env: paidEnv, blobStore, idGenerator: () => runId });
    assert.equal(prepared.status, 201);

    const submitted = await handleCreatorWorkflowRoute(request('run', {
        method: 'POST', env: paidEnv,
        body: { projectId, runId, confirm: true },
    }), {
        path: ['run'],
        env: paidEnv,
        blobStore,
        fetchImpl: async () => new Response(JSON.stringify({ run_id: 'provider-run-1', status: 'queued' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        }),
    });
    assert.equal(submitted.status, 202);

    const status = await handleCreatorWorkflowRoute(request(`status/${projectId}/${runId}`, { env: baseEnv }), {
        path: ['status', projectId, runId],
        method: 'GET',
        env: baseEnv,
        blobStore,
        assetIdGenerator: () => assetId,
        fetchImpl: async (url, options) => {
            assert.equal(String(url).endsWith('/workflow/run/provider-run-1/api-outputs'), true);
            assert.equal(options.headers['x-api-key'], baseEnv.MUAPI_PRODUCTION_API_KEY);
            return new Response(JSON.stringify({
                status: 'completed',
                outputs: ['https://cdn.muapi.ai/workflows/final.mp4'],
                node_runs: [{ node_id: 'final', status: 'completed' }],
            }), { status: 200, headers: { 'content-type': 'application/json' } });
        },
    });
    assert.equal(status.status, 200);
    const body = await status.json();
    assert.equal(body.run.status, 'completed');
    assert.deepEqual(body.run.outputAssetIds, [assetId]);
});
