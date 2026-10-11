export const STUDIO_NAVIGATION = Object.freeze([
    { id: 'home', label: 'Home', path: '/studio/home', section: 'primary' },
    { id: 'selena', label: 'Selena', path: '/studio/selena', section: 'agent' },
    { id: 'image', label: 'Image', path: '/studio/tools/image', section: 'tools' },
    { id: 'video', label: 'Video', path: '/studio/tools/video', section: 'tools' },
    { id: 'audio', label: 'Audio & Voice', path: '/studio/tools/audio', section: 'tools' },
    { id: 'avatar', label: 'Avatar', path: '/studio/tools/avatar', section: 'tools', secondary: true },
    { id: 'generator', label: 'AI Generator', path: '/studio/apps/generator', section: 'apps' },
    { id: 'scene-builder', label: 'Scene Builder', path: '/studio/apps/scene-builder', section: 'apps' },
    { id: 'music-video', label: 'Music Video', path: '/studio/apps/music-video', section: 'apps' },
    { id: 'workflow-run', label: 'Workflow Run', path: '/studio/apps/workflow-run', section: 'apps' },
    { id: 'agent-team', label: 'Agent Team', path: '/studio/apps/agent-team', section: 'apps' },
    { id: 'projects', label: 'Projects', path: '/studio/projects', section: 'primary' },
    { id: 'assets', label: 'Assets', path: '/studio/assets', section: 'primary' },
    { id: 'publish', label: 'Publish', path: '/studio/publish', section: 'primary' },
    { id: 'provider-settings', label: 'Provider Settings', path: '/studio/advanced/providers', section: 'advanced' },
]);

const ROUTE_ALIASES = Object.freeze({
    '': 'home', creator: 'selena', storyboard: 'scene-builder',
    image: 'image', video: 'video', audio: 'audio', 'music-video': 'music-video',
});

export function resolveStudioDestination(segments = []) {
    const parts = Array.isArray(segments) ? segments.filter(Boolean) : [];
    const path = `/studio/${parts.join('/')}`;
    return STUDIO_NAVIGATION.find((item) => item.path === path)?.id
        || ROUTE_ALIASES[parts[0] || ''] || 'home';
}

export function studioDestination(id) {
    return STUDIO_NAVIGATION.find((item) => item.id === id) || STUDIO_NAVIGATION[0];
}
