import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveView } from '../src/lib/replicateStudioView.js';

const base = {
    kind: 'image', loaded: true, loadError: '', mode: 'mock', configured: true,
    limits: { maxUsdPerJob: 1 }, models: [{ id: 'm' }], modelId: 'm', values: {}, fieldErrors: {},
    projectId: 'p', quote: null, overCap: false, phase: 'idle', job: null, jobId: '', jobProjectId: '',
    cancelRequested: false, checkFailed: false, deadlineReached: false, notice: null, error: '', uncertain: null, authLost: false,
};
const state = (patch) => ({ ...base, ...patch });

test('mock mode shows a no-charge badge and a one-click Generate', () => {
    const view = deriveView(state({}));
    assert.match(view.badge.text, /Mock/);
    assert.equal(view.primary.action, 'generate');
    assert.match(view.primary.label, /no charge/i);
    assert.equal(view.primary.enabled, true);
});

test('live mode asks for price review, then an explicit confirmation showing the price', () => {
    assert.equal(deriveView(state({ mode: 'live' })).primary.label, 'Review price');
    const quoted = deriveView(state({
        mode: 'live', phase: 'quoted',
        quote: { estimateUsd: 0.003, display: '~$0.003 per image (estimate)', expiresAt: '2026-10-09T12:05:00.000Z' },
    }));
    assert.equal(quoted.primary.action, 'confirm');
    assert.match(quoted.primary.label, /\$0\.003/);
    assert.equal(quoted.price.expiresAt, '2026-10-09T12:05:00.000Z');
});

test('Generate is disabled without a Project, models, or configuration, with a reason', () => {
    assert.equal(deriveView(state({ projectId: '' })).primary.enabled, false);
    assert.match(deriveView(state({ projectId: '' })).disabledReason, /Project/);
    assert.match(deriveView(state({ configured: false })).disabledReason, /not configured/i);
    assert.equal(deriveView(state({ modelId: '', models: [] })).primary.enabled, false);
});

test('an estimate above the cap cannot be confirmed and suggests changes', () => {
    const view = deriveView(state({
        mode: 'live', phase: 'quoted', overCap: true,
        quote: { estimateUsd: 1.5, display: 'x', expiresAt: 'z', maxUsdPerJob: 1 },
    }));
    assert.equal(view.primary.enabled, false);
    assert.match(view.overCapMessage, /\$1\.00/);
});

test('uncertain state blocks Generate and shows acknowledge, plus check status only with a job id', () => {
    const withId = deriveView(state({ phase: 'uncertain', jobId: 'job1', uncertain: { jobId: 'job1', message: 'm', acknowledged: false } }));
    assert.equal(withId.primary.enabled, false);
    assert.equal(withId.showAcknowledge, true);
    assert.equal(withId.showCheckStatus, true);
    const noId = deriveView(state({ phase: 'uncertain', uncertain: { jobId: null, message: 'm', acknowledged: false } }));
    assert.equal(noId.showCheckStatus, false);
    assert.equal(noId.showAcknowledge, true);
    assert.ok(noId.banners.some((banner) => banner.tone === 'warn' && banner.text === 'm'));
});

test('an acknowledged uncertainty stays visible but Generate is available again', () => {
    const view = deriveView(state({ phase: 'idle', uncertain: { jobId: null, message: 'm', acknowledged: true } }));
    assert.equal(view.primary.enabled, true);
    assert.equal(view.showAcknowledge, false);
    assert.ok(view.banners.some((banner) => banner.text === 'm'));
});

test('running shows Cancel, locks provider switching, and shows Check status after a failed poll or deadline', () => {
    const running = deriveView(state({ phase: 'running', jobId: 'job1', job: { status: 'processing' } }));
    assert.equal(running.showCancel, true);
    assert.equal(running.providerSwitchDisabled, true);
    assert.equal(running.showCheckStatus, false);
    assert.equal(deriveView(state({ phase: 'running', jobId: 'job1', checkFailed: true })).showCheckStatus, true);
    assert.equal(deriveView(state({ phase: 'running', jobId: 'job1', deadlineReached: true })).showCheckStatus, true);
});

test('cancel is reported as requested until a confirmed canceled state', () => {
    const requested = deriveView(state({ phase: 'running', jobId: 'job1', cancelRequested: true, notice: { kind: 'cancel-requested', message: 'Cancel requested.' } }));
    assert.ok(requested.banners.some((banner) => /Cancel requested/.test(banner.text)));
    const canceled = deriveView(state({ phase: 'canceled', job: { status: 'canceled' } }));
    assert.ok(canceled.banners.some((banner) => /Canceled/.test(banner.text)));
});

test('a completed mock image is an image with a mock-placeholder label', () => {
    const view = deriveView(state({ phase: 'completed', job: { status: 'completed', mock: true, asset: { id: 'a', url: 'https://x/a.png', type: 'graphic' } } }));
    assert.deepEqual({ kind: view.result.kind, mock: view.result.mockPlaceholder, id: view.result.assetId }, { kind: 'image', mock: true, id: 'a' });
});

test('a mock VIDEO job is previewed as an image placeholder, never as playable video', () => {
    const view = deriveView(state({ kind: 'video', phase: 'completed', job: { status: 'completed', mock: true, asset: { id: 'a', url: 'https://x/a.png', type: 'graphic' } } }));
    assert.equal(view.result.kind, 'image');
    assert.equal(view.result.mockPlaceholder, true);
});

test('a live video Asset is playable video', () => {
    const view = deriveView(state({ kind: 'video', mode: 'live', phase: 'completed', job: { status: 'completed', mock: false, asset: { id: 'a', url: 'https://x/a.mp4', type: 'video' } } }));
    assert.equal(view.result.kind, 'video');
    assert.equal(view.result.mockPlaceholder, false);
});

test('saving-problem and auth-loss are reported', () => {
    const saving = deriveView(state({ phase: 'running', jobId: 'j', notice: { kind: 'saving-problem', message: 'saving' } }));
    assert.ok(saving.banners.some((banner) => banner.tone === 'warn' && banner.text === 'saving'));
    const auth = deriveView(state({ authLost: true }));
    assert.ok(auth.banners.some((banner) => /sign in/i.test(banner.text)));
});

test('failed jobs show the server message; no Retry control exists in the view', () => {
    const view = deriveView(state({ phase: 'failed', error: 'Model rejected the prompt.', job: { status: 'failed' } }));
    assert.ok(view.banners.some((banner) => banner.tone === 'error' && /rejected/.test(banner.text)));
    assert.equal(Object.hasOwn(view, 'showRetry'), false);
});

test('an unknown mode never shows a no-charge label and blocks Generate', () => {
    const view = deriveView(state({ mode: null }));
    assert.equal(view.primary.enabled, false);
    assert.doesNotMatch(view.primary.label, /no charge/i);
    assert.notEqual(view.disabledReason, '');
});

test('a lost session blocks Generate', () => {
    const view = deriveView(state({ authLost: true }));
    assert.equal(view.primary.enabled, false);
    assert.match(view.disabledReason, /Sign in/);
});
