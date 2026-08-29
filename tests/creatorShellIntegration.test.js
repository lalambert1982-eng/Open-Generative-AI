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
    const image = await read('../packages/studio/src/components/ImageStudio.jsx');
    const draw = await read('../packages/studio/src/components/DrawModal.jsx');
    assert.match(graphic, /DesignAgentStudio/);
    assert.match(graphic, /ImageStudio/);
    assert.match(graphic, /LayersStudio/);
    assert.match(graphic, /apiKey \? "canvas" : "image"/);
    assert.match(graphic, /initialAsset=\{initialAsset\}/);
    assert.match(image, /initialAsset\?\.type !== "image"/);
    assert.match(image, /Use the secure Creator Image tool to generate/);
    assert.match(draw, /initialImageUrl/);
});

test('legacy Agent Builder routes through Studio-contained Agent Blueprints paths', async () => {
    const agents = await read('../packages/studio/src/components/AgentStudio.jsx');
    const shell = await read('../components/StandaloneShell.js');
    assert.match(agents, /basePath = "\/agents"/);
    assert.match(shell, /basePath="\/studio\/advanced\/agents"/);
    assert.doesNotMatch(shell, /window\.history\.pushState|window\.location\.reload/);
});

test('asset handoff populates Graphic Studio, Storyboard, and Lip Sync without requiring a URL copy', async () => {
    const storyboard = await read('../packages/studio/src/components/StoryboardWorkspace.jsx');
    const lipSync = await read('../packages/studio/src/components/LipSyncStudio.jsx');
    const shell = await read('../components/StandaloneShell.js');
    assert.match(storyboard, /initialAsset\.type === 'image'/);
    assert.match(lipSync, /setVideoUrl\(initialAsset\.url\)/);
    assert.match(lipSync, /setImageUrl\(initialAsset\.url\)/);
    assert.match(shell, /'graphic-studio': '\/studio\/apps\/graphic-studio'/);
    assert.match(shell, /<GraphicStudio[^>]*initialAsset=\{handoffAsset\}/);
});

test('no new provider key is embedded in the integrated shell or secure Creator client', async () => {
    const shell = await read('../components/StandaloneShell.js');
    const creator = await read('../packages/studio/src/components/CreatorStudio.jsx');
    assert.doesNotMatch(shell, /MUAPI_(?:API_KEY|PRODUCTION_API_KEY)\s*=/);
    assert.doesNotMatch(creator, /x-api-key/);
    assert.match(creator, /Provider keys never enter the browser/);
});

test('legacy credentials are requested inside the Creator shell instead of replacing navigation', async () => {
    const shell = await read('../components/StandaloneShell.js');
    assert.doesNotMatch(shell, /return <ApiKeyModal/);
    assert.match(shell, /LEGACY_DESTINATIONS\.has\(destinationId\).*requiredFor=\{destination\.label\}/s);
    assert.doesNotMatch(shell.match(/const LEGACY_DESTINATIONS = new Set\(\[([\s\S]*?)\]\);/)?.[1] || '', /graphic-studio|graphics/);
});

test('Music Video reuses the real Storyboard workspace and Workflow exits without a reload loop', async () => {
    const shell = await read('../components/StandaloneShell.js');
    const workflow = await read('../packages/studio/src/components/WorkflowStudio.jsx');
    const workflowUi = await read('../packages/studio/src/components/WorkflowUI.jsx');
    assert.match(shell, /case 'music-video': return <CreatorStudio[^>]*initialToolId="storyboard"/);
    assert.doesNotMatch(workflow, /window\.location\.reload|fromWorkflowBuilder/);
    assert.doesNotMatch(workflowUi, /fromWorkflowBuilder|sessionStorage/);
});

test('unified Publish preserves direct YouTube and adds secure Asset handoff for Instagram and TikTok', async () => {
    const shell = await read('../components/StandaloneShell.js');
    const assets = await read('../components/StudioAssets.js');
    const social = await read('../packages/studio/src/components/SocialPublishStudio.jsx');
    const route = await read('../app/api/social/muapi/[[...path]]/route.js');
    assert.match(shell, /<SocialPublishStudio initialAsset=\{handoffAsset\}/);
    assert.match(shell, /youtubeWorkspace=\{<CreatorStudio/);
    assert.match(shell, /'publish': '\/studio\/publish'/);
    assert.match(assets, /onOpen\?\.\(asset, 'publish'\)/);
    assert.match(social, /Review Publish/);
    assert.match(social, /approved: true/);
    assert.match(social, /Scheduling is not available/);
    assert.doesNotMatch(social, /MUAPI_(?:SOCIAL_|PRODUCTION_)?API_KEY|x-api-key/);
    assert.match(route, /authorizeCreatorRequest/);
    assert.match(route, /evaluateJsonSafety/);
});
