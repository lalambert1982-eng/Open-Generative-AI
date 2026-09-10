import assert from 'node:assert/strict';
import test from 'node:test';

import {
    createNvidiaImageEditJob,
    createNvidiaImageJob,
    nvidiaConfiguration,
    nvidiaProviderStatus,
    normalizeNvidiaImageEditInput,
    normalizeNvidiaImageInput,
} from '../../src/lib/nvidiaProvider.js';
import {
    NVIDIA_IMAGE_EDIT_TOOL_ID,
    NVIDIA_IMAGE_TOOL_ID,
} from '../../src/lib/creatorToolRegistry.js';

const configuredEnv = {
    NVIDIA_API_KEY: 'nvidia-provider-secret',
    NVIDIA_IMAGE_MODEL: 'flux-2-klein-4b',
    NVIDIA_BRAIN_MODEL: 'nvidia/nemotron-3.5-lightning-30b-a3b',
};

const pngBase64 = Buffer.from('fake-png-bytes').toString('base64');

test('NVIDIA configuration requires an explicit API key and applies documented defaults', () => {
    assert.deepEqual(nvidiaConfiguration({}).missing, ['NVIDIA_API_KEY']);
    const configuration = nvidiaConfiguration({ NVIDIA_API_KEY: 'nvidia-provider-secret' });
    assert.equal(configuration.configured, true);
    assert.equal(configuration.imageModel, 'flux-2-klein-4b');
    assert.equal(configuration.brainModel, 'nvidia/nemotron-3.5-lightning-30b-a3b');
});

test('NVIDIA provider status never leaks the configured API key', () => {
    const status = nvidiaProviderStatus(configuredEnv);
    assert.equal(status.id, 'nvidia');
    assert.equal(status.configured, true);
    assert.deepEqual(status.toolIds, [NVIDIA_IMAGE_TOOL_ID, NVIDIA_IMAGE_EDIT_TOOL_ID]);
    assert.equal(JSON.stringify(status).includes(configuredEnv.NVIDIA_API_KEY), false);
});

test('NVIDIA rejects a missing prompt and an unsafe edit source URL before provider access', () => {
    assert.equal(normalizeNvidiaImageInput({ prompt: '' }).error, 'Image prompt is required.');
    assert.equal(normalizeNvidiaImageInput({}).error, 'Image prompt must be text.');
    assert.equal(
        normalizeNvidiaImageEditInput({ prompt: 'Add a sunset glow', imageUrl: 'not-a-url' }).error,
        'Source image URL must be a valid HTTPS URL.',
    );
    assert.equal(
        normalizeNvidiaImageEditInput({
            prompt: 'Add a sunset glow',
            imageUrl: 'javascript:alert(1)',
        }).error,
        'Source image URL must be a valid HTTPS URL.',
    );
});

test('NVIDIA image generation posts the fixed configured model and keeps the API key server-side', async () => {
    let captured;
    const result = await createNvidiaImageJob({
        prompt: 'A dramatic track stadium at sunset.',
        size: '1024x1024',
        model: 'attacker-model',
    }, {
        env: configuredEnv,
        fetchImpl: async (url, options) => {
            captured = { url, options };
            return new Response(JSON.stringify({ data: [{ b64_json: pngBase64 }] }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        },
    });

    assert.equal(result.ok, true);
    assert.equal(result.status, 200);
    assert.equal(result.image.contentType, 'image/png');
    assert.equal(result.image.bytes.toString(), 'fake-png-bytes');
    assert.equal(captured.url, 'https://ai.api.nvidia.com/v1/genai/black-forest-labs/flux.2-klein-4b');
    assert.equal(captured.options.headers.authorization, `Bearer ${configuredEnv.NVIDIA_API_KEY}`);
    const body = JSON.parse(captured.options.body);
    assert.equal(body.model, 'flux-2-klein-4b');
    assert.notEqual(body.model, 'attacker-model');
    assert.equal(JSON.stringify(result).includes(configuredEnv.NVIDIA_API_KEY), false);
});

test('NVIDIA image editing sends the source image URL alongside the prompt', async () => {
    let captured;
    const result = await createNvidiaImageEditJob({
        prompt: 'Replace the sky with a dramatic sunset.',
        imageUrl: 'https://assets.example.test/source.png',
    }, {
        env: configuredEnv,
        fetchImpl: async (url, options) => {
            captured = { url, options };
            return new Response(JSON.stringify({ data: [{ b64_json: pngBase64 }] }), { status: 200 });
        },
    });

    assert.equal(result.ok, true);
    const body = JSON.parse(captured.options.body);
    assert.equal(body.image, 'https://assets.example.test/source.png');
    assert.equal(body.prompt, 'Replace the sky with a dramatic sunset.');
});

test('NVIDIA sanitizes provider error detail and fails closed on missing configuration', async () => {
    const missingConfig = await createNvidiaImageJob(
        { prompt: 'A cinematic skyline.' },
        { env: {}, fetchImpl: async () => new Response('{}', { status: 200 }) },
    );
    assert.equal(missingConfig.ok, false);
    assert.equal(missingConfig.status, 503);
    assert.deepEqual(missingConfig.missing, ['NVIDIA_API_KEY']);

    const rejected = await createNvidiaImageJob({ prompt: 'A cinematic skyline.' }, {
        env: configuredEnv,
        fetchImpl: async () => new Response(
            JSON.stringify({ error: { message: `Invalid key ${configuredEnv.NVIDIA_API_KEY}` } }),
            { status: 401 },
        ),
    });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.status, 502);
    assert.equal(rejected.error, 'NVIDIA NIM rejected the configured API credentials.');
    assert.equal(JSON.stringify(rejected).includes(configuredEnv.NVIDIA_API_KEY), false);
});

test('NVIDIA rejects a non-image or oversized response instead of returning invalid bytes', async () => {
    const invalidData = await createNvidiaImageJob({ prompt: 'A cinematic skyline.' }, {
        env: configuredEnv,
        fetchImpl: async () => new Response(JSON.stringify({ data: [{}] }), { status: 200 }),
    });
    assert.equal(invalidData.ok, false);
    assert.equal(invalidData.error, 'NVIDIA NIM returned no image data.');

    const timeout = await createNvidiaImageJob({ prompt: 'A cinematic skyline.' }, {
        env: configuredEnv,
        fetchImpl: async () => {
            const error = new Error('timed out');
            error.name = 'TimeoutError';
            throw error;
        },
    });
    assert.equal(timeout.ok, false);
    assert.equal(timeout.status, 504);
});
