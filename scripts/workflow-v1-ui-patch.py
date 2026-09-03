from pathlib import Path

workflow = Path('packages/studio/src/components/WorkflowStudio.jsx')
text = workflow.read_text()

helper_anchor = '''const WorkflowUI = dynamic(() => import("./WorkflowUI"), {
  ssr: false,
  loading: () => (
    <div className="absolute inset-0 flex items-center justify-center">
      <div className="flex flex-col items-center gap-4">
        <div className="w-12 h-12 border-4 border-white/5 border-t-[#22d3ee] rounded-full animate-spin" />
        <div className="text-[10px] font-black text-white/20 uppercase tracking-widest">
          Loading Builder...
        </div>
      </div>
    </div>
  ),
});
'''
helper_insert = helper_anchor + '''
async function creatorWorkflowRequest(path, { method = "GET", body } = {}) {
  const response = await fetch(`/api/creator/workflows/${path}`, {
    method,
    credentials: "same-origin",
    cache: "no-store",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(value.error || `Workflow request failed (${response.status}).`);
    error.status = response.status;
    error.code = value.code;
    throw error;
  }
  return value;
}

function creatorWorkflowInputs(formData) {
  const inputs = {};
  Object.entries(formData || {}).forEach(([key, value]) => {
    if (!value) return;
    if (key.startsWith("text")) inputs[key] = { prompt: value };
    else if (key.startsWith("image")) inputs[key] = { image_url: value };
    else if (key.startsWith("video")) inputs[key] = { video_url: value };
    else inputs[key] = value;
  });
  return inputs;
}

function wait(milliseconds) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}
'''
if helper_anchor not in text:
    raise SystemExit('WorkflowUI helper anchor not found')
text = text.replace(helper_anchor, helper_insert, 1)

props_old = '''export default function WorkflowStudio({
  apiKey,
  isHeaderVisible = true,
  onToggleHeader,
  onGenerationStart,
  onGenerationEnd,
  onGenerationComplete,
  onGenerationError,
}) {'''
props_new = '''export default function WorkflowStudio({
  apiKey,
  isHeaderVisible = true,
  onToggleHeader,
  onGenerationStart,
  onGenerationEnd,
  onGenerationComplete,
  onGenerationError,
  project = null,
  onProjectRefresh,
}) {'''
if props_old not in text:
    raise SystemExit('WorkflowStudio props anchor not found')
text = text.replace(props_old, props_new, 1)

state_old = '''  const [isExecuting, setIsExecuting] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  
'''
state_new = '''  const [isExecuting, setIsExecuting] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [creatorRun, setCreatorRun] = useState(null);
  
'''
if state_old not in text:
    raise SystemExit('WorkflowStudio state anchor not found')
text = text.replace(state_old, state_new, 1)

init_old = '''          const initial = {};
          Object.entries(schema.properties || {}).forEach(([key, prop]) => {
            initial[key] =
              prop.default ||
              (Array.isArray(prop.examples) ? prop.examples[0] : prop.examples) ||
              "";
          });
          setFormData(initial);'''
init_new = '''          const initial = {};
          const storyboardScenes = Array.isArray(project?.storyboard?.scenes) ? project.storyboard.scenes : [];
          const storyboardScene = storyboardScenes.find((scene) => scene.id === project?.storyboard?.selectedSceneId) || storyboardScenes[0] || null;
          Object.entries(schema.properties || {}).forEach(([key, prop]) => {
            const configured =
              prop.default ||
              (Array.isArray(prop.examples) ? prop.examples[0] : prop.examples) ||
              "";
            const lowerKey = key.toLowerCase();
            if (configured || !storyboardScene) {
              initial[key] = configured;
            } else if (lowerKey.includes("image")) {
              initial[key] = storyboardScene.imageUrl || "";
            } else if (lowerKey.includes("video")) {
              initial[key] = storyboardScene.videoUrl || "";
            } else if (lowerKey.includes("text") || lowerKey.includes("prompt")) {
              initial[key] = storyboardScene.prompt || storyboardScene.title || "";
            } else {
              initial[key] = configured;
            }
          });
          setFormData(initial);'''
if init_old not in text:
    raise SystemExit('Workflow input initialization anchor not found')
text = text.replace(init_old, init_new, 1)
text = text.replace('  }, [selectedWorkflow?.id, apiKey]);', '  }, [selectedWorkflow?.id, apiKey, project?.id, project?.storyboard?.selectedSceneId]);', 1)

run_start = text.index('  const handleRun = async (e) => {')
run_end = text.index('\n\n  if (loading && !selectedWorkflow) {', run_start)
new_run = '''  const finishCreatorRun = useCallback(async (run) => {
    setCreatorRun(run);
    if (run?.status === "completed") {
      setResult({ creatorRun: run, outputs: [] });
      await onProjectRefresh?.(run.projectId);
      return run;
    }
    if (run?.status === "failed") throw new Error(run.error || "Workflow execution failed.");
    if (run?.status === "cancelled") throw new Error("Workflow execution was cancelled.");
    return run;
  }, [onProjectRefresh]);

  const pollCreatorRun = useCallback(async (initialRun) => {
    let run = initialRun;
    for (let attempt = 0; attempt < 150 && ["queued", "running"].includes(run?.status); attempt += 1) {
      await wait(2000);
      const value = await creatorWorkflowRequest(`status/${encodeURIComponent(run.projectId)}/${encodeURIComponent(run.id)}`);
      run = value.run;
      setCreatorRun(run);
    }
    if (["queued", "running"].includes(run?.status)) {
      throw new Error("Workflow is still running. You can return later and refresh its status.");
    }
    return finishCreatorRun(run);
  }, [finishCreatorRun]);

  const handleRun = async (e) => {
    e.preventDefault();
    if (isExecuting) return;
    setError(null);
    setResult(null);
    setCreatorRun(null);
    const inputs = creatorWorkflowInputs(formData);

    if (project?.id) {
      setIsExecuting(true);
      try {
        const storyboardSceneIds = Array.isArray(project.storyboard?.scenes)
          ? project.storyboard.scenes.map((scene) => scene?.id).filter(Boolean)
          : [];
        const value = await creatorWorkflowRequest("prepare", {
          method: "POST",
          body: { projectId: project.id, workflowId: selectedWorkflow.id, inputs, storyboardSceneIds },
        });
        setCreatorRun(value.run);
      } catch (err) {
        const message = err.message || "Workflow preparation failed";
        setError(message);
        onGenerationError?.(message);
      } finally {
        setIsExecuting(false);
      }
      return;
    }

    onGenerationStart?.();
    setIsExecuting(true);
    try {
      const data = await executeWorkflow(apiKey, selectedWorkflow.id, inputs);
      setResult(data);
      onGenerationComplete?.({
        url: data?.url || data?.output?.url || data?.outputs?.[0]?.url || null,
        type: "workflow",
      });
    } catch (err) {
      const message = err.message || "Execution failed";
      setError(message);
      onGenerationError?.(message);
    } finally {
      setIsExecuting(false);
      onGenerationEnd?.();
    }
  };

  const handleApproveCreatorRun = async () => {
    if (!project?.id || creatorRun?.status !== "waiting_for_approval" || isExecuting) return;
    if (!window.confirm("Run this Workflow now? Workflow execution may invoke configured paid generation providers. No publishing, deletion, or scheduling permission is granted.")) return;
    onGenerationStart?.();
    setIsExecuting(true);
    setError(null);
    try {
      const value = await creatorWorkflowRequest("run", {
        method: "POST",
        body: { projectId: project.id, runId: creatorRun.id, confirm: true },
      });
      setCreatorRun(value.run);
      if (["queued", "running"].includes(value.run?.status)) await pollCreatorRun(value.run);
      else await finishCreatorRun(value.run);
    } catch (err) {
      const message = err.message || "Workflow execution failed";
      setError(message);
      onGenerationError?.(message);
    } finally {
      setIsExecuting(false);
      onGenerationEnd?.();
    }
  };

  const handleRetryCreatorRun = async () => {
    if (!project?.id || !creatorRun?.id || isExecuting) return;
    setIsExecuting(true);
    setError(null);
    setResult(null);
    try {
      const value = await creatorWorkflowRequest("retry", {
        method: "POST",
        body: { projectId: project.id, runId: creatorRun.id },
      });
      setCreatorRun(value.run);
    } catch (err) {
      setError(err.message || "Workflow retry could not be prepared.");
    } finally {
      setIsExecuting(false);
    }
  };

  const handleCancelCreatorRun = async () => {
    if (!project?.id || creatorRun?.status !== "waiting_for_approval" || isExecuting) return;
    setIsExecuting(true);
    try {
      const value = await creatorWorkflowRequest("cancel", {
        method: "POST",
        body: { projectId: project.id, runId: creatorRun.id },
      });
      setCreatorRun(value.run);
      setResult(null);
    } catch (err) {
      setError(err.message || "Workflow could not be cancelled.");
    } finally {
      setIsExecuting(false);
    }
  };'''
text = text[:run_start] + new_run + text[run_end:]

button_old = '<span>Run Workflow</span>'
if button_old not in text:
    raise SystemExit('Workflow run button anchor not found')
text = text.replace(button_old, '<span>{project?.id ? "Prepare Workflow" : "Run Workflow"}</span>', 1)

note_anchor = '''                    {!selectedWorkflow.id && (
                      <p className="text-[10px] text-white/30 text-center mt-4">
                        Save your workflow first to enable execution.
                      </p>
                    )}'''
if note_anchor not in text:
    raise SystemExit('Workflow note anchor not found')
text = text.replace(note_anchor, note_anchor + '''
                    {project?.id && selectedWorkflow.id && (
                      <p className="text-[10px] text-white/30 text-center mt-4">
                        Project-scoped execution · outputs return to Assets · paid execution requires a separate approval.
                      </p>
                    )}''', 1)

empty_old = '''                {!isExecuting && !result && !error && (
                  <div className="flex flex-col items-center gap-6 opacity-40">'''
if empty_old not in text:
    raise SystemExit('Workflow empty-state anchor not found')
text = text.replace(empty_old, '''                {!isExecuting && creatorRun?.status === "waiting_for_approval" && !error && (
                  <div className="w-full max-w-lg rounded-2xl border border-amber-300/20 bg-amber-300/[0.06] p-6">
                    <div className="text-[10px] font-black uppercase tracking-[0.2em] text-amber-200">Waiting for approval</div>
                    <h3 className="mt-2 text-lg font-bold text-white">Workflow prepared for this Project</h3>
                    <p className="mt-2 text-sm leading-6 text-white/45">
                      Execution has not started. Approving this run permits this Workflow execution only; it does not approve publishing, deletion, or scheduling.
                    </p>
                    {creatorRun.storyboardSceneIds?.length > 0 && (
                      <p className="mt-3 text-[11px] text-cyan-200/60">Storyboard context: {creatorRun.storyboardSceneIds.length} scene{creatorRun.storyboardSceneIds.length === 1 ? "" : "s"}</p>
                    )}
                    <div className="mt-5 flex gap-3">
                      <button type="button" onClick={handleCancelCreatorRun} className="rounded-xl border border-white/10 px-4 py-2.5 text-[10px] font-black uppercase tracking-wider text-white/50 hover:bg-white/[0.05]">Cancel</button>
                      <button type="button" onClick={handleApproveCreatorRun} className="rounded-xl bg-amber-200 px-4 py-2.5 text-[10px] font-black uppercase tracking-wider text-black hover:bg-white">Approve & Run</button>
                    </div>
                  </div>
                )}

                {!isExecuting && !result && !error && !creatorRun && (
                  <div className="flex flex-col items-center gap-6 opacity-40">''', 1)

error_tail = '''                      <p className="text-white/60 text-sm leading-relaxed">
                        {error}
                      </p>
                    </div>
                  </div>
                )}'''
if error_tail not in text:
    raise SystemExit('Workflow error-state anchor not found')
text = text.replace(error_tail, '''                      <p className="text-white/60 text-sm leading-relaxed">
                        {error}
                      </p>
                      {creatorRun?.status === "failed" && (
                        <button type="button" onClick={handleRetryCreatorRun} className="mt-4 rounded-lg bg-white px-4 py-2 text-[10px] font-black uppercase tracking-wider text-black">Prepare retry</button>
                      )}
                    </div>
                  </div>
                )}''', 1)

result_anchor = '''                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                      {result.outputs?.map((out, idx) => ('''
if result_anchor not in text:
    raise SystemExit('Workflow result anchor not found')
text = text.replace(result_anchor, '''                    {result.creatorRun && (
                      <div className="rounded-2xl border border-emerald-300/15 bg-emerald-300/[0.04] p-5">
                        <p className="text-sm font-bold text-white">Project Assets updated</p>
                        <p className="mt-1 text-xs text-white/40">{result.creatorRun.outputAssetIds?.length || 0} output asset{result.creatorRun.outputAssetIds?.length === 1 ? "" : "s"} registered.</p>
                        {result.creatorRun.nodeStates?.length > 0 && (
                          <div className="mt-4 flex flex-wrap gap-2">
                            {result.creatorRun.nodeStates.map((node) => (
                              <span key={node.id} className="rounded-full border border-white/10 bg-black/30 px-3 py-1 text-[9px] font-bold uppercase tracking-wider text-white/50">{node.id} · {node.status}</span>
                            ))}
                          </div>
                        )}
                      </div>
                    )}

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                      {result.outputs?.map((out, idx) => (''', 1)
workflow.write_text(text)

shell = Path('components/StandaloneShell.js')
shell_text = shell.read_text()
shell_old = "      case 'workflows': return <WorkflowStudio {...legacyShared} isHeaderVisible={isHeaderVisible} onToggleHeader={setIsHeaderVisible} />;"
shell_new = "      case 'workflows': return <WorkflowStudio {...legacyShared} project={currentProject} onProjectRefresh={(projectId) => openProject(projectId || currentProject?.id)} isHeaderVisible={isHeaderVisible} onToggleHeader={setIsHeaderVisible} />;"
if shell_old not in shell_text:
    raise SystemExit('StandaloneShell WorkflowStudio anchor not found')
shell.write_text(shell_text.replace(shell_old, shell_new, 1))

gateway = Path('src/lib/creatorWorkflowGateway.js')
gateway_text = gateway.read_text()
gateway_text = gateway_text.replace("'outputs', 'output', 'data', 'results'", "'outputs', 'output', 'value', 'data', 'results'", 1)
gateway_text = gateway_text.replace("requestId: run.providerRunId || undefined,", "requestId: run.id,", 1)
gateway.write_text(gateway_text)
