import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeSelenaPlan } from '../../src/lib/selenaOrchestrator.js';

test('Selena workflow.run is server-defined, approval-gated, and cannot carry arbitrary provider fields', () => {
    const plan = normalizeSelenaPlan({
        structuredOutput: {
            message: 'Review the workflow.',
            plan: ['Open the workflow for review.'],
            referencedAssets: [],
            suggestedActions: [{
                action: 'workflow.run',
                requiresApproval: false,
                destination: 'https://attacker.test',
                parameters: {
                    workflowId: 'launch-video-v1',
                    apiKey: 'browser-secret',
                    confirm: true,
                    providerRunId: 'attacker-run',
                },
            }],
        },
    });
    assert.equal(plan.suggestedActions.length, 1);
    const action = plan.suggestedActions[0];
    assert.equal(action.action, 'workflow.run');
    assert.equal(action.destination, '/studio/workflows');
    assert.equal(action.requiresApproval, true);
    assert.deepEqual(action.parameters, { workflowId: 'launch-video-v1' });
    const serialized = JSON.stringify(plan);
    assert.equal(serialized.includes('browser-secret'), false);
    assert.equal(serialized.includes('attacker.test'), false);
    assert.equal(serialized.includes('attacker-run'), false);
});
