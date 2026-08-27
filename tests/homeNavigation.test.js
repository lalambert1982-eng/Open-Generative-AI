import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { HOME_QUICK_ACTIONS, resolveHomeIntent } from '../packages/studio/src/components/homeNavigationModel.js';

test('Home quick actions route to existing workspaces and preserve YouTube', () => {
  const byId = Object.fromEntries(HOME_QUICK_ACTIONS.map((action) => [action.id, action.tabId]));
  assert.equal(byId.image, 'creator');
  assert.equal(byId.video, 'creator');
  assert.equal(byId.storyboard, 'creator');
  assert.equal(byId.graphics, 'graphics');
  assert.equal(byId.youtube, 'youtube');
  assert.equal(byId['ai-influencer'], 'ai-influencer');
});

test('Selena Home intent routing is deterministic and does not call a provider', () => {
  assert.equal(resolveHomeIntent('Publish this finished video to YouTube'), 'youtube');
  assert.equal(resolveHomeIntent('Create narration in my voice'), 'voice');
  assert.equal(resolveHomeIntent('Make an avatar presenter'), 'avatar');
  assert.equal(resolveHomeIntent('Build a five-scene music video'), 'creator');
  assert.equal(resolveHomeIntent('Create a social campaign'), 'marketing');
  assert.equal(resolveHomeIntent('Design a track meet poster'), 'graphics');
  assert.equal(resolveHomeIntent('Help me think through an original concept'), 'agents');
});

test('Home and navigation client source contains no provider credentials', async () => {
  const files = [
    '../packages/studio/src/components/HomeStudio.jsx',
    '../packages/studio/src/components/homeNavigationModel.js',
  ];
  const source = (await Promise.all(files.map((file) => readFile(new URL(file, import.meta.url), 'utf8')))).join('\n');
  assert.doesNotMatch(source, /MUAPI_(?:API_KEY|PRODUCTION_API_KEY)|ELEVENLABS_API_KEY|HEYGEN_API_KEY|YOUTUBE_CLIENT_SECRET/);
  assert.doesNotMatch(source, /fetch\(|axios|authorization/i);
});
