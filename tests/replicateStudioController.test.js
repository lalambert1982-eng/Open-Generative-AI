import test from 'node:test';
import assert from 'node:assert/strict';
import {
    POLL_DEADLINE_MS, ReplicateApiError, createReplicateApi, createReplicateController,
} from '../src/lib/replicateStudioClient.js';
import { createResumeStore } from '../src/lib/replicateResume.js';

const NOW = Date.UTC(2026, 9, 9, 12, 0, 0);
const PROJECT = '11111111-1111-4111-8111-111111111111';
const OTHER_PROJECT = '22222222-2222-4222-8222-222222222222';
const JOB_ID = 'abcdef123456';
const MODELS = [{
    id: 'vendor/fast', kind: 'image', task: 'text-to-image', label: 'Fast', enabled: true,
    pricing: { display: '~$0.003' },
    inputs: { prompt: { type: 'string', required: true, max: 100 }, aspect_ratio: { type: 'enum', values: ['1:1', '16:9'], default: '1:1' } },
}];

function job(status, extra = {}) {
    return {
        provider: 'replicate', kind: 'image', jobId: JOB_ID, status, model: 'vendor/fast', mode: 'mock', mock: true,
        error: null, estimateUsd: 0.003,
        asset: status === 'completed' ? { id: 'asset-1', url: 'https://creator.public.blob.vercel-storage.com/a.png', type: 'graphic' } : null,
        ...extra,
    };
}

function harness({ mode = 'mock', overrides = {}, controllerOptions = {} } = {}) {
    const calls = [];
    const timers = [];
    const settled = [];
    const counters = { authLost: 0 };
    let clock = NOW;
    const api = {
        models: async () => ({ mode, provider: { configured: true }, limits: { maxUsdPerJob: 1, maxUsdPerDay: 5 }, models: MODELS }),
        quote: async (body) => {
            calls.push(['quote', body]);
            return { estimateUsd: 0.003, display: '~$0.003', quoteToken: 'tok', expiresAt: new Date(clock + 300000).toISOString(), mode, maxUsdPerJob: 1 };
        },
        generate: async (body) => { calls.push(['generate', body]); return { job: job('completed') }; },
        status: async (id) => { calls.push(['status', id]); return { job: job('completed') }; },
        cancel: async (id) => { calls.push(['cancel', id]); return { job: job('canceled') }; },
        ...overrides,
    };
    const controller = createReplicateController({
        api, kind: 'image', now: () => clock,
        setTimer: (fn, ms) => { const timer = { fn, ms, cleared: false, fired: false }; timers.push(timer); return timer; },
        clearTimer: (timer) => { timer.cleared = true; },
        onJobSettled: (event) => settled.push(event),
        onAuthLost: () => { counters.authLost += 1; },
        ...controllerOptions,
    });
    return {
        controller, calls, timers, settled, counters,
        advance: (ms) => { clock += ms; },
        count: (name) => calls.filter((call) => call[0] === name).length,
        pending: () => timers.filter((timer) => !timer.cleared && !timer.fired),
        async fire() { const timer = timers.find((item) => !item.cleared && !item.fired); timer.fired = true; await timer.fn(); },
        async ready() {
            await controller.load();
            controller.setProject(PROJECT);
            controller.setValue('prompt', 'a red fox');
        },
    };
}
const accepted = (extra = {}) => new ReplicateApiError('Could not save the job.', {
    status: 500, generationAccepted: true, jobId: JOB_ID, jobRecordState: 'confirmed', statusRecoveryAvailable: true, retryable: false, ...extra,
});
const queuedJob = () => ({ job: job('queued') });

test('load selects the first enabled model of the kind with defaults', async () => {
    const h = harness();
    await h.controller.load();
    const state = h.controller.getState();
    assert.equal(state.modelId, 'vendor/fast');
    assert.deepEqual(state.values, { aspect_ratio: '1:1' });
    assert.equal(state.mode, 'mock');
    assert.equal(state.configured, true);
});

test('generate needs a Project and valid settings before any request', async () => {
    const h = harness();
    await h.controller.load();
    await h.controller.generate();
    assert.match(h.controller.getState().error, /Project/);
    h.controller.setProject(PROJECT);
    await h.controller.generate();
    assert.ok(h.controller.getState().fieldErrors.prompt);
    assert.equal(h.calls.length, 0);
});

test('mock mode quotes then submits once and settles the originating Project', async () => {
    const h = harness();
    await h.ready();
    await h.controller.generate();
    assert.equal(h.count('quote'), 1);
    assert.equal(h.count('generate'), 1);
    assert.deepEqual(h.calls.find((call) => call[0] === 'generate')[1], {
        model: 'vendor/fast', input: { prompt: 'a red fox', aspect_ratio: '1:1' }, projectId: PROJECT, quoteToken: 'tok',
    });
    assert.equal(h.controller.getState().phase, 'completed');
    assert.deepEqual(h.settled.map((event) => event.projectId), [PROJECT]);
    assert.equal(h.settled[0].job.asset.id, 'asset-1');
});

test('two rapid Generate clicks send exactly one create request', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const h = harness({ overrides: { generate: async (body) => { h.calls.push(['generate', body]); await gate; return { job: job('completed') }; } } });
    await h.ready();
    const first = h.controller.generate();
    const second = h.controller.generate();
    release();
    await Promise.all([first, second]);
    assert.equal(h.count('generate'), 1);
    assert.equal(h.count('quote'), 1);
});

test('live mode only quotes on the first click and submits on explicit confirmation', async () => {
    const h = harness({ mode: 'live' });
    await h.ready();
    await h.controller.generate();
    assert.equal(h.controller.getState().phase, 'quoted');
    assert.equal(h.count('generate'), 0);
    await h.controller.confirm();
    assert.equal(h.count('generate'), 1);
    assert.equal(h.controller.getState().phase, 'completed');
});

test('two rapid Confirm clicks send exactly one create request', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const h = harness({ mode: 'live', overrides: { generate: async (body) => { h.calls.push(['generate', body]); await gate; return { job: job('completed') }; } } });
    await h.ready();
    await h.controller.generate();
    const first = h.controller.confirm();
    const second = h.controller.confirm();
    release();
    await Promise.all([first, second]);
    assert.equal(h.count('generate'), 1);
});

test('an expired live quote is not submitted and asks for a new review', async () => {
    const h = harness({ mode: 'live' });
    await h.ready();
    await h.controller.generate();
    h.advance(300001);
    await h.controller.confirm();
    const state = h.controller.getState();
    assert.equal(h.count('generate'), 0);
    assert.equal(state.phase, 'idle');
    assert.equal(state.quote, null);
    assert.equal(state.notice.kind, 'expired');
});

test('editing settings after a quote invalidates the review', async () => {
    const h = harness({ mode: 'live' });
    await h.ready();
    await h.controller.generate();
    h.controller.setValue('prompt', 'a blue fox');
    assert.equal(h.controller.getState().phase, 'idle');
    assert.equal(h.controller.getState().quote, null);
    await h.controller.confirm();
    assert.equal(h.count('generate'), 0);
});

test('changing Project or model after a quote also invalidates the review', async () => {
    const h = harness({ mode: 'live' });
    await h.ready();
    await h.controller.generate();
    h.controller.setProject(OTHER_PROJECT);
    assert.equal(h.controller.getState().phase, 'idle');
    await h.controller.generate();
    h.controller.selectModel('vendor/fast');
    assert.equal(h.controller.getState().phase, 'idle');
});

test('an estimate above the per-job cap cannot be submitted', async () => {
    const h = harness({
        mode: 'live',
        overrides: { quote: async (body) => { h.calls.push(['quote', body]); return { estimateUsd: 1.5, display: 'x', quoteToken: 'tok', expiresAt: new Date(NOW + 300000).toISOString(), mode: 'live', maxUsdPerJob: 1 }; } },
    });
    await h.ready();
    await h.controller.generate();
    assert.equal(h.controller.getState().overCap, true);
    await h.controller.confirm();
    assert.equal(h.count('generate'), 0);
});

test('a queued job is polled by its id until it completes', async () => {
    let statusCalls = 0;
    const h = harness({
        overrides: {
            generate: async (body) => { h.calls.push(['generate', body]); return queuedJob(); },
            status: async (id) => { h.calls.push(['status', id]); statusCalls += 1; return { job: job(statusCalls < 2 ? 'processing' : 'completed') }; },
        },
    });
    await h.ready();
    await h.controller.generate();
    assert.equal(h.controller.getState().phase, 'running');
    assert.equal(h.pending().length, 1);
    await h.fire();
    assert.equal(h.controller.getState().phase, 'running');
    await h.fire();
    assert.equal(h.controller.getState().phase, 'completed');
    assert.deepEqual(h.calls.filter((call) => call[0] === 'status').map((call) => call[1]), [JOB_ID, JOB_ID]);
    assert.equal(h.count('generate'), 1);
    assert.equal(h.settled.length, 1);
});

test('an accepted job with an HTTP 404 and a recoverable id is adopted and polled, never re-posted', async () => {
    const h = harness({
        overrides: {
            generate: async (body) => { h.calls.push(['generate', body]); throw accepted({ status: 404 }); },
            status: async (id) => { h.calls.push(['status', id]); return { job: job('completed') }; },
        },
    });
    await h.ready();
    await h.controller.generate();
    let state = h.controller.getState();
    assert.equal(state.phase, 'running');
    assert.equal(state.jobId, JOB_ID);
    assert.equal(state.notice.kind, 'saving-problem');
    await h.fire();
    state = h.controller.getState();
    assert.equal(state.phase, 'completed');
    assert.equal(h.count('generate'), 1);
});

test('an accepted job without recoverable status is uncertain and blocks Generate until acknowledged', async () => {
    const h = harness({
        overrides: {
            generate: async (body) => { h.calls.push(['generate', body]); throw accepted({ statusRecoveryAvailable: false, jobRecordState: 'unconfirmed' }); },
            status: async (id) => { h.calls.push(['status', id]); throw new ReplicateApiError('Generation job not found.', { status: 404 }); },
        },
    });
    await h.ready();
    await h.controller.generate();
    let state = h.controller.getState();
    assert.equal(state.phase, 'uncertain');
    assert.equal(state.uncertain.jobId, JOB_ID);
    assert.equal(state.uncertain.acknowledged, false);
    assert.equal(h.pending().length, 0);

    await h.controller.generate();
    assert.equal(h.count('quote'), 1, 'no new quote or create while uncertain');
    assert.equal(h.count('generate'), 1);

    await h.controller.checkStatus();
    state = h.controller.getState();
    assert.equal(state.phase, 'uncertain');
    assert.match(state.uncertain.message, /not recorded/i);

    h.controller.acknowledge();
    state = h.controller.getState();
    assert.equal(state.phase, 'idle');
    assert.equal(state.uncertain.acknowledged, true);
});

test('an unknown outcome with no job id offers no status check and no resubmission', async () => {
    const h = harness({
        overrides: { generate: async (body) => { h.calls.push(['generate', body]); throw new ReplicateApiError('Timed out.', { status: 502, outcomeUnknown: true, retryable: false }); } },
    });
    await h.ready();
    await h.controller.generate();
    const state = h.controller.getState();
    assert.equal(state.phase, 'uncertain');
    assert.equal(state.uncertain.jobId, null);
    await h.controller.checkStatus();
    assert.equal(h.count('status'), 0);
    await h.controller.generate();
    assert.equal(h.count('generate'), 1);
});

test('a network failure during create is an unknown outcome, not a failure', async () => {
    const h = harness({
        overrides: { generate: async (body) => { h.calls.push(['generate', body]); throw new ReplicateApiError('lost', { status: 0, outcomeUnknown: true }); } },
    });
    await h.ready();
    await h.controller.generate();
    assert.equal(h.controller.getState().phase, 'uncertain');
});

test('a definite rejection returns to idle with the message and no uncertainty', async () => {
    const h = harness({
        overrides: { generate: async (body) => { h.calls.push(['generate', body]); throw new ReplicateApiError('An identical request is already in progress.', { status: 409 }); } },
    });
    await h.ready();
    await h.controller.generate();
    const state = h.controller.getState();
    assert.equal(state.phase, 'idle');
    assert.match(state.error, /identical request/);
    assert.equal(state.uncertain, null);
});

test('a status read failure stops polling and offers a check of the same job without another create', async () => {
    let fail = true;
    const h = harness({
        overrides: {
            generate: async (body) => { h.calls.push(['generate', body]); return queuedJob(); },
            status: async (id) => {
                h.calls.push(['status', id]);
                if (fail) throw new ReplicateApiError('Server error.', { status: 500 });
                return { job: job('completed') };
            },
        },
    });
    await h.ready();
    await h.controller.generate();
    await h.fire();
    let state = h.controller.getState();
    assert.equal(state.phase, 'running');
    assert.equal(state.checkFailed, true);
    assert.equal(h.pending().length, 0);
    fail = false;
    await h.controller.checkStatus();
    state = h.controller.getState();
    assert.equal(state.phase, 'completed');
    assert.equal(h.count('generate'), 1);
});

test('reaching the polling deadline keeps the job running and offers a manual check', async () => {
    const h = harness({
        overrides: {
            generate: async (body) => { h.calls.push(['generate', body]); return queuedJob(); },
            status: async (id) => { h.calls.push(['status', id]); return { job: job('processing') }; },
        },
    });
    await h.ready();
    await h.controller.generate();
    h.advance(POLL_DEADLINE_MS);
    await h.fire();
    const state = h.controller.getState();
    assert.equal(state.phase, 'running');
    assert.equal(state.deadlineReached, true);
    assert.equal(h.pending().length, 0);
});

test('cancel shows a confirmed cancellation, or "requested" while still pending', async () => {
    const h = harness({
        overrides: { generate: async (body) => { h.calls.push(['generate', body]); return queuedJob(); } },
    });
    await h.ready();
    await h.controller.generate();
    await h.controller.cancel();
    assert.equal(h.controller.getState().phase, 'canceled');
    assert.equal(h.settled.length, 0);

    const pending = harness({
        overrides: {
            generate: async (body) => { pending.calls.push(['generate', body]); return queuedJob(); },
            cancel: async (id) => { pending.calls.push(['cancel', id]); return { job: job('processing') }; },
        },
    });
    await pending.ready();
    await pending.controller.generate();
    await pending.controller.cancel();
    const state = pending.controller.getState();
    assert.equal(state.phase, 'running');
    assert.equal(state.cancelRequested, true);
    assert.equal(state.notice.kind, 'cancel-requested');
    assert.equal(pending.pending().length, 1, 'polling continues until a confirmed state');
});

test('switching Project while a job runs settles the originating Project only', async () => {
    const h = harness({
        overrides: { generate: async (body) => { h.calls.push(['generate', body]); return queuedJob(); } },
    });
    await h.ready();
    await h.controller.generate();
    h.controller.setProject(OTHER_PROJECT);
    assert.equal(h.controller.getState().phase, 'running');
    await h.fire();
    assert.deepEqual(h.settled.map((event) => event.projectId), [PROJECT]);
    assert.equal(h.controller.getState().projectId, OTHER_PROJECT);
});

test('teardown clears the timer and ignores a late response', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const h = harness({
        overrides: {
            generate: async (body) => { h.calls.push(['generate', body]); return queuedJob(); },
            status: async () => { await gate; return { job: job('completed') }; },
        },
    });
    await h.ready();
    await h.controller.generate();
    const timer = h.timers[0];
    const inFlight = h.fire();
    h.controller.teardown();
    release();
    await inFlight;
    assert.equal(h.settled.length, 0);
    assert.equal(h.controller.getState().phase, 'running');
    h.controller.teardown();
    assert.equal(timer.fired, true);
});

test('teardown cancels a scheduled poll', async () => {
    const h = harness({
        overrides: { generate: async (body) => { h.calls.push(['generate', body]); return queuedJob(); } },
    });
    await h.ready();
    await h.controller.generate();
    assert.equal(h.pending().length, 1);
    h.controller.teardown();
    assert.equal(h.pending().length, 0);
});

test('a 401 mid-poll clears owner-specific state and stops polling', async () => {
    const h = harness({
        overrides: {
            generate: async (body) => { h.calls.push(['generate', body]); return queuedJob(); },
            status: async () => { throw new ReplicateApiError('Sign in required.', { status: 401 }); },
        },
    });
    await h.ready();
    await h.controller.generate();
    await h.fire();
    const state = h.controller.getState();
    assert.equal(state.authLost, true);
    assert.equal(state.job, null);
    assert.equal(state.jobId, '');
    assert.equal(state.phase, 'idle');
    assert.equal(h.pending().length, 0);
    assert.equal(h.counters.authLost, 1);
});

test('starting a new generation clears the previous result and uncertainty', async () => {
    const h = harness();
    await h.ready();
    await h.controller.generate();
    assert.equal(h.controller.getState().job.jobId, JOB_ID);
    h.controller.setValue('prompt', 'another fox');
    await h.controller.generate();
    assert.equal(h.count('generate'), 2);
});

test('checkStatus after completion makes no status call and does not settle again', async () => {
    const h = harness();
    await h.ready();
    await h.controller.generate();
    assert.equal(h.controller.getState().phase, 'completed');
    await h.controller.checkStatus();
    assert.equal(h.count('status'), 0);
    assert.equal(h.settled.length, 1);
});

test('a late non-terminal poll response after a confirmed terminal state does not regress the job', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const h = harness({
        overrides: {
            generate: async (body) => { h.calls.push(['generate', body]); return queuedJob(); },
            status: async () => { await gate; return { job: job('processing') }; },
        },
    });
    await h.ready();
    await h.controller.generate();
    const inFlight = h.fire();
    await h.controller.cancel();
    assert.equal(h.controller.getState().phase, 'canceled');
    release();
    await inFlight;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.controller.getState().phase, 'canceled');
    assert.equal(h.pending().length, 0);
    assert.equal(h.settled.length, 0);
});

test('checkStatus after acknowledging an uncertain job makes no status call', async () => {
    const h = harness({
        overrides: {
            generate: async (body) => { h.calls.push(['generate', body]); throw accepted({ statusRecoveryAvailable: false, jobRecordState: 'unconfirmed' }); },
        },
    });
    await h.ready();
    await h.controller.generate();
    h.controller.acknowledge();
    await h.controller.checkStatus();
    assert.equal(h.count('status'), 0);
    assert.equal(h.controller.getState().phase, 'idle');
});

test('a live quote on a mock-badged page is never auto-submitted', async () => {
    const h = harness({
        mode: 'mock',
        overrides: {
            quote: async (body) => { h.calls.push(['quote', body]); return { estimateUsd: 0.003, display: '~$0.003', quoteToken: 'tok', expiresAt: new Date(NOW + 300000).toISOString(), mode: 'live', maxUsdPerJob: 1 }; },
        },
    });
    await h.ready();
    await h.controller.generate();
    const state = h.controller.getState();
    assert.equal(h.count('generate'), 0);
    assert.equal(state.phase, 'quoted');
    assert.equal(state.mode, 'live');
});

test('a failed status check keeps the uncertain warning, appends the error once, and does not stack', async () => {
    const h = harness({
        overrides: {
            generate: async (body) => { h.calls.push(['generate', body]); throw accepted({ statusRecoveryAvailable: false, jobRecordState: 'unconfirmed' }); },
            status: async (id) => { h.calls.push(['status', id]); throw new ReplicateApiError('Server exploded.', { status: 500 }); },
        },
    });
    await h.ready();
    await h.controller.generate();
    await h.controller.checkStatus();
    await h.controller.checkStatus();
    const { message } = h.controller.getState().uncertain;
    assert.match(message, /billed|Operator review/);
    assert.match(message, /Server exploded\./);
    assert.equal(message.split('Status check failed').length - 1, 1);
});

const nextTurn = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

for (const source of ['cancel', 'poll']) {
    for (const reply of ['success', 'error']) {
        for (const nextPhase of ['quoted', 'submitting', 'running']) {
            test(`a late old ${source} ${reply} cannot change the new ${nextPhase} operation`, async () => {
                const late = deferred();
                const submission = deferred();
                let creates = 0;
                let reads = 0;
                const h = harness({
                    mode: nextPhase === 'quoted' ? 'live' : 'mock',
                    overrides: {
                        generate: async (body) => {
                            h.calls.push(['generate', body]);
                            if (++creates === 1) return queuedJob();
                            if (nextPhase === 'submitting') return submission.promise;
                            return { job: job('queued', { jobId: 'new-job' }) };
                        },
                        status: async () => source === 'poll' && ++reads === 1 ? late.promise : { job: job('completed') },
                        cancel: async () => source === 'cancel' ? late.promise : { job: job('canceled') },
                    },
                });
                await h.ready();
                await h.controller.generate();
                if (nextPhase === 'quoted') await h.controller.confirm();
                const oldRequest = source === 'cancel' ? h.controller.cancel() : h.fire();
                if (source === 'cancel') await h.controller.checkStatus();
                else await h.controller.cancel();
                const newRequest = h.controller.generate();
                await nextTurn();
                assert.equal(h.controller.getState().phase, nextPhase);
                const expected = h.controller.getState();
                const settled = h.settled.length;
                if (reply === 'success') late.resolve({ job: job(source === 'cancel' ? 'canceled' : 'completed') });
                else late.reject(new ReplicateApiError('Old request failed.', { status: 500 }));
                await oldRequest;
                await nextTurn();
                assert.deepEqual(h.controller.getState(), expected);
                assert.equal(h.settled.length, settled);
                assert.equal(h.pending().length, nextPhase === 'running' ? 1 : 0);
                submission.resolve({ job: job('queued', { jobId: 'new-job' }) });
                await newRequest;
                h.controller.teardown();
            });
        }
    }
}

test('an outstanding old cancellation does not prevent canceling the new job', async () => {
    const old = deferred();
    let creates = 0;
    const h = harness({ overrides: {
        generate: async () => ({ job: job('queued', { jobId: ++creates === 1 ? JOB_ID : 'new-job' }) }),
        cancel: async (id) => {
            h.calls.push(['cancel', id]);
            return id === JOB_ID ? old.promise : { job: job('canceled', { jobId: id }) };
        },
    } });
    await h.ready();
    await h.controller.generate();
    const oldRequest = h.controller.cancel();
    await h.controller.checkStatus();
    await h.controller.generate();
    await h.controller.cancel();
    assert.equal(h.controller.getState().jobId, 'new-job');
    assert.equal(h.controller.getState().phase, 'canceled');
    assert.deepEqual(h.calls.filter(([name]) => name === 'cancel').map(([, id]) => id), [JOB_ID, 'new-job']);
    old.resolve({ job: job('canceled') });
    await oldRequest;
    h.controller.teardown();
});

for (const status of [502, 503, 504]) {
    test(`an HTML HTTP ${status} generation reply blocks another create until acknowledgment`, async () => {
        let creates = 0;
        const api = createReplicateApi({ fetchImpl: async (url) => {
            if (url.endsWith('/models')) return Response.json({ mode: 'mock', provider: { configured: true }, models: MODELS });
            if (url.endsWith('/quote')) return Response.json({ mode: 'mock', estimateUsd: 0, maxUsdPerJob: 1 });
            assert.ok(url.endsWith('/generate'));
            creates += 1;
            return new Response('<html>proxy timeout</html>', { status });
        } });
        const h = harness({ overrides: api });
        await h.ready();
        await h.controller.generate();
        assert.equal(h.controller.getState().phase, 'uncertain');
        assert.equal(h.controller.getState().uncertain.acknowledged, false);
        await h.controller.generate();
        assert.equal(creates, 1);
        h.controller.acknowledge();
        await h.controller.generate();
        assert.equal(creates, 2);
    });
}

for (const value of [null, {}, { job: { jobId: 42, status: 'queued' } }, { job: { jobId: JOB_ID } }, { job: { jobId: JOB_ID, status: 'unexpected' } }]) {
    test(`a malformed generate success ${JSON.stringify(value)} keeps the uncertainty lock`, async () => {
        const h = harness({ overrides: {
            generate: async (body) => { h.calls.push(['generate', body]); return value; },
        } });
        await h.ready();
        await h.controller.generate();
        assert.equal(h.controller.getState().phase, 'uncertain');
        assert.equal(h.controller.getState().jobId, '');
        await h.controller.generate();
        assert.equal(h.count('generate'), 1);
        h.controller.teardown();
    });
}

for (const source of ['cancel', 'poll', 'checkStatus']) {
    test(`${source} cannot adopt a reply for a different job id`, async () => {
        const wrongJob = async () => ({ job: job('completed', { jobId: 'wrong-job' }) });
        const h = harness({ overrides: { generate: async () => queuedJob(), status: wrongJob, cancel: wrongJob } });
        await h.ready();
        await h.controller.generate();
        const expected = h.controller.getState();
        if (source === 'poll') await h.fire();
        else await h.controller[source]();
        await nextTurn();
        assert.deepEqual(h.controller.getState(), expected);
        assert.equal(h.settled.length, 0);
        h.controller.teardown();
    });
}

test('a malformed accepted generate error without a job id remains uncertain', async () => {
    const h = harness({ overrides: {
        generate: async (body) => {
            h.calls.push(['generate', body]);
            throw accepted({ jobId: null });
        },
    } });
    await h.ready();
    await h.controller.generate();
    assert.equal(h.controller.getState().phase, 'uncertain');
    await h.controller.generate();
    assert.equal(h.count('generate'), 1);
});

for (const status of [500, 502, 503, 504]) {
    test(`a generic JSON HTTP ${status} create error retains the uncertainty lock`, async () => {
        let creates = 0;
        const api = createReplicateApi({ fetchImpl: async (url) => {
            if (url.endsWith('/models')) return Response.json({ mode: 'mock', provider: { configured: true }, models: MODELS });
            if (url.endsWith('/quote')) return Response.json({ mode: 'mock', estimateUsd: 0, maxUsdPerJob: 1 });
            assert.ok(url.endsWith('/generate'));
            creates += 1;
            return Response.json({ error: 'Gateway timeout' }, { status });
        } });
        const h = harness({ overrides: api });
        await h.ready();
        await h.controller.generate();
        assert.equal(h.controller.getState().phase, 'uncertain');
        assert.equal(h.controller.getState().uncertain.acknowledged, false);
        await h.controller.generate();
        assert.equal(creates, 1);
    });
}

test('accepted recovery takes precedence over ambiguous HTTP 502 and explicit unknown outcome', async () => {
    let creates = 0;
    let reads = 0;
    const api = createReplicateApi({ fetchImpl: async (url) => {
        if (url.endsWith('/models')) return Response.json({ mode: 'mock', provider: { configured: true }, models: MODELS });
        if (url.endsWith('/quote')) return Response.json({ mode: 'mock', estimateUsd: 0, maxUsdPerJob: 1 });
        if (url.endsWith('/generate')) {
            creates += 1;
            return Response.json({ error: 'Saving failed.', generationAccepted: true, outcomeUnknown: true,
                jobId: JOB_ID, jobRecordState: 'confirmed', statusRecoveryAvailable: true, retryable: false }, { status: 502 });
        }
        assert.ok(url.endsWith(`/status?id=${JOB_ID}`));
        reads += 1;
        return Response.json({ job: job('completed') });
    } });
    const h = harness({ overrides: api });
    await h.ready();
    await h.controller.generate();
    assert.equal(h.controller.getState().phase, 'running');
    assert.equal(h.controller.getState().jobId, JOB_ID);
    await h.controller.generate();
    await h.controller.checkStatus();
    assert.equal(h.controller.getState().phase, 'completed');
    assert.equal(creates, 1);
    assert.equal(reads, 1);
    h.controller.teardown();
});

for (const source of ['poll', 'checkStatus', 'cancel']) {
    for (const status of [undefined, null, 'unexpected']) {
        test(`${source} preserves the known job when a matching-id reply has status ${status}`, async () => {
            const badReply = async () => ({ job: job(status) });
            const h = harness({ overrides: { generate: async () => queuedJob(), status: badReply, cancel: badReply } });
            await h.ready();
            await h.controller.generate();
            const known = h.controller.getState().job;
            if (source === 'poll') await h.fire();
            else await h.controller[source]();
            await nextTurn();
            const state = h.controller.getState();
            assert.deepEqual(state.job, known);
            assert.equal(state.jobId, JOB_ID);
            assert.equal(state.phase, 'running');
            assert.equal(state.checkFailed, true);
            assert.ok(state.error);
            assert.equal(state.cancelRequested, false);
            assert.equal(h.settled.length, 0);
            await h.controller.generate();
            assert.equal(h.count('quote'), 1);
            h.controller.teardown();
        });
    }
}

test('a matching-id malformed manual status reply retains the uncertain warning', async () => {
    const h = harness({ overrides: {
        generate: async () => { throw accepted({ statusRecoveryAvailable: false }); },
        status: async () => ({ job: job('unexpected') }),
    } });
    await h.ready();
    await h.controller.generate();
    await h.controller.checkStatus();
    const state = h.controller.getState();
    assert.equal(state.phase, 'uncertain');
    assert.equal(state.job, null);
    assert.match(state.uncertain.message, /billed/);
    assert.match(state.uncertain.message, /Status check failed/);
    h.controller.teardown();
});


function memoryStorage(initial = {}) {
    const data = { ...initial };
    return { data, getItem: (key) => data[key] ?? null,
        setItem: (key, value) => { data[key] = String(value); },
        removeItem: (key) => { delete data[key]; } };
}
const RESUME_KEY = 'ogai.replicate.activeJob.v1.image';
const resumeFor = (storage) => createResumeStore({ storage, kind: 'image', now: () => NOW });
const savedStorage = (userId = '42') => memoryStorage({
    [RESUME_KEY]: JSON.stringify({ v: 1, jobId: JOB_ID, projectId: PROJECT, userId, ts: NOW }),
});

test('a nonterminal accepted job saves its originating project and completion clears the pointer', async () => {
    const storage = memoryStorage();
    const h = harness({ overrides: { generate: async () => queuedJob() },
        controllerOptions: { resume: resumeFor(storage), userId: '42' } });
    await h.ready();
    await h.controller.generate();
    assert.deepEqual(JSON.parse(storage.getItem(RESUME_KEY)), { v: 1, jobId: JOB_ID, projectId: PROJECT, userId: '42', ts: NOW });
    h.controller.setProject(OTHER_PROJECT);
    await h.fire();
    await nextTurn();
    assert.equal(h.controller.getState().phase, 'completed');
    assert.equal(h.settled[0].projectId, PROJECT);
    assert.equal(storage.getItem(RESUME_KEY), null);
});

test('recreating the controller resumes only status and settles the original project', async () => {
    const storage = memoryStorage();
    const options = { resume: resumeFor(storage), userId: '42' };
    const first = harness({ overrides: { generate: async () => queuedJob() }, controllerOptions: options });
    await first.ready();
    await first.controller.generate();
    first.controller.teardown();
    const second = harness({ controllerOptions: options });
    second.controller.setProject(OTHER_PROJECT);
    await second.controller.load();
    assert.equal(second.controller.getState().phase, 'completed');
    assert.equal(second.count('status'), 1);
    assert.equal(second.count('generate'), 0);
    assert.equal(second.count('quote'), 0);
    assert.equal(second.settled[0].projectId, PROJECT);
    assert.equal(storage.getItem(RESUME_KEY), null);
});

test('repeated load of a running resume leaves one polling loop and the original project', async () => {
    const storage = savedStorage();
    const h = harness({ overrides: { status: async (id) => { h.calls.push(['status', id]); return { job: job('running') }; } },
        controllerOptions: { resume: resumeFor(storage), userId: '42' } });
    await Promise.all([h.controller.load(), h.controller.load()]);
    assert.equal(h.controller.getState().resumed, true);
    assert.equal(h.controller.getState().notice.kind, 'resumed');
    assert.equal(h.count('status'), 1);
    assert.equal(h.pending().length, 1);
    h.controller.setProject(OTHER_PROJECT);
    await h.fire();
    await nextTurn();
    assert.deepEqual(h.calls.filter(([name]) => name === 'status').map(([, id]) => id), [JOB_ID, JOB_ID]);
    assert.equal(JSON.parse(storage.getItem(RESUME_KEY)).projectId, PROJECT);
    assert.equal(h.pending().length, 1);
    h.controller.teardown();
});

test('a resumed 404 clears the pointer but preserves the billing warning and acknowledgement lock', async () => {
    const storage = savedStorage();
    const h = harness({ overrides: { status: async () => { throw new ReplicateApiError('Missing', { status: 404 }); } },
        controllerOptions: { resume: resumeFor(storage), userId: '42' } });
    await h.ready();
    assert.equal(h.controller.getState().phase, 'uncertain');
    assert.match(h.controller.getState().uncertain.message, /no longer available|not recorded/);
    assert.match(h.controller.getState().uncertain.message, /billed/);
    assert.equal(storage.getItem(RESUME_KEY), null);
    assert.equal(h.pending().length, 0);
    await h.controller.generate();
    assert.equal(h.count('generate'), 0);
    h.controller.acknowledge();
    h.controller.setValue('prompt', 'acknowledged generation');
    await h.controller.generate();
    assert.equal(h.count('generate'), 1);
});

for (const userId of ['99', '']) {
    test(`resume ignores and clears a pointer for an unavailable or different owner (${userId})`, async () => {
        const storage = savedStorage();
        const h = harness({ controllerOptions: { resume: resumeFor(storage), userId } });
        await h.controller.load();
        assert.equal(h.controller.getState().phase, 'idle');
        assert.equal(h.count('status'), 0);
        assert.equal(storage.getItem(RESUME_KEY), null);
    });
}

test('accepted error with status recovery saves the pointer before polling', async () => {
    const storage = memoryStorage();
    const h = harness({ overrides: { generate: async () => { throw accepted(); } },
        controllerOptions: { resume: resumeFor(storage), userId: '42' } });
    await h.ready();
    await h.controller.generate();
    assert.equal(JSON.parse(storage.getItem(RESUME_KEY)).jobId, JOB_ID);
    await h.fire();
    await nextTurn();
    assert.equal(storage.getItem(RESUME_KEY), null);
    assert.equal(h.settled[0].projectId, PROJECT);
});

test('session loss clears both kind pointers even when the controller has no resume adapter', async () => {
    const storage = savedStorage();
    const videoKey = 'ogai.replicate.activeJob.v1.video';
    storage.setItem(videoKey, storage.getItem(RESUME_KEY));
    const previous = globalThis.window;
    globalThis.window = { sessionStorage: storage };
    try {
        const h = harness({ overrides: { models: async () => { throw new ReplicateApiError('Sign in', { status: 401 }); } } });
        await h.controller.load();
        assert.equal(h.counters.authLost, 1);
        assert.equal(storage.getItem(RESUME_KEY), null);
        assert.equal(storage.getItem(videoKey), null);
    } finally { globalThis.window = previous; }
});

test('resume adapter failures never prevent loading, generation or settlement', async () => {
    const broken = () => { throw new Error('Storage unavailable'); };
    const h = harness({ overrides: { generate: async () => queuedJob() },
        controllerOptions: { resume: { load: broken, save: broken, clear: broken }, userId: '42' } });
    await h.ready();
    assert.equal(h.controller.getState().loaded, true);
    assert.equal(h.controller.getState().loadError, '');
    await h.controller.generate();
    assert.equal(h.controller.getState().phase, 'running');
    await h.fire();
    await nextTurn();
    assert.equal(h.controller.getState().phase, 'completed');
    assert.equal(h.settled.length, 1);
});

test('teardown discards a late resumed status without clearing the pointer or settling', async () => {
    const storage = savedStorage();
    const late = deferred();
    const h = harness({ overrides: { status: async () => late.promise },
        controllerOptions: { resume: resumeFor(storage), userId: '42' } });
    const loading = h.controller.load();
    await nextTurn();
    h.controller.teardown();
    late.resolve({ job: job('completed') });
    await loading;
    assert.equal(h.settled.length, 0);
    assert.equal(h.pending().length, 0);
    assert.ok(storage.getItem(RESUME_KEY));
});

test('resumed polls use bounded increasing delays and retain manual status at the deadline', async () => {
    const storage = savedStorage();
    const h = harness({ overrides: { status: async () => ({ job: job('running') }) },
        controllerOptions: { resume: resumeFor(storage), userId: '42' } });
    await h.controller.load();
    const firstDelay = h.pending()[0].ms;
    await h.fire();
    await nextTurn();
    assert.ok(h.pending()[0].ms > firstDelay);
    assert.ok(h.pending()[0].ms <= 30000);
    h.advance(POLL_DEADLINE_MS);
    await h.fire();
    await nextTurn();
    assert.equal(h.controller.getState().deadlineReached, true);
    assert.equal(h.pending().length, 0);
    assert.ok(storage.getItem(RESUME_KEY));
    h.controller.teardown();
});

test('a controller without resume keeps the existing initial behavior', async () => {
    const h = harness();
    await h.controller.load();
    assert.equal(h.controller.getState().phase, 'idle');
    assert.equal(h.controller.getState().resumed, false);
});


const uncertaintyFor = async (storage) => {
    const { createUncertaintyStore } = await import('../src/lib/replicateUncertainty.js');
    return createUncertaintyStore({ storage, kind: 'image', now: () => NOW });
};
const UNCERTAINTY_KEY = 'ogai.replicate.uncertain.v1.image';

for (const outcome of ['network', 'accepted-untracked', 'missing-resume']) {
    test(`recreated controllers retain the ${outcome} uncertainty lock without submitting`, async () => {
        const storage = outcome === 'missing-resume' ? savedStorage() : memoryStorage();
        const options = { resume: resumeFor(storage), uncertainty: await uncertaintyFor(storage), userId: '42' };
        const first = harness({ controllerOptions: options, overrides: {
            generate: async () => { throw outcome === 'network'
                ? new ReplicateApiError('offline', { outcomeUnknown: true })
                : accepted({ statusRecoveryAvailable: false }); },
            status: async () => { throw new ReplicateApiError('Missing', { status: 404 }); },
        } });
        await first.ready();
        if (outcome !== 'missing-resume') await first.controller.generate();
        assert.equal(first.controller.getState().phase, 'uncertain');
        assert.ok(storage.getItem(UNCERTAINTY_KEY));
        first.controller.teardown();
        const second = harness({ controllerOptions: options });
        await second.ready();
        assert.equal(second.controller.getState().phase, 'uncertain');
        assert.match(second.controller.getState().uncertain.message, /billed/);
        assert.equal(second.controller.getState().jobProjectId, PROJECT);
        await second.controller.generate();
        assert.equal(second.count('generate'), 0);
        assert.equal(second.count('status'), 0, 'uncertainty never automatically polls or submits');
        second.controller.acknowledge();
        assert.equal(storage.getItem(UNCERTAINTY_KEY), null);
        assert.equal(storage.getItem(RESUME_KEY), null);
    });
}

test('navigation during submission keeps an uncertainty marker before the server answers', async () => {
    const storage = memoryStorage();
    const options = { resume: resumeFor(storage), uncertainty: await uncertaintyFor(storage), userId: '42' };
    const late = deferred();
    const first = harness({ controllerOptions: options, overrides: { generate: async () => late.promise } });
    await first.ready();
    const submitting = first.controller.generate();
    await nextTurn();
    assert.ok(storage.getItem(UNCERTAINTY_KEY));
    first.controller.teardown();
    const second = harness({ controllerOptions: options });
    await second.ready();
    assert.equal(second.controller.getState().phase, 'uncertain');
    late.resolve(queuedJob());
    await submitting;
    assert.equal(second.controller.getState().phase, 'uncertain');
    assert.ok(storage.getItem(UNCERTAINTY_KEY));
    second.controller.acknowledge();
});

test('a known status manually recovered from uncertainty clears its marker and writes a resume pointer', async () => {
    const storage = memoryStorage();
    const h = harness({ controllerOptions: { resume: resumeFor(storage), uncertainty: await uncertaintyFor(storage), userId: '42' },
        overrides: { generate: async () => { throw accepted({ statusRecoveryAvailable: false }); },
            status: async () => ({ job: job('running') }) } });
    await h.ready();
    await h.controller.generate();
    assert.ok(storage.getItem(UNCERTAINTY_KEY));
    h.controller.setProject(OTHER_PROJECT);
    await h.controller.checkStatus();
    assert.equal(storage.getItem(UNCERTAINTY_KEY), null);
    assert.equal(JSON.parse(storage.getItem(RESUME_KEY)).projectId, PROJECT);
    h.controller.teardown();
});

test('a definite create rejection clears the provisional uncertainty marker', async () => {
    const storage = memoryStorage();
    const h = harness({ controllerOptions: { resume: resumeFor(storage), uncertainty: await uncertaintyFor(storage), userId: '42' },
        overrides: { generate: async () => { throw new ReplicateApiError('Rejected', { status: 400 }); } } });
    await h.ready();
    await h.controller.generate();
    assert.equal(h.controller.getState().phase, 'idle');
    assert.equal(storage.getItem(UNCERTAINTY_KEY), null);
});


test('accepted jobs retain an uncertainty marker when saving their resume pointer fails', async () => {
    const storage = memoryStorage();
    const uncertainty = await uncertaintyFor(storage);
    const options = { uncertainty, userId: '42', resume: { save() { throw Error('quota'); }, load() { return null; }, clear() {} } };
    const first = harness({ controllerOptions: options, overrides: { generate: async () => queuedJob() } });
    await first.ready();
    await first.controller.generate();
    assert.equal(first.controller.getState().phase, 'running');
    assert.equal(JSON.parse(storage.getItem(UNCERTAINTY_KEY)).jobId, JOB_ID);
    first.controller.teardown();
    const second = harness({ controllerOptions: options });
    await second.ready();
    assert.equal(second.controller.getState().phase, 'uncertain');
    assert.equal(second.controller.getState().uncertain.jobId, JOB_ID);
    second.controller.acknowledge();
});

test('a manual check during an automatic status read shares the existing read', async () => {
    const late = deferred();
    let reads = 0;
    const h = harness({ overrides: { generate: async () => queuedJob(),
        status: async () => { reads += 1; return late.promise; } } });
    await h.ready();
    await h.controller.generate();
    const polling = h.fire();
    const checking = h.controller.checkStatus();
    assert.equal(reads, 1);
    late.resolve({ job: job('running') });
    await Promise.all([polling, checking]);
    assert.equal(h.pending().length, 1);
    h.controller.teardown();
});

test('a manual status read cancels its scheduled automatic read until it finishes', async () => {
    const late = deferred();
    const h = harness({ overrides: { generate: async () => queuedJob(), status: async () => late.promise } });
    await h.ready();
    await h.controller.generate();
    const checking = h.controller.checkStatus();
    assert.equal(h.pending().length, 0);
    late.resolve({ job: job('running') });
    await checking;
    assert.equal(h.pending().length, 1);
    h.controller.teardown();
});
