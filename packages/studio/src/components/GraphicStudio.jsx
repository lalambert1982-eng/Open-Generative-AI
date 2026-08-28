"use client";

import React, { useState } from "react";
import DesignAgentStudio from "./DesignAgentStudio";
import ImageStudio from "./ImageStudio";
import LayersStudio from "./LayersStudio";

const MODES = [
  { id: "canvas", label: "Creative Canvas", description: "Conversational design and asset-aware editing" },
  { id: "image", label: "Generate & Edit", description: "Image generation, uploads, drawing, text, shapes, undo, and redo" },
  { id: "layers", label: "Layers", description: "Layer decomposition and advanced composition" },
];

export default function GraphicStudio({
  apiKey,
  initialAsset,
  droppedFiles,
  onFilesHandled,
  onGenerationStart,
  onGenerationEnd,
  onGenerationComplete,
  onGenerationError,
  isHeaderVisible,
  onToggleHeader,
}) {
  const [mode, setMode] = useState(apiKey ? "canvas" : "image");
  const shared = {
    apiKey,
    droppedFiles,
    onFilesHandled,
    onGenerationStart,
    onGenerationEnd,
    onGenerationComplete,
    onGenerationError,
    isHeaderVisible,
    onToggleHeader,
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-[#050506] text-white">
      <header className="flex shrink-0 flex-col gap-3 border-b border-white/[0.07] bg-[#09090b] px-4 py-3 lg:flex-row lg:items-center lg:justify-between lg:px-6">
        <div>
          <p className="text-[10px] font-black uppercase tracking-[0.2em] text-cyan-300/70">Graphic Studio</p>
          <h1 className="mt-1 text-lg font-semibold tracking-tight">One workspace, existing design engines</h1>
        </div>
        <div className="flex max-w-full gap-1 overflow-x-auto rounded-xl border border-white/[0.08] bg-black/30 p-1">
          {MODES.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setMode(item.id)}
              title={item.description}
              className={`shrink-0 rounded-lg px-3 py-2 text-[11px] font-bold transition ${
                mode === item.id ? "bg-cyan-300 text-black" : "text-white/45 hover:bg-white/[0.06] hover:text-white"
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
      </header>

      {!apiKey && (
        <div className="shrink-0 border-b border-cyan-300/10 bg-cyan-300/[0.045] px-4 py-2 text-[11px] leading-5 text-cyan-100/65 lg:px-6">
          Existing Creator image Assets can be edited here without a provider key. Generate new AI images in the secure Image tool; Creative Canvas and legacy AI edits remain isolated until their server-route migration.
        </div>
      )}

      <div className="min-h-0 flex-1">
        {mode === "canvas" && (apiKey
          ? <DesignAgentStudio {...shared} />
          : <div className="flex h-full items-center justify-center p-6"><div className="max-w-xl rounded-3xl border border-white/[0.08] bg-white/[0.025] p-7 text-center"><p className="text-xs font-black uppercase tracking-[0.2em] text-cyan-200">Legacy canvas compatibility</p><h2 className="mt-3 text-xl font-semibold">Creative Canvas still requires a session key</h2><p className="mt-3 text-sm leading-6 text-white/38">Use Generate &amp; Edit for an existing Creator asset without exposing a provider key. Creative Canvas remains isolated until its provider calls migrate behind the secure Creator gateway.</p></div></div>)}
        {mode === "image" && <ImageStudio {...shared} initialAsset={initialAsset} />}
        {mode === "layers" && <LayersStudio {...shared} />}
      </div>
    </div>
  );
}
