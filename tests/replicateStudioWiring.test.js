import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

const BROWSER_FILES = [
    '../components/ReplicateStudio.js',
    '../components/CreatorMediaStudio.js',
    '../src/lib/replicateStudioClient.js',
    '../src/lib/replicateStudioForm.js',
    '../src/lib/replicateStudioView.js',
];

test('browser Replicate files never touch server code, environment, tokens, or non-Asset output URLs', async () => {
    for (const file of BROWSER_FILES) {
        const source = await read(file);
        assert.doesNotMatch(source, /process\.env/, file);
        assert.doesNotMatch(source, /REPLICATE_API_TOKEN|BLOB_READ_WRITE_TOKEN|CREATOR_SESSION_SECRET/, file);
        assert.doesNotMatch(source, /replicateGateway|replicateProvider|replicatePersist|replicateModelRegistry|generationGuard/, file);
        assert.doesNotMatch(source, /outputUrl/, file);
    }
});

test('ReplicateStudio renders controller state, one Generate path, and no Retry-generation control', async () => {
    const source = await read('../components/ReplicateStudio.js');
    assert.match(source, /createReplicateController/);
    assert.match(source, /useSyncExternalStore/);
    assert.match(source, /deriveView/);
    assert.match(source, /\.teardown\(\)/);
    assert.match(source, /aria-live="polite"/);
    assert.match(source, /role=\{[^}]*'alert'/);
    assert.doesNotMatch(source, /Retry/);
    assert.match(source, /Saved to Project/);
    assert.match(source, /Mock placeholder/);
});

test('CreatorMediaStudio keeps Replicate default and MuAPI behind an explicit selector', async () => {
    const source = await read('../components/CreatorMediaStudio.js');
    assert.match(source, /useState\('replicate'\)/);
    assert.match(source, /muapiWorkspace/);
    assert.match(source, /role="radiogroup"/);
    assert.match(source, /providerSwitchDisabled|busy/);
    assert.match(source, /hidden=\{provider !== 'replicate'\}/);
    assert.doesNotMatch(source, /provider === 'replicate'\s*\?/);
});

test('shell routes Image and Video through the wrapper and keeps MuAPI as a passed-in element', async () => {
    const shell = await read('../components/StandaloneShell.js');
    assert.match(shell, /import CreatorMediaStudio from '\.\/CreatorMediaStudio'/);
    assert.match(shell, /<CreatorMediaStudio kind="image"/);
    assert.match(shell, /<CreatorMediaStudio kind="video"/);
    assert.match(shell, /muapiWorkspace=\{<CreatorStudio[^>]*initialToolId="image"/);
    assert.match(shell, /muapiWorkspace=\{<CreatorStudio[^>]*initialToolId="video"/);
});

test('the Replicate flow refreshes the originating Project and never posts the Asset again', async () => {
    const shell = await read('../components/StandaloneShell.js');
    const start = shell.indexOf('const settleReplicateJob');
    const endMarker = '}, [applyCurrentProject]);';
    const end = shell.indexOf(endMarker, start);
    const block = start >= 0 && end >= 0 ? shell.slice(start, end + endMarker.length) : '';
    assert.ok(block.length > 0, 'settleReplicateJob block must exist');
    assert.match(block, /projectRequest\(`\/\$\{encodeURIComponent\(projectId\)\}`\)/);
    assert.match(block, /currentProjectIdRef\.current === projectId/);
    assert.match(block, /applyCurrentProject\(value\.project\)/);
    assert.match(block, /setProjectSummaries/);
    assert.doesNotMatch(block, /recordAsset|\/assets/);
    const wrapperCalls = shell.match(/<CreatorMediaStudio[^]*?\/>/g) || [];
    for (const call of wrapperCalls) assert.doesNotMatch(call, /onGenerationComplete|recordAsset/);
});

test('Home shows recent Project Assets and enabled models without breaking the Selena prompt', async () => {
    const home = await read('../components/CreatorHome.js');
    const shell = await read('../components/StandaloneShell.js');
    assert.match(home, /recentAssets/);
    assert.match(home, /createReplicateApi/);
    assert.match(home, /onAskSelena\?\.\(value\)/);
    assert.match(home, /\['image',\s*'video',\s*'graphic'\]\.includes\(asset\.type\)/);
    assert.match(shell, /<CreatorHome onNavigate=\{navigate\}[^]*?recentAssets=\{assets/);
});
