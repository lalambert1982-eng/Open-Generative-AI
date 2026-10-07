import assert from 'node:assert/strict';
import test from 'node:test';

import {
    BrainRouterError,
    DEFAULT_BRAIN_PROVIDER,
    getBrainConfiguration,
    reasonWithBrain,
} from '../../src/lib/brainRouter.js';
import { creatorRenderEnabled, renderCreatorTimeline } from '../../src/lib/creatorProjectStore.js';
import { nvidiaImageConfiguration } from '../../src/lib/nvidiaCreatorProvider.js';

const request = { task: 'Create a short launch plan.', mode: 'plan', sensitivity: 'NORMAL' };

function neverCalledFetch() {
    const calls = [];
    const fetchImpl = async (url) => {
        calls.push(url);
        throw new Error('network must not be reached');
    };
    return { calls, fetchImpl };
}

// Each test passes an explicit env object, so process.env is never touched.

test('NVIDIA image generation stays off when only NVIDIA_API_KEY is set', () => {
    const configuration = nvidiaImageConfiguration({ NVIDIA_API_KEY: 'nvapi-test-provider-secret' });
    assert.equal(configuration.configured, false);
    assert.ok(configuration.missing.includes('NVIDIA_IMAGE_ENABLED=true'));
});

test('BRAIN_PROVIDER=nvidia without NVIDIA_API_KEY stops instead of falling back to a paid provider', async () => {
    const { calls, fetchImpl } = neverCalledFetch();
    await assert.rejects(
        reasonWithBrain(request, {
            env: {
                BRAIN_PROVIDER: 'nvidia',
                MUAPI_API_KEY: 'muapi-test-provider-secret',
                MUAPI_KEY_MODE: 'production',
                MUAPI_ALLOW_PAID_GENERATION: 'true',
                GEMINI_API_KEY: 'gemini-test-provider-secret',
            },
            fetchImpl,
        }),
        (error) => {
            assert.ok(error instanceof BrainRouterError);
            assert.equal(error.status, 503);
            assert.equal(error.code, 'provider_configuration_missing');
            assert.deepEqual(error.attemptedProviders ?? [], []);
            return true;
        },
    );
    assert.deepEqual(calls, []);
});

test('POST /projects/:id/render refuses when CREATOR_RENDER_ENABLED is unset', async () => {
    assert.equal(creatorRenderEnabled({}), false);
    await assert.rejects(
        renderCreatorTimeline({ id: 'user-1' }, 'project-1', {}, { env: {} }),
        (error) => {
            assert.equal(error.code, 'render_disabled');
            assert.equal(error.status, 503);
            return true;
        },
    );
});

test('BRAIN_PROVIDER unset resolves to muapi-agent, not nvidia', () => {
    assert.equal(DEFAULT_BRAIN_PROVIDER, 'muapi-agent');
    const configuration = getBrainConfiguration({});
    assert.equal(configuration.valid, true);
    assert.equal(configuration.selectedProvider, 'muapi-agent');
});

test('An unknown BRAIN_PROVIDER is rejected with a configuration error, not a silent default', async () => {
    const env = { BRAIN_PROVIDER: 'not-a-provider', GEMINI_API_KEY: 'gemini-test-provider-secret' };
    const configuration = getBrainConfiguration(env);
    assert.equal(configuration.valid, false);
    assert.match(configuration.errors[0], /BRAIN_PROVIDER/);
    const { calls, fetchImpl } = neverCalledFetch();
    await assert.rejects(
        reasonWithBrain(request, { env, fetchImpl }),
        (error) => {
            assert.equal(error.code, 'brain_configuration');
            assert.equal(error.status, 503);
            return true;
        },
    );
    assert.deepEqual(calls, []);
});
