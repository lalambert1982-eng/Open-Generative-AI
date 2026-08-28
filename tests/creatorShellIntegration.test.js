import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('Selena remains on the secure Creator assistant route and does not use MuAPI Agent chat', async () => {
    const creator = await read('../packages/studio/src/components/CreatorStudio.jsx');
    assert.match(creator, /request\("assistant", \{ method: "POST"/);
    assert.match(creator, /fetch\(`\/api\/creator\/\$\{path\}`/);
    assert.doesNotMatch(creator, /sendAgentChatMessage/);
});

test('direct image and video creation reuse the project media request implementation', async () => {
    const creator = await read('../packages/studio/src/components/CreatorStudio.jsx');
    assert.match(creator, /submitProjectMedia\(\{ kind: toolId, \.\.\.draft \}, token/);
    assert.match(creator, /buildProjectMediaRequest/);
    assert.match(creator, /initialAsset\.url/);
});

test('Graphic Studio consolidates existing canvas, image editor, and layer components', async () => {
    const graphic = await read('../packages/studio/src/components/GraphicStudio.jsx');
    assert.match(graphic, /DesignAgentStudio/);
    assert.match(graphic, /ImageStudio/);
    assert.match(graphic, /LayersStudio/);
});

test('legacy Agent Builder routes through Studio-contained Agent Blueprints paths', async () => {
    const agents = await read('../packages/studio/src/components/AgentStudio.jsx');
    const shell = await read('../components/StandaloneShell.js');
    assert.match(agents, /basePath = "\/agents"/);
    assert.match(shell, /basePath="\/studio\/advanced\/agents"/);
    assert.doesNotMatch(shell, /window\.history\.pushState|window\.location\.reload/);
});

test('asset handoff populates Storyboard and Lip Sync without requiring a URL copy', async () => {
    const storyboard = await read('../packages/studio/src/components/StoryboardWorkspace.jsx');
    const lipSync = await read('../packages/studio/src/components/LipSyncStudio.jsx');
    assert.match(storyboard, /initialAsset\.type === 'image'/);
    assert.match(lipSync, /setVideoUrl\(initialAsset\.url\)/);
    assert.match(lipSync, /setImageUrl\(initialAsset\.url\)/);
});

test('no new provider key is embedded in the integrated shell or secure Creator client', async () => {
    const shell = await read('../components/StandaloneShell.js');
    const creator = await read('../packages/studio/src/components/CreatorStudio.jsx');
    assert.doesNotMatch(shell, /MUAPI_(?:API_KEY|PRODUCTION_API_KEY)\s*=/);
    assert.doesNotMatch(creator, /x-api-key/);
    assert.match(creator, /Provider keys never enter the browser/);
});

