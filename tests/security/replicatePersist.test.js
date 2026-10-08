import assert from 'node:assert/strict';
import test from 'node:test';

import {
    createCreatorProject,
    creatorProjectStoreForTests,
    getCreatorProject,
} from '../../src/lib/creatorProjectStore.js';
import { PersistError, isReplicateDeliveryUrl, persistGeneratedAsset } from '../../src/lib/replicatePersist.js';

const env = {
    BLOB_READ_WRITE_TOKEN: 'vercel-blob-test-token-that-is-long-enough',
    CREATOR_ASSET_BLOB_READ_WRITE_TOKEN: 'creator-public-blob-test-token-that-is-long-enough',
    CREATOR_SESSION_SECRET: 'creator-project-test-secret-that-is-longer-than-thirty-two-characters',
};
const owner = { id: 12345678, login: 'a' };
const other = { id: 87654321, login: 'b' };
const projectId = '11111111-1111-4111-8111-111111111111';
const record = { jobId: 'abc123def456ghi789jkl012mn', kind: 'image', model: 'black-forest-labs/flux-schnell', mock: false, prompt: 'a red fox' };

function assetStore() {
    const puts = [];
    return {
        puts,
        async put(pathname, body, options) {
            puts.push({ pathname, size: body.length, options });
            return { url: `https://creator.public.blob.vercel-storage.com/${pathname}`, pathname };
        },
        async del() {},
    };
}

async function setup() {
    const blobStore = creatorProjectStoreForTests(new Map());
    await createCreatorProject(owner, { name: 'P' }, { env, blobStore, idGenerator: () => projectId });
    return { blobStore, assetBlobStore: assetStore() };
}

function mediaResponse(type, bytes = Buffer.from('fake-media')) {
    return new Response(bytes, { status: 200, headers: { 'content-type': type, 'content-length': String(bytes.length) } });
}

test('only replicate.delivery HTTPS URLs are downloadable', () => {
    assert.equal(isReplicateDeliveryUrl('https://replicate.delivery/xezq/a/out.png'), true);
    assert.equal(isReplicateDeliveryUrl('https://pbxt.replicate.delivery/a.png'), true);
    for (const bad of ['http://replicate.delivery/a.png', 'https://evil.test/a.png', 'https://replicate.delivery.evil.test/a.png', 'https://user:pw@replicate.delivery/a.png', 'https://127.0.0.1/a.png', 'not a url']) {
        assert.equal(isReplicateDeliveryUrl(bad), false, bad);
    }
});

test('live output is downloaded once, stored publicly at a deterministic path and added as an Asset', async () => {
    const { blobStore, assetBlobStore } = await setup();
    let downloads = 0;
    const fetchImpl = async (url, options) => {
        downloads += 1;
        assert.equal(url, 'https://replicate.delivery/xezq/a/out.png');
        assert.equal(options.redirect, 'error');
        return mediaResponse('image/png');
    };
    const args = { user: owner, projectId, record, outputUrl: 'https://replicate.delivery/xezq/a/out.png', env, fetchImpl, assetBlobStore, blobStore, idGenerator: () => '22222222-2222-4222-8222-222222222222' };
    const first = await persistGeneratedAsset(args);
    assert.equal(first.created, true);
    assert.equal(first.asset.type, 'image');
    assert.equal(first.asset.source, 'replicate');
    assert.equal(first.asset.provider.requestId, record.jobId);
    assert.equal(assetBlobStore.puts[0].pathname, `creator-assets/${projectId}/replicate-${record.jobId}.png`);
    assert.equal(assetBlobStore.puts[0].options.access, 'public');
    const second = await persistGeneratedAsset(args);
    assert.equal(second.created, false);
    assert.equal(second.asset.id, first.asset.id);
    assert.equal((await getCreatorProject(owner, projectId, { env, blobStore })).assets.length, 1);
    assert.equal(downloads, 2);
});

test('mock records store a placeholder PNG typed as a graphic with no download', async () => {
    const { blobStore, assetBlobStore } = await setup();
    const result = await persistGeneratedAsset({
        user: owner,
        projectId,
        record: { ...record, jobId: 'mock_11111111-1111-4111-8111-111111111111', mock: true },
        outputUrl: null,
        env,
        fetchImpl: () => { throw new Error('no download in mock mode'); },
        assetBlobStore,
        blobStore,
    });
    assert.equal(result.asset.type, 'graphic');
    assert.equal(assetBlobStore.puts[0].options.contentType, 'image/png');
    assert.ok(assetBlobStore.puts[0].size > 20);
});

test('unsafe or unusable outputs are rejected and nothing is stored', async () => {
    const { blobStore, assetBlobStore } = await setup();
    const base = { user: owner, projectId, record, env, assetBlobStore, blobStore };
    await assert.rejects(persistGeneratedAsset({ ...base, outputUrl: 'https://evil.test/a.png', fetchImpl: () => { throw new Error('must not fetch'); } }), (e) => e instanceof PersistError && e.status === 502);
    await assert.rejects(persistGeneratedAsset({ ...base, outputUrl: 'https://replicate.delivery/a.html', fetchImpl: async () => mediaResponse('text/html') }), (e) => e instanceof PersistError && e.code === 'unexpected_media_type');
    await assert.rejects(persistGeneratedAsset({ ...base, outputUrl: 'https://replicate.delivery/a.mp4', fetchImpl: async () => mediaResponse('video/mp4') }), (e) => e instanceof PersistError && e.code === 'unexpected_media_type');
    await assert.rejects(persistGeneratedAsset({ ...base, outputUrl: 'https://replicate.delivery/a.png', fetchImpl: async () => new Response('x', { status: 500 }) }), (e) => e instanceof PersistError && e.status === 502);
    await assert.rejects(persistGeneratedAsset({ ...base, outputUrl: 'https://replicate.delivery/a.png', fetchImpl: async () => { throw new Error('net'); } }), (e) => e instanceof PersistError && e.code === 'download_failed');
    const huge = new Response('x', { status: 200, headers: { 'content-type': 'image/png', 'content-length': String(300 * 1024 * 1024) } });
    await assert.rejects(persistGeneratedAsset({ ...base, outputUrl: 'https://replicate.delivery/a.png', fetchImpl: async () => huge }), (e) => e instanceof PersistError && e.status === 413);
    assert.equal(assetBlobStore.puts.length, 0);
});

test('missing asset storage configuration and foreign Projects fail without storing', async () => {
    const { blobStore, assetBlobStore } = await setup();
    const fetchImpl = async () => mediaResponse('image/png');
    const outputUrl = 'https://replicate.delivery/a.png';
    const { CREATOR_ASSET_BLOB_READ_WRITE_TOKEN: _omit, ...noAssetEnv } = env;
    await assert.rejects(persistGeneratedAsset({ user: owner, projectId, record, outputUrl, env: noAssetEnv, fetchImpl, assetBlobStore, blobStore }), (e) => e instanceof PersistError && e.status === 503);
    await assert.rejects(persistGeneratedAsset({ user: other, projectId, record, outputUrl, env, fetchImpl, assetBlobStore, blobStore }), (e) => e.status === 404);
    assert.equal(assetBlobStore.puts.length, 0);
});

test('a mid-stream read failure becomes download_failed and nothing is stored', async () => {
    const { blobStore, assetBlobStore } = await setup();
    const body = new ReadableStream({
        start(controller) {
            controller.enqueue(new Uint8Array(10));
        },
        pull() {
            throw new Error('socket reset');
        },
    });
    const fetchImpl = async () => new Response(body, { status: 200, headers: { 'content-type': 'image/png' } });
    await assert.rejects(
        persistGeneratedAsset({ user: owner, projectId, record, outputUrl: 'https://replicate.delivery/a.png', env, fetchImpl, assetBlobStore, blobStore }),
        (e) => e instanceof PersistError && e.code === 'download_failed' && e.status === 502,
    );
    assert.equal(assetBlobStore.puts.length, 0);
});

test('the uploaded blob is removed when adding the Asset fails, but not when the Asset already exists', async () => {
    const { blobStore, assetBlobStore } = await setup();
    const dels = [];
    assetBlobStore.del = async (...args) => { dels.push(args); };
    const fetchImpl = async () => mediaResponse('image/png');
    const args = { user: owner, projectId, record, outputUrl: 'https://replicate.delivery/a.png', env, fetchImpl, assetBlobStore };
    const failing = { ...blobStore, async put() { throw new Error('manifest write failed'); } };
    await assert.rejects(persistGeneratedAsset({ ...args, blobStore: failing }), (e) => e.message !== undefined && !(e instanceof PersistError && e.code === 'upload_failed'));
    assert.equal(assetBlobStore.puts.length, 1);
    assert.equal(dels.length, 1);
    assert.equal(dels[0][0], assetBlobStore.puts[0].pathname);
    assert.equal(dels[0][1].token, env.CREATOR_ASSET_BLOB_READ_WRITE_TOKEN);
    dels.length = 0;
    assert.equal((await persistGeneratedAsset({ ...args, blobStore })).created, true);
    assert.equal((await persistGeneratedAsset({ ...args, blobStore })).created, false);
    assert.equal(dels.length, 0);
});

test('invalid generation records are rejected with 400 before any work', async () => {
    const { blobStore, assetBlobStore } = await setup();
    const fetchImpl = () => { throw new Error('must not fetch'); };
    const bad = [
        { ...record, jobId: '../x' },
        { ...record, jobId: 'a' },
        { ...record, jobId: 'a'.repeat(61) },
        { ...record, kind: 'audio' },
        { ...record, mock: true },
        { ...record, jobId: 'mock_abc', mock: false },
    ];
    for (const badRecord of bad) {
        await assert.rejects(
            persistGeneratedAsset({ user: owner, projectId, record: badRecord, outputUrl: 'https://replicate.delivery/a.png', env, fetchImpl, assetBlobStore, blobStore }),
            (e) => e instanceof PersistError && e.status === 400 && e.code === 'invalid_record',
            JSON.stringify(badRecord),
        );
    }
    assert.equal(assetBlobStore.puts.length, 0);
});
