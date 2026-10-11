import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const ROOTS = ['app', 'src', 'components', 'packages/studio/src'];
const CREDENTIAL = /(?:api[_-]?key|provider[_-]?key|access[_-]?token|refresh[_-]?token|replicate[_-]?(?:api[_-]?)?token|client[_-]?secret|session[_-]?secret|blob[_-]?(?:read[_-]?write[_-]?)?token|muapi[_-]?key)/i;
const CREDENTIAL_NAME = /^\s*['"`](?:key|token|secret|password|credentials?)['"`]\s*$/i;
const PUBLIC_SECRET = /\bNEXT_PUBLIC_[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)[A-Z0-9_]*\b/;
const PROVIDER_SECRET = /\b(?:REPLICATE_API_TOKEN|MUAPI_(?:API_KEY|PRODUCTION_API_KEY|AGENT_API_KEY|SOCIAL_API_KEY)|(?:GEMINI|GROQ|OPENROUTER|NVIDIA|OPENAI|ELEVENLABS|HEYGEN|RUNWAY)_API_KEY|BLOB_READ_WRITE_TOKEN|CREATOR_ASSET_BLOB_READ_WRITE_TOKEN|CREATOR_SESSION_SECRET|GITHUB_OAUTH_CLIENT_SECRET|YOUTUBE_OAUTH_CLIENT_SECRET|YOUTUBE_TOKEN_ENCRYPTION_KEY)\b/;

async function files(directory) {
    const result = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) result.push(...await files(path));
        else if (/\.(?:[cm]?js|jsx|tsx?|mts|cts)$/.test(entry.name)) result.push(path);
    }
    return result;
}

function browserStorageViolations(source) {
    const violations = [];
    if (/\bmuapi_key\b/.test(source)) violations.push('legacy MuAPI credential storage key');
    if (/\bdocument\s*(?:\.\s*cookie|\[\s*['"]cookie['"]\s*\])\s*=/.test(source)) violations.push('document.cookie assignment');
    // Check storage names and values, including calls through the resume store's
    // injected storage object. A generic variable named key is not a credential.
    for (const call of source.matchAll(/(?:\bsetItem|\[\s*['"]setItem['"]\s*\])\s*\(\s*([^,\n]+),\s*([^;\n]+)/g)) {
        if (CREDENTIAL_NAME.test(call[1]) || CREDENTIAL.test(call[1]) || CREDENTIAL.test(call[2])) violations.push('credential storage write');
    }
    for (const assignment of source.matchAll(/\b(?:localStorage|sessionStorage)\s*(?:\[([^\]]+)\]|\.([A-Za-z_$][\w$]*))\s*=\s*([^;\n]+)/g)) {
        if (CREDENTIAL_NAME.test(assignment[1] || '') || /^(?:key|token|secret|password|credentials?)$/i.test(assignment[2] || '') || CREDENTIAL.test(assignment.slice(1).join(' '))) violations.push('credential storage assignment');
    }
    return violations;
}

test('guard catches credential persistence while allowing server headers and resume pointers', () => {
    for (const source of [
        "sessionStorage.setItem('provider-api-key', value)",
        'localStorage.setItem(name, apiKey)',
        "storage.setItem('access_token', value)",
        "localStorage.setItem('token', value)",
        "sessionStorage['setItem']('apiKey', value)",
        "window.localStorage['token'] = REPLICATE_API_TOKEN",
        "document['cookie'] = value",
    ]) assert.notDeepEqual(browserStorageViolations(source), [], source);
    for (const source of [
        "const headers = { 'x-api-key': configuration.apiKey };",
        'serverCache.set(apiKey, providerResult);',
        "storage.setItem(key, JSON.stringify({ v: 1, jobId, projectId, userId, ts }));",
        "sessionStorage.setItem('ogai.replicate.activeJob.v1.image', identity);",
        'localStorage.setItem(CURRENT_PROJECT_STORAGE_KEY, project.id);',
    ]) assert.deepEqual(browserStorageViolations(source), [], source);
    assert.match('NEXT_PUBLIC_MUAPI_API_KEY', PUBLIC_SECRET);
    assert.match('NEXT_PUBLIC_REPLICATE_TOKEN', PUBLIC_SECRET);
});

test('retained app and studio sources never persist browser credentials or write cookies', async () => {
    const offenders = [];
    for (const directory of ROOTS) {
        for (const file of await files(join(ROOT, directory))) {
            const violations = browserStorageViolations(await readFile(file, 'utf8'));
            if (violations.length) offenders.push(`${relative(ROOT, file)}: ${violations.join(', ')}`);
        }
    }
    assert.deepEqual(offenders, []);
});

test('no public environment secrets or provider secrets in retained client sources', async () => {
    const offenders = [];
    for (const directory of ROOTS) {
        for (const file of await files(join(ROOT, directory))) {
            const source = await readFile(file, 'utf8');
            const path = relative(ROOT, file).replaceAll('\\', '/');
            const client = /^(?:components\/|packages\/studio\/src\/)/.test(path)
                || /^\s*['"]use client['"]\s*;?/m.test(source)
                || /^src\/lib\/(?:client|replicateStudio|replicateResume|studioNavigation)/.test(path);
            if (PUBLIC_SECRET.test(source) || (client && PROVIDER_SECRET.test(source))) offenders.push(path);
        }
    }
    assert.deepEqual(offenders, []);
});
