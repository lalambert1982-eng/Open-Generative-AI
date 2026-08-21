"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Bot,
  Check,
  CircleAlert,
  Download,
  ExternalLink,
  Film,
  Image as ImageIcon,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  Mic2,
  Play,
  Send,
  Sparkles,
  UserRound,
  WandSparkles,
} from "lucide-react";

const ACCESS_KEY_STORAGE = "creator_studio_access_key";

const TOOLS = [
  {
    id: "assistant",
    label: "Assistant",
    provider: "anthropic",
    eyebrow: "Think",
    description: "Turn a rough idea into a production plan, script, or optimized prompt.",
    icon: Bot,
    accent: "from-violet-500 to-fuchsia-400",
  },
  {
    id: "image",
    label: "Image",
    provider: "openai",
    eyebrow: "Create",
    description: "Generate an original campaign image or first frame with OpenAI.",
    icon: ImageIcon,
    accent: "from-emerald-400 to-cyan-400",
  },
  {
    id: "voice",
    label: "Voice",
    provider: "elevenlabs",
    eyebrow: "Speak",
    description: "Render narration with your configured ElevenLabs voice.",
    icon: Mic2,
    accent: "from-amber-400 to-orange-500",
  },
  {
    id: "avatar",
    label: "Avatar",
    provider: "heygen",
    eyebrow: "Present",
    description: "Create a presenter video with your configured HeyGen avatar and voice.",
    icon: UserRound,
    accent: "from-sky-400 to-blue-600",
  },
  {
    id: "video",
    label: "Video",
    provider: "runway",
    eyebrow: "Direct",
    description: "Generate a cinematic clip from text or an optional first-frame image.",
    icon: Film,
    accent: "from-pink-500 to-rose-500",
  },
];

const INITIAL_DRAFTS = {
  assistant: {
    prompt: "",
    mode: "strategy",
  },
  image: {
    prompt: "",
    size: "1024x1024",
    quality: "low",
  },
  voice: {
    text: "",
    stability: 0.5,
    similarityBoost: 0.75,
  },
  avatar: {
    script: "",
    title: "G.FURY Creator Studio",
    aspectRatio: "16:9",
  },
  video: {
    prompt: "",
    firstFrameUrl: "",
    ratio: "1280:720",
    duration: 5,
  },
};

function cx(...values) {
  return values.filter(Boolean).join(" ");
}

async function responseError(response) {
  try {
    const data = await response.json();
    return data.detail || data.error || `Request failed (${response.status})`;
  } catch {
    return `Request failed (${response.status})`;
  }
}

function sleep(milliseconds) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function ToolButton({ tool, active, provider, onClick }) {
  const Icon = tool.icon;
  const configured = provider?.configured === true;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`${tool.label} — ${configured ? "configured" : "setup required"}`}
      aria-pressed={active}
      title={tool.label}
      className={cx(
        "group relative flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl border transition-all duration-200",
        active
          ? "border-white/20 bg-white/[0.12] text-white shadow-[0_12px_35px_rgba(0,0,0,0.35)]"
          : "border-transparent bg-transparent text-white/40 hover:border-white/10 hover:bg-white/[0.06] hover:text-white",
      )}
    >
      {active && (
        <span className={cx("absolute -left-2 h-7 w-1 rounded-full bg-gradient-to-b", tool.accent)} />
      )}
      <Icon size={21} strokeWidth={1.8} />
      <span
        className={cx(
          "absolute right-2 top-2 h-1.5 w-1.5 rounded-full",
          configured ? "bg-emerald-400" : "bg-amber-400",
        )}
      />
    </button>
  );
}

function ProviderChip({ provider }) {
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-full border border-white/[0.08] bg-black/30 px-3 py-1.5">
      <span className={cx("h-2 w-2 shrink-0 rounded-full", provider?.configured ? "bg-emerald-400" : "bg-amber-400")} />
      <span className="truncate text-[11px] font-semibold text-white/70">
        {provider?.label || "Provider"}
      </span>
      <span className="hidden truncate text-[10px] text-white/30 sm:inline">
        {provider?.model || "setup required"}
      </span>
    </div>
  );
}

function UnlockPanel({ value, onChange, onUnlock, error, loading }) {
  return (
    <div className="flex h-full w-full items-center justify-center bg-[#050506] px-5 py-12">
      <div className="relative w-full max-w-lg overflow-hidden rounded-[28px] border border-white/10 bg-[#0b0b0e] p-7 shadow-[0_30px_100px_rgba(0,0,0,0.65)] sm:p-10">
        <div className="pointer-events-none absolute -right-28 -top-28 h-64 w-64 rounded-full bg-violet-500/15 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-36 -left-24 h-72 w-72 rounded-full bg-cyan-400/10 blur-3xl" />
        <div className="relative">
          <div className="mb-7 flex h-14 w-14 items-center justify-center rounded-2xl border border-white/10 bg-white/[0.06] text-cyan-300">
            <LockKeyhole size={25} />
          </div>
          <p className="mb-2 text-[11px] font-black uppercase tracking-[0.24em] text-cyan-300/80">Private provider workspace</p>
          <h2 className="text-3xl font-semibold tracking-[-0.04em] text-white">Unlock Creator Studio</h2>
          <p className="mt-3 max-w-md text-sm leading-6 text-white/45">
            Enter the private Creator Studio access key. Your Anthropic, OpenAI, ElevenLabs, HeyGen, and Runway credentials stay on the server.
          </p>

          <form onSubmit={onUnlock} className="mt-8 space-y-4">
            <label className="block">
              <span className="mb-2 block text-[11px] font-bold uppercase tracking-[0.16em] text-white/35">Studio access key</span>
              <div className="flex items-center gap-3 rounded-2xl border border-white/10 bg-black/35 px-4 focus-within:border-cyan-300/40 focus-within:ring-4 focus-within:ring-cyan-300/[0.06]">
                <KeyRound size={17} className="text-white/30" />
                <input
                  type="password"
                  value={value}
                  onChange={(event) => onChange(event.target.value)}
                  placeholder="Paste the private access key"
                  autoComplete="off"
                  className="h-14 min-w-0 flex-1 bg-transparent text-sm text-white outline-none placeholder:text-white/20"
                />
              </div>
            </label>
            {error && (
              <div className="flex items-start gap-2 rounded-xl border border-red-400/20 bg-red-400/[0.08] px-3 py-2.5 text-xs leading-5 text-red-200">
                <CircleAlert size={15} className="mt-0.5 shrink-0" />
                <span>{error}</span>
              </div>
            )}
            <button
              type="submit"
              disabled={!value.trim() || loading}
              className="flex h-12 w-full items-center justify-center gap-2 rounded-2xl bg-white px-5 text-sm font-bold text-black transition hover:bg-cyan-200 disabled:cursor-not-allowed disabled:opacity-35"
            >
              {loading ? <LoaderCircle size={17} className="animate-spin" /> : <Sparkles size={17} />}
              Unlock workspace
            </button>
          </form>
          <p className="mt-5 text-[11px] leading-5 text-white/25">
            This key is stored only in this browser tab and is different from every provider API key.
          </p>
        </div>
      </div>
    </div>
  );
}

function EmptyCanvas({ tool, configured }) {
  const Icon = tool.icon;
  return (
    <div className="relative flex h-full min-h-[360px] w-full items-center justify-center overflow-hidden rounded-[26px] border border-white/[0.08] bg-[#08080a]">
      <div className="absolute inset-0 opacity-[0.18] [background-image:linear-gradient(rgba(255,255,255,.08)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,.08)_1px,transparent_1px)] [background-size:42px_42px]" />
      <div className={cx("absolute h-56 w-56 rounded-full bg-gradient-to-br opacity-10 blur-3xl", tool.accent)} />
      <div className="relative flex max-w-md flex-col items-center px-7 text-center">
        <div className={cx("mb-5 flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br text-black", tool.accent)}>
          <Icon size={29} strokeWidth={1.8} />
        </div>
        <p className="text-[11px] font-black uppercase tracking-[0.22em] text-white/35">{tool.eyebrow} with {tool.label}</p>
        <h3 className="mt-2 text-2xl font-semibold tracking-tight text-white">Your result appears here</h3>
        <p className="mt-3 text-sm leading-6 text-white/38">{tool.description}</p>
        {!configured && (
          <div className="mt-5 flex items-center gap-2 rounded-full border border-amber-400/20 bg-amber-400/[0.08] px-3 py-1.5 text-[11px] font-semibold text-amber-200">
            <CircleAlert size={13} /> Provider setup required in Vercel
          </div>
        )}
      </div>
    </div>
  );
}

function ResultCanvas({ output, tool }) {
  if (!output) return null;

  return (
    <div className="relative flex h-full min-h-[360px] w-full items-center justify-center overflow-hidden rounded-[26px] border border-white/[0.09] bg-[#08080a] p-5 sm:p-8">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_20%,rgba(255,255,255,0.08),transparent_45%)]" />

      {output.type === "text" && (
        <article className="relative max-h-full w-full max-w-3xl overflow-y-auto rounded-2xl border border-white/[0.08] bg-black/35 p-6 text-sm leading-7 text-white/75 custom-scrollbar sm:p-9">
          <div className="mb-5 flex items-center justify-between gap-3 border-b border-white/[0.07] pb-4">
            <div>
              <p className="text-[10px] font-black uppercase tracking-[0.2em] text-violet-300">Anthropic response</p>
              <p className="mt-1 text-xs text-white/30">{output.model}</p>
            </div>
            <Check size={18} className="text-emerald-400" />
          </div>
          <div className="whitespace-pre-wrap">{output.text}</div>
        </article>
      )}

      {output.type === "image" && (
        <div className="relative flex h-full w-full items-center justify-center">
          <img src={output.url} alt="Generated creative" className="max-h-full max-w-full rounded-2xl object-contain shadow-2xl" />
          <a
            href={output.url}
            download="creator-studio-image.png"
            className="absolute bottom-3 right-3 flex h-10 items-center gap-2 rounded-xl border border-white/15 bg-black/70 px-3 text-xs font-bold text-white backdrop-blur-xl transition hover:bg-white hover:text-black"
          >
            <Download size={15} /> Download
          </a>
        </div>
      )}

      {output.type === "audio" && (
        <div className="relative w-full max-w-xl rounded-[26px] border border-white/[0.08] bg-black/35 p-7 sm:p-10">
          <div className={cx("mb-8 flex h-20 w-20 items-center justify-center rounded-[24px] bg-gradient-to-br text-black", tool.accent)}>
            <Mic2 size={34} />
          </div>
          <p className="text-[10px] font-black uppercase tracking-[0.22em] text-amber-300">ElevenLabs voice</p>
          <h3 className="mt-2 text-2xl font-semibold text-white">Narration ready</h3>
          <audio src={output.url} controls className="mt-7 w-full" />
          <a href={output.url} download="creator-studio-voice.mp3" className="mt-5 inline-flex items-center gap-2 text-xs font-bold text-white/55 hover:text-white">
            <Download size={14} /> Download MP3
          </a>
        </div>
      )}

      {output.type === "video" && output.url && (
        <div className="relative flex h-full w-full items-center justify-center">
          <video src={output.url} poster={output.thumbnailUrl || undefined} controls className="max-h-full max-w-full rounded-2xl bg-black object-contain shadow-2xl" />
          <a
            href={output.url}
            target="_blank"
            rel="noreferrer"
            className="absolute bottom-3 right-3 flex h-10 items-center gap-2 rounded-xl border border-white/15 bg-black/70 px-3 text-xs font-bold text-white backdrop-blur-xl transition hover:bg-white hover:text-black"
          >
            <ExternalLink size={14} /> Open
          </a>
        </div>
      )}

      {output.type === "pending" && (
        <div className="relative flex max-w-md flex-col items-center text-center">
          <div className={cx("flex h-20 w-20 items-center justify-center rounded-[24px] bg-gradient-to-br text-black", tool.accent)}>
            <LoaderCircle size={34} className="animate-spin" />
          </div>
          <p className="mt-6 text-[10px] font-black uppercase tracking-[0.2em] text-white/35">{output.provider} is rendering</p>
          <h3 className="mt-2 text-2xl font-semibold text-white">{output.status || "Generation queued"}</h3>
          <p className="mt-3 text-sm leading-6 text-white/35">You can keep this workspace open while the provider completes the job.</p>
          {output.id && <p className="mt-4 max-w-full truncate font-mono text-[10px] text-white/20" title={output.id}>Task {output.id}</p>}
        </div>
      )}
    </div>
  );
}

function FieldLabel({ children, hint }) {
  return (
    <div className="mb-2 flex items-center justify-between gap-3">
      <label className="text-[10px] font-black uppercase tracking-[0.17em] text-white/38">{children}</label>
      {hint && <span className="text-[10px] text-white/22">{hint}</span>}
    </div>
  );
}

const inputClass = "w-full rounded-xl border border-white/[0.08] bg-black/25 px-3.5 py-3 text-xs text-white outline-none transition placeholder:text-white/20 focus:border-white/20 focus:bg-black/40";
const selectClass = `${inputClass} appearance-none`;

function PromptTextarea({ value, onChange, placeholder, maxLength = 4000 }) {
  return (
    <textarea
      value={value}
      onChange={(event) => onChange(event.target.value)}
      placeholder={placeholder}
      maxLength={maxLength}
      rows={8}
      className="min-h-44 w-full resize-none rounded-2xl border border-white/[0.08] bg-black/25 px-4 py-4 text-sm leading-6 text-white outline-none transition placeholder:text-white/20 focus:border-white/20 focus:bg-black/40"
    />
  );
}

function InspectorFields({ activeTool, draft, updateDraft }) {
  if (activeTool.id === "assistant") {
    return (
      <>
        <div>
          <FieldLabel>Assistant mode</FieldLabel>
          <select value={draft.mode} onChange={(event) => updateDraft("mode", event.target.value)} className={selectClass}>
            <option value="strategy">Creative strategy</option>
            <option value="plan">Production plan</option>
            <option value="script">Script + shot plan</option>
            <option value="prompt">Provider prompts</option>
          </select>
        </div>
        <div>
          <FieldLabel hint={`${draft.prompt.length}/20000`}>Brief</FieldLabel>
          <PromptTextarea value={draft.prompt} onChange={(value) => updateDraft("prompt", value)} placeholder="Describe the content, audience, platform, tone, and desired outcome…" maxLength={20000} />
        </div>
      </>
    );
  }

  if (activeTool.id === "image") {
    return (
      <>
        <div>
          <FieldLabel hint={`${draft.prompt.length}/4000`}>Image prompt</FieldLabel>
          <PromptTextarea value={draft.prompt} onChange={(value) => updateDraft("prompt", value)} placeholder="Describe the subject, setting, camera, light, color, and composition…" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <FieldLabel>Canvas</FieldLabel>
            <select value={draft.size} onChange={(event) => updateDraft("size", event.target.value)} className={selectClass}>
              <option value="1024x1024">Square</option>
              <option value="1536x1024">Landscape</option>
              <option value="1024x1536">Portrait</option>
            </select>
          </div>
          <div>
            <FieldLabel>Quality</FieldLabel>
            <select value={draft.quality} onChange={(event) => updateDraft("quality", event.target.value)} className={selectClass}>
              <option value="low">Low — test</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
            </select>
          </div>
        </div>
      </>
    );
  }

  if (activeTool.id === "voice") {
    return (
      <>
        <div>
          <FieldLabel hint={`${draft.text.length}/5000`}>Voice script</FieldLabel>
          <PromptTextarea value={draft.text} onChange={(value) => updateDraft("text", value)} placeholder="Paste narration for your configured voice…" maxLength={5000} />
        </div>
        <div className="space-y-4 rounded-2xl border border-white/[0.07] bg-black/20 p-4">
          <label className="block">
            <span className="mb-2 flex justify-between text-[10px] font-bold uppercase tracking-wider text-white/35"><span>Stability</span><span>{draft.stability}</span></span>
            <input type="range" min="0" max="1" step="0.05" value={draft.stability} onChange={(event) => updateDraft("stability", Number(event.target.value))} className="w-full accent-amber-400" />
          </label>
          <label className="block">
            <span className="mb-2 flex justify-between text-[10px] font-bold uppercase tracking-wider text-white/35"><span>Similarity</span><span>{draft.similarityBoost}</span></span>
            <input type="range" min="0" max="1" step="0.05" value={draft.similarityBoost} onChange={(event) => updateDraft("similarityBoost", Number(event.target.value))} className="w-full accent-amber-400" />
          </label>
        </div>
      </>
    );
  }

  if (activeTool.id === "avatar") {
    return (
      <>
        <div>
          <FieldLabel hint={`${draft.script.length}/5000`}>Avatar script</FieldLabel>
          <PromptTextarea value={draft.script} onChange={(value) => updateDraft("script", value)} placeholder="Write exactly what your HeyGen avatar should say…" maxLength={5000} />
        </div>
        <div>
          <FieldLabel>Project title</FieldLabel>
          <input value={draft.title} onChange={(event) => updateDraft("title", event.target.value)} maxLength={100} className={inputClass} />
        </div>
        <div>
          <FieldLabel>Aspect ratio</FieldLabel>
          <select value={draft.aspectRatio} onChange={(event) => updateDraft("aspectRatio", event.target.value)} className={selectClass}>
            <option value="16:9">Landscape 16:9</option>
            <option value="9:16">Vertical 9:16</option>
            <option value="1:1">Square 1:1</option>
          </select>
        </div>
      </>
    );
  }

  return (
    <>
      <div>
        <FieldLabel hint={`${draft.prompt.length}/4000`}>Direction</FieldLabel>
        <PromptTextarea value={draft.prompt} onChange={(value) => updateDraft("prompt", value)} placeholder="Describe the shot, subject motion, camera movement, lighting, and mood…" />
      </div>
      <div>
        <FieldLabel>First-frame image URL <span className="normal-case tracking-normal text-white/20">optional</span></FieldLabel>
        <input type="url" value={draft.firstFrameUrl} onChange={(event) => updateDraft("firstFrameUrl", event.target.value)} placeholder="https://…" className={inputClass} />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <FieldLabel>Frame</FieldLabel>
          <select value={draft.ratio} onChange={(event) => updateDraft("ratio", event.target.value)} className={selectClass}>
            <option value="1280:720">Landscape</option>
            <option value="720:1280">Vertical</option>
            <option value="1280:768">Cinema wide</option>
            <option value="768:1280">Portrait</option>
          </select>
        </div>
        <div>
          <FieldLabel>Duration</FieldLabel>
          <select value={draft.duration} onChange={(event) => updateDraft("duration", Number(event.target.value))} className={selectClass}>
            {[2, 3, 4, 5, 6, 7, 8, 9, 10].map((seconds) => <option key={seconds} value={seconds}>{seconds} sec</option>)}
          </select>
        </div>
      </div>
    </>
  );
}

function hasRequiredInput(toolId, draft) {
  if (toolId === "voice") return Boolean(draft.text.trim());
  if (toolId === "avatar") return Boolean(draft.script.trim());
  return Boolean(draft.prompt.trim());
}

export default function CreatorStudio({ onGenerationStart, onGenerationEnd, onGenerationComplete, onGenerationError }) {
  const [accessKey, setAccessKey] = useState("");
  const [unlockValue, setUnlockValue] = useState("");
  const [providers, setProviders] = useState([]);
  const [activeToolId, setActiveToolId] = useState("assistant");
  const [drafts, setDrafts] = useState(INITIAL_DRAFTS);
  const [outputs, setOutputs] = useState({});
  const [unlocking, setUnlocking] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [hydrated, setHydrated] = useState(false);
  const objectUrlsRef = useRef(new Set());
  const generationTokenRef = useRef(0);

  const activeTool = TOOLS.find((tool) => tool.id === activeToolId) || TOOLS[0];
  const activeDraft = drafts[activeTool.id];
  const activeOutput = outputs[activeTool.id] || null;
  const activeProvider = providers.find((provider) => provider.id === activeTool.provider);

  const providerMap = useMemo(
    () => Object.fromEntries(providers.map((provider) => [provider.id, provider])),
    [providers],
  );

  const request = useCallback(async (path, options = {}, keyOverride) => {
    const key = keyOverride || accessKey;
    const headers = new Headers(options.headers || {});
    headers.set("x-studio-access-key", key);
    if (options.body && typeof options.body !== "string") {
      headers.set("content-type", "application/json");
    }
    const response = await fetch(`/api/creator/${path}`, {
      ...options,
      headers,
      body: options.body && typeof options.body !== "string" ? JSON.stringify(options.body) : options.body,
    });
    if (response.status === 401) {
      window.sessionStorage.removeItem(ACCESS_KEY_STORAGE);
      setAccessKey("");
    }
    return response;
  }, [accessKey]);

  const loadProviders = useCallback(async (key) => {
    const response = await request("providers", {}, key);
    if (!response.ok) throw new Error(await responseError(response));
    const data = await response.json();
    setProviders(Array.isArray(data.providers) ? data.providers : []);
    return data;
  }, [request]);

  useEffect(() => {
    const stored = window.sessionStorage.getItem(ACCESS_KEY_STORAGE) || "";
    setHydrated(true);
    if (!stored) return;
    setAccessKey(stored);
    loadProviders(stored).catch(() => {
      window.sessionStorage.removeItem(ACCESS_KEY_STORAGE);
      setAccessKey("");
    });
  }, []);

  useEffect(() => () => {
    generationTokenRef.current += 1;
    objectUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    objectUrlsRef.current.clear();
  }, []);

  const handleUnlock = async (event) => {
    event.preventDefault();
    if (!unlockValue.trim() || unlocking) return;
    setUnlocking(true);
    setError("");
    try {
      await loadProviders(unlockValue.trim());
      window.sessionStorage.setItem(ACCESS_KEY_STORAGE, unlockValue.trim());
      setAccessKey(unlockValue.trim());
      setUnlockValue("");
    } catch (unlockError) {
      setError(unlockError.message || "Unable to unlock Creator Studio.");
    } finally {
      setUnlocking(false);
    }
  };

  const lockStudio = () => {
    generationTokenRef.current += 1;
    window.sessionStorage.removeItem(ACCESS_KEY_STORAGE);
    setAccessKey("");
    setProviders([]);
    setError("");
  };

  const updateDraft = (field, value) => {
    setDrafts((previous) => ({
      ...previous,
      [activeTool.id]: { ...previous[activeTool.id], [field]: value },
    }));
  };

  const rememberObjectUrl = (blob) => {
    const url = URL.createObjectURL(blob);
    objectUrlsRef.current.add(url);
    return url;
  };

  const pollTask = async (provider, id, token, toolId) => {
    const terminalSuccess = provider === "runway" ? ["SUCCEEDED"] : ["completed"];
    const terminalFailure = provider === "runway" ? ["FAILED", "CANCELED"] : ["failed", "error"];

    for (let attempt = 0; attempt < 120; attempt += 1) {
      await sleep(5000 + Math.floor(Math.random() * 700));
      if (generationTokenRef.current !== token) throw new Error("Generation was stopped.");
      const response = await request(`${provider}/status?id=${encodeURIComponent(id)}`);
      if (!response.ok) throw new Error(await responseError(response));
      const data = await response.json();
      const status = String(data.status || "unknown");
      const terminalStatus = provider === "runway" ? status.toUpperCase() : status.toLowerCase();
      setOutputs((previous) => ({
        ...previous,
        [toolId]: { type: "pending", provider, id, status },
      }));
      if (terminalSuccess.includes(terminalStatus)) {
        const url = provider === "runway" ? data.output?.[0] : data.videoUrl;
        if (!url) throw new Error(`${provider} completed without a video URL.`);
        return { type: "video", provider, id, url, thumbnailUrl: data.thumbnailUrl || null };
      }
      if (terminalFailure.includes(terminalStatus)) {
        throw new Error(data.failure || `${provider} generation failed.`);
      }
    }
    throw new Error(`${provider} generation is still running. Reopen the provider dashboard with the task ID to check it.`);
  };

  const generate = async () => {
    if (working || !activeProvider?.configured || !hasRequiredInput(activeTool.id, activeDraft)) return;
    const toolId = activeTool.id;
    const providerId = activeTool.provider;
    const draft = activeDraft;
    const token = generationTokenRef.current + 1;
    generationTokenRef.current = token;
    setWorking(true);
    setError("");
    onGenerationStart?.();

    try {
      let output;
      if (toolId === "assistant") {
        const response = await request("assistant", { method: "POST", body: draft });
        if (!response.ok) throw new Error(await responseError(response));
        const data = await response.json();
        output = { type: "text", text: data.text, model: data.model };
      } else if (toolId === "image") {
        const response = await request("image", { method: "POST", body: draft });
        if (!response.ok) throw new Error(await responseError(response));
        output = { type: "image", url: rememberObjectUrl(await response.blob()) };
      } else if (toolId === "voice") {
        const response = await request("speech", { method: "POST", body: draft });
        if (!response.ok) throw new Error(await responseError(response));
        output = { type: "audio", url: rememberObjectUrl(await response.blob()) };
      } else if (toolId === "avatar") {
        const response = await request("heygen", { method: "POST", body: draft });
        if (!response.ok) throw new Error(await responseError(response));
        const data = await response.json();
        setOutputs((previous) => ({ ...previous, avatar: { type: "pending", provider: "heygen", id: data.id, status: data.status } }));
        output = await pollTask("heygen", data.id, token, toolId);
      } else {
        const response = await request("runway", { method: "POST", body: draft });
        if (!response.ok) throw new Error(await responseError(response));
        const data = await response.json();
        setOutputs((previous) => ({ ...previous, video: { type: "pending", provider: "runway", id: data.id, status: data.status } }));
        output = await pollTask("runway", data.id, token, toolId);
      }

      if (generationTokenRef.current !== token) return;
      setOutputs((previous) => ({ ...previous, [toolId]: output }));
      onGenerationComplete?.({ url: output.url || null, provider: providerId });
    } catch (generationError) {
      if (generationTokenRef.current !== token) return;
      const message = generationError.message || "Generation failed.";
      setError(message);
      onGenerationError?.(message);
    } finally {
      if (generationTokenRef.current === token) {
        setWorking(false);
      }
      onGenerationEnd?.();
    }
  };

  if (!hydrated) return <div className="h-full w-full bg-[#050506]" />;
  if (!accessKey) {
    return <UnlockPanel value={unlockValue} onChange={setUnlockValue} onUnlock={handleUnlock} error={error} loading={unlocking} />;
  }

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-[#050506] text-white">
      <header className="flex h-16 shrink-0 items-center justify-between gap-4 border-b border-white/[0.06] bg-[#09090b]/95 px-4 sm:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white text-black">
            <WandSparkles size={18} />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="truncate text-sm font-bold tracking-tight">Creator Studio</h1>
              <span className="rounded-full border border-violet-400/20 bg-violet-400/10 px-2 py-0.5 text-[9px] font-black uppercase tracking-wider text-violet-200">Private</span>
            </div>
            <p className="truncate text-[10px] text-white/30">One canvas · five specialist providers</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="hidden items-center gap-2 lg:flex">
            {providers.map((provider) => <ProviderChip key={provider.id} provider={provider} />)}
          </div>
          <button type="button" onClick={lockStudio} title="Lock Creator Studio" className="flex h-9 w-9 items-center justify-center rounded-xl border border-white/[0.08] bg-white/[0.04] text-white/45 transition hover:bg-white/[0.09] hover:text-white">
            <LockKeyhole size={16} />
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <aside className="flex shrink-0 items-center gap-2 overflow-x-auto border-b border-white/[0.06] bg-[#09090b] px-3 py-2 md:w-[76px] md:flex-col md:border-b-0 md:border-r md:px-2 md:py-4">
          {TOOLS.map((tool) => (
            <ToolButton
              key={tool.id}
              tool={tool}
              active={activeTool.id === tool.id}
              provider={providerMap[tool.provider]}
              onClick={() => { setActiveToolId(tool.id); setError(""); }}
            />
          ))}
        </aside>

        <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <div className="flex shrink-0 items-center justify-between border-b border-white/[0.05] px-5 py-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className={cx("h-2 w-2 rounded-full bg-gradient-to-br", activeTool.accent)} />
                <p className="text-[10px] font-black uppercase tracking-[0.2em] text-white/40">{activeTool.eyebrow}</p>
              </div>
              <h2 className="mt-1 truncate text-lg font-semibold tracking-tight">{activeTool.label}</h2>
            </div>
            <ProviderChip provider={activeProvider} />
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-4 custom-scrollbar sm:p-6">
            <div className="mx-auto h-full min-h-[360px] w-full max-w-6xl">
              {activeOutput ? <ResultCanvas output={activeOutput} tool={activeTool} /> : <EmptyCanvas tool={activeTool} configured={activeProvider?.configured} />}
            </div>
          </div>
        </main>

        <aside className="max-h-[48vh] shrink-0 overflow-y-auto border-t border-white/[0.06] bg-[#0a0a0d] custom-scrollbar md:max-h-none md:w-[370px] md:border-l md:border-t-0 xl:w-[410px]">
          <div className="p-5 sm:p-6">
            <div className="mb-6">
              <p className="text-[10px] font-black uppercase tracking-[0.2em] text-white/30">Generation controls</p>
              <h3 className="mt-1 text-xl font-semibold tracking-tight">{activeTool.description}</h3>
            </div>

            {!activeProvider?.configured && (
              <div className="mb-5 flex items-start gap-3 rounded-2xl border border-amber-400/20 bg-amber-400/[0.07] p-4 text-xs leading-5 text-amber-100/80">
                <CircleAlert size={16} className="mt-0.5 shrink-0 text-amber-300" />
                <span>Add the required {activeProvider?.label || activeTool.provider} environment variables in Vercel, then redeploy.</span>
              </div>
            )}

            <div className="space-y-5">
              <InspectorFields activeTool={activeTool} draft={activeDraft} updateDraft={updateDraft} />
            </div>

            {error && (
              <div role="alert" className="mt-5 flex items-start gap-2 rounded-xl border border-red-400/20 bg-red-400/[0.08] px-3 py-2.5 text-xs leading-5 text-red-200">
                <CircleAlert size={15} className="mt-0.5 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            <button
              type="button"
              onClick={generate}
              disabled={working || !activeProvider?.configured || !hasRequiredInput(activeTool.id, activeDraft)}
              className={cx(
                "mt-6 flex h-12 w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-r px-5 text-sm font-black text-black shadow-lg transition hover:brightness-110 active:scale-[0.99] disabled:cursor-not-allowed disabled:grayscale disabled:opacity-30",
                activeTool.accent,
              )}
            >
              {working ? <LoaderCircle size={17} className="animate-spin" /> : activeTool.id === "assistant" ? <Send size={16} /> : <Play size={16} fill="currentColor" />}
              {working ? "Working…" : activeTool.id === "assistant" ? "Ask Anthropic" : `Generate ${activeTool.label}`}
            </button>

            <div className="mt-5 flex items-center justify-center gap-2 text-[10px] text-white/22">
              <LockKeyhole size={11} /> Provider keys never enter the browser
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
