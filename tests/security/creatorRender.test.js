import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import test from 'node:test';

import { createCreatorSession, creatorCookieSettings } from '../../src/lib/creatorAuth.js';
import { handleCreatorProjectRoute } from '../../src/lib/creatorProjectRoutes.js';
import {
    CreatorProjectError,
    createCreatorProject,
    creatorProjectStoreForTests,
    getCreatorProject,
    renameCreatorProject,
    renderCreatorTimeline,
    saveCreatorStoryboard,
} from '../../src/lib/creatorProjectStore.js';
import { resetRateLimitStore } from '../../src/lib/rateLimit.js';

const env = {
    BLOB_READ_WRITE_TOKEN: 'vercel-blob-test-token-that-is-long-enough',
    CREATOR_ASSET_BLOB_READ_WRITE_TOKEN: 'creator-public-blob-test-token-that-is-long-enough',
    CREATOR_SESSION_SECRET: 'creator-project-test-secret-that-is-longer-than-thirty-two-characters',
    CREATOR_GITHUB_ALLOWED_USER_IDS: '12345678',
    CREATOR_GITHUB_ALLOWED_LOGINS: 'lalambert1982-eng',
    CREATOR_STUDIO_RATE_LIMIT: '50',
    CREATOR_STUDIO_STATUS_RATE_LIMIT: '50',
    CONTENT_SAFETY_MODE: 'enforce',
    CREATOR_RENDER_ENABLED: 'true',
};
const owner = { id: 12345678, login: 'lalambert1982-eng' };
const projectId = '11111111-1111-4111-8111-111111111111';
const sceneImage = 'https://cdn.muapi.ai/scene-1.png';

let counter = 0;
const idGenerator = () => `33333333-3333-4333-8333-${String(++counter).padStart(12, '0')}`;

async function projectWithOneScene(blobStore) {
    await createCreatorProject(owner, { name: 'Render Project' }, { env, blobStore, idGenerator: () => projectId });
    return saveCreatorStoryboard(owner, projectId, {
        storyboard: { scenes: [{ id: 'scene-1', title: 'Opening', imageUrl: sceneImage, duration: 4 }] },
    }, { env, blobStore });
}

function mediaFetch(calls = []) {
    return async (url, options) => {
        calls.push({ url, options });
        return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    };
}

async function fakeFfmpeg(_path, args) {
    await writeFile(args.at(-1), Buffer.from('rendered-mp4'));
}

function assetStore() {
    const puts = [];
    return {
        puts,
        dels: [],
        async del(pathname) {
            this.dels.push(pathname);
        },
        async put(pathname, body, options) {
            puts.push({ pathname, body, options });
            return { pathname, url: `https://store.public.blob.vercel-storage.com/${pathname}` };
        },
    };
}

test('rendering is disabled unless CREATOR_RENDER_ENABLED=true', async () => {
    const blobStore = creatorProjectStoreForTests();
    await projectWithOneScene(blobStore);
    await assert.rejects(
        renderCreatorTimeline(owner, projectId, {}, { env: { ...env, CREATOR_RENDER_ENABLED: '' }, blobStore }),
        (error) => error instanceof CreatorProjectError && error.code === 'render_disabled' && error.status === 503,
    );
});

test('rendering requires the public Creator Asset store', async () => {
    const blobStore = creatorProjectStoreForTests();
    await projectWithOneScene(blobStore);
    await assert.rejects(
        renderCreatorTimeline(owner, projectId, {}, { env: { ...env, CREATOR_ASSET_BLOB_READ_WRITE_TOKEN: '' }, blobStore }),
        (error) => error.code === 'asset_storage_unconfigured' && error.status === 503,
    );
});

test('a successful render uploads to the asset store and records a new video Asset', async () => {
    const blobStore = creatorProjectStoreForTests();
    await projectWithOneScene(blobStore);
    const assets = assetStore();
    const calls = [];
    const result = await renderCreatorTimeline(owner, projectId, {}, {
        env, blobStore, assetBlobStore: assets, idGenerator, fetchImpl: mediaFetch(calls), execFileImpl: fakeFfmpeg,
    });

    assert.equal(result.status, 201);
    assert.equal(result.render.status, 'complete');
    assert.equal(calls[0].url, sceneImage);
    assert.equal(calls[0].options.redirect, 'error');
    assert.equal(assets.puts.length, 1);
    assert.equal(assets.puts[0].options.token, env.CREATOR_ASSET_BLOB_READ_WRITE_TOKEN);
    assert.equal(assets.puts[0].options.access, 'public');
    assert.match(assets.puts[0].pathname, /^creator-assets\/11111111-1111-4111-8111-111111111111\/render-/);
    const stored = await getCreatorProject(owner, projectId, { env, blobStore });
    assert.equal(stored.assets[0].id, result.render.outputAssetId);
    assert.equal(stored.assets[0].source, 'render');
    assert.equal(stored.renders[0].id, result.render.id);
});

test('edits made while a render runs are preserved, not overwritten', async () => {
    const blobStore = creatorProjectStoreForTests();
    await projectWithOneScene(blobStore);
    const result = await renderCreatorTimeline(owner, projectId, {}, {
        env,
        blobStore,
        assetBlobStore: assetStore(),
        idGenerator,
        fetchImpl: mediaFetch(),
        execFileImpl: async (path, args) => {
            await renameCreatorProject(owner, projectId, { name: 'Renamed mid-render' }, { env, blobStore });
            await fakeFfmpeg(path, args);
        },
    });
    assert.equal(result.render.status, 'complete');
    const stored = await getCreatorProject(owner, projectId, { env, blobStore });
    assert.equal(stored.name, 'Renamed mid-render');
    assert.equal(stored.assets[0].source, 'render');
});

test('a failed render is recorded as failed without leaking engine output', async () => {
    const blobStore = creatorProjectStoreForTests();
    await projectWithOneScene(blobStore);
    const assets = assetStore();
    const result = await renderCreatorTimeline(owner, projectId, {}, {
        env,
        blobStore,
        assetBlobStore: assets,
        idGenerator,
        fetchImpl: mediaFetch(),
        execFileImpl: async () => { throw Object.assign(new Error('/tmp/secret-path: stderr detail'), { code: 1 }); },
    });
    assert.equal(result.status, 502);
    assert.equal(result.render.status, 'failed');
    assert.equal(result.render.code, 'render_failed');
    assert.equal(JSON.stringify(result).includes('secret-path'), false);
    assert.equal(assets.puts.length, 0);
    const stored = await getCreatorProject(owner, projectId, { env, blobStore });
    assert.equal(stored.assets.length, 0);
    assert.equal(stored.renders[0].status, 'failed');
});

test('a source outside the asset host allowlist or over the size cap fails the render', async () => {
    const blobStore = creatorProjectStoreForTests();
    await projectWithOneScene(blobStore);
    const result = await renderCreatorTimeline(owner, projectId, {}, {
        env,
        blobStore,
        assetBlobStore: assetStore(),
        idGenerator,
        fetchImpl: async () => new Response('x', { status: 200, headers: { 'content-length': String(300 * 1024 * 1024) } }),
        execFileImpl: fakeFfmpeg,
    });
    assert.equal(result.render.status, 'failed');
    assert.equal(result.render.code, 'render_source_too_large');
});

test('a timeline without media fails with a clear, recorded reason', async () => {
    const blobStore = creatorProjectStoreForTests();
    await createCreatorProject(owner, { name: 'Empty' }, { env, blobStore, idGenerator: () => projectId });
    const result = await renderCreatorTimeline(owner, projectId, {}, {
        env, blobStore, assetBlobStore: assetStore(), idGenerator, fetchImpl: mediaFetch(), execFileImpl: fakeFfmpeg,
    });
    assert.equal(result.status, 422);
    assert.equal(result.render.code, 'render_no_clips');
});

test('the render route requires a signed-in same-origin request', async () => {
    resetRateLimitStore();
    const blobStore = creatorProjectStoreForTests();
    await projectWithOneScene(blobStore);
    const unauthenticated = await handleCreatorProjectRoute(new Request(`https://studio.test/api/creator/projects/${projectId}/render`, {
        method: 'POST',
    }), { path: [projectId, 'render'], env, blobStore });
    assert.equal(unauthenticated.status, 401);

    const session = createCreatorSession(owner, { env });
    const cookie = `${creatorCookieSettings(env).sessionName}=${session}`;
    const disabled = await handleCreatorProjectRoute(new Request(`https://studio.test/api/creator/projects/${projectId}/render`, {
        method: 'POST',
        headers: { cookie, origin: 'https://studio.test', 'sec-fetch-site': 'same-origin' },
    }), { path: [projectId, 'render'], env: { ...env, CREATOR_RENDER_ENABLED: 'false' }, blobStore });
    assert.equal(disabled.status, 503);
    assert.equal((await disabled.json()).code, 'render_disabled');
});

function conflictingStore(blobStore) {
    const state = { conflicts: 0, busy: false };
    const store = {
        ...blobStore,
        async get(pathname, options) {
            if (state.conflicts > 0 && !state.busy) {
                state.conflicts -= 1;
                state.busy = true;
                try {
                    await renameCreatorProject(owner, projectId, { name: `edit ${state.conflicts}` }, { env, blobStore: store });
                } finally {
                    state.busy = false;
                }
            }
            return blobStore.get(pathname, options);
        },
    };
    return { store, state };
}

test('a render commit retries after a concurrent Project write instead of discarding the render', async () => {
    const base = creatorProjectStoreForTests();
    await projectWithOneScene(base);
    const { store, state } = conflictingStore(base);
    const assets = assetStore();
    const result = await renderCreatorTimeline(owner, projectId, {}, {
        env, blobStore: store, assetBlobStore: assets, idGenerator, fetchImpl: mediaFetch(),
        execFileImpl: async (path, args) => { await fakeFfmpeg(path, args); state.conflicts = 2; },
    });
    assert.equal(result.render.status, 'complete');
    assert.equal(assets.dels.length, 0);
    const stored = await getCreatorProject(owner, projectId, { env, blobStore: base });
    assert.match(stored.name, /^edit /);
    assert.equal(stored.assets[0].source, 'render');
});

test('when the commit keeps conflicting, the uploaded render is deleted rather than orphaned', async () => {
    const base = creatorProjectStoreForTests();
    await projectWithOneScene(base);
    const { store, state } = conflictingStore(base);
    const assets = assetStore();
    await assert.rejects(
        renderCreatorTimeline(owner, projectId, {}, {
            env, blobStore: store, assetBlobStore: assets, idGenerator, fetchImpl: mediaFetch(),
            execFileImpl: async (path, args) => { await fakeFfmpeg(path, args); state.conflicts = 100; },
        }),
        (error) => error.code === 'project_conflict',
    );
    assert.equal(assets.puts.length, 1);
    assert.deepEqual(assets.dels, [assets.puts[0].pathname]);
});

test('ffmpeg is bounded by the overall render budget', async () => {
    const blobStore = creatorProjectStoreForTests();
    await projectWithOneScene(blobStore);
    let timeout;
    await renderCreatorTimeline(owner, projectId, {}, {
        env: { ...env, CREATOR_RENDER_MAX_MS: '30000' }, blobStore, assetBlobStore: assetStore(), idGenerator, fetchImpl: mediaFetch(),
        execFileImpl: async (path, args, options) => { timeout = options.timeout; await fakeFfmpeg(path, args); },
    });
    assert.ok(timeout > 0 && timeout <= 30_000);
});

test('many sources that are each under the cap but too large together fail the render', async () => {
    const blobStore = creatorProjectStoreForTests();
    await createCreatorProject(owner, { name: 'Render Project' }, { env, blobStore, idGenerator: () => projectId });
    await saveCreatorStoryboard(owner, projectId, {
        storyboard: {
            scenes: [1, 2, 3].map((n) => ({ id: `scene-${n}`, title: `Scene ${n}`, imageUrl: sceneImage, duration: 4 })),
        },
    }, { env, blobStore });
    const result = await renderCreatorTimeline(owner, projectId, {}, {
        env,
        blobStore,
        assetBlobStore: assetStore(),
        idGenerator,
        fetchImpl: async () => new Response(Buffer.alloc(200 * 1024 * 1024), { status: 200 }),
        execFileImpl: fakeFfmpeg,
    });
    assert.equal(result.render.status, 'failed');
    assert.equal(result.render.code, 'render_sources_too_large');
});
