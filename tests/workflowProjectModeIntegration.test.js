import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workflowSource = await readFile(new URL('../packages/studio/src/components/WorkflowStudio.jsx', import.meta.url), 'utf8');
const shellSource = await readFile(new URL('../components/StandaloneShell.js', import.meta.url), 'utf8');

test('Project Workflow mode uses Creator-authenticated catalog/input/run routes and restores durable runs', () => {
    assert.match(workflowSource, /creatorWorkflowRequest\(`catalog\/\$\{catalog\}`\)/);
    assert.match(workflowSource, /creatorWorkflowRequest\(`inputs\/\$\{encodeURIComponent\(wfId\)\}`\)/);
    assert.match(workflowSource, /creatorWorkflowRequest\(`list\/\$\{encodeURIComponent\(project\.id\)\}`\)/);
    assert.match(workflowSource, /Refresh status/);
    assert.match(workflowSource, /initialAction\?\.parameters\?\.workflowId/);
});

test('Creator shell does not require browser BYOK for an opened Project Workflow', () => {
    assert.match(shellSource, /destinationId === 'workflows' && \(projectsLoading \|\| currentProject\?\.id\)/);
    assert.match(shellSource, /'workflow\.run': '\/studio\/workflows'/);
    assert.match(shellSource, /<WorkflowStudio[^>]*initialAction=\{selenaAction\}/);
});
