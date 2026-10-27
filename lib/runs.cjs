'use strict';
const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { TARGETS, InputError, aggregateSamples, probe, probeSpeed } = require('./probe.cjs');

function abortableSleep(ms, { signal } = {}) {
  if (signal?.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
    if (signal?.aborted) done();
  });
}

function createAccumulator() {
  const stats = { attempts: 0, successes: 0, restricted: 0, failures: 0 };
  const totals = {};
  const counts = {};
  const previousLatencies = new Map();
  let jitterSum = 0, jitterCount = 0;
  function add(sample, key = "default") {
    if (sample.status === 'cancelled') return;
    stats.attempts++;
    if (sample.status === 'ok') stats.successes++;
    else if (sample.status === 'restricted') stats.restricted++;
    else stats.failures++;
    if (sample.httpStatus > 0 && Number.isFinite(sample.ttfbMs)) {
      for (const [field, value] of Object.entries({ latencyMs: sample.ttfbMs, dnsMs: sample.dnsMs, connectMs: sample.connectMs, tlsMs: sample.tlsMs, totalMs: sample.totalMs })) {
        if (Number.isFinite(value)) { totals[field] = (totals[field] || 0) + value; counts[field] = (counts[field] || 0) + 1; }
      }
      if (previousLatencies.has(key)) { jitterSum += Math.abs(sample.ttfbMs - previousLatencies.get(key)); jitterCount++; }
      previousLatencies.set(key, sample.ttfbMs);
    }
  }
  function metrics() {
    const result = aggregateSamples([]);
    for (const field of ['latencyMs', 'dnsMs', 'connectMs', 'tlsMs', 'totalMs']) result[field] = counts[field] ? Math.round(totals[field] / counts[field]) : null;
    result.jitterMs = jitterCount ? Math.round(jitterSum / jitterCount) : null;
    result.successRate = stats.attempts ? Math.round(stats.successes / stats.attempts * 100) : null;
    result.failureRate = stats.attempts ? Math.round(stats.failures / stats.attempts * 100) : null;
    return result;
  }
  return { stats, add, metrics };
}

function createRunManager({ dataDir, probeFn = probe, speedFn = probeSpeed, targetsFn = () => TARGETS, sleepFn = abortableSleep, nowFn = Date.now } = {}) {
  const runs = new Map();
  let history = [], active = null, persistence = Promise.resolve();
  const historyFile = path.join(dataDir, 'history.json');
  const ready = fs.readFile(historyFile, 'utf8').then(text => {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) history = parsed.filter(run => run && typeof run.id === 'string' && Array.isArray(run.results)).slice(0, 50);
  }).catch(() => {});
  const addEvent = (run, message, level = 'info') => {
    run.events.push({ time: new Date(nowFn()).toISOString(), level, message });
    if (run.events.length > 200) run.events.shift();
  };
  function updateProgress(run) {
    const end = run.finishedAt ? Date.parse(run.finishedAt) : nowFn();
    run.progress.elapsedMs = Math.max(0, end - Date.parse(run.startedAt));
    run.progress.remainingMs = run.deadlineAt ? Math.max(0, Date.parse(run.deadlineAt) - end) : null;
    return run;
  }
  function persist() {
    const serialized = JSON.stringify(history, null, 2);
    persistence = persistence.catch(() => {}).then(async () => {
      await fs.mkdir(dataDir, { recursive: true });
      await fs.writeFile(historyFile + '.tmp', serialized, { mode: 0o600 });
      await fs.rename(historyFile + '.tmp', historyFile);
    });
    return persistence;
  }
  async function execute(run, context) {
    const { controller, snapshot } = context;
    const signal = controller.signal, settings = run.settings;
    const selected = snapshot.filter(target => settings.targets.includes(target.id));
    const overall = createAccumulator();
    const durationMode = settings.runMode === 'duration';
    const deadline = run.deadlineAt ? Date.parse(run.deadlineAt) : null;
    const expire = () => {
      if (!controller.signal.aborted) { context.stopReason = 'deadline'; controller.abort(); }
    };
    const beforeDeadline = () => {
      if (durationMode && nowFn() >= deadline) expire();
      return !signal.aborted;
    };
    const deadlineTimer = durationMode ? setTimeout(expire, Math.max(0, deadline - nowFn())) : null;
    const testService = async target => {
      const result = run.results.find(item => item.id === target.id);
      const accumulator = createAccumulator();
      result.status = 'running';
      let attempts = 0;
      while (beforeDeadline() && (durationMode || attempts < settings.rounds)) {
        const sample = await probeFn(target, settings, { signal });
        if (signal.aborted || sample.status === 'cancelled') break;
        sample.index = ++attempts;
        result.samples.push(sample);
        if (result.samples.length > 100) result.samples.shift();
        accumulator.add(sample); overall.add(sample, target.id);
        result.stats = { ...accumulator.stats }; result.metrics = accumulator.metrics();
        run.stats = { ...overall.stats }; run.metrics = overall.metrics();
        run.progress.completed++;
        if (sample.egress) run.egress = sample.egress;
        addEvent(run, `${target.name} #${attempts} · ${sample.message}${sample.ttfbMs != null ? ` (${sample.ttfbMs} ms)` : ''}`, sample.status === 'ok' ? 'success' : sample.status === 'restricted' ? 'warning' : 'error');
        if (target.id === 'chatgpt' && attempts === 1 && beforeDeadline()) {
          const authTarget = { id: 'chatgpt-auth', name: '登录认证站点', url: 'https://auth.openai.com/' };
          const diagnostic = await probeFn(authTarget, settings, { signal });
          if (!signal.aborted && diagnostic.status !== 'cancelled') {
            result.diagnostics = [{ ...authTarget, ...diagnostic }];
            addEvent(run, `ChatGPT 认证站点 · ${diagnostic.message}`, diagnostic.status === 'ok' ? 'success' : 'warning');
          }
        }
        if (beforeDeadline() && (durationMode || attempts < settings.rounds)) {
          const remaining = durationMode ? Math.max(0, deadline - nowFn()) : Infinity;
          await sleepFn(Math.min(settings.interval * 1000, remaining), { signal });
        }
      }
      const s = accumulator.stats;
      if (!s.attempts) { result.status = context.stopReason === 'deadline' ? 'waiting' : 'cancelled'; result.summary = context.stopReason === 'deadline' ? '持续时间已到，没有完成有效请求。' : '已停止'; return; }
      result.status = s.failures === s.attempts ? 'error' : s.failures || s.restricted ? 'restricted' : 'ok';
      result.summary = `${s.successes}/${s.attempts} 次成功` + (s.restricted ? `，${s.restricted} 次访问受限` : '') + (s.failures ? `，${s.failures} 次请求失败` : '') + '。';
      if (s.failures === s.attempts && result.samples.at(-1)?.message) result.summary += ' ' + result.samples.at(-1).message;
      const auth = result.diagnostics?.[0];
      if (auth && auth.status !== 'ok') { if (result.status === 'ok') result.status = 'restricted'; result.summary += ` 认证站点：${auth.message}`; }
    };
    try {
      const jobs = selected.map(target => testService(target).catch(error => { controller.abort(); throw error; }));
      if (!settings.targets.includes('cloudflare')) jobs.push((async () => {
        const sample = await probeFn(TARGETS.find(target => target.id === 'cloudflare'), settings, { signal });
        if (sample.egress) run.egress = sample.egress;
        else if (!signal.aborted) addEvent(run, `出口信息未获取：${sample.message}`, 'warning');
      })());
      const outcomes = await Promise.allSettled(jobs);
      const failed = outcomes.find(outcome => outcome.status === 'rejected');
      if (failed) throw failed.reason;
      if (settings.speedTest && !signal.aborted) {
        run.speed = { status: 'running', mbps: null, bytes: 0, error: null };
        addEvent(run, '开始 10 MiB 下载测试。');
        run.speed = await speedFn(settings, { signal });
        addEvent(run, run.speed.status === 'ok' ? `下载样本速度 ${run.speed.mbps} Mbps。` : run.speed.error || '下载测试已取消。', run.speed.status === 'ok' ? 'success' : 'warning');
      }
      if (signal.aborted && run.speed && ['waiting', 'running'].includes(run.speed.status)) run.speed = { status: 'cancelled', mbps: null, bytes: 0, error: '下载测试已取消。' };
      run.status = context.stopReason === 'user' ? 'cancelled' : 'completed';
      addEvent(run, context.stopReason === 'deadline' ? '指定测试时间已到，已保留全部完成样本的统计。' : signal.aborted ? '检测已停止，保留已完成的样本。' : '本次检测完成。');
    } catch (error) {
      run.status = context.stopReason === 'user' ? 'cancelled' : 'failed';
      controller.abort();
      addEvent(run, `检测中断：${error.message}`, 'error');
      for (const result of run.results) if (['running', 'waiting'].includes(result.status)) { result.status = 'error'; result.summary = '检测意外中断，请重试。'; }
    } finally {
      clearTimeout(deadlineTimer);
      run.finishedAt = new Date(nowFn()).toISOString();
      updateProgress(run);
      if (durationMode) run.progress.remainingMs = 0;
      active = null;
      history.unshift(JSON.parse(JSON.stringify(run)));
      history = history.slice(0, 50);
      while (runs.size > 20) runs.delete(runs.keys().next().value);
      try { await persist(); } catch { addEvent(run, '本地历史写入失败，本次结果仍可导出。', 'warning'); }
    }
  }
  function start(input) {
    if (active) { const error = new InputError('已有检测正在进行，请等待完成或先停止。'); error.statusCode = 409; throw error; }
    const settings = { runMode: 'count', duration: 60, interval: 1, ...input };
    const snapshot = targetsFn();
    const selected = snapshot.filter(target => settings.targets.includes(target.id));
    if (!selected.length || selected.length !== settings.targets.length) throw new InputError('检测网站列表已变化，请重新选择。');
    const id = randomUUID(), started = nowFn();
    const run = { id, status: 'running', startedAt: new Date(started).toISOString(), deadlineAt: settings.runMode === 'duration' ? new Date(started + settings.duration * 1000).toISOString() : null, finishedAt: null, settings, progress: { completed: 0, total: settings.runMode === 'duration' ? null : settings.targets.length * settings.rounds, elapsedMs: 0, remainingMs: settings.runMode === 'duration' ? settings.duration * 1000 : null }, stats: { attempts: 0, successes: 0, restricted: 0, failures: 0 }, metrics: aggregateSamples([]), results: selected.map(target => ({ id: target.id, name: target.name, url: target.url, status: 'waiting', summary: '等待检测', stats: { attempts: 0, successes: 0, restricted: 0, failures: 0 }, metrics: aggregateSamples([]), samples: [] })), events: [], egress: null, speed: settings.speedTest ? { status: 'waiting', mbps: null, bytes: 0, error: null } : null };
    const context = { id, controller: new AbortController(), stopReason: null, snapshot };
    runs.set(id, run); active = context;
    addEvent(run, `${settings.runMode === 'duration' ? `持续 ${settings.duration} 秒` : `每项 ${settings.rounds} 次`} · 通过${settings.mode === 'direct' ? '直连 / TUN 网络' : settings.proxy}检测。`);
    setImmediate(() => execute(run, context));
    return run;
  }
  function cancel(id) {
    if (active?.id !== id) return false;
    active.stopReason = 'user'; active.controller.abort(); return true;
  }
  return { ready, start, cancel, get: id => { const run = runs.get(id) || history.find(item => item.id === id); return run ? updateProgress(run) : undefined; }, getHistory: () => history, getActive: () => active ? updateProgress(runs.get(active.id)) : null, stop: () => active && cancel(active.id) };
}
module.exports = { createRunManager, createAccumulator, abortableSleep };
