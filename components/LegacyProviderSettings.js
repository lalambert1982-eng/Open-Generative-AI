'use client';

import { ShieldCheck } from 'lucide-react';

export default function LegacyProviderSettings() {
  return (
    <div className="h-full overflow-y-auto bg-[#050506] px-5 py-10 text-white sm:px-8">
      <div className="mx-auto max-w-3xl">
        <p className="text-[10px] font-black uppercase tracking-[0.22em] text-cyan-300/70">Advanced</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">Provider settings</h1>
        <div className="mt-8 rounded-3xl border border-white/[0.08] bg-white/[0.025] p-6">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-cyan-100"><ShieldCheck size={18} /> Server-managed providers</h2>
          <p className="mt-3 text-sm leading-6 text-white/38">MuAPI credentials are configured on the server. Creator tools report provider availability when you use them. Provider keys never enter the browser.</p>
        </div>
      </div>
    </div>
  );
}
