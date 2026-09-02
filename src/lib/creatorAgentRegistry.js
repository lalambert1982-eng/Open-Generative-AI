const AGENT_KEY_PATTERN = /^[a-z][a-z0-9-]{1,60}$/;

function agentDefinition({
    id,
    name,
    role,
    description,
    capabilities,
    systemPrompt,
}) {
    return Object.freeze({
        id,
        name,
        role,
        description,
        capabilities: Object.freeze([...capabilities]),
        enabled: true,
        allowedActions: Object.freeze(['respond']),
        systemPrompt: [
            systemPrompt,
            'You are a specialized worker inside G.FURY Creator Studio. Selena is the sole coordinator.',
            'Do not create, spawn, invoke, or delegate to other agents. If another specialty is needed, state that need clearly so Selena can coordinate it.',
            'Do not claim that media was generated, content was published, money was spent, assets were deleted, or any external mutation occurred unless the supplied context explicitly proves it.',
            'Return concise production-ready work plus any follow-on needs as recommendations only.',
        ].join(' '),
    });
}

export const CREATOR_AGENT_REGISTRY = Object.freeze({
    'creative-director': agentDefinition({
        id: 'creative-director',
        name: 'G.FURY Creative Director',
        role: 'creative-direction',
        description: 'Turns a creative goal into coherent direction, campaign themes, briefs, visual language, tone, and story structure.',
        capabilities: ['creative-direction', 'campaign-concepts', 'creative-briefs', 'story-structure'],
        systemPrompt: 'Act as the senior creative director. Shape the strongest coherent creative direction while keeping execution recommendations grounded in the existing Creator Studio.',
    }),
    'research-trends': agentDefinition({
        id: 'research-trends',
        name: 'G.FURY Research & Trends',
        role: 'research',
        description: 'Supports topic, trend, audience, competitive, and creative research without fabricating sources.',
        capabilities: ['research-planning', 'trend-analysis', 'audience-insight', 'competitive-analysis'],
        systemPrompt: 'Act as a verification-first research and trends specialist. Separate confirmed facts, assumptions, and evidence still needed. Never fabricate sources.',
    }),
    'content-writer': agentDefinition({
        id: 'content-writer',
        name: 'G.FURY Content Writer',
        role: 'content',
        description: 'Writes scripts, hooks, captions, titles, descriptions, newsletters, CTAs, and reusable campaign copy.',
        capabilities: ['scripts', 'hooks', 'captions', 'titles', 'descriptions', 'copywriting'],
        systemPrompt: 'Act as a production-ready content and script specialist. Write in clear reusable deliverables and offer concise variants when useful.',
    }),
    'design-director': agentDefinition({
        id: 'design-director',
        name: 'G.FURY Design Director',
        role: 'design',
        description: 'Prepares visual concepts, thumbnail direction, brand-consistent prompts, layout briefs, and Graphic Studio recommendations.',
        capabilities: ['visual-strategy', 'image-concepts', 'thumbnail-concepts', 'design-briefs'],
        systemPrompt: 'Act as a visual design director. Prepare design direction and prompts only; do not claim paid image generation or asset mutation occurred.',
    }),
    'video-director': agentDefinition({
        id: 'video-director',
        name: 'G.FURY Video Director',
        role: 'video',
        description: 'Plans scenes, shot lists, storyboard structure, continuity, motion, camera direction, and timeline-ready video concepts.',
        capabilities: ['scene-planning', 'storyboards', 'shot-lists', 'continuity', 'video-direction'],
        systemPrompt: 'Act as a video and storyboard director. Produce scene-ready plans and continuity guidance. Never claim a final rendered video exists unless context explicitly confirms it.',
    }),
    'social-producer': agentDefinition({
        id: 'social-producer',
        name: 'G.FURY Social Producer',
        role: 'social',
        description: 'Turns Project content into platform-specific Instagram, TikTok, and YouTube packages without publishing.',
        capabilities: ['social-packaging', 'platform-adaptation', 'captions', 'repurposing'],
        systemPrompt: 'Act as a social producer. Prepare platform-specific packages and publishing recommendations, but never publish or claim a post was published.',
    }),
    'marketing-strategist': agentDefinition({
        id: 'marketing-strategist',
        name: 'G.FURY Marketing Strategist',
        role: 'marketing',
        description: 'Builds campaign strategy, audience positioning, offers, funnels, launches, and distribution recommendations.',
        capabilities: ['campaign-strategy', 'positioning', 'offers', 'funnels', 'launch-planning'],
        systemPrompt: 'Act as a marketing strategist. Build practical campaigns and identify needed content, design, video, or social support for Selena to coordinate.',
    }),
    'project-producer': agentDefinition({
        id: 'project-producer',
        name: 'G.FURY Project Producer',
        role: 'project-operations',
        description: 'Reviews Project status, Asset inventory, missing deliverables, task sequence, Storyboard readiness, and publish readiness.',
        capabilities: ['project-readiness', 'asset-inventory', 'task-sequencing', 'delivery-checklists'],
        systemPrompt: 'Act as a creative project producer. Identify status, gaps, dependencies, and next steps. Do not delete Assets or perform consequential mutations.',
    }),
});

export const CREATOR_AGENT_KEYS = Object.freeze(Object.keys(CREATOR_AGENT_REGISTRY));

export const CREATOR_AGENT_SPECIALTY_MAP = Object.freeze({
    research: 'research-trends',
    trends: 'research-trends',
    script: 'content-writer',
    scripts: 'content-writer',
    copy: 'content-writer',
    content: 'content-writer',
    design: 'design-director',
    visual: 'design-director',
    video: 'video-director',
    storyboard: 'video-director',
    social: 'social-producer',
    marketing: 'marketing-strategist',
    campaign: 'marketing-strategist',
    project: 'project-producer',
    readiness: 'project-producer',
    creative: 'creative-director',
    direction: 'creative-director',
});

export class CreatorAgentRegistryError extends Error {
    constructor(code, message, status = 400) {
        super(message);
        this.name = 'CreatorAgentRegistryError';
        this.code = code;
        this.status = status;
    }
}

export function normalizeCreatorAgentKey(value) {
    const key = typeof value === 'string' ? value.trim().toLowerCase() : '';
    return AGENT_KEY_PATTERN.test(key) ? key : '';
}

export function getCreatorAgentDefinition(value, { allowDisabled = false } = {}) {
    const key = normalizeCreatorAgentKey(value);
    const definition = key ? CREATOR_AGENT_REGISTRY[key] : null;
    if (!definition) {
        throw new CreatorAgentRegistryError('unknown_agent', 'The requested Creator Agent is not registered.', 404);
    }
    if (!definition.enabled && !allowDisabled) {
        throw new CreatorAgentRegistryError('agent_disabled', 'The requested Creator Agent is disabled.', 409);
    }
    return definition;
}

export function listCreatorAgentDefinitions() {
    return CREATOR_AGENT_KEYS.map((key) => {
        const definition = CREATOR_AGENT_REGISTRY[key];
        return {
            id: definition.id,
            name: definition.name,
            role: definition.role,
            description: definition.description,
            capabilities: [...definition.capabilities],
            enabled: definition.enabled,
        };
    });
}

export function creatorAgentForSpecialty(value) {
    const specialty = typeof value === 'string' ? value.trim().toLowerCase() : '';
    const key = CREATOR_AGENT_SPECIALTY_MAP[specialty];
    return key ? getCreatorAgentDefinition(key) : null;
}
