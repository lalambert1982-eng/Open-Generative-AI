import assert from 'node:assert/strict';
import test from 'node:test';

import { createCreatorSession, creatorCookieSettings } from '../../src/lib/creatorAuth.js';
import { handleCreatorProjectRoute } from '../../src/lib/creatorProjectRoutes.js';
import { creatorProjectStoreForTests } from '../../src/lib/creatorProjectStore.js';
import { resetRateLimitStore } from '../../src/lib/rateLimit.js';

const env = {
    BLOB_READ_WRITE_TOKEN: 'vercel-blob-test-token-that-is-long-enough',
    CREATOR_ASSET_BLOB_READ_WRITE_TOKEN: 'creator-public-blob-test-token-that-is-long-enough',
    CREATOR_SESSION_SECRET: 'creator-workflow-route-test-secret-that-is-longer-than-32-chars',
    CREATOR_GITHUB_ALLOWED_USER_IDS: '12345678',
    CREATOR_GITHUB_ALLOWED_LOGINS: 'lalambert1982-eng',
    CREATOR_STUDIO_RATE_LIMIT: '50',
    CREATOR_STUDIO_STATUS_RATE_LIMIT: '50',
    CONTENT_SAFETY_MODE: 'enforce',
    MUAPI_KEY_MODE: 'sandbox',
    MUAPI_API_KEY: 'sandbox-key-that-is-long-enough',
};
const owner = { id: 12345678, login: 'lalambert1982-eng' };
const projectId = '11111111-1111-4111-8111-111111111111';

function jsonRequest(url, { method = 'GET', body, authenticated = true, origin = 'https://local.test', session, cookieName } = {}) {
    return new Request(`https://local.test${url}`, {
        method,
        headers: {
            ...(body ? { 'content-type': 'application/json' } : {}),
            origin,
            'sec-fetch-site': origin === 'https://local.test' ? 'same-origin' : 'cross-site',
            ...(authenticated ? { cookie: `${cookieName}=${session}` } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
    });
}

function succeedingFetch() {
    let counter = 0;
    return async () => {
        counter += 1;
        return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ id: `job-${counter}`, status: 'succeeded', output: [`https://cdn.muapi.ai/route-out-${counter}.png`] }),
        };
    };
}

async function createProject(blobStore, session, cookieName) {
    const response = await handleCreatorProjectRoute(
        jsonRequest('/api/creator/projects', { method: 'POST', body: { name: 'Route Test Project' }, session, cookieName }),
        { path: [], env, blobStore, idGenerator: () => projectId },
    );
    assert.equal(response.status, 201);
}

test('workflow routes require authentication and same-origin, matching every other Project mutation', async () => {
    resetRateLimitStore();
    const blobStore = creatorProjectStoreForTests(new Map());
    const cookieName = creatorCookieSettings(env).sessionName;
    const session = createCreatorSession(owner, { env });
    await createProject(blobStore, session, cookieName);

    const unauthenticated = await handleCreatorProjectRoute(
        jsonRequest(`/api/creator/projects/${projectId}/workflows`, { method: 'POST', body: { source: 'manual', nodes: [{ kind: 'image.generate', prompt: 'x' }] }, authenticated: false, session, cookieName }),
        { path: [projectId, 'workflows'], method: 'POST', env, blobStore },
    );
    assert.equal(unauthenticated.status, 401);

    const crossOrigin = await handleCreatorProjectRoute(
        jsonRequest(`/api/creator/projects/${projectId}/workflows`, { method: 'POST', body: { source: 'manual', nodes: [{ kind: 'image.generate', prompt: 'x' }] }, origin: 'https://attacker.test', session, cookieName }),
        { path: [projectId, 'workflows'], method: 'POST', env, blobStore },
    );
    assert.equal(crossOrigin.status, 403);
});

test('workflow route round trip: create, list, fetch, gate, and complete over HTTP', async () => {
    resetRateLimitStore();
    const blobStore = creatorProjectStoreForTests(new Map());
    const cookieName = creatorCookieSettings(env).sessionName;
    const session = createCreatorSession(owner, { env });
    await createProject(blobStore, session, cookieName);

    const created = await handleCreatorProjectRoute(
        jsonRequest(`/api/creator/projects/${projectId}/workflows`, {
            method: 'POST',
            body: { source: 'manual', name: 'HTTP Run', nodes: [{ kind: 'image.generate', prompt: 'a route-level test image' }] },
            session,
            cookieName,
        }),
        { path: [projectId, 'workflows'], method: 'POST', env, blobStore, idGenerator: (() => { let n = 0; return () => `run-${++n}`; })() },
    );
    assert.equal(created.status, 201);
    const createdBody = await created.json();
    const runId = createdBody.run.id;
    assert.equal(createdBody.run.status, 'queued');

    const listed = await handleCreatorProjectRoute(
        jsonRequest(`/api/creator/projects/${projectId}/workflows`, { method: 'GET', session, cookieName }),
        { path: [projectId, 'workflows'], method: 'GET', env, blobStore },
    );
    assert.equal(listed.status, 200);
    const listedBody = await listed.json();
    assert.equal(listedBody.workflowRuns.length, 1);

    const fetched = await handleCreatorProjectRoute(
        jsonRequest(`/api/creator/projects/${projectId}/workflows/${runId}`, { method: 'GET', session, cookieName }),
        { path: [projectId, 'workflows', runId], method: 'GET', env, blobStore },
    );
    assert.equal(fetched.status, 200);
    assert.equal((await fetched.json()).run.id, runId);

    const missing = await handleCreatorProjectRoute(
        jsonRequest(`/api/creator/projects/${projectId}/workflows/does-not-exist`, { method: 'GET', session, cookieName }),
        { path: [projectId, 'workflows', 'does-not-exist'], method: 'GET', env, blobStore },
    );
    assert.equal(missing.status, 404);

    const fetchImpl = succeedingFetch();
    const gated = await handleCreatorProjectRoute(
        jsonRequest(`/api/creator/projects/${projectId}/workflows/${runId}/advance`, { method: 'POST', session, cookieName }),
        { path: [projectId, 'workflows', runId, 'advance'], method: 'POST', env, blobStore, fetchImpl },
    );
    assert.equal(gated.status, 200);
    const gatedBody = await gated.json();
    assert.equal(gatedBody.run.status, 'waiting_for_approval');

    const approved = await handleCreatorProjectRoute(
        jsonRequest(`/api/creator/projects/${projectId}/workflows/${runId}/approve`, { method: 'POST', session, cookieName }),
        { path: [projectId, 'workflows', runId, 'approve'], method: 'POST', env, blobStore, fetchImpl },
    );
    assert.equal(approved.status, 200);
    const approvedBody = await approved.json();
    assert.equal(approvedBody.run.status, 'completed');
    assert.equal(approvedBody.project.assets.length, 1);
    assert.equal(approvedBody.project.assets[0].source, 'workflow');

    const unknownAction = await handleCreatorProjectRoute(
        jsonRequest(`/api/creator/projects/${projectId}/workflows/${runId}/bogus`, { method: 'POST', session, cookieName }),
        { path: [projectId, 'workflows', runId, 'bogus'], method: 'POST', env, blobStore },
    );
    assert.equal(unknownAction.status, 404);
});
