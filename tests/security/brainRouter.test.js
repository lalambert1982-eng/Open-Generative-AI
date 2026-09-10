import assert from 'node:assert/strict';
import test from 'node:test';

import {
    BrainRouterError,
    brainErrorResponse,
    brainProviderStatuses,
    brainRouterStatus,
    getBrainConfiguration,
    reasonWithBrain,
} from '../../src/lib/brainRouter.js';

const baseEnv = {
    BRAIN_PROVIDER: 'gemini',
    BRAIN_FALLBACK_ORDER: 'gemini,groq,openrouter',
    BRAIN_ENABLE_AUTOMATIC_FALLBACK: 'true',
    BRAIN_MAX_ATTEMPTS: '3',
    NVIDIA_API_KEY: 'nvidia-test-provider-secret',
    NVIDIA_MODEL: 'nvidia/llama-3.1-nemotron-70b-instruct',
    GEMINI_API_KEY: 'gemini-test-provider-secret',
    GEMINI_MODEL: 'gemini-3.7-flash',
    GROQ_API_KEY: 'groq-test-provider-secret',
    GROQ_MODEL: 'openai/gpt-oss-120b',
    OPENROUTER_API_KEY: 'openrouter-test-provider-secret',
    OPENROUTER_MODEL: 'openrouter/free',
    ANTHROPIC_API_KEY: 'anthropic-test-provider-secret',
    ANTHROPIC_MODEL: 'claude-sonnet-5',
};

const request = {
    task: 'Create a short launch plan.',
    mode: 'plan',
    sensitivity: 'NORMAL',
};

function geminiSuccess(text = 'Gemini plan') {
    return new Response(JSON.stringify({
        modelVersion: 'gemini-3.7-flash',
        candidates: [{
            content: { parts: [{ text }] },
            finishReason: 'STOP',
        }],
        usageMetadata: {
            promptTokenCount: 10,
            candidatesTokenCount: 5,
            totalTokenCount: 15,
        },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
}

function compatibleSuccess(provider, text = `${provider} plan`) {
    return new Response(JSON.stringify({
        model: provider === 'groq' ? 'openai/gpt-oss-120b' : 'selected/free-model',
        choices: [{
            message: { role: 'assistant', content: text },
            finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
}

test('Brain Router defaults to Gemini and keeps its API key server-side', async () => {
    let captured;
    const result = await reasonWithBrain(request, {
        env: baseEnv,
        fetchImpl: async (url, options) => {
            captured = { url, options };
            return geminiSuccess();
        },
    });

    assert.equal(result.provider, 'gemini');
    assert.equal(result.model, 'gemini-3.7-flash');
    assert.equal(result.text, 'Gemini plan');
    assert.deepEqual(result.toolCalls, []);
    assert.deepEqual(result.usage, { inputTokens: 10, outputTokens: 5, totalTokens: 15 });
    assert.equal(captured.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.7-flash:generateContent');
    assert.equal(captured.options.headers['x-goog-api-key'], baseEnv.GEMINI_API_KEY);
    assert.equal(captured.options.body.includes(baseEnv.GEMINI_API_KEY), false);
});

test('Groq adapter normalizes OpenAI-compatible responses and tools', async () => {
    let captured;
    const result = await reasonWithBrain({
        ...request,
        tools: [{
            name: 'route_agent',
            description: 'Select an existing agent.',
            inputSchema: { type: 'object', properties: { agent: { type: 'string' } }, required: ['agent'] },
        }],
    }, {
        env: { ...baseEnv, BRAIN_PROVIDER: 'groq', BRAIN_ENABLE_AUTOMATIC_FALLBACK: 'false' },
        fetchImpl: async (url, options) => {
            captured = { url, options };
            return new Response(JSON.stringify({
                model: 'openai/gpt-oss-120b',
                choices: [{
                    message: {
                        role: 'assistant',
                        content: '',
                        tool_calls: [{
                            id: 'call-1',
                            type: 'function',
                            function: { name: 'route_agent', arguments: '{"agent":"scriptwriter"}' },
                        }],
                    },
                    finish_reason: 'tool_calls',
                }],
                usage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 },
            }), { status: 200 });
        },
    });

    assert.equal(captured.url, 'https://api.groq.com/openai/v1/chat/completions');
    assert.equal(captured.options.headers.authorization, `Bearer ${baseEnv.GROQ_API_KEY}`);
    assert.deepEqual(result.toolCalls, [{
        id: 'call-1',
        name: 'route_agent',
        arguments: { agent: 'scriptwriter' },
    }]);
    assert.equal(result.finishReason, 'tool_calls');
});

test('OpenRouter adapter uses the current free router and reports the model actually selected', async () => {
    let captured;
    const result = await reasonWithBrain(request, {
        env: { ...baseEnv, BRAIN_PROVIDER: 'openrouter', BRAIN_ENABLE_AUTOMATIC_FALLBACK: 'false' },
        fetchImpl: async (url, options) => {
            captured = { url, options };
            return compatibleSuccess('openrouter');
        },
    });

    assert.equal(captured.url, 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(JSON.parse(captured.options.body).model, 'openrouter/free');
    assert.equal(result.provider, 'openrouter');
    assert.equal(result.model, 'selected/free-model');
});

test('Anthropic remains available through the normalized brain interface', async () => {
    let captured;
    const result = await reasonWithBrain(request, {
        env: { ...baseEnv, BRAIN_PROVIDER: 'anthropic', BRAIN_ENABLE_AUTOMATIC_FALLBACK: 'false' },
        fetchImpl: async (url, options) => {
            captured = { url, options };
            return new Response(JSON.stringify({
                model: 'claude-sonnet-5',
                content: [{ type: 'text', text: 'Anthropic plan' }],
                stop_reason: 'end_turn',
                usage: { input_tokens: 11, output_tokens: 7 },
            }), { status: 200 });
        },
    });

    assert.equal(captured.url, 'https://api.anthropic.com/v1/messages');
    assert.equal(captured.options.headers['x-api-key'], baseEnv.ANTHROPIC_API_KEY);
    assert.equal(result.provider, 'anthropic');
    assert.equal(result.text, 'Anthropic plan');
    assert.deepEqual(result.usage, { inputTokens: 11, outputTokens: 7, totalTokens: 18 });
});

test('NVIDIA NIM adapter uses the OpenAI-compatible endpoint', async () => {
    let captured;
    const result = await reasonWithBrain(request, {
        env: { ...baseEnv, BRAIN_PROVIDER: 'nvidia', BRAIN_ENABLE_AUTOMATIC_FALLBACK: 'false' },
        fetchImpl: async (url, options) => {
            captured = { url, options };
            return compatibleSuccess('nvidia', 'NVIDIA plan');
        },
    });

    assert.equal(captured.url, 'https://integrate.api.nvidia.com/v1/chat/completions');
    assert.equal(captured.options.headers.authorization, `Bearer ${baseEnv.NVIDIA_API_KEY}`);
    assert.equal(JSON.parse(captured.options.body).model, baseEnv.NVIDIA_MODEL);
    assert.equal(result.provider, 'nvidia');
    assert.equal(result.text, 'NVIDIA plan');
});

test('NVIDIA brain model defaults to the current Build/NIM agentic reasoning model', async () => {
    let captured;
    const env = { ...baseEnv, BRAIN_PROVIDER: 'nvidia', BRAIN_ENABLE_AUTOMATIC_FALLBACK: 'false' };
    delete env.NVIDIA_MODEL;
    await reasonWithBrain(request, {
        env,
        fetchImpl: async (url, options) => {
            captured = { url, options };
            return compatibleSuccess('nvidia');
        },
    });
    assert.equal(JSON.parse(captured.options.body).model, 'nvidia/nemotron-3.5-lightning-30b-a3b');
});

test('NVIDIA_BRAIN_MODEL is the preferred configuration variable and takes precedence over legacy NVIDIA_MODEL', async () => {
    let captured;
    await reasonWithBrain(request, {
        env: {
            ...baseEnv,
            BRAIN_PROVIDER: 'nvidia',
            BRAIN_ENABLE_AUTOMATIC_FALLBACK: 'false',
            NVIDIA_MODEL: 'nvidia/llama-3.1-nemotron-70b-instruct',
            NVIDIA_BRAIN_MODEL: 'nvidia/nemotron-3.5-lightning-30b-a3b',
        },
        fetchImpl: async (url, options) => {
            captured = { url, options };
            return compatibleSuccess('nvidia');
        },
    });
    assert.equal(JSON.parse(captured.options.body).model, 'nvidia/nemotron-3.5-lightning-30b-a3b');
});

test('legacy NVIDIA_MODEL still configures the NVIDIA brain when NVIDIA_BRAIN_MODEL is unset', async () => {
    let captured;
    const env = { ...baseEnv, BRAIN_PROVIDER: 'nvidia', BRAIN_ENABLE_AUTOMATIC_FALLBACK: 'false' };
    delete env.NVIDIA_BRAIN_MODEL;
    await reasonWithBrain(request, {
        env,
        fetchImpl: async (url, options) => {
            captured = { url, options };
            return compatibleSuccess('nvidia');
        },
    });
    assert.equal(JSON.parse(captured.options.body).model, 'nvidia/llama-3.1-nemotron-70b-instruct');
});

test('the brain defaults to NVIDIA as primary with Gemini, Groq, OpenRouter, then Anthropic as fallbacks', () => {
    const configuration = getBrainConfiguration({
        NVIDIA_API_KEY: 'x',
        GEMINI_API_KEY: 'x',
        GROQ_API_KEY: 'x',
        OPENROUTER_API_KEY: 'x',
        ANTHROPIC_API_KEY: 'x',
    });
    assert.equal(configuration.selectedProvider, 'nvidia');
    assert.deepEqual(configuration.fallbackOrder, ['nvidia', 'gemini', 'groq', 'openrouter', 'anthropic']);
});

test('BRAIN_MAX_ATTEMPTS defaults to the length of the complete configured provider chain', () => {
    const fullChain = getBrainConfiguration({
        NVIDIA_API_KEY: 'x',
        GEMINI_API_KEY: 'x',
        GROQ_API_KEY: 'x',
        OPENROUTER_API_KEY: 'x',
        ANTHROPIC_API_KEY: 'x',
    });
    assert.equal(fullChain.maxAttempts, 5);

    const shortChain = getBrainConfiguration({
        BRAIN_PROVIDER: 'gemini',
        BRAIN_FALLBACK_ORDER: 'gemini,groq',
        GEMINI_API_KEY: 'x',
        GROQ_API_KEY: 'x',
    });
    assert.equal(shortChain.maxAttempts, 2);

    const explicit = getBrainConfiguration({
        NVIDIA_API_KEY: 'x',
        GEMINI_API_KEY: 'x',
        BRAIN_MAX_ATTEMPTS: '1',
    });
    assert.equal(explicit.maxAttempts, 1);
});

test('the default fallback chain reaches OpenRouter and Anthropic without an explicit BRAIN_MAX_ATTEMPTS override', async () => {
    const fullChainEnv = {
        NVIDIA_API_KEY: 'nvidia-test-provider-secret',
        GEMINI_API_KEY: 'gemini-test-provider-secret',
        GROQ_API_KEY: 'groq-test-provider-secret',
        OPENROUTER_API_KEY: 'openrouter-test-provider-secret',
        ANTHROPIC_API_KEY: 'anthropic-test-provider-secret',
    };
    const calls = [];
    const result = await reasonWithBrain(request, {
        env: fullChainEnv,
        fetchImpl: async (url) => {
            calls.push(url);
            if (calls.length < 5) {
                return new Response(JSON.stringify({ error: { message: 'temporarily unavailable' } }), { status: 503 });
            }
            return new Response(JSON.stringify({
                model: 'claude-sonnet-5',
                content: [{ type: 'text', text: 'Anthropic plan reached via full default fallback' }],
                stop_reason: 'end_turn',
                usage: { input_tokens: 5, output_tokens: 5 },
            }), { status: 200 });
        },
    });
    assert.equal(result.provider, 'anthropic');
    assert.equal(calls.length, 5);
    assert.deepEqual(calls, [
        'https://integrate.api.nvidia.com/v1/chat/completions',
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.7-flash:generateContent',
        'https://api.groq.com/openai/v1/chat/completions',
        'https://openrouter.ai/api/v1/chat/completions',
        'https://api.anthropic.com/v1/messages',
    ]);
});

test('a Gemini quota response falls back once to Groq', async () => {
    const calls = [];
    const result = await reasonWithBrain(request, {
        env: baseEnv,
        fetchImpl: async (url) => {
            calls.push(url);
            if (calls.length === 1) {
                return new Response(JSON.stringify({ error: { message: 'quota exhausted' } }), { status: 429 });
            }
            return compatibleSuccess('groq');
        },
    });

    assert.equal(result.provider, 'groq');
    assert.equal(calls.length, 2);
});

test('a provider timeout falls back to the next eligible provider', async () => {
    let calls = 0;
    const result = await reasonWithBrain(request, {
        env: baseEnv,
        fetchImpl: async () => {
            calls += 1;
            if (calls === 1) {
                const error = new Error('aborted');
                error.name = 'AbortError';
                throw error;
            }
            return compatibleSuccess('groq');
        },
    });
    assert.equal(result.provider, 'groq');
    assert.equal(calls, 2);
});

test('temporary provider errors can reach the OpenRouter tertiary fallback', async () => {
    const calls = [];
    const result = await reasonWithBrain(request, {
        env: baseEnv,
        fetchImpl: async (url) => {
            calls.push(url);
            if (calls.length < 3) {
                return new Response(JSON.stringify({ error: { message: 'temporarily unavailable' } }), { status: 503 });
            }
            return compatibleSuccess('openrouter');
        },
    });
    assert.equal(result.provider, 'openrouter');
    assert.equal(calls.length, 3);
});

test('an explicitly unsupported capability falls back cleanly', async () => {
    let calls = 0;
    const result = await reasonWithBrain(request, {
        env: baseEnv,
        fetchImpl: async () => {
            calls += 1;
            if (calls === 1) {
                return new Response(JSON.stringify({
                    error: { message: 'This model does not support the requested capability.' },
                }), { status: 400 });
            }
            return compatibleSuccess('groq');
        },
    });
    assert.equal(result.provider, 'groq');
    assert.equal(calls, 2);
});

test('malformed provider responses can fall back without exposing provider data', async () => {
    let calls = 0;
    const result = await reasonWithBrain(request, {
        env: baseEnv,
        fetchImpl: async () => {
            calls += 1;
            return calls === 1 ? new Response('not-json', { status: 200 }) : compatibleSuccess('groq');
        },
    });
    assert.equal(result.provider, 'groq');
    assert.equal(calls, 2);
});

test('BRAIN_MAX_ATTEMPTS strictly bounds provider attempts', async () => {
    let calls = 0;
    await assert.rejects(
        reasonWithBrain(request, {
            env: { ...baseEnv, BRAIN_MAX_ATTEMPTS: '2' },
            fetchImpl: async () => {
                calls += 1;
                return new Response(JSON.stringify({ error: { message: 'temporary outage' } }), { status: 503 });
            },
        }),
        (error) => {
            assert.equal(error instanceof BrainRouterError, true);
            assert.deepEqual(error.attemptedProviders, ['gemini', 'groq']);
            return true;
        },
    );
    assert.equal(calls, 2);
});

test('safety rejections never fall back', async () => {
    let calls = 0;
    await assert.rejects(
        reasonWithBrain(request, {
            env: baseEnv,
            fetchImpl: async () => {
                calls += 1;
                return new Response(JSON.stringify({
                    candidates: [{ content: { parts: [] }, finishReason: 'SAFETY' }],
                }), { status: 200 });
            },
        }),
        (error) => error.code === 'safety_rejection' && error.attemptedProviders.length === 1,
    );
    assert.equal(calls, 1);
});

test('invalid provider credentials and rejected input never fall back', async () => {
    for (const [status, code] of [[401, 'provider_credentials'], [400, 'provider_rejected']]) {
        let calls = 0;
        await assert.rejects(
            reasonWithBrain(request, {
                env: baseEnv,
                fetchImpl: async () => {
                    calls += 1;
                    return new Response(JSON.stringify({ error: { message: 'request rejected' } }), { status });
                },
            }),
            (error) => error.code === code,
        );
        assert.equal(calls, 1);
    }
});

test('invalid requests are rejected before any provider call', async () => {
    let calls = 0;
    await assert.rejects(
        reasonWithBrain({ task: '', sensitivity: 'NORMAL' }, {
            env: baseEnv,
            fetchImpl: async () => { calls += 1; return geminiSuccess(); },
        }),
        (error) => error.code === 'invalid_request',
    );
    assert.equal(calls, 0);
});

test('internal brain callers retain the repository content-safety boundary', async () => {
    let calls = 0;
    await assert.rejects(
        reasonWithBrain({
            task: 'Create explicit sexual content involving a child.',
            sensitivity: 'NORMAL',
        }, {
            env: { ...baseEnv, CONTENT_SAFETY_MODE: 'enforce' },
            fetchImpl: async () => { calls += 1; return geminiSuccess(); },
        }),
        (error) => error.code === 'safety_rejection',
    );
    assert.equal(calls, 0);
});

test('a missing primary API key is skipped in favor of the next configured provider when fallback is enabled', async () => {
    const calls = [];
    const result = await reasonWithBrain(request, {
        env: { ...baseEnv, BRAIN_PROVIDER: 'nvidia', NVIDIA_API_KEY: '', BRAIN_FALLBACK_ORDER: 'gemini,groq,openrouter' },
        fetchImpl: async (url) => {
            calls.push(url);
            return geminiSuccess('Gemini plan via fallback');
        },
    });
    assert.equal(result.provider, 'gemini');
    assert.deepEqual(calls, ['https://generativelanguage.googleapis.com/v1beta/models/gemini-3.7-flash:generateContent']);
});

test('a missing primary API key fails closed immediately when automatic fallback is disabled', async () => {
    let calls = 0;
    await assert.rejects(
        reasonWithBrain(request, {
            env: { ...baseEnv, GEMINI_API_KEY: '', BRAIN_ENABLE_AUTOMATIC_FALLBACK: 'false' },
            fetchImpl: async () => { calls += 1; return compatibleSuccess('groq'); },
        }),
        (error) => error.code === 'provider_configuration_missing' && error.provider === 'gemini',
    );
    assert.equal(calls, 0);
});

test('an explicit providerOverride with a missing key fails closed instead of silently rerouting', async () => {
    let calls = 0;
    await assert.rejects(
        reasonWithBrain(request, {
            env: { ...baseEnv, NVIDIA_API_KEY: '' },
            providerOverride: 'nvidia',
            fetchImpl: async () => { calls += 1; return compatibleSuccess('groq'); },
        }),
        (error) => error.code === 'provider_configuration_missing' && error.provider === 'nvidia',
    );
    assert.equal(calls, 0);
});

test('missing keys across the whole eligible chain fail clearly once no configured provider remains', async () => {
    let calls = 0;
    await assert.rejects(
        reasonWithBrain(request, {
            env: {
                ...baseEnv,
                GEMINI_API_KEY: '',
                GROQ_API_KEY: '',
                OPENROUTER_API_KEY: '',
                BRAIN_FALLBACK_ORDER: 'gemini,groq,openrouter',
            },
            fetchImpl: async () => { calls += 1; return geminiSuccess(); },
        }),
        (error) => error.code === 'provider_configuration_missing' && error.attemptedProviders.length === 0,
    );
    assert.equal(calls, 0);
});

test('a missing key combined with a sensitivity-restricted chain fails clearly without broadening eligibility', async () => {
    let calls = 0;
    await assert.rejects(
        reasonWithBrain({ ...request, sensitivity: 'PRIVATE' }, {
            env: {
                ...baseEnv,
                BRAIN_PROVIDER: 'nvidia',
                NVIDIA_API_KEY: '',
                BRAIN_PRIVATE_ELIGIBLE_PROVIDERS: 'nvidia',
            },
            fetchImpl: async () => { calls += 1; return geminiSuccess(); },
        }),
        (error) => error.code === 'provider_configuration_missing',
    );
    assert.equal(calls, 0);
});

test('sensitive work fails closed when no reviewed provider is eligible', async () => {
    let calls = 0;
    await assert.rejects(
        reasonWithBrain({ ...request, sensitivity: 'CLIENT_CONFIDENTIAL' }, {
            env: baseEnv,
            fetchImpl: async () => { calls += 1; return geminiSuccess(); },
        }),
        (error) => error.code === 'sensitivity_provider_unavailable',
    );
    assert.equal(calls, 0);
});

test('sensitivity routing only calls an explicitly reviewed eligible provider', async () => {
    const calls = [];
    const result = await reasonWithBrain({ ...request, sensitivity: 'PRIVATE' }, {
        env: { ...baseEnv, BRAIN_PRIVATE_ELIGIBLE_PROVIDERS: 'groq' },
        fetchImpl: async (url) => {
            calls.push(url);
            return compatibleSuccess('groq');
        },
    });
    assert.equal(result.provider, 'groq');
    assert.deepEqual(calls, ['https://api.groq.com/openai/v1/chat/completions']);
});

test('paid-generation and publishing classifications disable automatic fallback', async () => {
    for (const sideEffect of ['paid-generation', 'publishing']) {
        let calls = 0;
        await assert.rejects(
            reasonWithBrain({ ...request, sideEffect }, {
                env: baseEnv,
                fetchImpl: async () => {
                    calls += 1;
                    return new Response(JSON.stringify({ error: { message: 'quota' } }), { status: 429 });
                },
            }),
            (error) => error.code === 'provider_capacity',
        );
        assert.equal(calls, 1);
    }
});

test('structured output is normalized without leaking provider-specific shapes', async () => {
    const result = await reasonWithBrain({
        ...request,
        desiredOutput: {
            type: 'json',
            schema: {
                type: 'object',
                properties: { title: { type: 'string' } },
                required: ['title'],
            },
        },
    }, {
        env: baseEnv,
        fetchImpl: async () => geminiSuccess('{"title":"Launch"}'),
    });
    assert.deepEqual(result.structuredOutput, { title: 'Launch' });
});

test('brain status distinguishes build and configuration without exposing secrets', () => {
    const configuration = getBrainConfiguration(baseEnv);
    const providers = brainProviderStatuses(baseEnv);
    const router = brainRouterStatus(baseEnv);
    const serialized = JSON.stringify({ configuration, providers, router });

    assert.equal(configuration.selectedProvider, 'gemini');
    assert.deepEqual(configuration.fallbackOrder, ['gemini', 'groq', 'openrouter']);
    assert.equal(router.configured, true);
    assert.equal(router.built, true);
    assert.equal(router.selectedProvider, 'gemini');
    assert.equal(providers.find((provider) => provider.id === 'anthropic').inFallbackOrder, false);
    for (const key of [
        baseEnv.GEMINI_API_KEY,
        baseEnv.GROQ_API_KEY,
        baseEnv.OPENROUTER_API_KEY,
        baseEnv.ANTHROPIC_API_KEY,
    ]) assert.equal(serialized.includes(key), false);
});

test('brain errors serialize only safe routing metadata', () => {
    const failure = brainErrorResponse(new BrainRouterError(
        'provider_credentials',
        'Google Gemini rejected its server-side credentials.',
        502,
        { provider: 'gemini', attemptedProviders: ['gemini'] },
    ));
    assert.deepEqual(failure, {
        status: 502,
        body: {
            error: 'Google Gemini rejected its server-side credentials.',
            code: 'provider_credentials',
            provider: 'gemini',
            attemptedProviders: ['gemini'],
        },
    });
});
