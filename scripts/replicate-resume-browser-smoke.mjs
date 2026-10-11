// Local-only browser verification. Starts and stops only its own fixture, Next,
// and Chrome processes. Node 24 and an already-installed Chrome are required.
// Run: node scripts/replicate-resume-browser-smoke.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, readdir, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const fixturePort = Number(process.env.RESUME_FIXTURE_PORT || 4118);
const nextPort = Number(process.env.RESUME_NEXT_PORT || 3118);
const chromePort = Number(process.env.RESUME_CHROME_PORT || 9418);
const fixtureOrigin = `http://127.0.0.1:${fixturePort}`;
// Next dev reports request.url as localhost even when bound to 127.0.0.1, so browse via localhost to keep Origin same-origin.
const nextOrigin = `http://localhost:${nextPort}`;
const chromeOrigin = `http://127.0.0.1:${chromePort}`;
const chromePath = process.env.RESUME_CHROME_PATH || '/Applications/Google Chrome 3.app/Contents/MacOS/Google Chrome';
const evidenceDir = process.env.RESUME_EVIDENCE_DIR || join(root, '.superpowers/sdd/2026-10-10-legacy-cleanup-and-job-resume/agent-08-evidence');
let appRoot;
const uncertaintyPrefix = 'ogai.replicate.uncertain.v1.';
const keyPrefix = 'ogai.replicate.activeJob.v1.';
const children = [];
const results = [];
const externalIntercepted = [];
const exceptions = [];
const requests = [];
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==';
let cdp;
let fixtureStats;
let sessionUnavailable = false;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function eventually(check, label, timeout = 90000) {
    const end = Date.now() + timeout;
    let last;
    while (Date.now() < end) {
        try { const value = await check(); if (value) return value; } catch (error) { last = error.message; }
        await sleep(150);
    }
    throw new Error(`Timed out: ${label}${last ? ` (${last})` : ''}`);
}
async function freePort(port) {
    const server = createServer();
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
    await new Promise((resolve) => server.close(resolve));
}
function start(name, command, args, env, cwd = root) {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    child.stdout.on('data', (bytes) => { log += bytes; });
    child.stderr.on('data', (bytes) => { log += bytes; });
    children.push({ name, child, getLog: () => log });
    return child;
}
async function stop() {
    cdp?.close();
    for (const { child } of [...children].reverse()) {
        if (child.exitCode !== null || child.signalCode !== null) continue;
        const exited = once(child, 'exit');
        child.kill('SIGTERM');
        await Promise.race([exited, sleep(3000)]);
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    for (const item of children) await writeFile(join(evidenceDir, `${item.name}.log`), item.getLog());
}
async function connect(url) {
    const socket = new WebSocket(url);
    await once(socket, 'open');
    let sequence = 0;
    const waiting = new Map();
    const listeners = new Map();
    socket.addEventListener('message', (event) => {
        const value = JSON.parse(event.data);
        if (value.id) {
            const pending = waiting.get(value.id);
            if (!pending) return;
            waiting.delete(value.id);
            if (value.error) pending.reject(new Error(value.error.message)); else pending.resolve(value.result);
        } else for (const listener of listeners.get(value.method) || []) listener(value.params);
    });
    return {
        send(method, params = {}) {
            const id = ++sequence;
            return new Promise((resolve, reject) => { waiting.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
        },
        on(method, listener) { listeners.set(method, [...(listeners.get(method) || []), listener]); },
        close() { socket.close(); },
    };
}
async function evaluate(expression) {
    const response = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.text);
    return response.result.value;
}
const text = () => evaluate('document.body.innerText');
const pointer = (kind) => evaluate(`JSON.parse(sessionStorage.getItem(${JSON.stringify(keyPrefix + kind)}) || 'null')`);
const uncertainty = (kind) => evaluate(`JSON.parse(sessionStorage.getItem(${JSON.stringify(uncertaintyPrefix + kind)}) || 'null')`);
const uncertaintyCount = () => evaluate(`Object.keys(sessionStorage).filter(key => key.startsWith(${JSON.stringify(uncertaintyPrefix)})).length`);
const pointerCount = () => evaluate(`Object.keys(sessionStorage).filter(key => key.startsWith(${JSON.stringify(keyPrefix)})).length`);
async function button(label) {
    if (label === 'Generate') label = 'Generate (mock — no charge)';
    await eventually(() => evaluate(`([...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(label)} && b.getClientRects().length))?.disabled === false`), `enabled button ${label}`);
    return evaluate(`(() => { const button = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(label)} && b.getClientRects().length); if (!button) throw new Error('Missing button: ' + ${JSON.stringify(label)}); button.click(); return true; })()`);
}
async function field(selector, value) {
    await evaluate(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); if (!node) throw new Error('Missing field'); const proto = node.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(node, ${JSON.stringify(value)}); node.dispatchEvent(new Event('input', { bubbles: true })); })()`);
}
async function navigate(path) {
    await cdp.send('Page.navigate', { url: `${nextOrigin}${path}` });
    await eventually(() => evaluate(`location.pathname === ${JSON.stringify(path)} && document.readyState === 'complete'`), `navigate ${path}`);
}
async function nav(label, suffix) {
    await button(label);
    await eventually(() => evaluate(`location.pathname.endsWith(${JSON.stringify(suffix)})`), `in-app ${label}`);
}
async function studioReady() {
    await eventually(() => evaluate("!!document.querySelector('#replicate-prompt') && document.querySelector('#replicate-model')?.options.length > 0"), 'Replicate studio');
}
async function shot(name) {
    const value = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await writeFile(join(evidenceDir, `${name}.png`), Buffer.from(value.data, 'base64'));
}
async function stats() { return (await fetch(`${fixtureOrigin}/api/creator/__fixture/stats`)).json(); }
async function control(action, jobId) {
    const response = await fetch(`${fixtureOrigin}/api/creator/__fixture/control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, jobId }) });
    assert.equal(response.status, 200, `${action} fixture control`);
}
async function startJob(kind, prompt) {
    await nav(kind === 'image' ? 'Image' : 'Video', `/tools/${kind}`);
    await studioReady();
    await eventually(() => evaluate("!document.querySelector('#replicate-prompt').disabled"), 'editable prompt');
    const before = await stats();
    await field('#replicate-prompt', prompt);
    await button('Generate');
    const saved = await eventually(() => pointer(kind), `${kind} accepted job pointer`);
    await eventually(async () => (await stats()).generate === before.generate + 1, 'single generate');
    assert.equal((await stats()).generate, before.generate + 1);
    assert.equal((await pointer(kind)).jobId, saved.jobId);
    return saved;
}
async function check(label, action) {
    console.log(`CHECK ${label}`);
    await action();
    results.push({ label, pass: true });
    console.log(`PASS ${label}`);
}

await mkdir(evidenceDir, { recursive: true });
try {
    assert.equal(new Set([fixturePort, nextPort, chromePort]).size, 3, 'use distinct dedicated ports');
    for (const port of [fixturePort, nextPort, chromePort]) await freePort(port);
    // Next gets a source copy with no env files and a fresh .next directory.
    // An explicit environment allowlist prevents inherited credentials/preloads.
    appRoot = await mkdtemp(join(tmpdir(), 'creator-resume-app-'));
    const sourceNames = ['app', 'components', 'src', 'packages', 'public', 'middleware.js',
        'next.config.mjs', 'package.json', 'jsconfig.json', 'postcss.config.js', 'tailwind.config.js'];
    const available = new Set(await readdir(root));
    for (const name of sourceNames.filter(name => available.has(name))) {
        await cp(join(root, name), join(appRoot, name), { recursive: true,
            filter: path => !path.split('/').some(part => part.startsWith('.env') || ['node_modules', '.next', '.git', 'dist'].includes(part)),
        });
    }
    await symlink(join(root, 'node_modules'), join(appRoot, 'node_modules'), 'dir');
    const env = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'LANG'].filter(name => process.env[name]).map(name => [name, process.env[name]]));
    const networkGuard = join(appRoot, 'fixture-network-guard.cjs');
    await writeFile(networkGuard, `
const net = require('node:net');
const tls = require('node:tls');
function guard(args) {
  const value = args[0];
  const host = typeof value === 'object' ? (value.host || value.hostname) : typeof args[1] === 'string' ? args[1] : undefined;
  if (host && !['127.0.0.1', 'localhost', '::1'].includes(host)) {
    console.error('FIXTURE_EXTERNAL_BLOCKED ' + host);
    throw new Error('External socket blocked by browser fixture');
  }
}
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function(...args) { guard(args); return connect.apply(this, args); };
const tlsConnect = tls.connect;
tls.connect = function(...args) { guard(args); return tlsConnect.apply(this, args); };
`);
    Object.assign(env, {
        NODE_ENV: 'development', NEXT_TELEMETRY_DISABLED: '1', NODE_OPTIONS: `--require=${networkGuard}`,
        CREATOR_UI_FIXTURE_ORIGIN: fixtureOrigin, FIXTURE_PORT: String(fixturePort),
        CREATOR_SESSION_SECRET: 'creator-ui-fixture-session-secret-over-thirty-two-characters',
        CREATOR_GITHUB_ALLOWED_USER_IDS: '12345678,87654321', CREATOR_GITHUB_ALLOWED_LOGINS: 'fixture-owner,other-owner',
        GENERATION_MODE: 'mock', REPLICATE_LIVE_ENABLED: 'false',
        BLOB_READ_WRITE_TOKEN: 'private-blob-fixture-test-token-only',
        CREATOR_ASSET_BLOB_READ_WRITE_TOKEN: 'public-blob-fixture-test-token-only',
        GITHUB_OAUTH_CLIENT_ID: 'Fixture00000000000000', GITHUB_OAUTH_CLIENT_SECRET: 'fixture-oauth-secret-unused-by-this-test',
        GITHUB_OAUTH_CALLBACK_URL: `${nextOrigin}/api/auth/github/callback`,
    });
    start('fixture', process.execPath, ['--experimental-test-module-mocks', 'scripts/replicate-ui-fixture-server.mjs'], env);
    await eventually(async () => (await stats()).mode === 'mock', 'fixture readiness');
    await control('hold');
    start('next', process.execPath, [join(root, 'node_modules/next/dist/bin/next'), 'dev', '-H', '127.0.0.1', '-p', String(nextPort)], env, appRoot);
    await eventually(async () => (await fetch(`${nextOrigin}/api/auth/session`)).status === 401, 'real Next auth readiness', 120000);
    const profile = await mkdtemp(join(tmpdir(), 'creator-resume-chrome-'));
    start('chrome', chromePath, [
        '--headless=new', `--remote-debugging-port=${chromePort}`, `--user-data-dir=${profile}`,
        '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-background-networking',
        '--disable-component-update', '--disable-sync', '--disable-extensions', '--disable-domain-reliability',
        '--metrics-recording-only', '--disable-features=MediaRouter,OptimizationHints',
        '--proxy-server=http://127.0.0.1:9', '--proxy-bypass-list=127.0.0.1;localhost', 'about:blank',
    ], env);
    const targets = await eventually(async () => {
        const response = await fetch(`${chromeOrigin}/json/list`);
        return response.ok && await response.json();
    }, 'Chrome readiness');
    cdp = await connect(targets.find((item) => item.type === 'page').webSocketDebuggerUrl);
    cdp.on('Fetch.requestPaused', async (event) => {
        try {
            const url = new URL(event.request.url);
            if (sessionUnavailable && url.origin === nextOrigin && url.pathname === '/api/auth/session') {
                await cdp.send('Fetch.fulfillRequest', { requestId: event.requestId, responseCode: 503, responseHeaders: [{ name: 'content-type', value: 'application/json' }], body: Buffer.from(JSON.stringify({ error: 'Injected session outage' })).toString('base64') });
            } else if (url.origin === nextOrigin || ['data:', 'blob:', 'about:'].includes(url.protocol)) {
                await cdp.send('Fetch.continueRequest', { requestId: event.requestId });
            } else {
                externalIntercepted.push({ url: event.request.url, resourceType: event.resourceType });
                if (event.resourceType === 'Image') await cdp.send('Fetch.fulfillRequest', { requestId: event.requestId, responseCode: 200, responseHeaders: [{ name: 'content-type', value: 'image/png' }], body: png });
                else await cdp.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'BlockedByClient' });
            }
        } catch (error) { exceptions.push(`interception: ${error.message}`); }
    });
    cdp.on('Runtime.exceptionThrown', (event) => exceptions.push(event.exceptionDetails.exception?.description || event.exceptionDetails.text));
    cdp.on('Network.requestWillBeSent', (event) => requests.push({ url: event.request.url, method: event.request.method }));
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Network.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await cdp.send('Page.navigate', { url: `${nextOrigin}/api/creator/__fixture/login` });
    await eventually(() => evaluate("location.pathname.startsWith('/studio') && document.readyState === 'complete'"), 'fixture sign-in redirect');
    const session = await evaluate("fetch('/api/auth/session').then(async r => ({status:r.status, ...await r.json()}))");
    assert.equal(session.status, 200, 'real Next session uses fabricated fixture cookie');
    assert.equal(String(session.user.id), '12345678');
    await nav('Projects', '/projects');
    await eventually(async () => (await text()).includes('New Project'), 'projects loaded');
    await button('New Project');
    await field('#project-editor-name', 'Resume Browser Fixture');
    await button('Create Project');
    await eventually(() => evaluate("!!document.querySelector('section[aria-label=\"Project Workspace\"]') && !document.querySelector('#project-editor-name')"), 'project creation');
    await check('navigation and reload recover status without duplicate create; terminal clears pointer', async () => {
        const saved = await startJob('image', 'Paper bird resume navigation');
        const before = await stats();
        await shot('01-image-running');
        await nav('Home', '/home');
        assert.equal((await pointer('image')).jobId, saved.jobId);
        await nav('Image', '/tools/image');
        await studioReady();
        await eventually(async () => (await stats()).statusByJob[saved.jobId] > (before.statusByJob[saved.jobId] || 0), 'return status recovery');
        const afterReturn = await stats();
        await cdp.send('Page.reload');
        await studioReady();
        await eventually(async () => (await stats()).statusByJob[saved.jobId] > afterReturn.statusByJob[saved.jobId], 'reload status recovery');
        assert.equal((await stats()).generate, before.generate);
        assert.equal((await pointer('image')).jobId, saved.jobId);
        await shot('02-image-resumed');
        sessionUnavailable = true;
        await cdp.send('Page.reload');
        await eventually(async () => /verify.*session|session.*verif/i.test(await text()), 'unavailable session stays unverified');
        assert.equal((await pointer('image')).jobId, saved.jobId);
        assert.equal(await evaluate("!!document.querySelector('#replicate-prompt')"), false);
        assert.equal((await stats()).generate, before.generate);
        await shot('02-session-unverified');
        sessionUnavailable = false;
        const beforeVerifiedReload = await stats();
        await cdp.send('Page.reload');
        await studioReady();
        await eventually(async () => (await stats()).statusByJob[saved.jobId] > beforeVerifiedReload.statusByJob[saved.jobId], 'verified session resumes preserved pointer');
        await control('release', saved.jobId);
        await eventually(async () => (await pointer('image')) === null && (await text()).includes('Mock placeholder'), 'terminal result and pointer clearing');
        assert.equal((await stats()).generate, before.generate);
        await shot('03-image-completed');
    });
    await check('resumed 404 clears pointer but keeps billing uncertainty locked until acknowledgment', async () => {
        const saved = await startJob('image', 'Paper bird missing record');
        const before = await stats();
        await control('missing', saved.jobId);
        await cdp.send('Page.reload');
        await studioReady();
        await eventually(async () => (await text()).toLowerCase().includes('no longer available'), 'missing-job notice');
        assert.equal(await pointer('image'), null);
        assert.equal((await stats()).generate, before.generate);
        assert.equal(await evaluate("document.querySelector('#replicate-prompt').disabled"), true);
        assert.equal((await uncertainty('image')).jobId, saved.jobId);
        assert.match(await text(), /billed/i);
        await shot('04-missing-locked');
        await nav('Home', '/home');
        await nav('Image', '/tools/image');
        await studioReady();
        await eventually(() => uncertainty('image'), 'uncertainty survives navigation');
        await cdp.send('Page.reload');
        await studioReady();
        await eventually(() => evaluate("[...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'I understand')"), 'uncertainty restored after reload');
        assert.equal(await evaluate("document.querySelector('#replicate-prompt').disabled"), true);
        assert.equal(await pointer('image'), null);
        assert.equal((await stats()).generate, before.generate);
        await shot('04-missing-reloaded-locked');
        await button('I understand');
        await eventually(async () => (await uncertainty('image')) === null && !await evaluate("document.querySelector('#replicate-prompt').disabled"), 'explicit acknowledgment unlocks');
        assert.equal((await stats()).generate, before.generate);
        await shot('04-missing-acknowledged');
    });
    await check('actual UI logout clears image and video pointers', async () => {
        await startJob('image', 'Paper bird logout image');
        await startJob('video', 'Paper bird logout video');
        assert.equal(await pointerCount(), 2);
        const before = await stats();
        await nav('Selena', '/selena');
        await eventually(() => evaluate("!!document.querySelector('button[title=\"Sign out of Creator Studio\"]')"), 'actual logout button');
        await evaluate("document.querySelector('button[title=\"Sign out of Creator Studio\"]').click()");
        await eventually(async () => (await pointerCount()) === 0, 'logout clears both pointers');
        assert.equal((await stats()).generate, before.generate);
        assert.equal(await uncertaintyCount(), 0);
        // Pointers clear before the logout request settles, so wait for the cookie to be dropped.
        await eventually(async () => (await evaluate("fetch('/api/auth/session').then(r => r.status)")) === 401, 'logout request drops the session cookie');
        await shot('05-logged-out');
    });
    await check('expired session during running video clears image and video pointers', async () => {
        await cdp.send('Page.navigate', { url: `${nextOrigin}/api/creator/__fixture/login` });
        await eventually(() => evaluate("location.pathname.startsWith('/studio') && document.readyState === 'complete'"), 'sign in after logout');
        await startJob('image', 'Paper bird session loss image');
        await startJob('video', 'Paper bird session loss video');
        assert.equal(await pointerCount(), 2);
        const before = await stats();
        await cdp.send('Network.deleteCookies', { name: 'creator_session', url: nextOrigin });
        await eventually(async () => (await pointerCount()) === 0 && (await text()).includes('session ended'), 'status 401 clears both pointers');
        assert.equal((await stats()).generate, before.generate);
        assert.equal(await uncertaintyCount(), 0);
        await shot('06-session-ended');
    });
    const styleEvidence = await evaluate(`(() => {
        const button = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Generate');
        return { stylesheets: [...document.styleSheets].map(s => s.href).filter(Boolean),
            button: button ? { background: getComputedStyle(button).backgroundColor, borderRadius: getComputedStyle(button).borderRadius } : null };
    })()`);
    styleEvidence.cssBytes = 0;
    for (const url of styleEvidence.stylesheets) {
        if (new URL(url).origin !== nextOrigin) continue;
        styleEvidence.cssBytes += Buffer.byteLength(await (await fetch(url)).text());
    }
    await writeFile(join(evidenceDir, 'style-evidence.json'), JSON.stringify(styleEvidence, null, 2));
    fixtureStats = await stats();
    assert.equal(fixtureStats.mode, 'mock');
    assert.equal(fixtureStats.stubCalls, 0);
    assert.equal(fixtureStats.forbiddenFetches, 0);
    assert.equal(exceptions.length, 0, 'no uncaught browser exceptions');
    console.log(`Browser smoke ${results.length}/${results.length}; generate=${fixtureStats.generate} status=${fixtureStats.status}; external URLs intercepted=${externalIntercepted.length}; provider calls=0`);
} catch (error) {
    results.push({ label: 'run failure', pass: false, error: error.stack });
    if (cdp) await shot('failure').catch(() => {});
    if (cdp) await writeFile(join(evidenceDir, 'failure-dom.txt'), await text().catch(() => '')).catch(() => {});
    console.error(error.message);
    process.exitCode = 1;
} finally {
    fixtureStats ||= await stats().catch(() => null);
    await writeFile(join(evidenceDir, 'evidence.json'), JSON.stringify({ results, fixtureStats, externalIntercepted, exceptions, requests, appRoot }, null, 2));
    await stop();
}
