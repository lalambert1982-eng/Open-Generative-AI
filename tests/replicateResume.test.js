import test from 'node:test';
import assert from 'node:assert/strict';
import {
    RESUME_KEY_PREFIX, RESUME_MAX_AGE_MS, createResumeStore,
    createBrowserResume, clearReplicateResume,
} from '../src/lib/replicateResume.js';

const NOW = Date.UTC(2026, 9, 10, 12);
const PROJECT = '11111111-1111-4111-8111-111111111111';
const KEY = 'ogai.replicate.activeJob.v1.image';
const VIDEO_KEY = 'ogai.replicate.activeJob.v1.video';
const IDENTITY = { jobId: 'abcdef123456', projectId: PROJECT, userId: '42' };

function memory(initial = {}) {
    const data = { ...initial };
    return {
        data,
        getItem: (key) => Object.hasOwn(data, key) ? data[key] : null,
        setItem: (key, value) => { data[key] = String(value); },
        removeItem: (key) => { delete data[key]; },
    };
}
const make = (storage, now = () => NOW) => createResumeStore({ storage, kind: 'image', now });
const entry = (patch = {}) => JSON.stringify({ v: 1, ...IDENTITY, ts: NOW, ...patch });

test('save persists only job identity and load returns a safe identity projection', () => {
    const storage = memory();
    const store = make(storage);
    store.save({ ...IDENTITY, prompt: 'private prompt', input: { token: 'secret' }, quoteToken: 'secret', url: 'https://private' });
    assert.deepEqual(JSON.parse(storage.data[KEY]), { v: 1, ...IDENTITY, ts: NOW });
    assert.equal(RESUME_KEY_PREFIX, 'ogai.replicate.activeJob.v1');
    assert.deepEqual(store.load({ userId: '42' }), { jobId: 'abcdef123456', projectId: PROJECT });
});

test('foreign or missing current users discard the stored pointer', () => {
    for (const userId of ['43', '', '   ', null, undefined, {}, true]) {
        const storage = memory({ [KEY]: entry() });
        assert.equal(make(storage).load({ userId }), null);
        assert.equal(storage.getItem(KEY), null);
    }
});

test('numeric user identities normalize consistently without coercing arbitrary objects', () => {
    const storage = memory();
    const store = make(storage);
    store.save({ ...IDENTITY, userId: 42 });
    assert.equal(JSON.parse(storage.data[KEY]).userId, '42');
    assert.deepEqual(store.load({ userId: 42 }), { jobId: 'abcdef123456', projectId: PROJECT });
});

test('expired, future, or invalid timestamps are discarded; the exact age limit is valid', () => {
    for (const ts of [NOW - 30 * 60 * 1000 - 1, NOW + 1, 'soon', null, -1, true, {}, [NOW], undefined]) {
        const storage = memory({ [KEY]: entry({ ts }) });
        assert.equal(make(storage).load({ userId: '42' }), null, String(ts));
        assert.equal(storage.getItem(KEY), null);
    }
    const storage = memory({ [KEY]: entry({ ts: NOW - 30 * 60 * 1000 }) });
    assert.equal(RESUME_MAX_AGE_MS, 30 * 60 * 1000);
    assert.deepEqual(make(storage).load({ userId: '42' }), { jobId: 'abcdef123456', projectId: PROJECT });
});

test('malformed JSON, versions, typed IDs, invalid UUIDs, and secret-bearing entries are removed', () => {
    const bad = [
        entry({ jobId: '../etc/passwd' }), entry({ jobId: 'ab' }), entry({ jobId: 'x'.repeat(61) }),
        entry({ jobId: 123 }), entry({ jobId: null }), entry({ jobId: ['abc'] }), entry({ jobId: {} }), entry({ jobId: true }),
        entry({ projectId: 'not-a-uuid' }), entry({ projectId: [PROJECT] }), entry({ projectId: 123 }), entry({ projectId: null }),
        entry({ projectId: {} }), entry({ projectId: true }),
        entry({ projectId: '11111111-1111-0111-8111-111111111111' }),
        entry({ projectId: '11111111-1111-4111-7111-111111111111' }),
        entry({ v: 2 }), entry({ v: '1' }), entry({ v: true }), entry({ v: null }), entry({ v: [1] }), entry({ v: {} }),
        entry({ userId: 42 }), entry({ userId: '' }), entry({ userId: {} }), entry({ userId: ['42'] }), entry({ userId: null }), entry({ userId: true }),
        ...['v', 'jobId', 'projectId', 'userId', 'ts'].map((field) => entry({ [field]: undefined })),
        entry({ prompt: 'private prompt' }), entry({ kind: 'video' }),
        'null', '[]', '"text"', '{not json', '',
    ];
    for (const raw of bad) {
        const storage = memory({ [KEY]: raw });
        assert.equal(make(storage).load({ userId: '42' }), null, raw);
        assert.equal(storage.getItem(KEY), null, raw);
    }
});

test('invalid saves clear a previous pointer and never write invalid identity', () => {
    const bad = [
        { jobId: 'bad id!' }, { jobId: 123 }, { jobId: null }, { jobId: ['abc'] },
        { projectId: 'nope' }, { projectId: [PROJECT] },
        { userId: '' }, { userId: '   ' }, { userId: {} }, { userId: true }, { userId: Infinity },
    ];
    for (const patch of bad) {
        const storage = memory({ [KEY]: entry() });
        make(storage).save({ ...IDENTITY, ...patch });
        assert.deepEqual(storage.data, {}, JSON.stringify(patch));
    }
});

test('valid opaque ID length boundaries and uppercase UUIDs round-trip', () => {
    for (const jobId of ['a-_', 'x'.repeat(60)]) {
        const storage = memory();
        const store = make(storage);
        const projectId = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA';
        store.save({ jobId, projectId, userId: '42' });
        assert.deepEqual(store.load({ userId: '42' }), { jobId, projectId });
    }
});

test('image and video pointers are independent and clear removes only its own', () => {
    const storage = memory({ unrelated: 'keep' });
    const image = make(storage);
    const video = createResumeStore({ storage, kind: 'video', now: () => NOW });
    image.save(IDENTITY);
    video.save({ ...IDENTITY, jobId: 'videojob1' });
    image.clear();
    assert.equal(image.load({ userId: '42' }), null);
    assert.deepEqual(video.load({ userId: '42' }), { jobId: 'videojob1', projectId: PROJECT });
    assert.equal(storage.getItem('unrelated'), 'keep');
});

test('unknown kinds cannot access or modify other storage keys', () => {
    for (const kind of [undefined, null, 'audio', '', '../image', {}, Symbol('image')]) {
        const storage = memory({ [KEY]: entry(), [`${RESUME_KEY_PREFIX}.audio`]: 'keep' });
        const before = { ...storage.data };
        const store = createResumeStore({ storage, kind, now: () => NOW });
        assert.doesNotThrow(() => store.save(IDENTITY));
        assert.equal(store.load({ userId: '42' }), null);
        assert.doesNotThrow(() => store.clear());
        assert.deepEqual(storage.data, before);
    }
});

test('throwing, absent, or partial storage never escapes store methods', () => {
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

test('throwing or invalid clocks discard pointers instead of trusting invalid age', () => {
    for (const now of [() => { throw new Error('clock'); }, () => NaN, () => Infinity, () => 'soon']) {
        const storage = memory({ [KEY]: entry() });
        const store = make(storage, now);
        assert.equal(store.load({ userId: '42' }), null);
        assert.equal(storage.getItem(KEY), null);
        assert.doesNotThrow(() => store.save(IDENTITY));
        assert.deepEqual(storage.data, {});
    }
});

test('throwing storage method getters are contained and discard the stale pointer when possible', () => {
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

test('load reads the clock once when checking age boundaries', () => {
    let calls = 0;
    const storage = memory({ [KEY]: entry() });
    const store = make(storage, () => { calls += 1; return NOW; });
    assert.deepEqual(store.load({ userId: '42' }), { jobId: 'abcdef123456', projectId: PROJECT });
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

test('browser wrapper saves into sessionStorage and logout helper clears both kinds only', () => {
    const storage = memory({ unrelated: 'keep' });
    withWindow({ sessionStorage: storage }, () => {
        createBrowserResume('image').save(IDENTITY);
        createBrowserResume('video').save({ ...IDENTITY, jobId: 'videojob1' });
        assert.deepEqual(createBrowserResume('image').load({ userId: '42' }), { jobId: 'abcdef123456', projectId: PROJECT });
        assert.ok(storage.getItem(VIDEO_KEY));
        clearReplicateResume();
        assert.deepEqual(storage.data, { unrelated: 'keep' });
    });
});

test('browser wrappers tolerate unavailable or denied sessionStorage', () => {
    const denied = Object.defineProperty({}, 'sessionStorage', { get() { throw new Error('denied'); } });
    for (const browser of [undefined, {}, denied]) {
        withWindow(browser, () => {
            const store = createBrowserResume('image');
            assert.doesNotThrow(() => store.save(IDENTITY));
            assert.equal(store.load({ userId: '42' }), null);
            assert.doesNotThrow(() => clearReplicateResume());
        });
    }
});

test('logout clearing attempts video even when image removal fails', () => {
    const storage = memory({ [KEY]: entry(), [VIDEO_KEY]: entry() });
    const remove = storage.removeItem;
    storage.removeItem = (key) => {
        if (key === KEY) throw new Error('image denied');
        remove(key);
    };
    withWindow({ sessionStorage: storage }, () => {
        assert.doesNotThrow(() => clearReplicateResume());
        assert.equal(storage.getItem(VIDEO_KEY), null);
    });
});
