'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { once } = require('node:events');
const { TARGETS, validateSettings } = require('../lib/probe.cjs');
const { createRunManager } = require('../lib/runs.cjs');
const { createTargetStore, validateTarget } = require('../lib/targets.cjs');
const { createApp } = require('../server.cjs');

async function temporary(t) {
  const dataDir = await fs.mkdtemp(path.join(__dirname, 'tmp-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  return dataDir;
}
function settings(overrides = {}) {
  return { mode: 'direct', proxy: '', runMode: 'count', rounds: 1, timeout: 3,
    duration: 5, interval: 0.5, targets: ['google'], speedTest: false,
    nodeLabel: '', ...overrides };
}
function success(overrides = {}) {
  return { status: 'ok', httpStatus: 204, ttfbMs: 100, totalMs: 110,
    dnsMs: 1, connectMs: 2, tlsMs: 3, message: 'ok', ...overrides };
}
async function complete(manager, id, timeout = 4000) {
  const deadline = Date.now() + timeout;
  while (manager.get(id).status === 'running') {
    assert.ok(Date.now() < deadline, 'test run did not complete');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  // Wait for the asynchronous local history write before test cleanup.
  await new Promise(resolve => setTimeout(resolve, 30));
  return manager.get(id);
}

test('continuous settings bound count, duration and interval, with store-backed target validation', () => {
  const valid = validateSettings({ mode: 'direct', runMode: 'count', rounds: 1000, interval: 0.5 });
  assert.equal(valid.rounds, 1000);
  assert.equal(valid.interval, 0.5);
  assert.equal(validateSettings({ mode: 'direct', runMode: 'duration', duration: 3600 }).duration, 3600);
  for (const input of [
    { runMode: 'forever' }, { rounds: 1001 }, { rounds: 0 },
    { duration: 4 }, { duration: 3601 }, { duration: 5.5 },
    { interval: 0.4 }, { interval: 31 }, { interval: '1' }, { interval: NaN },
    { runMode: 'duration', speedTest: true },
  ]) assert.throws(() => validateSettings({ mode: 'direct', ...input }), { name: 'InputError' });
  const custom = { id: 'custom-fixture', name: 'Fixture', url: 'https://example.test/' };
  assert.deepEqual(validateSettings({ mode: 'direct', targets: [custom.id] }, {}, [...TARGETS, custom]).targets, [custom.id]);
  assert.throws(() => validateSettings({ mode: 'direct', targets: [custom.id] }), { name: 'InputError' });
});

test('long count runs cap retained samples but keep all attempts and latency metrics', async t => {
  const dataDir = await temporary(t);
  let calls = 0;
  const manager = createRunManager({ dataDir, sleepFn: async () => {}, probeFn: async target => {
    if (target.id !== 'google') return success();
    return ++calls <= 5
      ? success({ status: 'error', httpStatus: 503, ttfbMs: 1000, totalMs: 1010, message: 'HTTP 503' })
      : success();
  } });
  await manager.ready;
  const run = manager.start(settings({ rounds: 105 }));
  const done = await complete(manager, run.id);
  const result = done.results[0];
  assert.equal(done.status, 'completed');
  assert.equal(calls, 105);
  assert.equal(result.samples.length, 100);
  assert.equal(result.samples[0].index, 6);
  assert.equal(result.samples.at(-1).index, 105);
  assert.ok(result.samples.every(sample => sample.status === 'ok'));
  assert.deepEqual(result.stats, { attempts: 105, successes: 100, restricted: 0, failures: 5 });
  assert.deepEqual(done.stats, result.stats);
  assert.equal(result.status, 'restricted');
  assert.equal(result.metrics.successRate, 95);
  assert.equal(result.metrics.failureRate, 5);
  assert.equal(result.metrics.latencyMs, 143);
  assert.equal(result.metrics.jitterMs, 9);
  assert.equal(result.metrics.totalMs, 153);
  assert.deepEqual(done.metrics, result.metrics);
  assert.equal(done.progress.completed, 105);
  assert.equal(done.progress.total, 105);
});

test('authentication diagnostic runs once during repeated ChatGPT sampling and does not inflate primary totals', async t => {
  const dataDir = await temporary(t);
  const calls = [];
  const manager = createRunManager({ dataDir, sleepFn: async () => {}, probeFn: async target => {
    calls.push(target.id);
    return target.id === 'chatgpt-auth' ? success({ status: 'restricted', httpStatus: 403, message: 'HTTP 403' }) : success();
  } });
  await manager.ready;
  const run = manager.start(settings({ rounds: 3, targets: ['chatgpt'] }));
  const done = await complete(manager, run.id);
  assert.equal(calls.filter(id => id === 'chatgpt').length, 3);
  assert.equal(calls.filter(id => id === 'chatgpt-auth').length, 1);
  assert.equal(calls.filter(id => id === 'cloudflare').length, 1);
  assert.deepEqual(done.stats, { attempts: 3, successes: 3, restricted: 0, failures: 0 });
  assert.equal(done.results[0].status, 'restricted');
  assert.equal(done.progress.completed, 3);
  assert.equal(done.progress.total, 3);
});

test('duration mode repeats until deadline with count-free progress and cumulative statistics', async t => {
  const dataDir = await temporary(t);
  let clock = 1700000000000;
  const manager = createRunManager({ dataDir, nowFn: () => clock,
    sleepFn: async ms => { clock += ms; },
    probeFn: async target => { if (target.id === 'google') clock += 100; return success(); },
  });
  await manager.ready;
  const run = manager.start(settings({ runMode: 'duration', duration: 5 }));
  const done = await complete(manager, run.id);
  assert.equal(done.status, 'completed');
  assert.equal(Date.parse(done.deadlineAt) - Date.parse(done.startedAt), 5000);
  assert.equal(done.progress.total, null);
  assert.equal(done.progress.remainingMs, 0);
  assert.ok(done.progress.elapsedMs >= 5000);
  assert.ok(done.stats.attempts > 1);
  assert.equal(done.stats.attempts, done.results[0].samples.length);
  assert.equal(done.stats.failures, 0);
});

test('duration expiry aborts an outstanding request without recording an invented failure', async t => {
  const dataDir = await temporary(t);
  let aborted = 0;
  const manager = createRunManager({ dataDir, probeFn: (target, options, { signal }) => {
    if (target.id !== 'google') return Promise.resolve(success());
    return new Promise(resolve => {
      const abort = () => { aborted++; resolve({ status: 'cancelled' }); };
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
  } });
  await manager.ready;
  const run = manager.start(settings({ runMode: 'duration', duration: 5 }));
  const done = await complete(manager, run.id, 7000);
  assert.equal(done.status, 'completed');
  assert.equal(aborted, 1);
  assert.deepEqual(done.stats, { attempts: 0, successes: 0, restricted: 0, failures: 0 });
  assert.equal(done.results[0].samples.length, 0);
  assert.equal(done.progress.completed, 0);
  assert.equal(done.progress.total, null);
});

test('custom URLs default to HTTPS and reject credentials, fragments, invalid names and non-HTTP schemes', () => {
  assert.deepEqual(validateTarget({ name: ' Example ', url: 'example.test/path?q=1' }), { name: 'Example', url: 'https://example.test/path?q=1' });
  assert.equal(validateTarget({ name: 'Local', url: 'http://127.0.0.1:8080/path' }).url, 'http://127.0.0.1:8080/path');
  for (const input of [null, [], { name: '', url: 'https://example.test' },
    { name: 'x'.repeat(41), url: 'https://example.test' }, { name: 'test', url: '' },
    { name: 'test', url: 'https://user:pass@example.test/' },
    { name: 'test', url: 'ftp://example.test/' }, { name: 'test', url: 'file:///C:/Windows' },
    { name: 'test', url: 'https://example.test/#part' }, { name: 'test', url: 'https://example.test/#' },
    { name: 'test', url: 'https://example.test/' + 'x'.repeat(2048) },
  ]) assert.throws(() => validateTarget(input), { name: 'InputError' });
});

test('custom targets persist, canonical duplicates are rejected, and builtins cannot be deleted', async t => {
  const dataDir = await temporary(t);
  const store = createTargetStore({ dataDir });
  await store.ready;
  const added = await store.add({ name: 'Example', url: 'EXAMPLE.test' });
  assert.match(added.id, /^custom-/);
  assert.equal(added.url, 'https://example.test/');
  assert.equal(added.custom, true);
  await assert.rejects(store.add({ name: 'duplicate', url: 'https://example.test/' }), { name: 'InputError' });
  await assert.rejects(store.add({ name: 'builtin duplicate', url: TARGETS[0].url }), { name: 'InputError' });
  await assert.rejects(store.remove('google'), { name: 'InputError' });
  const reloaded = createTargetStore({ dataDir });
  await reloaded.ready;
  assert.ok(reloaded.list().some(target => target.id === added.id));
  const returned = reloaded.list();
  returned.find(target => target.id === added.id).url = 'https://changed.test/';
  assert.equal(reloaded.list().find(target => target.id === added.id).url, added.url);
  assert.equal(await reloaded.remove(added.id), true);
  const afterRemoval = createTargetStore({ dataDir });
  await afterRemoval.ready;
  assert.equal(afterRemoval.list().length, TARGETS.length);
});

test('custom target count is bounded and invalid saved definitions are ignored', async t => {
  const dataDir = await temporary(t);
  const store = createTargetStore({ dataDir });
  await store.ready;
  for (let i = 0; i < 20; i++) await store.add({ name: 'Site ' + i, url: `https://site-${i}.test/` });
  await assert.rejects(store.add({ name: 'overflow', url: 'https://overflow.test/' }), { name: 'InputError' });
  assert.equal(store.list().length, TARGETS.length + 20);
  await fs.writeFile(path.join(dataDir, 'targets.json'), JSON.stringify([
    { id: 'custom-safe', name: 'Safe', url: 'https://safe.test/' },
    { id: 'custom-bad', name: 'Unsafe', url: 'file:///C:/Windows' },
    { id: 'custom-dupe', name: 'Duplicate', url: 'https://safe.test/' },
    { id: 'google', name: 'Override', url: 'https://override.test/' },
  ]));
  const clean = createTargetStore({ dataDir });
  await clean.ready;
  assert.equal(clean.list().length, TARGETS.length + 1);
  assert.equal(clean.list().at(-1).id, 'custom-safe');
});

test('manager snapshots registered custom targets and rejects stale or unknown IDs', async t => {
  const dataDir = await temporary(t);
  const custom = { id: 'custom-fixture', name: 'Example', url: 'https://example.test/', custom: true };
  let targets = [...TARGETS, custom];
  const manager = createRunManager({ dataDir, targetsFn: () => targets, probeFn: async target => {
    if (target.id === custom.id) assert.equal(target.url, custom.url);
    return success();
  } });
  await manager.ready;
  const run = manager.start(settings({ targets: [custom.id] }));
  targets = [...TARGETS];
  const done = await complete(manager, run.id);
  assert.equal(done.results[0].url, custom.url);
  assert.equal(done.stats.successes, 1);
  assert.throws(() => manager.start(settings({ targets: [custom.id] })), { name: 'InputError' });
});

test('target HTTP API persists custom sites, protects builtins and locks editing during a run', async t => {
  const dataDir = await temporary(t);
  const app = createApp({ dataDir, readSystemProxyFn: async () => ({ enabled: false, proxy: '' }),
    managerOptions: { probeFn: (target, options, { signal }) => new Promise(resolve => {
      const abort = () => resolve({ status: 'cancelled' });
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    }) },
  });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  t.after(() => new Promise(resolve => { app.manager.stop(); app.server.close(resolve); app.server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const headers = { 'x-nodescope-token': app.token, 'content-type': 'application/json' };
  const response = await fetch(base + '/api/targets', { method: 'POST', headers, body: JSON.stringify({ name: 'API site', url: 'api-fixture.test' }) });
  assert.equal(response.status, 201);
  const body = await response.json();
  const added = body.target || body;
  assert.equal(added.url, 'https://api-fixture.test/');
  assert.equal((await fetch(base + '/api/targets/google', { method: 'DELETE', headers })).status, 400);
  const start = await fetch(base + '/api/runs', { method: 'POST', headers, body: JSON.stringify(settings({ targets: [added.id] })) });
  assert.equal(start.status, 201);
  const started = await start.json();
  assert.equal((await fetch(base + '/api/targets', { method: 'POST', headers, body: JSON.stringify({ name: 'Busy', url: 'busy.test' }) })).status, 409);
  assert.equal((await fetch(base + '/api/targets/' + added.id, { method: 'DELETE', headers })).status, 409);
  app.manager.cancel(started.id);
  await complete(app.manager, started.id);
  assert.equal((await fetch(base + '/api/targets/' + added.id, { method: 'DELETE', headers })).status, 200);
  assert.equal(app.targetStore.list().length, TARGETS.length);
});
