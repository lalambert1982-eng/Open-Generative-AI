'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
  AgentStudio, AiInfluencerStudio, AppsStudio, AudioStudio, CinemaStudio,
  ClippingStudio, CreatorStudio, GraphicStudio, LipSyncStudio, MarketingStudio,
  RecastStudio, SocialPublishStudio, VibeMotionStudio, VideoStudio, WorkflowStudio, getUserBalance,
} from 'studio';
import {
  Blocks, Bot, Boxes, ChevronDown, Clapperboard, Film, FolderOpen, Home, Image,
  LayoutGrid, Menu, Mic2, Music2, PanelLeftClose, PanelLeftOpen, Send, Settings2, Share2,
  Sparkles, UserRound, WandSparkles, Workflow, X, Zap,
} from 'lucide-react';
import CreatorHome from './CreatorHome';
import LegacyProviderSettings from './LegacyProviderSettings';
import StudioAssets from './StudioAssets';
import { resolveStudioDestination, studioDestination } from '@/src/lib/studioNavigation.js';

const STORAGE_KEY = 'muapi_key';
const ASSET_STORAGE_KEY = 'gfury_creator_assets_v1';
const NAV_GROUPS = [
  { label: '', items: ['home'] },
  { label: 'Agent', items: ['selena'] },
  { label: 'Tools', items: ['image', 'video', 'audio', 'graphics', 'avatar', 'music', 'video-advanced', 'lipsync', 'motion', 'transform', 'smart-clip'] },
  { label: 'Apps', items: ['generator', 'influencer', 'graphic-studio', 'scene-builder', 'music-video', 'marketing', 'edit-studio'] },
  { label: '', items: ['workflows', 'assets', 'publish'] },
  { label: 'Advanced', items: ['agent-blueprints', 'marketplace', 'provider-settings'] },
];
const ICONS = {
  home: Home, selena: Bot, image: Image, video: Film, audio: Mic2, graphics: LayoutGrid,
  avatar: UserRound, music: Mic2, 'video-advanced': Film,
  lipsync: Mic2, motion: Zap, transform: Sparkles, 'smart-clip': Clapperboard,
  generator: WandSparkles, influencer: UserRound, 'graphic-studio': LayoutGrid,
  'scene-builder': Boxes, 'music-video': Music2, marketing: Send, 'edit-studio': Clapperboard,
  workflows: Workflow, assets: FolderOpen, publish: Share2, 'agent-blueprints': Blocks,
  marketplace: Boxes, 'provider-settings': Settings2,
};
const LEGACY_DESTINATIONS = new Set([
  'music', 'video-advanced', 'lipsync', 'motion', 'transform', 'smart-clip', 'influencer',
  'marketing', 'edit-studio', 'workflows', 'agent-blueprints', 'marketplace',
]);

function loadAssets() {
  if (typeof window === 'undefined') return [];
  try {
    const value = JSON.parse(window.sessionStorage.getItem(ASSET_STORAGE_KEY) || '[]');
    return Array.isArray(value) ? value.filter((asset) => asset?.url?.startsWith('https://')).slice(0, 100) : [];
  } catch { return []; }
}

function inferAssetType(value, source) {
  if (['image', 'video', 'audio'].includes(value?.type)) return value.type;
  if (['video', 'lipsync', 'motion', 'transform', 'smart-clip', 'edit-studio', 'scene-builder'].includes(source)) return 'video';
  if (source === 'audio') return 'audio';
  return 'image';
}

export default function StandaloneShell() {
  const params = useParams();
  const router = useRouter();
  const slug = Array.isArray(params?.slug) ? params.slug : [];
  const destinationId = params?.id ? 'workflows' : resolveStudioDestination(slug);
  const destination = studioDestination(destinationId);

  const [apiKey, setApiKey] = useState(null);
  const [balance, setBalance] = useState(null);
  const [mounted, setMounted] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [openGroups, setOpenGroups] = useState(() => new Set(['Agent', 'Tools', 'Apps']));
  const [droppedFiles, setDroppedFiles] = useState(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isHeaderVisible, setIsHeaderVisible] = useState(true);
  const [selenaPrompt, setSelenaPrompt] = useState('');
  const [assets, setAssets] = useState([]);
  const [handoffAsset, setHandoffAsset] = useState(null);
  const [notifications, setNotifications] = useState([]);
  const [generationCounts, setGenerationCounts] = useState({});

  const navigate = useCallback((path) => {
    router.push(path, { scroll: false });
    setSidebarOpen(false);
  }, [router]);

  useEffect(() => {
    setMounted(true);
    setAssets(loadAssets());
    const legacy = window.localStorage.getItem(STORAGE_KEY);
    const stored = window.sessionStorage.getItem(STORAGE_KEY) || legacy;
    if (stored) {
      window.sessionStorage.setItem(STORAGE_KEY, stored);
      window.localStorage.removeItem(STORAGE_KEY);
      setApiKey(stored);
    }
    document.cookie = 'muapi_key=; path=/; max-age=0; SameSite=Lax';
  }, []);

  useEffect(() => {
    if (!apiKey) return;
    let active = true;
    getUserBalance(apiKey).then((data) => { if (active) setBalance(data.balance); }).catch(() => {});
    return () => { active = false; };
  }, [apiKey]);

  useEffect(() => {
    try { window.sessionStorage.setItem(ASSET_STORAGE_KEY, JSON.stringify(assets)); } catch {}
  }, [assets]);

  const saveKey = useCallback((key) => {
    window.sessionStorage.setItem(STORAGE_KEY, key);
    window.localStorage.removeItem(STORAGE_KEY);
    setApiKey(key);
  }, []);
  const clearKey = useCallback(() => {
    window.sessionStorage.removeItem(STORAGE_KEY);
    window.localStorage.removeItem(STORAGE_KEY);
    window.localStorage.removeItem('token');
    setApiKey(null); setBalance(null);
  }, []);

  const recordAsset = useCallback((source) => (value = {}) => {
    const url = typeof value.url === 'string' ? value.url : '';
    if (url.startsWith('https://')) {
      const asset = {
        id: window.crypto.randomUUID(), type: inferAssetType(value, source), url,
        title: value.title || `${studioDestination(source).label} output`, source,
        model: value.model || null, createdAt: new Date().toISOString(),
      };
      setAssets((previous) => [asset, ...previous.filter((item) => item.url !== asset.url)].slice(0, 100));
    }
    setNotifications((previous) => [
      { id: `${Date.now()}-${Math.random()}`, type: 'success', label: studioDestination(source).label, url: url || null },
      ...previous,
    ].slice(0, 3));
  }, []);
  const reportError = useCallback((source) => (value) => {
    const message = typeof value === 'string' ? value : value?.message || 'The request failed.';
    setNotifications((previous) => [
      { id: `${Date.now()}-${Math.random()}`, type: 'error', label: studioDestination(source).label, message },
      ...previous,
    ].slice(0, 3));
  }, []);
  const startGeneration = useCallback((source) => () => setGenerationCounts((previous) => ({ ...previous, [source]: (previous[source] || 0) + 1 })), []);
  const endGeneration = useCallback((source) => () => setGenerationCounts((previous) => ({ ...previous, [source]: Math.max(0, (previous[source] || 0) - 1) })), []);
  const callbacks = useCallback((source) => ({
    onGenerationStart: startGeneration(source), onGenerationEnd: endGeneration(source),
    onGenerationComplete: recordAsset(source), onGenerationError: reportError(source),
  }), [endGeneration, recordAsset, reportError, startGeneration]);

  const legacyShared = useMemo(() => ({
    apiKey, droppedFiles, onFilesHandled: () => setDroppedFiles(null), ...callbacks(destinationId),
  }), [apiKey, callbacks, destinationId, droppedFiles]);
  const openAsset = useCallback((asset, target) => {
    setHandoffAsset(asset);
    const targets = {
      'graphic-studio': '/studio/apps/graphic-studio',
      'scene-builder': '/studio/apps/scene-builder',
      'lipsync': '/studio/tools/lip-sync',
      'publish': '/studio/publish',
    };
    navigate(targets[target] || '/studio/assets');
  }, [navigate]);

  const renderDestination = () => {
    switch (destinationId) {
      case 'home': return <CreatorHome onNavigate={navigate} onAskSelena={(prompt) => { setSelenaPrompt(prompt); navigate('/studio/selena'); }} />;
      case 'selena': return <CreatorStudio {...callbacks('selena')} initialToolId="assistant" allowedToolIds={['assistant']} initialPrompt={selenaPrompt} workspaceLabel="Selena" />;
      case 'image': return <CreatorStudio {...callbacks('image')} initialToolId="image" allowedToolIds={['image']} workspaceLabel="Image" />;
      case 'video': return <CreatorStudio {...callbacks('video')} initialToolId="video" allowedToolIds={['video']} initialAsset={handoffAsset} workspaceLabel="Video" />;
      case 'audio': return <CreatorStudio {...callbacks('audio')} initialToolId="voice" allowedToolIds={['voice']} workspaceLabel="Audio & Voice" />;
      case 'avatar': return <CreatorStudio {...callbacks('avatar')} initialToolId="avatar" allowedToolIds={['avatar']} workspaceLabel="Avatar" />;
      case 'music': return <AudioStudio {...legacyShared} />;
      case 'video-advanced': return slug.includes('cinema') ? <CinemaStudio {...legacyShared} /> : <VideoStudio {...legacyShared} />;
      case 'generator': return <CreatorStudio {...callbacks('generator')} initialToolId="image" allowedToolIds={['image', 'video']} initialAsset={handoffAsset} workspaceLabel="AI Generator" />;
      case 'scene-builder': return <CreatorStudio {...callbacks('scene-builder')} initialToolId="storyboard" allowedToolIds={['storyboard']} initialAsset={handoffAsset} workspaceLabel="Scene Builder" />;
      case 'music-video': return <CreatorStudio {...callbacks('music-video')} initialToolId="storyboard" allowedToolIds={['storyboard']} initialAsset={handoffAsset} workspaceLabel="Music Video" />;
      case 'publish': return <SocialPublishStudio initialAsset={handoffAsset} youtubeWorkspace={<CreatorStudio {...callbacks('publish')} initialToolId="publish" allowedToolIds={['publish']} workspaceLabel="YouTube Publish" />} />;
      case 'assets': return <StudioAssets assets={assets} onOpen={openAsset} onDelete={(id) => setAssets((previous) => previous.filter((asset) => asset.id !== id))} />;
      case 'graphics':
      case 'graphic-studio': return <GraphicStudio {...legacyShared} initialAsset={handoffAsset} isHeaderVisible={isHeaderVisible} onToggleHeader={setIsHeaderVisible} />;
      case 'lipsync': return <LipSyncStudio {...legacyShared} initialAsset={handoffAsset} />;
      case 'motion': return <VibeMotionStudio {...legacyShared} />;
      case 'transform': return <RecastStudio {...legacyShared} />;
      case 'smart-clip':
      case 'edit-studio': return <ClippingStudio {...legacyShared} />;
      case 'influencer': return <AiInfluencerStudio {...legacyShared} />;
      case 'marketing': return <MarketingStudio {...legacyShared} />;
      case 'workflows': return <WorkflowStudio {...legacyShared} isHeaderVisible={isHeaderVisible} onToggleHeader={setIsHeaderVisible} />;
      case 'agent-blueprints': return <AgentStudio apiKey={apiKey} basePath="/studio/advanced/agents" />;
      case 'marketplace': return <AppsStudio apiKey={apiKey} />;
      case 'provider-settings': return <LegacyProviderSettings apiKey={apiKey} onSave={saveKey} onClear={clearKey} />;
      default: return <CreatorHome onNavigate={navigate} />;
    }
  };

  if (!mounted) return <div className="flex h-screen items-center justify-center bg-[#050506] text-cyan-200"><Sparkles className="animate-pulse" /></div>;
  return (
    <div className="flex h-screen flex-col overflow-hidden bg-[#050506] text-white"
      onDragOver={(event) => event.preventDefault()}
      onDragEnter={(event) => { if (event.dataTransfer?.types?.includes('Files')) setIsDragging(true); }}
      onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setIsDragging(false); }}
      onDrop={(event) => { event.preventDefault(); setIsDragging(false); setDroppedFiles(Array.from(event.dataTransfer.files || [])); }}>
      {isHeaderVisible && (
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-white/[0.07] bg-[#09090b] px-3 sm:px-4">
          <div className="flex items-center gap-3">
            <button type="button" onClick={() => setSidebarOpen(true)} className="rounded-lg p-2 text-white/50 hover:bg-white/[0.06] md:hidden" aria-label="Open navigation"><Menu size={18} /></button>
            <button type="button" onClick={() => setSidebarCollapsed((value) => !value)} className="hidden rounded-lg p-2 text-white/45 hover:bg-white/[0.06] md:block" aria-label="Toggle sidebar">{sidebarCollapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}</button>
            <button type="button" onClick={() => navigate('/studio/home')} className="flex items-center gap-2.5">
              <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-cyan-300 text-black"><Sparkles size={17} /></span>
              <span className="hidden text-sm font-black tracking-tight sm:inline">G.FURY CREATOR</span>
            </button>
          </div>
          <div className="flex items-center gap-3">
            <span className="hidden text-[10px] font-bold uppercase tracking-wider text-white/25 sm:inline">{destination.label}</span>
            {apiKey && <span className="rounded-full border border-white/[0.08] bg-white/[0.04] px-2.5 py-1 text-[10px] text-white/35">Legacy ${balance ?? '—'}</span>}
          </div>
        </header>
      )}

      <div className="flex min-h-0 flex-1">
        {isHeaderVisible && sidebarOpen && <button type="button" className="fixed inset-0 z-40 bg-black/70 md:hidden" onClick={() => setSidebarOpen(false)} aria-label="Close navigation overlay" />}
        {isHeaderVisible && (
          <aside className={`fixed bottom-0 left-0 top-0 z-50 flex flex-col border-r border-white/[0.07] bg-[#09090b] transition-transform md:static md:z-auto ${sidebarOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'} ${sidebarCollapsed ? 'w-64 md:w-[72px]' : 'w-64 md:w-60'}`}>
            <div className="flex h-14 items-center justify-between border-b border-white/[0.07] px-4 md:hidden"><span className="text-xs font-black">G.FURY CREATOR</span><button type="button" onClick={() => setSidebarOpen(false)}><X size={18} /></button></div>
            <nav aria-label="Creator Studio" className="flex-1 overflow-y-auto px-2 py-3">
              {NAV_GROUPS.map((group, index) => {
                const open = !group.label || openGroups.has(group.label) || sidebarCollapsed;
                return (
                  <div key={`${group.label}-${index}`} className={index ? 'mt-3 border-t border-white/[0.05] pt-3' : ''}>
                    {group.label && !sidebarCollapsed && <button type="button" onClick={() => setOpenGroups((previous) => { const next = new Set(previous); next.has(group.label) ? next.delete(group.label) : next.add(group.label); return next; })} className="mb-1 flex w-full items-center justify-between px-3 py-1 text-[9px] font-black uppercase tracking-[0.18em] text-white/22">{group.label}<ChevronDown size={12} className={open ? 'rotate-180' : ''} /></button>}
                    {open && <div className="space-y-0.5">{group.items.map((id) => {
                      const item = studioDestination(id); const Icon = ICONS[id] || Blocks;
                      const active = destinationId === id || (id === 'graphic-studio' && destinationId === 'graphics');
                      return <button key={id} type="button" onClick={() => navigate(item.path)} title={sidebarCollapsed ? item.label : undefined} className={`flex w-full items-center rounded-xl text-left transition ${sidebarCollapsed ? 'h-11 justify-center px-0' : 'gap-3 px-3 py-2.5'} ${active ? 'bg-cyan-300/[0.11] text-cyan-200' : 'text-white/43 hover:bg-white/[0.045] hover:text-white'}`}><Icon size={17} className="shrink-0" />{!sidebarCollapsed && <span className={`truncate text-[12px] ${['lipsync','motion','transform','smart-clip'].includes(id) ? 'pl-1 text-[11px]' : 'font-semibold'}`}>{item.label}</span>}</button>;
                    })}</div>}
                  </div>
                );
              })}
            </nav>
          </aside>
        )}
        <main className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
          {!apiKey && LEGACY_DESTINATIONS.has(destinationId) && destinationId !== 'provider-settings'
            ? <LegacyProviderSettings apiKey={apiKey} onSave={saveKey} onClear={clearKey} requiredFor={destination.label} />
            : renderDestination()}
          {isDragging && <div className="pointer-events-none absolute inset-4 z-50 flex items-center justify-center rounded-3xl border-2 border-dashed border-cyan-300/40 bg-cyan-300/[0.08] backdrop-blur"><p className="text-sm font-bold text-cyan-100">Drop media into the active tool</p></div>}
        </main>
      </div>

      {(Object.values(generationCounts).some(Boolean) || notifications.length > 0) && <div aria-live="polite" className="fixed right-4 top-16 z-[100] w-[330px] max-w-[calc(100vw-32px)] space-y-2">
        {Object.entries(generationCounts).filter(([, count]) => count > 0).map(([id]) => <div key={id} className="rounded-xl border border-cyan-300/20 bg-[#101014] px-4 py-3 text-xs font-semibold shadow-2xl">{studioDestination(id).label} is working…</div>)}
        {notifications.map((item) => <div key={item.id} role={item.type === 'error' ? 'alert' : 'status'} className={`rounded-xl border bg-[#101014] px-4 py-3 text-xs shadow-2xl ${item.type === 'error' ? 'border-red-300/20 text-red-200' : 'border-emerald-300/20 text-emerald-100'}`}><div className="flex justify-between gap-3"><span><strong>{item.label}</strong>{item.type === 'error' ? ` · ${item.message}` : ' · Complete'}</span><button type="button" onClick={() => setNotifications((previous) => previous.filter((value) => value.id !== item.id))}>×</button></div>{item.url && <a href={item.url} target="_blank" rel="noreferrer" className="mt-2 inline-block text-[10px] font-bold text-cyan-200">Open asset →</a>}</div>)}
      </div>}
    </div>
  );
}
