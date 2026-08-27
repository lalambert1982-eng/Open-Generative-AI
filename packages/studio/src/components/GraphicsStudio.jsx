"use client";

import React, { useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  Circle,
  Copy,
  Download,
  Image as ImageIcon,
  Redo2,
  Square,
  Trash2,
  Type,
  Undo2,
  Upload,
} from "lucide-react";
import {
  GRAPHICS_BRAND_COLORS,
  GRAPHICS_SIZES,
  addGraphicsObject,
  createGraphicsDocument,
  deleteGraphicsObject,
  duplicateGraphicsObject,
  getGraphicsSize,
  reorderGraphicsObject,
  resizeGraphicsDocument,
  updateGraphicsObject,
} from "./graphicsStudioModel";

const ALLOWED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const MAX_LOCAL_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_HISTORY_ENTRIES = 100;

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function svgPoint(event, svg, size) {
  const bounds = svg.getBoundingClientRect();
  return {
    x: ((event.clientX - bounds.left) / bounds.width) * size.width,
    y: ((event.clientY - bounds.top) / bounds.height) * size.height,
  };
}

function renderText(object) {
  const lines = String(object.content || "").split("\n");
  const anchor = object.textAlign === "center" ? "middle" : object.textAlign === "right" ? "end" : "start";
  const x = object.textAlign === "center"
    ? object.x + (object.width / 2)
    : object.textAlign === "right"
      ? object.x + object.width
      : object.x;

  return (
    <text
      x={x}
      y={object.y + object.fontSize}
      fill={object.color}
      fontFamily="Inter, ui-sans-serif, system-ui, sans-serif"
      fontSize={object.fontSize}
      fontWeight={object.fontWeight}
      textAnchor={anchor}
    >
      {lines.map((line, index) => (
        <tspan key={`${object.id}-${index}`} x={x} dy={index === 0 ? 0 : object.fontSize * object.lineHeight}>
          {line || " "}
        </tspan>
      ))}
    </text>
  );
}

function GraphicsObject({ object, selected, onPointerDown }) {
  const content = object.type === "text"
    ? renderText(object)
    : object.type === "rectangle"
      ? <rect x={object.x} y={object.y} width={object.width} height={object.height} rx={object.cornerRadius} fill={object.color} />
      : object.type === "circle"
        ? <ellipse cx={object.x + object.width / 2} cy={object.y + object.height / 2} rx={object.width / 2} ry={object.height / 2} fill={object.color} />
        : <image href={object.src} x={object.x} y={object.y} width={object.width} height={object.height} preserveAspectRatio="xMidYMid slice" />;

  return (
    <g
      opacity={object.opacity}
      onPointerDown={(event) => onPointerDown(event, object)}
      style={{ cursor: "move" }}
      aria-label={object.name}
    >
      {content}
      {selected && (
        <g data-editor-only="true" opacity={1}>
          <rect
            x={object.x - 6}
            y={object.y - 6}
            width={object.width + 12}
            height={object.height + 12}
            rx={8}
            fill="none"
            stroke="#f4bd50"
            strokeWidth={5}
            strokeDasharray="14 10"
            vectorEffect="non-scaling-stroke"
          />
        </g>
      )}
    </g>
  );
}

function LayerIcon({ type }) {
  if (type === "text") return <Type size={13} />;
  if (type === "circle") return <Circle size={13} />;
  if (type === "image") return <ImageIcon size={13} />;
  return <Square size={13} />;
}

export default function GraphicsStudio() {
  const [history, setHistory] = useState(() => [createGraphicsDocument()]);
  const [historyIndex, setHistoryIndex] = useState(0);
  const [selectedObjectId, setSelectedObjectId] = useState("starter-heading");
  const [error, setError] = useState("");
  const [exporting, setExporting] = useState(false);
  const svgRef = useRef(null);
  const uploadRef = useRef(null);
  const dragRef = useRef(null);

  const graphicsDocument = history[historyIndex];
  const size = getGraphicsSize(graphicsDocument.sizeId);
  const selectedObject = useMemo(
    () => graphicsDocument.objects.find((object) => object.id === selectedObjectId) || null,
    [graphicsDocument.objects, selectedObjectId],
  );

  const commit = (nextDocument, nextSelectedObjectId = selectedObjectId) => {
    const nextHistory = [...history.slice(0, historyIndex + 1), nextDocument].slice(-MAX_HISTORY_ENTRIES);
    setHistory(nextHistory);
    setHistoryIndex(nextHistory.length - 1);
    setSelectedObjectId(nextSelectedObjectId);
    setError("");
  };

  const undo = () => {
    if (historyIndex <= 0) return;
    const nextIndex = historyIndex - 1;
    setHistoryIndex(nextIndex);
    if (!history[nextIndex].objects.some((object) => object.id === selectedObjectId)) {
      setSelectedObjectId(null);
    }
  };

  const redo = () => {
    if (historyIndex >= history.length - 1) return;
    const nextIndex = historyIndex + 1;
    setHistoryIndex(nextIndex);
    if (!history[nextIndex].objects.some((object) => object.id === selectedObjectId)) {
      setSelectedObjectId(null);
    }
  };

  const addObject = (type, source = {}) => {
    const result = addGraphicsObject(graphicsDocument, type, source);
    commit(result.document, result.selectedObjectId);
  };

  const updateSelected = (patch) => {
    if (!selectedObject) return;
    commit(updateGraphicsObject(graphicsDocument, selectedObject.id, patch));
  };

  const duplicateSelected = () => {
    if (!selectedObject) return;
    const result = duplicateGraphicsObject(graphicsDocument, selectedObject.id);
    commit(result.document, result.selectedObjectId);
  };

  const deleteSelected = () => {
    if (!selectedObject) return;
    const result = deleteGraphicsObject(graphicsDocument, selectedObject.id);
    commit(result.document, result.selectedObjectId);
  };

  const reorderSelected = (direction) => {
    if (!selectedObject) return;
    commit(reorderGraphicsObject(graphicsDocument, selectedObject.id, direction));
  };

  const handleObjectPointerDown = (event, object) => {
    event.preventDefault();
    event.stopPropagation();
    setSelectedObjectId(object.id);
    const svg = svgRef.current;
    if (!svg) return;
    const point = svgPoint(event, svg, size);
    const nextHistory = [...history.slice(0, historyIndex + 1), graphicsDocument].slice(-MAX_HISTORY_ENTRIES);
    const dragHistoryIndex = nextHistory.length - 1;
    setHistory(nextHistory);
    setHistoryIndex(dragHistoryIndex);
    dragRef.current = {
      pointerId: event.pointerId,
      historyIndex: dragHistoryIndex,
      object,
      startX: point.x,
      startY: point.y,
      document: graphicsDocument,
    };
    svg.setPointerCapture?.(event.pointerId);
  };

  const handlePointerMove = (event) => {
    const drag = dragRef.current;
    const svg = svgRef.current;
    if (!drag || !svg || drag.pointerId !== event.pointerId) return;
    const point = svgPoint(event, svg, size);
    const x = clamp(drag.object.x + point.x - drag.startX, 0, Math.max(0, size.width - drag.object.width));
    const y = clamp(drag.object.y + point.y - drag.startY, 0, Math.max(0, size.height - drag.object.height));
    const nextDocument = updateGraphicsObject(drag.document, drag.object.id, {
      x: Math.round(x),
      y: Math.round(y),
    });
    setHistory((currentHistory) => currentHistory.map((entry, index) => (
      index === drag.historyIndex ? nextDocument : entry
    )));
  };

  const endDrag = (event) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    svgRef.current?.releasePointerCapture?.(event.pointerId);
    dragRef.current = null;
  };

  const handleUpload = (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!ALLOWED_IMAGE_TYPES.has(file.type)) {
      setError("Use a PNG, JPEG, or WebP image.");
      return;
    }
    if (file.size > MAX_LOCAL_IMAGE_BYTES) {
      setError("Local images must be 8 MB or smaller.");
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      addObject("image", {
        name: file.name,
        src: String(reader.result || ""),
        x: Math.round(size.width * 0.12),
        y: Math.round(size.height * 0.18),
        width: Math.round(size.width * 0.76),
        height: Math.round(size.height * 0.56),
      });
    };
    reader.onerror = () => setError("The local image could not be read.");
    reader.readAsDataURL(file);
  };

  const exportPng = async () => {
    if (!svgRef.current || exporting) return;
    setExporting(true);
    setError("");
    let svgUrl;
    let pngUrl;
    try {
      const clone = svgRef.current.cloneNode(true);
      clone.querySelectorAll("[data-editor-only]").forEach((node) => node.remove());
      clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
      clone.setAttribute("width", String(size.width));
      clone.setAttribute("height", String(size.height));
      const source = new XMLSerializer().serializeToString(clone);
      svgUrl = URL.createObjectURL(new Blob([source], { type: "image/svg+xml;charset=utf-8" }));
      const image = new window.Image();
      await new Promise((resolve, reject) => {
        image.onload = resolve;
        image.onerror = reject;
        image.src = svgUrl;
      });
      const canvas = window.document.createElement("canvas");
      canvas.width = size.width;
      canvas.height = size.height;
      const context = canvas.getContext("2d");
      context.drawImage(image, 0, 0, size.width, size.height);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
      if (!blob) throw new Error("PNG export failed.");
      pngUrl = URL.createObjectURL(blob);
      const anchor = window.document.createElement("a");
      const filename = graphicsDocument.title.trim().replace(/[^a-z0-9_-]+/gi, "-").replace(/^-|-$/g, "") || "gfury-graphic";
      anchor.href = pngUrl;
      anchor.download = `${filename}.png`;
      anchor.click();
    } catch {
      setError("PNG export could not be completed in this browser.");
    } finally {
      if (svgUrl) URL.revokeObjectURL(svgUrl);
      if (pngUrl) URL.revokeObjectURL(pngUrl);
      setExporting(false);
    }
  };

  const compactButton = "flex h-9 items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/[0.045] px-3 text-[11px] font-bold text-white/70 transition hover:border-[#f4bd50]/35 hover:bg-white/[0.09] hover:text-white disabled:cursor-not-allowed disabled:opacity-25";
  const fieldClass = "h-10 w-full rounded-xl border border-white/10 bg-black/30 px-3 text-xs text-white outline-none transition focus:border-[#f4bd50]/55";

  return (
    <main className="flex h-full min-h-0 flex-col overflow-hidden bg-[#09090b] text-white">
      <header className="flex min-h-16 shrink-0 flex-wrap items-center gap-3 border-b border-white/10 bg-[#111114] px-4 py-3 shadow-[0_12px_40px_rgba(0,0,0,0.3)] sm:px-5">
        <div className="mr-auto min-w-[210px]">
          <p className="text-[9px] font-black uppercase tracking-[0.24em] text-[#f4bd50]">G.FURY Graphics Studio</p>
          <input
            aria-label="Graphic title"
            value={graphicsDocument.title}
            onChange={(event) => commit({ ...graphicsDocument, title: event.target.value })}
            className="mt-1 w-full bg-transparent text-lg font-semibold tracking-tight text-white outline-none placeholder:text-white/30"
          />
        </div>
        <div className="flex items-center gap-2">
          <span className="hidden rounded-full border border-emerald-300/20 bg-emerald-300/[0.08] px-3 py-1.5 text-[9px] font-black uppercase tracking-[0.16em] text-emerald-100/75 md:inline-flex">
            Local design · no provider call
          </span>
          <button type="button" onClick={undo} disabled={historyIndex === 0} aria-label="Undo" className={compactButton}><Undo2 size={14} /></button>
          <button type="button" onClick={redo} disabled={historyIndex === history.length - 1} aria-label="Redo" className={compactButton}><Redo2 size={14} /></button>
          <button type="button" onClick={exportPng} className="flex h-10 items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-[#e11d48] to-[#f4bd50] px-4 text-[11px] font-black text-black shadow-[0_8px_30px_rgba(225,29,72,0.22)] transition hover:brightness-110">
            <Download size={14} /> {exporting ? "Exporting…" : "Export PNG"}
          </button>
        </div>
      </header>

      {error && (
        <div role="alert" className="shrink-0 border-b border-rose-300/20 bg-rose-400/10 px-5 py-2 text-xs text-rose-100">
          {error}
        </div>
      )}

      <div className="grid min-h-0 flex-1 overflow-y-auto lg:grid-cols-[220px_minmax(0,1fr)_280px] lg:overflow-hidden">
        <aside className="border-b border-white/10 bg-[#101013] p-4 lg:overflow-y-auto lg:border-b-0 lg:border-r">
          <p className="text-[9px] font-black uppercase tracking-[0.22em] text-white/45">Add to canvas</p>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <button type="button" onClick={() => addObject("text", { content: "Your headline", fontSize: 92, fontWeight: 900, height: 120 })} className={compactButton}><Type size={14} /> Heading</button>
            <button type="button" onClick={() => addObject("text", { content: "Add supporting copy", fontSize: 38, fontWeight: 500, height: 90 })} className={compactButton}><Type size={12} /> Body</button>
            <button type="button" onClick={() => addObject("rectangle")} className={compactButton}><Square size={14} /> Shape</button>
            <button type="button" onClick={() => addObject("circle")} className={compactButton}><Circle size={14} /> Circle</button>
            <button type="button" onClick={() => uploadRef.current?.click()} className={`${compactButton} col-span-2`}><Upload size={14} /> Add local image</button>
            <input ref={uploadRef} type="file" accept="image/png,image/jpeg,image/webp" onChange={handleUpload} className="hidden" />
          </div>

          <div className="mt-6">
            <p className="text-[9px] font-black uppercase tracking-[0.22em] text-white/45">Brand colors</p>
            <div className="mt-3 flex flex-wrap gap-2">
              {GRAPHICS_BRAND_COLORS.map((color) => (
                <button
                  key={color}
                  type="button"
                  aria-label={`Use ${color}`}
                  onClick={() => selectedObject && selectedObject.type !== "image" ? updateSelected({ color }) : commit({ ...graphicsDocument, background: color })}
                  className="h-8 w-8 rounded-full border border-white/20 shadow-[0_4px_14px_rgba(0,0,0,0.35)] transition hover:scale-110"
                  style={{ backgroundColor: color }}
                />
              ))}
            </div>
          </div>

          <div className="mt-6">
            <div className="flex items-center justify-between gap-3">
              <p className="text-[9px] font-black uppercase tracking-[0.22em] text-white/45">Layers</p>
              <span className="text-[9px] text-white/30">{graphicsDocument.objects.length}</span>
            </div>
            <div className="mt-3 space-y-1.5">
              {[...graphicsDocument.objects].reverse().map((object) => (
                <button
                  key={object.id}
                  type="button"
                  onClick={() => setSelectedObjectId(object.id)}
                  className={`flex w-full items-center gap-2 rounded-xl border px-3 py-2 text-left text-[11px] transition ${selectedObjectId === object.id ? "border-[#f4bd50]/45 bg-[#f4bd50]/10 text-[#ffe8ae]" : "border-white/[0.07] bg-black/20 text-white/55 hover:bg-white/[0.05] hover:text-white"}`}
                >
                  <LayerIcon type={object.type} />
                  <span className="truncate">{object.name}</span>
                </button>
              ))}
            </div>
          </div>
        </aside>

        <section className="relative flex min-h-[480px] items-center justify-center overflow-auto bg-[radial-gradient(circle_at_top,rgba(225,29,72,0.11),transparent_36%),linear-gradient(135deg,#17171b,#0b0b0d)] p-5 sm:p-8">
          <div
            className="relative w-full max-w-[760px] overflow-hidden shadow-[0_35px_100px_rgba(0,0,0,0.62),0_0_0_1px_rgba(244,189,80,0.16)]"
            style={{
              aspectRatio: `${size.width} / ${size.height}`,
              width: `min(100%, 760px, calc((100vh - 190px) * ${size.width / size.height}))`,
              maxHeight: "calc(100vh - 190px)",
            }}
          >
            <svg
              ref={svgRef}
              viewBox={`0 0 ${size.width} ${size.height}`}
              width="100%"
              height="100%"
              role="img"
              aria-label={`${graphicsDocument.title} design canvas`}
              onPointerDown={(event) => {
                if (event.target === event.currentTarget) setSelectedObjectId(null);
              }}
              onPointerMove={handlePointerMove}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              className="block h-full w-full touch-none select-none"
            >
              <rect
                width={size.width}
                height={size.height}
                fill={graphicsDocument.background}
                onPointerDown={() => setSelectedObjectId(null)}
              />
              {graphicsDocument.objects.map((object) => (
                <GraphicsObject
                  key={object.id}
                  object={object}
                  selected={selectedObjectId === object.id}
                  onPointerDown={handleObjectPointerDown}
                />
              ))}
            </svg>
          </div>
          <div className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border border-white/10 bg-black/60 px-3 py-1.5 text-[9px] font-bold text-white/45 backdrop-blur">
            {size.width} × {size.height} · drag elements to arrange
          </div>
        </section>

        <aside className="border-t border-white/10 bg-[#101013] p-4 lg:overflow-y-auto lg:border-l lg:border-t-0">
          <p className="text-[9px] font-black uppercase tracking-[0.22em] text-[#f4bd50]">Design settings</p>
          <label className="mt-4 block text-[10px] font-bold text-white/55">
            Format
            <select
              value={graphicsDocument.sizeId}
              onChange={(event) => commit(resizeGraphicsDocument(graphicsDocument, event.target.value))}
              className={`${fieldClass} mt-2`}
            >
              {GRAPHICS_SIZES.map((option) => <option key={option.id} value={option.id}>{option.label} · {option.width}×{option.height}</option>)}
            </select>
          </label>

          {!selectedObject ? (
            <div className="mt-5 rounded-2xl border border-white/[0.08] bg-black/20 p-4">
              <p className="text-xs font-bold">Canvas selected</p>
              <p className="mt-1 text-[10px] leading-4 text-white/35">Choose a background or select a layer to edit it.</p>
              <label className="mt-4 flex items-center justify-between gap-3 text-[10px] font-bold text-white/55">
                Background
                <input type="color" value={graphicsDocument.background} onChange={(event) => commit({ ...graphicsDocument, background: event.target.value })} className="h-9 w-14 cursor-pointer rounded-lg border border-white/10 bg-transparent" />
              </label>
            </div>
          ) : (
            <div className="mt-5 space-y-4 rounded-2xl border border-[#f4bd50]/15 bg-[#f4bd50]/[0.035] p-4">
              <div>
                <p className="text-xs font-bold text-white">{selectedObject.name}</p>
                <p className="mt-1 text-[9px] font-black uppercase tracking-[0.18em] text-white/30">{selectedObject.type}</p>
              </div>

              {selectedObject.type === "text" && (
                <>
                  <label className="block text-[10px] font-bold text-white/55">
                    Text
                    <textarea value={selectedObject.content} onChange={(event) => updateSelected({ content: event.target.value })} rows={4} className="mt-2 w-full resize-none rounded-xl border border-white/10 bg-black/30 p-3 text-xs leading-5 text-white outline-none focus:border-[#f4bd50]/55" />
                  </label>
                  <label className="block text-[10px] font-bold text-white/55">
                    Font size · {selectedObject.fontSize}px
                    <input type="range" min="18" max="180" value={selectedObject.fontSize} onChange={(event) => updateSelected({ fontSize: Number(event.target.value) })} className="mt-2 w-full accent-[#e11d48]" />
                  </label>
                  <label className="block text-[10px] font-bold text-white/55">
                    Weight
                    <select value={selectedObject.fontWeight} onChange={(event) => updateSelected({ fontWeight: Number(event.target.value) })} className={`${fieldClass} mt-2`}>
                      <option value="400">Regular</option><option value="600">Semibold</option><option value="800">Bold</option><option value="900">Black</option>
                    </select>
                  </label>
                </>
              )}

              {selectedObject.type !== "image" && (
                <label className="flex items-center justify-between gap-3 text-[10px] font-bold text-white/55">
                  Element color
                  <input type="color" value={selectedObject.color} onChange={(event) => updateSelected({ color: event.target.value })} className="h-9 w-14 cursor-pointer rounded-lg border border-white/10 bg-transparent" />
                </label>
              )}

              <label className="block text-[10px] font-bold text-white/55">
                Opacity · {Math.round(selectedObject.opacity * 100)}%
                <input type="range" min="10" max="100" value={Math.round(selectedObject.opacity * 100)} onChange={(event) => updateSelected({ opacity: Number(event.target.value) / 100 })} className="mt-2 w-full accent-[#f4bd50]" />
              </label>

              <div className="grid grid-cols-2 gap-2">
                <label className="text-[10px] font-bold text-white/55">X<input type="number" value={Math.round(selectedObject.x)} onChange={(event) => updateSelected({ x: Number(event.target.value) || 0 })} className={`${fieldClass} mt-1`} /></label>
                <label className="text-[10px] font-bold text-white/55">Y<input type="number" value={Math.round(selectedObject.y)} onChange={(event) => updateSelected({ y: Number(event.target.value) || 0 })} className={`${fieldClass} mt-1`} /></label>
                <label className="text-[10px] font-bold text-white/55">Width<input type="number" min="10" value={Math.round(selectedObject.width)} onChange={(event) => updateSelected({ width: Math.max(10, Number(event.target.value) || 10) })} className={`${fieldClass} mt-1`} /></label>
                <label className="text-[10px] font-bold text-white/55">Height<input type="number" min="10" value={Math.round(selectedObject.height)} onChange={(event) => updateSelected({ height: Math.max(10, Number(event.target.value) || 10) })} className={`${fieldClass} mt-1`} /></label>
              </div>

              <div className="grid grid-cols-2 gap-2 border-t border-white/[0.08] pt-4">
                <button type="button" onClick={() => reorderSelected("forward")} className={compactButton}><ChevronUp size={14} /> Forward</button>
                <button type="button" onClick={() => reorderSelected("backward")} className={compactButton}><ChevronDown size={14} /> Backward</button>
                <button type="button" onClick={duplicateSelected} className={compactButton}><Copy size={14} /> Duplicate</button>
                <button type="button" onClick={deleteSelected} className="flex h-9 items-center justify-center gap-2 rounded-xl border border-rose-300/15 bg-rose-400/[0.06] px-3 text-[11px] font-bold text-rose-100/70 transition hover:bg-rose-400/15 hover:text-white"><Trash2 size={14} /> Delete</button>
              </div>
            </div>
          )}

          <div className="mt-5 rounded-2xl border border-white/[0.08] bg-black/20 p-4 text-[10px] leading-5 text-white/35">
            <strong className="block text-white/65">Phase 1 scope</strong>
            Static graphics edit in local React state. AI generation, shared assets, cloud saves, collaboration, and template persistence are not claimed in this build.
          </div>
        </aside>
      </div>
    </main>
  );
}
