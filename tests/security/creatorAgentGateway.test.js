import assert from 'node:assert/strict';
import test from 'node:test';

import { createCreatorSession, creatorCookieSettings } from '../../src/lib/creatorAuth.js';
import {
    CreatorAgentError,
    delegateCreatorAgent,
    ensureCreatorAgents,
    handleCreatorAgentRoute,
} from '../../src/lib/creatorAgentGateway.js';
import { creatorAgentAuditStoreForTests } from '../../src/lib/creatorAgentAuditStore.js';
import {
    CREATOR_AGENT_KEYS,
    CREATOR_AGENT_REGISTRY,
    CreatorAgentRegistryError,
    creatorAgentForSpecialty,
    getCreatorAgentDefinition,
    listCreatorAgentDefinitions,
} from '../../src/lib/creatorAgentRegistry.js';
import {
    addCreatorAsset,
    createCreatorProject,
    creatorProjectStoreForTests,
} from '../../src/lib/creatorProjectStore.js';
import { handleSelenaAgentAssistant } from '../../src/lib/selenaAgentAssistant.js';
import { normalizeSelenaPlan } from '../../src/lib/selenaOrchestrator.js';
import { resetRateLimitStore } from '../../src/lib/rateLimit.js';

const PROJECT_A = '11111111-1111-4111-8111-111111111111';
const PROJECT_B = '22222222-2222-4222-8222-222222222222';
const ASSET_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ASSET_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const EXTERNAL_AGENT_ID = 'muapi-agent-content-writer-secret-id';
const PROVIDER_KEY = 'muapi-sandbox-agent-provider-secret';

const baseEnv = {
    CREATOR_SESSION_SECRET: 'creator-agent-test-session-secret-that-is-longer-than-thirty-two-characters',
    CREATOR_GITHUB_ALLOWED_USER_IDS: '12345678',
    CREATOR_GITHUB_ALLOWED_LOGINS: 'lalambert1982-eng',
    CREATOR_STUDIO_RATE_LIMIT: '200',
    CREATOR_STUDIO_STATUS_RATE_LIMIT: '200',
    CONTENT_SAFETY_MODE: 'enforce',
    BLOB_READ_WRITE_TOKEN: 'blob-test-token-that-is-long-enough-for-tests',
    MUAPI_KEY_MODE: 'sandbox',
    MUAPI_API_KEY: PROVIDER_KEY,
};
const githubUser = { id: 12345678, login: 'lalambert1982-eng' };
const session = createCreatorSession(githubUser, { env: baseEnv });
const sessionCookieName = creatorCookieSettings(baseEnv).sessionName;

function creatorRequest(path, body, { method = 'POST', extraHeaders = {} } = {}) {
    const hasBody = body !== undefined;
    return new Request(`https://local.test/api/creator/${path}`, {
        method,
        headers: {
            cookie: `${sessionCookieName}=${session}`,
            ...(hasBody ? { 'content-type': 'application/json' } : {}),
            ...(!['GET', 'HEAD'].includes(method) ? {
                origin: 'https://local.test',
                'sec-fetch-site': 'same-origin',
            } : {}),
            ...extraHeaders,
        },
        body: hasBody ? JSON.stringify(body) : undefined,
    });
}

function jsonResponse(value, status = 200) {
    return new Response(JSON.stringify(value), {
        status,
        headers: { 'content-type': 'application/json' },
    });
}

function decodedRequestBody(options = {}) {
    const body = options.body;
    if (body instanceof ArrayBuffer) return new TextDecoder().decode(body);
    if (ArrayBuffer.isView(body)) {
        return new TextDecoder().decode(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength));
    }
    return typeof body === 'string' ? body : String(body || '');
}

function parsedRequestBody(options = {}) {
    return JSON.parse(decodedRequestBody(options));
}

function slugFor(name) {
    return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

async function seedProjects() {
    const projectStore = creatorProjectStoreForTests();
    const auditStore = creatorAgentAuditStoreForTests();
    const first = await createCreatorProject(githubUser, { name: 'Project Alpha' }, {
        env: baseEnv,
        blobStore: projectStore,
        idGenerator: () => PROJECT_A,
    });
    await addCreatorAsset(githubUser, first.id, {
        type: 'image',
        title: 'Alpha image',
        url: 'https://alpha.vercel-storage.com/image.png',
        source: 'upload',
    }, {
        env: baseEnv,
        blobStore: projectStore,
        idGenerator: () => ASSET_A,
    });
    const second = await createCreatorProject(githubUser, { name: 'Project Beta' }, {
        env: baseEnv,
        blobStore: projectStore,
        idGenerator: () => PROJECT_B,
    });
    await addCreatorAsset(githubUser, second.id, {
        type: 'image',
        title: 'Beta image',
        url: 'https://beta.vercel-storage.com/image.png',
        source: 'upload',
    }, {
        env: baseEnv,
        blobStore: projectStore,
        idGenerator: () => ASSET_B,
    });
    return { projectStore, auditStore };
}

function completedAgentFetch({ capture = [] } = {}) {
    return async (url, options = {}) => {
        const href = String(url);
        capture.push({ url: href, options });
        if (href.endsWith('/agents/user/agents')) {
            return jsonResponse([{ agent_id: EXTERNAL_AGENT_ID, name: 'G.FURY Content Writer' }]);
        }
        if (href.includes(`/agents/by-slug/${EXTERNAL_AGENT_ID}/chat`)) {
            return jsonResponse({ request_id: 'prediction-agent-123' });
        }
        if (href.endsWith('/api/v1/predictions/prediction-agent-123/result')) {
            return jsonResponse({
                is_complete: true,
                conversation_id: 'conversation-agent-123',
                messages: [{ role: 'assistant', content: 'Three launch hooks are ready.' }],
            });
        }
        throw new Error(`Unexpected MuAPI URL: ${href}`);
    };
}

test('Creator Agent registry exposes exactly the approved internal workforce and specialty mapping', () => {
    assert.equal(CREATOR_AGENT_KEYS.length, 8);
    assert.deepEqual(listCreatorAgentDefinitions().map((agent) => agent.id), CREATOR_AGENT_KEYS);
    assert.equal(getCreatorAgentDefinition('content-writer').name, 'G.FURY Content Writer');
    assert.equal(creatorAgentForSpecialty('research').id, 'research-trends');
    assert.equal(creatorAgentForSpecialty('campaign').id, 'marketing-strategist');
    assert.equal(creatorAgentForSpecialty('storyboard').id, 'video-director');
});

test('unknown and disabled Creator Agents are rejected with distinct error codes', () => {
    assert.throws(
        () => getCreatorAgentDefinition('not-registered'),
        (error) => error instanceof CreatorAgentRegistryError && error.code === 'unknown_agent' && error.status === 404,
    );
    const disabledRegistry = {
        ...CREATOR_AGENT_REGISTRY,
        'content-writer': { ...CREATOR_AGENT_REGISTRY['content-writer'], enabled: false },
    };
    assert.throws(
        () => getCreatorAgentDefinition('content-writer', { registry: disabledRegistry }),
        (error) => error instanceof CreatorAgentRegistryError && error.code === 'agent_disabled' && error.status === 409,
    );
});

test('Selena allowlist keeps direct tools direct and rejects arbitrary or unregistered agent actions', () => {
    const direct = normalizeSelenaPlan({
        structuredOutput: {
            message: 'Open the editor.',
            plan: [],
            suggestedActions: [
                { action: 'graphic.open', parameters: {} },
                { action: 'function.call', parameters: { name: 'dangerous' } },
                { action: 'agent.delegate', parameters: { agentId: 'unregistered-agent', task: 'Do work.' } },
            ],
            referencedAssets: [],
        },
    });
    assert.deepEqual(direct.suggestedActions.map((action) => action.action), ['graphic.open']);
    assert.equal(direct.suggestedActions[0].requiresApproval, false);
});

test('ensureCreatorAgents is idempotent and does not duplicate provisioned agents', async () => {
    const externalAgents = [];
    let creates = 0;
    const fetchImpl = async (url, options = {}) => {
        const href = String(url);
        if (href.endsWith('/agents/user/agents')) return jsonResponse(externalAgents);
        if (href.endsWith('/agents') && options.method === 'POST') {
            creates += 1;
            const body = parsedRequestBody(options);
            const created = { agent_id: slugFor(body.name), name: body.name, description: body.description };
            externalAgents.push(created);
            return jsonResponse(created, 201);
        }
        throw new Error(`Unexpected MuAPI URL: ${href}`);
    };

    const first = await ensureCreatorAgents({ env: baseEnv, fetchImpl });
    const second = await ensureCreatorAgents({ env: baseEnv, fetchImpl });
    assert.equal(creates, CREATOR_AGENT_KEYS.length);
    assert.equal(first.filter((item) => item.status === 'created').length, CREATOR_AGENT_KEYS.length);
    assert.equal(second.every((item) => item.status === 'ready'), true);
    assert.equal(externalAgents.length, CREATOR_AGENT_KEYS.length);
});

test('browser payload cannot supply external Agent ID or MuAPI key', async () => {
    resetRateLimitStore();
    const { projectStore, auditStore } = await seedProjects();
    for (const forbidden of [
        { externalAgentId: EXTERNAL_AGENT_ID },
        { agentSlug: EXTERNAL_AGENT_ID },
        { apiKey: PROVIDER_KEY },
    ]) {
        const response = await handleCreatorAgentRoute(
            creatorRequest('agents/delegate', {
                agentId: 'content-writer',
                task: 'Write three hooks.',
                projectId: PROJECT_A,
                ...forbidden,
            }),
            {
                path: ['delegate'],
                env: baseEnv,
                blobStore: projectStore,
                auditBlobStore: auditStore,
                fetchImpl: async () => { throw new Error('Provider must not be reached.'); },
            },
        );
        assert.equal(response.status, 400);
        const body = await response.json();
        assert.equal(body.code, 'external_agent_id_forbidden');
    }
});

test('Creator Agent delegation resolves external Agent ID server-side and never returns provider credentials', async () => {
    resetRateLimitStore();
    const { projectStore, auditStore } = await seedProjects();
    const capture = [];
    const browserPayload = {
        agentId: 'content-writer',
        task: 'Write three launch hooks.',
        projectId: PROJECT_A,
        assetId: ASSET_A,
    };
    const serializedBrowserPayload = JSON.stringify(browserPayload);
    assert.equal(serializedBrowserPayload.includes(EXTERNAL_AGENT_ID), false);
    assert.equal(serializedBrowserPayload.includes(PROVIDER_KEY), false);

    const response = await handleCreatorAgentRoute(
        creatorRequest('agents/delegate', browserPayload),
        {
            path: ['delegate'],
            env: baseEnv,
            blobStore: projectStore,
            auditBlobStore: auditStore,
            fetchImpl: completedAgentFetch({ capture }),
            pollOptions: { maxAttempts: 1, intervalMs: 0 },
        },
    );
    assert.equal(response.status, 200);
    const text = await response.text();
    const body = JSON.parse(text);
    assert.equal(body.result.agentId, 'content-writer');
    assert.equal(body.result.agentName, 'G.FURY Content Writer');
    assert.equal(body.result.status, 'completed');
    assert.deepEqual(body.result.referencedAssets, [ASSET_A]);
    assert.equal(text.includes(EXTERNAL_AGENT_ID), false);
    assert.equal(text.includes(PROVIDER_KEY), false);

    const chat = capture.find((entry) => entry.url.includes('/agents/by-slug/'));
    assert.ok(chat);
    assert.equal(chat.url.includes(EXTERNAL_AGENT_ID), true);
    assert.equal(new Headers(chat.options.headers).get('x-api-key'), PROVIDER_KEY);
    assert.equal(decodedRequestBody(chat.options).includes(PROVIDER_KEY), false);
});

test('bounded Agent context is isolated to the selected Project', async () => {
    const { projectStore, auditStore } = await seedProjects();
    const capture = [];
    await delegateCreatorAgent(githubUser, {
        agentId: 'content-writer',
        task: 'Write copy for Project Beta.',
        projectId: PROJECT_B,
        assetId: ASSET_B,
    }, {
        env: baseEnv,
        blobStore: projectStore,
        auditBlobStore: auditStore,
        fetchImpl: completedAgentFetch({ capture }),
        pollOptions: { maxAttempts: 1, intervalMs: 0 },
    });

    const chat = capture.find((entry) => entry.url.includes('/chat'));
    const submitted = parsedRequestBody(chat.options);
    assert.equal(submitted.message.includes('Project Beta'), true);
    assert.equal(submitted.message.includes('Beta image'), true);
    assert.equal(submitted.message.includes('Project Alpha'), false);
    assert.equal(submitted.message.includes('Alpha image'), false);
    assert.equal(submitted.message.includes(ASSET_A), false);
});

test('Asset ownership is enforced before the Agent provider is called', async () => {
    const { projectStore, auditStore } = await seedProjects();
    let providerCalled = false;
    await assert.rejects(
        () => delegateCreatorAgent(githubUser, {
            agentId: 'content-writer',
            task: 'Use this asset.',
            projectId: PROJECT_B,
            assetId: ASSET_A,
        }, {
            env: baseEnv,
            blobStore: projectStore,
            auditBlobStore: auditStore,
            fetchImpl: async () => { providerCalled = true; return jsonResponse({}); },
        }),
        (error) => error instanceof CreatorAgentError && error.code === 'asset_not_owned' && error.status === 403,
    );
    assert.equal(providerCalled, false);
});

test('Agent timeout is normalized and does not claim completion', async () => {
    resetRateLimitStore();
    const { projectStore, auditStore } = await seedProjects();
    const fetchImpl = async (url) => {
        const href = String(url);
        if (href.endsWith('/agents/user/agents')) {
            return jsonResponse([{ agent_id: EXTERNAL_AGENT_ID, name: 'G.FURY Content Writer' }]);
        }
        if (href.includes('/chat')) return jsonResponse({ request_id: 'prediction-timeout-123' });
        if (href.endsWith('/api/v1/predictions/prediction-timeout-123/result')) {
            return jsonResponse({ is_complete: false, messages: [] });
        }
        throw new Error(`Unexpected URL: ${href}`);
    };
    const response = await handleCreatorAgentRoute(
        creatorRequest('agents/delegate', {
            agentId: 'content-writer',
            task: 'Write three hooks.',
            projectId: PROJECT_A,
        }),
        {
            path: ['delegate'],
            env: baseEnv,
            blobStore: projectStore,
            auditBlobStore: auditStore,
            fetchImpl,
            pollOptions: { maxAttempts: 1, intervalMs: 0 },
        },
    );
    assert.equal(response.status, 504);
    const body = await response.json();
    assert.equal(body.code, 'agent_timeout');
});

test('malformed Agent provider responses fail closed', async () => {
    resetRateLimitStore();
    const { projectStore, auditStore } = await seedProjects();
    const fetchImpl = async (url) => {
        const href = String(url);
        if (href.endsWith('/agents/user/agents')) {
            return jsonResponse([{ agent_id: EXTERNAL_AGENT_ID, name: 'G.FURY Content Writer' }]);
        }
        if (href.includes('/chat')) return new Response('not-json', { status: 200 });
        throw new Error(`Unexpected URL: ${href}`);
    };
    const response = await handleCreatorAgentRoute(
        creatorRequest('agents/delegate', {
            agentId: 'content-writer',
            task: 'Write three hooks.',
            projectId: PROJECT_A,
        }),
        {
            path: ['delegate'],
            env: baseEnv,
            blobStore: projectStore,
            auditBlobStore: auditStore,
            fetchImpl,
        },
    );
    assert.equal(response.status, 502);
    const body = await response.json();
    assert.equal(body.code, 'agent_provider_invalid_response');
});

test('Selena delegates specialized work and preserves approval gates on consequential follow-up actions', async () => {
    resetRateLimitStore();
    const { projectStore, auditStore } = await seedProjects();
    const env = {
        ...baseEnv,
        GEMINI_API_KEY: 'gemini-agent-test-provider-secret',
        BRAIN_PROVIDER: 'gemini',
        BRAIN_ENABLE_AUTOMATIC_FALLBACK: 'false',
    };
    const capture = [];
    const fetchImpl = async (url, options = {}) => {
        const href = String(url);
        capture.push({ url: href, options });
        if (href.includes('generativelanguage.googleapis.com')) {
            return jsonResponse({
                modelVersion: 'gemini-3.7-flash',
                candidates: [{
                    content: { parts: [{ text: JSON.stringify({
                        message: 'I will delegate the writing and keep publishing behind review.',
                        plan: ['Draft hooks.', 'Review social post.'],
                        suggestedActions: [
                            {
                                action: 'agent.delegate',
                                parameters: {
                                    agentId: 'content-writer',
                                    task: 'Write three launch hooks.',
                                    assetId: ASSET_A,
                                },
                            },
                            {
                                action: 'social.publish',
                                parameters: {
                                    assetId: ASSET_A,
                                    platform: 'instagram',
                                    caption: 'Launch caption',
                                },
                            },
                        ],
                        referencedAssets: [ASSET_A],
                    }) }] },
                    finishReason: 'STOP',
                }],
            });
        }
        if (href.endsWith('/agents/user/agents')) {
            return jsonResponse([{ agent_id: EXTERNAL_AGENT_ID, name: 'G.FURY Content Writer' }]);
        }
        if (href.includes(`/agents/by-slug/${EXTERNAL_AGENT_ID}/chat`)) {
            return jsonResponse({ request_id: 'prediction-agent-123' });
        }
        if (href.endsWith('/api/v1/predictions/prediction-agent-123/result')) {
            return jsonResponse({
                is_complete: true,
                conversation_id: 'conversation-agent-123',
                messages: [{ role: 'assistant', content: 'Hook 1. Hook 2. Hook 3.' }],
                suggestions: [{ text: 'Prepare the strongest hook for social review.' }],
            });
        }
        throw new Error(`Unexpected URL: ${href}`);
    };

    const response = await handleSelenaAgentAssistant(
        creatorRequest('assistant', {
            prompt: 'Write three launch hooks and prepare the next Instagram step.',
            mode: 'strategy',
            projectId: PROJECT_A,
            selectedAssetId: ASSET_A,
            workspace: 'Selena',
        }),
        {
            env,
            fetchImpl,
            blobStore: projectStore,
            auditBlobStore: auditStore,
            pollOptions: { maxAttempts: 1, intervalMs: 0 },
        },
    );
    assert.equal(response.status, 200);
    const text = await response.text();
    const body = JSON.parse(text);
    assert.equal(body.agentDelegation.status, 'completed');
    assert.equal(body.agentResult.agentId, 'content-writer');
    assert.equal(body.agentResult.message, 'Hook 1. Hook 2. Hook 3.');
    assert.deepEqual(body.suggestedActions.map((action) => action.action), ['social.publish']);
    assert.equal(body.suggestedActions[0].requiresApproval, true);
    assert.equal(body.requiresApproval, true);
    assert.equal(text.includes(EXTERNAL_AGENT_ID), false);
    assert.equal(text.includes(PROVIDER_KEY), false);
});

test('Selena reports an unavailable specialized Agent without bypassing the normal plan', async () => {
    resetRateLimitStore();
    const { projectStore, auditStore } = await seedProjects();
    const env = {
        ...baseEnv,
        GEMINI_API_KEY: 'gemini-agent-test-provider-secret',
        BRAIN_PROVIDER: 'gemini',
        BRAIN_ENABLE_AUTOMATIC_FALLBACK: 'false',
        CREATOR_AGENT_AUTO_PROVISION: 'false',
    };
    const fetchImpl = async (url) => {
        const href = String(url);
        if (href.includes('generativelanguage.googleapis.com')) {
            return jsonResponse({
                modelVersion: 'gemini-3.7-flash',
                candidates: [{
                    content: { parts: [{ text: JSON.stringify({
                        message: 'This needs specialized writing.',
                        plan: ['Delegate the hooks.'],
                        suggestedActions: [{
                            action: 'agent.delegate',
                            parameters: { agentId: 'content-writer', task: 'Write three hooks.' },
                        }],
                        referencedAssets: [],
                    }) }] },
                    finishReason: 'STOP',
                }],
            });
        }
        if (href.endsWith('/agents/user/agents')) return jsonResponse([]);
        throw new Error(`Unexpected URL: ${href}`);
    };
    const response = await handleSelenaAgentAssistant(
        creatorRequest('assistant', {
            prompt: 'Write three hooks.',
            projectId: PROJECT_A,
            workspace: 'Selena',
        }),
        { env, fetchImpl, blobStore: projectStore, auditBlobStore: auditStore },
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.agentDelegation.status, 'blocked');
    assert.equal(body.agentDelegation.code, 'agent_not_provisioned');
    assert.equal(body.suggestedActions[0].action, 'agent.delegate');
    assert.equal(body.suggestedActions[0].available, false);
});
