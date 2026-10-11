// Local browser-verification fixture for the Replicate Creator Studio UI.
// Run: node --experimental-test-module-mocks scripts/replicate-ui-fixture-server.mjs
// Then: CREATOR_UI_FIXTURE_ORIGIN=http://127.0.0.1:4010 npm run dev
// GENERATION_MODE stays 'mock'; all credentials are fabricated; every outbound
// fetch not addressed to this server's own origin is counted and refused.
// Nothing in the Next app imports this file.

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mock } from 'node:test';

import { createCreatorSession, creatorCookieSettings } from '../src/lib/creatorAuth.js';
import { creatorProjectStoreForTests } from '../src/lib/creatorProjectStore.js';
import { resetRateLimitStore } from '../src/lib/rateLimit.js';
import { authorizeCreatorRequest, creatorJson } from '../src/lib/creatorProviderGateway.js';

const gatewayUrl = new URL('../src/lib/replicateGateway.js', import.meta.url);
const projectRoutesUrl = new URL('../src/lib/creatorProjectRoutes.js', import.meta.url);
const nativeFetch = globalThis.fetch;
const PORT = Number(process.env.FIXTURE_PORT || 4010);
const env = {
    NODE_ENV: 'development',
    BLOB_READ_WRITE_TOKEN: 'private-blob-fixture-test-token-only',
    CREATOR_ASSET_BLOB_READ_WRITE_TOKEN: 'public-blob-fixture-test-token-only',
    CREATOR_SESSION_SECRET: 'creator-ui-fixture-session-secret-over-thirty-two-characters',
    CREATOR_GITHUB_ALLOWED_USER_IDS: '12345678,87654321',
    CREATOR_GITHUB_ALLOWED_LOGINS: 'fixture-owner,other-owner',
    CREATOR_STUDIO_RATE_LIMIT: '200',
    CREATOR_STUDIO_STATUS_RATE_LIMIT: '200',
    CONTENT_SAFETY_MODE: 'enforce',
    GENERATION_MODE: 'mock',
    REPLICATE_LIVE_ENABLED: 'false',
};
const owner = { id: 12345678, login: 'fixture-owner' };
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
let holdSubmissions = false;
const heldJobs = new Map();
const traffic = { generate: 0, status: 0, quote: 0, statusByJob: {} };
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

// Extend only the fixture's injected provider boundary. A real mock job record
// is saved as queued, and the normal status handler settles it after release.
const providerUrl = new URL('../src/lib/replicateProvider.js', import.meta.url);
const realProvider = await import(providerUrl);
mock.module(providerUrl.href, {
    cache: true,
    namedExports: {
        ...realProvider,
        async submitReplicateJob(...args) {
            const result = await realProvider.submitReplicateJob(...args);
            if (!holdSubmissions || !result.ok || !result.job.mock) return result;
            return { ...result, status: 202, job: { ...result.job, status: 'queued' } };
        },
    },
});
const realGateway = await import(gatewayUrl);
const realProjects = await import(projectRoutesUrl);

async function fixtureGateway(name, handler, request, options) {
    const context = { ...ctx, ...options };
    if (name === 'handleReplicateStatus') {
        const auth = authorizeCreatorRequest(request, { env, action: 'replicate-status', statusRequest: true });
        if (auth.response) return auth.response;
        const jobId = new URL(request.url).searchParams.get('id');
        const held = heldJobs.get(jobId);
        if (held && held.userId === String(auth.user.id)) {
            if (held.missing) return creatorJson({ error: 'Generation job not found.' }, 404);
            if (!held.released) return creatorJson({ job: { ...held.job, status: 'running' } });
        }
    }
    const response = await handler(request, context);
    if (name === 'handleReplicateGenerate' && response.status === 202) {
        const { job } = await response.clone().json();
        const auth = authorizeCreatorRequest(request, { env, action: 'fixture-generated', statusRequest: true });
        if (job?.mock && auth.user) heldJobs.set(job.jobId, { job, userId: String(auth.user.id), released: false, missing: false });
    }
    return response;
}

// Only the dependency boundary is replaced. Dispatch, auth, validation,
// provider, guard, persistence and Project handlers are the real implementation.
mock.module(gatewayUrl.href, {
    cache: true,
    namedExports: Object.fromEntries(Object.entries(realGateway).map(([name, handler]) => [name,
        (request, options = {}) => fixtureGateway(name, handler, request, options),
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
        throw new Error('external fetch blocked by UI fixture');
    }
    return nativeFetch(url, options);
};
const server = createServer(async (incoming, outgoing) => {
    try {
        const bytes = [];
        for await (const chunk of incoming) bytes.push(chunk);
        const method = incoming.method;
        const host = incoming.headers['x-forwarded-host'] || incoming.headers.host;
        const proto = incoming.headers['x-forwarded-proto'] || 'http';
        const request = new Request(`${proto}://${host}${incoming.url}`, {
            method, headers: incoming.headers,
            ...(['GET', 'HEAD'].includes(method) ? {} : { body: Buffer.concat(bytes) }),
        });
        const pathname = new URL(request.url).pathname;
        if (pathname === '/api/creator/__fixture/stats' && method === 'GET') {
            outgoing.writeHead(200, { 'content-type': 'application/json' });
            outgoing.end(JSON.stringify({ ...traffic, forbiddenFetches, stubCalls, heldJobs: heldJobs.size, mode: env.GENERATION_MODE }));
            return;
        }
        if (pathname === '/api/creator/__fixture/control' && method === 'POST') {
            const body = JSON.parse(Buffer.concat(bytes).toString());
            if (body.action === 'hold') holdSubmissions = true;
            else if (body.action === 'release' || body.action === 'missing') {
                const held = heldJobs.get(body.jobId);
                if (!held) { outgoing.writeHead(404); outgoing.end(JSON.stringify({ error: 'No held fixture job.' })); return; }
                held[body.action === 'release' ? 'released' : 'missing'] = true;
            } else { outgoing.writeHead(400); outgoing.end(JSON.stringify({ error: 'Unknown fixture control.' })); return; }
            outgoing.writeHead(200, { 'content-type': 'application/json' });
            outgoing.end(JSON.stringify({ ok: true }));
            return;
        }
        if (pathname === '/api/creator/__fixture/login') {
            const cookie = `${creatorCookieSettings(env).sessionName}=${createCreatorSession(owner, { env })}; Path=/; HttpOnly; SameSite=Lax`;
            outgoing.writeHead(302, { 'set-cookie': cookie, location: '/studio' });
            outgoing.end();
            return;
        }
        if (method === 'GET' && pathname.startsWith('/api/creator/__fixture/media/')) {
            const bytes = media.get(decodeURIComponent(pathname.slice('/api/creator/__fixture/media/'.length)));
            if (!bytes) { outgoing.writeHead(404); outgoing.end(); return; }
            outgoing.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
            outgoing.end(bytes);
            return;
        }
        const path = pathname.split('/').slice(3);
        if (path[0] === 'replicate') {
            if (path[1] === 'generate' && method === 'POST') traffic.generate += 1;
            if (path[1] === 'quote' && method === 'POST') traffic.quote += 1;
            if (path[1] === 'status' && method === 'GET') {
                traffic.status += 1;
                const id = new URL(request.url).searchParams.get('id');
                traffic.statusByJob[id] = (traffic.statusByJob[id] || 0) + 1;
            }
        }
        if (!pathname.startsWith('/api/creator/') || !['projects', 'replicate'].includes(path[0]) || typeof route[method] !== 'function') {
            outgoing.writeHead(404, { 'content-type': 'application/json' });
            outgoing.end(JSON.stringify({ error: 'Not a fixture route.' }));
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

server.on('error', (error) => { console.error(error.message); process.exit(1); });
await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));
origin = `http://127.0.0.1:${server.address().port}`;
console.log(`Fixture API ready on ${origin}`);
console.log(`Start Next with: CREATOR_UI_FIXTURE_ORIGIN=${origin} npm run dev`);
console.log(`Then sign in via: http://localhost:3000/api/creator/__fixture/login (use the actual Next port)`);
const shutdown = () => {
    console.log(`Fixture stopping; blocked outbound fetches: ${forbiddenFetches}; injected provider calls: ${stubCalls}`);
    globalThis.fetch = nativeFetch;
    server.closeAllConnections();
    server.close(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGUSR2', () => console.log(`outbound-fetch-blocked=${forbiddenFetches} stubCalls=${stubCalls}`));
