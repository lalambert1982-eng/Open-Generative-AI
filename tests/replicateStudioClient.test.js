import test from 'node:test';
import assert from 'node:assert/strict';
import { ReplicateApiError, createReplicateApi } from '../src/lib/replicateStudioClient.js';

function fakeFetch(handler) {
    const calls = [];
    const fetchImpl = async (url, options) => {
        calls.push({ url, options });
        return handler(url, options);
    };
    return { fetchImpl, calls };
}
const json = (status, value) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

test('requests are same-origin, uncached JSON against the Creator route', async () => {
    const { fetchImpl, calls } = fakeFetch(() => json(200, { models: [] }));
    const api = createReplicateApi({ fetchImpl });
    await api.models();
    await api.quote({ model: 'a/b', input: { prompt: 'x' } });
    assert.equal(calls[0].url, '/api/creator/replicate/models');
    assert.equal(calls[0].options.credentials, 'same-origin');
    assert.equal(calls[0].options.cache, 'no-store');
    assert.equal(calls[1].url, '/api/creator/replicate/quote');
    assert.equal(calls[1].options.method, 'POST');
    assert.deepEqual(JSON.parse(calls[1].options.body), { model: 'a/b', input: { prompt: 'x' } });
});

test('generate sends only model, input, projectId, and the quote token', async () => {
    const { fetchImpl, calls } = fakeFetch(() => json(202, { job: { jobId: 'j' } }));
    await createReplicateApi({ fetchImpl }).generate({ model: 'a/b', input: { prompt: 'x' }, projectId: 'p', quoteToken: 't' });
    assert.deepEqual(JSON.parse(calls[0].options.body), { model: 'a/b', input: { prompt: 'x' }, projectId: 'p', quoteToken: 't' });
});

test('status ids are URL-encoded and cancel posts the id', async () => {
    const { fetchImpl, calls } = fakeFetch(() => json(200, { job: {} }));
    const api = createReplicateApi({ fetchImpl });
    await api.status('a b');
    await api.cancel('job1');
    assert.equal(calls[0].url, '/api/creator/replicate/status?id=a%20b');
    assert.deepEqual(JSON.parse(calls[1].options.body), { id: 'job1' });
});

test('accepted-job failure fields survive on the thrown error', async () => {
    const { fetchImpl } = fakeFetch(() => json(404, {
        error: 'Project changed.', code: 'project_not_found', generationAccepted: true,
        jobId: 'abcdef123456', jobRecordState: 'confirmed', statusRecoveryAvailable: true, retryable: false,
    }));
    await assert.rejects(createReplicateApi({ fetchImpl }).generate({ model: 'a/b', input: {}, projectId: 'p' }), (error) => {
        assert.ok(error instanceof ReplicateApiError);
        assert.equal(error.status, 404);
        assert.equal(error.generationAccepted, true);
        assert.equal(error.jobId, 'abcdef123456');
        assert.equal(error.statusRecoveryAvailable, true);
        assert.equal(error.retryable, false);
        return true;
    });
});

test('outcomeUnknown from the server is preserved', async () => {
    const { fetchImpl } = fakeFetch(() => json(502, { error: 'Timed out.', retryable: false, outcomeUnknown: true }));
    await assert.rejects(createReplicateApi({ fetchImpl }).generate({ model: 'a/b', input: {}, projectId: 'p' }), (error) => error.outcomeUnknown === true && error.generationAccepted === false);
});

test('a network failure during generate is an unknown outcome, but not during status', async () => {
    const api = createReplicateApi({ fetchImpl: async () => { throw new TypeError('network'); } });
    await assert.rejects(api.generate({ model: 'a/b', input: {}, projectId: 'p' }), (error) => error.outcomeUnknown === true && error.status === 0);
    await assert.rejects(api.status('job1'), (error) => error.outcomeUnknown === false && error.status === 0);
});

test('non-JSON error bodies fall back to a status message', async () => {
    const { fetchImpl } = fakeFetch(() => new Response('<html>', { status: 500 }));
    await assert.rejects(createReplicateApi({ fetchImpl }).models(), /Request failed \(500\)/);
});

for (const status of [502, 503, 504]) {
    test(`an unreadable HTTP ${status} generate reply has an unknown outcome`, async () => {
        const api = createReplicateApi({ fetchImpl: async () => new Response('<html>proxy failure</html>', { status }) });
        await assert.rejects(api.generate({ model: 'a/b', input: {}, projectId: 'p' }),
            (error) => error instanceof ReplicateApiError && error.status === status && error.outcomeUnknown === true);
    });
    test(`a structured definite HTTP ${status} rejection remains a definite error`, async () => {
        const api = createReplicateApi({ fetchImpl: async () => json(status, { error: 'Not configured.', generationAccepted: false }) });
        await assert.rejects(api.generate({ model: 'a/b', input: {}, projectId: 'p' }),
            (error) => error.message === 'Not configured.' && error.outcomeUnknown === false);
    });
}

for (const value of [null, [], 'unexpected', {}, { error: 42 }]) {
    test(`an unexpected generate error body ${JSON.stringify(value)} has an unknown outcome`, async () => {
        const api = createReplicateApi({ fetchImpl: async () => json(502, value) });
        await assert.rejects(api.generate({ model: 'a/b', input: {}, projectId: 'p' }),
            (error) => error instanceof ReplicateApiError && error.outcomeUnknown === true);
    });
}

for (const status of [500, 502, 503, 504]) {
    test(`a generic JSON HTTP ${status} generate error does not prove rejection`, async () => {
        const api = createReplicateApi({ fetchImpl: async () => json(status, { error: 'Gateway timeout' }) });
        await assert.rejects(api.generate({ model: 'a/b', input: {}, projectId: 'p' }),
            (error) => error.status === status && error.outcomeUnknown === true);
    });
}

for (const evidence of [{ generationAccepted: false }, { outcomeUnknown: false }]) {
    test(`explicit non-acceptance evidence ${JSON.stringify(evidence)} keeps a JSON 500 definite`, async () => {
        const api = createReplicateApi({ fetchImpl: async () => json(500, { error: 'Request rejected.', ...evidence }) });
        await assert.rejects(api.generate({ model: 'a/b', input: {}, projectId: 'p' }),
            (error) => error.outcomeUnknown === false && error.generationAccepted === false);
    });
}

test('an explicit unknown outcome overrides non-acceptance evidence', async () => {
    const api = createReplicateApi({ fetchImpl: async () => json(504, {
        error: 'Timed out.', generationAccepted: false, outcomeUnknown: true,
    }) });
    await assert.rejects(api.generate({ model: 'a/b', input: {}, projectId: 'p' }),
        (error) => error.outcomeUnknown === true);
});

test('a structured client-error rejection remains definite without acceptance fields', async () => {
    const api = createReplicateApi({ fetchImpl: async () => json(409, { error: 'Duplicate request.' }) });
    await assert.rejects(api.generate({ model: 'a/b', input: {}, projectId: 'p' }),
        (error) => error.status === 409 && error.outcomeUnknown === false);
});
