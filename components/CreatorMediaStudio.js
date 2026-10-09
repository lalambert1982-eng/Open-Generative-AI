'use client';

import { useState } from 'react';
import ReplicateStudio from './ReplicateStudio';

const PROVIDERS = [
  { id: 'replicate', label: 'Replicate' },
  { id: 'muapi', label: 'MuAPI' },
];

export default function CreatorMediaStudio({ kind, workspaceLabel, project, assets, onJobSettled, onAuthLost, muapiWorkspace }) {
  const [provider, setProvider] = useState('replicate');
  const [busy, setBusy] = useState(false);

  return (
    <div className="flex h-full flex-col bg-[#050506]">
      <div className="flex shrink-0 items-center gap-3 border-b border-white/[0.06] px-5 py-3 sm:px-8">
        <span className="text-[11px] font-black uppercase tracking-[0.2em] text-white/35">{workspaceLabel} provider</span>
        <div role="radiogroup" aria-label={`${workspaceLabel} provider`} className="flex gap-1 rounded-xl border border-white/[0.08] p-1">
          {PROVIDERS.map((item) => (
            <button key={item.id} type="button" role="radio" aria-checked={provider === item.id}
              disabled={busy && provider !== item.id}
              onClick={() => setProvider(item.id)}
              className={`rounded-lg px-3 py-1.5 text-xs font-bold disabled:cursor-not-allowed disabled:opacity-30 ${provider === item.id ? 'bg-cyan-300 text-black' : 'text-white/55 hover:text-white'}`}>
              {item.label}
            </button>
          ))}
        </div>
        {busy && <span className="text-[11px] text-white/35">Provider locked while a generation is active.</span>}
      </div>
      <div className="min-h-0 flex-1">
        {provider === 'replicate'
          ? <ReplicateStudio kind={kind} project={project} assets={assets} onJobSettled={onJobSettled} onAuthLost={onAuthLost} onBusyChange={setBusy} />
          : muapiWorkspace}
      </div>
    </div>
  );
}
