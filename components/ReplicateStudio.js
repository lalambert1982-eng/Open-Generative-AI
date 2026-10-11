'use client';

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { AlertTriangle, CheckCircle2, Download, Loader2 } from 'lucide-react';
import { createReplicateApi, createReplicateController, fetchSessionUserId } from '@/src/lib/replicateStudioClient.js';
import { createBrowserResume, clearReplicateResume } from '@/src/lib/replicateResume.js';
import { createBrowserUncertainty, clearReplicateUncertainty } from '@/src/lib/replicateUncertainty.js';
import { assetChoices, fieldLabel } from '@/src/lib/replicateStudioForm.js';
import { deriveView } from '@/src/lib/replicateStudioView.js';

const BADGE_CLASS = {
  mock: 'border-emerald-300/25 bg-emerald-300/[0.08] text-emerald-100',
  live: 'border-amber-300/30 bg-amber-300/[0.1] text-amber-100',
  setup: 'border-red-300/25 bg-red-300/[0.08] text-red-100',
};
const BANNER_CLASS = {
  error: 'border-red-300/25 bg-red-300/[0.07] text-red-100',
  warn: 'border-amber-300/25 bg-amber-300/[0.07] text-amber-100',
  info: 'border-white/15 bg-white/[0.04] text-white/70',
  ok: 'border-emerald-300/25 bg-emerald-300/[0.07] text-emerald-100',
};
const inputClass = 'w-full rounded-xl border border-white/[0.1] bg-black/30 px-3 py-2.5 text-sm text-white outline-none focus:border-cyan-300/40 disabled:opacity-40';

function Field({ name, spec, value, error, disabled, choices, onChange }) {
  const id = `replicate-${name}`;
  const label = <label htmlFor={id} className="mb-1.5 block text-[11px] font-bold uppercase tracking-wider text-white/45">{fieldLabel(name)}{spec.required ? ' *' : ''}</label>;
  const message = error ? <p id={`${id}-error`} className="mt-1 text-xs text-red-200">{error}</p> : null;
  const describedBy = error ? `${id}-error` : undefined;

  if (spec.type === 'string') {
    return (
      <div>{label}
        <textarea id={id} rows={4} maxLength={spec.max} value={value ?? ''} disabled={disabled} aria-invalid={Boolean(error)} aria-describedby={describedBy}
          onChange={(event) => onChange(event.target.value)} className={`${inputClass} resize-y`} />
        <p className="mt-1 text-right text-[10px] text-white/25">{(value ?? '').length}/{spec.max}</p>{message}
      </div>
    );
  }
  if (spec.type === 'enum') {
    return (
      <div>{label}
        <select id={id} value={String(value ?? '')} disabled={disabled} onChange={(event) => onChange(spec.values.find((item) => String(item) === event.target.value))} className={inputClass}>
          {spec.values.map((item) => <option key={String(item)} value={String(item)}>{String(item)}</option>)}
        </select>{message}
      </div>
    );
  }
  if (spec.type === 'integer') {
    return (
      <div>{label}
        <input id={id} type="number" min={spec.min} max={spec.max} step={1} value={value ?? ''} disabled={disabled} aria-invalid={Boolean(error)} aria-describedby={describedBy}
          onChange={(event) => onChange(event.target.value)} className={inputClass} />{message}
      </div>
    );
  }
  if (spec.type === 'boolean') {
    return (
      <div className="flex items-center gap-3">
        <input id={id} type="checkbox" checked={Boolean(value)} disabled={disabled} onChange={(event) => onChange(event.target.checked)} className="h-4 w-4" />
        <label htmlFor={id} className="text-sm text-white/70">{fieldLabel(name)}</label>
      </div>
    );
  }
  if (spec.type === 'url') {
    return (
      <div>{label}
        <select id={id} value={value ?? ''} disabled={disabled} aria-invalid={Boolean(error)} aria-describedby={describedBy} onChange={(event) => onChange(event.target.value)} className={inputClass}>
          <option value="">{spec.required ? 'Select a Project image…' : 'None'}</option>
          {choices.map((choice) => <option key={choice.id} value={choice.url}>{choice.title}</option>)}
        </select>
        {choices.length === 0 && <p className="mt-1 text-xs text-white/35">This Project has no image Assets yet. Upload one in Assets.</p>}{message}
      </div>
    );
  }
  if (spec.type === 'urlArray') {
    const selected = Array.isArray(value) ? value : [];
    return (
      <fieldset disabled={disabled}>
        <legend className="mb-1.5 text-[11px] font-bold uppercase tracking-wider text-white/45">{fieldLabel(name)} (up to {spec.max})</legend>
        <div className="max-h-40 space-y-1 overflow-y-auto rounded-xl border border-white/[0.08] p-2">
          {choices.length === 0 && <p className="text-xs text-white/35">No image Assets in this Project.</p>}
          {choices.map((choice) => (
            <label key={choice.id} className="flex items-center gap-2 text-xs text-white/70">
              <input type="checkbox" checked={selected.includes(choice.url)}
                onChange={(event) => onChange(event.target.checked ? [...selected, choice.url] : selected.filter((item) => item !== choice.url))} />
              {choice.title}
            </label>
          ))}
        </div>{message}
      </fieldset>
    );
  }
  return null;
}

export default function ReplicateStudio({ kind, project, assets = [], onJobSettled, onAuthLost, onBusyChange }) {
  const [controller, setController] = useState(null);
  const [sessionError, setSessionError] = useState('');
  const callbacks = useRef({});
  callbacks.current = { onJobSettled, onAuthLost };

  useEffect(() => {
    let cancelled = false;
    let next = null;
    setController(null);
    setSessionError('');
    (async () => {
      const userId = await fetchSessionUserId();
      if (cancelled) return;
      if (userId === null) {
        setSessionError('Could not verify your session. Reload to check again before generating.');
        return;
      }
      if (!userId) {
        clearReplicateResume();
        clearReplicateUncertainty();
        setSessionError('Sign in again before generating.');
        callbacks.current.onAuthLost?.();
        return;
      }
      next = createReplicateController({
        api: createReplicateApi(),
        kind,
        resume: userId ? createBrowserResume(kind) : null,
        uncertainty: userId ? createBrowserUncertainty(kind) : null,
        userId,
        onJobSettled: (event) => callbacks.current.onJobSettled?.(event),
        onAuthLost: () => callbacks.current.onAuthLost?.(),
      });
      setController(next);
      next.load();
    })();
    return () => { cancelled = true; next?.teardown(); };
  }, [kind]);

  const subscribe = useCallback((listener) => (controller ? controller.subscribe(listener) : () => {}), [controller]);
  const getSnapshot = useCallback(() => (controller ? controller.getState() : null), [controller]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, () => null);
  const state = controller?.getState().kind === kind ? snapshot : null;

  useEffect(() => { controller?.setProject(project?.id || ''); }, [controller, project?.id]);

  const view = state ? deriveView(state) : null;
  useEffect(() => { onBusyChange?.(Boolean(view?.locked)); }, [view?.locked, onBusyChange]);

  if (sessionError) return <div role="alert" className="p-8 text-sm text-red-200">{sessionError}</div>;
  if (!state || !view) return <div className="p-8 text-sm text-white/40">Loading Replicate models…</div>;

  const model = state.models.find((item) => item.id === state.modelId);
  const choices = assetChoices(assets);
  const editable = !view.locked;
  const originalProject = Boolean(state.jobProjectId && state.jobProjectId !== project?.id
    && (state.phase === 'running' || state.phase === 'uncertain' || view.result));
  const onPrimary = () => (view.primary.action === 'confirm' ? controller.confirm() : controller.generate());

  return (
    <div className="h-full overflow-y-auto bg-[#050506] px-5 py-8 text-white sm:px-8">
      <div className="mx-auto grid max-w-6xl gap-8 lg:grid-cols-[minmax(0,26rem)_1fr]">
        <section aria-label="Generation settings" className="space-y-5">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight">{kind === 'video' ? 'Video' : 'Image'} · Replicate</h1>
            <span className={`rounded-full border px-3 py-1 text-[11px] font-bold ${BADGE_CLASS[view.badge.tone]}`}>{view.badge.text}</span>
          </div>
          <p className="text-xs text-white/35">{originalProject ? 'This generation belongs to its original Project.' : project ? <>Results are saved to <strong className="text-white/60">{project.name}</strong>.</> : 'Open a Project to save results.'}</p>

          {state.models.length > 0 && (
            <div>
              <label htmlFor="replicate-model" className="mb-1.5 block text-[11px] font-bold uppercase tracking-wider text-white/45">Model</label>
              <select id="replicate-model" value={state.modelId} disabled={!editable} onChange={(event) => controller.selectModel(event.target.value)} className={inputClass}>
                {state.models.map((item) => <option key={item.id} value={item.id}>{item.label} — {item.pricing?.display}</option>)}
              </select>
            </div>
          )}

          {model && Object.entries(model.inputs).map(([name, spec]) => (
            <Field key={`${model.id}:${name}`} name={name} spec={spec} value={state.values[name]} error={state.fieldErrors[name]}
              disabled={!editable} choices={choices} onChange={(value) => controller.setValue(name, value)} />
          ))}

          {view.price && (
            <div className="rounded-xl border border-white/[0.1] bg-white/[0.03] px-4 py-3 text-sm">
              <p className="font-semibold">Estimated price: {view.price.text}</p>
              <p className="mt-1 text-xs text-white/35">Estimate only, not billing truth. Quote expires {new Date(view.price.expiresAt).toLocaleTimeString()}.</p>
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={onPrimary} disabled={!view.primary.enabled}
              className="rounded-xl bg-cyan-300 px-5 py-3 text-sm font-black text-black disabled:cursor-not-allowed disabled:opacity-30">
              {view.primary.label}
            </button>
            {view.showCancel && <button type="button" onClick={() => controller.cancel()} className="rounded-xl border border-white/[0.15] px-4 py-3 text-sm font-bold">Cancel</button>}
            {view.showCheckStatus && <button type="button" onClick={() => controller.checkStatus()} className="rounded-xl border border-white/[0.15] px-4 py-3 text-sm font-bold">Check status</button>}
            {view.showAcknowledge && <button type="button" onClick={() => controller.acknowledge()} className="rounded-xl border border-amber-300/40 px-4 py-3 text-sm font-bold text-amber-100">I understand</button>}
          </div>
          {view.disabledReason && !view.primary.enabled && <p className="text-xs text-white/35">{view.disabledReason}</p>}
        </section>

        <section aria-label="Result" className="space-y-4">
          <div aria-live="polite" className="min-h-[1.5rem] text-sm text-white/60">
            {view.progressText && <span className="inline-flex items-center gap-2"><Loader2 size={14} className="animate-spin" />{view.progressText}</span>}
          </div>
          {view.banners.map((banner, index) => (
            <div key={`${banner.tone}-${index}`} role={banner.tone === 'error' || banner.tone === 'warn' ? 'alert' : 'status'}
              className={`flex gap-3 rounded-2xl border px-4 py-3 text-sm ${BANNER_CLASS[banner.tone]}`}>
              <AlertTriangle size={16} className="mt-0.5 shrink-0" /><p>{banner.text}</p>
            </div>
          ))}
          {view.result && (
            <figure className="overflow-hidden rounded-2xl border border-white/[0.08] bg-black">
              {view.result.kind === 'video'
                ? <video src={view.result.url} controls className="w-full" />
                // eslint-disable-next-line @next/next/no-img-element
                : <img src={view.result.url} alt={view.result.alt} className="w-full object-contain" />}
              <figcaption className="space-y-2 p-4 text-xs text-white/50">
                {view.result.mockPlaceholder && <p className="font-semibold text-emerald-200">Mock placeholder — nothing was generated or charged.</p>}
                <p className="flex items-center gap-2 text-emerald-100"><CheckCircle2 size={14} /> Saved to Project · Asset {view.result.assetId}</p>
                <a href={view.result.url} download target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 rounded-lg border border-white/[0.15] px-3 py-2 font-bold text-white/80">
                  <Download size={13} /> Download
                </a>
              </figcaption>
            </figure>
          )}
        </section>
      </div>
    </div>
  );
}
