import { randomUUID } from 'node:crypto';

import {
    estimateReplicateUsd,
    getReplicateModel,
    validateReplicateInput,
} from './replicateModelRegistry.js';

export const REPLICATE_IMAGE_TOOL_ID = 'replicate_image';
export const REPLICATE_VIDEO_TOOL_ID = 'replicate_video';

const API_BASE = 'https://api.replicate.com/v1';
const CANCEL_AFTER = '10m';
const MAX_PROVIDER_JSON_BYTES = 2 * 1024 * 1024;
const PREDICTION_ID_PATTERN = /^[a-z0-9]{8,40}$/;
const STATUS = Object.freeze({
    starting: 'queued',
    processing: 'processing',
    succeeded: 'completed',
    failed: 'failed',
    canceled: 'canceled',
    aborted: 'canceled',
});

function normalizedString(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function configuredToken(value) {
    const key = normalizedString(value);
    if (!/^[\x21-\x7E]{8,4096}$/.test(key)) return false;
    return !/^(?:<.*>|change-?me|placeholder|your[-_]?api[-_]?token)$/i.test(key);
}

function boundedNumber(value, fallback, minimum, maximum) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(maximum, Math.max(minimum, parsed));
}

function safeText(value, secrets = []) {
    if (typeof value !== 'string') return '';
    let text = value.replace(/[\u0000-\u001F\u007F]/g, ' ');
    for (const secret of secrets) {
        if (typeof secret === 'string' && secret.length >= 3) text = text.split(secret).join('[redacted]');
    }
    return text.replace(/\br8_[A-Za-z0-9_-]{8,}\b/g, '[redacted]').trim().slice(0, 400);
}

export function replicateConfiguration(env = process.env) {
    const requestedMode = normalizedString(env.GENERATION_MODE).toLowerCase() === 'live' ? 'live' : 'mock';
    const liveEnabled = normalizedString(env.REPLICATE_LIVE_ENABLED).toLowerCase() === 'true';
    const apiKey = normalizedString(env.REPLICATE_API_TOKEN);
    const missing = [];
    if (requestedMode === 'live') {
        if (!liveEnabled) missing.push('REPLICATE_LIVE_ENABLED=true');
        if (!configuredToken(apiKey)) missing.push('REPLICATE_API_TOKEN');
    }
    const live = requestedMode === 'live' && missing.length === 0;
    return {
        mode: live ? 'live' : (requestedMode === 'mock' ? 'mock' : 'unconfigured'),
        requestedMode,
        live,
        configured: requestedMode === 'mock' || live,
        missing,
        apiKey: live ? apiKey : '',
        maxUsdPerJob: boundedNumber(env.REPLICATE_MAX_USD_PER_JOB, 1, 0.01, 100),
        maxUsdPerDay: boundedNumber(env.REPLICATE_MAX_USD_PER_DAY, 5, 0.01, 1000),
        jobTimeoutMs: boundedNumber(env.REPLICATE_JOB_TIMEOUT_MS, 20 * 60 * 1000, 60 * 1000, 30 * 60 * 1000),
    };
}

export function replicateProviderStatus(env = process.env) {
    const config = replicateConfiguration(env);
    const label = config.mode === 'live'
        ? 'Live · paid generation enabled'
        : config.mode === 'mock'
            ? 'Mock · no spend'
            : 'Setup Required';
    return {
        id: 'replicate',
        label: 'Replicate',
        capability: 'Image, image-edit and video generation',
        toolIds: [REPLICATE_IMAGE_TOOL_ID, REPLICATE_VIDEO_TOOL_ID],
        configured: config.configured,
        status: label,
        mode: config.mode,
    };
}

export function prepareReplicateRequest({ modelId, input }, { env = process.env, assetUrl } = {}) {
    const config = replicateConfiguration(env);
    if (!config.configured) {
        return { ok: false, status: 503, error: 'Replicate is not configured.', missing: config.missing };
    }
    const model = getReplicateModel(modelId);
    if (!model || !model.enabled) return { ok: false, status: 400, error: 'Unknown or disabled model.' };
    const checked = validateReplicateInput(model, input, { assetUrl });
    if (checked.error) return { ok: false, status: 400, error: checked.error };
    return {
        ok: true,
        model,
        input: checked.value,
        estimateUsd: estimateReplicateUsd(model, checked.value),
        config,
    };
}

async function fetchWithTimeout(fetchImpl, url, options, timeoutMs) {
    try {
        return await fetchImpl(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
        const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
        return { networkError: timedOut ? 'timeout' : 'unavailable' };
    }
}

async function readJson(response) {
    const raw = await response.text();
    if (new TextEncoder().encode(raw).byteLength > MAX_PROVIDER_JSON_BYTES) return { error: 'too_large' };
    try {
        return { value: JSON.parse(raw) };
    } catch {
        return { error: 'invalid' };
    }
}

function networkFailure(result) {
    return {
        ok: false,
        status: result.networkError === 'timeout' ? 504 : 502,
        error: result.networkError === 'timeout' ? 'Replicate request timed out.' : 'Replicate is temporarily unavailable.',
        retryable: true,
    };
}

function providerFailure(response, value, apiKey) {
    const detail = safeText(value?.detail || value?.title || '', [apiKey]);
    const extra = detail ? { detail } : {};
    if (response.status === 401 || response.status === 403) {
        return { ok: false, status: 502, error: 'Replicate rejected the configured API credentials.', retryable: false };
    }
    if (response.status === 402) {
        return { ok: false, status: 402, error: 'Replicate account has insufficient credit.', retryable: false };
    }
    if (response.status === 429) {
        return { ok: false, status: 429, error: 'Replicate rate limit reached.', retryable: true, ...extra };
    }
    if ([400, 404, 409, 422].includes(response.status)) {
        return { ok: false, status: 422, error: 'Replicate rejected the generation request.', retryable: false, ...extra };
    }
    return { ok: false, status: 502, error: 'Replicate is temporarily unavailable.', retryable: true, ...extra };
}

function firstOutputUrl(output) {
    const candidate = Array.isArray(output) ? output[0] : output;
    if (typeof candidate !== 'string' || candidate.length > 4096) return null;
    try {
        const parsed = new URL(candidate);
        return parsed.protocol === 'https:' && !parsed.username && !parsed.password ? parsed.toString() : null;
    } catch {
        return null;
    }
}

function toolIdFor(model) {
    return model.kind === 'image' ? REPLICATE_IMAGE_TOOL_ID : REPLICATE_VIDEO_TOOL_ID;
}

function publicJob(model, value, apiKey) {
    const id = normalizedString(value?.id);
    let status = STATUS[normalizedString(value?.status).toLowerCase()] || 'queued';
    const outputUrl = status === 'completed' ? firstOutputUrl(value?.output) : null;
    let error = null;
    if (status === 'completed' && !outputUrl) {
        status = 'failed';
        error = 'Replicate finished without a usable output.';
    } else if (status === 'failed') {
        error = safeText(value?.error, [apiKey]) || 'Replicate generation failed.';
    }
    return {
        provider: 'replicate',
        toolId: toolIdFor(model),
        kind: model.kind,
        jobId: PREDICTION_ID_PATTERN.test(id) ? id : null,
        status,
        outputUrl,
        model: model.id,
        mode: 'live',
        mock: false,
        error,
    };
}

export async function submitReplicateJob(prepared, {
    env = process.env,
    fetchImpl = fetch,
    idGenerator = randomUUID,
    timeoutMs = 30_000,
} = {}) {
    const { model, input, config } = prepared;
    if (config.mode === 'mock') {
        return {
            ok: true,
            status: 200,
            job: {
                provider: 'replicate',
                toolId: toolIdFor(model),
                kind: model.kind,
                jobId: `mock_${idGenerator()}`,
                status: 'completed',
                outputUrl: null,
                model: model.id,
                mode: 'mock',
                mock: true,
                error: null,
            },
        };
    }
    const liveConfig = replicateConfiguration(env);
    if (!liveConfig.live) {
        return { ok: false, status: 503, error: 'Replicate is not configured.', missing: liveConfig.missing };
    }
    const result = await fetchWithTimeout(fetchImpl, `${API_BASE}/models/${model.id}/predictions`, {
        method: 'POST',
        headers: {
            authorization: `Bearer ${liveConfig.apiKey}`,
            'content-type': 'application/json',
            'cancel-after': CANCEL_AFTER,
        },
        body: JSON.stringify({ input }),
    }, timeoutMs);
    if (result.networkError) return networkFailure(result);
    const decoded = await readJson(result);
    if (decoded.error) return { ok: false, status: 502, error: 'Replicate returned an invalid response.', retryable: true };
    if (!result.ok) return providerFailure(result, decoded.value, liveConfig.apiKey);
    const job = publicJob(model, decoded.value, liveConfig.apiKey);
    if (!job.jobId) return { ok: false, status: 502, error: 'Replicate returned no valid prediction ID.' };
    return { ok: true, status: job.status === 'completed' ? 200 : 202, job };
}

async function predictionRequest({ jobId, modelId }, suffix, method, { env, fetchImpl, timeoutMs }) {
    const config = replicateConfiguration(env);
    if (!config.live) {
        return { ok: false, status: 503, error: 'Replicate is not configured.', missing: config.missing, retryable: false };
    }
    const model = getReplicateModel(modelId);
    if (!model) return { ok: false, status: 400, error: 'Unknown model.', retryable: false };
    if (typeof jobId !== 'string' || !PREDICTION_ID_PATTERN.test(jobId)) {
        return { ok: false, status: 400, error: 'A valid Replicate prediction ID is required.', retryable: false };
    }
    const result = await fetchWithTimeout(fetchImpl, `${API_BASE}/predictions/${jobId}${suffix}`, {
        method,
        headers: { authorization: `Bearer ${config.apiKey}` },
    }, timeoutMs);
    if (result.networkError) return networkFailure(result);
    const decoded = await readJson(result);
    if (decoded.error) return { ok: false, status: 502, error: 'Replicate returned an invalid response.', retryable: true };
    if (!result.ok) return providerFailure(result, decoded.value, config.apiKey);
    return { ok: true, status: 200, job: publicJob(model, decoded.value, config.apiKey) };
}

export function getReplicateJob(ref, { env = process.env, fetchImpl = fetch, timeoutMs = 30_000 } = {}) {
    return predictionRequest(ref, '', 'GET', { env, fetchImpl, timeoutMs });
}

export function cancelReplicateJob(ref, { env = process.env, fetchImpl = fetch, timeoutMs = 30_000 } = {}) {
    return predictionRequest(ref, '/cancel', 'POST', { env, fetchImpl, timeoutMs });
}
