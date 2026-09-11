import { NVIDIA_IMAGE_TOOL_ID } from './creatorToolRegistry.js';

// Fixed NVIDIA Build "Visual Generative AI" (GenAI) inference host. This is
// never taken from configuration or client input, so a request can never be
// redirected to an arbitrary upstream URL.
const NVIDIA_IMAGE_API_BASE = 'https://ai.api.nvidia.com/v1/genai';

const MAX_PROVIDER_JSON_BYTES = 16 * 1024 * 1024;
const MAX_PROMPT_CHARACTERS = 4000;
const MAX_REFERENCE_IMAGE_BYTES = 8 * 1024 * 1024;
// Base64 grows input by ~4/3; cap the encoded string a little above that.
const MAX_REFERENCE_IMAGE_BASE64_CHARACTERS = Math.ceil(MAX_REFERENCE_IMAGE_BYTES * 1.4);

// Client-facing aspect ratios, mapped to the width/height pairs the verified
// hosted contract actually accepts (the upstream API has no aspect-ratio
// field). Each pair keeps the total pixel budget close to 1024x1024 on
// 64px-aligned dimensions.
const IMAGE_ASPECT_RATIO_DIMENSIONS = Object.freeze({
    '1:1': Object.freeze({ width: 1024, height: 1024 }),
    '16:9': Object.freeze({ width: 1344, height: 768 }),
    '9:16': Object.freeze({ width: 768, height: 1344 }),
    '4:3': Object.freeze({ width: 1024, height: 768 }),
    '3:4': Object.freeze({ width: 768, height: 1024 }),
});
const IMAGE_ASPECT_RATIOS = new Set(Object.keys(IMAGE_ASPECT_RATIO_DIMENSIONS));
const MIN_SEED = 0;
const MAX_SEED = 4_294_967_295; // unsigned 32-bit range
const MIN_STEPS = 1;
const MAX_STEPS = 50;
const DEFAULT_STEPS = 4;

// Controlled server-side allowlist. Only models verified against current
// official NVIDIA Build/NIM documentation are listed here. The browser can
// never select a model directly -- it can only request generation/editing,
// and the server resolves NVIDIA_IMAGE_MODEL against this registry.
const NVIDIA_IMAGE_MODEL_REGISTRY = Object.freeze({
    'flux-2-klein-4b': Object.freeze({
        id: 'flux-2-klein-4b',
        // publisher/model path segment used to build the fixed upstream URL.
        // Verified against the current NVIDIA Build hosted contract:
        // https://ai.api.nvidia.com/v1/genai/black-forest-labs/flux.2-klein-4b
        path: 'black-forest-labs/flux.2-klein-4b',
        label: 'FLUX.2 [klein] 4B',
        capabilities: Object.freeze(['generate', 'edit']),
    }),
});

const DEFAULT_NVIDIA_IMAGE_MODEL_ID = 'flux-2-klein-4b';

function normalizedString(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function configuredApiKey(value) {
    const key = normalizedString(value);
    if (!/^[\x21-\x7E]{8,4096}$/.test(key) || /[\r\n]/.test(key)) return false;
    return !/^(?:<.*>|change-?me|placeholder|your[-_]?api[-_]?key)$/i.test(key);
}

export function nvidiaImageModelRegistry() {
    return Object.values(NVIDIA_IMAGE_MODEL_REGISTRY);
}

// Resolves the configured model against the fixed registry. An unknown or
// unset NVIDIA_IMAGE_MODEL value never reaches the upstream request --
// it silently falls back to the reviewed default instead of being forwarded.
export function resolveNvidiaImageModel(env = process.env) {
    const requested = normalizedString(env.NVIDIA_IMAGE_MODEL).toLowerCase();
    return NVIDIA_IMAGE_MODEL_REGISTRY[requested] || NVIDIA_IMAGE_MODEL_REGISTRY[DEFAULT_NVIDIA_IMAGE_MODEL_ID];
}

export function nvidiaImageConfiguration(env = process.env) {
    const apiKey = normalizedString(env.NVIDIA_API_KEY);
    const missing = [];
    if (!configuredApiKey(apiKey)) missing.push('NVIDIA_API_KEY');
    return {
        configured: missing.length === 0,
        missing,
        apiKey,
        model: resolveNvidiaImageModel(env),
    };
}

export function nvidiaImageProviderStatus(env = process.env) {
    const configuration = nvidiaImageConfiguration(env);
    return {
        id: 'nvidia-image',
        label: 'NVIDIA Image Generation',
        category: 'generation',
        capability: 'Image generation and editing',
        toolId: NVIDIA_IMAGE_TOOL_ID,
        built: true,
        configured: configuration.configured,
        tested: false,
        productionReady: false,
        model: configuration.model.label,
        capabilities: configuration.model.capabilities,
    };
}

function textInput(value, name, maximum = MAX_PROMPT_CHARACTERS) {
    if (typeof value !== 'string') return { error: `${name} must be text.` };
    const normalized = value.trim();
    if (!normalized) return { error: `${name} is required.` };
    if (normalized.length > maximum) return { error: `${name} must be ${maximum} characters or fewer.` };
    return { value: normalized };
}

function boundedInteger(value, name, fallback, minimum, maximum) {
    if (value == null || value === '') return { value: fallback };
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
        return { error: `${name} must be an integer between ${minimum} and ${maximum}.` };
    }
    return { value: parsed };
}

const REFERENCE_IMAGE_PATTERN = /^data:image\/(png|jpe?g|webp);base64,([A-Za-z0-9+/]+=*)$/i;

function referenceImageInput(value) {
    if (value == null || value === '') return { value: null };
    if (typeof value !== 'string') return { error: 'Reference image must be a base64 data URL.' };
    if (value.length > MAX_REFERENCE_IMAGE_BASE64_CHARACTERS) {
        return { error: 'Reference image is too large.' };
    }
    const match = REFERENCE_IMAGE_PATTERN.exec(value.trim());
    if (!match) {
        return { error: 'Reference image must be a PNG, JPEG, or WEBP base64 data URL.' };
    }
    const base64 = match[2];
    const decodedBytes = Math.floor((base64.length * 3) / 4);
    if (decodedBytes === 0 || decodedBytes > MAX_REFERENCE_IMAGE_BYTES) {
        return { error: 'Reference image must be a valid, appropriately sized image.' };
    }
    return { value: base64 };
}

// Normalizes a Creator Studio request into a fixed upstream payload. The
// client can only ever supply prompt/referenceImage/aspectRatio/seed/steps --
// any client-supplied model, endpoint, or URL field is ignored, never
// forwarded upstream.
export function normalizeNvidiaImageRequest(value, { env = process.env } = {}) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return { error: 'NVIDIA image input must be an object.' };
    }
    if (typeof value.model === 'string' && value.model.trim()) {
        return { error: 'Image model selection is not permitted from the client.' };
    }
    const configuration = nvidiaImageConfiguration(env);
    if (!configuration.configured) {
        return { error: 'NVIDIA Image Generation is not configured.', missing: configuration.missing };
    }
    const prompt = textInput(value.prompt, 'Image prompt');
    if (prompt.error) return prompt;

    const aspectRatio = value.aspectRatio == null || value.aspectRatio === '' ? '1:1' : value.aspectRatio;
    if (typeof aspectRatio !== 'string' || !IMAGE_ASPECT_RATIOS.has(aspectRatio)) {
        return { error: 'Image aspect ratio is not supported by NVIDIA Image Generation.' };
    }

    const seed = boundedInteger(value.seed, 'Seed', null, MIN_SEED, MAX_SEED);
    if (seed.error) return seed;

    const steps = boundedInteger(value.steps, 'Steps', DEFAULT_STEPS, MIN_STEPS, MAX_STEPS);
    if (steps.error) return steps;

    const referenceImage = referenceImageInput(value.referenceImage);
    if (referenceImage.error) return referenceImage;

    const model = configuration.model;
    const kind = referenceImage.value ? 'edit' : 'generate';
    const dimensions = IMAGE_ASPECT_RATIO_DIMENSIONS[aspectRatio];
    // Verified hosted contract fields: mode, prompt, width, height, samples,
    // seed, steps. There is no aspect_ratio field upstream -- the client's
    // aspect ratio selection is resolved to explicit width/height here.
    const payload = {
        mode: kind === 'edit' ? 'Image Editing' : 'Image Generation',
        prompt: prompt.value,
        width: dimensions.width,
        height: dimensions.height,
        samples: 1,
        steps: steps.value,
    };
    if (seed.value != null) payload.seed = seed.value;
    // Editing-mode input image field: the verified contract documents only
    // the generation payload shape, so this stays a best-effort carryover
    // pending a live hosted-account contract check (see
    // nvidiaImageProviderStatus's `tested`/`productionReady: false`).
    if (referenceImage.value) payload.image = referenceImage.value;

    return {
        value: {
            kind,
            model,
            payload,
        },
    };
}

function safeProviderText(value) {
    if (typeof value !== 'string') return '';
    return value
        .replace(/[\u0000-\u001F\u007F]/g, ' ')
        .replace(/\bBearer\s+[A-Za-z0-9._-]{8,}\b/gi, '[redacted]')
        .trim()
        .slice(0, 400);
}

function providerMessage(value) {
    return safeProviderText(
        value?.error?.message ||
        value?.error?.detail ||
        value?.error ||
        value?.detail ||
        value?.message ||
        '',
    );
}

async function fetchWithTimeout(fetchImpl, url, options, timeoutMs) {
    try {
        return await fetchImpl(url, {
            ...options,
            redirect: 'error',
            signal: AbortSignal.timeout(timeoutMs),
        });
    } catch (error) {
        const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
        return { networkError: timedOut ? 'timeout' : 'unavailable' };
    }
}

async function readProviderJson(response) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > MAX_PROVIDER_JSON_BYTES) {
        return { error: 'provider_response_too_large' };
    }
    try {
        return { value: JSON.parse(text) };
    } catch {
        return { error: 'invalid_provider_response' };
    }
}

function networkFailure(result) {
    return {
        ok: false,
        status: result.networkError === 'timeout' ? 504 : 502,
        error: result.networkError === 'timeout'
            ? 'NVIDIA Image Generation request timed out.'
            : 'NVIDIA Image Generation is temporarily unavailable.',
    };
}

function providerFailure(response, value) {
    const detail = providerMessage(value);
    if (response.status === 401 || response.status === 403) {
        return { ok: false, status: 502, error: 'NVIDIA Image Generation rejected the configured API credentials.' };
    }
    if (response.status === 429) {
        return {
            ok: false,
            status: 429,
            error: 'NVIDIA Image Generation rate limit or account balance limit was reached.',
            ...(detail ? { detail } : {}),
        };
    }
    if ([400, 404, 409, 422].includes(response.status)) {
        return {
            ok: false,
            status: 422,
            error: 'NVIDIA Image Generation rejected the generation request.',
            ...(detail ? { detail } : {}),
        };
    }
    return {
        ok: false,
        status: 502,
        error: 'NVIDIA Image Generation is temporarily unavailable.',
        ...(detail ? { detail } : {}),
    };
}

const BASE64_PATTERN = /^[A-Za-z0-9+/]+=*$/;

function extractImageBase64(value) {
    const candidates = [
        value?.artifacts?.[0]?.base64,
        value?.artifacts?.[0]?.b64_json,
        value?.artifacts?.[0]?.image,
        value?.data?.[0]?.b64_json,
        value?.data?.[0]?.base64,
        value?.image,
        value?.image_b64,
        value?.b64_json,
    ];
    for (const candidate of candidates) {
        if (typeof candidate === 'string' && candidate.length > 0 && BASE64_PATTERN.test(candidate)) {
            return candidate;
        }
    }
    return null;
}

export async function createNvidiaImageGeneration(value, {
    env = process.env,
    fetchImpl = fetch,
    timeoutMs = 60_000,
} = {}) {
    const normalized = normalizeNvidiaImageRequest(value, { env });
    if (normalized.error) {
        return {
            ok: false,
            status: normalized.missing ? 503 : 400,
            error: normalized.error,
            ...(normalized.missing ? { missing: normalized.missing } : {}),
        };
    }
    const configuration = nvidiaImageConfiguration(env);
    const { kind, model, payload } = normalized.value;
    const url = `${NVIDIA_IMAGE_API_BASE}/${model.path}`;

    const result = await fetchWithTimeout(fetchImpl, url, {
        method: 'POST',
        headers: {
            authorization: `Bearer ${configuration.apiKey}`,
            accept: 'application/json',
            'content-type': 'application/json',
        },
        body: JSON.stringify(payload),
    }, timeoutMs);
    if (result.networkError) return networkFailure(result);

    const decoded = await readProviderJson(result);
    if (decoded.error === 'provider_response_too_large') {
        return { ok: false, status: 502, error: 'NVIDIA Image Generation returned an oversized response.' };
    }
    if (decoded.error) {
        return { ok: false, status: 502, error: 'NVIDIA Image Generation returned an invalid response.' };
    }
    if (!result.ok) return providerFailure(result, decoded.value);

    const base64 = extractImageBase64(decoded.value);
    if (!base64) {
        return { ok: false, status: 502, error: 'NVIDIA Image Generation returned no image data.' };
    }
    const image = Buffer.from(base64, 'base64');
    if (image.length === 0 || image.length > MAX_REFERENCE_IMAGE_BYTES * 4) {
        return { ok: false, status: 502, error: 'NVIDIA Image Generation returned an invalid or oversized image.' };
    }

    return {
        ok: true,
        status: 200,
        job: {
            provider: 'nvidia',
            toolId: NVIDIA_IMAGE_TOOL_ID,
            kind,
            model: model.label,
            contentType: 'image/png',
            image,
        },
    };
}
