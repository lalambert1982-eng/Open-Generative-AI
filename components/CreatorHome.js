'use client';

import { useEffect, useState } from 'react';
import { ArrowRight, Bot, Film, Image, LayoutGrid, Megaphone, Music2, Sparkles, UserRound } from 'lucide-react';
import { createReplicateApi } from '@/src/lib/replicateStudioClient.js';

const ACTIONS = [
  { label: 'AI Generator', path: '/studio/apps/generator', icon: Sparkles, copy: 'Create an image or video without choosing a provider.' },
  { label: 'AI Influencer', path: '/studio/apps/influencer', icon: UserRound, copy: 'Build reusable influencer visuals.' },
  { label: 'Music Video', path: '/studio/apps/music-video', icon: Music2, copy: 'Plan connected scenes for a music-led visual.' },
  { label: 'Scene Builder', path: '/studio/apps/scene-builder', icon: Film, copy: 'Create a connected visual storyboard.' },
  { label: 'Image', path: '/studio/tools/image', icon: Image, copy: 'Generate a secure image asset.' },
  { label: 'Video', path: '/studio/tools/video', icon: Film, copy: 'Generate from text or animate a first frame.' },
  { label: 'Graphic Design', path: '/studio/apps/graphic-studio', icon: LayoutGrid, copy: 'Open the consolidated graphics workspace.' },
  { label: 'Social Campaign', path: '/studio/apps/marketing', icon: Megaphone, copy: 'Prepare campaign creative and copy.' },
];

export default function CreatorHome({ onNavigate, onAskSelena, recentAssets = [] }) {
  const [prompt, setPrompt] = useState('');
  const [models, setModels] = useState([]);
  useEffect(() => {
    let active = true;
    createReplicateApi().models()
      .then((value) => { if (active) setModels((value.models || []).filter((item) => item.enabled !== false).slice(0, 4)); })
      .catch(() => {});
    return () => { active = false; };
  }, []);
  const recent = recentAssets.filter((asset) => asset?.url && ['image', 'video', 'graphic'].includes(asset.type)).slice(0, 4);

  const submit = (event) => {
    event.preventDefault();
    const value = prompt.trim();
    if (!value) return;
    onAskSelena?.(value);
  };

  return (
    <div className="h-full overflow-y-auto bg-[#050506] text-white">
      <div className="mx-auto flex min-h-full max-w-6xl flex-col justify-center px-5 py-12 sm:px-8 lg:px-12">
        <div className="mx-auto w-full max-w-4xl text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl border border-cyan-300/20 bg-cyan-300/[0.08] text-cyan-200">
            <Bot size={25} />
          </div>
          <p className="mt-6 text-[11px] font-black uppercase tracking-[0.26em] text-cyan-300/70">Selena · G.FURY Creator Studio</p>
          <h1 className="mt-4 text-3xl font-semibold tracking-[-0.04em] sm:text-5xl">What do you want to create?</h1>
          <p className="mx-auto mt-4 max-w-2xl text-sm leading-6 text-white/38">Start with the outcome. Selena can plan the work and route it to the right Studio capability.</p>

          <form onSubmit={submit} className="mx-auto mt-8 flex max-w-3xl items-end gap-3 rounded-[24px] border border-white/[0.1] bg-white/[0.045] p-3 shadow-[0_28px_80px_rgba(0,0,0,.35)] focus-within:border-cyan-300/30">
            <textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              rows={3}
              placeholder="Create a five-scene music video, an Instagram graphic, or a campaign workflow…"
              className="min-h-[74px] flex-1 resize-none bg-transparent px-3 py-2 text-sm leading-6 text-white outline-none placeholder:text-white/22"
            />
            <button type="submit" disabled={!prompt.trim()} aria-label="Ask Selena" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-cyan-300 text-black transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-25">
              <ArrowRight size={18} />
            </button>
          </form>
        </div>

        <div className="mt-12 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {ACTIONS.map(({ label, path, icon: Icon, copy }) => (
            <button key={label} type="button" onClick={() => onNavigate?.(path)} className="group min-h-36 rounded-2xl border border-white/[0.07] bg-white/[0.025] p-5 text-left transition hover:-translate-y-0.5 hover:border-cyan-300/20 hover:bg-white/[0.05]">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-white/[0.08] bg-black/30 text-white/55 transition group-hover:text-cyan-200"><Icon size={18} /></div>
              <h2 className="mt-5 text-sm font-semibold">{label}</h2>
              <p className="mt-2 text-[11px] leading-5 text-white/30">{copy}</p>
            </button>
          ))}
        </div>
        {recent.length > 0 && (
          <section aria-label="Recent in this Project" className="mt-10">
            <h2 className="text-[11px] font-black uppercase tracking-[0.22em] text-white/35">Recent in this Project</h2>
            <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {recent.map((asset) => (
                <a key={asset.id} href={asset.url} target="_blank" rel="noreferrer" className="overflow-hidden rounded-2xl border border-white/[0.07] bg-white/[0.025]">
                  <div className="aspect-video bg-black">
                    {asset.type === 'video'
                      ? <video src={asset.url} muted preload="metadata" className="h-full w-full object-cover" />
                      // eslint-disable-next-line @next/next/no-img-element
                      : <img src={asset.url} alt={asset.title || 'Project Asset'} className="h-full w-full object-cover" />}
                  </div>
                  <p className="truncate p-3 text-xs font-semibold">{asset.title || asset.id}</p>
                </a>
              ))}
            </div>
          </section>
        )}
        {models.length > 0 && (
          <section aria-label="Featured models" className="mt-10">
            <h2 className="text-[11px] font-black uppercase tracking-[0.22em] text-white/35">Featured models</h2>
            <div className="mt-3 flex flex-wrap gap-2">
              {models.map((item) => (
                <button key={item.id} type="button" onClick={() => onNavigate?.(item.kind === 'video' ? '/studio/tools/video' : '/studio/tools/image')}
                  className="rounded-full border border-white/[0.1] px-4 py-2 text-xs font-bold text-white/70 hover:text-white">
                  {item.label}
                </button>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
