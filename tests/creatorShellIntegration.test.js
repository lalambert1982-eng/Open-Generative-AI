import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('Selena remains on the secure Creator assistant route and does not use MuAPI Agent chat', async () => {
    const creator = await read('../packages/studio/src/components/CreatorStudio.jsx');
    assert.match(creator, /request\("assistant",\s*\{[\s\S]*?method: "POST"/);
    assert.match(creator, /fetch\(`\/api\/creator\/\$\{path\}`/);
    assert.doesNotMatch(creator, /sendAgentChatMessage/);
});

test('direct image and video creation reuse the project media request implementation', async () => {
    const creator = await read('../packages/studio/src/components/CreatorStudio.jsx');
    assert.match(creator, /submitProjectMedia\(\{ kind: toolId, \.\.\.draft \}, token/);
    assert.match(creator, /buildProjectMediaRequest/);
    assert.match(creator, /initialAsset\.url/);
});

test('Projects and Assets use the authenticated durable Project API with owner-scoped handoff', async () => {
    const shell = await read('../components/StandaloneShell.js');
    const projects = await read('../components/ProjectsStudio.js');
    const assets = await read('../components/StudioAssets.js');
    const projectRoute = await read('../src/lib/creatorProjectRoutes.js');
    assert.match(shell, /fetch\(`\/api\/creator\/projects\$\{path\}`/);
    assert.match(shell, /case 'projects': return <ProjectsStudio/);
    assert.match(shell, /saveProjectStoryboard/);
    assert.match(shell, /saveProjectConversation/);
    assert.match(shell, /recordAsset/);
    assert.match(projects, /New Project/);
    assert.match(projects, /aria-label=\{editor\.mode === 'create' \? 'Create Project' : 'Rename Project'\}/);
    assert.match(projects, /onSubmit=\{submitEditor\}/);
    assert.doesNotMatch(projects, /window\.prompt/);
    assert.match(projects, /aria-label="Project Workspace"/);
    assert.match(projects, /Continue with Selena/);
    assert.match(projects, /Build Storyboard/);
    assert.match(projects, /Prepare Publish/);
    assert.match(projects, /onNavigate\?\.\(action\.path\)/);
    assert.match(shell, /onNavigate=\{navigate\}/);
    assert.match(projects, /Recent Projects/);
    assert.match(assets, /Upload Asset/);
    assert.match(assets, /role="alert"/);
    assert.match(assets, /Asset upload failed/);
    assert.match(shell, /uploading=\{assetUploading\} error=\{projectError\}/);
    assert.match(projectRoute, /authorizeCreatorRequest/);
    assert.match(projectRoute, /getCreatorProject\(user, payload\.projectId/);
});

test('Selena renders structured plans and approval-aware action cards', async () => {
    const creator = await read('../packages/studio/src/components/CreatorStudio.jsx');
    assert.match(creator, /data\.suggestedActions/);
    assert.match(creator, /message\.plan/);
    assert.match(creator, /action\.requiresApproval/);
    assert.match(creator, /Review action/);
    assert.match(creator, /Cancel/);
    assert.match(creator, /projectId: project\?\.id/);
    assert.doesNotMatch(creator, /project:\s*project/);
});

test('Storyboard persistence produces a versioned timeline boundary without claiming rendered transitions', async () => {
    const storyboard = await read('../packages/studio/src/components/StoryboardWorkspace.jsx');
    const timeline = await read('../src/lib/creatorTimeline.js');
    assert.match(storyboard, /onStoryboardChange/);
    assert.match(storyboard, /project\.storyboard/);
    assert.match(timeline, /CREATOR_TIMELINE_VERSION = 1/);
    assert.match(timeline, /rendered: false/);
    assert.match(timeline, /status: 'not-requested'/);
    assert.doesNotMatch(timeline, /ffmpeg|renderVideo|composeVideo/);
});

test('asset handoff populates the retained Storyboard without requiring a URL copy', async () => {
    const storyboard = await read('../packages/studio/src/components/StoryboardWorkspace.jsx');
    assert.match(storyboard, /initialAsset\.type === 'image'/);
});

test('no new provider key is embedded in the integrated shell or secure Creator client', async () => {
    const shell = await read('../components/StandaloneShell.js');
    const creator = await read('../packages/studio/src/components/CreatorStudio.jsx');
    assert.doesNotMatch(shell, /MUAPI_(?:API_KEY|PRODUCTION_API_KEY)\s*=/);
    assert.doesNotMatch(creator, /x-api-key/);
    assert.match(creator, /Provider keys never enter the browser/);
    assert.doesNotMatch(shell, /window\.history\.pushState|window\.location\.reload/);
});

test('provider settings are read-only within the Creator shell', async () => {
    const shell = await read('../components/StandaloneShell.js');
    const settings = await read('../components/LegacyProviderSettings.js');
    assert.doesNotMatch(shell, /return <ApiKeyModal|LEGACY_DESTINATIONS|muapi_key/);
    assert.match(shell, /case 'provider-settings': return <LegacyProviderSettings \/>/);
    assert.match(settings, /Server-managed providers/);
    assert.doesNotMatch(settings, /<form|<input|onSave|onClear|sessionStorage|localStorage/);
});

test('Music Video reuses the retained Storyboard workspace', async () => {
    const shell = await read('../components/StandaloneShell.js');
    assert.match(shell, /case 'music-video': return <CreatorStudio[^>]*initialToolId="storyboard"/);
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

test('Selena action handoff rejects a stale or foreign-Project asset instead of navigating silently', async () => {
    const shell = await read('../components/StandaloneShell.js');
    assert.match(shell, /assets\.find\(\(asset\) => asset\.id === action\.parameters\.assetId\)/);
    assert.match(shell, /if \(!requestedAsset\) \{/);
    assert.match(shell, /no longer available in this Project/);
    assert.match(shell, /setHandoffAsset\(null\);\s*\n\s*return;/);
});

test('shell mount does not seed a previous Project\'s cached Assets while a durable Project load is pending', async () => {
    const shell = await read('../components/StandaloneShell.js');
    assert.match(shell, /pendingProjectId = window\.localStorage\.getItem\(CURRENT_PROJECT_STORAGE_KEY\)/);
    assert.match(shell, /if \(!pendingProjectId\) setAssets\(loadAssets\(\)\);/);
});

test('Social publish confirmation guards against a double-submit race with a synchronous ref', async () => {
    const social = await read('../packages/studio/src/components/SocialPublishStudio.jsx');
    assert.match(social, /const publishInFlightRef = useRef\(false\);/);
    assert.match(social, /if \(publishInFlightRef\.current \|\| working \|\| !approved\) return;/);
    assert.match(social, /publishInFlightRef\.current = true;/);
    assert.match(social, /publishInFlightRef\.current = false;/);
});

test('Workflow Execution reuses the Creator Studio shell instead of a second Workflows product', async () => {
    const creator = await read('../packages/studio/src/components/CreatorStudio.jsx');
    const shell = await read('../components/StandaloneShell.js');
    const panel = await read('../packages/studio/src/components/WorkflowRunPanel.jsx');
    const nav = await read('../src/lib/studioNavigation.js');
    const selena = await read('../src/lib/selenaOrchestrator.js');

    // The new Workflow tab lives inside the existing CreatorStudio tool shell,
    // not a standalone page, and reuses its own request() helper and onProjectChange
    // wiring rather than duplicating fetch/session logic.
    assert.match(creator, /id: "workflow"/);
    assert.match(creator, /import WorkflowRunPanel from "\.\/WorkflowRunPanel"/);
    assert.match(creator, /<WorkflowRunPanel[\s\S]*?request=\{request\}/);
    assert.match(creator, /<WorkflowRunPanel[\s\S]*?onProjectChange=\{onProjectChange\}/);

    assert.doesNotMatch(shell, /WorkflowStudio|case 'workflows':/);
    assert.match(shell, /case 'workflow-run': return <CreatorStudio[\s\S]*?initialToolId="workflow"/);
    assert.match(nav, /id: 'workflow-run', label: 'Workflow Run', path: '\/studio\/apps\/workflow-run'/);

    // Selena can only ever reach the new execution surface through the server
    // allowlist, and starting a run is never itself treated as approval.
    for (const action of ['workflow.create', 'workflow.configure', 'workflow.run', 'workflow.status']) {
        assert.match(shell, new RegExp(`'${action.replace('.', '\\.')}': '/studio/apps/workflow-run'`));
        assert.match(selena, new RegExp(`'${action.replace('.', '\\.')}': Object\\.freeze\\(\\{[\\s\\S]*?requiresApproval: false`));
    }

    // The status panel drives the project-scoped API and never a client-held
    // provider credential, and offers the approve/retry/cancel controls the
    // run's state machine requires.
    assert.match(panel, /callAction\(`projects\/\$\{project\.id\}\/workflows`/);
    assert.match(panel, /const response = await request\(path, options\);/);
    assert.match(panel, /runStep\("approve"\)/);
    assert.match(panel, /runStep\("retry"\)/);
    assert.match(panel, /runStep\("cancel"\)/);

    // workflow.configure/run/status carry a workflowId parameter that must
    // actually select (and, for workflow.run, advance) the referenced run —
    // not just navigate to an empty panel — while still going through the
    // same approve-gated advance() as any manual click.
    assert.match(creator, /<WorkflowRunPanel[\s\S]*?initialAction=\{initialAction\}/);
    assert.match(panel, /initialAction\?\.parameters\?\.workflowId/);
    assert.match(panel, /initialAction\.action === "workflow\.run"/);
    assert.match(panel, /workflows\/\$\{selectedRunId\}\/\$\{action\}/);
    assert.doesNotMatch(panel, /apiKey/);
});
