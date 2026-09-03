import assert from 'node:assert/strict';
import test from 'node:test';

import { createCreatorSession, creatorCookieSettings } from '../../src/lib/creatorAuth.js';
import { handleCreatorWorkflowRoute } from '../../src/lib/creatorWorkflowGateway.js';
import {
    createCreatorProject,
    creatorProjectStoreForTests,
    getCreatorProject,
    saveCreatorStoryboard,
} from '../../src/lib/creatorProjectStore.js';
import { resetRateLimitStore } from '../../src/lib/rateLimit.js';

const env = {
    BLOB_READ_WRITE_TOKEN: 'vercel-blob-workflow-test-token-that-is-long-enough',
    CREATOR_SESSION_SECRET: 'creator-workflow-test-secret-that-is-longer-than-thirty-two-characters',
    CREATOR_GITHUB_ALLOWED_USER_IDS: '12345678,87654321',
    CREATOR_GITHUB_ALLOWED_LOGINS: 'lalambert1982-eng,other-owner',
    CREATOR_STUDIO_RATE_LIMIT: '100',
    CREATOR_STUDIO_STATUS_RATE_LIMIT: '100',
    CONTENT_SAFETY_MODE: 'enforce',
    MUAPI_KEY_MODE: 'sandbox',
    MUAPI_API_KEY: 'muapi-workflow-sandbox-test-key',
    MUAPI_ALLOW_PAID_GENERATION: 'false',
};
const owner = { id: 12345678, login: 'lalambert1982-eng' };
const otherOwner = { id: 87654321, login: 'other-owner' };
const projectId = '11111111-1111-4111-8111-111111111111';
const otherProjectId = '22222222-2222-4222-8222-222222222222';
const runId = '33333333-3333-4333-8333-333333333333';
const retryRunId = '44444444-4444-4444-8444-444444444444';
const assetId = '55555555-5555-4555-8555-555555555555';
const workflowId = 'workflow-v1-test';
const providerRunId = 'provider-run-123';

function creatorRequest(path, body, {
    user = owner,
    method = 'POST',
    authenticated = true,
    origin = 'https://local.test',
} = {}) {
    const cookieName = creatorCookieSettings(env).sessionName;
    const session = createCreatorSession(user, { env });
    return new Request(`https://local.test/api/creator/workflows/${path}`, {
        method,
        headers: {
            ...(method !== 'GET' ? { 'content-type': 'application/json' } : {}),
            origin,
            'sec-fetch-site': origin === 'https://local.test' ? 'same-origin' : 'cross-site',
            ...(authenticated ? { cookie: `${cookieName}=${session}` } : {}),
        },
        ...(method !== 'GET' ? { body: JSON.stringify(body || {}) } : {}),
    });
}

async function seedProject(blobStore, { withStoryboard = false } = {}) {
    await createCreatorProject(owner, { name: 'Workflow Project' }, {
        env,
        blobStore,
        idGenerator: () => projectId,
        now: Date.UTC(2026, 8, 3, 12, 0, 0),
    });
    if (withStoryboard) {
        await saveCreatorStoryboard(owner, projectId, {
            storyboard: {
                selectedSceneId: 'scene-1',
                scenes: [{
                    id: 'scene-1',
                    title: 'Opening',
                    prompt: 'Opening frame.',
                    imageUrl: '',
                    videoUrl: '',
                    duration: 5,
                    aspectRatio: '16:9',
                    transition: 'cut',
                    status: 'draft',
                }],
            },
        }, { env, blobStore });
    }
}

async function prepare(blobStore, extra = {}) {
    resetRateLimitStore();
    const response = await handleCreatorWorkflowRoute(creatorRequest('prepare', {
        projectId,
        workflowId,
        inputs: { text_prompt: { prompt: 'Build a launch sequence.' } },
        ...extra,
    }), {
        path: ['prepare'],
        env,
        blobStore,
        idGenerator: () => runId,
    });
    assert.equal(response.status, 201);
    return (await response.json()).run;
}

test('Workflow routes require Creator authentication and same-origin mutation', async () => {
    resetRateLimitStore();
    const blobStore = creatorProjectStoreForTests();
    await seedProject(blobStore);

    const unauthenticated = await handleCreatorWorkflowRoute(creatorRequest('prepare', {
        projectId,
        workflowId,
        inputs: {},
    }, { authenticated: false }), {
        path: ['prepare'], env, blobStore, idGenerator: () => runId,
    });
    assert.equal(unauthenticated.status, 401);

    const crossOrigin = await handleCreatorWorkflowRoute(creatorRequest('prepare', {
        projectId,
        workflowId,
        inputs: {},
    }, { origin: 'https://attacker.test' }), {
        path: ['prepare'], env, blobStore, idGenerator: () => runId,
    });
    assert.equal(crossOrigin.status, 403);
});

test('prepared Workflow runs are Project-scoped and hide inputs/provider identifiers', async () => {
    const blobStore = creatorProjectStoreForTests();
    await seedProject(blobStore);
    const run = await prepare(blobStore);

    assert.equal(run.id, runId);
    assert.equal(run.projectId, projectId);
    assert.equal(run.workflowId, workflowId);
    assert.equal(run.status, 'waiting_for_approval');
    assert.equal(run.approvalRequired, true);
    assert.deepEqual(run.inputKeys, ['text_prompt']);
    assert.equal(Object.hasOwn(run, 'inputs'), false);
    assert.equal(Object.hasOwn(run, 'providerRunId'), false);
    const serialized = JSON.stringify(run);
    assert.equal(serialized.includes(env.MUAPI_API_KEY), false);
    assert.equal(serialized.includes('Build a launch sequence.'), false);
});

test('Workflow inputs fail closed on provider credentials, raw provider ids, and unknown fields', async () => {
    resetRateLimitStore();
    const blobStore = creatorProjectStoreForTests();
    await seedProject(blobStore);

    const secretInput = await handleCreatorWorkflowRoute(creatorRequest('prepare', {
        projectId,
        workflowId,
        inputs: { apiKey: 'browser-secret-must-not-pass' },
    }), { path: ['prepare'], env, blobStore, idGenerator: () => runId });
    assert.equal(secretInput.status, 403);
    assert.equal((await secretInput.json()).code, 'workflow_secret_forbidden');

    const providerField = await handleCreatorWorkflowRoute(creatorRequest('run', {
        projectId,
        runId,
        confirm: true,
        providerRunId: 'attacker-controlled-provider-run',
    }), { path: ['run'], env, blobStore, fetchImpl: async () => { throw new Error('must_not_run'); } });
    assert.equal(providerField.status, 403);
    assert.equal((await providerField.json()).code, 'workflow_provider_field_forbidden');

    const unknownField = await handleCreatorWorkflowRoute(creatorRequest('prepare', {
        projectId,
        workflowId,
        inputs: {},
        surprise: true,
    }), { path: ['prepare'], env, blobStore, idGenerator: () => runId });
    assert.equal(unknownField.status, 400);
    assert.equal((await unknownField.json()).code, 'unknown_workflow_field');
});

test('Storyboard references must exist inside the same Project', async () => {
    resetRateLimitStore();
    const blobStore = creatorProjectStoreForTests();
    await seedProject(blobStore, { withStoryboard: true });

    const valid = await handleCreatorWorkflowRoute(creatorRequest('prepare', {
        projectId,
        workflowId,
        inputs: {},
        storyboardSceneIds: ['scene-1'],
    }), { path: ['prepare'], env, blobStore, idGenerator: () => runId });
    assert.equal(valid.status, 201);
    assert.deepEqual((await valid.json()).run.storyboardSceneIds, ['scene-1']);

    const invalid = await handleCreatorWorkflowRoute(creatorRequest('prepare', {
        projectId,
        workflowId,
        inputs: {},
        storyboardSceneIds: ['scene-from-another-project'],
    }), { path: ['prepare'], env, blobStore, idGenerator: () => retryRunId });
    assert.equal(invalid.status, 403);
    assert.equal((await invalid.json()).code, 'invalid_storyboard_reference');
});

test('owner isolation blocks another Creator from reading or executing a Workflow run', async () => {
    resetRateLimitStore();
    const blobStore = creatorProjectStoreForTests();
    await seedProject(blobStore);
    await prepare(blobStore);

    await createCreatorProject(otherOwner, { name: 'Other Owner Project' }, {
        env,
        blobStore,
        idGenerator: () => projectId,
    });

    const status = await handleCreatorWorkflowRoute(creatorRequest(`status/${projectId}/${runId}`, null, {
        user: otherOwner,
        method: 'GET',
    }), {
        path: ['status', projectId, runId],
        method: 'GET',
        env,
        blobStore,
    });
    assert.equal(status.status, 404);

    let providerCalled = false;
    const execute = await handleCreatorWorkflowRoute(creatorRequest('run', {
        projectId,
        runId,
        confirm: true,
    }, { user: otherOwner }), {
        path: ['run'],
        env,
        blobStore,
        fetchImpl: async () => { providerCalled = true; return new Response('{}'); },
    });
    assert.equal(execute.status, 404);
    assert.equal(providerCalled, false);
});

test('Workflow execution cannot submit before explicit approval', async () => {
    resetRateLimitStore();
    const blobStore = creatorProjectStoreForTests();
    await seedProject(blobStore);
    await prepare(blobStore);
    let providerCalled = false;

    const response = await handleCreatorWorkflowRoute(creatorRequest('run', {
        projectId,
        runId,
        confirm: false,
    }), {
        path: ['run'],
        env,
        blobStore,
        fetchImpl: async () => { providerCalled = true; return new Response('{}'); },
    });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).code, 'approval_required');
    assert.equal(providerCalled, false);
});

test('approved Workflow submit is idempotent while queued and provider identifiers remain server-only', async () => {
    resetRateLimitStore();
    const blobStore = creatorProjectStoreForTests();
    await seedProject(blobStore);
    await prepare(blobStore);
    let calls = 0;
    const fetchImpl = async (url, options = {}) => {
        calls += 1;
        assert.equal(String(url).endsWith(`/workflow/${workflowId}/api-execute`), true);
        assert.equal(options.headers['x-api-key'], env.MUAPI_API_KEY);
        return new Response(JSON.stringify({ run_id: providerRunId, status: 'queued' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        });
    };

    const first = await handleCreatorWorkflowRoute(creatorRequest('run', {
        projectId,
        runId,
        confirm: true,
    }), { path: ['run'], env, blobStore, fetchImpl });
    assert.equal(first.status, 202);
    const firstRun = (await first.json()).run;
    assert.equal(firstRun.status, 'queued');
    assert.equal(JSON.stringify(firstRun).includes(providerRunId), false);

    const second = await handleCreatorWorkflowRoute(creatorRequest('run', {
        projectId,
        runId,
        confirm: true,
    }), { path: ['run'], env, blobStore, fetchImpl });
    assert.equal(second.status, 202);
    assert.equal(calls, 1);
});

test('completed provider Workflow output is registered as an owned Project Asset exactly once', async () => {
    resetRateLimitStore();
    const blobStore = creatorProjectStoreForTests();
    await seedProject(blobStore);
    await prepare(blobStore);
    let phase = 'submit';
    const outputUrl = 'https://cdn.muapi.ai/workflows/final.mp4';
    const fetchImpl = async (url) => {
        if (phase === 'submit') {
            phase = 'status';
            return new Response(JSON.stringify({ run_id: providerRunId, status: 'queued' }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        }
        assert.equal(String(url).endsWith(`/workflow/run/${providerRunId}/api-outputs`), true);
        return new Response(JSON.stringify({
            status: 'completed',
            outputs: [outputUrl],
            node_runs: [
                { node_id: 'generate-image', status: 'completed' },
                { node_id: 'animate-video', status: 'completed', output: { url: outputUrl } },
            ],
        }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        });
    };

    const submitted = await handleCreatorWorkflowRoute(creatorRequest('run', {
        projectId,
        runId,
        confirm: true,
    }), { path: ['run'], env, blobStore, fetchImpl });
    assert.equal(submitted.status, 202);

    const status = await handleCreatorWorkflowRoute(creatorRequest(`status/${projectId}/${runId}`, null, {
        method: 'GET',
    }), {
        path: ['status', projectId, runId],
        method: 'GET',
        env,
        blobStore,
        fetchImpl,
        assetIdGenerator: () => assetId,
    });
    assert.equal(status.status, 200);
    const completed = (await status.json()).run;
    assert.equal(completed.status, 'completed');
    assert.deepEqual(completed.outputAssetIds, [assetId]);
    assert.equal(completed.nodeStates.every((node) => node.status === 'completed'), true);
    assert.equal(JSON.stringify(completed).includes(providerRunId), false);

    const project = await getCreatorProject(owner, projectId, { env, blobStore });
    assert.equal(project.assets.length, 1);
    assert.equal(project.assets[0].id, assetId);
    assert.equal(project.assets[0].type, 'video');
    assert.equal(project.assets[0].url, outputUrl);
    assert.equal(project.assets[0].source, 'workflow');

    const repeated = await handleCreatorWorkflowRoute(creatorRequest(`status/${projectId}/${runId}`, null, {
        method: 'GET',
    }), {
        path: ['status', projectId, runId],
        method: 'GET',
        env,
        blobStore,
        fetchImpl: async () => { throw new Error('completed run must not poll again'); },
    });
    assert.equal(repeated.status, 200);
    assert.equal((await getCreatorProject(owner, projectId, { env, blobStore })).assets.length, 1);
});

test('failed Workflow runs stop as failed and retry creates a new approval-gated attempt', async () => {
    resetRateLimitStore();
    const blobStore = creatorProjectStoreForTests();
    await seedProject(blobStore);
    await prepare(blobStore);
    let phase = 'submit';
    const fetchImpl = async () => {
        if (phase === 'submit') {
            phase = 'status';
            return new Response(JSON.stringify({ run_id: providerRunId, status: 'running' }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        }
        return new Response(JSON.stringify({ status: 'failed', error: 'node 2 failed' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        });
    };

    const submitted = await handleCreatorWorkflowRoute(creatorRequest('run', {
        projectId,
        runId,
        confirm: true,
    }), { path: ['run'], env, blobStore, fetchImpl });
    assert.equal(submitted.status, 202);

    const status = await handleCreatorWorkflowRoute(creatorRequest(`status/${projectId}/${runId}`, null, {
        method: 'GET',
    }), {
        path: ['status', projectId, runId], method: 'GET', env, blobStore, fetchImpl,
    });
    assert.equal(status.status, 200);
    assert.equal((await status.json()).run.status, 'failed');

    const retry = await handleCreatorWorkflowRoute(creatorRequest('retry', {
        projectId,
        runId,
    }), {
        path: ['retry'],
        env,
        blobStore,
        idGenerator: () => retryRunId,
    });
    assert.equal(retry.status, 201);
    const retried = (await retry.json()).run;
    assert.equal(retried.id, retryRunId);
    assert.equal(retried.retryOf, runId);
    assert.equal(retried.attempt, 2);
    assert.equal(retried.status, 'waiting_for_approval');
});

test('prepared Workflow can be cancelled before provider submission without a provider call', async () => {
    resetRateLimitStore();
    const blobStore = creatorProjectStoreForTests();
    await seedProject(blobStore);
    await prepare(blobStore);

    const cancelled = await handleCreatorWorkflowRoute(creatorRequest('cancel', {
        projectId,
        runId,
    }), { path: ['cancel'], env, blobStore });
    assert.equal(cancelled.status, 200);
    assert.equal((await cancelled.json()).run.status, 'cancelled');
});
