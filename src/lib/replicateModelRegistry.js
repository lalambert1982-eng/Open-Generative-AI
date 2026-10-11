const MAX_PROMPT_CHARACTERS = 4000;
const IMAGE_RATIOS = Object.freeze(['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3']);

const PROMPT = Object.freeze({ type: 'string', required: true, max: MAX_PROMPT_CHARACTERS });
const url = (required = false) => Object.freeze({ type: 'url', required });
const urlArray = (max) => Object.freeze({ type: 'urlArray', max });
const choice = (values, fallback) => Object.freeze({ type: 'enum', values: Object.freeze(values), default: fallback });
const integer = (min, max, fallback) => Object.freeze({ type: 'integer', min, max, default: fallback });
const toggle = (fallback = false) => Object.freeze({ type: 'boolean', default: fallback });

function model(entry) {
    return Object.freeze({
        provider: 'replicate',
        official: true,
        enabled: true,
        ...entry,
        pricing: Object.freeze(entry.pricing),
        inputs: Object.freeze(entry.inputs),
    });
}

// Field names are Replicate's own input names, copied from each official
// model's published schema (see docs/superpowers/research). Prices are the
// highest rate on the model page and are estimates, not billing truth.
export const REPLICATE_MODELS = Object.freeze([
    // enum values not re-verified
    model({
        id: 'black-forest-labs/flux-2-pro',
        kind: 'image',
        task: 'text-to-image',
        label: 'FLUX 2 Pro',
        pricing: { mode: 'flat', usd: 0.015, display: '~$0.015 per image (estimate)' },
        inputs: { prompt: PROMPT, aspect_ratio: choice(IMAGE_RATIOS, '1:1') },
    }),
    // enum values not re-verified
    model({
        id: 'black-forest-labs/flux-schnell',
        kind: 'image',
        task: 'text-to-image',
        label: 'FLUX Schnell (fast draft)',
        pricing: { mode: 'flat', usd: 0.003, display: '~$0.003 per image (estimate)' },
        inputs: { prompt: PROMPT, aspect_ratio: choice(IMAGE_RATIOS, '1:1') },
    }),
    // enum values not re-verified
    model({
        id: 'google/nano-banana-2',
        kind: 'image',
        task: 'text-to-image',
        label: 'Nano Banana 2',
        pricing: { mode: 'flat', usd: 0.151, display: 'up to ~$0.151 per image (estimate)' },
        inputs: { prompt: PROMPT, aspect_ratio: choice(IMAGE_RATIOS, '1:1'), image_input: urlArray(14) },
    }),
    // enum values not re-verified
    model({
        id: 'black-forest-labs/flux-kontext-pro',
        kind: 'image',
        task: 'image-edit',
        label: 'FLUX Kontext Pro (edit)',
        pricing: { mode: 'flat', usd: 0.04, display: '~$0.04 per image (estimate)' },
        inputs: {
            prompt: PROMPT,
            input_image: url(true),
            aspect_ratio: choice(['match_input_image', ...IMAGE_RATIOS], 'match_input_image'),
        },
    }),
    // enum values not re-verified
    model({
        id: 'google/nano-banana-pro',
        kind: 'image',
        task: 'image-edit',
        label: 'Nano Banana Pro (edit, references)',
        pricing: { mode: 'flat', usd: 0.3, display: 'up to ~$0.30 per image (estimate)' },
        inputs: { prompt: PROMPT, aspect_ratio: choice(IMAGE_RATIOS, '1:1'), image_input: urlArray(14) },
    }),
    // enum values not re-verified
    model({
        id: 'google/veo-3.1-fast',
        kind: 'video',
        task: 'text-to-video',
        label: 'Veo 3.1 Fast',
        pricing: { mode: 'perSecond', usd: 0.15, display: 'up to ~$0.15 per second (estimate)' },
        inputs: {
            prompt: PROMPT,
            image: url(),
            last_frame: url(),
            duration: choice([4, 6, 8], 6),
            aspect_ratio: choice(['16:9', '9:16'], '16:9'),
        },
    }),
    // enum values not re-verified
    model({
        id: 'kwaivgi/kling-v3-video',
        kind: 'video',
        task: 'text-to-video',
        label: 'Kling v3',
        pricing: { mode: 'perSecond', usd: 0.336, display: 'up to ~$0.336 per second (estimate)' },
        inputs: {
            prompt: PROMPT,
            start_image: url(),
            end_image: url(),
            duration: integer(3, 15, 5),
            aspect_ratio: choice(['16:9', '9:16', '1:1'], '16:9'),
            mode: choice(['standard', 'pro'], 'standard'),
        },
    }),
    // enum values not re-verified
    model({
        id: 'bytedance/seedance-1.5-pro',
        kind: 'video',
        task: 'text-to-video',
        label: 'Seedance 1.5 Pro',
        pricing: { mode: 'perSecond', usd: 0.12, display: 'up to ~$0.12 per second (estimate)' },
        inputs: {
            prompt: PROMPT,
            image: url(),
            last_frame_image: url(),
            duration: integer(2, 12, 5),
            aspect_ratio: choice(['16:9', '9:16', '1:1'], '16:9'),
            camera_fixed: toggle(false),
        },
    }),
]);

export function getReplicateModel(id) {
    return REPLICATE_MODELS.find((entry) => entry.id === id) || null;
}

export function listReplicateModels() {
    return REPLICATE_MODELS.map(({ id, kind, task, label, pricing, inputs, enabled }) => ({
        id, kind, task, label, pricing, inputs, enabled,
    }));
}

function checkField(name, spec, value, assetUrl) {
    switch (spec.type) {
        case 'string': {
            if (typeof value !== 'string') return { error: `${name} must be text.` };
            const text = value.trim();
            if (!text) return { error: `${name} is required.` };
            if (text.length > spec.max) return { error: `${name} must be ${spec.max} characters or fewer.` };
            return { value: text };
        }
        case 'enum': {
            const match = spec.values.find((candidate) => String(candidate) === String(value));
            return match === undefined ? { error: `${name} is not a supported value.` } : { value: match };
        }
        case 'integer': {
            const number = Number(value);
            if (!Number.isInteger(number) || number < spec.min || number > spec.max) {
                return { error: `${name} must be a whole number from ${spec.min} to ${spec.max}.` };
            }
            return { value: number };
        }
        case 'boolean':
            return typeof value === 'boolean' ? { value } : { error: `${name} must be true or false.` };
        case 'url':
            return checkUrl(name, value, assetUrl);
        case 'urlArray': {
            if (!Array.isArray(value) || value.length > spec.max) {
                return { error: `${name} must be a list of up to ${spec.max} image URLs.` };
            }
            const urls = [];
            for (const item of value) {
                const checked = checkUrl(name, item, assetUrl);
                if (checked.error) return checked;
                urls.push(checked.value);
            }
            return { value: urls };
        }
        default:
            return { error: `${name} has an unsupported type.` };
    }
}

function checkUrl(name, value, assetUrl) {
    if (typeof assetUrl !== 'function') return { error: `${name} references are not available.` };
    try {
        return { value: assetUrl(value) };
    } catch {
        return { error: `${name} must be a permitted HTTPS media URL.` };
    }
}

export function validateReplicateInput(modelDefinition, raw, { assetUrl } = {}) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'Input must be an object.' };
    for (const key of Object.keys(raw)) {
        if (!Object.hasOwn(modelDefinition.inputs, key)) return { error: `Unsupported setting: ${key}.` };
    }
    const out = {};
    for (const [name, spec] of Object.entries(modelDefinition.inputs)) {
        const value = raw[name];
        if (value == null || value === '') {
            if (spec.required) return { error: `${name} is required.` };
            if (spec.default !== undefined) out[name] = spec.default;
            continue;
        }
        const checked = checkField(name, spec, value, assetUrl);
        if (checked.error) return checked;
        out[name] = checked.value;
    }
    return { value: out };
}

export function estimateReplicateUsd(modelDefinition, input) {
    const { mode, usd } = modelDefinition.pricing;
    if (mode === 'flat') return usd;
    const seconds = Number(input?.duration ?? modelDefinition.inputs.duration?.default ?? 5);
    return Number((usd * seconds).toFixed(4));
}
