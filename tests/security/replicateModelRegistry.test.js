import assert from 'node:assert/strict';
import test from 'node:test';

import {
    REPLICATE_MODELS,
    estimateReplicateUsd,
    getReplicateModel,
    listReplicateModels,
    validateReplicateInput,
} from '../../src/lib/replicateModelRegistry.js';

const assetUrl = (url) => {
    if (!url.startsWith('https://creator.public.blob.vercel-storage.com/')) throw new Error('blocked');
    return url;
};

test('every registry entry is well formed', () => {
    assert.ok(REPLICATE_MODELS.length >= 8);
    for (const model of REPLICATE_MODELS) {
        assert.match(model.id, /^[a-z0-9-]+\/[a-z0-9._-]+$/);
        assert.ok(['image', 'video'].includes(model.kind));
        assert.equal(model.provider, 'replicate');
        assert.equal(model.inputs.prompt.required, true);
        assert.ok(['flat', 'perSecond'].includes(model.pricing.mode));
        assert.ok(model.pricing.usd > 0);
    }
});

test('listReplicateModels exposes no internal-only fields', () => {
    const [first] = listReplicateModels();
    assert.deepEqual(Object.keys(first).sort(), ['enabled', 'id', 'inputs', 'kind', 'label', 'pricing', 'task']);
});

test('defaults are applied and only registry fields are produced', () => {
    const model = getReplicateModel('black-forest-labs/flux-schnell');
    const result = validateReplicateInput(model, { prompt: '  a red fox  ' }, { assetUrl });
    assert.deepEqual(result.value, { prompt: 'a red fox', aspect_ratio: '1:1' });
});

test('unknown or hostile keys are rejected', () => {
    const model = getReplicateModel('black-forest-labs/flux-schnell');
    assert.match(validateReplicateInput(model, { prompt: 'x', disable_safety_checker: true }, { assetUrl }).error, /Unsupported setting/);
    const hostile = JSON.parse('{"prompt":"x","__proto__":{"polluted":true}}');
    assert.match(validateReplicateInput(model, hostile, { assetUrl }).error, /Unsupported setting/);
    assert.equal(validateReplicateInput(model, 'nope', { assetUrl }).error, 'Input must be an object.');
});

test('prompt and enum checks', () => {
    const model = getReplicateModel('black-forest-labs/flux-schnell');
    assert.equal(validateReplicateInput(model, {}, { assetUrl }).error, 'prompt is required.');
    assert.equal(validateReplicateInput(model, { prompt: 42 }, { assetUrl }).error, 'prompt must be text.');
    assert.match(validateReplicateInput(model, { prompt: 'x'.repeat(4001) }, { assetUrl }).error, /4000/);
    assert.match(validateReplicateInput(model, { prompt: 'x', aspect_ratio: '7:5' }, { assetUrl }).error, /aspect_ratio/);
});

test('reference-image URLs must pass the asset allowlist and required fields are enforced', () => {
    const edit = getReplicateModel('black-forest-labs/flux-kontext-pro');
    assert.equal(validateReplicateInput(edit, { prompt: 'make it night' }, { assetUrl }).error, 'input_image is required.');
    assert.match(
        validateReplicateInput(edit, { prompt: 'x', input_image: 'https://attacker.test/a.png' }, { assetUrl }).error,
        /input_image/,
    );
    const ok = validateReplicateInput(edit, {
        prompt: 'make it night',
        input_image: 'https://creator.public.blob.vercel-storage.com/a.png',
    }, { assetUrl });
    assert.equal(ok.value.input_image, 'https://creator.public.blob.vercel-storage.com/a.png');
});

test('video numeric settings are bounded and priced per second', () => {
    const model = getReplicateModel('kwaivgi/kling-v3-video');
    assert.match(validateReplicateInput(model, { prompt: 'x', duration: 99 }, { assetUrl }).error, /duration/);
    const { value } = validateReplicateInput(model, { prompt: 'x', duration: '10' }, { assetUrl });
    assert.equal(value.duration, 10);
    assert.equal(estimateReplicateUsd(model, value), Number((model.pricing.usd * 10).toFixed(4)));
});

test('enum values match numerically written inputs', () => {
    const veo = getReplicateModel('google/veo-3.1-fast');
    assert.equal(validateReplicateInput(veo, { prompt: 'x', duration: '8' }, { assetUrl }).value.duration, 8);
    assert.match(validateReplicateInput(veo, { prompt: 'x', duration: 5 }, { assetUrl }).error, /duration/);
});
