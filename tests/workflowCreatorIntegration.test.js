import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflowSource = await readFile(new URL("../packages/studio/src/components/WorkflowStudio.jsx", import.meta.url), "utf8");
const shellSource = await readFile(new URL("../components/StandaloneShell.js", import.meta.url), "utf8");
const gatewaySource = await readFile(new URL("../src/lib/creatorWorkflowGateway.js", import.meta.url), "utf8");

test("Creator Project Workflow execution uses the authenticated approval-gated route", () => {
  assert.match(workflowSource, /\/api\/creator\/workflows\//);
  assert.match(workflowSource, /confirm:\s*true/);
  assert.match(workflowSource, /waiting_for_approval/);
  assert.match(workflowSource, /Project-scoped execution/);
  assert.match(shellSource, /<WorkflowStudio[^>]*project=\{currentProject\}/);
});

test("Creator Projects block the legacy visual builder node-execution surface", () => {
  assert.match(workflowSource, /project\?\.id\s*\?\s*\(/);
  assert.match(workflowSource, /upstream visual builder can execute individual nodes through its legacy BYOK route/);
  assert.match(workflowSource, /Return to secure Playground/);
  assert.match(workflowSource, /:\s*nodeSchemas && workflowDef \? \(/);
});

test("Workflow provider identifiers stay server-only when outputs become Project Assets", () => {
  assert.match(gatewaySource, /requestId:\s*run\.id/);
  assert.doesNotMatch(gatewaySource, /requestId:\s*run\.providerRunId/);
});
