import {
    buildInput, defaultValues, pickDefaultModel, validationErrors,
} from './replicateStudioForm.js';

import { clearReplicateResume } from './replicateResume.js';
import { clearReplicateUncertainty } from './replicateUncertainty.js';

const BASE = '/api/creator/replicate';
export const POLL_INTERVAL_MS = 2500;
export const POLL_DEADLINE_MS = 21 * 60 * 1000;
const TERMINAL = new Set(['completed', 'failed', 'canceled']);
const JOB_STATUSES = new Set(['queued', 'processing', 'running', ...TERMINAL]);
const validJob = (job) => typeof job?.jobId === 'string' && job.jobId.trim().length > 0
    && JOB_STATUSES.has(job.status);

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
        const value = await response.json().catch(() => null);
        if (!response.ok) {
            const details = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
            const structuredError = typeof details.error === 'string' && details.error.trim().length > 0;
            const definiteRejection = details.generationAccepted === false || details.outcomeUnknown === false;
            const ambiguousServerError = response.status >= 500 && details.generationAccepted !== true && !definiteRejection;
            throw new ReplicateApiError(structuredError ? details.error : `Request failed (${response.status}).`, {
                ...details, status: response.status,
                outcomeUnknown: details.outcomeUnknown === true
                    || (unknownOnNetworkFailure && (!structuredError || ambiguousServerError)),
            });
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
        notice: null, resumed: false, error: '', uncertain: null, authLost: false,
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
    resume = null, uncertainty = null, userId = '',
}) {
    let state = initialState(kind);
    const listeners = new Set();
    let epoch = 0;
    let inFlight = false;
    let cancelling = null;
    let statusRead = null;
    let timer = null;
    let pollStartedAt = 0;
    let pollDelay = POLL_INTERVAL_MS;

    const set = (patch) => {
        state = { ...state, ...patch };
        listeners.forEach((listener) => listener());
    };
    const locked = () => LOCKED.has(state.phase);
    const currentModel = () => state.models.find((item) => item.id === state.modelId) || null;
    const currentJob = (jobId, myEpoch) => myEpoch === epoch && state.jobId === jobId
        && (state.phase === 'running' || state.phase === 'uncertain');

    function stopPolling() {
        if (timer) clearTimer(timer);
        timer = null;
    }

    const clearResume = () => { try { resume?.clear(); } catch { /* Best effort storage. */ } };
    const clearUncertainty = () => { try { uncertainty?.clear(); } catch { /* Best effort storage. */ } };
    const saveUncertainty = (jobId = null) => {
        try { uncertainty?.save({ jobId, projectId: state.jobProjectId, userId }); } catch { /* Best effort storage. */ }
    };
    const saveResume = (jobId) => {
        try { resume?.save({ jobId, projectId: state.jobProjectId, userId }); } catch { /* Best effort storage. */ }
        const saved = loadPointer(resume);
        if (saved?.jobId === jobId && saved.projectId === state.jobProjectId) clearUncertainty();
        else saveUncertainty(jobId);
    };
    const loadPointer = (store) => {
        try { return store?.load({ userId }) || null; } catch { return null; }
    };

    function invalidate() {
        if (state.phase === 'quoted' || state.phase === 'quoting') {
            set({ phase: 'idle', quote: null, overCap: false });
        }
    }

    function authLost() {
        clearResume();
        clearUncertainty();
        clearReplicateResume();
        clearReplicateUncertainty();
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
        clearResume();
        saveUncertainty(jobId || null);
        set({
            phase: 'uncertain', jobId: jobId || '', quote: null, overCap: false,
            uncertain: { jobId: jobId || null, message, baseMessage: message, acknowledged: false },
        });
    }

    function schedule(jobId) {
        stopPolling();
        const myEpoch = epoch;
        timer = setTimer(() => pollOnce(jobId, myEpoch), pollDelay);
        pollDelay = Math.min(30000, Math.round(pollDelay * 1.5));
    }

    function startPolling(jobId) {
        pollStartedAt = now();
        pollDelay = POLL_INTERVAL_MS;
        set({ checkFailed: false, deadlineReached: false });
        schedule(jobId);
    }

    function applyJob(job, { polled = false } = {}) {
        if (!validJob(job)) throw new ReplicateApiError('The server returned an invalid generation status.', { code: 'invalid_job_reply' });
        if (state.jobId === job.jobId && TERMINAL.has(state.phase)) return;
        if (!TERMINAL.has(job.status)) {
            saveResume(job.jobId);
            set({ job, jobId: job.jobId, phase: 'running', checkFailed: false, uncertain: null });
            if (!polled) startPolling(job.jobId);
            else if (now() - pollStartedAt >= POLL_DEADLINE_MS) set({ deadlineReached: true });
            else schedule(job.jobId);
            return;
        }
        stopPolling();
        clearResume();
        clearUncertainty();
        const phase = job.status === 'completed' ? 'completed' : job.status === 'canceled' ? 'canceled' : 'failed';
        const missingAsset = phase === 'completed' && !job.asset;
        set({
            job, jobId: job.jobId, phase, resumed: false, quote: null, overCap: false, uncertain: null,
            cancelRequested: false, checkFailed: false, deadlineReached: false,
            notice: missingAsset ? { kind: 'info', message: 'The generation finished but no saved Asset was returned.' } : null,
            error: phase === 'failed' ? (job.error || 'Generation failed.') : '',
        });
        if (phase === 'completed' && job.asset) onJobSettled({ projectId: state.jobProjectId, job });
    }

    function missingResumedJob(error, jobId) {
        if (error.status !== 404 || !state.resumed) return false;
        enterUncertain({ jobId, message: `The earlier generation is no longer available (job ${jobId}). This does not prove nothing was generated; it may still have been billed. Operator review is needed before generating this request again.` });
        set({ resumed: false, checkFailed: false, error: '' });
        return true;
    }

    async function pollOnce(jobId, myEpoch) {
        if (!currentJob(jobId, myEpoch)) return;
        timer = null;
        if (statusRead?.epoch === myEpoch && statusRead.jobId === jobId) return;
        const operation = { epoch: myEpoch, jobId };
        statusRead = operation;
        try {
            const value = await api.status(jobId);
            if (!currentJob(jobId, myEpoch) || value?.job?.jobId !== jobId) return;
            applyJob(value.job, { polled: true });
        } catch (error) {
            if (!currentJob(jobId, myEpoch)) return;
            if (isAuthError(error)) { authLost(); return; }
            if (missingResumedJob(error, jobId)) return;
            stopPolling();
            set({ checkFailed: true, error: error.message });
        } finally {
            if (statusRead === operation) statusRead = null;
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
            if (state.phase === 'idle' && !state.jobId && !state.authLost) {
                const uncertain = loadPointer(uncertainty);
                if (uncertain) {
                    set({ jobProjectId: uncertain.projectId });
                    enterUncertain({ jobId: uncertain.jobId, message: UNKNOWN_MESSAGE });
                    return;
                }
                const saved = loadPointer(resume);
                if (saved) {
                    set({
                        phase: 'running', jobId: saved.jobId, jobProjectId: saved.projectId, resumed: true,
                        notice: { kind: 'resumed', message: 'Resuming your in-progress generation…' },
                    });
                    pollStartedAt = now();
                    pollDelay = POLL_INTERVAL_MS;
                    await pollOnce(saved.jobId, myEpoch);
                }
            }
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
        const myEpoch = ++epoch;
        stopPolling();
        const input = buildInput(model, state.values);
        const projectId = state.projectId;
        set({
            phase: 'quoting', error: '', fieldErrors: {}, notice: null, uncertain: null,
            job: null, jobId: '', resumed: false, cancelRequested: false, checkFailed: false, deadlineReached: false,
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
        const myEpoch = ++epoch;
        set({ phase: 'submitting', error: '', notice: null, jobProjectId: quote.projectId });
        // Persist the possible outcome before dispatch: navigation can discard a late answer.
        saveUncertainty();
        try {
            const value = await api.generate({
                model: quote.modelId, input: quote.input, projectId: quote.projectId, quoteToken: quote.quoteToken,
            });
            if (myEpoch !== epoch) return;
            if (!validJob(value?.job)) {
                enterUncertain({ jobId: null, message: UNKNOWN_MESSAGE }); return;
            }
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
                    saveResume(error.jobId);
                    startPolling(error.jobId);
                } else {
                    enterUncertain({
                        jobId: error.jobId,
                        message: `The generation was accepted (job ${error.jobId}) but its record could not be confirmed, so progress cannot be tracked. It may be billed. Operator review is needed before generating this request again.`,
                    });
                }
            } else if (error.generationAccepted || error.outcomeUnknown) {
                enterUncertain({ jobId: null, message: UNKNOWN_MESSAGE });
            } else {
                clearUncertainty();
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
        const myEpoch = epoch;
        if (statusRead?.epoch === myEpoch && statusRead.jobId === jobId) return;
        const operation = { epoch: myEpoch, jobId };
        statusRead = operation;
        stopPolling();
        inFlight = true;
        try {
            const value = await api.status(jobId);
            if (!currentJob(jobId, myEpoch) || value?.job?.jobId !== jobId) return;
            applyJob(value.job);
        } catch (error) {
            if (!currentJob(jobId, myEpoch)) return;
            if (isAuthError(error)) { authLost(); return; }
            if (missingResumedJob(error, jobId)) return;
            if (state.phase === 'uncertain') {
                const message = error.status === 404
                    ? `Job ${jobId} is not recorded on the server. That does not prove nothing was generated; it may still have been billed. Operator review is needed before generating this request again.`
                    : `${state.uncertain.baseMessage ?? state.uncertain.message} (Status check failed: ${error.message})`;
                set({ uncertain: { ...state.uncertain, message } });
            } else {
                set({ checkFailed: true, error: error.message });
            }
        } finally {
            if (statusRead === operation) statusRead = null;
            inFlight = false;
        }
    }

    async function cancel() {
        if (state.phase !== 'running' || !state.jobId) return;
        const myEpoch = epoch;
        const jobId = state.jobId;
        if (cancelling?.epoch === myEpoch && cancelling.jobId === jobId) return;
        const operation = { epoch: myEpoch, jobId };
        cancelling = operation;
        try {
            const value = await api.cancel(jobId);
            if (!currentJob(jobId, myEpoch) || value?.job?.jobId !== jobId) return;
            applyJob(value.job, { polled: true });
            if (state.phase === 'running') {
                set({ cancelRequested: true, notice: { kind: 'cancel-requested', message: 'Cancel requested. Waiting for the provider to confirm.' } });
            }
        } catch (error) {
            if (!currentJob(jobId, myEpoch)) return;
            if (isAuthError(error)) { authLost(); return; }
            set({ error: error.message, ...(error.code === 'invalid_job_reply' ? { checkFailed: true } : {}) });
        } finally {
            if (cancelling === operation) cancelling = null;
        }
    }

    function acknowledge() {
        if (state.phase !== 'uncertain') return;
        clearResume();
        clearUncertainty();
        set({ phase: 'idle', resumed: false, uncertain: { ...state.uncertain, acknowledged: true } });
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


export async function fetchSessionUserId({ fetchImpl = (...args) => globalThis.fetch(...args) } = {}) {
    try {
        const response = await fetchImpl('/api/auth/session', { credentials: 'same-origin', cache: 'no-store' });
        if (response.status === 401) return '';
        if (!response.ok) return null;
        const value = await response.json();
        if (value?.authenticated === false) return '';
        if (value?.authenticated !== true) return null;
        const id = value?.user?.id;
        if (typeof id === 'string' && id.trim()) return id;
        if (typeof id === 'number' && Number.isFinite(id)) return String(id);
        return null;
    } catch {
        return null;
    }
}
