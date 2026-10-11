import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const exists = (path) => access(new URL(path, import.meta.url)).then(() => true, () => false);

test('shell imports only the Creator-core studio exports', async () => {
    const shell = await read('../components/StandaloneShell.js');
    const imported = shell.match(/import \{([^}]*)\} from 'studio';/)?.[1] || '';
    assert.deepEqual(imported.split(',').map((item) => item.trim()).filter(Boolean).sort(), ['CreatorStudio', 'SocialPublishStudio']);
    const index = await read('../packages/studio/src/index.js');
    assert.deepEqual([...index.matchAll(/default as (\w+)/g)].map((match) => match[1]).sort(), ['CreatorStudio', 'SocialPublishStudio']);
});

test('legacy studio files and browser key storage are gone', async () => {
    for (const path of [
        "src/lib/creatorMuapiProxy.js",
        "tests/security/creativeCanvasProxy.test.js",
        "components/ApiKeyModal.js",
        "src/lib/models.js",
        "tests/layoutStudio.test.js",
        "packages/studio/src/muapi.js",
        "packages/studio/src/models.js",
        "packages/studio/src/persistKey.js",
        "packages/studio/src/utils/formatError.js",
        "packages/studio/src/components/layoutStudioModel.js",
        "packages/studio/src/components/AgentStudio.jsx",
        "packages/studio/src/components/AiInfluencerStudio.jsx",
        "packages/studio/src/components/AppsStudio.jsx",
        "packages/studio/src/components/AudioStudio.jsx",
        "packages/studio/src/components/CinemaStudio.jsx",
        "packages/studio/src/components/ClippingStudio.jsx",
        "packages/studio/src/components/DesignAgentStudio.jsx",
        "packages/studio/src/components/DrawModal.jsx",
        "packages/studio/src/components/GraphicStudio.jsx",
        "packages/studio/src/components/ImageStudio.jsx",
        "packages/studio/src/components/LayersStudio.jsx",
        "packages/studio/src/components/LayoutStudio.jsx",
        "packages/studio/src/components/LipSyncStudio.jsx",
        "packages/studio/src/components/MarketingStudio.jsx",
        "packages/studio/src/components/McpCliStudio.jsx",
        "packages/studio/src/components/MobileGenerationActions.jsx",
        "packages/studio/src/components/RecastStudio.jsx",
        "packages/studio/src/components/VibeMotionStudio.jsx",
        "packages/studio/src/components/VideoStudio.jsx",
        "packages/studio/src/components/WorkflowStudio.jsx",
        "packages/studio/src/components/WorkflowUI.jsx",
        "app/agents/[agent_id]/AgentChatClient.js",
        "app/agents/[agent_id]/[conversation_id]/page.js",
        "app/agents/[agent_id]/page.js",
        "app/agents/create/AgentCreateClient.js",
        "app/agents/create/page.js",
        "app/agents/edit/[id]/AgentEditClient.js",
        "app/agents/edit/[id]/page.js",
        "app/agents/layout.js",
        "app/agents/useAgentAuth.js",
        "app/api/agents/[[...path]]/route.js",
        "app/api/api/v1/[[...path]]/route.js",
        "app/api/api/v1/upload_file/route.js",
        "app/api/app/[[...path]]/route.js",
        "app/api/upload-binary/route.js",
        "app/api/v1/[[...path]]/route.js",
        "app/api/v1/creative-agent/[[...path]]/route.js",
        "app/api/v1/get_upload_url/route.js",
        "app/api/v1/upload-binary/route.js",
        "app/api/v1/upload_file/route.js",
        "app/api/workflow/[[...path]]/route.js",
        "app/assistant/page.js",
        "app/workflow/[id]/[tab]/page.js",
        "app/workflow/[id]/page.js",
        "packages/studio/src/components/prompt/PromptComposer.jsx",
        "packages/studio/src/components/prompt/README.md",
        "src/lib/handleDirectUploadProxy.js",
        "src/lib/handleUploadProxy.js",
        "src/lib/uploadTicket.js",
        "src/lib/uploadCredentialProxy.js",
        "src/lib/uploadProxyTarget.js",
        "tests/security/directUploadProxy.test.js",
        "tests/security/uploadProxy.test.js",
        "tests/security/uploadTicket.test.js",
        "tests/security/uploadValidation.test.js"
]) assert.equal(await exists(`../${path}`), false, path);
    for (const path of ['../components/StandaloneShell.js', '../components/LegacyProviderSettings.js']) {
        assert.doesNotMatch(await read(path), /muapi_key|getUserBalance|saveKey|clearKey|apiKey|onSave|onClear/);
    }
});

test('retained client launchers do not target removed workspaces', async () => {
    for (const path of ['../components/StandaloneShell.js', '../components/CreatorHome.js', '../components/StudioAssets.js', '../components/ProjectsStudio.js', '../src/lib/selenaOrchestrator.js']) {
        assert.doesNotMatch(await read(path), /graphic-studio|lipsync|lip-sync|\/studio\/workflows|agent-blueprints|marketplace/);
    }
});
