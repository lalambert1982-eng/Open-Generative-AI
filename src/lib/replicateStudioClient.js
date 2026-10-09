import {
    buildInput, defaultValues, pickDefaultModel, validationErrors,
} from './replicateStudioForm.js';

const BASE = '/api/creator/replicate';
export const POLL_INTERVAL_MS = 2500;
export const POLL_DEADLINE_MS = 21 * 60 * 1000;
const TERMINAL = new Set(['completed', 'failed', 'canceled']);

export class ReplicateApiError extends Error {
    constructor(message, details = {}) {
        super(message);
        this.name = 'ReplicateApiError';
        this.status = details.status ?? 0;
        this.code = details.code;
        this.generationAccepted = details.generationAccepted === true;
        this.jobId = typeof details.jobId === 'string' ? details.jobId : null;
        this.jobRecordState = details.jobRecordState || null;
        this.statusRecoveryAvailable = details.statusRecoveryAvailable === true;
        this.retryable = details.retryable;
        this.outcomeUnknown = details.outcomeUnknown === true;
    }
}

export function createReplicateApi({ fetchImpl = (...args) => globalThis.fetch(...args), base = BASE } = {}) {
    async function call(path, { method = 'GET', body, unknownOnNetworkFailure = false } = {}) {
        let response;
        try {
            response = await fetchImpl(`${base}/${path}`, {
                method,
                credentials: 'same-origin',
                cache: 'no-store',
                headers: body === undefined ? undefined : { 'content-type': 'application/json' },
                body: body === undefined ? undefined : JSON.stringify(body),
            });
        } catch {
            throw new ReplicateApiError('The connection was lost before the server answered.', {
                status: 0, outcomeUnknown: unknownOnNetworkFailure,
            });
        }
        const value = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw new ReplicateApiError(value.error || `Request failed (${response.status}).`, { ...value, status: response.status });
        }
        return value;
    }
    return {
        models: () => call('models'),
        quote: ({ model, input }) => call('quote', { method: 'POST', body: { model, input } }),
        generate: ({ model, input, projectId, quoteToken }) => call('generate', {
            method: 'POST',
            body: { model, input, projectId, ...(quoteToken ? { quoteToken } : {}) },
            unknownOnNetworkFailure: true,
        }),
        status: (id) => call(`status?id=${encodeURIComponent(id)}`),
        cancel: (id) => call('cancel', { method: 'POST', body: { id } }),
    };
}

const LOCKED = new Set(['quoting', 'submitting', 'running', 'uncertain']);
const UNKNOWN_MESSAGE = 'The server did not confirm whether a generation was started. It may have been, and may be billed. Operator review is needed before generating this request again.';

function initialState(kind) {
    return {
        kind, loaded: false, loadError: '', mode: null, configured: false,
        limits: { maxUsdPerJob: null, maxUsdPerDay: null },
        models: [], modelId: '', values: {}, fieldErrors: {}, projectId: '',
        quote: null, overCap: false, phase: 'idle',
        job: null, jobId: '', jobProjectId: '',
        cancelRequested: false, checkFailed: false, deadlineReached: false,
        notice: null, error: '', uncertain: null, authLost: false,
    };
}

const isAuthError = (error) => error?.status === 401;

export function createReplicateController({
    api,
    kind,
    now = () => Date.now(),
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (id) => clearTimeout(id),
    onJobSettled = () => {},
    onAuthLost = () => {},
}) {
    let state = initialState(kind);
    const listeners = new Set();
    let epoch = 0;
    let inFlight = false;
    let cancelling = false;
    let timer = null;
    let pollStartedAt = 0;

    const set = (patch) => {
        state = { ...state, ...patch };
        listeners.forEach((listener) => listener());
    };
    const locked = () => LOCKED.has(state.phase);
    const currentModel = () => state.models.find((item) => item.id === state.modelId) || null;

    function stopPolling() {
        if (timer) clearTimer(timer);
        timer = null;
    }

    function invalidate() {
        if (state.phase === 'quoted' || state.phase === 'quoting') {
            set({ phase: 'idle', quote: null, overCap: false });
        }
    }

    function authLost() {
        epoch += 1;
        stopPolling();
        set({
            ...initialState(kind),
            loaded: state.loaded, mode: state.mode, configured: state.configured, limits: state.limits,
            models: state.models, modelId: state.modelId, values: state.values, projectId: state.projectId,
            authLost: true,
        });
        onAuthLost();
    }

    function enterUncertain({ jobId, message }) {
        stopPolling();
        set({
            phase: 'uncertain', jobId: jobId || '', quote: null, overCap: false,
            uncertain: { jobId: jobId || null, message, baseMessage: message, acknowledged: false },
        });
    }

    function schedule(jobId) {
        stopPolling();
        const myEpoch = epoch;
        timer = setTimer(() => { pollOnce(jobId, myEpoch); }, POLL_INTERVAL_MS);
    }

    function startPolling(jobId) {
        pollStartedAt = now();
        set({ checkFailed: false, deadlineReached: false });
        schedule(jobId);
    }

    function applyJob(job, { polled = false } = {}) {
        if (state.jobId === job.jobId && TERMINAL.has(state.phase)) return;
        if (!TERMINAL.has(job.status)) {
            set({ job, jobId: job.jobId, phase: 'running', checkFailed: false, uncertain: null });
            if (!polled) startPolling(job.jobId);
            else if (now() - pollStartedAt >= POLL_DEADLINE_MS) set({ deadlineReached: true });
            else schedule(job.jobId);
            return;
        }
        stopPolling();
        const phase = job.status === 'completed' ? 'completed' : job.status === 'canceled' ? 'canceled' : 'failed';
        const missingAsset = phase === 'completed' && !job.asset;
        set({
            job, jobId: job.jobId, phase, quote: null, overCap: false, uncertain: null,
            cancelRequested: false, checkFailed: false, deadlineReached: false,
            notice: missingAsset ? { kind: 'info', message: 'The generation finished but no saved Asset was returned.' } : null,
            error: phase === 'failed' ? (job.error || 'Generation failed.') : '',
        });
        if (phase === 'completed' && job.asset) onJobSettled({ projectId: state.jobProjectId, job });
    }

    async function pollOnce(jobId, myEpoch) {
        timer = null;
        if (myEpoch !== epoch) return;
        try {
            const value = await api.status(jobId);
            if (myEpoch !== epoch) return;
            applyJob(value.job, { polled: true });
        } catch (error) {
            if (myEpoch !== epoch) return;
            if (isAuthError(error)) { authLost(); return; }
            stopPolling();
            set({ checkFailed: true, error: error.message });
        }
    }

    async function load() {
        const myEpoch = epoch;
        try {
            const value = await api.models();
            if (myEpoch !== epoch) return;
            const models = (value.models || []).filter((item) => item.kind === kind && item.enabled !== false);
            const keep = models.find((item) => item.id === state.modelId);
            const chosen = keep || pickDefaultModel(models, kind);
            set({
                loaded: true, loadError: '', mode: value.mode || null,
                configured: value.provider?.configured === true,
                limits: value.limits || state.limits, models,
                modelId: chosen?.id || '', values: keep ? state.values : (chosen ? defaultValues(chosen) : {}),
            });
        } catch (error) {
            if (myEpoch !== epoch) return;
            if (isAuthError(error)) { authLost(); return; }
            set({ loaded: true, loadError: error.message });
        }
    }

    function selectModel(id) {
        if (locked()) return;
        const model = state.models.find((item) => item.id === id);
        if (!model) return;
        set({ modelId: id, values: defaultValues(model), fieldErrors: {}, error: '' });
        invalidate();
    }

    function setValue(name, value) {
        if (locked()) return;
        set({ values: { ...state.values, [name]: value }, fieldErrors: { ...state.fieldErrors, [name]: undefined }, error: '' });
        invalidate();
    }

    function setProject(projectId) {
        if (projectId === state.projectId) return;
        set({ projectId });
        invalidate();
    }

    async function doReview() {
        const model = currentModel();
        if (!model) return false;
        if (!state.projectId) { set({ error: 'Open a Project before generating.' }); return false; }
        if (!state.configured) { set({ error: 'Replicate is not configured on this server.' }); return false; }
        const problems = validationErrors(model, state.values);
        if (Object.keys(problems).length) {
            set({ fieldErrors: problems, error: 'Fix the highlighted settings before generating.' });
            return false;
        }
        const myEpoch = epoch;
        const input = buildInput(model, state.values);
        const projectId = state.projectId;
        set({
            phase: 'quoting', error: '', fieldErrors: {}, notice: null, uncertain: null,
            job: null, jobId: '', cancelRequested: false, checkFailed: false, deadlineReached: false,
        });
        try {
            const value = await api.quote({ model: model.id, input });
            if (myEpoch !== epoch || state.phase !== 'quoting' || state.projectId !== projectId) return false;
            const cap = Number(value.maxUsdPerJob);
            const overCap = Number.isFinite(cap) && value.estimateUsd > cap;
            set({
                phase: 'quoted', overCap,
                ...((value.mode === 'mock' || value.mode === 'live') && value.mode !== state.mode ? { mode: value.mode } : {}),
                quote: {
                    estimateUsd: value.estimateUsd, display: value.display, quoteToken: value.quoteToken,
                    expiresAt: value.expiresAt, mode: value.mode, maxUsdPerJob: value.maxUsdPerJob,
                    modelId: model.id, projectId, input,
                },
            });
            return !overCap;
        } catch (error) {
            if (myEpoch !== epoch) return false;
            if (isAuthError(error)) { authLost(); return false; }
            set({ phase: 'idle', error: error.message });
            return false;
        }
    }

    async function doSubmit() {
        const { quote } = state;
        if (state.phase !== 'quoted' || !quote || state.overCap) return;
        if (state.mode === 'live' && now() >= Date.parse(quote.expiresAt)) {
            set({
                phase: 'idle', quote: null, overCap: false,
                notice: { kind: 'expired', message: 'The price quote expired. Review the price again.' },
            });
            return;
        }
        const myEpoch = epoch;
        set({ phase: 'submitting', error: '', notice: null, jobProjectId: quote.projectId });
        try {
            const value = await api.generate({
                model: quote.modelId, input: quote.input, projectId: quote.projectId, quoteToken: quote.quoteToken,
            });
            if (myEpoch !== epoch) return;
            if (!value?.job?.jobId) { enterUncertain({ jobId: null, message: UNKNOWN_MESSAGE }); return; }
            applyJob(value.job);
        } catch (error) {
            if (myEpoch !== epoch) return;
            if (isAuthError(error) && !error.generationAccepted) { authLost(); return; }
            if (error.generationAccepted && error.jobId) {
                if (error.statusRecoveryAvailable) {
                    set({
                        phase: 'running', jobId: error.jobId,
                        notice: { kind: 'saving-problem', message: 'The generation started, but saving its record had a problem. Checking the same job; it will not be submitted again.' },
                    });
                    startPolling(error.jobId);
                } else {
                    enterUncertain({
                        jobId: error.jobId,
                        message: `The generation was accepted (job ${error.jobId}) but its record could not be confirmed, so progress cannot be tracked. It may be billed. Operator review is needed before generating this request again.`,
                    });
                }
            } else if (error.outcomeUnknown) {
                enterUncertain({ jobId: null, message: UNKNOWN_MESSAGE });
            } else {
                set({ phase: 'idle', quote: null, overCap: false, error: error.message });
            }
        }
    }

    // Synchronous in-flight guard: set before the first await so two rapid clicks cannot both pass.
    async function generate() {
        if (inFlight || locked()) return;
        inFlight = true;
        try {
            if (state.phase === 'quoted') return;
            const reviewed = await doReview();
            if (reviewed && state.quote?.mode !== 'live' && state.mode !== 'live') await doSubmit();
        } finally {
            inFlight = false;
        }
    }

    async function confirm() {
        if (inFlight || state.phase !== 'quoted') return;
        inFlight = true;
        try {
            await doSubmit();
        } finally {
            inFlight = false;
        }
    }

    async function checkStatus() {
        const jobId = state.phase === 'uncertain' ? state.uncertain?.jobId : state.jobId;
        if (state.phase !== 'running' && state.phase !== 'uncertain') return;
        if (!jobId || inFlight) return;
        inFlight = true;
        const myEpoch = epoch;
        try {
            const value = await api.status(jobId);
            if (myEpoch !== epoch) return;
            applyJob(value.job);
        } catch (error) {
            if (myEpoch !== epoch) return;
            if (isAuthError(error)) { authLost(); return; }
            if (state.phase === 'uncertain') {
                const message = error.status === 404
                    ? `Job ${jobId} is not recorded on the server. That does not prove nothing was generated; it may still have been billed. Operator review is needed before generating this request again.`
                    : `${state.uncertain.baseMessage ?? state.uncertain.message} (Status check failed: ${error.message})`;
                set({ uncertain: { ...state.uncertain, message } });
            } else {
                set({ checkFailed: true, error: error.message });
            }
        } finally {
            inFlight = false;
        }
    }

    async function cancel() {
        if (state.phase !== 'running' || !state.jobId || cancelling) return;
        cancelling = true;
        const myEpoch = epoch;
        try {
            const value = await api.cancel(state.jobId);
            if (myEpoch !== epoch) return;
            set({ cancelRequested: true });
            applyJob(value.job, { polled: true });
            if (state.phase === 'running') {
                set({ notice: { kind: 'cancel-requested', message: 'Cancel requested. Waiting for the provider to confirm.' } });
            }
        } catch (error) {
            if (myEpoch !== epoch) return;
            if (isAuthError(error)) { authLost(); return; }
            set({ error: error.message });
        } finally {
            cancelling = false;
        }
    }

    function acknowledge() {
        if (state.phase !== 'uncertain') return;
        set({ phase: 'idle', uncertain: { ...state.uncertain, acknowledged: true } });
    }

    function teardown() {
        epoch += 1;
        stopPolling();
        listeners.clear();
    }

    return {
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
        getState: () => state,
        load, selectModel, setValue, setProject, generate, confirm, checkStatus, cancel, acknowledge, teardown,
    };
}
