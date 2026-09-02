import { CREATOR_AGENT_KEYS } from './creatorAgentRegistry.js';

const ACTION_ID_PATTERN = /^[a-z][a-z0-9.-]{1,80}$/;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,139}$/;
const ASPECT_RATIOS = new Set(['16:9', '9:16', '1:1', '4:5']);
const PLATFORMS = new Set(['instagram', 'tiktok', 'youtube']);
const CREATOR_AGENT_IDS = new Set(CREATOR_AGENT_KEYS);

export const SELENA_ACTION_REGISTRY = Object.freeze({
    'image.generate': Object.freeze({
        label: 'Generate Image',
        destination: '/studio/tools/image',
        requiresApproval: true,
        available: true,
        sideEffect: 'Provider generation is only submitted after the user reviews the prepared prompt.',
        fields: Object.freeze(['prompt', 'aspectRatio']),
    }),
    'video.generate': Object.freeze({
        label: 'Generate Video',
        destination: '/studio/tools/video',
        requiresApproval: true,
        available: true,
        sideEffect: 'Video generation may incur provider cost when paid generation is enabled.',
        fields: Object.freeze(['prompt', 'aspectRatio', 'duration']),
    }),
    'video.animate': Object.freeze({
        label: 'Animate Image',
        destination: '/studio/tools/video',
        requiresApproval: true,
        available: true,
        sideEffect: 'Image-to-video generation may incur provider cost when paid generation is enabled.',
        fields: Object.freeze(['prompt', 'aspectRatio', 'duration', 'assetId']),
    }),
    'graphic.open': Object.freeze({
        label: 'Open Graphic Studio',
        destination: '/studio/apps/graphic-studio',
        requiresApproval: false,
        available: true,
        sideEffect: null,
        fields: Object.freeze(['assetId']),
    }),
    'storyboard.create': Object.freeze({
        label: 'Open Scene Builder',
        destination: '/studio/apps/scene-builder',
        requiresApproval: false,
        available: true,
        sideEffect: null,
        fields: Object.freeze(['prompt', 'aspectRatio']),
    }),
    'storyboard.addScene': Object.freeze({
        label: 'Prepare Storyboard Scene',
        destination: '/studio/apps/scene-builder',
        requiresApproval: false,
        available: true,
        sideEffect: null,
        fields: Object.freeze(['prompt', 'aspectRatio', 'duration', 'assetId']),
    }),
    'workflow.open': Object.freeze({
        label: 'Open Workflows',
        destination: '/studio/workflows',
        requiresApproval: false,
        available: true,
        sideEffect: null,
        fields: Object.freeze(['workflowId']),
    }),
    'agent.open': Object.freeze({
        label: 'Open Agent Blueprints',
        destination: '/studio/advanced/agents',
        requiresApproval: false,
        available: true,
        sideEffect: null,
        fields: Object.freeze(['agentId']),
    }),
    'agent.delegate': Object.freeze({
        label: 'Delegate to Creator Agent',
        destination: '/studio/selena',
        requiresApproval: false,
        available: true,
        sideEffect: 'Delegation sends bounded Project context to one approved Creator Agent and returns the result to Selena.',
        fields: Object.freeze(['agentId', 'task', 'assetId']),
    }),
    'agent.continue': Object.freeze({
        label: 'Continue Creator Agent',
        destination: '/studio/selena',
        requiresApproval: false,
        available: true,
        sideEffect: 'Continuation sends a bounded follow-up to the same approved Creator Agent conversation.',
        fields: Object.freeze(['agentId', 'task', 'assetId', 'conversationId']),
    }),
    'asset.open': Object.freeze({
        label: 'Open Asset',
        destination: '/studio/assets',
        requiresApproval: false,
        available: true,
        sideEffect: null,
        fields: Object.freeze(['assetId']),
    }),
    'social.prepare': Object.freeze({
        label: 'Prepare Social Post',
        destination: '/studio/publish',
        requiresApproval: false,
        available: true,
        sideEffect: 'Preparation does not publish content.',
        fields: Object.freeze(['assetId', 'platform', 'caption']),
    }),
    'social.publish': Object.freeze({
        label: 'Review Social Publish',
        destination: '/studio/publish',
        requiresApproval: true,
        available: true,
        sideEffect: 'Publishing creates an external post and can incur provider cost.',
        fields: Object.freeze(['assetId', 'platform', 'caption']),
    }),
    'social.schedule': Object.freeze({
        label: 'Schedule Social Post',
        destination: '/studio/publish',
        requiresApproval: true,
        available: false,
        sideEffect: 'Scheduling is unavailable until MuAPI documents a supported REST contract.',
        fields: Object.freeze(['assetId', 'platform', 'caption']),
    }),
    'asset.delete': Object.freeze({
        label: 'Delete Asset',
        destination: '/studio/assets',
        requiresApproval: true,
        available: true,
        sideEffect: 'Deletion removes Project metadata and owned Blob media after explicit confirmation.',
        fields: Object.freeze(['assetId']),
    }),
});

export const SELENA_PLAN_SCHEMA = Object.freeze({
    type: 'object',
    additionalProperties: false,
    properties: {
        message: { type: 'string', maxLength: 12000 },
        plan: {
            type: 'array',
            maxItems: 12,
            items: { type: 'string', maxLength: 1000 },
        },
        suggestedActions: {
            type: 'array',
            maxItems: 12,
            items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    action: { type: 'string', enum: Object.keys(SELENA_ACTION_REGISTRY) },
                    label: { type: 'string', maxLength: 120 },
                    rationale: { type: 'string', maxLength: 500 },
                    parameters: { type: 'object' },
                },
                required: ['action'],
            },
        },
        referencedAssets: {
            type: 'array',
            maxItems: 20,
            items: { type: 'string', maxLength: 140 },
        },
    },
    required: ['message', 'plan', 'suggestedActions', 'referencedAssets'],
});

function text(value, maximum) {
    return typeof value === 'string' ? value.trim().slice(0, maximum) : '';
}

function opaqueId(value) {
    const id = text(value, 140);
    return OPAQUE_ID_PATTERN.test(id) ? id : '';
}

function normalizeParameters(actionId, value) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const definition = SELENA_ACTION_REGISTRY[actionId];
    const parameters = {};
    for (const field of definition.fields) {
        if (field === 'prompt') {
            const prompt = text(source.prompt, 4000);
            if (prompt) parameters.prompt = prompt;
        } else if (field === 'task') {
            const task = text(source.task, 8000);
            if (task) parameters.task = task;
        } else if (field === 'agentId') {
            const agentId = text(source.agentId, 60).toLowerCase();
            if (CREATOR_AGENT_IDS.has(agentId)) parameters.agentId = agentId;
        } else if (field === 'conversationId') {
            const id = opaqueId(source.conversationId);
            if (id) parameters.conversationId = id;
        } else if (field === 'aspectRatio') {
            if (ASPECT_RATIOS.has(source.aspectRatio)) parameters.aspectRatio = source.aspectRatio;
        } else if (field === 'duration') {
            const duration = Number(source.duration);
            if (Number.isFinite(duration)) parameters.duration = Math.min(12, Math.max(3, Math.round(duration)));
        } else if (field === 'assetId' || field === 'workflowId') {
            const id = opaqueId(source[field]);
            if (id) parameters[field] = id;
        } else if (field === 'platform') {
            const platform = text(source.platform, 20).toLowerCase();
            if (PLATFORMS.has(platform)) parameters.platform = platform;
        } else if (field === 'caption') {
            const caption = text(source.caption, 2200);
            if (caption) parameters.caption = caption;
        }
    }
    return parameters;
}

function normalizeContextAsset(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const id = opaqueId(value.id);
    const type = text(value.type, 20).toLowerCase();
    if (!id || !['image', 'video', 'voice', 'audio', 'music', 'avatar', 'graphic', 'upload'].includes(type)) return null;
    return {
        id,
        type,
        title: text(value.title, 160) || 'Untitled Asset',
        source: text(value.source, 60) || null,
    };
}

export function boundedSelenaContext({
    workspace,
    project,
    selectedAssetId,
} = {}) {
    const assets = Array.isArray(project?.assets)
        ? project.assets.map(normalizeContextAsset).filter(Boolean).slice(0, 12)
        : [];
    const selected = assets.find((asset) => asset.id === selectedAssetId) || null;
    const scenes = Array.isArray(project?.storyboard?.scenes) ? project.storyboard.scenes.slice(0, 30) : [];
    return {
        workspace: text(workspace, 80) || 'Selena',
        project: project ? {
            id: opaqueId(project.id),
            name: text(project.name, 100) || 'Untitled Project',
            objective: text(project.objective, 1000) || null,
            assetCount: assets.length,
            storyboard: {
                sceneCount: scenes.length,
                readySceneCount: scenes.filter((scene) => scene?.imageUrl || scene?.videoUrl).length,
                titles: scenes.map((scene) => text(scene?.title, 80)).filter(Boolean).slice(0, 12),
            },
        } : null,
        selectedAsset: selected,
        recentAssets: assets,
    };
}

export function buildSelenaBrainRequest(input = {}, context = {}) {
    const prompt = text(input.prompt ?? input.task, 20_000);
    if (!prompt) throw new Error('A Selena prompt is required.');
    const mode = ['strategy', 'plan', 'script', 'prompt'].includes(input.mode) ? input.mode : 'strategy';
    return {
        task: prompt,
        mode,
        agent: 'Selena',
        sensitivity: 'NORMAL',
        context,
        instructions: [
            'Return a bounded Creator Studio plan. Only suggest actions from the supplied schema.',
            'Use direct Creator actions for single obvious operations such as opening Graphic Studio or preparing one image/video generation.',
            'For specialized synthesis or strategy, prefer agent.delegate with one approved internal Creator Agent ID: research-trends for research/trends; content-writer for scripts/copy; design-director for visual strategy; video-director for video/storyboard planning; social-producer for social packaging; marketing-strategist for campaigns/marketing; project-producer for Project readiness; creative-director for overall creative direction.',
            'Selena remains the sole coordinator. Never ask one Creator Agent to spawn, invoke, or delegate to another Agent.',
            'Never invent an external Agent ID or Agent slug. Only the internal Creator Agent IDs listed above are valid model-visible identifiers.',
            'Never claim that generation, publishing, scheduling, deletion, spending, or another external action occurred.',
            'Prepare parameters for the user to review. Do not invent provider keys, URLs, asset IDs, account IDs, workflow IDs, or conversation IDs.',
            'Normal users should see AI Engine: Auto rather than provider or model selection.',
        ].join(' '),
        desiredOutput: { type: 'structured', schema: SELENA_PLAN_SCHEMA },
        allowFallback: true,
        requiresExplicitApproval: false,
        sideEffect: 'none',
    };
}

export function normalizeSelenaPlan(result = {}) {
    const source = result.structuredOutput && typeof result.structuredOutput === 'object' && !Array.isArray(result.structuredOutput)
        ? result.structuredOutput
        : {};
    const suggestedActions = [];
    const rawActions = Array.isArray(source.suggestedActions) ? source.suggestedActions.slice(0, 12) : [];
    for (const candidate of rawActions) {
        const action = text(candidate?.action, 80);
        if (!ACTION_ID_PATTERN.test(action) || !SELENA_ACTION_REGISTRY[action]) continue;
        const definition = SELENA_ACTION_REGISTRY[action];
        const parameters = normalizeParameters(action, candidate?.parameters);
        if (action.startsWith('agent.') && !parameters.agentId) continue;
        if (['agent.delegate', 'agent.continue'].includes(action) && !parameters.task) continue;
        if (action === 'agent.continue' && !parameters.conversationId) continue;
        suggestedActions.push({
            id: `${action}-${suggestedActions.length + 1}`,
            action,
            label: text(candidate?.label, 120) || definition.label,
            rationale: text(candidate?.rationale, 500),
            parameters,
            destination: definition.destination,
            available: definition.available,
            requiresApproval: definition.requiresApproval,
            sideEffect: definition.sideEffect,
        });
    }
    const plan = Array.isArray(source.plan)
        ? source.plan.map((item) => text(item, 1000)).filter(Boolean).slice(0, 12)
        : [];
    const referencedAssets = Array.isArray(source.referencedAssets)
        ? [...new Set(source.referencedAssets.map(opaqueId).filter(Boolean))].slice(0, 20)
        : [];
    const estimatedSideEffects = [...new Set(suggestedActions.map((action) => action.sideEffect).filter(Boolean))];
    return {
        message: text(source.message, 12_000) || text(result.text, 12_000) || 'I prepared the next Creator Studio steps.',
        plan,
        suggestedActions,
        referencedAssets,
        requiresApproval: suggestedActions.some((action) => action.requiresApproval),
        estimatedSideEffects,
    };
}
