import { createHmac, randomUUID } from 'node:crypto';

import { get as getBlob, list as listBlobs, put as putBlob } from '@vercel/blob';

import {
    CreatorProjectError,
    creatorProjectConfiguration,
    getCreatorProject,
} from './creatorProjectStore.js';

const WORKFLOW_ROOT = 'creator-workflow-runs';
const RUN_VERSION = 1;
const MAX_RUNS_PER_PROJECT = 100;
const MAX_INPUT_BYTES = 64 * 1024;
const MAX_RECORD_BYTES = 256 * 1024;
const MAX_SCENE_REFERENCES = 100;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,139}$/;
const INPUT_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9._-]{0,79}$/;
const WORKFLOW_STATUSES = new Set([
    'queued',
    'running',
    'waiting_for_approval',
    'completed',
    'failed',
    'cancelled',
]);
const NODE_STATUSES = new Set(['queued', 'running', 'completed', 'failed', 'cancelled']);
const SENSITIVE_INPUT_KEY = /^(?:api[-_]?key|x[-_]?api[-_]?key|authorization|credential|credentials|password|secret|token)$/i;

const defaultBlobStore = {
    get: getBlob,
    list: listBlobs,
    put: putBlob,
};

export class CreatorWorkflowError extends Error {
    constructor(code, message, status = 400) {
        super(message);
        this.name = 'CreatorWorkflowError';
        this.code = code;
        this.status = status;
    }
}

function normalized(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function validProjectId(value) {
    const id = normalized(value);
    if (!UUID_PATTERN.test(id)) throw new CreatorWorkflowError('invalid_project', 'A valid Project ID is required.');
    return id.toLowerCase();
}

function validRunId(value) {
    const id = normalized(value);
    if (!UUID_PATTERN.test(id)) throw new CreatorWorkflowError('invalid_workflow_run', 'A valid Workflow run ID is required.');
    return id.toLowerCase();
}

function validWorkflowId(value) {
    const id = normalized(value);
    if (!OPAQUE_ID_PATTERN.test(id)) throw new CreatorWorkflowError('invalid_workflow', 'A valid Workflow ID is required.');
    return id;
}

function configurationFor(env) {
    const configuration = creatorProjectConfiguration(env);
    if (!configuration.configured) {
        throw new CreatorWorkflowError('workflow_storage_unconfigured', 'Durable Workflow run storage is not configured.', 503);
    }
    return configuration;
}

function ownerSubject(user, configuration) {
    const subject = String(user?.id || '').trim();
    if (!/^\d+$/.test(subject)) throw new CreatorWorkflowError('invalid_owner', 'Creator owner identity is invalid.', 403);
    return createHmac('sha256', configuration.sessionSecret)
        .update(`creator-project-owner:${subject}`, 'utf8')
        .digest('hex')
        .slice(0, 40);
}

function projectRunPrefix(owner, projectId) {
    return `${WORKFLOW_ROOT}/${owner}/${projectId}/`;
}

function runPath(owner, projectId, runId) {
    return `${projectRunPrefix(owner, projectId)}${runId}.json`;
}

function blobOptions(configuration) {
    return { token: configuration.blobToken };
}

async function blobText(result) {
    if (!result) return '';
    if (typeof result.text === 'function') return result.text();
    if (result.stream) return new Response(result.stream).text();
    if (result.body) return new Response(result.body).text();
    return '';
}

function sanitizeInputValue(value, depth = 0) {
    if (depth > 6) throw new CreatorWorkflowError('invalid_workflow_inputs', 'Workflow inputs are nested too deeply.');
    if (value == null || typeof value === 'boolean') return value;
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) throw new CreatorWorkflowError('invalid_workflow_inputs', 'Workflow numeric inputs must be finite.');
        return value;
    }
    if (typeof value === 'string') {
        if (value.length > 20_000) throw new CreatorWorkflowError('invalid_workflow_inputs', 'A Workflow text input is too long.');
        return value;
    }
    if (Array.isArray(value)) {
        if (value.length > 100) throw new CreatorWorkflowError('invalid_workflow_inputs', 'A Workflow input list is too large.');
        return value.map((item) => sanitizeInputValue(item, depth + 1));
    }
    if (typeof value === 'object') {
        const entries = Object.entries(value);
        if (entries.length > 100) throw new CreatorWorkflowError('invalid_workflow_inputs', 'A Workflow input object has too many fields.');
        const output = {};
        for (const [key, item] of entries) {
            if (!INPUT_KEY_PATTERN.test(key)) throw new CreatorWorkflowError('invalid_workflow_inputs', 'Workflow input contains an invalid field name.');
            if (SENSITIVE_INPUT_KEY.test(key)) {
                throw new CreatorWorkflowError('workflow_secret_forbidden', 'Provider credentials cannot be supplied as Workflow inputs.', 403);
            }
            output[key] = sanitizeInputValue(item, depth + 1);
        }
        return output;
    }
    throw new CreatorWorkflowError('invalid_workflow_inputs', 'Workflow inputs contain an unsupported value.');
}

export function normalizeCreatorWorkflowInputs(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new CreatorWorkflowError('invalid_workflow_inputs', 'Workflow inputs must be a JSON object.');
    }
    const inputs = sanitizeInputValue(value);
    if (Buffer.byteLength(JSON.stringify(inputs), 'utf8') > MAX_INPUT_BYTES) {
        throw new CreatorWorkflowError('workflow_inputs_too_large', 'Workflow inputs exceed the 64 KB limit.', 413);
    }
    return inputs;
}

function normalizeSceneReferences(value, project) {
    const source = Array.isArray(value) ? value : [];
    if (source.length > MAX_SCENE_REFERENCES) {
        throw new CreatorWorkflowError('invalid_storyboard_reference', `A Workflow can reference at most ${MAX_SCENE_REFERENCES} Storyboard scenes.`);
    }
    const existing = new Set((project?.storyboard?.scenes || []).map((scene) => normalized(scene?.id)).filter(Boolean));
    const references = [];
    for (const item of source) {
        const id = normalized(item);
        if (!OPAQUE_ID_PATTERN.test(id) || !existing.has(id)) {
            throw new CreatorWorkflowError('invalid_storyboard_reference', 'Workflow references a Storyboard scene outside this Project.', 403);
        }
        if (!references.includes(id)) references.push(id);
    }
    return references;
}

function normalizeNodeStates(value) {
    if (!Array.isArray(value)) return [];
    return value.slice(0, 200).map((node, index) => {
        const id = normalized(node?.id || node?.nodeId || node?.node_id) || `node-${index + 1}`;
        const status = normalized(node?.status).toLowerCase();
        return {
            id: OPAQUE_ID_PATTERN.test(id) ? id : `node-${index + 1}`,
            status: NODE_STATUSES.has(status) ? status : 'queued',
            error: status === 'failed' ? normalized(node?.error).slice(0, 400) || 'Workflow node failed.' : '',
        };
    });
}

function normalizeAssetIds(value) {
    if (!Array.isArray(value)) return [];
    return [...new Set(value.map((item) => normalized(item).toLowerCase()).filter((item) => UUID_PATTERN.test(item)))].slice(0, 100);
}

function publicRun(run) {
    const {
        ownerSubject: _ownerSubject,
        inputs: _inputs,
        providerRunId: _providerRunId,
        ...safe
    } = run;
    return {
        ...safe,
        inputKeys: Object.keys(run.inputs || {}).slice(0, 100),
    };
}

async function writeRun(run, { configuration, blobStore, allowOverwrite }) {
    const serialized = JSON.stringify(run);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_RECORD_BYTES) {
        throw new CreatorWorkflowError('workflow_run_too_large', 'Workflow run record exceeds the storage limit.', 413);
    }
    await blobStore.put(runPath(run.ownerSubject, run.projectId, run.id), serialized, {
        ...blobOptions(configuration),
        access: 'private',
        addRandomSuffix: false,
        allowOverwrite,
        cacheControlMaxAge: 60,
        contentType: 'application/json',
    });
}

async function readRun(owner, projectId, runId, { configuration, blobStore }) {
    let result;
    try {
        result = await blobStore.get(runPath(owner, projectId, runId), {
            ...blobOptions(configuration),
            access: 'private',
            useCache: false,
        });
    } catch {
        throw new CreatorWorkflowError('workflow_storage_unavailable', 'Workflow run storage is temporarily unavailable.', 503);
    }
    if (!result) throw new CreatorWorkflowError('workflow_run_not_found', 'Workflow run was not found.', 404);
    try {
        const text = await blobText(result);
        if (Buffer.byteLength(text, 'utf8') > MAX_RECORD_BYTES) throw new Error('oversized');
        const run = JSON.parse(text);
        if (
            run?.version !== RUN_VERSION ||
            run?.ownerSubject !== owner ||
            run?.projectId !== projectId ||
            run?.id !== runId ||
            !WORKFLOW_STATUSES.has(run?.status)
        ) {
            throw new Error('invalid_record');
        }
        return run;
    } catch {
        throw new CreatorWorkflowError('workflow_run_invalid', 'Stored Workflow run data is invalid.', 503);
    }
}

async function contextFor(user, projectId, { env, blobStore }) {
    const configuration = configurationFor(env);
    const id = validProjectId(projectId);
    const project = await getCreatorProject(user, id, { env, blobStore });
    return {
        configuration,
        owner: ownerSubject(user, configuration),
        project,
        projectId: id,
    };
}

export async function prepareCreatorWorkflowRun(user, input = {}, {
    env = process.env,
    blobStore = defaultBlobStore,
    now = Date.now(),
    idGenerator = randomUUID,
} = {}) {
    const { configuration, owner, project, projectId } = await contextFor(user, input.projectId, { env, blobStore });
    const listed = await blobStore.list({
        ...blobOptions(configuration),
        prefix: projectRunPrefix(owner, projectId),
        limit: MAX_RUNS_PER_PROJECT,
    });
    if ((listed.blobs || []).length >= MAX_RUNS_PER_PROJECT) {
        throw new CreatorWorkflowError('workflow_run_limit', `A Project supports at most ${MAX_RUNS_PER_PROJECT} retained Workflow runs.`, 409);
    }
    const id = validRunId(idGenerator());
    const timestamp = new Date(now).toISOString();
    const run = {
        version: RUN_VERSION,
        ownerSubject: owner,
        id,
        projectId,
        workflowId: validWorkflowId(input.workflowId),
        status: 'waiting_for_approval',
        approvalRequired: true,
        provider: 'muapi',
        providerRunId: null,
        inputs: normalizeCreatorWorkflowInputs(input.inputs || {}),
        storyboardSceneIds: normalizeSceneReferences(input.storyboardSceneIds, project),
        nodeStates: [],
        outputAssetIds: [],
        retryOf: input.retryOf ? validRunId(input.retryOf) : null,
        attempt: Math.max(1, Math.min(20, Number.isFinite(Number(input.attempt)) ? Math.round(Number(input.attempt)) : 1)),
        error: '',
        createdAt: timestamp,
        updatedAt: timestamp,
        approvedAt: null,
        startedAt: null,
        completedAt: null,
    };
    try {
        await writeRun(run, { configuration, blobStore, allowOverwrite: false });
    } catch (error) {
        if (error instanceof CreatorWorkflowError) throw error;
        throw new CreatorWorkflowError('workflow_storage_unavailable', 'Workflow run could not be prepared.', 503);
    }
    return publicRun(run);
}

export async function getCreatorWorkflowRunRecord(user, projectId, runId, {
    env = process.env,
    blobStore = defaultBlobStore,
} = {}) {
    const { configuration, owner, projectId: id } = await contextFor(user, projectId, { env, blobStore });
    return readRun(owner, id, validRunId(runId), { configuration, blobStore });
}

export async function getCreatorWorkflowRun(user, projectId, runId, options = {}) {
    return publicRun(await getCreatorWorkflowRunRecord(user, projectId, runId, options));
}

export async function listCreatorWorkflowRuns(user, projectId, {
    env = process.env,
    blobStore = defaultBlobStore,
} = {}) {
    const { configuration, owner, projectId: id } = await contextFor(user, projectId, { env, blobStore });
    let listed;
    try {
        listed = await blobStore.list({
            ...blobOptions(configuration),
            prefix: projectRunPrefix(owner, id),
            limit: MAX_RUNS_PER_PROJECT,
        });
    } catch {
        throw new CreatorWorkflowError('workflow_storage_unavailable', 'Workflow run storage is temporarily unavailable.', 503);
    }
    const runs = [];
    for (const item of listed.blobs || []) {
        const match = String(item.pathname || '').match(/\/([0-9a-f-]{36})\.json$/i);
        if (!match || !UUID_PATTERN.test(match[1])) continue;
        try {
            runs.push(publicRun(await readRun(owner, id, match[1].toLowerCase(), { configuration, blobStore })));
        } catch {
            // Omit an invalid individual record without leaking its contents.
        }
    }
    return runs.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
}

export async function updateCreatorWorkflowRun(user, projectId, runId, patch = {}, {
    env = process.env,
    blobStore = defaultBlobStore,
    now = Date.now(),
} = {}) {
    const { configuration, owner, projectId: id } = await contextFor(user, projectId, { env, blobStore });
    const targetRunId = validRunId(runId);
    const run = await readRun(owner, id, targetRunId, { configuration, blobStore });
    const nextStatus = patch.status == null ? run.status : normalized(patch.status).toLowerCase();
    if (!WORKFLOW_STATUSES.has(nextStatus)) throw new CreatorWorkflowError('invalid_workflow_status', 'Workflow run status is invalid.');
    const providerRunId = patch.providerRunId === undefined
        ? run.providerRunId
        : patch.providerRunId == null
            ? null
            : validWorkflowId(patch.providerRunId);
    const next = {
        ...run,
        status: nextStatus,
        providerRunId,
        nodeStates: patch.nodeStates === undefined ? run.nodeStates : normalizeNodeStates(patch.nodeStates),
        outputAssetIds: patch.outputAssetIds === undefined ? run.outputAssetIds : normalizeAssetIds(patch.outputAssetIds),
        error: patch.error === undefined ? run.error : normalized(patch.error).slice(0, 400),
        approvedAt: patch.approvedAt === undefined ? run.approvedAt : patch.approvedAt,
        startedAt: patch.startedAt === undefined ? run.startedAt : patch.startedAt,
        completedAt: patch.completedAt === undefined ? run.completedAt : patch.completedAt,
        updatedAt: new Date(now).toISOString(),
    };
    await writeRun(next, { configuration, blobStore, allowOverwrite: true });
    return publicRun(next);
}

export async function retryCreatorWorkflowRun(user, projectId, runId, {
    env = process.env,
    blobStore = defaultBlobStore,
    now = Date.now(),
    idGenerator = randomUUID,
} = {}) {
    const prior = await getCreatorWorkflowRunRecord(user, projectId, runId, { env, blobStore });
    if (!['failed', 'cancelled'].includes(prior.status)) {
        throw new CreatorWorkflowError('workflow_retry_not_allowed', 'Only failed or cancelled Workflow runs can be retried.', 409);
    }
    return prepareCreatorWorkflowRun(user, {
        projectId: prior.projectId,
        workflowId: prior.workflowId,
        inputs: prior.inputs,
        storyboardSceneIds: prior.storyboardSceneIds,
        retryOf: prior.id,
        attempt: prior.attempt + 1,
    }, { env, blobStore, now, idGenerator });
}

export function creatorWorkflowStoreForTests(records = new Map(), { now = Date.now() } = {}) {
    return {
        records,
        async put(pathname, body, options = {}) {
            if (options.allowOverwrite === false && records.has(pathname)) throw new Error('blob_exists');
            const bytes = Buffer.from(typeof body === 'string' ? body : String(body));
            records.set(pathname, { pathname, bytes, uploadedAt: new Date(now), url: `https://private.test/${pathname}` });
            return { pathname, url: `https://private.test/${pathname}` };
        },
        async get(pathname) {
            const record = records.get(pathname);
            if (!record) return null;
            return { stream: new Blob([record.bytes]).stream() };
        },
        async list({ prefix = '', limit = 100 } = {}) {
            return { blobs: [...records.values()].filter((item) => item.pathname.startsWith(prefix)).slice(0, limit) };
        },
    };
}
