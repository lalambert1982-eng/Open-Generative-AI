import test from 'node:test';
import assert from 'node:assert/strict';
import {
    assetChoices, buildInput, defaultValues, fieldLabel, formatUsd, pickDefaultModel, validationErrors,
} from '../src/lib/replicateStudioForm.js';

const model = {
    id: 'vendor/video', kind: 'video', enabled: true,
    inputs: {
        prompt: { type: 'string', required: true, max: 10 },
        image: { type: 'url' },
        refs: { type: 'urlArray', max: 2 },
        duration: { type: 'enum', values: [4, 6, 8], default: 6 },
        steps: { type: 'integer', min: 1, max: 5, default: 3 },
        fixed: { type: 'boolean', default: false },
    },
};

test('formatUsd keeps small values and pads whole cents', () => {
    assert.equal(formatUsd(0.003), '$0.003');
    assert.equal(formatUsd(0.015), '$0.015');
    assert.equal(formatUsd(0.3), '$0.30');
    assert.equal(formatUsd(1), '$1.00');
    assert.equal(formatUsd(0.151), '$0.151');
});

test('defaultValues copies declared defaults only', () => {
    assert.deepEqual(defaultValues(model), { duration: 6, steps: 3, fixed: false });
});

test('buildInput trims, drops empties, and maps enum strings back to declared values', () => {
    const input = buildInput(model, { prompt: '  a fox ', image: '', refs: ['', 'https://x/y.png'], duration: '8', steps: '4', fixed: true });
    assert.deepEqual(input, { prompt: 'a fox', refs: ['https://x/y.png'], duration: 8, steps: 4, fixed: true });
});

test('validationErrors reports required, length, range, and array limits', () => {
    assert.deepEqual(Object.keys(validationErrors(model, { prompt: '' })), ['prompt']);
    assert.ok(validationErrors(model, { prompt: 'x'.repeat(11) }).prompt);
    assert.ok(validationErrors(model, { prompt: 'ok', steps: 9 }).steps);
    assert.ok(validationErrors(model, { prompt: 'ok', steps: 2.5 }).steps);
    assert.ok(validationErrors(model, { prompt: 'ok', refs: ['a', 'b', 'c'] }).refs);
    assert.deepEqual(validationErrors(model, { prompt: 'ok', steps: 2 }), {});
});

test('required url field is enforced', () => {
    const edit = { inputs: { prompt: { type: 'string', required: true, max: 50 }, input_image: { type: 'url', required: true } } };
    assert.ok(validationErrors(edit, { prompt: 'ok' }).input_image);
});

test('pickDefaultModel returns the first enabled model of the kind', () => {
    const models = [{ id: 'a', kind: 'image', enabled: false }, { id: 'b', kind: 'image', enabled: true }, { id: 'c', kind: 'video', enabled: true }];
    assert.equal(pickDefaultModel(models, 'image').id, 'b');
    assert.equal(pickDefaultModel(models, 'audio'), null);
});

test('assetChoices offers only image and graphic Assets that have a url', () => {
    const choices = assetChoices([
        { id: '1', type: 'image', url: 'https://a/1.png', title: 'One' },
        { id: '2', type: 'graphic', url: 'https://a/2.png', title: 'Two' },
        { id: '3', type: 'video', url: 'https://a/3.mp4', title: 'Three' },
        { id: '4', type: 'image', title: 'No url' },
    ]);
    assert.deepEqual(choices.map((item) => item.id), ['1', '2']);
});

test('fieldLabel humanizes provider field names', () => {
    assert.equal(fieldLabel('aspect_ratio'), 'Aspect ratio');
    assert.equal(fieldLabel('prompt'), 'Prompt');
});
