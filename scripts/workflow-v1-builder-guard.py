from pathlib import Path

workflow = Path('packages/studio/src/components/WorkflowStudio.jsx')
text = workflow.read_text()
old = '''          ) : (
            <div className="flex-1 relative bg-[#050505]">
              {nodeSchemas && workflowDef ? (
                <WorkflowUI
                  apiKey={apiKey}
                  workflowId={selectedWorkflow?.id}
                  initialNodeSchemas={nodeSchemas}
                  initialWorkflowData={{
                    ...workflowDef,
                    // Inject ID to prevent builder from assuming this is a new unsaved flow
                    workflow_id: selectedWorkflow?.id
                  }}
                  onGenerationStart={onGenerationStart}
                  onGenerationEnd={onGenerationEnd}
                  onGenerationComplete={onGenerationComplete}
                  onGenerationError={onGenerationError}
                />
              ) : (
                <div className="absolute inset-0 flex items-center justify-center">
                  <div className="flex flex-col items-center gap-4">
                    <div className="w-12 h-12 border-4 border-white/5 border-t-[#22d3ee] rounded-full animate-spin" />
                    <div className="text-[10px] font-black text-white/20 uppercase tracking-widest">
                      Loading Builder...
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}'''
new = '''          ) : (
            <div className="flex-1 relative bg-[#050505]">
              {project?.id ? (
                <div className="absolute inset-0 flex items-center justify-center p-8">
                  <div className="w-full max-w-xl rounded-2xl border border-amber-300/20 bg-amber-300/[0.05] p-7 text-center">
                    <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-amber-300/10 text-amber-200">
                      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 9v4m0 4h.01M10.3 3.3L2.6 17a2 2 0 001.7 3h15.4a2 2 0 001.7-3L13.7 3.3a2 2 0 00-3.4 0z"/></svg>
                    </div>
                    <h3 className="mt-4 text-lg font-bold text-white">Project-safe builder execution is being hardened</h3>
                    <p className="mt-2 text-sm leading-6 text-white/45">
                      The upstream visual builder can execute individual nodes through its legacy BYOK route. That execution surface is disabled inside Creator Projects so it cannot bypass Project ownership or approval gates.
                    </p>
                    <p className="mt-3 text-xs leading-5 text-white/30">
                      Use Playground to prepare and approve the complete Workflow through the secure Creator execution boundary. The standalone legacy Workflow builder remains unchanged outside Project mode.
                    </p>
                    <button type="button" onClick={() => setActiveSubTab("playground")} className="mt-6 rounded-xl bg-amber-200 px-5 py-3 text-[10px] font-black uppercase tracking-[0.18em] text-black hover:bg-white transition-colors">
                      Return to secure Playground
                    </button>
                  </div>
                </div>
              ) : nodeSchemas && workflowDef ? (
                <WorkflowUI
                  apiKey={apiKey}
                  workflowId={selectedWorkflow?.id}
                  initialNodeSchemas={nodeSchemas}
                  initialWorkflowData={{
                    ...workflowDef,
                    // Inject ID to prevent builder from assuming this is a new unsaved flow
                    workflow_id: selectedWorkflow?.id
                  }}
                  onGenerationStart={onGenerationStart}
                  onGenerationEnd={onGenerationEnd}
                  onGenerationComplete={onGenerationComplete}
                  onGenerationError={onGenerationError}
                />
              ) : (
                <div className="absolute inset-0 flex items-center justify-center">
                  <div className="flex flex-col items-center gap-4">
                    <div className="w-12 h-12 border-4 border-white/5 border-t-[#22d3ee] rounded-full animate-spin" />
                    <div className="text-[10px] font-black text-white/20 uppercase tracking-widest">
                      Loading Builder...
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}'''
if old not in text:
    raise SystemExit('Creator builder branch anchor not found')
workflow.write_text(text.replace(old, new, 1))

test_file = Path('tests/workflowCreatorIntegration.test.js')
test_file.write_text('''import assert from "node:assert/strict";\nimport { readFile } from "node:fs/promises";\nimport test from "node:test";\n\nconst workflowSource = await readFile(new URL("../packages/studio/src/components/WorkflowStudio.jsx", import.meta.url), "utf8");\nconst shellSource = await readFile(new URL("../components/StandaloneShell.js", import.meta.url), "utf8");\nconst gatewaySource = await readFile(new URL("../src/lib/creatorWorkflowGateway.js", import.meta.url), "utf8");\n\ntest("Creator Project Workflow execution uses the authenticated approval-gated route", () => {\n  assert.match(workflowSource, /\\/api\\/creator\\/workflows\\//);\n  assert.match(workflowSource, /confirm:\\s*true/);\n  assert.match(workflowSource, /waiting_for_approval/);\n  assert.match(workflowSource, /Project-scoped execution/);\n  assert.match(shellSource, /<WorkflowStudio[^>]*project=\\{currentProject\\}/);\n});\n\ntest("Creator Projects block the legacy visual builder node-execution surface", () => {\n  assert.match(workflowSource, /project\\?\\.id\\s*\\?\\s*\\(/);\n  assert.match(workflowSource, /upstream visual builder can execute individual nodes through its legacy BYOK route/);\n  assert.match(workflowSource, /Return to secure Playground/);\n  assert.match(workflowSource, /:\\s*nodeSchemas && workflowDef \\? \\(/);\n});\n\ntest("Workflow provider identifiers stay server-only when outputs become Project Assets", () => {\n  assert.match(gatewaySource, /requestId:\\s*run\\.id/);\n  assert.doesNotMatch(gatewaySource, /requestId:\\s*run\\.providerRunId/);\n  assert.match(gatewaySource, /providerRunId:\\s*_providerRunId/);\n});\n''')
