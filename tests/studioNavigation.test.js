import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveStudioDestination, studioDestination, STUDIO_NAVIGATION } from '../src/lib/studioNavigation.js';

const retained = ['home', 'selena', 'image', 'video', 'audio', 'avatar', 'generator', 'scene-builder', 'music-video', 'workflow-run', 'agent-team', 'projects', 'assets', 'publish', 'provider-settings'];

test('Creator Studio routes resolve every retained destination and core alias', () => {
    assert.equal(resolveStudioDestination([]), 'home');
    for (const destination of STUDIO_NAVIGATION) {
        assert.equal(resolveStudioDestination(destination.path.slice('/studio/'.length).split('/')), destination.id);
        assert.equal(studioDestination(destination.id), destination);
    }
    for (const [alias, id] of [['creator', 'selena'], ['storyboard', 'scene-builder'], ['image', 'image'], ['video', 'video'], ['audio', 'audio'], ['music-video', 'music-video']]) {
        assert.equal(resolveStudioDestination([alias]), id);
    }
});

test('removed studio destinations and unknown paths fall back to Home', () => {
    for (const path of ['advanced/agents/create', 'advanced/marketplace', 'agents', 'design-agent', 'cinema', 'layers', 'apps/influencer', 'apps/graphic-studio', 'apps/marketing', 'apps/edit-studio', 'tools/graphics', 'tools/lip-sync', 'tools/music', 'tools/video-advanced', 'tools/motion', 'tools/transform', 'tools/smart-clip', 'workflows', 'unknown']) {
        assert.equal(resolveStudioDestination(path.split('/')), 'home', path);
    }
    assert.equal(studioDestination('unknown').id, 'home');
});

test('navigation contains exactly one stable destination per retained working area', () => {
    const ids = STUDIO_NAVIGATION.map((item) => item.id);
    assert.equal(new Set(ids).size, ids.length);
    assert.deepEqual(ids, retained);
});
