import test from 'node:test';
import assert from 'node:assert/strict';
import {
    POLL_DEADLINE_MS, ReplicateApiError, createReplicateController,
} from '../src/lib/replicateStudioClient.js';

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

function harness({ mode = 'mock', overrides = {} } = {}) {
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
