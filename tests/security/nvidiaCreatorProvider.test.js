import assert from 'node:assert/strict';
import test from 'node:test';

import {
    createNvidiaImageGeneration,
    normalizeNvidiaImageRequest,
    nvidiaImageConfiguration,
    nvidiaImageModelRegistry,
    nvidiaImageProviderStatus,
    resolveNvidiaImageModel,
} from '../../src/lib/nvidiaCreatorProvider.js';
import { NVIDIA_IMAGE_TOOL_ID } from '../../src/lib/creatorToolRegistry.js';

const providerKey = 'nvidia-image-test-provider-secret';
const configuredEnv = { NVIDIA_API_KEY: providerKey };

const onePixelPng = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
);
const referenceImageDataUrl = `data:image/png;base64,${onePixelPng.toString('base64')}`;

function providerSuccess(base64 = onePixelPng.toString('base64')) {
    return new Response(JSON.stringify({ artifacts: [{ base64 }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
    });
}

test('model allowlist resolves only reviewed registry entries and ignores unknown configuration', () => {
    const registry = nvidiaImageModelRegistry();
    assert.equal(registry.length > 0, true);
    assert.deepEqual(registry.map((model) => model.id), ['flux-2-klein-4b']);

    const known = resolveNvidiaImageModel({ NVIDIA_IMAGE_MODEL: 'flux-2-klein-4b' });
    assert.equal(known.path, 'black-forest-labs/flux.2-klein-4b');

    const unknown = resolveNvidiaImageModel({ NVIDIA_IMAGE_MODEL: 'attacker-supplied-model' });
    assert.equal(unknown.id, 'flux-2-klein-4b');

    const unset = resolveNvidiaImageModel({});
    assert.equal(unset.id, 'flux-2-klein-4b');
});

test('a client-supplied model field is rejected rather than forwarded upstream', () => {
    const result = normalizeNvidiaImageRequest({
        prompt: 'A neon skyline at dusk.',
        model: 'black-forest-labs/some-other-model',
    }, { env: configuredEnv });
    assert.equal(result.error, 'Image model selection is not permitted from the client.');
});

test('NVIDIA Image Generation reports missing configuration without a key', () => {
    const configuration = nvidiaImageConfiguration({});
    assert.equal(configuration.configured, false);
    assert.deepEqual(configuration.missing, ['NVIDIA_API_KEY']);

    const normalized = normalizeNvidiaImageRequest({ prompt: 'A neon skyline.' }, { env: {} });
    assert.equal(normalized.error, 'NVIDIA Image Generation is not configured.');
    assert.deepEqual(normalized.missing, ['NVIDIA_API_KEY']);
});

test('image generation requests normalize prompt, aspect ratio, seed, and steps without a reference image', () => {
    const result = normalizeNvidiaImageRequest({
        prompt: 'A dramatic track stadium at sunset.',
        aspectRatio: '16:9',
        seed: 42,
        steps: 10,
    }, { env: configuredEnv });
    assert.equal(result.error, undefined);
    assert.equal(result.value.kind, 'generate');
    assert.equal(result.value.model.path, 'black-forest-labs/flux.2-klein-4b');
    assert.deepEqual(result.value.payload, {
        mode: 'Image Generation',
        prompt: 'A dramatic track stadium at sunset.',
        width: 1344,
        height: 768,
        samples: 1,
        steps: 10,
        seed: 42,
    });
});

test('image-edit requests normalize with a reference image and are classified as edit', () => {
    const result = normalizeNvidiaImageRequest({
        prompt: 'Add dramatic rim lighting.',
        referenceImage: referenceImageDataUrl,
    }, { env: configuredEnv });
    assert.equal(result.error, undefined);
    assert.equal(result.value.kind, 'edit');
    assert.equal(result.value.payload.mode, 'Image Editing');
    assert.equal(result.value.payload.image, onePixelPng.toString('base64'));
    assert.equal(result.value.payload.width, 1024);
    assert.equal(result.value.payload.height, 1024);
    assert.equal(result.value.payload.samples, 1);
    assert.equal(result.value.payload.steps, 4);
});

test('reference image validation rejects invalid, oversized, and non-image data', () => {
    assert.equal(
        normalizeNvidiaImageRequest({ prompt: 'Edit it.', referenceImage: 'not-a-data-url' }, { env: configuredEnv }).error,
        'Reference image must be a PNG, JPEG, or WEBP base64 data URL.',
    );
    assert.equal(
        normalizeNvidiaImageRequest({
            prompt: 'Edit it.',
            referenceImage: 'data:text/plain;base64,aGVsbG8=',
        }, { env: configuredEnv }).error,
        'Reference image must be a PNG, JPEG, or WEBP base64 data URL.',
    );
    assert.equal(
        normalizeNvidiaImageRequest({
            prompt: 'Edit it.',
            referenceImage: `data:image/png;base64,${'A'.repeat(20 * 1024 * 1024)}`,
        }, { env: configuredEnv }).error,
        'Reference image is too large.',
    );
});

test('arbitrary aspect ratios, seeds, and steps outside the supported range are rejected', () => {
    assert.equal(
        normalizeNvidiaImageRequest({ prompt: 'x', aspectRatio: '2:1' }, { env: configuredEnv }).error,
        'Image aspect ratio is not supported by NVIDIA Image Generation.',
    );
    assert.match(
        normalizeNvidiaImageRequest({ prompt: 'x', seed: -1 }, { env: configuredEnv }).error,
        /Seed must be an integer/,
    );
    assert.match(
        normalizeNvidiaImageRequest({ prompt: 'x', seed: 4_294_967_296 }, { env: configuredEnv }).error,
        /Seed must be an integer/,
    );
    assert.match(
        normalizeNvidiaImageRequest({ prompt: 'x', steps: 0 }, { env: configuredEnv }).error,
        /Steps must be an integer/,
    );
    assert.match(
        normalizeNvidiaImageRequest({ prompt: 'x', steps: 51 }, { env: configuredEnv }).error,
        /Steps must be an integer/,
    );
});

test('the upstream request always targets the fixed NVIDIA GenAI host, never a client-influenced URL', async () => {
    let captured;
    const result = await createNvidiaImageGeneration({
        prompt: 'A cinematic skyline.',
        endpoint: 'https://attacker.example.test/steal',
        baseUrl: 'https://attacker.example.test',
        url: 'https://attacker.example.test',
    }, {
        env: configuredEnv,
        fetchImpl: async (url, options) => {
            captured = { url, options };
            return providerSuccess();
        },
    });
    assert.equal(result.ok, true);
    assert.equal(captured.url, 'https://ai.api.nvidia.com/v1/genai/black-forest-labs/flux.2-klein-4b');
    assert.equal(captured.options.headers.authorization, `Bearer ${providerKey}`);
});

test('generation keeps the API key server-side and returns normalized image bytes', async () => {
    const result = await createNvidiaImageGeneration({
        prompt: 'A cinematic skyline.',
        aspectRatio: '16:9',
    }, {
        env: configuredEnv,
        fetchImpl: async () => providerSuccess(),
    });
    assert.equal(result.ok, true);
    assert.equal(result.job.provider, 'nvidia');
    assert.equal(result.job.toolId, NVIDIA_IMAGE_TOOL_ID);
    assert.equal(result.job.kind, 'generate');
    assert.equal(result.job.contentType, 'image/png');
    assert.deepEqual(new Uint8Array(result.job.image), new Uint8Array(onePixelPng));
    assert.equal(JSON.stringify(result).includes(providerKey), false);
});

test('a request timeout is reported without exposing the provider payload', async () => {
    const result = await createNvidiaImageGeneration({ prompt: 'Timeout test.' }, {
        env: configuredEnv,
        fetchImpl: async () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            throw error;
        },
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 504);
    assert.equal(result.error, 'NVIDIA Image Generation request timed out.');
});

test('401 and 403 responses are normalized as rejected credentials without leaking upstream detail', async () => {
    for (const status of [401, 403]) {
        const result = await createNvidiaImageGeneration({ prompt: 'x' }, {
            env: configuredEnv,
            fetchImpl: async () => new Response(JSON.stringify({
                error: { message: `token ${providerKey} invalid` },
            }), { status }),
        });
        assert.equal(result.ok, false);
        assert.equal(result.status, 502);
        assert.equal(result.error, 'NVIDIA Image Generation rejected the configured API credentials.');
        assert.equal(JSON.stringify(result).includes(providerKey), false);
    }
});

test('429 responses are normalized as a rate limit failure', async () => {
    const result = await createNvidiaImageGeneration({ prompt: 'x' }, {
        env: configuredEnv,
        fetchImpl: async () => new Response(JSON.stringify({ error: { message: 'quota exhausted' } }), { status: 429 }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 429);
    assert.equal(result.error, 'NVIDIA Image Generation rate limit or account balance limit was reached.');
});

test('a malformed (non-JSON) provider response is rejected cleanly', async () => {
    const result = await createNvidiaImageGeneration({ prompt: 'x' }, {
        env: configuredEnv,
        fetchImpl: async () => new Response('not-json', { status: 200 }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 502);
    assert.equal(result.error, 'NVIDIA Image Generation returned an invalid response.');
});

test('a provider response missing recognizable image data is rejected', async () => {
    const result = await createNvidiaImageGeneration({ prompt: 'x' }, {
        env: configuredEnv,
        fetchImpl: async () => new Response(JSON.stringify({ status: 'ok' }), { status: 200 }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 502);
    assert.equal(result.error, 'NVIDIA Image Generation returned no image data.');
});

test('an oversized provider response is rejected before parsing', async () => {
    const result = await createNvidiaImageGeneration({ prompt: 'x' }, {
        env: configuredEnv,
        fetchImpl: async () => new Response('a'.repeat(17 * 1024 * 1024), { status: 200 }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 502);
    assert.equal(result.error, 'NVIDIA Image Generation returned an oversized response.');
});

test('provider status exposes configuration, model, and capabilities without ever including the API key', () => {
    const status = nvidiaImageProviderStatus(configuredEnv);
    assert.equal(status.id, 'nvidia-image');
    assert.equal(status.category, 'generation');
    assert.equal(status.configured, true);
    assert.equal(status.toolId, NVIDIA_IMAGE_TOOL_ID);
    assert.deepEqual(status.capabilities, ['generate', 'edit']);
    assert.equal(typeof status.model, 'string');
    const serialized = JSON.stringify(status);
    assert.equal(serialized.includes(providerKey), false);
    assert.doesNotMatch(serialized, /apiKey|api_key/i);

    const unconfigured = nvidiaImageProviderStatus({});
    assert.equal(unconfigured.configured, false);
});
