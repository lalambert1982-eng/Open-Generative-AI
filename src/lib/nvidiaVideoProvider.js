import { NVIDIA_VIDEO_TOOL_ID } from './creatorToolRegistry.js';

const NVIDIA_SHARED_KEY_VARIABLE = 'NVIDIA_API_KEY';
const NVIDIA_RELIGHTING_TARGET = 'grpc.nvcf.nvidia.com:443';
const NVIDIA_RELIGHTING_FUNCTION_ID = '253bc77f-2d6c-4b9d-86c6-c6fb0f9e239c';

// This registry intentionally separates credential linking from execution.
// All entries authenticate with the same server-side NVIDIA_API_KEY used by
// the Selena Brain and NVIDIA Image provider, but each NVIDIA media service
// has a different transport/runtime contract.
//
// Cosmos3 Nano is listed by NVIDIA Build as a Free Endpoint, but its public
// Build page currently marks external API usage as "Coming Soon" and does not
// publish a stable hosted request URL/contract. Relighting publishes a hosted
// preview gRPC target/function ID. Video Super Resolution is currently exposed
// as a downloadable NIM rather than a documented public hosted endpoint.
//
// Do not guess or synthesize endpoint URLs. A model becomes executable here
// only after NVIDIA publishes a stable contract that we can test.
const NVIDIA_VIDEO_MODEL_REGISTRY = Object.freeze({
    'cosmos3-nano': Object.freeze({
        id: 'cosmos3-nano',
        upstreamModel: 'nvidia/Cosmos3-Nano',
        label: 'NVIDIA Cosmos3 Nano',
        capability: 'Physics-aware text-to-video and image-to-video generation',
        capabilities: Object.freeze(['text-to-video', 'image-to-video', 'video-with-sound']),
        credentialVariable: NVIDIA_SHARED_KEY_VARIABLE,
        access: 'free-endpoint',
        transport: 'hosted-preview',
        executable: false,
        blockedReason: 'NVIDIA Build currently marks the external hosted API contract as Coming Soon.',
    }),
    relighting: Object.freeze({
        id: 'relighting',
        label: 'NVIDIA Relighting',
        capability: 'Re-light a person in video using NVIDIA AI for Media',
        capabilities: Object.freeze(['video-relighting']),
        credentialVariable: NVIDIA_SHARED_KEY_VARIABLE,
        access: 'preview-grpc',
        transport: 'grpc',
        target: NVIDIA_RELIGHTING_TARGET,
        functionId: NVIDIA_RELIGHTING_FUNCTION_ID,
        executable: false,
        blockedReason: 'Requires the NVIDIA AI for Media gRPC client/runtime; Creator Studio currently has no server-side gRPC media worker.',
    }),
    vsr: Object.freeze({
        id: 'vsr',
        label: 'NVIDIA Video Super Resolution',
        capability: 'Upscale video through NVIDIA Video Super Resolution NIM',
        capabilities: Object.freeze(['video-upscale']),
        credentialVariable: NVIDIA_SHARED_KEY_VARIABLE,
        access: 'downloadable-nim',
        transport: 'self-hosted-nim',
        executable: false,
        blockedReason: 'NVIDIA currently documents this as a downloadable NIM rather than a public hosted Creator Studio endpoint.',
    }),
});

const DEFAULT_NVIDIA_VIDEO_MODEL_ID = 'cosmos3-nano';

function normalizedString(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function configuredApiKey(value) {
    const key = normalizedString(value);
    if (!/^[\x21-\x7E]{8,4096}$/.test(key) || /[\r\n]/.test(key)) return false;
    return !/^(?:<.*>|change-?me|placeholder|your[-_]?api[-_]?key)$/i.test(key);
}

export function nvidiaVideoModelRegistry() {
    return Object.values(NVIDIA_VIDEO_MODEL_REGISTRY);
}

export function resolveNvidiaVideoModel(env = process.env) {
    const requested = normalizedString(env.NVIDIA_VIDEO_MODEL).toLowerCase();
    return NVIDIA_VIDEO_MODEL_REGISTRY[requested] || NVIDIA_VIDEO_MODEL_REGISTRY[DEFAULT_NVIDIA_VIDEO_MODEL_ID];
}

export function nvidiaVideoConfiguration(env = process.env) {
    const missing = [];
    if (!configuredApiKey(env.NVIDIA_API_KEY)) missing.push(NVIDIA_SHARED_KEY_VARIABLE);
    const model = resolveNvidiaVideoModel(env);
    return {
        configured: missing.length === 0,
        missing,
        credentialVariable: NVIDIA_SHARED_KEY_VARIABLE,
        model,
    };
}

export function nvidiaVideoProviderStatus(env = process.env) {
    const configuration = nvidiaVideoConfiguration(env);
    const model = configuration.model;
    return {
        id: 'nvidia-video',
        label: 'NVIDIA Video',
        category: 'generation',
        capability: model.capability,
        toolId: NVIDIA_VIDEO_TOOL_ID,
        // Credential linking is built. Execution stays deferred until the
        // selected NVIDIA service has a verified runtime contract in this app.
        built: false,
        configured: configuration.configured,
        tested: false,
        productionReady: false,
        deferred: true,
        credentialVariable: configuration.credentialVariable,
        sharedCredentialWith: Object.freeze(['nvidia-brain', 'nvidia-image']),
        model: model.label,
        modelId: model.id,
        capabilities: model.capabilities,
        access: model.access,
        transport: model.transport,
        executable: model.executable,
        blockedReason: model.blockedReason,
        models: nvidiaVideoModelRegistry().map((entry) => ({
            id: entry.id,
            label: entry.label,
            capability: entry.capability,
            capabilities: entry.capabilities,
            credentialVariable: entry.credentialVariable,
            access: entry.access,
            transport: entry.transport,
            executable: entry.executable,
            ...(entry.target ? { target: entry.target } : {}),
            ...(entry.functionId ? { functionId: entry.functionId } : {}),
            blockedReason: entry.blockedReason,
        })),
    };
}
