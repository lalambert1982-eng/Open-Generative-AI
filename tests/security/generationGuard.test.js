import assert from 'node:assert/strict';
import test from 'node:test';

import { creatorProjectStoreForTests } from '../../src/lib/creatorProjectStore.js';
import {
    GenerationGuardError,
    issueQuote,
    loadJobRecord,
    refundSpend,
    releaseGeneration,
    requestFingerprint,
    reserveGeneration,
    saveJobRecord,
    verifyQuote,
    generationOwnerKey,
} from '../../src/lib/generationGuard.js';

const env = {
    BLOB_READ_WRITE_TOKEN: 'vercel-blob-test-token-that-is-long-enough',
    CREATOR_SESSION_SECRET: 'creator-project-test-secret-that-is-longer-than-thirty-two-characters',
};
const owner = { id: 12345678, login: 'a' };
const other = { id: 87654321, login: 'b' };
const limits = { maxUsdPerJob: 1, maxUsdPerDay: 1 };
const model = 'black-forest-labs/flux-2-pro';
const now = Date.UTC(2026, 9, 8, 12, 0, 0);

async function expectCode(promise, code, status) {
    await assert.rejects(promise, (error) => error instanceof GenerationGuardError && error.code === code && error.status === status);
}

test('owner keys are stable per user and differ across users', () => {
    assert.equal(generationOwnerKey(owner, env), generationOwnerKey(owner, env));
    assert.notEqual(generationOwnerKey(owner, env), generationOwnerKey(other, env));
    assert.throws(() => generationOwnerKey({ id: 'abc' }, env), GenerationGuardError);
});

test('fingerprints ignore key order and differ when inputs differ', () => {
    const key = generationOwnerKey(owner, env);
    assert.equal(
        requestFingerprint(key, model, { prompt: 'a', aspect_ratio: '1:1' }),
        requestFingerprint(key, model, { aspect_ratio: '1:1', prompt: 'a' }),
    );
    assert.notEqual(requestFingerprint(key, model, { prompt: 'a' }), requestFingerprint(key, model, { prompt: 'b' }));
});

test('quotes bind owner, model, input, estimate and expiry', () => {
    const input = { prompt: 'fox' };
    const quote = issueQuote({ user: owner, env, modelId: model, input, estimateUsd: 0.015, now });
    const check = (overrides = {}) => verifyQuote(quote.token, { user: owner, env, modelId: model, input, estimateUsd: 0.015, now: now + 1000, ...overrides });
    assert.equal(check(), true);
    assert.equal(check({ user: other }), false);
    assert.equal(check({ input: { prompt: 'cat' } }), false);
    assert.equal(check({ modelId: 'black-forest-labs/flux-schnell' }), false);
    assert.equal(check({ estimateUsd: 0.02 }), false);
    assert.equal(check({ now: now + 6 * 60 * 1000 }), false);
    assert.equal(verifyQuote('garbage', { user: owner, env, modelId: model, input, estimateUsd: 0.015, now }), false);
    assert.equal(verifyQuote(undefined, { user: owner, env, modelId: model, input, estimateUsd: 0.015, now }), false);
});

test('live reservation requires a valid quote and respects the per-job cap', async () => {
    const blobStore = creatorProjectStoreForTests(new Map());
    const input = { prompt: 'fox' };
    await expectCode(
        reserveGeneration({ user: owner, env, blobStore, mode: 'live', modelId: model, input, estimateUsd: 0.015, limits, now }),
        'confirmation_required',
        428,
    );
    const quote = issueQuote({ user: owner, env, modelId: model, input, estimateUsd: 1.5, now });
    await expectCode(
        reserveGeneration({ user: owner, env, blobStore, mode: 'live', modelId: model, input, estimateUsd: 1.5, quoteToken: quote.token, limits, now }),
        'job_limit',
        402,
    );
});

test('duplicate submissions are blocked until the lock expires', async () => {
    const blobStore = creatorProjectStoreForTests(new Map());
    const args = { user: owner, env, blobStore, mode: 'mock', modelId: model, input: { prompt: 'fox' }, estimateUsd: 0.015, limits };
    await reserveGeneration({ ...args, now });
    await expectCode(reserveGeneration({ ...args, now: now + 1000 }), 'duplicate_submission', 409);
    await reserveGeneration({ ...args, input: { prompt: 'different' }, now: now + 1000 });
    await reserveGeneration({ ...args, now: now + 61_000 });
});

test('releaseGeneration frees the lock immediately', async () => {
    const blobStore = creatorProjectStoreForTests(new Map());
    const args = { user: owner, env, blobStore, mode: 'mock', modelId: model, input: { prompt: 'fox' }, estimateUsd: 0.015, limits };
    const reservation = await reserveGeneration({ ...args, now });
    await releaseGeneration({ user: owner, env, blobStore, reservation, now: now + 10 });
    await reserveGeneration({ ...args, now: now + 20 });
});

test('mock mode never touches the spend ledger', async () => {
    const records = new Map();
    const blobStore = creatorProjectStoreForTests(records);
    const reservation = await reserveGeneration({ user: owner, env, blobStore, mode: 'mock', modelId: model, input: { prompt: 'fox' }, estimateUsd: 0.5, limits, now });
    assert.equal(reservation.ledgerDay, null);
    assert.equal([...records.keys()].some((key) => key.includes('/ledger/')), false);
});

test('daily cap is enforced for live spend and refunds restore headroom', async () => {
    const blobStore = creatorProjectStoreForTests(new Map());
    const reserve = (prompt, estimateUsd) => {
        const input = { prompt };
        const quote = issueQuote({ user: owner, env, modelId: model, input, estimateUsd, now });
        return reserveGeneration({ user: owner, env, blobStore, mode: 'live', modelId: model, input, estimateUsd, quoteToken: quote.token, limits, now });
    };
    const first = await reserve('one', 0.6);
    assert.equal(first.ledgerDay, '2026-10-08');
    await expectCode(reserve('two', 0.6), 'daily_limit', 402);
    await refundSpend({ user: owner, env, blobStore, ledgerDay: first.ledgerDay, estimateUsd: 0.6 });
    await reserve('two', 0.6);
    await refundSpend({ user: owner, env, blobStore, ledgerDay: first.ledgerDay, estimateUsd: 99 });
    await reserve('three', 1);
});

test('job records are owner-bound and ids are validated', async () => {
    const blobStore = creatorProjectStoreForTests(new Map());
    await saveJobRecord(owner, { jobId: 'abc123def456ghi789jkl012mn', status: 'queued' }, { env, blobStore });
    assert.equal((await loadJobRecord(owner, 'abc123def456ghi789jkl012mn', { env, blobStore })).status, 'queued');
    assert.equal(await loadJobRecord(other, 'abc123def456ghi789jkl012mn', { env, blobStore }), null);
    assert.equal(await loadJobRecord(owner, '../../creator-projects/x', { env, blobStore }), null);
    await assert.rejects(saveJobRecord(owner, { jobId: '../x' }, { env, blobStore }), GenerationGuardError);
});

test('unconfigured storage fails closed', async () => {
    const blobStore = creatorProjectStoreForTests(new Map());
    await expectCode(
        reserveGeneration({ user: owner, env: { CREATOR_SESSION_SECRET: env.CREATOR_SESSION_SECRET }, blobStore, mode: 'mock', modelId: model, input: { prompt: 'x' }, estimateUsd: 0.01, limits, now }),
        'unconfigured',
        503,
    );
});

const badEstimates = [Number.NaN, undefined, -1, Number.POSITIVE_INFINITY];

test('invalid estimates are rejected by reserve, quote and refund', async () => {
    for (const mode of ['live', 'mock']) {
        for (const estimateUsd of badEstimates) {
            const records = new Map();
            const blobStore = creatorProjectStoreForTests(records);
            await expectCode(
                reserveGeneration({ user: owner, env, blobStore, mode, modelId: model, input: { prompt: 'x' }, estimateUsd, quoteToken: 'x', limits, now }),
                'invalid_estimate',
                400,
            );
            assert.equal(records.size, 0);
        }
    }
    for (const estimateUsd of badEstimates) {
        assert.throws(() => issueQuote({ user: owner, env, modelId: model, input: { prompt: 'x' }, estimateUsd, now }), GenerationGuardError);
        assert.equal(verifyQuote('1790000000000.abc', { user: owner, env, modelId: model, input: { prompt: 'x' }, estimateUsd, now }), false);
        await expectCode(
            refundSpend({ user: owner, env, blobStore: creatorProjectStoreForTests(new Map()), ledgerDay: '2026-10-08', estimateUsd }),
            'invalid_estimate',
            400,
        );
    }
});

test('a rejected live estimate does not touch the ledger', async () => {
    const records = new Map();
    const blobStore = creatorProjectStoreForTests(records);
    const quoteToken = issueQuote({ user: owner, env, modelId: model, input: { prompt: 'x' }, estimateUsd: 0.1, now }).token;
    await expectCode(
        reserveGeneration({ user: owner, env, blobStore, mode: 'live', modelId: model, input: { prompt: 'x' }, estimateUsd: Number.NaN, quoteToken, limits, now }),
        'invalid_estimate',
        400,
    );
    assert.equal([...records.keys()].some((key) => key.includes('/ledger/')), false);
});

test('mode is whitelisted before any storage access', async () => {
    for (const mode of ['LIVE', undefined, 'bogus', 'unconfigured']) {
        const records = new Map();
        const blobStore = creatorProjectStoreForTests(records);
        await expectCode(
            reserveGeneration({ user: owner, env, blobStore, mode, modelId: model, input: { prompt: 'x' }, estimateUsd: 0.01, limits, now }),
            'invalid_mode',
            400,
        );
        assert.equal(records.size, 0);
    }
});

test('releaseGeneration ignores a tampered lockPath and ownerKey', async () => {
    const records = new Map();
    const blobStore = creatorProjectStoreForTests(records);
    const args = { user: owner, env, blobStore, mode: 'mock', modelId: model, input: { prompt: 'fox' }, estimateUsd: 0.015, limits };
    const reservation = await reserveGeneration({ ...args, now });
    await releaseGeneration({
        user: owner,
        env,
        blobStore,
        reservation: { ...reservation, lockPath: 'creator-projects/evil.json', ownerKey: 'evil' },
        now: now + 10,
    });
    assert.equal(records.has('creator-projects/evil.json'), false);
    await reserveGeneration({ ...args, now: now + 20 });
    await expectCode(
        releaseGeneration({ user: owner, env, blobStore, reservation: { ...reservation, fingerprint: '../x' }, now }),
        'invalid_reservation',
        400,
    );
});

test('malformed ledgerDay is rejected but null is a no-op', async () => {
    const records = new Map();
    const blobStore = creatorProjectStoreForTests(records);
    await expectCode(refundSpend({ user: owner, env, blobStore, ledgerDay: '../x', estimateUsd: 0.1 }), 'invalid_ledger_day', 400);
    await refundSpend({ user: owner, env, blobStore, ledgerDay: null, estimateUsd: 0.1 });
    assert.equal(records.size, 0);
});

test('invalid limits are rejected', async () => {
    for (const bad of [undefined, {}, { maxUsdPerJob: 1 }, { maxUsdPerJob: 0, maxUsdPerDay: 1 }, { maxUsdPerJob: 1, maxUsdPerDay: Number.NaN }, { maxUsdPerJob: -1, maxUsdPerDay: 1 }]) {
        const records = new Map();
        await expectCode(
            reserveGeneration({ user: owner, env, blobStore: creatorProjectStoreForTests(records), mode: 'mock', modelId: model, input: { prompt: 'x' }, estimateUsd: 0.01, limits: bad, now }),
            'invalid_limits',
            500,
        );
        assert.equal(records.size, 0);
    }
});
