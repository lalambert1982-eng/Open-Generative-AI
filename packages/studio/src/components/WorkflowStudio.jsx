"use client";

import { useState, useEffect, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  getTemplateWorkflows,
  getUserWorkflows,
  getPublishedWorkflows,
  createWorkflow,
  updateWorkflowName,
  deleteWorkflow,
  getWorkflowInputs,
  executeWorkflow,
  getAllNodeSchemas,
  getWorkflowData,
} from "../muapi.js";
import dynamic from "next/dynamic";

const WorkflowUI = dynamic(() => import("./WorkflowUI"), {
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

function creatorWorkflowForm(schema, project) {
  const initial = {};
  const storyboardScenes = Array.isArray(project?.storyboard?.scenes) ? project.storyboard.scenes : [];
  const storyboardScene = storyboardScenes.find((scene) => scene.id === project?.storyboard?.selectedSceneId) || storyboardScenes[0] || null;
  Object.entries(schema?.properties || {}).forEach(([key, prop]) => {
    const configured = prop.default || (Array.isArray(prop.examples) ? prop.examples[0] : prop.examples) || "";
    const lowerKey = key.toLowerCase();
    if (configured || !storyboardScene) initial[key] = configured;
    else if (lowerKey.includes("image")) initial[key] = storyboardScene.imageUrl || "";
    else if (lowerKey.includes("video")) initial[key] = storyboardScene.videoUrl || "";
    else if (lowerKey.includes("text") || lowerKey.includes("prompt")) initial[key] = storyboardScene.prompt || storyboardScene.title || "";
    else initial[key] = configured;
  });
  return initial;
}

function WorkflowCard({ workflow, onClick, activeTab, onRename, onDelete }) {
  const [showOptions, setShowOptions] = useState(false);

  return (
    <div
      onClick={() => onClick(workflow)}
      className="group relative aspect-[3/4] rounded-lg overflow-hidden cursor-pointer border border-white/5 bg-[#0a0a0a] transition-all hover:border-[#22d3ee]/30 hover:scale-[1.02] shadow-2xl"
    >
      {workflow.thumbnail ? (
        <img
          src={workflow.thumbnail}
          alt={workflow.name}
          className="absolute inset-0 w-full h-full object-cover transition-transform duration-700 group-hover:scale-110"
        />
      ) : (
        <div className="absolute inset-0 bg-gradient-to-br from-blue-500/10 to-purple-500/10 flex items-center justify-center">
          <svg
            width="40"
            height="40"
            viewBox="0 0 24 24"
            fill="none"
            stroke="white"
            strokeWidth="1"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="opacity-20"
          >
            <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
          </svg>
        </div>
      )}
      <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/20 to-transparent" />
      
      {/* Options Dropdown for My Workflows */}
      {activeTab === 'my-workflows' && (
        <div 
          className="absolute top-2 right-2 z-30"
          onClick={(e) => { e.stopPropagation(); }}
        >
          <button
            onClick={() => setShowOptions(!showOptions)}
            onBlur={() => setTimeout(() => setShowOptions(false), 200)}
            className="w-8 h-8 rounded-full bg-black/40 backdrop-blur-md border border-white/10 flex items-center justify-center text-white/60 hover:text-white transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <circle cx="12" cy="5" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="12" cy="19" r="1" />
            </svg>
          </button>
          
          {showOptions && (
            <div className="absolute top-10 right-0 w-32 bg-[#111] border border-white/10 rounded-lg shadow-2xl py-1 animate-in fade-in zoom-in duration-200">
              <button
                onClick={() => onRename(workflow)}
                className="w-full px-4 py-2 text-left text-[11px] font-bold text-white/70 hover:text-[#22d3ee] hover:bg-white/5 transition-colors flex items-center gap-2"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
                  <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
                </svg>
                Rename
              </button>
              <button
                onClick={() => onDelete(workflow.id)}
                className="w-full px-4 py-2 text-left text-[11px] font-bold text-red-500 hover:bg-red-500/10 transition-colors flex items-center gap-2"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
                </svg>
                Delete
              </button>
            </div>
          )}
        </div>
      )}

      {/* Community Profile Info */}
      {activeTab === 'published' && workflow.user_name && (
        <div className="absolute top-2 left-2 z-20 flex items-center gap-2 bg-black/40 backdrop-blur-md px-2 py-1 rounded-full border border-white/10">
          <img src={workflow.user_profile || "/user_profile.png"} alt="profile" className="w-4 h-4 rounded-full" />
          <span className="text-[9px] font-black text-white/80 uppercase tracking-widest">{workflow.user_name}</span>
        </div>
      )}

      <div className="absolute inset-x-0 bottom-0 p-4">
        <div className="text-[10px] font-bold text-[#22d3ee] uppercase tracking-wider mb-1 opacity-80">
          {workflow.category || "General"}
        </div>
        <h3 className="text-sm font-bold text-white truncate group-hover:text-[#22d3ee] transition-colors">
          {workflow.name || "Untitled Flow"}
        </h3>
      </div>
    </div>
  );
}

export default function WorkflowStudio({
  apiKey,
  isHeaderVisible = true,
  onToggleHeader,
  onGenerationStart,
  onGenerationEnd,
  onGenerationComplete,
  onGenerationError,
  project = null,
  onProjectRefresh,
  initialAction = null,
}) {
  const params = useParams();
  const router = useRouter();
  const idFromParams = params?.id;     // exists on /workflow/[id]/[tab] route
  const tabFromParams = params?.tab;   // string on /workflow/[id]/[tab]; array on the [[...tab]] catch-all
  // Catch-all routes (/studio/[brandSlug]/[[...tab]], /open-generative-ai/[[...tab]]) expose the
  // whole remaining path as params.tab (an array) — NOT params.slug, which doesn't exist on either
  // route and previously made this whole fallback branch permanently dead.
  const catchAllSegments = Array.isArray(tabFromParams) ? tabFromParams : [];

  // Robustly extract ID and Tab from either route structure
  const getWorkflowInfo = useCallback(() => {
    // Priority 1: Dedicated /workflow/[id]/[tab] route
    if (idFromParams) {
      return { id: idFromParams, tab: tabFromParams || null };
    }
    // Priority 2: Catch-all studio shell route — also recognizes the singular
    // "workflow" segment used by the standalone /workflow/[id]/[tab] URL scheme,
    // since a white-label custom domain's middleware rewrite lands here too.
    const wfIndex = catchAllSegments.findIndex(s => s === 'workflows' || s === 'workflow');
    if (wfIndex === -1) return { id: null, tab: null };
    return {
      id: catchAllSegments[wfIndex + 1] || null,
      tab: catchAllSegments[wfIndex + 2] || null
    };
  }, [catchAllSegments, idFromParams, tabFromParams]);

  const { id: urlWorkflowId, tab: urlTab } = getWorkflowInfo();

  const [workflows, setWorkflows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedWorkflow, setSelectedWorkflow] = useState(null);
  const [activeSubTab, setActiveSubTab] = useState("playground"); // 'playground' | 'builder'
  const [activeMainTab, setActiveMainTab] = useState("templates"); // 'templates' | 'my-workflows' | 'published'
  const [renamingWorkflow, setRenamingWorkflow] = useState(null);
  const [newWorkflowName, setNewWorkflowName] = useState("");
  const [isDeletingId, setIsDeletingId] = useState(null);
  const [inputSchema, setInputSchema] = useState(null);
  const [nodeSchemas, setNodeSchemas] = useState(null);
  const [workflowDef, setWorkflowDef] = useState(null);
  const [formData, setFormData] = useState({});
  const [isExecuting, setIsExecuting] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [creatorRun, setCreatorRun] = useState(null);

  useEffect(() => {
    const workflowId = initialAction?.parameters?.workflowId;
    if (!workflowId || !["workflow.open", "workflow.run"].includes(initialAction?.action)) return;
    router.push(`/workflow/${encodeURIComponent(workflowId)}/playground`);
  }, [initialAction?.action, initialAction?.parameters?.workflowId, router]);
  

  // Handlers defined early so they can be used in effects
  const handleSelectWorkflow = useCallback(
    async (wf, fromUrl = false) => {
      setSelectedWorkflow(wf);
      setResult(null);
      setError(null);
      setCreatorRun(null);
      
      const targetTab = urlTab || "playground";
      setActiveSubTab(targetTab);

      if (!fromUrl) {
        // Always route to /workflow/[id] so the builder library's useParams().id resolves correctly
        router.push(`/workflow/${wf.id}/${targetTab}`);
      }
    },
    [router, urlTab],
  );

  // Dedicated data fetching effect for the active workflow.
  // Project mode uses the Creator-authenticated server boundary so the browser
  // never needs a MuAPI key just to browse/run a workflow.
  useEffect(() => {
    if (!selectedWorkflow?.id || (!project?.id && !apiKey)) return;
    let active = true;

    async function loadWorkflowDetails() {
      try {
        setLoading(true);
        const wfId = selectedWorkflow.id;

        if (project?.id) {
          const response = await creatorWorkflowRequest(`inputs/${encodeURIComponent(wfId)}`);
          if (!active) return;
          const schema = response.input_data || response;
          setInputSchema(schema);
          setFormData(creatorWorkflowForm(schema, project));
          setNodeSchemas(null);
          setWorkflowDef(null);
          return;
        }

        const results = await Promise.allSettled([
          getWorkflowInputs(apiKey, wfId),
          getAllNodeSchemas(apiKey, wfId),
          getWorkflowData(apiKey, wfId),
        ]);
        if (!active) return;

        if (results[0].status === "fulfilled") {
          const response = results[0].value;
          const schema = response.input_data || response;
          setInputSchema(schema);
          setFormData(creatorWorkflowForm(schema, project));
        } else {
          console.warn("Input schema not available for this workflow:", results[0].reason);
          setInputSchema(null);
          setFormData({});
        }

        const nodes = results[1].status === "fulfilled" ? results[1].value : [];
        const def = results[2].status === "fulfilled" ? results[2].value : { nodes: [], edges: [] };
        setNodeSchemas(nodes);
        setWorkflowDef(def);
        if (results[1].status === "rejected" || results[2].status === "rejected") {
          console.error("Builder components failed to load:", results[1].reason, results[2].reason);
          if (!nodes.length && !def.nodes?.length) setError("Failed to load full builder data. Some features may be disabled.");
        }
      } catch (err) {
        if (!active) return;
        console.error("Critical error loading workflow details:", err);
        setError("Critical error loading workflow: " + err.message);
        setNodeSchemas([]);
        setWorkflowDef({ nodes: [], edges: [] });
      } finally {
        if (active) setLoading(false);
      }
    }

    loadWorkflowDetails();
    return () => { active = false; };
  }, [selectedWorkflow?.id, apiKey, project?.id, project?.storyboard?.selectedSceneId]);

  const handleCreateWorkflow = useCallback(
    async (fromUrl = false) => {
      try {
        setLoading(true);
        if (!fromUrl) {
          const payload = {
            workflow_id: null,
            name: "Untitled Workflow",
            edges: [],
            data: { nodes: [] },
          };
          const response = await createWorkflow(apiKey, payload);
          // StandaloneShell keeps the session-scoped BYOK credential in memory
          // across this same-origin route transition; do not duplicate it under
          // another browser-storage key.
          router.push(`/workflow/${response.workflow_id}/builder`);
          return;
        }

        // Initialize state for the new flow
        setSelectedWorkflow({ id: null, name: "Untitled Workflow" });
        setNodeSchemas([]);
        setWorkflowDef({ nodes: [], edges: [] });
        setActiveSubTab("builder");
      } catch (err) {
        setError("Failed to initialize workflow: " + err.message);
      } finally {
        setLoading(false);
      }
    },
    [apiKey, router],
  );

  const handleDeleteWorkflow = async (wfId) => {
    if (!confirm("Are you sure you want to delete this workflow?")) return;
    setIsDeletingId(wfId);
    try {
      await deleteWorkflow(apiKey, wfId);
      setWorkflows((prev) => prev.filter((w) => w.id !== wfId));
    } catch (err) {
      console.error("Delete failed:", err);
      alert("Failed to delete workflow");
    } finally {
      setIsDeletingId(null);
    }
  };

  const handleRenameWorkflow = async (e) => {
    e?.preventDefault();
    if (!renamingWorkflow || !newWorkflowName.trim()) return;

    const wfId = renamingWorkflow.id;
    try {
      await updateWorkflowName(apiKey, wfId, newWorkflowName);
      setWorkflows((prev) =>
        prev.map((w) => (w.id === wfId ? { ...w, name: newWorkflowName } : w)),
      );
      if (selectedWorkflow?.id === wfId) {
        setSelectedWorkflow({ ...selectedWorkflow, name: newWorkflowName });
      }
      setRenamingWorkflow(null);
    } catch (err) {
      console.error("Rename failed:", err);
      alert("Failed to rename workflow");
    }
  };

  // KEY FIX: If the user is on /studio/workflows/[id], redirect to /workflow/[id]
  // so the builder library's useParams().id resolves correctly, preventing duplicate creation.
  useEffect(() => {
    if (typeof window !== 'undefined' && urlWorkflowId && urlWorkflowId !== 'new') {
      const path = window.location.pathname;
      if (path.startsWith('/studio/workflows/')) {
        const tab = urlTab || 'builder';
        router.replace(`/workflow/${urlWorkflowId}/${tab}`);
      }
    }
  }, [urlWorkflowId, urlTab, router]);

  // 1. Sync state with URL on mount or URL change
  useEffect(() => {
    if (loading) return;

    if (urlWorkflowId) {
      if (urlWorkflowId === "new") {
        if (!selectedWorkflow || selectedWorkflow.id !== null) {
          handleCreateWorkflow(true);
        }
      } else {
        const found = workflows.find((wf) => wf.id === urlWorkflowId);
        if (found) {
          if (!selectedWorkflow || selectedWorkflow.id !== urlWorkflowId) {
            handleSelectWorkflow(found, true);
          }
        } else if (
          !selectedWorkflow ||
          selectedWorkflow.id !== urlWorkflowId
        ) {
          // Fallback for deep-linking: attempt to open even if not in the current tab's list
          // handleSelectWorkflow fetches official name/data anyway
          handleSelectWorkflow(
            { id: urlWorkflowId, name: "Loading..." },
            true,
          );
        }
      }
    } else if (selectedWorkflow) {
      setSelectedWorkflow(null);
    }
  }, [
    urlWorkflowId,
    workflows,
    loading,
    selectedWorkflow,
    handleCreateWorkflow,
    handleSelectWorkflow,
  ]);

  useEffect(() => {
    let active = true;
    async function loadWorkflows() {
      try {
        setLoading(true);
        let data = [];
        if (project?.id) {
          const catalog = activeMainTab === "templates" ? "templates" : activeMainTab === "my-workflows" ? "mine" : "published";
          const value = await creatorWorkflowRequest(`catalog/${catalog}`);
          data = Array.isArray(value.workflows) ? value.workflows : [];
        } else if (apiKey) {
          if (activeMainTab === "templates") data = await getTemplateWorkflows(apiKey);
          else if (activeMainTab === "my-workflows") data = await getUserWorkflows(apiKey);
          else if (activeMainTab === "published") data = await getPublishedWorkflows(apiKey);
        }
        if (active) setWorkflows(data);
      } catch (err) {
        if (!active) return;
        console.error("Failed to load workflows:", err);
        setError("Failed to load workflows list.");
      } finally {
        if (active) setLoading(false);
      }
    }
    loadWorkflows();
    return () => { active = false; };
  }, [apiKey, activeMainTab, project?.id]);

  useEffect(() => {
    if (!project?.id || !selectedWorkflow?.id || creatorRun?.id) return;
    let active = true;
    creatorWorkflowRequest(`list/${encodeURIComponent(project.id)}`)
      .then((value) => {
        if (!active) return;
        const latest = (Array.isArray(value.runs) ? value.runs : []).find((run) => run.workflowId === selectedWorkflow.id) || null;
        setCreatorRun(latest);
        if (latest?.status === "completed") {
          setResult({ creatorRun: latest, outputs: [] });
          setError(null);
        } else if (latest?.status === "failed") {
          setResult(null);
          setError(latest.error || "Workflow execution failed.");
        }
      })
      .catch((err) => {
        if (active) setError(err.message || "Saved Workflow run status could not be restored.");
      });
    return () => { active = false; };
  }, [creatorRun?.id, project?.id, selectedWorkflow?.id]);

  const finishCreatorRun = useCallback(async (run) => {
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

  const handleRefreshCreatorRun = async () => {
    if (!project?.id || !creatorRun?.id || isExecuting) return;
    setIsExecuting(true);
    setError(null);
    try {
      const value = await creatorWorkflowRequest(`status/${encodeURIComponent(project.id)}/${encodeURIComponent(creatorRun.id)}`);
      setCreatorRun(value.run);
      if (!["queued", "running"].includes(value.run?.status)) await finishCreatorRun(value.run);
    } catch (err) {
      setError(err.message || "Workflow status could not be refreshed.");
    } finally {
      setIsExecuting(false);
    }
  };

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
  };

  if (loading && !selectedWorkflow) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="animate-spin text-[#22d3ee] text-3xl">◌</div>
      </div>
    );
  }

  if (selectedWorkflow) {
    return (
      <div className="h-full flex flex-col bg-[#030303] text-white">
        {/* Immersive Sub-header / Floating Toggle */}
        {isHeaderVisible ? (
          <div className="flex-shrink-0 h-14 border-b border-white/5 flex items-center justify-between px-6 bg-black/40 z-30">
            <div className="flex items-center gap-8 h-full">
              <button
                onClick={() => router.push("/studio/workflows")}
                className="flex items-center gap-2 text-xs font-bold text-white/50 hover:text-white transition-colors"
                type="button"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M19 12H5M12 19l-7-7 7-7" />
                </svg>
                All Workflows
              </button>

              <div className="h-4 w-[1px] bg-white/10" />

              <div className="flex h-full">
                <div className="flex bg-white/5 p-1 rounded-lg my-auto">
                  <button
                    onClick={() => {
                        setActiveSubTab("playground");
                        if (selectedWorkflow?.id) router.push(`/workflow/${selectedWorkflow.id}/playground`);
                    }}
                    type="button"
                    className={`px-4 py-1.5 text-[10px] font-black uppercase tracking-widest rounded-md transition-all ${
                      activeSubTab === "playground"
                        ? "bg-[#22d3ee] text-black shadow-[0_0_15px_rgba(34, 211, 238,0.2)]"
                        : "text-white/40 hover:text-white"
                    }`}
                  >
                    Playground
                  </button>
                  <button
                    onClick={() => {
                        setActiveSubTab("builder");
                        if (selectedWorkflow?.id) {
                          router.push(`/workflow/${selectedWorkflow.id}/builder`);
                        }
                    }}
                    type="button"
                    className={`px-4 py-1.5 text-[10px] font-black uppercase tracking-widest rounded-md transition-all ${
                      activeSubTab === "builder"
                        ? "bg-[#22d3ee] text-black shadow-[0_0_15px_rgba(34, 211, 238,0.2)]"
                        : "text-white/40 hover:text-white"
                    }`}
                  >
                    Full Workflow
                  </button>
                </div>
              </div>
            </div>

            <div className="flex items-center gap-3">
              <span className="text-[11px] font-black text-[#22d3ee] uppercase tracking-widest">
                {selectedWorkflow.name}
              </span>
              <button
                onClick={() => onToggleHeader?.(false)}
                className="p-1.5 bg-white/5 hover:bg-white/10 rounded-md transition-colors text-white/40 hover:text-white"
                title="Enter Zen Mode"
                type="button"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
                </svg>
              </button>
            </div>
          </div>
        ) : (
          /* Floating Immersive Mode Controller */
          <div className="absolute top-4 left-1/2 -translate-x-1/2 z-[100] flex items-center gap-4 px-4 py-2 bg-black/60 backdrop-blur-xl border border-white/10 rounded-full shadow-2xl animate-fade-in-down">
            <button
               onClick={() => router.push("/studio/workflows")}
               className="p-1.5 text-white/40 hover:text-white transition-colors"
               title="Back to All Workflows"
               type="button"
            >
               <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
            </button>
            
            <div className="h-4 w-[1px] bg-white/10" />
            
            <div className="flex bg-white/5 p-1 rounded-lg">
               <button
                 onClick={() => setActiveSubTab("playground")}
                 type="button"
                 className={`px-3 py-1 text-[9px] font-black uppercase tracking-widest rounded-md transition-all ${
                   activeSubTab === "playground" ? "bg-[#22d3ee] text-black" : "text-white/40"
                 }`}
               >
                 Play
               </button>
               <button
                 onClick={() => setActiveSubTab("builder")}
                 type="button"
                 className={`px-3 py-1 text-[9px] font-black uppercase tracking-widest rounded-md transition-all ${
                   activeSubTab === "builder" ? "bg-[#22d3ee] text-black" : "text-white/40"
                 }`}
               >
                 Builder
               </button>
            </div>

            <div className="h-4 w-[1px] bg-white/10" />

            <button
              onClick={() => onToggleHeader?.(true)}
              className="px-3 py-1 bg-white/10 hover:bg-white/20 text-[9px] font-black text-white uppercase tracking-widest rounded-lg transition-colors flex items-center gap-2"
              type="button"
            >
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="M4 14h6v6M20 10h-6V4M10 20l-7-7M14 4l7 7"/></svg>
              Exit Zen
            </button>
          </div>
        )}

        <div className="flex-1 overflow-hidden flex flex-col lg:flex-row">
          {activeSubTab === "playground" ? (
            <>
              {/* Controls Panel */}
              <div className="w-full lg:w-[400px] border-r border-white/5 flex flex-col bg-black/20">
                <div className="p-6 overflow-y-auto flex-1 custom-scrollbar">
                  <form onSubmit={handleRun} className="space-y-6">
                    <div>
                      <h3 className="text-xs font-black text-white/30 uppercase tracking-widest mb-4">
                        Configuration
                      </h3>
                      <div className="space-y-4">
                        {inputSchema &&
                          Object.entries(inputSchema.properties || {}).map(
                            ([key, prop]) => (
                              <div key={key} className="space-y-2">
                                <label className="block text-[11px] font-bold text-white/80 uppercase tracking-wider">
                                  {prop.title || key}
                                </label>
                                {prop.type === "string" && !prop.enum ? (
                                  <textarea
                                    value={formData[key] || ""}
                                    onChange={(e) =>
                                      setFormData({
                                        ...formData,
                                        [key]: e.target.value,
                                      })
                                    }
                                    className="w-full bg-white/5 border border-white/10 rounded-lg p-3 text-sm text-white focus:outline-none focus:border-[#22d3ee]/50 transition-colors min-h-[80px] resize-none"
                                    placeholder={
                                      prop.description || `Enter ${key}...`
                                    }
                                  />
                                ) : prop.enum ? (
                                  <select
                                    value={formData[key] || ""}
                                    onChange={(e) =>
                                      setFormData({
                                        ...formData,
                                        [key]: e.target.value,
                                      })
                                    }
                                    className="w-full bg-white/5 border border-white/10 rounded-lg p-3 text-sm text-white focus:outline-none focus:border-[#22d3ee]/50 transition-colors"
                                  >
                                    {prop.enum.map((opt) => (
                                      <option
                                        key={opt}
                                        value={opt}
                                        className="bg-black"
                                      >
                                        {opt}
                                      </option>
                                    ))}
                                  </select>
                                ) : (
                                  <input
                                    type="text"
                                    value={formData[key] || ""}
                                    onChange={(e) =>
                                      setFormData({
                                        ...formData,
                                        [key]: e.target.value,
                                      })
                                    }
                                    className="w-full bg-white/5 border border-white/10 rounded-lg p-3 text-sm text-white focus:outline-none focus:border-[#22d3ee]/50 transition-colors"
                                    placeholder={
                                      prop.description || `Enter ${key}...`
                                    }
                                  />
                                )}
                              </div>
                            ),
                          )}
                      </div>
                    </div>

                    <button
                      type="submit"
                      disabled={isExecuting || !selectedWorkflow.id}
                      className="w-full py-4 bg-[#22d3ee] text-black text-xs font-black uppercase tracking-[0.2em] rounded-xl hover:bg-white transition-all transform hover:scale-[1.02] active:scale-95 disabled:opacity-50 disabled:grayscale shadow-[0_0_30px_rgba(34, 211, 238,0.15)] flex items-center justify-center gap-3 mt-8"
                    >
                      {isExecuting ? (
                        <>
                          <div className="w-4 h-4 border-2 border-black/20 border-t-black rounded-full animate-spin" />
                          <span>Generating...</span>
                        </>
                      ) : (
                        <>
                          <svg
                            width="16"
                            height="16"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="3"
                          >
                            <path d="M5 3l14 9-14 9V3z" />
                          </svg>
                          <span>{project?.id ? "Prepare Workflow" : "Run Workflow"}</span>
                        </>
                      )}
                    </button>
                    {!selectedWorkflow.id && (
                      <p className="text-[10px] text-white/30 text-center mt-4">
                        Save your workflow first to enable execution.
                      </p>
                    )}
                    {project?.id && selectedWorkflow.id && (
                      <p className="text-[10px] text-white/30 text-center mt-4">
                        Project-scoped execution · outputs return to Assets · paid execution requires a separate approval.
                      </p>
                    )}
                  </form>
                </div>
              </div>

              {/* Preview Panel */}
              <div className="flex-1 overflow-y-auto p-8 lg:p-12 bg-[#050505] flex items-center justify-center min-h-[500px]">
                {error && (
                  <div className="w-full max-w-md p-6 bg-red-500/10 border border-red-500/20 rounded-2xl flex flex-col items-center gap-4 animate-shake">
                    <div className="w-12 h-12 bg-red-500/20 rounded-full flex items-center justify-center text-red-500">
                      <svg
                        width="24"
                        height="24"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.5"
                      >
                        <circle cx="12" cy="12" r="10" />
                        <line x1="12" y1="8" x2="12" y2="12" />
                        <line x1="12" y1="16" x2="12.01" y2="16" />
                      </svg>
                    </div>
                    <div className="text-center">
                      <span className="text-[10px] font-black text-red-500 uppercase tracking-widest block mb-1">
                        Execution Error
                      </span>
                      <p className="text-white/60 text-sm leading-relaxed">
                        {error}
                      </p>
                      {creatorRun?.status === "failed" && (
                        <button type="button" onClick={handleRetryCreatorRun} className="mt-4 rounded-lg bg-white px-4 py-2 text-[10px] font-black uppercase tracking-wider text-black">Prepare retry</button>
                      )}
                    </div>
                  </div>
                )}

                {!isExecuting && creatorRun?.status === "waiting_for_approval" && !error && (
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

                {!isExecuting && !result && !error && ["queued", "running"].includes(creatorRun?.status) && (
                  <div className="w-full max-w-lg rounded-2xl border border-cyan-300/20 bg-cyan-300/[0.05] p-6">
                    <div className="text-[10px] font-black uppercase tracking-[0.2em] text-cyan-200">{creatorRun.status}</div>
                    <h3 className="mt-2 text-lg font-bold text-white">Workflow run is in progress</h3>
                    <p className="mt-2 text-sm leading-6 text-white/45">This durable run was restored from the Project. Refresh status to check for new node results without submitting it again.</p>
                    {creatorRun.nodeStates?.length > 0 && (
                      <div className="mt-4 flex flex-wrap gap-2">
                        {creatorRun.nodeStates.map((node) => <span key={node.id} className="rounded-full border border-white/10 bg-black/30 px-3 py-1 text-[9px] font-bold uppercase tracking-wider text-white/50">{node.id} · {node.status}</span>)}
                      </div>
                    )}
                    <button type="button" onClick={handleRefreshCreatorRun} className="mt-5 rounded-xl bg-cyan-200 px-4 py-2.5 text-[10px] font-black uppercase tracking-wider text-black hover:bg-white">Refresh status</button>
                  </div>
                )}

                {!isExecuting && !result && !error && creatorRun?.status === "cancelled" && (
                  <div className="w-full max-w-lg rounded-2xl border border-white/10 bg-white/[0.04] p-6">
                    <div className="text-[10px] font-black uppercase tracking-[0.2em] text-white/45">Cancelled</div>
                    <h3 className="mt-2 text-lg font-bold text-white">This Workflow run was cancelled</h3>
                    <button type="button" onClick={handleRetryCreatorRun} className="mt-5 rounded-xl bg-white px-4 py-2.5 text-[10px] font-black uppercase tracking-wider text-black">Prepare retry</button>
                  </div>
                )}

                {!isExecuting && !result && !error && !creatorRun && (
                  <div className="flex flex-col items-center gap-6 opacity-40">
                    <div className="w-20 h-20 bg-white/5 rounded-3xl flex items-center justify-center text-white/20">
                      <svg
                        width="40"
                        height="40"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                      >
                        <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
                      </svg>
                    </div>
                    <p className="text-xs text-white/40 max-w-[200px] mx-auto text-center font-medium">
                      Configure parameters and run the workflow to see results.
                    </p>
                  </div>
                )}

                {isExecuting && (
                  <div className="flex flex-col items-center gap-6 animate-fade-in">
                    <div className="relative">
                      <div className="w-24 h-24 border-[3px] border-white/5 border-t-[#22d3ee] rounded-full animate-spin shadow-[0_0_40px_rgba(34, 211, 238,0.1)]" />
                      <div className="absolute inset-0 flex items-center justify-center text-[#22d3ee]">
                        <svg
                          width="32"
                          height="32"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2.5"
                          className="animate-pulse"
                        >
                          <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
                        </svg>
                      </div>
                    </div>
                    <div className="text-center space-y-2">
                      <div className="text-[10px] font-black text-[#22d3ee] uppercase tracking-[0.3em] animate-pulse">
                        Running Pipeline
                      </div>
                      <div className="text-[13px] text-white/40 font-medium">
                        Processing nodes and generating assets...
                      </div>
                    </div>
                  </div>
                )}

                {result && (
                  <div className="w-full max-w-4xl space-y-8 animate-fade-in-up">
                    <div className="flex items-center justify-between mb-2">
                      <h3 className="text-xs font-black text-white/30 uppercase tracking-widest">
                        Workflow Results
                      </h3>
                      <div className="flex items-center gap-2 px-3 py-1 bg-green-500/10 text-green-500 rounded-full text-[10px] font-bold border border-green-500/20">
                        <div className="w-1 h-1 bg-green-500 rounded-full animate-pulse" />{" "}
                        COMPLETED
                      </div>
                    </div>

                    {result.creatorRun && (
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
                      {result.outputs?.map((out, idx) => (
                        <div
                          key={idx}
                          className="group relative bg-white/5 border border-white/10 rounded-2xl overflow-hidden hover:border-[#22d3ee]/30 transition-all shadow-2xl"
                        >
                          {out.type === "image_url" ? (
                            <img
                              src={out.value}
                              className="w-full aspect-square object-cover"
                              alt="Output"
                            />
                          ) : out.type === "video_url" ? (
                            <video
                              src={out.value}
                              controls
                              className="w-full aspect-square object-cover"
                            />
                          ) : (
                            <div className="p-6 min-h-[200px] flex items-center justify-center italic text-white/60">
                              {out.value}
                            </div>
                          )}

                          <div className="absolute inset-x-0 bottom-0 p-4 bg-gradient-to-t from-black/80 to-transparent translate-y-full group-hover:translate-y-0 transition-transform">
                            <div className="flex items-center justify-between">
                              <span className="text-[10px] font-black text-[#22d3ee] uppercase tracking-widest">
                                {out.id}
                              </span>
                              <a
                                href={out.value}
                                target="_blank"
                                rel="noreferrer"
                                className="w-8 h-8 rounded-lg bg-white/10 flex items-center justify-center hover:bg-[#22d3ee] hover:text-black transition-colors"
                              >
                                <svg
                                  width="14"
                                  height="14"
                                  viewBox="0 0 24 24"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="2.5"
                                >
                                  <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6M15 3h6v6M10 14L21 3" />
                                </svg>
                              </a>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </>
          ) : (
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
          )}
        </div>
      </div>
    );
  }

  // Render main workflow list
  return (
    <div className="h-full w-full flex flex-col p-8 overflow-y-auto custom-scrollbar">
      <div className="max-w-7xl mx-auto w-full">
        <div className="flex flex-col gap-6 mb-12">
          <div className="flex items-end justify-between">
            <div>
              <h1 className="text-3xl font-bold text-white mb-2 tracking-tight">
                Workflows
              </h1>
              <p className="text-white/40 text-sm font-medium">
                Create and manage your asynchronous AI processing pipelines
              </p>
            </div>
            <button
              onClick={() => handleCreateWorkflow()}
              className="px-6 py-3 bg-[#22d3ee] text-black text-xs font-black uppercase tracking-widest rounded-lg hover:bg-white transition-all transform hover:scale-105 active:scale-95 shadow-[0_0_20px_rgba(34, 211, 238,0.3)] flex items-center gap-2"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="3"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <line x1="12" y1="5" x2="12" y2="19"></line>
                <line x1="5" y1="12" x2="19" y2="12"></line>
              </svg>
              Create Workflow
            </button>
          </div>

          <div className="flex items-center gap-2 border-b border-white/5">
            <button
              onClick={() => setActiveMainTab("templates")}
              className={`px-6 py-4 text-xs font-black uppercase tracking-[0.2em] transition-all border-b-2 ${
                activeMainTab === "templates"
                  ? "text-[#22d3ee] border-[#22d3ee]"
                  : "text-white/30 border-transparent hover:text-white"
              }`}
            >
              Templates
            </button>
            <button
              onClick={() => setActiveMainTab("my-workflows")}
              className={`px-6 py-4 text-xs font-black uppercase tracking-[0.2em] transition-all border-b-2 ${
                activeMainTab === "my-workflows"
                  ? "text-[#22d3ee] border-[#22d3ee]"
                  : "text-white/30 border-transparent hover:text-white"
              }`}
            >
              My Workflows
            </button>
            <button
              onClick={() => setActiveMainTab("published")}
              className={`px-6 py-4 text-xs font-black uppercase tracking-[0.2em] transition-all border-b-2 ${
                activeMainTab === "published"
                  ? "text-[#22d3ee] border-[#22d3ee]"
                  : "text-white/30 border-transparent hover:text-white"
              }`}
            >
              Community
            </button>
          </div>
        </div>

        {loading ? (
          <div className="py-20 flex items-center justify-center">
            <div className="w-10 h-10 border-4 border-white/5 border-t-[#22d3ee] rounded-full animate-spin" />
          </div>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 gap-6">
            {workflows.map((wf) => (
              <WorkflowCard
                key={wf.id}
                workflow={wf}
                onClick={handleSelectWorkflow}
                activeTab={activeMainTab}
                onRename={(wf) => {
                   setRenamingWorkflow(wf);
                   setNewWorkflowName(wf.name);
                }}
                onDelete={handleDeleteWorkflow}
              />
            ))}
            {!loading && workflows.length === 0 && (
              <div className="col-span-full py-24 text-center border-2 border-dashed border-white/5 rounded-2xl bg-white/[0.02]">
                <div className="text-white/20 text-sm font-medium italic">
                  No workflows found in this section.
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Rename Modal */}
      {renamingWorkflow && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="rename-workflow-title"
          tabIndex={-1}
          onKeyDown={(event) => { if (event.key === "Escape") setRenamingWorkflow(null); }}
          className="fixed inset-0 z-[100] flex items-center justify-center p-6"
        >
          <div className="absolute inset-0 bg-black/80 backdrop-blur-md" onClick={() => setRenamingWorkflow(null)} />
          <form
            onSubmit={handleRenameWorkflow}
            className="relative w-full max-w-sm bg-[#0a0a0a] border border-white/10 rounded-2xl p-8 shadow-2xl animate-in fade-in zoom-in duration-300"
          >
            <h3 id="rename-workflow-title" className="text-xl font-bold text-white mb-2">Rename Workflow</h3>
            <p className="text-white/40 text-sm mb-6">Enter a new descriptive name for your pipeline.</p>
            
            <div className="space-y-4">
              <div className="space-y-2">
                <label className="text-[10px] font-black text-[#22d3ee] uppercase tracking-widest">Workflow Name</label>
                <input
                  autoFocus
                  type="text"
                  value={newWorkflowName}
                  onChange={(e) => setNewWorkflowName(e.target.value)}
                  placeholder="e.g. Cinematic Video Flow"
                  className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-sm text-white focus:outline-none focus:border-[#22d3ee]/50 transition-colors"
                />
              </div>
              
              <div className="flex gap-3 pt-4">
                <button
                  type="button"
                  onClick={() => setRenamingWorkflow(null)}
                  className="flex-1 px-4 py-3 text-xs font-black text-white/40 uppercase tracking-widest hover:text-white transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="flex-1 bg-[#22d3ee] text-black px-4 py-3 rounded-xl text-xs font-black uppercase tracking-widest hover:bg-white transition-all transform hover:scale-105 active:scale-95"
                >
                  Save Name
                </button>
              </div>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
