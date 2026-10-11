import test from 'node:test';
import assert from 'node:assert/strict';
import {
    UNCERTAINTY_KEY_PREFIX, createUncertaintyStore,
    createBrowserUncertainty, clearReplicateUncertainty,
} from '../src/lib/replicateUncertainty.js';

const NOW = Date.UTC(2026, 9, 10, 12);
const PROJECT = '11111111-1111-4111-8111-111111111111';
const KEY = 'ogai.replicate.uncertain.v1.image';
const VIDEO_KEY = 'ogai.replicate.uncertain.v1.video';
const IDENTITY = { jobId: null, projectId: PROJECT, userId: '42' };

function memory(initial = {}) {
    const data = { ...initial };
    return {
        data,
        getItem: (key) => Object.hasOwn(data, key) ? data[key] : null,
        setItem: (key, value) => { data[key] = String(value); },
        removeItem: (key) => { delete data[key]; },
    };
}
const make = (storage, now = () => NOW) => createUncertaintyStore({ storage, kind: 'image', now });
const entry = (patch = {}) => JSON.stringify({ v: 1, ...IDENTITY, ts: NOW, ...patch });

test('unknown outcomes persist only identity and reload with an explicit null job ID', () => {
    const storage = memory();
    make(storage).save({ ...IDENTITY, message: 'private error', prompt: 'secret', input: {}, token: 'secret', url: 'https://private' });
    assert.deepEqual(JSON.parse(storage.data[KEY]), { v: 1, ...IDENTITY, ts: NOW });
    assert.equal(UNCERTAINTY_KEY_PREFIX, 'ogai.replicate.uncertain.v1');
    assert.deepEqual(make(storage).load({ userId: '42' }), { jobId: null, projectId: PROJECT });
});

test('omitted job ID saves as null and known opaque IDs round-trip', () => {
    for (const jobId of [undefined, 'a-_', 'abcdef123456', 'x'.repeat(60)]) {
        const storage = memory();
        make(storage).save({ ...IDENTITY, jobId });
        assert.deepEqual(make(storage).load({ userId: '42' }), { jobId: jobId ?? null, projectId: PROJECT });
    }
});

test('foreign, missing, or invalid current users discard the uncertainty marker', () => {
    for (const userId of ['43', '', '   ', null, undefined, {}, true, Infinity]) {
        const storage = memory({ [KEY]: entry() });
        assert.equal(make(storage).load({ userId }), null);
        assert.equal(storage.getItem(KEY), null);
    }
    const storage = memory();
    make(storage).save({ ...IDENTITY, userId: 42 });
    assert.equal(JSON.parse(storage.data[KEY]).userId, '42');
    assert.deepEqual(make(storage).load({ userId: 42 }), { jobId: null, projectId: PROJECT });
});

test('uncertainty TTL discards expired/future timestamps and permits the exact thirty-minute boundary', () => {
    for (const ts of [NOW - 1_800_001, NOW + 1, -1, 'soon', null, true, {}, [NOW], undefined]) {
        const storage = memory({ [KEY]: entry({ ts }) });
        assert.equal(make(storage).load({ userId: '42' }), null);
        assert.equal(storage.getItem(KEY), null);
    }
    const storage = memory({ [KEY]: entry({ ts: NOW - 1_800_000 }) });
    assert.deepEqual(make(storage).load({ userId: '42' }), { jobId: null, projectId: PROJECT });
});

test('corrupt records, wrong field types, invalid IDs/UUIDs, and additional fields are discarded', () => {
    const bad = [
        'null', '[]', '"text"', '{not json', '',
        ...[2, '1', null, true, {}, [1]].map((v) => entry({ v })),
        ...['ab', 'x'.repeat(61), '../job', '', 123, true, {}, ['abc']].map((jobId) => entry({ jobId })),
        ...['nope', null, 123, true, {}, [PROJECT], '11111111-1111-0111-8111-111111111111', '11111111-1111-4111-7111-111111111111'].map((projectId) => entry({ projectId })),
        ...['', 42, true, null, {}, ['42']].map((userId) => entry({ userId })),
        ...['v', 'jobId', 'projectId', 'userId', 'ts'].map((field) => entry({ [field]: undefined })),
        entry({ prompt: 'secret' }), entry({ message: 'private error' }), entry({ kind: 'video' }),
    ];
    for (const raw of bad) {
        const storage = memory({ [KEY]: raw });
        assert.equal(make(storage).load({ userId: '42' }), null, raw);
        assert.equal(storage.getItem(KEY), null, raw);
    }
});

test('invalid saves remove stale markers instead of retaining a different uncertain identity', () => {
    for (const patch of [{ jobId: 123 }, { jobId: '' }, { jobId: ['abc'] }, { projectId: 'nope' }, { projectId: [PROJECT] }, { userId: '' }, { userId: {} }, { userId: true }]) {
        const storage = memory({ [KEY]: entry() });
        make(storage).save({ ...IDENTITY, ...patch });
        assert.deepEqual(storage.data, {});
    }
});

test('kinds are isolated, unknown kinds are inert, and clear preserves other storage', () => {
    const storage = memory({ unrelated: 'keep' });
    make(storage).save(IDENTITY);
    createUncertaintyStore({ storage, kind: 'video', now: () => NOW }).save({ ...IDENTITY, jobId: 'videojob1' });
    for (const kind of [undefined, null, '', 'audio', '../image', {}, Symbol('image')]) {
        const before = { ...storage.data };
        const store = createUncertaintyStore({ storage, kind });
        store.save(IDENTITY);
        assert.equal(store.load({ userId: '42' }), null);
        store.clear();
        assert.deepEqual(storage.data, before);
    }
    make(storage).clear();
    assert.equal(storage.getItem(KEY), null);
    assert.ok(storage.getItem(VIDEO_KEY));
    assert.equal(storage.getItem('unrelated'), 'keep');
});

test('throwing, absent, partial storage and malformed call arguments never escape', () => {
    const throwing = {
        getItem() { throw new Error('denied'); },
        setItem() { throw new Error('quota'); },
        removeItem() { throw new Error('denied'); },
    };
    for (const storage of [throwing, null, undefined, {}]) {
        const store = make(storage);
        assert.doesNotThrow(() => store.save(IDENTITY));
        assert.doesNotThrow(() => store.save(null));
        assert.equal(store.load({ userId: '42' }), null);
        assert.equal(store.load(null), null);
        assert.doesNotThrow(() => store.clear());
    }
});

test('storage getter failures are contained and clear stale markers where possible', () => {
    for (const method of ['getItem', 'setItem', 'removeItem']) {
        const storage = memory({ [KEY]: entry() });
        Object.defineProperty(storage, method, { get() { throw new Error('storage getter denied'); } });
        const store = make(storage);
        if (method === 'getItem') {
            assert.equal(store.load({ userId: '42' }), null);
            assert.equal(storage.data[KEY], undefined);
        } else if (method === 'setItem') {
            assert.doesNotThrow(() => store.save(IDENTITY));
            assert.equal(storage.data[KEY], undefined);
        } else {
            assert.doesNotThrow(() => store.clear());
        }
    }
});

test('invalid/throwing clocks clear markers and valid age checking reads the clock once', () => {
    for (const now of [() => { throw new Error('clock'); }, () => NaN, () => Infinity, () => 'soon']) {
        const storage = memory({ [KEY]: entry() });
        const store = make(storage, now);
        assert.equal(store.load({ userId: '42' }), null);
        assert.equal(storage.getItem(KEY), null);
        assert.doesNotThrow(() => store.save(IDENTITY));
        assert.deepEqual(storage.data, {});
    }
    let calls = 0;
    const store = make(memory({ [KEY]: entry() }), () => { calls += 1; return NOW; });
    assert.deepEqual(store.load({ userId: '42' }), { jobId: null, projectId: PROJECT });
    assert.equal(calls, 1);
});

function withWindow(value, run) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
    try {
        Object.defineProperty(globalThis, 'window', { configurable: true, value });
        run();
    } finally {
        if (descriptor) Object.defineProperty(globalThis, 'window', descriptor);
        else delete globalThis.window;
    }
}

test('browser wrapper restores uncertainty and logout clears both kinds only', () => {
    const storage = memory({ unrelated: 'keep' });
    withWindow({ sessionStorage: storage }, () => {
        createBrowserUncertainty('image').save(IDENTITY);
        createBrowserUncertainty('video').save({ ...IDENTITY, jobId: 'videojob1' });
        assert.deepEqual(createBrowserUncertainty('image').load({ userId: '42' }), { jobId: null, projectId: PROJECT });
        assert.ok(storage.getItem(VIDEO_KEY));
        clearReplicateUncertainty();
        assert.deepEqual(storage.data, { unrelated: 'keep' });
    });
});

test('browser storage access failures are tolerated and logout attempts both removals independently', () => {
    const denied = Object.defineProperty({}, 'sessionStorage', { get() { throw new Error('denied'); } });
    for (const browser of [undefined, {}, denied]) {
        withWindow(browser, () => {
            const store = createBrowserUncertainty('image');
            assert.doesNotThrow(() => store.save(IDENTITY));
            assert.equal(store.load({ userId: '42' }), null);
            assert.doesNotThrow(() => clearReplicateUncertainty());
        });
    }
    const storage = memory({ [KEY]: entry(), [VIDEO_KEY]: entry() });
    const remove = storage.removeItem;
    storage.removeItem = (key) => {
        if (key === KEY) throw new Error('image denied');
        remove(key);
    };
    withWindow({ sessionStorage: storage }, () => {
        assert.doesNotThrow(() => clearReplicateUncertainty());
        assert.equal(storage.getItem(VIDEO_KEY), null);
    });
});
