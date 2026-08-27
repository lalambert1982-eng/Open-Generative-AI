"use client";

import React, { useState } from "react";
import {
  ArrowRight,
  Bot,
  Film,
  Image as ImageIcon,
  LayoutGrid,
  Megaphone,
  PanelsTopLeft,
  Palette,
  Play,
  Sparkles,
  UserRound,
} from "lucide-react";
import { HOME_QUICK_ACTIONS, resolveHomeIntent } from "./homeNavigationModel";

const ICONS = {
  "ai-generator": Sparkles,
  "ai-influencer": UserRound,
  "music-video": Film,
  image: ImageIcon,
  video: Film,
  storyboard: PanelsTopLeft,
  graphics: Palette,
  "social-campaign": Megaphone,
  youtube: Play,
};

export default function HomeStudio({ onNavigate }) {
  const [prompt, setPrompt] = useState("");

  const submit = (event) => {
    event.preventDefault();
    onNavigate?.(resolveHomeIntent(prompt));
  };

  return (
    <main className="h-full overflow-y-auto bg-[#0a0809] text-white">
      <div className="mx-auto flex min-h-full w-full max-w-7xl flex-col px-5 py-8 sm:px-8 lg:px-12 lg:py-12">
        <section className="relative overflow-hidden rounded-[32px] border border-[#f4bd50]/20 bg-[#171216] px-6 py-9 shadow-[0_30px_100px_rgba(0,0,0,0.55),0_0_80px_rgba(225,29,72,0.08)] sm:px-10 sm:py-12">
          <div className="pointer-events-none absolute -right-28 -top-32 h-80 w-80 rounded-full bg-[#e11d48]/25 blur-3xl" />
          <div className="pointer-events-none absolute -bottom-36 -left-20 h-80 w-80 rounded-full bg-[#f4bd50]/15 blur-3xl" />
          <div className="pointer-events-none absolute left-[42%] top-0 h-px w-72 bg-gradient-to-r from-transparent via-[#f4bd50]/70 to-transparent" />
          <div className="relative max-w-4xl">
            <div className="mb-5 flex items-center gap-2 text-[11px] font-black uppercase tracking-[0.24em] text-[#f4bd50]">
              <Bot size={16} /> Selena · Creator command center
            </div>
            <h1 className="max-w-3xl text-4xl font-semibold tracking-[-0.055em] sm:text-5xl lg:text-6xl">
              What do you want to create?
            </h1>
            <p className="mt-4 max-w-2xl text-sm leading-6 text-white/65 sm:text-base">
              Describe the outcome. Selena will route you to the best existing Creator Studio workspace without exposing provider keys or starting a paid generation.
            </p>
            <form onSubmit={submit} className="mt-8 flex flex-col gap-3 rounded-2xl border border-[#f4bd50]/20 bg-black/50 p-2 shadow-[0_16px_45px_rgba(0,0,0,0.28)] sm:flex-row">
              <label className="sr-only" htmlFor="selena-home-prompt">What do you want to create?</label>
              <input
                id="selena-home-prompt"
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                placeholder="Create a music video, campaign, storyboard, image, or YouTube package…"
                className="min-h-12 flex-1 bg-transparent px-4 text-sm text-white outline-none placeholder:text-white/40"
              />
              <button type="submit" className="flex min-h-12 items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-[#e11d48] to-[#f4bd50] px-5 text-sm font-black text-black shadow-[0_8px_30px_rgba(225,29,72,0.2)] transition hover:brightness-110">
                Start with Selena <ArrowRight size={16} />
              </button>
            </form>
          </div>
        </section>

        <section className="py-9">
          <div className="mb-5 flex items-end justify-between gap-4">
            <div>
              <p className="text-[10px] font-black uppercase tracking-[0.22em] text-[#f4bd50]/80">Quick actions</p>
              <h2 className="mt-1 text-xl font-semibold tracking-tight">Start from a working tool</h2>
            </div>
            <span className="hidden items-center gap-2 text-xs text-white/45 sm:flex"><LayoutGrid size={14} /> Existing tools, one workspace</span>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {HOME_QUICK_ACTIONS.map((action) => {
              const Icon = ICONS[action.id] || Sparkles;
              return (
                <button
                  key={action.id}
                  type="button"
                  onClick={() => onNavigate?.(action.tabId)}
                  className="group flex min-h-28 items-start gap-4 rounded-2xl border border-white/[0.12] bg-[#161216] p-4 text-left shadow-[0_10px_35px_rgba(0,0,0,0.22)] transition hover:-translate-y-0.5 hover:border-[#f4bd50]/35 hover:bg-[#20161b]"
                >
                  <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-[#f4bd50]/20 bg-gradient-to-br from-[#e11d48]/20 to-[#f4bd50]/10 text-[#f4bd50]"><Icon size={20} /></span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center justify-between gap-3 text-sm font-bold text-white">{action.label}<ArrowRight size={14} className="text-white/30 transition group-hover:translate-x-0.5 group-hover:text-[#f4bd50]" /></span>
                    <span className="mt-2 block text-xs leading-5 text-white/55">{action.description}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </section>

        <section className="mb-4 grid gap-3 rounded-2xl border border-[#f4bd50]/15 bg-[#141114] p-5 text-xs text-white/55 md:grid-cols-3">
          <div><strong className="block text-white/90">Create</strong><span className="mt-1 block leading-5">Storyboard, Image, Video, Voice, Avatar, Audio, and Graphics.</span></div>
          <div><strong className="block text-white/90">Connect</strong><span className="mt-1 block leading-5">YouTube remains owner-only and stages uploads privately for review.</span></div>
          <div><strong className="block text-white/90">Build next</strong><span className="mt-1 block leading-5">Persistent Projects, shared Assets, and final compositing remain later phases.</span></div>
        </section>
      </div>
    </main>
  );
}
