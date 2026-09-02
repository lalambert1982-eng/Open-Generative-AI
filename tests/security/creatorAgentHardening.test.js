import assert from 'node:assert/strict';
import test from 'node:test';

import { createCreatorSession, creatorCookieSettings } from '../../src/lib/creatorAuth.js';
import {
    CREATOR_AGENT_KEYS,
} from '../../src/lib/creatorAgentRegistry.js';
import {
    ensureCreatorAgents,
    handleCreatorAgentRoute,
} from '../../src/lib/creatorAgentGateway.js';
import { muapiConfiguration } from '../../src/lib/muapiCreatorProvider.js';
import { resetRateLimitStore } from '../../src/lib/rateLimit.js';

const githubUser = { id: 12345678, login: 'lalambert1982-eng' };
const productionAgentEnv = {
    CREATOR_SESSION_SECRET: 'creator-agent-hardening-session-secret-that-is-longer-than-thirty-two-characters',
    CREATOR_GITHUB_ALLOWED_USER_IDS: '12345678',
    CREATOR_GITHUB_ALLOWED_LOGINS: 'lalambert1982-eng',
    CREATOR_STUDIO_RATE_LIMIT: '200',
    CREATOR_STUDIO_STATUS_RATE_LIMIT: '200',
    CONTENT_SAFETY_MODE: 'enforce',
    MUAPI_KEY_MODE: 'production',
    MUAPI_PRODUCTION_API_KEY: 'muapi-production-agent-provider-secret',
};

function jsonResponse(value, status = 200) {
    return new Response(JSON.stringify(value), {
        status,
        headers: { 'content-type': 'application/json' },
    });
}

function requestBody(options = {}) {
    const body = options.body;
    if (body instanceof ArrayBuffer) return new TextDecoder().decode(body);
    if (ArrayBuffer.isView(body)) {
        return new TextDecoder().decode(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength));
    }
    return typeof body === 'string' ? body : String(body || '');
}

function creatorRequest(body) {
    const session = createCreatorSession(githubUser, { env: productionAgentEnv });
    const sessionCookieName = creatorCookieSettings(productionAgentEnv).sessionName;
    return new Request('https://local.test/api/creator/agents/delegate', {
        method: 'POST',
        headers: {
            cookie: `${sessionCookieName}=${session}`,
            'content-type': 'application/json',
            origin: 'https://local.test',
            'sec-fetch-site': 'same-origin',
        },
        body: JSON.stringify(body),
    });
}

test('text-only Creator Agent access does not require the paid media-generation switch', async () => {
    const mediaConfiguration = muapiConfiguration(productionAgentEnv);
    assert.equal(mediaConfiguration.configured, false);
    assert.equal(mediaConfiguration.missing.includes('MUAPI_ALLOW_PAID_GENERATION=true'), true);

    const externalAgents = [];
    let creates = 0;
    const fetchImpl = async (url, options = {}) => {
        const href = String(url);
        const headers = new Headers(options.headers || {});
        assert.equal(headers.get('x-api-key'), productionAgentEnv.MUAPI_PRODUCTION_API_KEY);

        if (href.endsWith('/agents/user/agents')) return jsonResponse(externalAgents);
        if (href.endsWith('/agents') && options.method === 'POST') {
            creates += 1;
            const body = JSON.parse(requestBody(options));
            const created = {
                agent_id: `creator-agent-${creates}`,
                name: body.name,
                description: body.description,
            };
            externalAgents.push(created);
            return jsonResponse(created, 201);
        }
        throw new Error(`Unexpected MuAPI URL: ${href}`);
    };

    const provisioned = await ensureCreatorAgents({ env: productionAgentEnv, fetchImpl });
    assert.equal(creates, CREATOR_AGENT_KEYS.length);
    assert.equal(provisioned.length, CREATOR_AGENT_KEYS.length);
    assert.equal(provisioned.every((item) => item.status === 'created'), true);
});

test('Creator Agent API rejects unknown client fields before provider access', async () => {
    resetRateLimitStore();
    let providerCalled = false;
    const response = await handleCreatorAgentRoute(
        creatorRequest({
            agentId: 'content-writer',
            task: 'Write three hooks.',
            projectId: '11111111-1111-4111-8111-111111111111',
            surpriseField: 'must fail closed',
        }),
        {
            path: ['delegate'],
            env: productionAgentEnv,
            fetchImpl: async () => {
                providerCalled = true;
                return jsonResponse({});
            },
        },
    );

    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.code, 'unknown_request_field');
    assert.equal(providerCalled, false);
});
