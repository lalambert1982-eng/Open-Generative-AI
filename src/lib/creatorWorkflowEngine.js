import { randomUUID } from 'node:crypto';

import { storyboardToTimeline } from './creatorTimeline.js';
import {
    CreatorProjectError,
    mutateCreatorProject,
    safeCreatorAssetUrl,
} from './creatorProjectStore.js';
import {
    createMuapiImageJob,
    createMuapiVideoJob,
    getMuapiGenerationJob,
} from './muapiCreatorProvider.js';

// Workflow Execution V1 is an execution layer over the existing Creator Project /
// Asset system. It intentionally reuses the same Blob-backed project record
// (mutateCreatorProject) and the same async job primitives already used by the
// direct image/video tools (createMuapiImageJob/createMuapiVideoJob/
// getMuapiGenerationJob) instead of introducing a new orchestration framework.
//
// V1 node kinds are limited to the MuAPI image/video job family, which share one
// uniform submit/poll/URL shape. HeyGen, ElevenLabs, OpenAI and Runway all return
// either binary payloads or need additional identity inputs (avatar/voice IDs,
// script text) that don't fit this uniform shape yet — adding them is future work,
// not a stub started here.
export const WORKFLOW_RUN_STATUSES = Object.freeze([
    'queued',
    'running',
    'waiting_for_approval',
    'completed',
    'failed',
    'cancelled',
]);

export const WORKFLOW_NODE_STATUSES = Object.freeze([
    'pending',
    'waiting_for_approval',
    'running',
    'completed',
    'failed',
]);

const WORKFLOW_NODE_KINDS = new Set(['image.generate', 'video.generate', 'video.animate']);
const ASPECT_RATIOS = new Set(['16:9', '9:16', '1:1']);
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,139}$/;

const MAX_WORKFLOW_RUNS = 20;
const MAX_WORKFLOW_NODES = 20;
// Mirrors creatorProjectStore's own MAX_ASSETS cap; kept local so this module
// doesn't need to reach into that file's private constants.
const MAX_PROJECT_ASSETS = 500;

export class CreatorWorkflowError extends CreatorProjectError {
    constructor(code, message, status = 400) {
        super(code, message, status);
        this.name = 'CreatorWorkflowError';
    }
}

function text(value, maximum) {
    return typeof value === 'string' ? value.trim().slice(0, maximum) : '';
}

function boundedInteger(value, fallback, minimum, maximum) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(maximum, Math.max(minimum, Math.round(parsed)));
}

function iso(now) {
    return new Date(now).toISOString();
}

function replaceAt(list, index, value) {
    const next = list.slice();
    next[index] = value;
    return next;
}

function normalizeNodeInput(kind, source, index) {
    const value = source && typeof source === 'object' && !Array.isArray(source) ? source : {};
    const prompt = text(value.prompt, 4000);
    if (!prompt) throw new CreatorWorkflowError('invalid_workflow_node', `Node ${index + 1} requires a prompt.`);
    const aspectRatio = ASPECT_RATIOS.has(value.aspectRatio) ? value.aspectRatio : '16:9';
    const inputs = { prompt, aspectRatio };
    if (kind === 'video.generate' || kind === 'video.animate') {
        inputs.duration = boundedInteger(value.duration, 5, 3, 12);
    }
    if (kind === 'video.animate') {
        const sourceNodeIndex = Number(value.sourceNodeIndex);
        if (!Number.isInteger(sourceNodeIndex) || sourceNodeIndex < 0 || sourceNodeIndex >= index) {
            throw new CreatorWorkflowError(
                'invalid_workflow_node',
                `Node ${index + 1} must reference an earlier node in this run as its image source.`,
            );
        }
        inputs.sourceNodeIndex = sourceNodeIndex;
    }
    const sceneId = text(value.sceneId, 140);
    if (sceneId) {
        if (!OPAQUE_ID_PATTERN.test(sceneId)) {
            throw new CreatorWorkflowError('invalid_workflow_node', `Node ${index + 1} has an invalid scene reference.`);
        }
        inputs.sceneId = sceneId;
    }
    return inputs;
}

function buildNode(kind, source, index, { idGenerator, now }) {
    const normalizedKind = text(kind, 40);
    if (!WORKFLOW_NODE_KINDS.has(normalizedKind)) {
        throw new CreatorWorkflowError('invalid_workflow_node', `Node ${index + 1} has an unsupported kind.`);
    }
    const inputs = normalizeNodeInput(normalizedKind, source, index);
    return {
        id: idGenerator(),
        kind: normalizedKind,
        label: text(source?.label, 120) || `Step ${index + 1}`,
        inputs,
        status: 'pending',
        approved: false,
        jobId: null,
        providerKind: null,
        outputAssetId: null,
        outputUrl: null,
        error: null,
        startedAt: null,
        completedAt: null,
        createdAt: iso(now),
    };
}

function buildRun({ projectId, name, nodesInput, source, idGenerator, now }) {
    if (!Array.isArray(nodesInput) || nodesInput.length === 0) {
        throw new CreatorWorkflowError('invalid_workflow_input', 'A workflow run requires at least one node.');
    }
    if (nodesInput.length > MAX_WORKFLOW_NODES) {
        throw new CreatorWorkflowError('invalid_workflow_input', `A workflow run supports at most ${MAX_WORKFLOW_NODES} nodes.`);
    }
    const nodes = nodesInput.map((nodeInput, index) => buildNode(nodeInput?.kind, nodeInput, index, { idGenerator, now }));
    const timestamp = iso(now);
    return {
        id: idGenerator(),
        projectId,
        name: text(name, 100) || 'Untitled Workflow',
        status: 'queued',
        source: source === 'storyboard' ? 'storyboard' : 'manual',
        currentNodeIndex: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
        nodes,
    };
}

function buildWorkflowRunFromStoryboardScenes(project, { sceneIds, name } = {}, { idGenerator, now }) {
    const scenes = Array.isArray(project?.storyboard?.scenes) ? project.storyboard.scenes : [];
    const requested = Array.isArray(sceneIds) && sceneIds.length
        ? new Set(sceneIds.map((id) => text(id, 140)))
        : null;
    const selected = (requested ? scenes.filter((scene) => requested.has(scene.id)) : scenes).slice(0, MAX_WORKFLOW_NODES);
    if (selected.length === 0) {
        throw new CreatorWorkflowError('invalid_workflow_input', 'The Storyboard has no scenes available to build a workflow from.');
    }
    const nodesInput = selected.map((scene) => ({
        kind: 'image.generate',
        label: text(scene.title, 120),
        prompt: scene.prompt,
        aspectRatio: scene.aspectRatio,
        sceneId: scene.id,
    }));
    return buildRun({
        projectId: project.id,
        name: name || 'Storyboard Workflow',
        nodesInput,
        source: 'storyboard',
        idGenerator,
        now,
    });
}

function providerKindFor(node) {
    return node.kind === 'image.generate' ? 'image' : 'video';
}

function resolveNodeInputs(node, run) {
    if (node.kind !== 'video.animate') return node.inputs;
    const source = run.nodes[node.inputs.sourceNodeIndex];
    if (!source || source.status !== 'completed' || !source.outputUrl) {
        throw new CreatorWorkflowError(
            'missing_upstream_output',
            'The upstream node output required for this step is not ready yet.',
            409,
        );
    }
    return { ...node.inputs, firstFrameUrl: source.outputUrl };
}

async function submitNode(node, resolvedInputs, { env, fetchImpl }) {
    if (node.kind === 'image.generate') {
        return createMuapiImageJob({
            prompt: resolvedInputs.prompt,
            aspectRatio: resolvedInputs.aspectRatio,
        }, { env, fetchImpl });
    }
    return createMuapiVideoJob({
        prompt: resolvedInputs.prompt,
        aspectRatio: resolvedInputs.aspectRatio,
        duration: resolvedInputs.duration,
        firstFrameUrl: resolvedInputs.firstFrameUrl || undefined,
    }, { env, fetchImpl });
}

async function pollNode(node, { env, fetchImpl }) {
    return getMuapiGenerationJob(node.jobId, node.providerKind || providerKindFor(node), { env, fetchImpl });
}

function buildAssetRecord(job, node, project, { idGenerator, now, env }) {
    const url = safeCreatorAssetUrl(job.url, { env });
    return {
        id: idGenerator(),
        projectId: project.id,
        type: node.kind === 'image.generate' ? 'image' : 'video',
        title: node.label || 'Workflow output',
        url,
        storagePath: null,
        source: 'workflow',
        mimeType: null,
        size: 0,
        provider: {
            provider: 'muapi',
            model: job.model || null,
            requestId: job.jobId || null,
            keyMode: job.keyMode || null,
        },
        createdAt: iso(now),
    };
}

function findRunIndex(project, runId) {
    const runs = Array.isArray(project.workflowRuns) ? project.workflowRuns : [];
    const index = runs.findIndex((item) => item.id === runId);
    if (index === -1) throw new CreatorWorkflowError('workflow_not_found', 'Workflow run was not found.', 404);
    return { runs, index };
}

export function findWorkflowRun(project, runId) {
    const runs = Array.isArray(project?.workflowRuns) ? project.workflowRuns : [];
    return runs.find((item) => item.id === runId) || null;
}

export async function createWorkflowRun(user, projectId, input = {}, options = {}) {
    const { idGenerator = randomUUID, now = Date.now() } = options;
    const runId = idGenerator();
    let createdRun = null;
    const project = await mutateCreatorProject(user, projectId, (proj) => {
        const runs = Array.isArray(proj.workflowRuns) ? proj.workflowRuns : [];
        if (runs.length >= MAX_WORKFLOW_RUNS) {
            throw new CreatorWorkflowError('workflow_limit', `A Project supports at most ${MAX_WORKFLOW_RUNS} workflow runs.`, 409);
        }
        const run = input.source === 'storyboard'
            ? buildWorkflowRunFromStoryboardScenes(proj, input, { idGenerator, now })
            : buildRun({
                projectId: proj.id,
                name: input.name,
                nodesInput: input.nodes,
                source: input.source,
                idGenerator,
                now,
            });
        // Pin the pre-generated runId so the caller can find this run after the
        // mutation resolves, regardless of which builder produced it.
        run.id = runId;
        createdRun = run;
        return { workflowRuns: [run, ...runs] };
    }, options);
    return { project, run: createdRun || findWorkflowRun(project, runId) };
}

async function step(user, projectId, runId, transition, options = {}) {
    const { env = process.env, fetchImpl = fetch, idGenerator = randomUUID, now = Date.now() } = options;
    let outcome = { changed: false, reason: null };
    const project = await mutateCreatorProject(user, projectId, async (proj) => {
        const { runs, index } = findRunIndex(proj, runId);
        const run = runs[index];
        const result = await transition(run, proj, { env, fetchImpl, idGenerator, now });
        if (!result) {
            outcome = { changed: false, reason: 'no_change', run };
            return null;
        }
        outcome = { changed: true, reason: result.reason, run: result.run };
        const patch = { workflowRuns: replaceAt(runs, index, result.run) };
        if (result.asset) {
            const assets = Array.isArray(proj.assets) ? proj.assets : [];
            if (assets.length >= MAX_PROJECT_ASSETS) {
                throw new CreatorWorkflowError('asset_limit', `A Project supports at most ${MAX_PROJECT_ASSETS} Assets.`, 409);
            }
            const nextAssets = [result.asset, ...assets];
            patch.assets = nextAssets;
            patch.timeline = storyboardToTimeline(proj.storyboard, nextAssets);
        }
        return patch;
    }, options);
    const run = outcome.run || findWorkflowRun(project, runId);
    return { project, run, changed: outcome.changed, reason: outcome.reason };
}

export async function advanceWorkflowRun(user, projectId, runId, options = {}) {
    return step(user, projectId, runId, async (run, project, ctx) => {
        const { env, fetchImpl, idGenerator, now } = ctx;
        if (!['queued', 'running'].includes(run.status)) return null;

        if (run.currentNodeIndex >= run.nodes.length) {
            return { reason: 'run_completed', run: { ...run, status: 'completed', updatedAt: iso(now) } };
        }

        const nodeIndex = run.currentNodeIndex;
        const node = run.nodes[nodeIndex];

        if (node.status === 'pending') {
            if (!node.approved) {
                const updatedNode = { ...node, status: 'waiting_for_approval' };
                return {
                    reason: 'approval_required',
                    run: { ...run, status: 'waiting_for_approval', nodes: replaceAt(run.nodes, nodeIndex, updatedNode), updatedAt: iso(now) },
                };
            }

            let resolvedInputs;
            try {
                resolvedInputs = resolveNodeInputs(node, run);
            } catch (resolveError) {
                const updatedNode = { ...node, status: 'failed', error: resolveError.message, completedAt: iso(now) };
                return {
                    reason: 'node_failed',
                    run: { ...run, status: 'failed', nodes: replaceAt(run.nodes, nodeIndex, updatedNode), updatedAt: iso(now) },
                };
            }

            const result = await submitNode(node, resolvedInputs, { env, fetchImpl });
            if (!result.ok) {
                const updatedNode = { ...node, status: 'failed', error: result.error || 'Provider error.', completedAt: iso(now) };
                return {
                    reason: 'node_failed',
                    run: { ...run, status: 'failed', nodes: replaceAt(run.nodes, nodeIndex, updatedNode), updatedAt: iso(now) },
                };
            }

            const job = result.job;
            if (job.status === 'completed' && job.url) {
                return completeNode({ run, nodeIndex, node, job, project, idGenerator, now, env });
            }
            const updatedNode = {
                ...node,
                status: 'running',
                jobId: job.jobId || null,
                providerKind: job.kind || providerKindFor(node),
                startedAt: iso(now),
            };
            return {
                reason: 'node_submitted',
                run: { ...run, status: 'running', nodes: replaceAt(run.nodes, nodeIndex, updatedNode), updatedAt: iso(now) },
            };
        }

        if (node.status === 'running') {
            const result = await pollNode(node, { env, fetchImpl });
            if (!result.ok) {
                const updatedNode = { ...node, status: 'failed', error: result.error || 'Provider error.', completedAt: iso(now) };
                return {
                    reason: 'node_failed',
                    run: { ...run, status: 'failed', nodes: replaceAt(run.nodes, nodeIndex, updatedNode), updatedAt: iso(now) },
                };
            }
            const job = result.job;
            if (job.status === 'completed' && job.url) {
                return completeNode({ run, nodeIndex, node, job, project, idGenerator, now, env });
            }
            if (job.status === 'failed') {
                const updatedNode = { ...node, status: 'failed', error: job.error || 'Generation failed.', completedAt: iso(now) };
                return {
                    reason: 'node_failed',
                    run: { ...run, status: 'failed', nodes: replaceAt(run.nodes, nodeIndex, updatedNode), updatedAt: iso(now) },
                };
            }
            return null; // still processing; nothing to persist yet
        }

        // waiting_for_approval or failed nodes require an explicit approve/retry call.
        return null;
    }, options);
}

function completeNode({ run, nodeIndex, node, job, project, idGenerator, now, env }) {
    let asset;
    try {
        asset = buildAssetRecord(job, node, project, { idGenerator, now, env });
    } catch (urlError) {
        const updatedNode = { ...node, status: 'failed', error: 'Provider returned an invalid output URL.', completedAt: iso(now) };
        return {
            reason: 'node_failed',
            run: { ...run, status: 'failed', nodes: replaceAt(run.nodes, nodeIndex, updatedNode), updatedAt: iso(now) },
        };
    }
    const updatedNode = {
        ...node,
        status: 'completed',
        outputAssetId: asset.id,
        outputUrl: asset.url,
        startedAt: node.startedAt || iso(now),
        completedAt: iso(now),
    };
    const nextIndex = nodeIndex + 1;
    const runCompleted = nextIndex >= run.nodes.length;
    return {
        reason: 'node_completed',
        asset,
        run: {
            ...run,
            status: runCompleted ? 'completed' : 'running',
            currentNodeIndex: nextIndex,
            nodes: replaceAt(run.nodes, nodeIndex, updatedNode),
            updatedAt: iso(now),
        },
    };
}

export async function approveWorkflowNode(user, projectId, runId, options = {}) {
    return step(user, projectId, runId, async (run, _project, { now }) => {
        if (run.status !== 'waiting_for_approval') return null;
        const nodeIndex = run.currentNodeIndex;
        const node = run.nodes[nodeIndex];
        if (!node || node.status !== 'waiting_for_approval') return null;
        const updatedNode = { ...node, status: 'pending', approved: true };
        return {
            reason: 'node_approved',
            run: { ...run, status: 'running', nodes: replaceAt(run.nodes, nodeIndex, updatedNode), updatedAt: iso(now) },
        };
    }, options);
}

export async function approveAndAdvanceWorkflowRun(user, projectId, runId, options = {}) {
    const approved = await approveWorkflowNode(user, projectId, runId, options);
    if (!approved.changed) return approved;
    return advanceWorkflowRun(user, projectId, runId, options);
}

export async function retryWorkflowNode(user, projectId, runId, options = {}) {
    return step(user, projectId, runId, async (run, _project, { now }) => {
        if (run.status !== 'failed') return null;
        const nodeIndex = run.nodes.findIndex((node) => node.status === 'failed');
        if (nodeIndex === -1) return null;
        const node = run.nodes[nodeIndex];
        // Completed nodes before this one are left untouched: retry never
        // re-submits already-finished work.
        const updatedNode = {
            ...node,
            status: 'pending',
            error: null,
            jobId: null,
            providerKind: null,
            startedAt: null,
            completedAt: null,
        };
        return {
            reason: 'node_retried',
            run: { ...run, status: 'running', currentNodeIndex: nodeIndex, nodes: replaceAt(run.nodes, nodeIndex, updatedNode), updatedAt: iso(now) },
        };
    }, options);
}

export async function cancelWorkflowRun(user, projectId, runId, options = {}) {
    return step(user, projectId, runId, async (run, _project, { now }) => {
        if (['completed', 'failed', 'cancelled'].includes(run.status)) return null;
        return {
            reason: 'run_cancelled',
            run: { ...run, status: 'cancelled', updatedAt: iso(now) },
        };
    }, options);
}
