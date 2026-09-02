import { evaluateJsonSafety } from './contentSafety.js';
import { appendCreatorAgentAudit, listCreatorAgentAudit } from './creatorAgentAuditStore.js';
import {
    CreatorAgentRegistryError,
    CREATOR_AGENT_KEYS,
    getCreatorAgentDefinition,
    listCreatorAgentDefinitions,
} from './creatorAgentRegistry.js';
import { authorizeCreatorRequest, creatorJson } from './creatorProviderGateway.js';
import { getCreatorProject } from './creatorProjectStore.js';
import { fetchMuapi } from './muapiProxy.js';

const MAX_REQUEST_BYTES = 32 * 1024;
const MAX_TASK_CHARACTERS = 8_000;
const MAX_CONTEXT_CHARACTERS = 16_000;
const MAX_AGENT_RESPONSE_CHARACTERS = 12_000;
const MAX_POLL_ATTEMPTS = 25;
const POLL_INTERVAL_MS = 1_000;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const ALLOWED_CLIENT_FIELDS = new Set([
    'agentId',
    'task',
    'projectId',
    'assetId',
    'conversationId',
]);
const FORBIDDEN_CLIENT_FIELDS = new Set([
    'apiKey',
    'api_key',
    'x-api-key',
    'externalAgentId',
    'external_agent_id',
    'agentSlug',
    'agent_slug',
    'providerAgentId',
]);

let ensureInFlight = null;

export class CreatorAgentError extends Error {
    constructor(code, message, status = 400, details = {}) {
        super(message);
        this.name = 'CreatorAgentError';
        this.code = code;
        this.status = status;
        this.details = details;
    }
}

function normalized(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function configuredApiKey(value) {
    const key = normalized(value);
    if (!/^[\x21-\x7E]{8,4096}$/.test(key) || /[\r\n]/.test(key)) return false;
    return !/^(?:<.*>|change-?me|placeholder|your[-_]?api[-_]?key)$/i.test(key);
}

function boundedText(value, name, maximum, { optional = false } = {}) {
    if (value == null && optional) return '';
    if (typeof value !== 'string') throw new CreatorAgentError('invalid_request', `${name} must be text.`);
    const text = value.trim();
    if (!text && !optional) throw new CreatorAgentError('invalid_request', `${name} is required.`);
    if (text.length > maximum) throw new CreatorAgentError('invalid_request', `${name} must be ${maximum} characters or fewer.`);
    return text;
}

function opaqueId(value, name, { optional = false } = {}) {
    if ((value == null || value === '') && optional) return '';
    const id = normalized(value);
    if (!OPAQUE_ID_PATTERN.test(id)) throw new CreatorAgentError('invalid_request', `${name} is invalid.`);
    return id;
}

function assertAllowedClientFields(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    for (const key of Object.keys(value)) {
        if (FORBIDDEN_CLIENT_FIELDS.has(key)) {
            throw new CreatorAgentError(
                'external_agent_id_forbidden',
                'External Agent identifiers and provider credentials are server-owned and cannot be supplied by the client.',
                400,
            );
        }
        if (!ALLOWED_CLIENT_FIELDS.has(key)) {
            throw new CreatorAgentError(
                'unknown_request_field',
                `Unsupported Creator Agent request field: ${key}.`,
                400,
            );
        }
    }
}

function safeProviderMessage(value) {
    if (typeof value !== 'string') return '';
    return value
        .replace(/[\u0000-\u001F\u007F]/g, ' ')
        .replace(/\b(?:sk|xi|key)-[A-Za-z0-9_-]{8,}\b/gi, '[redacted]')
        .trim()
        .slice(0, 400);
}

function agentConfiguration(env) {
    const keyMode = normalized(env.MUAPI_KEY_MODE).toLowerCase();
    const missing = [];
    if (!['sandbox', 'production'].includes(keyMode)) {
        missing.push('MUAPI_KEY_MODE');
    }
    const apiKeyVariable = keyMode === 'production'
        ? 'MUAPI_PRODUCTION_API_KEY'
        : keyMode === 'sandbox'
            ? 'MUAPI_API_KEY'
            : null;
    const apiKey = apiKeyVariable ? normalized(env[apiKeyVariable]) : '';
    if (apiKeyVariable && !configuredApiKey(apiKey)) missing.push(apiKeyVariable);
    if (missing.length > 0) {
        throw new CreatorAgentError(
            'agent_provider_unconfigured',
            'Creator Agent delegation requires an active server-side MuAPI Agent credential.',
            503,
            { missing },
        );
    }
    return {
        configured: true,
        apiKey,
        keyMode,
    };
}

async function readJsonResponse(response) {
    const raw = await response.text();
    if (new TextEncoder().encode(raw).byteLength > 2 * 1024 * 1024) {
        throw new CreatorAgentError('agent_provider_response_too_large', 'MuAPI returned an oversized Agent response.', 502);
    }
    try {
        return raw ? JSON.parse(raw) : {};
    } catch {
        throw new CreatorAgentError('agent_provider_invalid_response', 'MuAPI returned an invalid Agent response.', 502);
    }
}

function providerError(response, value) {
    const detail = safeProviderMessage(value?.detail?.error || value?.detail || value?.error || value?.message || '');
    if (response.status === 401 || response.status === 403) {
        return new CreatorAgentError('agent_provider_credentials', 'MuAPI rejected the configured Agent credentials.', 502);
    }
    if (response.status === 404) {
        return new CreatorAgentError('agent_provider_not_found', 'The configured MuAPI Agent could not be found.', 502);
    }
    if (response.status === 429) {
        return new CreatorAgentError('agent_provider_rate_limit', 'MuAPI Agent rate or account limits were reached.', 429, detail ? { detail } : {});
    }
    if ([400, 409, 422].includes(response.status)) {
        return new CreatorAgentError('agent_provider_rejected', 'MuAPI rejected the Agent request.', 422, detail ? { detail } : {});
    }
    return new CreatorAgentError('agent_provider_unavailable', 'MuAPI Agent service is temporarily unavailable.', 502, detail ? { detail } : {});
}

async function callMuapi({
    prefix = 'agents',
    pathSegments = [],
    method = 'GET',
    body,
    env = process.env,
    fetchImpl = fetch,
}) {
    const configuration = agentConfiguration(env);
    const request = new Request('https://creator-agent.internal/request', {
        method,
        headers: body == null ? {} : { 'content-type': 'application/json' },
        ...(body == null ? {} : { body: JSON.stringify(body) }),
    });
    const result = await fetchMuapi(request, {
        prefix,
        pathSegments,
        method,
        env,
        requireApiKey: false,
        apiKeyOverride: configuration.apiKey,
        fetchImpl,
    });
    const response = result.response;
    const value = await readJsonResponse(response);
    if (!response.ok) throw providerError(response, value);
    return value;
}

function externalAgentList(value) {
    if (Array.isArray(value)) return value;
    if (Array.isArray(value?.agents)) return value.agents;
    if (Array.isArray(value?.items)) return value.items;
    return [];
}

function externalAgentName(value) {
    return normalized(value?.name);
}

function externalAgentSlug(value) {
    const candidate = normalized(value?.agent_id || value?.slug || value?.id);
    return OPAQUE_ID_PATTERN.test(candidate) ? candidate : '';
}

function findExternalAgent(agents, definition) {
    const wanted = definition.name.toLowerCase();
    return agents.find((agent) => externalAgentName(agent).toLowerCase() === wanted) || null;
}

async function listExternalAgents(options = {}) {
    return externalAgentList(await callMuapi({
        ...options,
        prefix: 'agents',
        pathSegments: ['user', 'agents'],
        method: 'GET',
    }));
}

async function createExternalAgent(definition, options = {}) {
    return callMuapi({
        ...options,
        prefix: 'agents',
        pathSegments: [],
        method: 'POST',
        body: {
            name: definition.name,
            description: `[GFURY_CREATOR_AGENT:${definition.id}] ${definition.description}`,
            system_prompt: definition.systemPrompt,
            welcome_message: `I'm ${definition.name}. Selena can delegate ${definition.role} work to me.`,
            skill_ids: [],
        },
    });
}

export async function ensureCreatorAgents({
    env = process.env,
    fetchImpl = fetch,
} = {}) {
    if (ensureInFlight) return ensureInFlight;
    ensureInFlight = (async () => {
        const existing = await listExternalAgents({ env, fetchImpl });
        const working = [...existing];
        const results = [];
        for (const key of CREATOR_AGENT_KEYS) {
            const definition = getCreatorAgentDefinition(key);
            const found = findExternalAgent(working, definition);
            if (found) {
                results.push({ id: definition.id, name: definition.name, status: 'ready' });
                continue;
            }
            const created = await createExternalAgent(definition, { env, fetchImpl });
            const createdAgent = created?.agent || created?.data || created;
            working.push(createdAgent);
            results.push({ id: definition.id, name: definition.name, status: 'created' });
        }
        return results;
    })();
    try {
        return await ensureInFlight;
    } finally {
        ensureInFlight = null;
    }
}

async function resolveExternalAgent(definition, options = {}) {
    const agents = await listExternalAgents(options);
    const found = findExternalAgent(agents, definition);
    const slug = externalAgentSlug(found);
    if (!found || !slug) {
        throw new CreatorAgentError(
            'agent_not_provisioned',
            `${definition.name} has not been provisioned in the connected MuAPI Agent account.`,
            409,
        );
    }
    return { slug };
}

function contextAsset(asset) {
    if (!asset || typeof asset !== 'object') return null;
    const id = normalized(asset.id);
    if (!id) return null;
    return {
        id,
        type: normalized(asset.type).slice(0, 30) || null,
        title: normalized(asset.title).slice(0, 160) || 'Untitled Asset',
        source: normalized(asset.source).slice(0, 60) || null,
    };
}

async function boundedProjectContext(user, projectId, assetId, {
    env = process.env,
    blobStore,
    auditBlobStore,
} = {}) {
    const project = await getCreatorProject(user, projectId, { env, blobStore });
    const recentAssets = Array.isArray(project.assets)
        ? project.assets.map(contextAsset).filter(Boolean).slice(0, 8)
        : [];
    let selectedAsset = null;
    if (assetId) {
        selectedAsset = recentAssets.find((asset) => asset.id === assetId) ||
            (Array.isArray(project.assets) ? contextAsset(project.assets.find((asset) => asset?.id === assetId)) : null);
        if (!selectedAsset) {
            throw new CreatorAgentError('asset_not_owned', 'The selected Asset does not belong to this Project.', 403);
        }
    }
    const scenes = Array.isArray(project?.storyboard?.scenes) ? project.storyboard.scenes.slice(0, 30) : [];
    const priorAudit = await listCreatorAgentAudit(user, project.id, {
        env,
        ...(auditBlobStore ? { blobStore: auditBlobStore } : {}),
    });
    const context = {
        project: {
            id: project.id,
            name: normalized(project.name).slice(0, 100) || 'Untitled Project',
            objective: normalized(project.objective).slice(0, 1000) || null,
        },
        selectedAsset,
        recentAssets,
        storyboard: {
            sceneCount: scenes.length,
            readySceneCount: scenes.filter((scene) => scene?.imageUrl || scene?.videoUrl).length,
            titles: scenes.map((scene) => normalized(scene?.title).slice(0, 80)).filter(Boolean).slice(0, 12),
        },
        priorAgentResultSummaries: priorAudit
            .filter((record) => record.status === 'completed')
            .slice(0, 6)
            .map((record) => ({
                agentId: record.agentId,
                agentName: record.agentName,
                resultSummary: record.resultSummary.slice(0, 1000),
            })),
    };
    let serialized = JSON.stringify(context);
    if (serialized.length > MAX_CONTEXT_CHARACTERS) {
        context.recentAssets = context.recentAssets.slice(0, 4);
        context.priorAgentResultSummaries = context.priorAgentResultSummaries.slice(0, 3).map((item) => ({
            ...item,
            resultSummary: item.resultSummary.slice(0, 500),
        }));
        serialized = JSON.stringify(context);
    }
    if (serialized.length > MAX_CONTEXT_CHARACTERS) {
        throw new CreatorAgentError('agent_context_too_large', 'Project context is too large to delegate safely.', 413);
    }
    return { project, context };
}

function textFromContent(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content
            .map((part) => typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : '')
            .filter(Boolean)
            .join('\n');
    }
    return '';
}

function safeHttpsUrl(value) {
    if (typeof value !== 'string' || value.length > 4096) return '';
    try {
        const url = new URL(value);
        if (url.protocol !== 'https:' || url.username || url.password || url.hash) return '';
        return url.toString();
    } catch {
        return '';
    }
}

function normalizedArtifacts(value) {
    const source = Array.isArray(value) ? value.slice(0, 8) : [];
    return source.map((artifact) => {
        if (!artifact || typeof artifact !== 'object') return null;
        const url = safeHttpsUrl(artifact.url || artifact.output_url || '');
        if (!url) return null;
        return {
            type: normalized(artifact.type).slice(0, 30) || 'external',
            title: normalized(artifact.title || artifact.name).slice(0, 160) || 'Agent artifact',
            url,
        };
    }).filter(Boolean);
}

function normalizedSuggestions(value) {
    const source = Array.isArray(value) ? value.slice(0, 8) : [];
    return source.map((item) => {
        if (typeof item === 'string') return item.trim().slice(0, 500);
        return normalized(item?.text || item?.title || item?.label).slice(0, 500);
    }).filter(Boolean);
}

function normalizeAgentResult(definition, result, selectedAsset) {
    const messages = Array.isArray(result?.messages) ? result.messages : [];
    const assistant = [...messages].reverse().find((message) => message?.role === 'assistant');
    const message = boundedText(
        textFromContent(assistant?.content) || normalized(result?.message) || 'The Agent completed the delegated task.',
        'Agent result',
        MAX_AGENT_RESPONSE_CHARACTERS,
    );
    const conversationId = opaqueId(result?.conversation_id || result?.conversationId, 'Agent conversation ID', { optional: true });
    return {
        agentId: definition.id,
        agentName: definition.name,
        conversationId: conversationId || null,
        status: result?.is_complete === false ? 'processing' : 'completed',
        message,
        artifacts: normalizedArtifacts(result?.artifacts || result?.outputs),
        suggestedActions: normalizedSuggestions(result?.suggestions),
        referencedAssets: selectedAsset ? [selectedAsset.id] : [],
    };
}

async function pollAgentResult(requestId, {
    env = process.env,
    fetchImpl = fetch,
    maxAttempts = MAX_POLL_ATTEMPTS,
    intervalMs = POLL_INTERVAL_MS,
} = {}) {
    const id = opaqueId(requestId, 'Agent request ID');
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        if (attempt > 1) await new Promise((resolve) => setTimeout(resolve, intervalMs));
        const result = await callMuapi({
            prefix: 'api/v1/predictions',
            pathSegments: [id, 'result'],
            method: 'GET',
            env,
            fetchImpl,
        });
        if (result?.is_complete === true) return result;
    }
    throw new CreatorAgentError('agent_timeout', 'The delegated Agent did not finish within the safe request window.', 504);
}

export async function delegateCreatorAgent(user, input = {}, {
    env = process.env,
    fetchImpl = fetch,
    blobStore,
    auditBlobStore,
    pollOptions = {},
} = {}) {
    assertAllowedClientFields(input);
    const definition = getCreatorAgentDefinition(input.agentId);
    const task = boundedText(input.task, 'Agent task', MAX_TASK_CHARACTERS);
    const projectId = opaqueId(input.projectId, 'Project ID');
    const assetId = opaqueId(input.assetId, 'Asset ID', { optional: true });
    const conversationId = opaqueId(input.conversationId, 'Conversation ID', { optional: true });
    const { project, context } = await boundedProjectContext(user, projectId, assetId, {
        env,
        blobStore,
        auditBlobStore,
    });
    const external = await resolveExternalAgent(definition, { env, fetchImpl });

    await appendCreatorAgentAudit(user, project.id, {
        agentId: definition.id,
        agentName: definition.name,
        conversationId: conversationId || null,
        taskSummary: task,
        resultSummary: '',
        status: 'requested',
        createdAt: new Date().toISOString(),
    }, {
        env,
        ...(auditBlobStore ? { blobStore: auditBlobStore } : {}),
    });

    const delegatedMessage = [
        `Creator task:\n${task}`,
        `Bounded Project context:\n${JSON.stringify(context)}`,
        'Return your specialist result to Selena. Recommendations for other specialties are allowed, but do not invoke other agents or execute consequential Creator actions.',
    ].join('\n\n');
    const submitted = await callMuapi({
        prefix: 'agents',
        pathSegments: ['by-slug', external.slug, 'chat'],
        method: 'POST',
        body: {
            message: delegatedMessage,
            conversation_id: conversationId || null,
            attachments: null,
            stream: false,
        },
        env,
        fetchImpl,
    });
    const requestId = opaqueId(submitted?.request_id || submitted?.requestId, 'Agent request ID');
    const completed = await pollAgentResult(requestId, {
        env,
        fetchImpl,
        ...pollOptions,
    });
    const result = normalizeAgentResult(definition, completed, context.selectedAsset);

    await appendCreatorAgentAudit(user, project.id, {
        agentId: definition.id,
        agentName: definition.name,
        conversationId: result.conversationId,
        taskSummary: task,
        resultSummary: result.message,
        status: result.status,
        createdAt: new Date().toISOString(),
    }, {
        env,
        ...(auditBlobStore ? { blobStore: auditBlobStore } : {}),
    });
    return result;
}

async function parseJson(request, env) {
    const declared = Number(request.headers.get('content-length') || 0);
    if (declared > MAX_REQUEST_BYTES) throw new CreatorAgentError('request_too_large', 'Creator Agent request is too large.', 413);
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > MAX_REQUEST_BYTES) {
        throw new CreatorAgentError('request_too_large', 'Creator Agent request is too large.', 413);
    }
    let value;
    try {
        value = JSON.parse(raw || '{}');
    } catch {
        throw new CreatorAgentError('invalid_json', 'A valid JSON request body is required.');
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new CreatorAgentError('invalid_json', 'Creator Agent request must be a JSON object.');
    }
    assertAllowedClientFields(value);
    const safety = evaluateJsonSafety(raw || '{}', { env });
    if (!safety.allowed) {
        throw new CreatorAgentError('content_safety', 'Creator Agent request was blocked by the content safety policy.', 422);
    }
    return value;
}

function failure(error) {
    if (error instanceof CreatorAgentRegistryError || error instanceof CreatorAgentError) {
        return creatorJson({
            error: error.message,
            code: error.code,
            ...(error.details?.missing ? { missing: error.details.missing } : {}),
        }, error.status);
    }
    return creatorJson({ error: 'Creator Agent service is temporarily unavailable.', code: 'agent_unavailable' }, 503);
}

export async function handleCreatorAgentRoute(request, {
    path = [],
    method = request.method,
    env = process.env,
    fetchImpl = fetch,
    blobStore,
    auditBlobStore,
    pollOptions,
} = {}) {
    const normalizedMethod = String(method || 'GET').toUpperCase();
    const action = `agents-${normalizedMethod.toLowerCase()}-${path.join('-') || 'list'}`;
    const auth = authorizeCreatorRequest(request, {
        env,
        action,
        statusRequest: normalizedMethod === 'GET',
    });
    if (auth.response) return auth.response;

    try {
        if (normalizedMethod === 'GET' && path.length === 0) {
            const definitions = listCreatorAgentDefinitions();
            const existing = await listExternalAgents({ env, fetchImpl });
            const agents = definitions.map((definition) => ({
                ...definition,
                provisioned: Boolean(findExternalAgent(existing, definition)),
            }));
            return creatorJson({ agents });
        }
        if (normalizedMethod === 'POST' && path.length === 1 && path[0] === 'ensure') {
            const results = await ensureCreatorAgents({ env, fetchImpl });
            return creatorJson({ agents: results });
        }
        if (normalizedMethod === 'POST' && path.length === 1 && ['delegate', 'continue'].includes(path[0])) {
            const input = await parseJson(request, env);
            if (path[0] === 'continue' && !normalized(input.conversationId)) {
                throw new CreatorAgentError('conversation_required', 'Agent continuation requires a conversation ID.');
            }
            const result = await delegateCreatorAgent(auth.user, input, {
                env,
                fetchImpl,
                blobStore,
                auditBlobStore,
                pollOptions,
            });
            return creatorJson({ result });
        }
        return creatorJson({ error: 'Creator Agent route not found.', code: 'agent_route_not_found' }, 404);
    } catch (error) {
        return failure(error);
    }
}