'use client';

import { useState } from 'react';
import { FolderOpen, LoaderCircle, Pencil, Plus, RefreshCw } from 'lucide-react';

export default function ProjectsStudio({
  projects = [],
  currentProject = null,
  loading = false,
  error = '',
  onCreate,
  onOpen,
  onRename,
  onRefresh,
}) {
  const [editor, setEditor] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const busy = loading || submitting;

  const openCreateProject = () => {
    setEditor({ mode: 'create', name: 'Untitled Project' });
  };
  const openRenameProject = (project) => {
    setEditor({ mode: 'rename', id: project.id, name: project.name, originalName: project.name });
  };
  const submitEditor = async (event) => {
    event.preventDefault();
    const name = editor?.name?.trim();
    if (!name || busy) return;
    if (editor.mode === 'rename' && name === editor.originalName) {
      setEditor(null);
      return;
    }
    setSubmitting(true);
    try {
      const result = editor.mode === 'create'
        ? await onCreate?.(name)
        : await onRename?.(editor.id, name);
      if (result) setEditor(null);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="h-full overflow-y-auto bg-[#050506] px-5 py-8 text-white sm:px-8">
      <div className="mx-auto max-w-6xl">
        <header className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
          <div>
            <p className="text-[10px] font-black uppercase tracking-[0.22em] text-cyan-300/70">Projects</p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight">Your durable creative work.</h1>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-white/35">Project manifests, Storyboards, Selena conversation context, Assets, and timeline metadata are owner-scoped in private Vercel Blob storage.</p>
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={onRefresh} disabled={busy} aria-label="Refresh Projects" className="flex h-11 w-11 items-center justify-center rounded-xl border border-white/[0.09] text-white/40 hover:text-white disabled:opacity-30"><RefreshCw size={15} className={busy ? 'animate-spin' : ''} /></button>
            <button type="button" onClick={openCreateProject} disabled={busy} className="flex h-11 items-center gap-2 rounded-xl bg-cyan-300 px-4 text-xs font-black text-black disabled:opacity-30"><Plus size={15} /> New Project</button>
          </div>
        </header>

        {editor && (
          <form onSubmit={submitEditor} aria-label={editor.mode === 'create' ? 'Create Project' : 'Rename Project'} className="mt-6 rounded-2xl border border-cyan-300/20 bg-cyan-300/[0.05] p-4 sm:flex sm:items-end sm:gap-3">
            <div className="min-w-0 flex-1">
              <label htmlFor="project-editor-name" className="block text-[10px] font-black uppercase tracking-[0.16em] text-cyan-100/60">{editor.mode === 'create' ? 'Project name' : `Rename ${editor.originalName}`}</label>
              <input
                id="project-editor-name"
                type="text"
                value={editor.name}
                onChange={(event) => setEditor((current) => ({ ...current, name: event.target.value }))}
                maxLength={100}
                autoFocus
                disabled={busy}
                className="mt-2 h-11 w-full rounded-xl border border-white/[0.1] bg-black/35 px-4 text-sm text-white outline-none transition focus:border-cyan-300/50 disabled:opacity-40"
              />
            </div>
            <div className="mt-3 flex gap-2 sm:mt-0">
              <button type="button" onClick={() => setEditor(null)} disabled={busy} className="h-11 rounded-xl border border-white/[0.1] px-4 text-xs font-bold text-white/55 hover:text-white disabled:opacity-30">Cancel</button>
              <button type="submit" disabled={busy || !editor.name.trim()} className="flex h-11 min-w-32 items-center justify-center rounded-xl bg-cyan-300 px-4 text-xs font-black text-black disabled:opacity-30">
                {submitting ? <LoaderCircle size={15} className="animate-spin" /> : editor.mode === 'create' ? 'Create Project' : 'Save Name'}
              </button>
            </div>
          </form>
        )}

        {error && <div role="alert" className="mt-6 rounded-2xl border border-amber-300/20 bg-amber-300/[0.07] px-4 py-3 text-sm text-amber-100">{error}</div>}
        {currentProject && <div className="mt-6 rounded-2xl border border-cyan-300/15 bg-cyan-300/[0.05] px-4 py-3 text-xs text-cyan-100/70"><strong>Current Project:</strong> {currentProject.name} · {currentProject.assets?.length || 0} Assets · {currentProject.storyboard?.scenes?.length || 0} Scenes</div>}

        {loading && projects.length === 0 ? (
          <div className="mt-10 flex items-center justify-center rounded-3xl border border-white/[0.07] py-24 text-cyan-200"><LoaderCircle size={24} className="animate-spin" /></div>
        ) : projects.length === 0 ? (
          <div className="mt-10 rounded-3xl border border-dashed border-white/[0.1] bg-white/[0.02] px-8 py-20 text-center">
            <FolderOpen size={30} className="mx-auto text-white/20" />
            <h2 className="mt-4 text-sm font-semibold text-white/65">Create your first Project</h2>
            <p className="mt-2 text-xs text-white/25">A Project keeps Assets, Storyboard scenes, Selena context, and timeline metadata together across browser sessions.</p>
            <button type="button" onClick={openCreateProject} disabled={busy} className="mt-6 rounded-xl bg-white px-4 py-3 text-xs font-black text-black disabled:opacity-30">New Project</button>
          </div>
        ) : (
          <section className="mt-8">
            <h2 className="mb-4 text-xs font-black uppercase tracking-[0.18em] text-white/35">Recent Projects</h2>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {projects.map((project) => {
              const active = currentProject?.id === project.id;
              return (
                <article key={project.id} className={`rounded-2xl border p-5 transition ${active ? 'border-cyan-300/30 bg-cyan-300/[0.06]' : 'border-white/[0.08] bg-white/[0.025]'}`}>
                  <div className="flex items-start justify-between gap-4">
                    <button type="button" onClick={() => onOpen?.(project.id)} className="min-w-0 flex-1 text-left">
                      <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-white/[0.08] bg-black/25 text-cyan-200"><FolderOpen size={17} /></div>
                      <h2 className="mt-4 truncate text-sm font-bold">{project.name}</h2>
                      <p className="mt-2 text-[10px] uppercase tracking-wider text-white/25">{project.assetCount} Assets · {project.sceneCount} Scenes</p>
                      <p className="mt-3 text-[10px] text-white/20">Updated {new Date(project.updatedAt).toLocaleString()}</p>
                    </button>
                    <button type="button" onClick={() => openRenameProject(project)} aria-label={`Rename ${project.name}`} className="text-white/25 hover:text-white"><Pencil size={14} /></button>
                  </div>
                  <button type="button" onClick={() => onOpen?.(project.id)} className={`mt-5 w-full rounded-xl px-4 py-2.5 text-[10px] font-black ${active ? 'bg-cyan-300 text-black' : 'border border-white/[0.09] text-white/55 hover:text-white'}`}>{active ? 'Current Project' : 'Open Project'}</button>
                </article>
              );
              })}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
