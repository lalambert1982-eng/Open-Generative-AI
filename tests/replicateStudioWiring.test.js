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
});
