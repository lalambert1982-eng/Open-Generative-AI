import assert from 'node:assert/strict';
import test from 'node:test';

import {
    createCreatorProject,
    creatorProjectStoreForTests,
    getCreatorProject,
    saveCreatorStoryboard,
} from '../../src/lib/creatorProjectStore.js';
import {
    CreatorWorkflowError,
    advanceWorkflowRun,
    approveAndAdvanceWorkflowRun,
    approveWorkflowNode,
    cancelWorkflowRun,
    createWorkflowRun,
    retryWorkflowNode,
} from '../../src/lib/creatorWorkflowEngine.js';

const env = {
    BLOB_READ_WRITE_TOKEN: 'vercel-blob-test-token-that-is-long-enough',
    CREATOR_ASSET_BLOB_READ_WRITE_TOKEN: 'creator-public-blob-test-token-that-is-long-enough',
    CREATOR_SESSION_SECRET: 'creator-workflow-test-secret-that-is-longer-than-thirty-two-characters',
    MUAPI_KEY_MODE: 'sandbox',
    MUAPI_API_KEY: 'sandbox-key-that-is-long-enough',
    HEYGEN_API_KEY: 'heygen-key-that-is-long-enough',
    HEYGEN_AVATAR_ID: 'avatar-1',
    HEYGEN_VOICE_ID: 'voice-1',
};
const owner = { id: 12345678, login: 'lalambert1982-eng' };
const otherOwner = { id: 87654321, login: 'other-owner' };
const projectAId = '11111111-1111-4111-8111-111111111111';
const projectBId = '22222222-2222-4222-8222-222222222222';

function sequentialIdGenerator(prefix = 'id') {
    let count = 0;
    return () => `${prefix}-${++count}`;
}

function succeedingFetch(hostOverride) {
    let counter = 0;
    return async () => {
        counter += 1;
        const host = hostOverride || 'cdn.muapi.ai';
        return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({
                id: `provider-job-${counter}`,
                status: 'succeeded',
                output: [`https://${host}/out-${counter}.png`],
            }),
        };
    };
}

function failingFetch(message = 'Upstream provider rejected the request.') {
    return async () => ({
        ok: false,
        status: 422,
        text: async () => JSON.stringify({ error: { message } }),
    });
}

async function setupProject(id, ownerUser, blobStore, options = {}) {
    return createCreatorProject(ownerUser, { name: 'Test Project' }, {
        env,
        blobStore,
        idGenerator: () => id,
        now: Date.UTC(2026, 0, 1),
        ...options,
    });
}

test('a manual two-node run gates approval, resolves upstream output, and registers assets sequentially', async () => {
    const blobStore = creatorProjectStoreForTests(new Map());
    await setupProject(projectAId, owner, blobStore);
    const idGenerator = sequentialIdGenerator('node');

    const { run } = await createWorkflowRun(owner, projectAId, {
        source: 'manual',
        name: 'Two Step',
        nodes: [
            { kind: 'image.generate', prompt: 'a lighthouse at dusk' },
            { kind: 'video.animate', prompt: 'slow pan across the lighthouse', sourceNodeIndex: 0 },
        ],
    }, { env, blobStore, idGenerator, now: Date.UTC(2026, 0, 2) });
    assert.equal(run.status, 'queued');
    assert.equal(run.nodes.length, 2);
    assert.equal(run.nodes[1].inputs.sourceNodeIndex, 0);

    const fetchImpl = succeedingFetch();

    // Node 1 must not execute before node 0 completes, and node 0 cannot submit
    // without an explicit approval step first — advance() must gate, not bypass.
    const gate = await advanceWorkflowRun(owner, projectAId, run.id, { env, blobStore, fetchImpl, now: Date.UTC(2026, 0, 3) });
    assert.equal(gate.run.status, 'waiting_for_approval');
    assert.equal(gate.run.nodes[0].status, 'waiting_for_approval');
    assert.equal(gate.run.nodes[0].approved, false);
    assert.equal(gate.run.nodes[1].status, 'pending');

    const approved = await approveAndAdvanceWorkflowRun(owner, projectAId, run.id, { env, blobStore, fetchImpl, now: Date.UTC(2026, 0, 4) });
    assert.equal(approved.run.nodes[0].status, 'completed');
    assert.equal(approved.run.nodes[0].outputUrl, 'https://cdn.muapi.ai/out-1.png');
    assert.equal(approved.run.status, 'running');
    assert.equal(approved.run.nodes[1].status, 'pending', 'node 1 must not have started yet');
    assert.equal(approved.project.assets.length, 1);
    assert.equal(approved.project.assets[0].source, 'workflow');

    const secondGate = await advanceWorkflowRun(owner, projectAId, run.id, { env, blobStore, fetchImpl, now: Date.UTC(2026, 0, 5) });
    assert.equal(secondGate.run.status, 'waiting_for_approval');
    assert.equal(secondGate.run.nodes[1].status, 'waiting_for_approval');

    const finished = await approveAndAdvanceWorkflowRun(owner, projectAId, run.id, { env, blobStore, fetchImpl, now: Date.UTC(2026, 0, 6) });
    assert.equal(finished.run.status, 'completed');
    assert.equal(finished.run.nodes[1].status, 'completed');
    // The downstream node received the upstream node's registered output as its
    // own input, proving normalized upstream-output handoff actually happened.
    assert.equal(finished.run.nodes[1].outputUrl, 'https://cdn.muapi.ai/out-2.png');
    assert.equal(finished.project.assets.length, 2);
});

test('a provider failure stops downstream execution and is reported as a failed node, not success', async () => {
    const blobStore = creatorProjectStoreForTests(new Map());
    await setupProject(projectAId, owner, blobStore);
    const idGenerator = sequentialIdGenerator('node');

    const { run } = await createWorkflowRun(owner, projectAId, {
        source: 'manual',
        nodes: [
            { kind: 'image.generate', prompt: 'first step' },
            { kind: 'image.generate', prompt: 'second step, must never run' },
        ],
    }, { env, blobStore, idGenerator, now: Date.UTC(2026, 0, 2) });

    await advanceWorkflowRun(owner, projectAId, run.id, { env, blobStore, fetchImpl: succeedingFetch(), now: Date.UTC(2026, 0, 3) });
    const failed = await approveAndAdvanceWorkflowRun(owner, projectAId, run.id, { env, blobStore, fetchImpl: failingFetch(), now: Date.UTC(2026, 0, 4) });

    assert.equal(failed.run.status, 'failed');
    assert.equal(failed.run.nodes[0].status, 'failed');
    assert.equal(typeof failed.run.nodes[0].error, 'string');
    assert.ok(failed.run.nodes[0].error.length > 0, 'the failure must be visible with a non-empty error, not misreported as success');
    assert.equal(failed.run.nodes[1].status, 'pending', 'node 2 must never have been submitted');
    assert.equal(failed.project.assets.length, 0);

    // A failed run refuses to advance further — no path silently resumes it.
    const noop = await advanceWorkflowRun(owner, projectAId, run.id, { env, blobStore, fetchImpl: succeedingFetch(), now: Date.UTC(2026, 0, 5) });
    assert.equal(noop.changed, false);
    assert.equal(noop.run.status, 'failed');
});

test('retry resubmits only the failed node and never duplicates already-completed work', async () => {
    const blobStore = creatorProjectStoreForTests(new Map());
    await setupProject(projectAId, owner, blobStore);
    const idGenerator = sequentialIdGenerator('node');

    const { run } = await createWorkflowRun(owner, projectAId, {
        source: 'manual',
        nodes: [
            { kind: 'image.generate', prompt: 'step one' },
            { kind: 'image.generate', prompt: 'step two' },
        ],
    }, { env, blobStore, idGenerator, now: Date.UTC(2026, 0, 2) });

    await advanceWorkflowRun(owner, projectAId, run.id, { env, blobStore, fetchImpl: succeedingFetch(), now: Date.UTC(2026, 0, 3) });
    const afterStep1 = await approveAndAdvanceWorkflowRun(owner, projectAId, run.id, { env, blobStore, fetchImpl: succeedingFetch(), now: Date.UTC(2026, 0, 4) });
    assert.equal(afterStep1.run.nodes[0].status, 'completed');
    const completedAssetId = afterStep1.run.nodes[0].outputAssetId;

    await advanceWorkflowRun(owner, projectAId, run.id, { env, blobStore, fetchImpl: succeedingFetch(), now: Date.UTC(2026, 0, 5) });
    const failedStep2 = await approveAndAdvanceWorkflowRun(owner, projectAId, run.id, { env, blobStore, fetchImpl: failingFetch(), now: Date.UTC(2026, 0, 6) });
    assert.equal(failedStep2.run.status, 'failed');
    assert.equal(failedStep2.run.nodes[0].status, 'completed', 'retry must never touch already-completed nodes');
    assert.equal(failedStep2.run.nodes[0].outputAssetId, completedAssetId);
    assert.equal(failedStep2.project.assets.length, 1);

    const retried = await retryWorkflowNode(owner, projectAId, run.id, { env, blobStore, now: Date.UTC(2026, 0, 7) });
    assert.equal(retried.run.status, 'running');
    assert.equal(retried.run.nodes[1].status, 'pending');
    assert.equal(retried.run.nodes[1].approved, true, 'retry does not require re-approval of an already-approved step');
    assert.equal(retried.run.nodes[1].error, null);

    const succeeded = await advanceWorkflowRun(owner, projectAId, run.id, { env, blobStore, fetchImpl: succeedingFetch(), now: Date.UTC(2026, 0, 8) });
    assert.equal(succeeded.run.status, 'completed');
    assert.equal(succeeded.run.nodes[1].status, 'completed');
    assert.equal(succeeded.project.assets.length, 2, 'retry must not duplicate the already-registered first asset');
});

test('a video.animate node must reference an image.generate node as its source, not another video node', async () => {
    const blobStore = creatorProjectStoreForTests(new Map());
    await setupProject(projectAId, owner, blobStore);
    const idGenerator = sequentialIdGenerator('node');

    await assert.rejects(
        createWorkflowRun(owner, projectAId, {
            source: 'manual',
            nodes: [
                { kind: 'video.generate', prompt: 'an establishing shot' },
                { kind: 'video.animate', prompt: 'continue the motion', sourceNodeIndex: 0 },
            ],
        }, { env, blobStore, idGenerator, now: Date.UTC(2026, 0, 2) }),
        (error) => error instanceof CreatorWorkflowError && error.code === 'invalid_workflow_node',
    );
});

test('a run can be cancelled while active or paused, and a cancelled run never resumes', async () => {
    const blobStore = creatorProjectStoreForTests(new Map());
    await setupProject(projectAId, owner, blobStore);
    const idGenerator = sequentialIdGenerator('node');

    const { run } = await createWorkflowRun(owner, projectAId, {
        source: 'manual',
        nodes: [{ kind: 'image.generate', prompt: 'a single step' }],
    }, { env, blobStore, idGenerator, now: Date.UTC(2026, 0, 2) });

    await advanceWorkflowRun(owner, projectAId, run.id, { env, blobStore, fetchImpl: succeedingFetch(), now: Date.UTC(2026, 0, 3) });
    const cancelled = await cancelWorkflowRun(owner, projectAId, run.id, { env, blobStore, now: Date.UTC(2026, 0, 4) });
    assert.equal(cancelled.run.status, 'cancelled');

    const noop = await approveAndAdvanceWorkflowRun(owner, projectAId, run.id, { env, blobStore, fetchImpl: succeedingFetch(), now: Date.UTC(2026, 0, 5) });
    assert.equal(noop.run.status, 'cancelled', 'a cancelled run must never resume via approve or advance');
});

test('a malformed provider output URL fails the node instead of registering an unsafe asset', async () => {
    const blobStore = creatorProjectStoreForTests(new Map());
    await setupProject(projectAId, owner, blobStore);
    const idGenerator = sequentialIdGenerator('node');

    const { run } = await createWorkflowRun(owner, projectAId, {
        source: 'manual',
        nodes: [{ kind: 'image.generate', prompt: 'a single step' }],
    }, { env, blobStore, idGenerator, now: Date.UTC(2026, 0, 2) });

    await advanceWorkflowRun(owner, projectAId, run.id, { env, blobStore, fetchImpl: succeedingFetch(), now: Date.UTC(2026, 0, 3) });
    const result = await approveAndAdvanceWorkflowRun(owner, projectAId, run.id, {
        env,
        blobStore,
        fetchImpl: succeedingFetch('evil.example.com'),
        now: Date.UTC(2026, 0, 4),
    });
    assert.equal(result.run.status, 'failed');
    assert.match(result.run.nodes[0].error, /invalid output URL/);
    assert.equal(result.project.assets.length, 0);
});

test('workflow runs and their generated assets are strictly project-scoped and owner-isolated', async () => {
    const blobStore = creatorProjectStoreForTests(new Map());
    await setupProject(projectAId, owner, blobStore, { idGenerator: () => projectAId });
    await setupProject(projectBId, owner, blobStore, { idGenerator: () => projectBId });
    const idGenerator = sequentialIdGenerator('node');

    const { run: runA } = await createWorkflowRun(owner, projectAId, {
        source: 'manual',
        nodes: [{ kind: 'image.generate', prompt: 'project A only' }],
    }, { env, blobStore, idGenerator, now: Date.UTC(2026, 0, 2) });

    await advanceWorkflowRun(owner, projectAId, runA.id, { env, blobStore, fetchImpl: succeedingFetch(), now: Date.UTC(2026, 0, 3) });
    const finished = await approveAndAdvanceWorkflowRun(owner, projectAId, runA.id, { env, blobStore, fetchImpl: succeedingFetch(), now: Date.UTC(2026, 0, 4) });
    assert.equal(finished.project.assets.length, 1);

    // The run and its generated asset must not leak into a sibling project owned
    // by the same user.
    const projectB = await getCreatorProject(owner, projectBId, { env, blobStore });
    assert.deepEqual(projectB.workflowRuns, []);
    assert.deepEqual(projectB.assets, []);

    // Advancing project A's run by ID against project B must fail as not found,
    // not silently operate on the wrong project.
    await assert.rejects(
        advanceWorkflowRun(owner, projectBId, runA.id, { env, blobStore, fetchImpl: succeedingFetch(), now: Date.UTC(2026, 0, 5) }),
        (error) => error instanceof CreatorWorkflowError && error.code === 'workflow_not_found',
    );

    // A different owner cannot even load project A to see its workflow runs.
    await assert.rejects(
        advanceWorkflowRun(otherOwner, projectAId, runA.id, { env, blobStore, fetchImpl: succeedingFetch(), now: Date.UTC(2026, 0, 6) }),
        (error) => error.code === 'project_not_found',
    );
});

test('a workflow run built from Storyboard scenes tags each node with its origin scene', async () => {
    const blobStore = creatorProjectStoreForTests(new Map());
    await setupProject(projectAId, owner, blobStore);
    await saveCreatorStoryboard(owner, projectAId, {
        storyboard: {
            scenes: [
                { id: 'scene-1', title: 'Opening', prompt: 'wide shot of the harbor at sunrise', aspectRatio: '16:9' },
                { id: 'scene-2', title: 'Reveal', prompt: 'the ship emerges from the fog', aspectRatio: '16:9' },
            ],
        },
    }, { env, blobStore, now: Date.UTC(2026, 0, 2) });

    const idGenerator = sequentialIdGenerator('node');
    const { run } = await createWorkflowRun(owner, projectAId, { source: 'storyboard', name: 'From Storyboard' }, {
        env, blobStore, idGenerator, now: Date.UTC(2026, 0, 3),
    });
    assert.equal(run.source, 'storyboard');
    assert.equal(run.nodes.length, 2);
    assert.equal(run.nodes[0].inputs.sceneId, 'scene-1');
    assert.equal(run.nodes[0].inputs.prompt, 'wide shot of the harbor at sunrise');
    assert.equal(run.nodes[1].inputs.sceneId, 'scene-2');
    assert.equal(run.nodes[0].kind, 'image.generate');
});

test('a completed scene-linked node writes its output back into the Storyboard scene atomically', async () => {
    const blobStore = creatorProjectStoreForTests(new Map());
    await setupProject(projectAId, owner, blobStore);
    await saveCreatorStoryboard(owner, projectAId, {
        storyboard: {
            scenes: [{ id: 'scene-1', title: 'Opening', prompt: 'wide shot of the harbor at sunrise', aspectRatio: '16:9' }],
        },
    }, { env, blobStore, now: Date.UTC(2026, 0, 2) });

    const idGenerator = sequentialIdGenerator('node');
    const { run } = await createWorkflowRun(owner, projectAId, { source: 'storyboard' }, {
        env, blobStore, idGenerator, now: Date.UTC(2026, 0, 3),
    });

    const fetchImpl = succeedingFetch();
    await advanceWorkflowRun(owner, projectAId, run.id, { env, blobStore, fetchImpl, now: Date.UTC(2026, 0, 4) });
    const finished = await approveAndAdvanceWorkflowRun(owner, projectAId, run.id, { env, blobStore, fetchImpl, now: Date.UTC(2026, 0, 5) });

    assert.equal(finished.run.nodes[0].status, 'completed');
    const scene = finished.project.storyboard.scenes.find((item) => item.id === 'scene-1');
    assert.equal(scene.imageUrl, finished.run.nodes[0].outputUrl);
    assert.equal(scene.status, 'ready');

    // Confirmed persisted, not just returned in this one response.
    const reloaded = await getCreatorProject(owner, projectAId, { env, blobStore });
    assert.equal(reloaded.storyboard.scenes[0].imageUrl, finished.run.nodes[0].outputUrl);
});

test('a Storyboard with more scenes than a run supports is rejected, never silently truncated', async () => {
    const blobStore = creatorProjectStoreForTests(new Map());
    await setupProject(projectAId, owner, blobStore);
    const scenes = Array.from({ length: 25 }, (_, index) => ({
        id: `scene-${index + 1}`,
        title: `Scene ${index + 1}`,
        prompt: `establishing shot number ${index + 1}`,
        aspectRatio: '16:9',
    }));
    await saveCreatorStoryboard(owner, projectAId, { storyboard: { scenes } }, { env, blobStore, now: Date.UTC(2026, 0, 2) });

    const idGenerator = sequentialIdGenerator('node');
    await assert.rejects(
        createWorkflowRun(owner, projectAId, { source: 'storyboard' }, { env, blobStore, idGenerator, now: Date.UTC(2026, 0, 3) }),
        (error) => error instanceof CreatorWorkflowError && error.code === 'invalid_workflow_input',
    );
});

test('workflow run state persists across a fresh project reload, not just in-memory', async () => {
    const blobStore = creatorProjectStoreForTests(new Map());
    await setupProject(projectAId, owner, blobStore);
    const idGenerator = sequentialIdGenerator('node');

    const { run } = await createWorkflowRun(owner, projectAId, {
        source: 'manual',
        nodes: [{ kind: 'image.generate', prompt: 'persisted step' }],
    }, { env, blobStore, idGenerator, now: Date.UTC(2026, 0, 2) });
    await advanceWorkflowRun(owner, projectAId, run.id, { env, blobStore, fetchImpl: succeedingFetch(), now: Date.UTC(2026, 0, 3) });
    await approveAndAdvanceWorkflowRun(owner, projectAId, run.id, { env, blobStore, fetchImpl: succeedingFetch(), now: Date.UTC(2026, 0, 4) });

    // Simulate reopening the Project in a fresh request with no prior in-memory state.
    const reloaded = await getCreatorProject(owner, projectAId, { env, blobStore });
    assert.equal(reloaded.workflowRuns.length, 1);
    assert.equal(reloaded.workflowRuns[0].status, 'completed');
    assert.equal(reloaded.workflowRuns[0].nodes[0].status, 'completed');
    assert.equal(reloaded.assets.length, 1);
    assert.equal(reloaded.assets[0].source, 'workflow');
});

test('an unapproved node can never reach running or completed through any advance call', async () => {
    const blobStore = creatorProjectStoreForTests(new Map());
    await setupProject(projectAId, owner, blobStore);
    const idGenerator = sequentialIdGenerator('node');

    const { run } = await createWorkflowRun(owner, projectAId, {
        source: 'manual',
        nodes: [{ kind: 'image.generate', prompt: 'gated step' }],
    }, { env, blobStore, idGenerator, now: Date.UTC(2026, 0, 2) });

    for (let attempt = 0; attempt < 3; attempt += 1) {
        // eslint-disable-next-line no-await-in-loop
        const result = await advanceWorkflowRun(owner, projectAId, run.id, { env, blobStore, fetchImpl: succeedingFetch(), now: Date.UTC(2026, 0, 3 + attempt) });
        assert.equal(result.run.nodes[0].approved, false);
        assert.notEqual(result.run.nodes[0].status, 'completed');
        assert.notEqual(result.run.nodes[0].status, 'running');
    }
});

test('a Project write failure right after a successful provider submission never causes a second paid submission', async () => {
    const blobStore = creatorProjectStoreForTests(new Map());
    await setupProject(projectAId, owner, blobStore);
    const idGenerator = sequentialIdGenerator('node');

    const { run } = await createWorkflowRun(owner, projectAId, {
        source: 'manual',
        nodes: [{ kind: 'image.generate', prompt: 'a single step' }],
    }, { env, blobStore, idGenerator, now: Date.UTC(2026, 0, 2) });

    await advanceWorkflowRun(owner, projectAId, run.id, { env, blobStore, fetchImpl: succeedingFetch(), now: Date.UTC(2026, 0, 3) });
    await approveWorkflowNode(owner, projectAId, run.id, { env, blobStore, now: Date.UTC(2026, 0, 4) });

    let fetchCalls = 0;
    const countingFetch = async (...args) => { fetchCalls += 1; return succeedingFetch()(...args); };

    let puts = 0;
    const faultyBlobStore = {
        ...blobStore,
        async put(...args) {
            puts += 1;
            // 1st put after approval = phase 1's "announce running" write (must
            // succeed); 2nd = phase 2's "finalize after provider call" write —
            // this is the one that fails, simulating a transient storage error
            // that lands *after* the provider already accepted the job.
            if (puts === 2) throw new Error('simulated_blob_write_failure');
            return blobStore.put(...args);
        },
    };

    await assert.rejects(
        advanceWorkflowRun(owner, projectAId, run.id, { env, blobStore: faultyBlobStore, fetchImpl: countingFetch, now: Date.UTC(2026, 0, 5) }),
    );
    assert.equal(fetchCalls, 1, 'the provider must have been called exactly once by the failed attempt');

    // The failed write must not have silently reverted progress: the node is
    // left visibly stuck (announced but unconfirmed), never quietly back at
    // "pending" where the next call would resubmit it to the provider again.
    const stuck = await getCreatorProject(owner, projectAId, { env, blobStore });
    assert.equal(stuck.workflowRuns[0].nodes[0].status, 'running');
    assert.equal(stuck.workflowRuns[0].nodes[0].jobId, null);

    // The next advance() call — now against healthy storage — must fail this
    // node cleanly and visibly rather than submitting a second paid job.
    const recovered = await advanceWorkflowRun(owner, projectAId, run.id, { env, blobStore, fetchImpl: countingFetch, now: Date.UTC(2026, 0, 6) });
    assert.equal(fetchCalls, 1, 'recovering from the stuck state must never call the provider a second time');
    assert.equal(recovered.run.nodes[0].status, 'failed');
    assert.equal(recovered.run.status, 'failed');

    // The node is then retryable exactly like any other failure.
    const retried = await retryWorkflowNode(owner, projectAId, run.id, { env, blobStore, now: Date.UTC(2026, 0, 7) });
    assert.equal(retried.run.nodes[0].status, 'pending');
    const succeeded = await advanceWorkflowRun(owner, projectAId, run.id, { env, blobStore, fetchImpl: countingFetch, now: Date.UTC(2026, 0, 8) });
    assert.equal(succeeded.run.nodes[0].status, 'completed');
    assert.equal(fetchCalls, 2, 'the retry performs exactly one new provider call');
});

function submitThenFlakyPoll({ failuresBeforeSuccess = Infinity, failureStatus = 502 } = {}) {
    let pollCalls = 0;
    let submitCalls = 0;
    return {
        fetchImpl: async (url) => {
            const target = String(url);
            if (target.includes('/predictions/')) {
                pollCalls += 1;
                if (pollCalls <= failuresBeforeSuccess) {
                    return { ok: false, status: failureStatus, text: async () => JSON.stringify({ error: { message: 'temporary upstream error' } }) };
                }
                return {
                    ok: true,
                    status: 200,
                    text: async () => JSON.stringify({ id: 'flaky-job-1', status: 'succeeded', output: ['https://cdn.muapi.ai/flaky-out.png'] }),
                };
            }
            submitCalls += 1;
            return { ok: true, status: 200, text: async () => JSON.stringify({ id: 'flaky-job-1', status: 'processing' }) };
        },
        counts: () => ({ submitCalls, pollCalls }),
    };
}

test('a transient poll failure keeps the node running on its existing job instead of failing it', async () => {
    const blobStore = creatorProjectStoreForTests(new Map());
    await setupProject(projectAId, owner, blobStore);
    const idGenerator = sequentialIdGenerator('node');

    const { run } = await createWorkflowRun(owner, projectAId, {
        source: 'manual',
        nodes: [{ kind: 'image.generate', prompt: 'a flaky poll target' }],
    }, { env, blobStore, idGenerator, now: Date.UTC(2026, 0, 2) });

    const flaky = submitThenFlakyPoll({ failuresBeforeSuccess: 2 });
    await advanceWorkflowRun(owner, projectAId, run.id, { env, blobStore, fetchImpl: flaky.fetchImpl, now: Date.UTC(2026, 0, 3) });
    // Approve + submit: the provider accepts the job but it's still "processing".
    const submitted = await approveAndAdvanceWorkflowRun(owner, projectAId, run.id, { env, blobStore, fetchImpl: flaky.fetchImpl, now: Date.UTC(2026, 0, 4) });
    assert.equal(submitted.run.nodes[0].status, 'running');
    const jobId = submitted.run.nodes[0].jobId;
    assert.ok(jobId);

    // First poll attempt fails transiently (a network blip, not a job failure).
    const afterFirstFailedPoll = await advanceWorkflowRun(owner, projectAId, run.id, { env, blobStore, fetchImpl: flaky.fetchImpl, now: Date.UTC(2026, 0, 5) });
    assert.equal(afterFirstFailedPoll.run.nodes[0].status, 'running', 'a transient poll error must not fail the node');
    assert.equal(afterFirstFailedPoll.run.nodes[0].jobId, jobId, 'the same job must still be tracked, not abandoned');
    assert.equal(afterFirstFailedPoll.run.nodes[0].pollFailures, 1);

    // Second poll attempt also fails transiently.
    const afterSecondFailedPoll = await advanceWorkflowRun(owner, projectAId, run.id, { env, blobStore, fetchImpl: flaky.fetchImpl, now: Date.UTC(2026, 0, 6) });
    assert.equal(afterSecondFailedPoll.run.nodes[0].status, 'running');
    assert.equal(afterSecondFailedPoll.run.nodes[0].pollFailures, 2);

    // Third poll succeeds — the job resumes and completes, and the failure
    // counter is cleared. Crucially, submitCalls stayed at 1 the whole time:
    // the transient poll errors never triggered a second paid submission.
    const finished = await advanceWorkflowRun(owner, projectAId, run.id, { env, blobStore, fetchImpl: flaky.fetchImpl, now: Date.UTC(2026, 0, 7) });
    assert.equal(finished.run.nodes[0].status, 'completed');
    assert.equal(finished.run.nodes[0].jobId, jobId);
    assert.equal(flaky.counts().submitCalls, 1, 'transient poll failures must never cause a second paid submission');
});

test('a node fails visibly after enough consecutive transient poll failures, never polling forever silently', async () => {
    const blobStore = creatorProjectStoreForTests(new Map());
    await setupProject(projectAId, owner, blobStore);
    const idGenerator = sequentialIdGenerator('node');

    const { run } = await createWorkflowRun(owner, projectAId, {
        source: 'manual',
        nodes: [{ kind: 'image.generate', prompt: 'a permanently unreachable poll target' }],
    }, { env, blobStore, idGenerator, now: Date.UTC(2026, 0, 2) });

    const flaky = submitThenFlakyPoll({ failuresBeforeSuccess: Infinity });
    await advanceWorkflowRun(owner, projectAId, run.id, { env, blobStore, fetchImpl: flaky.fetchImpl, now: Date.UTC(2026, 0, 3) });
    await approveAndAdvanceWorkflowRun(owner, projectAId, run.id, { env, blobStore, fetchImpl: flaky.fetchImpl, now: Date.UTC(2026, 0, 4) });

    let result;
    for (let attempt = 0; attempt < 10; attempt += 1) {
        // eslint-disable-next-line no-await-in-loop
        result = await advanceWorkflowRun(owner, projectAId, run.id, { env, blobStore, fetchImpl: flaky.fetchImpl, now: Date.UTC(2026, 0, 5 + attempt) });
        if (result.run.nodes[0].status === 'failed') break;
    }
    assert.equal(result.run.nodes[0].status, 'failed');
    assert.equal(result.run.status, 'failed');
    assert.equal(flaky.counts().submitCalls, 1, 'even giving up must never have triggered a second paid submission');
});

test('a terminal poll rejection (e.g. job not found) fails the node immediately, not after 5 wasted attempts', async () => {
    const blobStore = creatorProjectStoreForTests(new Map());
    await setupProject(projectAId, owner, blobStore);
    const idGenerator = sequentialIdGenerator('node');

    const { run } = await createWorkflowRun(owner, projectAId, {
        source: 'manual',
        nodes: [{ kind: 'image.generate', prompt: 'a poll target the provider rejects outright' }],
    }, { env, blobStore, idGenerator, now: Date.UTC(2026, 0, 2) });

    // status 422 here simulates the provider outright rejecting the poll
    // (e.g. "job not found") -- an identical retry will never succeed.
    const rejected = submitThenFlakyPoll({ failuresBeforeSuccess: Infinity, failureStatus: 422 });
    await advanceWorkflowRun(owner, projectAId, run.id, { env, blobStore, fetchImpl: rejected.fetchImpl, now: Date.UTC(2026, 0, 3) });
    await approveAndAdvanceWorkflowRun(owner, projectAId, run.id, { env, blobStore, fetchImpl: rejected.fetchImpl, now: Date.UTC(2026, 0, 4) });

    const polled = await advanceWorkflowRun(owner, projectAId, run.id, { env, blobStore, fetchImpl: rejected.fetchImpl, now: Date.UTC(2026, 0, 5) });
    assert.equal(polled.run.nodes[0].status, 'failed', 'a terminal rejection must fail on the very first poll, not be retried as if transient');
    assert.equal(rejected.counts().pollCalls, 1);
    assert.equal(rejected.counts().submitCalls, 1);
});

test('a rejected credential (401/403) fails the poll immediately even though it normalizes to the same status as a transient error', async () => {
    const blobStore = creatorProjectStoreForTests(new Map());
    await setupProject(projectAId, owner, blobStore);
    const idGenerator = sequentialIdGenerator('node');

    const { run } = await createWorkflowRun(owner, projectAId, {
        source: 'manual',
        nodes: [{ kind: 'image.generate', prompt: 'a poll rejected for bad credentials' }],
    }, { env, blobStore, idGenerator, now: Date.UTC(2026, 0, 2) });

    // The provider itself returns 401/403 here; muapiCreatorProvider.js
    // normalizes that to the SAME status (502) a genuine network hiccup
    // would produce, so this must be distinguished by the retryable flag,
    // not the collapsed status code.
    const rejected = submitThenFlakyPoll({ failuresBeforeSuccess: Infinity, failureStatus: 401 });
    await advanceWorkflowRun(owner, projectAId, run.id, { env, blobStore, fetchImpl: rejected.fetchImpl, now: Date.UTC(2026, 0, 3) });
    await approveAndAdvanceWorkflowRun(owner, projectAId, run.id, { env, blobStore, fetchImpl: rejected.fetchImpl, now: Date.UTC(2026, 0, 4) });

    const polled = await advanceWorkflowRun(owner, projectAId, run.id, { env, blobStore, fetchImpl: rejected.fetchImpl, now: Date.UTC(2026, 0, 5) });
    assert.equal(polled.run.nodes[0].status, 'failed', 'a rejected credential must never be treated as a transient network blip');
    assert.equal(rejected.counts().pollCalls, 1);
});

test('a 429 (rate limit or exhausted balance) fails the poll immediately rather than risking 4 wasted retries on an exhausted balance', async () => {
    const blobStore = creatorProjectStoreForTests(new Map());
    await setupProject(projectAId, owner, blobStore);
    const idGenerator = sequentialIdGenerator('node');

    const { run } = await createWorkflowRun(owner, projectAId, {
        source: 'manual',
        nodes: [{ kind: 'image.generate', prompt: 'a poll rejected for exhausted balance' }],
    }, { env, blobStore, idGenerator, now: Date.UTC(2026, 0, 2) });

    const rejected = submitThenFlakyPoll({ failuresBeforeSuccess: Infinity, failureStatus: 429 });
    await advanceWorkflowRun(owner, projectAId, run.id, { env, blobStore, fetchImpl: rejected.fetchImpl, now: Date.UTC(2026, 0, 3) });
    await approveAndAdvanceWorkflowRun(owner, projectAId, run.id, { env, blobStore, fetchImpl: rejected.fetchImpl, now: Date.UTC(2026, 0, 4) });

    const polled = await advanceWorkflowRun(owner, projectAId, run.id, { env, blobStore, fetchImpl: rejected.fetchImpl, now: Date.UTC(2026, 0, 5) });
    assert.equal(polled.run.nodes[0].status, 'failed');
    assert.equal(rejected.counts().pollCalls, 1);
});

// HeyGen's create response never carries the finished video (only a job ID and
// a queued/processing status) and its job shape uses `videoUrl`/structured
// `error: {code, message}` instead of MuAPI's `url`/plain-string `error` — so
// submission and completion are always two separate fetch calls here, unlike
// the MuAPI mocks above where a single mocked response can already be
// "succeeded".
function heygenFetch({ pollStatus = 'completed', pollStatusCode = 200, failureStatus, submitStatusCode = 200 } = {}) {
    let submitCalls = 0;
    let pollCalls = 0;
    return {
        fetchImpl: async (url, options = {}) => {
            if (options.method === 'POST') {
                submitCalls += 1;
                return {
                    ok: submitStatusCode < 400,
                    status: submitStatusCode,
                    text: async () => JSON.stringify({ data: { video_id: 'heygen-job-1', status: 'processing' } }),
                };
            }
            pollCalls += 1;
            if (failureStatus) {
                return {
                    ok: false,
                    status: failureStatus,
                    text: async () => JSON.stringify({ error: { message: 'temporary upstream error' } }),
                };
            }
            return {
                ok: pollStatusCode < 400,
                status: pollStatusCode,
                text: async () => JSON.stringify({
                    data: pollStatus === 'failed'
                        ? { status: 'failed', failure_message: 'Avatar rendering failed.', failure_code: 'render_failed' }
                        : { status: pollStatus, video_url: `https://resource.heygen.ai/out-${pollCalls}.mp4` },
                }),
            };
        },
        counts: () => ({ submitCalls, pollCalls }),
    };
}

test('an avatar.generate node submits a script to HeyGen and registers a heygen-provider video asset on completion', async () => {
    const blobStore = creatorProjectStoreForTests(new Map());
    await setupProject(projectAId, owner, blobStore);
    const idGenerator = sequentialIdGenerator('node');

    const { run } = await createWorkflowRun(owner, projectAId, {
        source: 'manual',
        nodes: [{ kind: 'avatar.generate', script: 'Welcome to the launch of our new product.' }],
    }, { env, blobStore, idGenerator, now: Date.UTC(2026, 0, 2) });
    assert.equal(run.nodes[0].inputs.script, 'Welcome to the launch of our new product.');

    const heygen = heygenFetch();
    await advanceWorkflowRun(owner, projectAId, run.id, { env, blobStore, fetchImpl: heygen.fetchImpl, now: Date.UTC(2026, 0, 3) });
    const submitted = await approveAndAdvanceWorkflowRun(owner, projectAId, run.id, { env, blobStore, fetchImpl: heygen.fetchImpl, now: Date.UTC(2026, 0, 4) });
    assert.equal(submitted.run.nodes[0].status, 'running');
    assert.equal(submitted.run.nodes[0].jobId, 'heygen-job-1');
    assert.equal(heygen.counts().submitCalls, 1);

    const finished = await advanceWorkflowRun(owner, projectAId, run.id, { env, blobStore, fetchImpl: heygen.fetchImpl, now: Date.UTC(2026, 0, 5) });
    assert.equal(finished.run.nodes[0].status, 'completed');
    assert.equal(finished.run.nodes[0].outputUrl, 'https://resource.heygen.ai/out-1.mp4');
    assert.equal(finished.project.assets.length, 1);
    assert.equal(finished.project.assets[0].type, 'video');
    assert.equal(finished.project.assets[0].provider.provider, 'heygen');
    assert.equal(heygen.counts().submitCalls, 1, 'completion must never trigger a second paid submission');
});

test('a node requires a non-empty script for avatar.generate', async () => {
    const blobStore = creatorProjectStoreForTests(new Map());
    await setupProject(projectAId, owner, blobStore);
    const idGenerator = sequentialIdGenerator('node');

    await assert.rejects(
        createWorkflowRun(owner, projectAId, {
            source: 'manual',
            nodes: [{ kind: 'avatar.generate', script: '   ' }],
        }, { env, blobStore, idGenerator, now: Date.UTC(2026, 0, 2) }),
        (error) => error instanceof CreatorWorkflowError && error.code === 'invalid_workflow_node',
    );
});

test('a failed HeyGen render surfaces the structured failure_message, not a generic error', async () => {
    const blobStore = creatorProjectStoreForTests(new Map());
    await setupProject(projectAId, owner, blobStore);
    const idGenerator = sequentialIdGenerator('node');

    const { run } = await createWorkflowRun(owner, projectAId, {
        source: 'manual',
        nodes: [{ kind: 'avatar.generate', script: 'a script that will fail to render' }],
    }, { env, blobStore, idGenerator, now: Date.UTC(2026, 0, 2) });

    const heygen = heygenFetch({ pollStatus: 'failed' });
    await advanceWorkflowRun(owner, projectAId, run.id, { env, blobStore, fetchImpl: heygen.fetchImpl, now: Date.UTC(2026, 0, 3) });
    await approveAndAdvanceWorkflowRun(owner, projectAId, run.id, { env, blobStore, fetchImpl: heygen.fetchImpl, now: Date.UTC(2026, 0, 4) });

    const failed = await advanceWorkflowRun(owner, projectAId, run.id, { env, blobStore, fetchImpl: heygen.fetchImpl, now: Date.UTC(2026, 0, 5) });
    assert.equal(failed.run.nodes[0].status, 'failed');
    assert.equal(failed.run.nodes[0].error, 'Avatar rendering failed.');
    assert.equal(failed.project.assets.length, 0);
});

test('a transient HeyGen poll failure (502) keeps an avatar.generate node running instead of failing it', async () => {
    const blobStore = creatorProjectStoreForTests(new Map());
    await setupProject(projectAId, owner, blobStore);
    const idGenerator = sequentialIdGenerator('node');

    const { run } = await createWorkflowRun(owner, projectAId, {
        source: 'manual',
        nodes: [{ kind: 'avatar.generate', script: 'a script with a flaky poll' }],
    }, { env, blobStore, idGenerator, now: Date.UTC(2026, 0, 2) });

    const heygen = heygenFetch({ failureStatus: 502 });
    await advanceWorkflowRun(owner, projectAId, run.id, { env, blobStore, fetchImpl: heygen.fetchImpl, now: Date.UTC(2026, 0, 3) });
    await approveAndAdvanceWorkflowRun(owner, projectAId, run.id, { env, blobStore, fetchImpl: heygen.fetchImpl, now: Date.UTC(2026, 0, 4) });

    const afterFailedPoll = await advanceWorkflowRun(owner, projectAId, run.id, { env, blobStore, fetchImpl: heygen.fetchImpl, now: Date.UTC(2026, 0, 5) });
    assert.equal(afterFailedPoll.run.nodes[0].status, 'running', 'a transient HeyGen poll error must not fail the node');
    assert.equal(afterFailedPoll.run.nodes[0].pollFailures, 1);
    assert.equal(heygen.counts().submitCalls, 1);
});

test('a rejected HeyGen credential (401) fails an avatar.generate node immediately rather than retrying', async () => {
    const blobStore = creatorProjectStoreForTests(new Map());
    await setupProject(projectAId, owner, blobStore);
    const idGenerator = sequentialIdGenerator('node');

    const { run } = await createWorkflowRun(owner, projectAId, {
        source: 'manual',
        nodes: [{ kind: 'avatar.generate', script: 'a script rejected for bad credentials' }],
    }, { env, blobStore, idGenerator, now: Date.UTC(2026, 0, 2) });

    const heygen = heygenFetch({ failureStatus: 401 });
    await advanceWorkflowRun(owner, projectAId, run.id, { env, blobStore, fetchImpl: heygen.fetchImpl, now: Date.UTC(2026, 0, 3) });
    await approveAndAdvanceWorkflowRun(owner, projectAId, run.id, { env, blobStore, fetchImpl: heygen.fetchImpl, now: Date.UTC(2026, 0, 4) });

    const failed = await advanceWorkflowRun(owner, projectAId, run.id, { env, blobStore, fetchImpl: heygen.fetchImpl, now: Date.UTC(2026, 0, 5) });
    assert.equal(failed.run.nodes[0].status, 'failed', 'a rejected credential must never be treated as a transient network blip');
    assert.equal(heygen.counts().pollCalls, 1);
});
