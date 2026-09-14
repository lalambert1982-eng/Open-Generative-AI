"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Circle,
  Clapperboard,
  Layers3,
  ListPlus,
  LoaderCircle,
  Play,
  Plus,
  RotateCcw,
  ShieldCheck,
  Square,
  Trash2,
  XCircle,
} from "lucide-react";

const ASPECT_RATIOS = ["16:9", "9:16", "1:1"];

// One entry per node kind the engine (creatorWorkflowEngine.js) accepts from a
// manual build. Adding a new kind there should only ever require adding one
// entry here, not touching the builder logic below.
const NODE_KIND_OPTIONS = [
  { value: "image.generate", label: "Generate image", promptLabel: "Prompt", field: "prompt", needsDuration: false, needsSource: false, needsAspectRatio: true },
  { value: "video.generate", label: "Generate video", promptLabel: "Prompt", field: "prompt", needsDuration: true, needsSource: false, needsAspectRatio: true },
  { value: "video.animate", label: "Animate an earlier image", promptLabel: "Motion prompt", field: "prompt", needsDuration: true, needsSource: true, needsAspectRatio: true },
  { value: "avatar.generate", label: "Generate avatar video", promptLabel: "Script", field: "script", needsDuration: false, needsSource: false, needsAspectRatio: false },
];

function emptyDraftNode() {
  return { kind: "image.generate", prompt: "", aspectRatio: "16:9", duration: 5, sourceNodeIndex: null };
}

const RUN_STATUS_LABEL = {
  queued: "Queued",
  running: "Running",
  waiting_for_approval: "Waiting for approval",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

const RUN_STATUS_STYLE = {
  queued: "border-white/15 bg-white/[0.04] text-white/50",
  running: "border-cyan-300/25 bg-cyan-300/[0.08] text-cyan-200",
  waiting_for_approval: "border-amber-300/25 bg-amber-300/[0.08] text-amber-200",
  completed: "border-emerald-300/25 bg-emerald-300/[0.08] text-emerald-200",
  failed: "border-red-400/25 bg-red-400/[0.08] text-red-200",
  cancelled: "border-white/15 bg-white/[0.04] text-white/40",
};

function NodeIcon({ status }) {
  if (status === "completed") return <CheckCircle2 size={15} className="text-emerald-300" />;
  if (status === "failed") return <XCircle size={15} className="text-red-400" />;
  if (status === "running") return <LoaderCircle size={15} className="animate-spin text-cyan-300" />;
  if (status === "waiting_for_approval") return <ShieldCheck size={15} className="text-amber-300" />;
  return <Circle size={15} className="text-white/25" />;
}

async function parseJson(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

export default function WorkflowRunPanel({ project, request, onProjectChange, initialAction }) {
  const runs = useMemo(() => (Array.isArray(project?.workflowRuns) ? project.workflowRuns : []), [project]);
  const [selectedRunId, setSelectedRunId] = useState(runs[0]?.id || null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [builderOpen, setBuilderOpen] = useState(false);
  const [builderName, setBuilderName] = useState("");
  const [builderNodes, setBuilderNodes] = useState([emptyDraftNode()]);
  const pollTimerRef = useRef(null);
  const busyRef = useRef(false);
  const consumedSelenaActionRef = useRef(null);
  useEffect(() => { busyRef.current = busy; }, [busy]);

  useEffect(() => {
    if (!selectedRunId && runs.length) setSelectedRunId(runs[0].id);
    if (selectedRunId && !runs.some((run) => run.id === selectedRunId)) setSelectedRunId(runs[0]?.id || null);
  }, [runs, selectedRunId]);

  const selectedRun = runs.find((run) => run.id === selectedRunId) || null;

  const callAction = useCallback(async (path, options, { onResult } = {}) => {
    setBusy(true);
    setError("");
    try {
      const response = await request(path, options);
      const data = await parseJson(response);
      if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
      if (data.project) onProjectChange?.(data.project);
      onResult?.(data);
      return data;
    } catch (actionError) {
      setError(actionError.message || "The workflow request failed.");
      return null;
    } finally {
      setBusy(false);
    }
  }, [request, onProjectChange]);

  const startFromStoryboard = useCallback(async () => {
    if (!project?.id) return;
    const data = await callAction(`projects/${project.id}/workflows`, {
      method: "POST",
      body: { source: "storyboard", name: "Storyboard Workflow" },
    });
    if (data?.run) {
      setSelectedRunId(data.run.id);
      setBuilderOpen(false);
    }
  }, [project?.id, callAction]);

  const openBuilder = useCallback(() => {
    setBuilderName("");
    setBuilderNodes([emptyDraftNode()]);
    setError("");
    setBuilderOpen(true);
  }, []);

  const addBuilderNode = useCallback(() => {
    setBuilderNodes((previous) => [...previous, emptyDraftNode()]);
  }, []);

  const removeBuilderNode = useCallback((index) => {
    setBuilderNodes((previous) => {
      const next = previous.filter((_, itemIndex) => itemIndex !== index);
      // A removed node can no longer be any later node's image source —
      // clear references rather than leave them pointing at a stale index.
      return next.map((node) => (
        node.kind === "video.animate" && node.sourceNodeIndex != null && node.sourceNodeIndex >= index
          ? { ...node, sourceNodeIndex: node.sourceNodeIndex === index ? null : node.sourceNodeIndex - 1 }
          : node
      ));
    });
  }, []);

  const updateBuilderNode = useCallback((index, patch) => {
    setBuilderNodes((previous) => previous.map((node, itemIndex) => (itemIndex === index ? { ...node, ...patch } : node)));
  }, []);

  const submitBuilder = useCallback(async () => {
    if (!project?.id) return;
    for (let index = 0; index < builderNodes.length; index += 1) {
      const node = builderNodes[index];
      if (!node.prompt.trim()) {
        setError(`Step ${index + 1} needs a prompt.`);
        return;
      }
      if (node.kind === "video.animate" && node.sourceNodeIndex == null) {
        setError(`Step ${index + 1} needs an earlier image step to animate.`);
        return;
      }
    }
    const data = await callAction(`projects/${project.id}/workflows`, {
      method: "POST",
      body: {
        source: "manual",
        name: builderName.trim() || "Untitled Workflow",
        nodes: builderNodes.map((node) => {
          const kindConfig = NODE_KIND_OPTIONS.find((option) => option.value === node.kind) || NODE_KIND_OPTIONS[0];
          return {
            kind: node.kind,
            [kindConfig.field]: node.prompt.trim(),
            ...(kindConfig.needsAspectRatio ? { aspectRatio: node.aspectRatio } : {}),
            ...(kindConfig.needsDuration ? { duration: node.duration } : {}),
            ...(node.kind === "video.animate" ? { sourceNodeIndex: node.sourceNodeIndex } : {}),
          };
        }),
      },
    });
    if (data?.run) {
      setSelectedRunId(data.run.id);
      setBuilderOpen(false);
    }
  }, [project?.id, builderName, builderNodes, callAction]);

  const runStep = useCallback((action) => {
    if (!project?.id || !selectedRunId) return;
    // Storyboard handoff for a scene-linked node is written atomically by the
    // server as part of node completion (see creatorWorkflowEngine.js), so
    // there is nothing further to persist here — onProjectChange above already
    // carries the updated storyboard/assets.
    return callAction(`projects/${project.id}/workflows/${selectedRunId}/${action}`, { method: "POST" });
  }, [project?.id, selectedRunId, callAction]);

  // Consume a Selena workflow.* action: select the run it named (workflow.
  // configure/run/status all carry a workflowId), and for workflow.run also
  // perform one advance() — still fully subject to the run's own approval
  // gate, since advance() never bypasses it. workflow.create carries no
  // workflowId; landing on this panel with its "New run" button is the whole
  // affordance for that action.
  useEffect(() => {
    const actionKey = initialAction?.id || "";
    if (!actionKey || consumedSelenaActionRef.current === actionKey || !project?.id) return;
    const workflowId = initialAction?.parameters?.workflowId;
    if (!workflowId) {
      consumedSelenaActionRef.current = actionKey;
      return;
    }
    const target = runs.find((run) => run.id === workflowId);
    if (!target) return; // runs may still be loading; retry once the list updates
    consumedSelenaActionRef.current = actionKey;
    setSelectedRunId(target.id);
    if (initialAction.action === "workflow.run" && ["queued", "running"].includes(target.status)) {
      callAction(`projects/${project.id}/workflows/${target.id}/advance`, { method: "POST" });
    }
  }, [initialAction, project?.id, runs, callAction]);

  // Poll while a node is actively submitted/processing so status keeps advancing
  // without requiring the user to keep clicking, mirroring the polling pattern
  // already used for HeyGen avatar jobs elsewhere in Creator Studio.
  useEffect(() => {
    window.clearInterval(pollTimerRef.current);
    const hasRunningNode = selectedRun?.status === "running" && selectedRun.nodes.some((node) => node.status === "running");
    if (!hasRunningNode) return undefined;
    pollTimerRef.current = window.setInterval(() => {
      // Skip a tick entirely while a request is already in flight — an
      // overlapping advance() call would read the same pre-completion project
      // state and could race the in-flight write on the same node.
      if (busyRef.current) return;
      runStep("advance");
    }, 3000);
    return () => window.clearInterval(pollTimerRef.current);
  }, [selectedRun?.status, selectedRun?.nodes, runStep]);

  if (!project?.id) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-3 p-8 text-center text-white/40">
        <Layers3 size={32} className="opacity-30" />
        <p className="text-sm">Open or create a Project to run a Workflow.</p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden md:flex-row">
      <aside className="flex shrink-0 flex-col gap-3 overflow-y-auto border-b border-white/[0.06] p-4 md:w-[280px] md:border-b-0 md:border-r">
        <button
          type="button"
          onClick={startFromStoryboard}
          disabled={busy || !project.storyboard?.scenes?.length}
          className="flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-lime-400 to-emerald-500 px-4 py-3 text-xs font-black uppercase tracking-widest text-black transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-30"
        >
          <Clapperboard size={15} /> New run from Storyboard
        </button>
        {!project.storyboard?.scenes?.length && (
          <p className="text-[10px] leading-4 text-white/30">Add scenes in Storyboard first, then start a run here.</p>
        )}
        <button
          type="button"
          onClick={openBuilder}
          disabled={busy}
          className="flex items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] px-4 py-3 text-xs font-black uppercase tracking-widest text-white/70 transition hover:bg-white/[0.08] hover:text-white disabled:cursor-not-allowed disabled:opacity-30"
        >
          <ListPlus size={15} /> Build a manual run
        </button>
        <div className="mt-2 flex flex-col gap-1.5">
          {runs.length === 0 && <p className="px-1 text-[11px] text-white/30">No workflow runs yet in this Project.</p>}
          {runs.map((run) => (
            <button
              key={run.id}
              type="button"
              onClick={() => { setSelectedRunId(run.id); setBuilderOpen(false); }}
              className={`flex flex-col gap-1 rounded-xl border px-3 py-2.5 text-left transition ${
                run.id === selectedRunId ? "border-cyan-300/30 bg-cyan-300/[0.06]" : "border-white/[0.06] bg-white/[0.02] hover:bg-white/[0.04]"
              }`}
            >
              <span className="truncate text-xs font-bold text-white/80">{run.name}</span>
              <span className={`inline-flex w-fit items-center rounded-full border px-2 py-0.5 text-[9px] font-black uppercase tracking-wider ${RUN_STATUS_STYLE[run.status]}`}>
                {RUN_STATUS_LABEL[run.status] || run.status}
              </span>
            </button>
          ))}
        </div>
      </aside>

      <main className="min-h-0 flex-1 overflow-y-auto p-5 sm:p-6">
        {error && (
          <div role="alert" className="mb-4 flex items-start gap-2 rounded-xl border border-red-400/20 bg-red-400/[0.08] px-3 py-2.5 text-xs leading-5 text-red-200">
            <AlertTriangle size={15} className="mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {builderOpen ? (
          <div className="mx-auto flex max-w-2xl flex-col gap-5">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-lg font-semibold text-white">Build a manual run</h3>
              <button type="button" onClick={() => setBuilderOpen(false)} className="text-[11px] font-bold text-white/40 hover:text-white">
                Cancel
              </button>
            </div>

            <div className="space-y-1.5">
              <label className="text-[10px] font-black uppercase tracking-wider text-white/40">Run name</label>
              <input
                type="text"
                value={builderName}
                onChange={(event) => setBuilderName(event.target.value)}
                placeholder="Untitled Workflow"
                className="w-full rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-sm text-white placeholder:text-white/25 focus:border-cyan-300/40 focus:outline-none"
              />
            </div>

            <ol className="flex flex-col gap-3">
              {builderNodes.map((node, index) => {
                const kindConfig = NODE_KIND_OPTIONS.find((option) => option.value === node.kind) || NODE_KIND_OPTIONS[0];
                const imageSourceOptions = builderNodes
                  .map((candidate, candidateIndex) => ({ candidate, candidateIndex }))
                  .filter(({ candidate, candidateIndex }) => candidateIndex < index && candidate.kind === "image.generate");
                return (
                  <li key={index} className="flex flex-col gap-3 rounded-xl border border-white/[0.08] bg-white/[0.02] p-4">
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] font-black uppercase tracking-wider text-white/40">Step {index + 1}</span>
                      {builderNodes.length > 1 && (
                        <button type="button" onClick={() => removeBuilderNode(index)} aria-label={`Remove step ${index + 1}`} className="text-white/30 hover:text-red-300">
                          <Trash2 size={14} />
                        </button>
                      )}
                    </div>

                    <select
                      value={node.kind}
                      onChange={(event) => {
                        const kind = event.target.value;
                        updateBuilderNode(index, { kind, sourceNodeIndex: kind === "video.animate" ? node.sourceNodeIndex : null });
                      }}
                      className="w-full rounded-lg border border-white/10 bg-[#0a0a0a] px-3 py-2 text-xs text-white focus:border-cyan-300/40 focus:outline-none"
                    >
                      {NODE_KIND_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>{option.label}</option>
                      ))}
                    </select>

                    {kindConfig.needsSource && (
                      imageSourceOptions.length === 0 ? (
                        <p className="text-[10px] leading-4 text-amber-200/70">Add an earlier "Generate image" step first to animate it here.</p>
                      ) : (
                        <select
                          value={node.sourceNodeIndex ?? ""}
                          onChange={(event) => updateBuilderNode(index, { sourceNodeIndex: event.target.value === "" ? null : Number(event.target.value) })}
                          className="w-full rounded-lg border border-white/10 bg-[#0a0a0a] px-3 py-2 text-xs text-white focus:border-cyan-300/40 focus:outline-none"
                        >
                          <option value="">Select the image step to animate…</option>
                          {imageSourceOptions.map(({ candidateIndex }) => (
                            <option key={candidateIndex} value={candidateIndex}>Step {candidateIndex + 1}</option>
                          ))}
                        </select>
                      )
                    )}

                    <textarea
                      value={node.prompt}
                      onChange={(event) => updateBuilderNode(index, { prompt: event.target.value })}
                      placeholder={kindConfig.promptLabel}
                      rows={2}
                      className="w-full resize-none rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-xs text-white placeholder:text-white/25 focus:border-cyan-300/40 focus:outline-none"
                    />

                    <div className="flex gap-2">
                      {kindConfig.needsAspectRatio && (
                        <select
                          value={node.aspectRatio}
                          onChange={(event) => updateBuilderNode(index, { aspectRatio: event.target.value })}
                          className="flex-1 rounded-lg border border-white/10 bg-[#0a0a0a] px-3 py-2 text-xs text-white focus:border-cyan-300/40 focus:outline-none"
                        >
                          {ASPECT_RATIOS.map((ratio) => <option key={ratio} value={ratio}>{ratio}</option>)}
                        </select>
                      )}
                      {kindConfig.needsDuration && (
                        <select
                          value={node.duration}
                          onChange={(event) => updateBuilderNode(index, { duration: Number(event.target.value) })}
                          className="flex-1 rounded-lg border border-white/10 bg-[#0a0a0a] px-3 py-2 text-xs text-white focus:border-cyan-300/40 focus:outline-none"
                        >
                          {[3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((seconds) => <option key={seconds} value={seconds}>{seconds}s</option>)}
                        </select>
                      )}
                    </div>
                  </li>
                );
              })}
            </ol>

            <button
              type="button"
              onClick={addBuilderNode}
              className="flex items-center justify-center gap-2 rounded-lg border border-dashed border-white/15 px-4 py-2.5 text-[11px] font-black uppercase tracking-wider text-white/50 hover:border-white/30 hover:text-white"
            >
              <Plus size={14} /> Add step
            </button>

            <button
              type="button"
              onClick={submitBuilder}
              disabled={busy}
              className="flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-lime-400 to-emerald-500 px-4 py-3 text-xs font-black uppercase tracking-widest text-black transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-30"
            >
              {busy ? <LoaderCircle size={15} className="animate-spin" /> : <Play size={15} fill="currentColor" />} Create run
            </button>
          </div>
        ) : !selectedRun ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center text-white/35">
            <Play size={28} className="opacity-30" />
            <p className="text-sm">Select or start a workflow run to see its progress.</p>
          </div>
        ) : (
          <div className="mx-auto flex max-w-2xl flex-col gap-5">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h3 className="text-lg font-semibold text-white">{selectedRun.name}</h3>
                <p className="text-[11px] text-white/35">{selectedRun.nodes.length} step{selectedRun.nodes.length === 1 ? "" : "s"} · {selectedRun.source === "storyboard" ? "From Storyboard" : "Manual"}</p>
              </div>
              <span className={`inline-flex items-center rounded-full border px-3 py-1 text-[10px] font-black uppercase tracking-widest ${RUN_STATUS_STYLE[selectedRun.status]}`}>
                {RUN_STATUS_LABEL[selectedRun.status] || selectedRun.status}
              </span>
            </div>

            <ol className="flex flex-col gap-2">
              {selectedRun.nodes.map((node, index) => (
                <li
                  key={node.id}
                  className={`rounded-xl border px-4 py-3 ${
                    index === selectedRun.currentNodeIndex && !["completed", "failed"].includes(node.status)
                      ? "border-cyan-300/25 bg-cyan-300/[0.05]"
                      : "border-white/[0.06] bg-white/[0.02]"
                  }`}
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2.5">
                      <NodeIcon status={node.status} />
                      <div>
                        <p className="text-xs font-bold text-white/80">{node.label}</p>
                        <p className="text-[10px] text-white/35">{node.kind}</p>
                      </div>
                    </div>
                    <span className="text-[9px] font-black uppercase tracking-wider text-white/30">{node.status.replace(/_/g, " ")}</span>
                  </div>
                  {node.error && (
                    <p className="mt-2 text-[11px] leading-4 text-red-300">{node.error}</p>
                  )}
                  {node.outputUrl && node.status === "completed" && (
                    <a href={node.outputUrl} target="_blank" rel="noreferrer" className="mt-2 inline-block text-[10px] font-bold text-cyan-200">
                      View output →
                    </a>
                  )}
                </li>
              ))}
            </ol>

            <div className="flex flex-wrap items-center gap-2 border-t border-white/[0.06] pt-4">
              {selectedRun.status === "waiting_for_approval" && (
                <button
                  type="button"
                  onClick={() => runStep("approve")}
                  disabled={busy}
                  className="flex items-center gap-2 rounded-lg bg-amber-300 px-4 py-2 text-[11px] font-black uppercase tracking-wider text-black disabled:opacity-40"
                >
                  <ShieldCheck size={14} /> Approve &amp; continue
                </button>
              )}
              {["queued", "running"].includes(selectedRun.status) && (
                <button
                  type="button"
                  onClick={() => runStep("advance")}
                  disabled={busy}
                  className="flex items-center gap-2 rounded-lg bg-cyan-300 px-4 py-2 text-[11px] font-black uppercase tracking-wider text-black disabled:opacity-40"
                >
                  <Play size={14} fill="currentColor" /> Advance
                </button>
              )}
              {selectedRun.status === "failed" && (
                <button
                  type="button"
                  onClick={() => runStep("retry")}
                  disabled={busy}
                  className="flex items-center gap-2 rounded-lg bg-white/10 px-4 py-2 text-[11px] font-black uppercase tracking-wider text-white disabled:opacity-40"
                >
                  <RotateCcw size={14} /> Retry failed step
                </button>
              )}
              {["queued", "running", "waiting_for_approval"].includes(selectedRun.status) && (
                <button
                  type="button"
                  onClick={() => runStep("cancel")}
                  disabled={busy}
                  className="flex items-center gap-2 rounded-lg border border-white/10 px-4 py-2 text-[11px] font-black uppercase tracking-wider text-white/50 hover:text-white disabled:opacity-40"
                >
                  <Square size={13} /> Cancel
                </button>
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
