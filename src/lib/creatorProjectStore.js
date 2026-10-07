import { execFile } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { del as deleteBlob, get as getBlob, list as listBlobs, put as putBlob } from '@vercel/blob';

import { buildFfmpegArgs, buildRenderPlan, CompositorError } from './creatorCompositor.js';
import { storyboardToTimeline } from './creatorTimeline.js';

const PROJECT_ROOT = 'creator-projects';
const ASSET_ROOT = 'creator-assets';
const PROJECT_VERSION = 1;
const MAX_PROJECTS = 100;
export const MAX_ASSETS = 500;
const MAX_SCENES = 100;
const MAX_MESSAGES = 50;
const MAX_PROJECT_BYTES = 1024 * 1024;
const MAX_RENDERS = 20;
const DEFAULT_RENDER_BUDGET_MS = 4 * 60 * 1000;
const RENDER_SOURCE_TIMEOUT_MS = 60 * 1000;
const RENDER_COMMIT_ATTEMPTS = 3;
const MAX_RENDER_SOURCE_BYTES = 250 * 1024 * 1024;
// All sources of one render together must fit the function's temp space and memory.
const MAX_RENDER_TOTAL_BYTES = 500 * 1024 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,139}$/;
const ASSET_TYPES = new Set(['image', 'video', 'voice', 'audio', 'music', 'avatar', 'graphic', 'upload']);
const ASPECT_RATIOS = new Set(['16:9', '9:16', '1:1']);
const TRANSITIONS = new Set(['cut', 'dissolve', 'fade', 'dip-black', 'match', 'whip']);
const SCENE_STATUSES = new Set(['draft', 'ready', 'error']);
const DEFAULT_ASSET_HOSTS = Object.freeze([
    'cdn.muapi.ai',
    '*.muapi.ai',
    '*.vercel-storage.com',
    '*.heygen.ai',
    '*.heygen.com',
]);

const defaultBlobStore = {
    del: deleteBlob,
    get: getBlob,
    list: listBlobs,
    put: putBlob,
};

export class CreatorProjectError extends Error {
    constructor(code, message, status = 400) {
        super(message);
        this.name = 'CreatorProjectError';
        this.code = code;
        this.status = status;
    }
}

function normalized(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function boundedText(value, name, maximum, { optional = false } = {}) {
    if (value == null && optional) return '';
    if (typeof value !== 'string') throw new CreatorProjectError('invalid_input', `${name} must be text.`);
    const text = value.trim();
    if (!text && !optional) throw new CreatorProjectError('invalid_input', `${name} is required.`);
    if (text.length > maximum) throw new CreatorProjectError('invalid_input', `${name} must be ${maximum} characters or fewer.`);
    return text;
}

function boundedInteger(value, fallback, minimum, maximum) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(maximum, Math.max(minimum, Math.round(parsed)));
}

function validProjectId(value) {
    const id = normalized(value);
    if (!UUID_PATTERN.test(id)) throw new CreatorProjectError('invalid_project', 'A valid Project ID is required.');
    return id.toLowerCase();
}

function validAssetId(value) {
    const id = normalized(value);
    if (!UUID_PATTERN.test(id)) throw new CreatorProjectError('invalid_asset', 'A valid Asset ID is required.');
    return id.toLowerCase();
}

function configuredHosts(env) {
    const configured = normalized(env.CREATOR_ASSET_ALLOWED_HOSTS)
        .split(',')
        .map((item) => item.trim().toLowerCase())
        .filter((item) => /^(?:\*\.)?[a-z0-9.-]+$/.test(item));
    return configured.length ? configured : DEFAULT_ASSET_HOSTS;
}

function hostMatches(hostname, pattern) {
    if (pattern.startsWith('*.')) {
        const suffix = pattern.slice(1);
        return hostname.endsWith(suffix) && hostname.length > suffix.length;
    }
    return hostname === pattern;
}

export function safeCreatorAssetUrl(value, { env = process.env, optional = false } = {}) {
    if ((value == null || value === '') && optional) return '';
    if (typeof value !== 'string' || value.length > 4096) {
        throw new CreatorProjectError('invalid_asset_url', 'Asset URL must be a permitted public HTTPS media URL.');
    }
    try {
        const url = new URL(value);
        const hostname = url.hostname.toLowerCase();
        if (
            url.protocol !== 'https:' ||
            url.username ||
            url.password ||
            url.hash ||
            hostname === 'localhost' ||
            hostname.endsWith('.local') ||
            isIP(hostname) !== 0 ||
            !configuredHosts(env).some((pattern) => hostMatches(hostname, pattern))
        ) {
            throw new Error('unsafe_url');
        }
        return url.toString();
    } catch (error) {
        if (error instanceof CreatorProjectError) throw error;
        throw new CreatorProjectError('invalid_asset_url', 'Asset URL must be a permitted public HTTPS media URL.');
    }
}

export function creatorProjectConfiguration(env = process.env) {
    const blobToken = normalized(env.BLOB_READ_WRITE_TOKEN);
    const sessionSecret = normalized(env.CREATOR_SESSION_SECRET);
    const missing = [];
    if (blobToken.length < 20 || blobToken.length > 4096) missing.push('BLOB_READ_WRITE_TOKEN');
    if (sessionSecret.length < 32 || sessionSecret.length > 4096) missing.push('CREATOR_SESSION_SECRET');
    return {
        configured: missing.length === 0,
        missing,
        blobToken,
        sessionSecret,
    };
}

export function creatorAssetStorageConfiguration(env = process.env) {
    const blobToken = normalized(env.CREATOR_ASSET_BLOB_READ_WRITE_TOKEN);
    const missing = [];
    if (blobToken.length < 20 || blobToken.length > 4096) {
        missing.push('CREATOR_ASSET_BLOB_READ_WRITE_TOKEN');
    }
    return {
        configured: missing.length === 0,
        missing,
        blobToken,
    };
}

function requireConfiguration(env) {
    const configuration = creatorProjectConfiguration(env);
    if (!configuration.configured) {
        throw new CreatorProjectError('project_storage_unconfigured', 'Durable Project storage is not configured.', 503);
    }
    return configuration;
}

function ownerSubject(user, configuration) {
    const subject = String(user?.id || '').trim();
    if (!/^\d+$/.test(subject)) throw new CreatorProjectError('invalid_owner', 'Creator owner identity is invalid.', 403);
    return createHmac('sha256', configuration.sessionSecret)
        .update(`creator-project-owner:${subject}`, 'utf8')
        .digest('hex')
        .slice(0, 40);
}

function projectPrefix(owner) {
    return `${PROJECT_ROOT}/${owner}/`;
}

function projectPath(owner, projectId) {
    return `${projectPrefix(owner)}${projectId}.json`;
}

export function creatorAssetUploadPrefix(projectId) {
    return `${ASSET_ROOT}/${validProjectId(projectId)}/`;
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

function emptyStoryboard() {
    return { version: 1, selectedSceneId: null, scenes: [] };
}

function emptyConversation() {
    return { version: 1, messages: [] };
}

function projectForClient(project) {
    const { ownerSubject: _ownerSubject, ...safe } = project;
    return {
        ...safe,
        assetUploadPrefix: creatorAssetUploadPrefix(project.id),
    };
}

function projectSummary(project) {
    return {
        id: project.id,
        name: project.name,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
        revision: project.revision,
        assetCount: project.assets.length,
        sceneCount: project.storyboard.scenes.length,
    };
}

function normalizeProviderMetadata(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const provider = normalized(value.provider).toLowerCase();
    const model = normalized(value.model);
    const requestId = normalized(value.requestId || value.jobId);
    const keyMode = ['sandbox', 'production'].includes(normalized(value.keyMode).toLowerCase())
        ? normalized(value.keyMode).toLowerCase()
        : null;
    if (!provider && !model && !requestId && !keyMode) return null;
    if (provider && !/^[a-z0-9._-]{1,60}$/.test(provider)) {
        throw new CreatorProjectError('invalid_asset', 'Asset provider metadata is invalid.');
    }
    if (requestId && !OPAQUE_ID_PATTERN.test(requestId)) {
        throw new CreatorProjectError('invalid_asset', 'Asset request metadata is invalid.');
    }
    return {
        provider: provider || null,
        model: model ? model.slice(0, 160) : null,
        requestId: requestId || null,
        keyMode,
    };
}

function normalizeAssetInput(value, {
    env,
    projectId,
    now,
    idGenerator,
} = {}) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new CreatorProjectError('invalid_asset', 'Asset input must be an object.');
    }
    const type = normalized(value.type).toLowerCase();
    if (!ASSET_TYPES.has(type)) throw new CreatorProjectError('invalid_asset', 'Asset type is not supported.');
    const url = safeCreatorAssetUrl(value.url, { env });
    const source = normalized(value.source).toLowerCase() || 'generated';
    if (!/^[a-z0-9._-]{1,60}$/.test(source)) throw new CreatorProjectError('invalid_asset', 'Asset source is invalid.');
    const storagePath = normalized(value.storagePath);
    if (storagePath && !storagePath.startsWith(creatorAssetUploadPrefix(projectId))) {
        throw new CreatorProjectError('invalid_asset', 'Asset storage reference is outside this Project.');
    }
    const mimeType = normalized(value.mimeType).toLowerCase();
    if (mimeType && !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(mimeType)) {
        throw new CreatorProjectError('invalid_asset', 'Asset media type is invalid.');
    }
    return {
        id: idGenerator(),
        projectId,
        type,
        title: boundedText(value.title || 'Untitled Asset', 'Asset title', 160),
        url,
        storagePath: storagePath || null,
        source,
        mimeType: mimeType || null,
        size: boundedInteger(value.size, 0, 0, 1024 * 1024 * 1024),
        provider: normalizeProviderMetadata(value.provider || value),
        createdAt: new Date(now).toISOString(),
    };
}

function normalizeScene(value, index, env) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new CreatorProjectError('invalid_storyboard', `Scene ${index + 1} must be an object.`);
    }
    const id = normalized(value.id);
    if (!OPAQUE_ID_PATTERN.test(id)) throw new CreatorProjectError('invalid_storyboard', `Scene ${index + 1} has an invalid ID.`);
    const imageUrl = safeCreatorAssetUrl(value.imageUrl, { env, optional: true });
    const videoUrl = safeCreatorAssetUrl(value.videoUrl, { env, optional: true });
    return {
        id,
        title: boundedText(value.title || `Scene ${index + 1}`, `Scene ${index + 1} title`, 80),
        prompt: boundedText(value.prompt || '', `Scene ${index + 1} prompt`, 4000, { optional: true }),
        imageUrl,
        videoUrl,
        duration: boundedInteger(value.duration, 5, 3, 12),
        aspectRatio: ASPECT_RATIOS.has(value.aspectRatio) ? value.aspectRatio : '16:9',
        transition: TRANSITIONS.has(value.transition) ? value.transition : 'cut',
        status: SCENE_STATUSES.has(value.status) ? value.status : imageUrl || videoUrl ? 'ready' : 'draft',
        model: normalized(value.model).slice(0, 160) || null,
        error: value.status === 'error' ? boundedText(value.error || 'Generation failed.', 'Scene error', 300) : '',
    };
}

function normalizeStoryboard(value, env) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new CreatorProjectError('invalid_storyboard', 'Storyboard must be an object.');
    }
    const sourceScenes = Array.isArray(value.scenes) ? value.scenes : [];
    if (sourceScenes.length > MAX_SCENES) throw new CreatorProjectError('invalid_storyboard', `Storyboard supports at most ${MAX_SCENES} scenes.`);
    const scenes = sourceScenes.map((scene, index) => normalizeScene(scene, index, env));
    const selected = normalized(value.selectedSceneId);
    return {
        version: 1,
        selectedSceneId: scenes.some((scene) => scene.id === selected) ? selected : scenes[0]?.id || null,
        scenes,
    };
}

function normalizeConversation(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new CreatorProjectError('invalid_conversation', 'Conversation must be an object.');
    }
    const source = Array.isArray(value.messages) ? value.messages : [];
    if (source.length > MAX_MESSAGES) throw new CreatorProjectError('invalid_conversation', `Conversation supports at most ${MAX_MESSAGES} retained messages.`);
    return {
        version: 1,
        messages: source.map((message, index) => {
            const role = message?.role === 'assistant' ? 'assistant' : message?.role === 'user' ? 'user' : '';
            if (!role) throw new CreatorProjectError('invalid_conversation', `Conversation message ${index + 1} has an invalid role.`);
            const actions = Array.isArray(message?.actions)
                ? message.actions.filter((item) => typeof item === 'string' && /^[a-z][a-z0-9.-]{1,80}$/.test(item)).slice(0, 12)
                : [];
            return {
                id: OPAQUE_ID_PATTERN.test(normalized(message.id)) ? normalized(message.id) : `message-${index + 1}`,
                role,
                text: boundedText(message.text || '', `Conversation message ${index + 1}`, 20_000),
                provider: role === 'assistant' ? normalized(message.provider).slice(0, 60) || null : null,
                actions,
                createdAt: normalized(message.createdAt).slice(0, 40) || null,
            };
        }),
    };
}

async function writeProject(project, {
    configuration,
    blobStore,
    allowOverwrite,
}) {
    const serialized = JSON.stringify(project);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_PROJECT_BYTES) {
        throw new CreatorProjectError('project_too_large', 'Project manifest exceeds the 1 MB storage limit.', 413);
    }
    await blobStore.put(projectPath(project.ownerSubject, project.id), serialized, {
        ...blobOptions(configuration),
        access: 'private',
        addRandomSuffix: false,
        allowOverwrite,
        cacheControlMaxAge: 60,
        contentType: 'application/json',
    });
}

async function readProject(owner, projectId, { configuration, blobStore }) {
    const pathname = projectPath(owner, projectId);
    let result;
    try {
        result = await blobStore.get(pathname, {
            ...blobOptions(configuration),
            access: 'private',
            useCache: false,
        });
    } catch {
        throw new CreatorProjectError('project_storage_unavailable', 'Project storage is temporarily unavailable.', 503);
    }
    if (!result) throw new CreatorProjectError('project_not_found', 'Project was not found.', 404);
    try {
        const text = await blobText(result);
        if (Buffer.byteLength(text, 'utf8') > MAX_PROJECT_BYTES) throw new Error('oversized');
        const project = JSON.parse(text);
        if (project?.version !== PROJECT_VERSION || project?.ownerSubject !== owner || project?.id !== projectId) {
            throw new Error('invalid_record');
        }
        return project;
    } catch {
        throw new CreatorProjectError('project_record_invalid', 'Stored Project data is invalid.', 503);
    }
}

function updatedProject(project, patch, now) {
    return {
        ...project,
        ...patch,
        revision: project.revision + 1,
        updatedAt: new Date(now).toISOString(),
    };
}

function assertExpectedRevision(project, expectedRevision) {
    if (expectedRevision == null || expectedRevision === '') return;
    if (!Number.isInteger(Number(expectedRevision)) || Number(expectedRevision) !== project.revision) {
        throw new CreatorProjectError('project_conflict', 'Project changed in another request. Reload it and try again.', 409);
    }
}

async function readAndCheckRevision(owner, id, expectedRevision, { configuration, blobStore }) {
    const project = await readProject(owner, id, { configuration, blobStore });
    if (expectedRevision != null) assertExpectedRevision(project, expectedRevision);
    return project;
}

// Shared by every Project mutation (workflow's mutateCreatorProject and the
// simpler rename/asset/storyboard/conversation writes below): compute the
// patch against `project`, then re-read immediately before writing and
// refuse to overwrite a Project another request already changed, rather
// than silently discarding it. This is what actually protects against a
// cross-function race (e.g. a Storyboard autosave racing a workflow node's
// completion) — it doesn't depend on both writers sharing the same queue,
// only on both going through this same check-before-write.
async function commitProjectPatch(owner, id, project, patch, { configuration, blobStore, now }) {
    if (patch == null) return projectForClient(project);
    const current = await readProject(owner, id, { configuration, blobStore });
    if (current.revision !== project.revision) {
        throw new CreatorProjectError('project_conflict', 'Project changed in another request. Reload it and try again.', 409);
    }
    const next = updatedProject(project, patch, now);
    await writeProject(next, { configuration, blobStore, allowOverwrite: true });
    return projectForClient(next);
}

function storeContext(user, env) {
    const configuration = requireConfiguration(env);
    return { configuration, owner: ownerSubject(user, configuration) };
}

export async function createCreatorProject(user, input = {}, {
    env = process.env,
    blobStore = defaultBlobStore,
    now = Date.now(),
    idGenerator = randomUUID,
} = {}) {
    const { configuration, owner } = storeContext(user, env);
    const id = validProjectId(idGenerator());
    const timestamp = new Date(now).toISOString();
    const project = {
        version: PROJECT_VERSION,
        ownerSubject: owner,
        id,
        name: boundedText(input.name || 'Untitled Project', 'Project name', 100),
        createdAt: timestamp,
        updatedAt: timestamp,
        revision: 1,
        conversation: emptyConversation(),
        assets: [],
        storyboard: emptyStoryboard(),
        timeline: storyboardToTimeline(emptyStoryboard(), []),
        workflowReferences: [],
        workflowRuns: [],
        publishDrafts: [],
        renders: [],
    };
    try {
        await writeProject(project, { configuration, blobStore, allowOverwrite: false });
    } catch (error) {
        if (error instanceof CreatorProjectError) throw error;
        throw new CreatorProjectError('project_storage_unavailable', 'Project could not be created.', 503);
    }
    return projectForClient(project);
}

export async function listCreatorProjects(user, {
    env = process.env,
    blobStore = defaultBlobStore,
} = {}) {
    const { configuration, owner } = storeContext(user, env);
    let listed;
    try {
        listed = await blobStore.list({
            ...blobOptions(configuration),
            prefix: projectPrefix(owner),
            limit: MAX_PROJECTS,
        });
    } catch {
        throw new CreatorProjectError('project_storage_unavailable', 'Project storage is temporarily unavailable.', 503);
    }
    const projects = [];
    for (const item of listed.blobs || []) {
        const match = String(item.pathname || '').match(/\/([0-9a-f-]{36})\.json$/i);
        if (!match || !UUID_PATTERN.test(match[1])) continue;
        try {
            projects.push(projectSummary(await readProject(owner, match[1].toLowerCase(), { configuration, blobStore })));
        } catch {
            // An invalid individual record is omitted without leaking its contents.
        }
    }
    return projects.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
}

export async function getCreatorProject(user, projectId, {
    env = process.env,
    blobStore = defaultBlobStore,
} = {}) {
    const { configuration, owner } = storeContext(user, env);
    return projectForClient(await readProject(owner, validProjectId(projectId), { configuration, blobStore }));
}

export async function renameCreatorProject(user, projectId, input = {}, {
    env = process.env,
    blobStore = defaultBlobStore,
    now = Date.now(),
} = {}) {
    const { configuration, owner } = storeContext(user, env);
    const id = validProjectId(projectId);
    const project = await readAndCheckRevision(owner, id, input.expectedRevision, { configuration, blobStore });
    const patch = { name: boundedText(input.name, 'Project name', 100) };
    return commitProjectPatch(owner, id, project, patch, { configuration, blobStore, now });
}

export async function addCreatorAsset(user, projectId, input = {}, {
    env = process.env,
    blobStore = defaultBlobStore,
    now = Date.now(),
    idGenerator = randomUUID,
} = {}) {
    const { configuration, owner } = storeContext(user, env);
    const id = validProjectId(projectId);
    const project = await readAndCheckRevision(owner, id, input.expectedRevision, { configuration, blobStore });
    const existing = project.assets.find((asset) => asset.url === input.url);
    if (existing) return { project: projectForClient(project), asset: existing, created: false };
    if (project.assets.length >= MAX_ASSETS) throw new CreatorProjectError('asset_limit', `A Project supports at most ${MAX_ASSETS} Assets.`, 409);
    const asset = normalizeAssetInput(input, { env, projectId: id, now, idGenerator });
    const assets = [asset, ...project.assets];
    const patch = { assets, timeline: storyboardToTimeline(project.storyboard, assets) };
    const next = await commitProjectPatch(owner, id, project, patch, { configuration, blobStore, now });
    return { project: next, asset, created: true };
}

export async function deleteCreatorAsset(user, projectId, assetId, input = {}, {
    env = process.env,
    blobStore = defaultBlobStore,
    assetBlobStore = defaultBlobStore,
    now = Date.now(),
} = {}) {
    if (input.approved !== true) throw new CreatorProjectError('approval_required', 'Asset deletion requires explicit approval.', 403);
    const { configuration, owner } = storeContext(user, env);
    const id = validProjectId(projectId);
    const targetAssetId = validAssetId(assetId);
    const project = await readAndCheckRevision(owner, id, input.expectedRevision, { configuration, blobStore });
    const asset = project.assets.find((item) => item.id === targetAssetId);
    if (!asset) throw new CreatorProjectError('asset_not_found', 'Asset was not found.', 404);
    const assets = project.assets.filter((item) => item.id !== targetAssetId);
    const patch = { assets, timeline: storyboardToTimeline(project.storyboard, assets) };
    const next = await commitProjectPatch(owner, id, project, patch, { configuration, blobStore, now });
    if (asset.storagePath && asset.storagePath.startsWith(creatorAssetUploadPrefix(id))) {
        const assetConfiguration = creatorAssetStorageConfiguration(env);
        if (assetConfiguration.configured) {
            await assetBlobStore.del(asset.storagePath, { token: assetConfiguration.blobToken }).catch(() => {});
        }
    }
    return { project: next, deletedAssetId: targetAssetId };
}

export async function saveCreatorStoryboard(user, projectId, input = {}, {
    env = process.env,
    blobStore = defaultBlobStore,
    now = Date.now(),
} = {}) {
    const { configuration, owner } = storeContext(user, env);
    const id = validProjectId(projectId);
    const project = await readAndCheckRevision(owner, id, input.expectedRevision, { configuration, blobStore });
    const storyboard = normalizeStoryboard(input.storyboard || input, env);
    const patch = { storyboard, timeline: storyboardToTimeline(storyboard, project.assets) };
    return commitProjectPatch(owner, id, project, patch, { configuration, blobStore, now });
}

export async function saveCreatorConversation(user, projectId, input = {}, {
    env = process.env,
    blobStore = defaultBlobStore,
    now = Date.now(),
} = {}) {
    const { configuration, owner } = storeContext(user, env);
    const id = validProjectId(projectId);
    const project = await readAndCheckRevision(owner, id, input.expectedRevision, { configuration, blobStore });
    const patch = { conversation: normalizeConversation(input.conversation || input) };
    return commitProjectPatch(owner, id, project, patch, { configuration, blobStore, now });
}

// Serializes mutateCreatorProject calls per Project within this process — the
// same technique StandaloneShell already uses client-side for its own request
// queue. A revision recheck alone still leaves a check-then-write gap: two
// truly concurrent calls can both pass the recheck before either has written.
// Serializing here closes that gap for every request this process itself
// handles; the recheck below remains as the second layer that catches a
// change made by a *different* process (relevant to a multi-instance
// deployment, where this in-process queue alone cannot see across instances).
const projectMutationQueues = new Map();

function enqueueProjectMutation(key, operation) {
    const previous = projectMutationQueues.get(key) || Promise.resolve();
    const next = previous.catch(() => {}).then(operation);
    const settled = next.catch(() => {});
    projectMutationQueues.set(key, settled);
    settled.finally(() => {
        if (projectMutationQueues.get(key) === settled) projectMutationQueues.delete(key);
    });
    return next;
}

export async function mutateCreatorProject(user, projectId, mutator, {
    env = process.env,
    blobStore = defaultBlobStore,
    now = Date.now(),
    expectedRevision,
} = {}) {
    const { configuration, owner } = storeContext(user, env);
    const id = validProjectId(projectId);
    return enqueueProjectMutation(`${owner}:${id}`, async () => {
        // Belt-and-suspenders: even under this process's own serialization, a
        // different process (or, since commitProjectPatch is now shared with
        // the unqueued rename/asset/storyboard/conversation writes below, a
        // concurrent call to one of those) could have written in between.
        // commitProjectPatch's re-read-before-write is what actually catches
        // that, regardless of which queue either writer used.
        const project = await readAndCheckRevision(owner, id, expectedRevision, { configuration, blobStore });
        const patch = await mutator(project);
        return commitProjectPatch(owner, id, project, patch, { configuration, blobStore, now });
    });
}

const execFileAsync = promisify(execFile);

export function creatorRenderEnabled(env = process.env) {
    return normalized(env.CREATOR_RENDER_ENABLED).toLowerCase() === 'true';
}

// One wall-clock budget covers downloads, ffmpeg, and upload; it must fit
// inside the hosting function's maxDuration.
function renderBudgetMs(env) {
    return boundedInteger(env.CREATOR_RENDER_MAX_MS, DEFAULT_RENDER_BUDGET_MS, 30_000, 780_000);
}

function remainingMs(deadline) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
        throw new CreatorProjectError('render_timeout', 'Render exceeded its time budget and was stopped.', 504);
    }
    return remaining;
}

async function downloadRenderSource(url, destPath, { env, fetchImpl, deadline, budget }) {
    const safeUrl = safeCreatorAssetUrl(url, { env });
    let response;
    try {
        response = await fetchImpl(safeUrl, {
            redirect: 'error',
            signal: AbortSignal.timeout(Math.min(RENDER_SOURCE_TIMEOUT_MS, remainingMs(deadline))),
        });
    } catch (error) {
        if (error instanceof CreatorProjectError) throw error;
        throw new CreatorProjectError('render_source_unreachable', 'Could not download a required media source for this render.', 502);
    }
    if (!response.ok) {
        throw new CreatorProjectError('render_source_unreachable', 'A required media source for this render is unavailable.', 502);
    }
    const tooLarge = new CreatorProjectError('render_source_too_large', 'A media source for this render is too large.', 413);
    if (Number(response.headers?.get?.('content-length') || 0) > MAX_RENDER_SOURCE_BYTES) throw tooLarge;
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_RENDER_SOURCE_BYTES) throw tooLarge;
    if (budget) {
        budget.bytes += buffer.length;
        if (budget.bytes > MAX_RENDER_TOTAL_BYTES) {
            throw new CreatorProjectError('render_sources_too_large', 'The media sources for this render are too large in total.', 413);
        }
    }
    await writeFile(destPath, buffer);
}

async function resolveFfmpegPath() {
    try {
        const installed = await import('@ffmpeg-installer/ffmpeg');
        const path = installed?.default?.path || installed?.path;
        if (typeof path === 'string' && path) return path;
    } catch {
        // Reported below as a clean 503 rather than crashing the route.
    }
    throw new CreatorProjectError('render_engine_unavailable', 'The video render engine is not installed in this deployment.', 503);
}

async function runFfmpeg(args, { execFileImpl, deadline }) {
    const ffmpegPath = await resolveFfmpegPath();
    try {
        await execFileImpl(ffmpegPath, args, { timeout: remainingMs(deadline), maxBuffer: 16 * 1024 * 1024 });
    } catch (error) {
        // Never surface ffmpeg stderr: it can echo input paths and content.
        throw new CreatorProjectError(
            'render_failed',
            error?.killed ? 'Render exceeded the time limit and was stopped.' : 'The render engine failed to produce a video.',
            502,
        );
    }
}

async function produceRender(project, renderId, { env, fetchImpl, execFileImpl, assetBlobStore, assetConfiguration }) {
    const deadline = Date.now() + renderBudgetMs(env);
    let plan;
    try {
        plan = buildRenderPlan(project.timeline);
    } catch (error) {
        if (error instanceof CompositorError) throw new CreatorProjectError(`render_${error.code}`, error.message, 422);
        throw error;
    }
    if (project.assets.length >= MAX_ASSETS) {
        throw new CreatorProjectError('asset_limit', `A Project supports at most ${MAX_ASSETS} Assets.`, 409);
    }
    const tmpDir = await mkdtemp(join(tmpdir(), 'creator-render-'));
    const budget = { bytes: 0 };
    try {
        const clipFilePaths = [];
        for (const [index, clip] of plan.clips.entries()) {
            const destPath = join(tmpDir, `clip-${index}.${clip.sourceType === 'video' ? 'mp4' : 'img'}`);
            await downloadRenderSource(clip.sourceUrl, destPath, { env, fetchImpl, deadline, budget });
            clipFilePaths.push(destPath);
        }
        let voiceFilePath = null;
        if (plan.voiceTrack) {
            voiceFilePath = join(tmpDir, 'voice.audio');
            await downloadRenderSource(plan.voiceTrack.url, voiceFilePath, { env, fetchImpl, deadline, budget });
        }
        let musicFilePath = null;
        if (plan.musicTrack) {
            musicFilePath = join(tmpDir, 'music.audio');
            await downloadRenderSource(plan.musicTrack.url, musicFilePath, { env, fetchImpl, deadline, budget });
        }
        const outputPath = join(tmpDir, 'output.mp4');
        let args;
        try {
            args = buildFfmpegArgs(plan, {
                clipFilePaths,
                voiceFilePath,
                musicFilePath,
                outputPath,
                fontFile: normalized(env.CREATOR_RENDER_FONT_FILE) || null,
            });
        } catch (error) {
            if (error instanceof CompositorError) throw new CreatorProjectError(`render_${error.code}`, error.message, 422);
            throw error;
        }
        await runFfmpeg(args, { execFileImpl, deadline });
        remainingMs(deadline);
        const outputBuffer = await readFile(outputPath);
        const storagePath = `${creatorAssetUploadPrefix(project.id)}render-${renderId}.mp4`;
        let uploaded;
        try {
            uploaded = await assetBlobStore.put(storagePath, outputBuffer, {
                token: assetConfiguration.blobToken,
                access: 'public',
                addRandomSuffix: false,
                allowOverwrite: false,
                contentType: 'video/mp4',
            });
        } catch {
            throw new CreatorProjectError('render_upload_failed', 'The rendered video could not be stored.', 502);
        }
        return {
            url: uploaded.url,
            storagePath,
            size: outputBuffer.length,
            clipCount: plan.clips.length,
            totalDuration: plan.totalDuration,
        };
    } finally {
        await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
}

// Renders the Project's current timeline synchronously (bounded by
// CREATOR_RENDER_MAX_MS), then records the outcome through mutateCreatorProject so
// edits made while ffmpeg ran are merged rather than overwritten. A failed
// render is recorded as failed, never reported as success.
async function discardRenderOutput(output, { assetBlobStore, assetConfiguration }) {
    try {
        await assetBlobStore.del(output.storagePath, { token: assetConfiguration.blobToken });
    } catch {
        // Best effort: an orphaned public render is harmless and listed under the Project prefix.
    }
}

export async function renderCreatorTimeline(user, projectId, input = {}, {
    env = process.env,
    blobStore = defaultBlobStore,
    assetBlobStore = defaultBlobStore,
    now = Date.now(),
    idGenerator = randomUUID,
    fetchImpl = fetch,
    execFileImpl = execFileAsync,
} = {}) {
    if (!creatorRenderEnabled(env)) {
        throw new CreatorProjectError('render_disabled', 'Timeline rendering is not enabled in this deployment.', 503);
    }
    const { configuration, owner } = storeContext(user, env);
    const assetConfiguration = creatorAssetStorageConfiguration(env);
    if (!assetConfiguration.configured) {
        throw new CreatorProjectError('asset_storage_unconfigured', 'Public Creator Asset storage is not configured.', 503);
    }
    const id = validProjectId(projectId);
    const snapshot = await readAndCheckRevision(owner, id, input.expectedRevision, { configuration, blobStore });
    const renderId = idGenerator();
    const requestedAt = new Date(now).toISOString();

    let output = null;
    let failure = null;
    try {
        output = await produceRender(snapshot, renderId, { env, fetchImpl, execFileImpl, assetBlobStore, assetConfiguration });
    } catch (error) {
        failure = error instanceof CreatorProjectError
            ? error
            : new CreatorProjectError('render_failed', 'The render could not be completed.', 502);
    }

    let record;
    let assetLimitReached = false;
    const recordOutcome = (current) => {
        let assets = current.assets;
        let asset = null;
        assetLimitReached = Boolean(output) && current.assets.length >= MAX_ASSETS;
        const outcomeFailure = assetLimitReached
            ? new CreatorProjectError('asset_limit', `A Project supports at most ${MAX_ASSETS} Assets.`, 409)
            : failure;
        if (output && !assetLimitReached) {
            asset = normalizeAssetInput({
                type: 'video',
                title: `Render ${requestedAt}`,
                url: output.url,
                storagePath: output.storagePath,
                source: 'render',
                mimeType: 'video/mp4',
                size: output.size,
            }, { env, projectId: id, now, idGenerator });
            assets = [asset, ...assets];
        }
        record = {
            id: renderId,
            status: asset ? 'complete' : 'failed',
            requestedAt,
            completedAt: new Date().toISOString(),
            error: outcomeFailure ? outcomeFailure.message : null,
            code: outcomeFailure ? outcomeFailure.code : null,
            outputAssetId: asset ? asset.id : null,
            clipCount: output ? output.clipCount : (current.timeline?.clips?.length || 0),
            totalDuration: asset ? output.totalDuration : null,
        };
        const renders = [record, ...(Array.isArray(current.renders) ? current.renders : [])].slice(0, MAX_RENDERS);
        return asset
            ? { assets, timeline: storyboardToTimeline(current.storyboard, assets), renders }
            : { renders };
    };

    // A concurrent unqueued write (e.g. a Storyboard autosave) makes the commit
    // fail with project_conflict; the mutator re-reads, so retrying is safe.
    let project;
    for (let attempt = 1; ; attempt += 1) {
        try {
            project = await mutateCreatorProject(user, id, recordOutcome, { env, blobStore, now });
            break;
        } catch (error) {
            if (error?.code === 'project_conflict' && attempt < RENDER_COMMIT_ATTEMPTS) continue;
            if (output) await discardRenderOutput(output, { assetBlobStore, assetConfiguration });
            throw error;
        }
    }
    if (assetLimitReached) await discardRenderOutput(output, { assetBlobStore, assetConfiguration });
    const status = record.status === 'complete' ? 201 : (assetLimitReached ? 409 : failure.status);
    return { project, render: record, status };
}

export function creatorProjectStoreForTests(records = new Map(), { now = Date.now() } = {}) {
    return {
        records,
        async put(pathname, body, options = {}) {
            if (options.allowOverwrite === false && records.has(pathname)) throw new Error('blob_exists');
            const bytes = Buffer.from(typeof body === 'string' ? body : body instanceof Uint8Array ? body : String(body));
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
        async del(targets) {
            for (const target of Array.isArray(targets) ? targets : [targets]) records.delete(String(target));
        },
    };
}
