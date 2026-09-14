import assert from 'node:assert/strict';
import test from 'node:test';

import {
  nvidiaVideoConfiguration,
  nvidiaVideoModelRegistry,
  nvidiaVideoProviderStatus,
  resolveNvidiaVideoModel,
} from '../../src/lib/nvidiaVideoProvider.js';

test('NVIDIA video reuses the shared NVIDIA_API_KEY credential', () => {
  const status = nvidiaVideoProviderStatus({ NVIDIA_API_KEY: 'nvapi-test-key-12345678' });
  assert.equal(status.configured, true);
  assert.equal(status.credentialVariable, 'NVIDIA_API_KEY');
  assert.deepEqual(status.sharedCredentialWith, ['nvidia-brain', 'nvidia-image']);
});

test('NVIDIA video fails closed when the shared key is missing', () => {
  const configuration = nvidiaVideoConfiguration({});
  assert.equal(configuration.configured, false);
  assert.deepEqual(configuration.missing, ['NVIDIA_API_KEY']);
});

test('Cosmos3 Nano is the default reviewed NVIDIA video capability', () => {
  const model = resolveNvidiaVideoModel({});
  assert.equal(model.id, 'cosmos3-nano');
  assert.equal(model.credentialVariable, 'NVIDIA_API_KEY');
  assert.equal(model.executable, false);
});

test('unknown NVIDIA video models do not escape the reviewed registry', () => {
  const model = resolveNvidiaVideoModel({ NVIDIA_VIDEO_MODEL: 'attacker/model' });
  assert.equal(model.id, 'cosmos3-nano');
});

test('reviewed registry tracks Cosmos3, Relighting, and VSR without inventing execution URLs', () => {
  const models = nvidiaVideoModelRegistry();
  assert.deepEqual(models.map((model) => model.id), ['cosmos3-nano', 'relighting', 'vsr']);
  assert.ok(models.every((model) => model.credentialVariable === 'NVIDIA_API_KEY'));
  assert.ok(models.every((model) => model.executable === false));
});
