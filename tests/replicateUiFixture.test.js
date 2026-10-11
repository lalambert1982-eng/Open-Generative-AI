import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';

test('browser fixture holds mock jobs until release and exposes owner-bound missing-job traffic', async (t) => {
    const child = spawn(process.execPath, ['--experimental-test-module-mocks', 'scripts/replicate-ui-fixture-server.mjs'], {
        cwd: new URL('..', import.meta.url), env: { ...process.env, FIXTURE_PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    t.after(async () => { if (child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); } });
    let output = '';
    const origin = await new Promise((resolve, reject) => {
        child.stdout.on('data', (bytes) => { output += bytes; const match = output.match(/Fixture API ready on (http:\/\/127\.0\.0\.1:\d+)/); if (match) resolve(match[1]); });
        child.stderr.on('data', (bytes) => { output += bytes; });
        child.once('exit', () => reject(new Error(output)));
    });
    const login = await fetch(`${origin}/api/creator/__fixture/login`, { redirect: 'manual' });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const call = async (path, body, withAuth = true) => {
        const response = await fetch(`${origin}/api/creator/${path}`, {
            method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', origin, ...(withAuth ? { cookie } : {}) },
            ...(body ? { body: JSON.stringify(body) } : {}),
        });
        return { status: response.status, value: await response.json() };
    };
    assert.equal((await call('__fixture/control', { action: 'hold' })).status, 200);
    const project = (await call('projects', { name: 'Fixture hold test' })).value.project;
    const input = { prompt: 'A blue paper bird', aspect_ratio: '1:1' };
    const model = 'black-forest-labs/flux-2-pro';
    const quote = (await call('replicate/quote', { model, input })).value;
    const generated = await call('replicate/generate', { model, input, projectId: project.id, quoteToken: quote.quoteToken });
    assert.equal(generated.status, 202);
    assert.equal(generated.value.job.status, 'queued');
    assert.equal(generated.value.job.asset, null);
    const jobId = generated.value.job.jobId;
    assert.equal((await call(`replicate/status?id=${jobId}`, undefined, false)).status, 401);
    for (let i = 0; i < 2; i++) assert.equal((await call(`replicate/status?id=${jobId}`)).value.job.status, 'running');
    assert.equal((await call('__fixture/control', { action: 'release', jobId })).status, 200);
    const completed = (await call(`replicate/status?id=${jobId}`)).value.job;
    assert.equal(completed.status, 'completed');
    assert.ok(completed.asset);
    const duplicate = (await call(`replicate/status?id=${jobId}`)).value.job;
    assert.equal(duplicate.asset.id, completed.asset.id);
    assert.equal((await call('__fixture/control', { action: 'missing', jobId })).status, 200);
    assert.equal((await call(`replicate/status?id=${jobId}`)).status, 404);
    const stats = (await call('__fixture/stats')).value;
    assert.equal(stats.generate, 1);
    assert.equal(stats.status, 6);
    assert.equal(stats.stubCalls, 0);
    assert.equal(stats.forbiddenFetches, 0);
});
