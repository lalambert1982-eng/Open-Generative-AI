import { evaluateJsonSafety } from './contentSafety.js';
import { authorizeCreatorRequest, creatorJson } from './creatorProviderGateway.js';
import { addCreatorAsset, safeCreatorAssetUrl } from './creatorProjectStore.js';
import { muapiConfiguration } from './muapiCreatorProvider.js';
import { buildMuapiUrl } from './muapiProxy.js';
import {
    CreatorWorkflowError,
    getCreatorWorkflowRun,
    getCreatorWorkflowRunRecord,
    listCreatorWorkflowRuns,
    prepareCreatorWorkflowRun,
    retryCreatorWorkflowRun,
    updateCreatorWorkflowRun,
} from './creatorWorkflowStore.js';

const MAX_REQUEST_BYTES = 128 * 1024;
const MAX_PROVIDER_BYTES = 4 * 1024 * 1024;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,139}$/;
const FORBIDDEN_CLIENT_FIELDS = new Set([
    'apiKey',
    'api_key',
    'x-api-key',
    'authorization',
    'providerRunId',
    'provider_run_id',
]);
const ROUTE_FIELDS = Object.freeze({
    prepare: new Set(['projectId', 'workflowId', 'inputs', 'storyboardSceneIds']),
    run: new Set(['projectId', 'runId', 'confirm']),
    retry: new Set(['projectId', 'runId']),
    cancel: new Set(['projectId', 'runId']),
});

function normalized(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function safeProviderText(value, secrets = []) {
    if (typeof value !== 'string') return '';
    let output = value
        .replace(/[\u0000-\u001F\u007F]/g, ' ')
        .replace(/\b(?:sk|xi|key)-[A-Za-z0-9_-]{8,}\b/gi, '[redacted]');
    for (const secret of secrets) {
        if (typeof secret === 'string' && secret.length >= 3) output = output.split(secret).join('[redacted]');
    }
    return output.trim().slice(0, 400);
}

function providerMessage(value, secrets) {
    return safeProviderText(
        value?.error?.message ||
        value?.error?.detail ||
        value?.error ||
        value?.detail ||
        value?.message ||
        '',
        secrets,
    );
}

function assertAllowedFields(value, route) {
    const allowed = ROUTE_FIELDS[route];
    if (!allowed) return;
    for (const key of Object.keys(value)) {
        if (FORBIDDEN_CLIENT_FIELDS.has(key)) {
            throw new CreatorWorkflowError('workflow_provider_field_forbidden', 'Provider credentials and provider run IDs are server-managed.', 403);
        }
        if (!allowed.has(key)) {
            throw new CreatorWorkflowError('unknown_workflow_field', `Unknown Workflow request field: ${key}.`);
        }
    }
}

async function parseJson(request, env, route) {
    const declared = Number(request.headers.get('content-length') || 0);
    if (declared > MAX_REQUEST_BYTES) throw new CreatorWorkflowError('workflow_request_too_large', 'Workflow request is too large.', 413);
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > MAX_REQUEST_BYTES) {
        throw new CreatorWorkflowError('workflow_request_too_large', 'Workflow request is too large.', 413);
    }
    let value;
    try {
        value = JSON.parse(raw);
    } catch {
        throw new CreatorWorkflowError('invalid_workflow_json', 'A valid JSON Workflow request body is required.');
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new CreatorWorkflowError('invalid_workflow_json', 'Workflow request must be a JSON object.');
    }
    const safety = evaluateJsonSafety(raw, { env });
    if (!safety.allowed) {
        throw new CreatorWorkflowError('content_safety', 'Workflow request was blocked by the content safety policy.', 422);
    }
    assertAllowedFields(value, route);
    return value;
}

function providerConfiguration(env) {
    const configuration = muapiConfiguration(env);
    if (!configuration.configured) {
        throw new CreatorWorkflowError(
            'workflow_provider_unconfigured',
            'MuAPI Workflow execution is not configured for this environment.',
            503,
        );
    }
    return configuration;
}

async function providerJson(fetchImpl, url, options, configuration, timeoutMs = 60_000) {
    let response;
    try {
        response = await fetchImpl(url, {
            ...options,
            headers: {
                'content-type': 'application/json',
                'x-api-key': configuration.apiKey,
                ...(options.headers || {}),
            },
            redirect: 'error',
            signal: AbortSignal.timeout(timeoutMs),
        });
    } catch (error) {
        const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
        throw new CreatorWorkflowError(
            timedOut ? 'workflow_provider_timeout' : 'workflow_provider_unavailable',
            timedOut ? 'MuAPI Workflow request timed out.' : 'MuAPI Workflow service is temporarily unavailable.',
            timedOut ? 504 : 502,
        );
    }

    const raw = await response.text();
    if (new TextEncoder().encode(raw).byteLength > MAX_PROVIDER_BYTES) {
        throw new CreatorWorkflowError('workflow_provider_invalid_response', 'MuAPI Workflow returned an oversized response.', 502);
    }
    let value;
    try {
        value = raw ? JSON.parse(raw) : {};
    } catch {
        throw new CreatorWorkflowError('workflow_provider_invalid_response', 'MuAPI Workflow returned an invalid response.', 502);
    }
    if (!response.ok) {
        const detail = providerMessage(value, [configuration.apiKey]);
        if (response.status === 401 || response.status === 403) {
            throw new CreatorWorkflowError('workflow_provider_credentials', 'MuAPI rejected the configured Workflow credentials.', 502);
        }
        if (response.status === 429) {
            throw new CreatorWorkflowError('workflow_provider_rate_limit', detail || 'MuAPI Workflow rate or account limit was reached.', 429);
        }
        if ([400, 404, 409, 422].includes(response.status)) {
            throw new CreatorWorkflowError('workflow_provider_rejected', detail || 'MuAPI rejected the Workflow request.', 422);
        }
        throw new CreatorWorkflowError('workflow_provider_unavailable', detail || 'MuAPI Workflow service is temporarily unavailable.', 502);
    }
    return value;
}

function providerRunId(value) {
    const id = normalized(value?.run_id || value?.runId || value?.id || value?.data?.run_id || value?.data?.id);
    return OPAQUE_ID_PATTERN.test(id) ? id : '';
}

function normalizeProviderStatus(value, { hasOutputs = false, hasRunId = false } = {}) {
    if (hasOutputs) return 'completed';
    const status = normalized(value).toLowerCase();
    if (['completed', 'succeeded', 'success', 'done'].includes(status)) return 'completed';
    if (['failed', 'error'].includes(status)) return 'failed';
    if (['cancelled', 'canceled'].includes(status)) return 'cancelled';
    if (['processing', 'running', 'in_progress', 'in-progress'].includes(status)) return 'running';
    if (['queued', 'pending', 'waiting', 'created'].includes(status)) return 'queued';
    return hasRunId ? 'queued' : 'running';
}

function collectOutputUrls(value, env, output = [], depth = 0) {
    if (depth > 6 || output.length >= 20 || value == null) return output;
    if (typeof value === 'string') {
        if (!value.startsWith('https://')) return output;
        try {
            const safe = safeCreatorAssetUrl(value, { env });
            if (!output.includes(safe)) output.push(safe);
        } catch {
            // Ignore non-media or unapproved provider URLs.
        }
        return output;
    }
    if (Array.isArray(value)) {
        for (const item of value) collectOutputUrls(item, env, output, depth + 1);
        return output;
    }
    if (typeof value === 'object') {
        const preferred = ['url', 'output_url', 'video_url', 'image_url', 'audio_url', 'outputs', 'output', 'data', 'results'];
        for (const key of preferred) {
            if (Object.hasOwn(value, key)) collectOutputUrls(value[key], env, output, depth + 1);
        }
    }
    return output;
}

function inferAssetType(url) {
    let pathname = '';
    try { pathname = new URL(url).pathname.toLowerCase(); } catch { return 'upload'; }
    if (/\.(?:mp4|webm|mov|m4v)$/.test(pathname)) return 'video';
    if (/\.(?:png|jpe?g|webp|gif|avif)$/.test(pathname)) return 'image';
    if (/\.(?:mp3|wav|ogg|m4a|aac)$/.test(pathname)) return 'audio';
    return 'upload';
}

function extractNodeStates(value) {
    const source = Array.isArray(value?.node_runs)
        ? value.node_runs
        : Array.isArray(value?.nodeRuns)
            ? value.nodeRuns
            : Array.isArray(value?.nodes)
                ? value.nodes
                : Array.isArray(value?.steps)
                    ? value.steps
                    : [];
    return source.slice(0, 200).map((node, index) => ({
        id: normalized(node?.node_id || node?.nodeId || node?.id) || `node-${index + 1}`,
        status: normalizeProviderStatus(node?.status, { hasOutputs: collectOutputUrls(node, {}, []).length > 0 }),
        error: normalized(node?.error || node?.message).slice(0, 400),
    }));
}

async function registerOutputs(user, run, value, {
    env,
    blobStore,
    now,
    assetIdGenerator,
}) {
    const urls = collectOutputUrls(value, env);
    const assetIds = [];
    for (let index = 0; index < urls.length; index += 1) {
        const url = urls[index];
        const added = await addCreatorAsset(user, run.projectId, {
            type: inferAssetType(url),
            title: `Workflow output ${index + 1}`,
            url,
            source: 'workflow',
            provider: {
                provider: 'muapi',
                model: `workflow:${run.workflowId}`,
                requestId: run.providerRunId || undefined,
                keyMode: normalized(env.MUAPI_KEY_MODE).toLowerCase(),
            },
        }, {
            env,
            blobStore,
            now,
            ...(assetIdGenerator ? { idGenerator: assetIdGenerator } : {}),
        });
        if (!assetIds.includes(added.asset.id)) assetIds.push(added.asset.id);
    }
    return assetIds;
}

async function finalizeCompletedRun(user, run, value, options) {
    const outputAssetIds = await registerOutputs(user, run, value, options);
    return updateCreatorWorkflowRun(user, run.projectId, run.id, {
        status: 'completed',
        nodeStates: extractNodeStates(value),
        outputAssetIds,
        error: '',
        completedAt: new Date(options.now).toISOString(),
    }, options);
}

async function submitRun(user, input, options) {
    if (input.confirm !== true) {
        throw new CreatorWorkflowError('approval_required', 'Workflow execution requires explicit approval.', 403);
    }
    const run = await getCreatorWorkflowRunRecord(user, input.projectId, input.runId, options);
    if (run.status === 'completed') return { run: await getCreatorWorkflowRun(user, run.projectId, run.id, options), status: 200 };
    if (['queued', 'running'].includes(run.status)) {
        return { run: await getCreatorWorkflowRun(user, run.projectId, run.id, options), status: 202 };
    }
    if (run.status !== 'waiting_for_approval') {
        throw new CreatorWorkflowError('workflow_run_not_executable', 'This Workflow run must be retried before it can execute again.', 409);
    }

    const configuration = providerConfiguration(options.env);
    let value;
    try {
        value = await providerJson(
            options.fetchImpl,
            buildMuapiUrl('workflow', [run.workflowId, 'api-execute']),
            { method: 'POST', body: JSON.stringify({ inputs: run.inputs }) },
            configuration,
        );
    } catch (error) {
        await updateCreatorWorkflowRun(user, run.projectId, run.id, {
            status: 'failed',
            error: error.message,
            completedAt: new Date(options.now).toISOString(),
        }, options).catch(() => {});
        throw error;
    }

    const externalRunId = providerRunId(value);
    const outputs = collectOutputUrls(value, options.env);
    const status = normalizeProviderStatus(value?.status || value?.data?.status, {
        hasOutputs: outputs.length > 0,
        hasRunId: Boolean(externalRunId),
    });
    const timestamp = new Date(options.now).toISOString();
    const updated = await updateCreatorWorkflowRun(user, run.projectId, run.id, {
        status,
        providerRunId: externalRunId || null,
        nodeStates: extractNodeStates(value),
        approvedAt: timestamp,
        startedAt: timestamp,
        ...(status === 'failed' || status === 'cancelled' ? {
            error: providerMessage(value, [configuration.apiKey]) || 'Workflow execution failed.',
            completedAt: timestamp,
        } : {}),
    }, options);

    if (status === 'completed') {
        const record = await getCreatorWorkflowRunRecord(user, run.projectId, run.id, options);
        return { run: await finalizeCompletedRun(user, record, value, options), status: 200 };
    }
    if (!externalRunId) {
        const failed = await updateCreatorWorkflowRun(user, run.projectId, run.id, {
            status: 'failed',
            error: 'MuAPI returned no Workflow run ID.',
            completedAt: timestamp,
        }, options);
        return { run: failed, status: 502 };
    }
    return { run: updated, status: 202 };
}

async function refreshRun(user, projectId, runId, options) {
    const run = await getCreatorWorkflowRunRecord(user, projectId, runId, options);
    if (!['queued', 'running'].includes(run.status) || !run.providerRunId) {
        return getCreatorWorkflowRun(user, projectId, runId, options);
    }
    const configuration = providerConfiguration(options.env);
    let value;
    try {
        value = await providerJson(
            options.fetchImpl,
            buildMuapiUrl('workflow', ['run', run.providerRunId, 'api-outputs']),
            { method: 'GET' },
            configuration,
        );
    } catch (error) {
        if (['workflow_provider_timeout', 'workflow_provider_unavailable', 'workflow_provider_rate_limit'].includes(error.code)) {
            return getCreatorWorkflowRun(user, projectId, runId, options);
        }
        const failed = await updateCreatorWorkflowRun(user, projectId, runId, {
            status: 'failed',
            error: error.message,
            completedAt: new Date(options.now).toISOString(),
        }, options);
        return failed;
    }
    const outputs = collectOutputUrls(value, options.env);
    const status = normalizeProviderStatus(value?.status || value?.data?.status, {
        hasOutputs: outputs.length > 0,
        hasRunId: true,
    });
    if (status === 'completed') {
        return finalizeCompletedRun(user, run, value, options);
    }
    if (status === 'failed' || status === 'cancelled') {
        return updateCreatorWorkflowRun(user, projectId, runId, {
            status,
            nodeStates: extractNodeStates(value),
            error: providerMessage(value, [configuration.apiKey]) || `Workflow ${status}.`,
            completedAt: new Date(options.now).toISOString(),
        }, options);
    }
    return updateCreatorWorkflowRun(user, projectId, runId, {
        status,
        nodeStates: extractNodeStates(value),
    }, options);
}

function workflowFailure(error) {
    if (error instanceof CreatorWorkflowError) {
        return creatorJson({ error: error.message, code: error.code }, error.status);
    }
    return creatorJson({ error: 'Workflow execution is temporarily unavailable.' }, 503);
}

export async function handleCreatorWorkflowRoute(request, {
    path = [],
    method = request.method,
    env = process.env,
    blobStore,
    now = Date.now(),
    idGenerator,
    assetIdGenerator,
    fetchImpl = fetch,
} = {}) {
    const normalizedMethod = String(method || 'GET').toUpperCase();
    const action = `workflows-${normalizedMethod.toLowerCase()}-${path.slice(0, 4).join('-') || 'root'}`;
    const auth = authorizeCreatorRequest(request, {
        env,
        action,
        statusRequest: normalizedMethod === 'GET',
    });
    if (auth.response) return auth.response;

    const options = { env, blobStore, now, idGenerator, assetIdGenerator, fetchImpl };
    try {
        if (normalizedMethod === 'POST' && path.length === 1 && path[0] === 'prepare') {
            const input = await parseJson(request, env, 'prepare');
            const run = await prepareCreatorWorkflowRun(auth.user, input, options);
            return creatorJson({ run }, 201);
        }
        if (normalizedMethod === 'POST' && path.length === 1 && path[0] === 'run') {
            const input = await parseJson(request, env, 'run');
            const result = await submitRun(auth.user, input, options);
            return creatorJson({ run: result.run }, result.status);
        }
        if (normalizedMethod === 'POST' && path.length === 1 && path[0] === 'retry') {
            const input = await parseJson(request, env, 'retry');
            const run = await retryCreatorWorkflowRun(auth.user, input.projectId, input.runId, options);
            return creatorJson({ run }, 201);
        }
        if (normalizedMethod === 'POST' && path.length === 1 && path[0] === 'cancel') {
            const input = await parseJson(request, env, 'cancel');
            const run = await getCreatorWorkflowRunRecord(auth.user, input.projectId, input.runId, options);
            if (['queued', 'running'].includes(run.status)) {
                throw new CreatorWorkflowError(
                    'workflow_cancel_not_supported',
                    'This provider run is already submitted; upstream cancellation is not enabled for V1.',
                    409,
                );
            }
            if (run.status !== 'waiting_for_approval') {
                throw new CreatorWorkflowError('workflow_cancel_not_allowed', 'Only a prepared Workflow can be cancelled.', 409);
            }
            const cancelled = await updateCreatorWorkflowRun(auth.user, input.projectId, input.runId, {
                status: 'cancelled',
                error: '',
                completedAt: new Date(now).toISOString(),
            }, options);
            return creatorJson({ run: cancelled });
        }
        if (normalizedMethod === 'GET' && path.length === 2 && path[0] === 'list') {
            const runs = await listCreatorWorkflowRuns(auth.user, path[1], options);
            return creatorJson({ runs });
        }
        if (normalizedMethod === 'GET' && path.length === 3 && path[0] === 'status') {
            const run = await refreshRun(auth.user, path[1], path[2], options);
            return creatorJson({ run });
        }
        return creatorJson({ error: 'Creator Workflow route not found.' }, 404);
    } catch (error) {
        return workflowFailure(error);
    }
}
