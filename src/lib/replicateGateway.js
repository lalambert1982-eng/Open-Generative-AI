import { randomUUID } from 'node:crypto';

import { authorizeCreatorRequest, creatorJson, parseCreatorJson } from './creatorProviderGateway.js';
import {
    CreatorProjectError,
    defaultBlobStore,
    getCreatorProject,
    safeCreatorAssetUrl,
} from './creatorProjectStore.js';
import {
    GenerationGuardError,
    generationOwnerKey,
    issueQuote,
    loadJobRecord,
    refundSpend,
    releaseGeneration,
    reserveGeneration,
    saveJobRecord,
} from './generationGuard.js';
import { listReplicateModels } from './replicateModelRegistry.js';
import { PersistError, persistGeneratedAsset } from './replicatePersist.js';
import {
    cancelReplicateJob,
    getReplicateJob,
    prepareReplicateRequest,
    replicateConfiguration,
    replicateProviderStatus,
    submitReplicateJob,
} from './replicateProvider.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TERMINAL = new Set(['completed', 'failed', 'canceled']);
const jobQueues = new WeakMap();

// Read the record inside the queue so overlapping polls/cancels cannot persist
// or refund the same job twice within this process. Blob is not a distributed lock.
async function withJobOperation(user, jobId, { env, blobStore }, operation) {
    let queues = jobQueues.get(blobStore);
    if (!queues) {
        queues = new Map();
        jobQueues.set(blobStore, queues);
    }
    const key = `${generationOwnerKey(user, env)}:${jobId}`;
    const previous = queues.get(key) || Promise.resolve();
    const next = previous.catch(() => {}).then(operation);
    queues.set(key, next);
    try {
        return await next;
    } finally {
        if (queues.get(key) === next) queues.delete(key);
    }
}

function errorResponse(error) {
    if (error instanceof GenerationGuardError || error instanceof CreatorProjectError || error instanceof PersistError) {
        return creatorJson({ error: error.message, code: error.code }, error.status);
    }
    return creatorJson({ error: 'Generation request failed.' }, 500);
}

function clientJob(record) {
    return {
        provider: 'replicate',
        toolId: record.kind === 'image' ? 'replicate_image' : 'replicate_video',
        kind: record.kind,
        jobId: record.jobId,
        status: record.status,
        model: record.model,
        mode: record.mock ? 'mock' : 'live',
        mock: record.mock,
        error: record.error || null,
        estimateUsd: record.estimateUsd,
        asset: record.asset || null,
    };
}

function failureResponse(result) {
    return creatorJson({
        error: result.error,
        ...(result.missing ? { missing: result.missing } : {}),
        ...(result.retryable !== undefined ? { retryable: result.retryable } : {}),
        ...(result.outcomeUnknown !== undefined ? { outcomeUnknown: result.outcomeUnknown } : {}),
    }, result.status || 502);
}

function assetUrlChecker(env) {
    return (value) => safeCreatorAssetUrl(value, { env });
}

async function authedJson(request, { env, action }) {
    const auth = authorizeCreatorRequest(request, { env, action });
    if (auth.response) return { response: auth.response };
    const parsed = await parseCreatorJson(request, { env });
    if (parsed.response) return { response: parsed.response };
    return { user: auth.user, body: parsed.value };
}

export async function handleReplicateModels(request, { env = process.env } = {}) {
    const auth = authorizeCreatorRequest(request, { env, action: 'replicate-models', statusRequest: true });
    if (auth.response) return auth.response;
    const config = replicateConfiguration(env);
    return creatorJson({
        mode: config.mode,
        provider: replicateProviderStatus(env),
        limits: { maxUsdPerJob: config.maxUsdPerJob, maxUsdPerDay: config.maxUsdPerDay },
        models: listReplicateModels(),
    });
}

export async function handleReplicateQuote(request, { env = process.env } = {}) {
    const ctx = await authedJson(request, { env, action: 'replicate-quote' });
    if (ctx.response) return ctx.response;
    const prepared = prepareReplicateRequest(
        { modelId: ctx.body.model, input: ctx.body.input },
        { env, assetUrl: assetUrlChecker(env) },
    );
    if (!prepared.ok) return failureResponse(prepared);
    try {
        const quote = issueQuote({
            user: ctx.user,
            env,
            modelId: prepared.model.id,
            input: prepared.input,
            estimateUsd: prepared.estimateUsd,
        });
        return creatorJson({
            estimateUsd: prepared.estimateUsd,
            display: prepared.model.pricing.display,
            quoteToken: quote.token,
            expiresAt: quote.expiresAt,
            mode: prepared.config.mode,
            maxUsdPerJob: prepared.config.maxUsdPerJob,
        });
    } catch (error) {
        return errorResponse(error);
    }
}

const PERSIST_ATTEMPTS = 3;

// Overlapping polls can both reach the Asset write; the Project store rejects
// the loser with `project_conflict`. Retrying is safe because the stored path
// and URL are deterministic per job, so the retry finds the winner's Asset.
async function persistIfComplete(user, record, outputUrl, { env, fetchImpl, blobStore, assetBlobStore, now }) {
    for (let attempt = 1; ; attempt += 1) {
        try {
            const { asset } = await persistGeneratedAsset({
                user,
                projectId: record.projectId,
                record,
                outputUrl,
                env,
                fetchImpl,
                assetBlobStore,
                blobStore,
                now,
            });
            return { id: asset.id, url: asset.url, type: asset.type };
        } catch (error) {
            const conflict = error instanceof CreatorProjectError && error.code === 'project_conflict';
            if (!conflict || attempt >= PERSIST_ATTEMPTS) throw error;
        }
    }
}

export async function handleReplicateGenerate(request, {
    env = process.env,
    fetchImpl = fetch,
    blobStore = defaultBlobStore,
    assetBlobStore = defaultBlobStore,
    now = Date.now(),
    idGenerator = randomUUID,
} = {}) {
    const ctx = await authedJson(request, { env, action: 'replicate-generate' });
    if (ctx.response) return ctx.response;
    const { user, body } = ctx;

    const projectId = typeof body.projectId === 'string' ? body.projectId.trim() : '';
    if (!UUID_PATTERN.test(projectId)) return creatorJson({ error: 'A valid Project ID is required.' }, 400);

    const prepared = prepareReplicateRequest(
        { modelId: body.model, input: body.input },
        { env, assetUrl: assetUrlChecker(env) },
    );
    if (!prepared.ok) return failureResponse(prepared);

    let reservation;
    try {
        await getCreatorProject(user, projectId, { env, blobStore });
        reservation = await reserveGeneration({
            user,
            env,
            blobStore,
            mode: prepared.config.mode,
            modelId: prepared.model.id,
            input: prepared.input,
            estimateUsd: prepared.estimateUsd,
            quoteToken: body.quoteToken,
            limits: { maxUsdPerJob: prepared.config.maxUsdPerJob, maxUsdPerDay: prepared.config.maxUsdPerDay },
            now,
        });
    } catch (error) {
        return errorResponse(error);
    }

    const submitted = await submitReplicateJob(prepared, { env, fetchImpl, idGenerator });
    if (!submitted.ok) {
        if (submitted.outcomeUnknown !== true) {
            await releaseGeneration({ user, env, blobStore, reservation, now }).catch(() => {});
        }
        return failureResponse(submitted);
    }

    const job = submitted.job;
    const record = {
        jobId: job.jobId,
        model: job.model,
        kind: job.kind,
        mock: job.mock,
        status: job.status,
        projectId,
        userId: String(user.id),
        prompt: String(prepared.input.prompt).slice(0, 200),
        estimateUsd: prepared.estimateUsd,
        ledgerDay: reservation.ledgerDay,
        refunded: false,
        asset: null,
        error: null,
        createdAt: now,
        updatedAt: now,
    };
    try {
        await saveJobRecord(user, record, { env, blobStore });
        if (job.mock) {
            record.asset = await persistIfComplete(user, record, null, { env, fetchImpl, blobStore, assetBlobStore, now });
            record.updatedAt = now;
            await saveJobRecord(user, record, { env, blobStore });
        }
    } catch (error) {
        return errorResponse(error);
    }
    return creatorJson({ job: clientJob(record) }, job.mock ? 200 : 202);
}

async function settle(user, record, providerJob, { env, fetchImpl, blobStore, assetBlobStore, now }) {
    const next = { ...record, status: providerJob.status, updatedAt: now };
    if (providerJob.status === 'completed' && !record.asset) {
        try {
            next.asset = await persistIfComplete(user, next, providerJob.outputUrl, { env, fetchImpl, blobStore, assetBlobStore, now });
        } catch (error) {
            if (!(error instanceof PersistError) || error.status === 503) throw error;
            next.status = 'failed';
            next.error = error.message;
        }
    } else if (providerJob.status === 'failed') {
        next.error = providerJob.error || 'Generation failed.';
    }
    if ((next.status === 'failed' || next.status === 'canceled') && !next.refunded) {
        await refundSpend({ user, env, blobStore, ledgerDay: next.ledgerDay, estimateUsd: next.estimateUsd });
        next.refunded = true;
    }
    await saveJobRecord(user, next, { env, blobStore });
    return next;
}

export async function handleReplicateStatus(request, {
    env = process.env,
    fetchImpl = fetch,
    blobStore = defaultBlobStore,
    assetBlobStore = defaultBlobStore,
    now = Date.now(),
} = {}) {
    const auth = authorizeCreatorRequest(request, { env, action: 'replicate-status', statusRequest: true });
    if (auth.response) return auth.response;
    const jobId = new URL(request.url).searchParams.get('id') || '';
    try {
        return await withJobOperation(auth.user, jobId, { env, blobStore }, async () => {
            const record = await loadJobRecord(auth.user, jobId, { env, blobStore });
            if (!record) return creatorJson({ error: 'Generation job not found.' }, 404);
            if (TERMINAL.has(record.status) && (record.asset || record.status !== 'completed')) {
                return creatorJson({ job: clientJob(record) });
            }
            if (record.mock) return creatorJson({ job: clientJob(record) });

            const config = replicateConfiguration(env);
            const timedOut = now - record.createdAt > config.jobTimeoutMs;
            const polled = timedOut
                ? await cancelReplicateJob({ jobId, modelId: record.model }, { env, fetchImpl })
                : await getReplicateJob({ jobId, modelId: record.model }, { env, fetchImpl });
            if (!polled.ok) return failureResponse(polled);
            const providerJob = timedOut && !TERMINAL.has(polled.job.status)
                ? { ...polled.job, status: 'failed', error: 'Generation timed out.' }
                : polled.job;
            const next = await settle(auth.user, record, providerJob, { env, fetchImpl, blobStore, assetBlobStore, now });
            return creatorJson({ job: clientJob(next) });
        });
    } catch (error) {
        return errorResponse(error);
    }
}

export async function handleReplicateCancel(request, {
    env = process.env,
    fetchImpl = fetch,
    blobStore = defaultBlobStore,
    assetBlobStore = defaultBlobStore,
    now = Date.now(),
} = {}) {
    const ctx = await authedJson(request, { env, action: 'replicate-cancel' });
    if (ctx.response) return ctx.response;
    try {
        return await withJobOperation(ctx.user, String(ctx.body.id ?? ''), { env, blobStore }, async () => {
            const record = await loadJobRecord(ctx.user, String(ctx.body.id ?? ''), { env, blobStore });
            if (!record) return creatorJson({ error: 'Generation job not found.' }, 404);
            if (TERMINAL.has(record.status) || record.mock) return creatorJson({ job: clientJob(record) });
            const cancelled = await cancelReplicateJob({ jobId: record.jobId, modelId: record.model }, { env, fetchImpl });
            if (!cancelled.ok) return failureResponse(cancelled);
            const next = await settle(ctx.user, record, cancelled.job, { env, fetchImpl, blobStore, assetBlobStore, now });
            return creatorJson({ job: clientJob(next) });
        });
    } catch (error) {
        return errorResponse(error);
    }
}
