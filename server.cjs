'use strict';

const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes, timingSafeEqual } = require('node:crypto');
const { spawn } = require('node:child_process');
const { TARGETS, InputError, readSystemProxy, validateSettings, curlVersion } = require('./lib/probe.cjs');
const { createRunManager } = require('./lib/runs.cjs');
const { createTargetStore } = require('./lib/targets.cjs');

function createApp({ dataDir = path.join(__dirname, 'data'), readSystemProxyFn = readSystemProxy, managerOptions = {} } = {}) {
  const token = randomBytes(32).toString('hex');
  const targetStore = createTargetStore({ dataDir });
  const manager = createRunManager({ ...managerOptions, dataDir, targetsFn: () => targetStore.list() });
  let lastHeartbeat = Date.now();
  let hasHeartbeat = false;
  const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); };
  async function readJson(req) {
    if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw new InputError('请求必须使用 JSON 格式。');
    let bytes = 0, chunks = [];
    for await (const chunk of req) { bytes += chunk.length; if (bytes > 16384) { const error = new InputError('请求体过大。'); error.statusCode = 413; throw error; } chunks.push(chunk); }
    try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { throw new InputError('JSON 格式不正确。'); }
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
      const host = req.headers.host || '';
      const port = server.address()?.port;
      if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(host)) return json(res, 403, { error: '禁止访问此主机。' });
      const url = new URL(req.url, `http://${host}`);
      if (url.pathname.startsWith('/api/')) {
        const provided = Buffer.from(String(req.headers['x-nodescope-token'] || ''));
        const expected = Buffer.from(token);
        if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return json(res, 403, { error: '会话已失效，请刷新应用。' });
        if (req.headers['sec-fetch-site'] === 'cross-site') return json(res, 403, { error: '不接受跨站请求。' });
        if (req.headers.origin && req.headers.origin !== `http://${host}`) return json(res, 403, { error: '不接受跨域请求。' });
        if (req.method === 'GET' && url.pathname === '/api/bootstrap') {
          const [systemProxy, version] = await Promise.all([readSystemProxyFn(), curlVersion(), targetStore.ready]);
          return json(res, 200, { app: { name: 'NodeScope', version: '1.0.0' }, defaults: { mode: 'system', proxy: systemProxy.proxy || 'http://127.0.0.1:7890', rounds: 3, timeout: 12, runMode: 'count', duration: 60, interval: 1 }, systemProxy, targets: targetStore.list(), runtime: { curlVersion: version }, activeRun: manager.getActive() });
        }
        if (req.method === 'GET' && url.pathname === '/api/history') { await manager.ready; return json(res, 200, { runs: manager.getHistory() }); }
        if (req.method === 'POST' && url.pathname === '/api/runs') {
          const input = await readJson(req);
          const systemProxy = input.mode === 'manual' || input.mode === 'direct' ? {} : await readSystemProxyFn();
          await Promise.all([manager.ready, targetStore.ready]);
          const settings = validateSettings(input, systemProxy, targetStore.list());
          const run = manager.start(settings);
          return json(res, 201, { id: run.id });
        }
        if (req.method === 'GET' && url.pathname === '/api/targets') { await targetStore.ready; return json(res, 200, { targets: targetStore.list() }); }
        if (req.method === 'POST' && url.pathname === '/api/targets') {
          const input = await readJson(req);
          if (manager.getActive()) return json(res, 409, { error: '请先停止检测，再添加测试网站。' });
          const target = await targetStore.add(input);
          return json(res, 201, { target });
        }
        const targetMatch = url.pathname.match(/^\/api\/targets\/([\w-]+)$/);
        if (req.method === 'DELETE' && targetMatch) {
          if (manager.getActive()) return json(res, 409, { error: '请先停止检测，再移除测试网站。' });
          await targetStore.remove(targetMatch[1]);
          return json(res, 200, { deleted: true });
        }
        if (req.method === 'POST' && url.pathname === '/api/heartbeat') { hasHeartbeat = true; lastHeartbeat = Date.now(); return json(res, 200, { ok: true }); }
        const match = url.pathname.match(/^\/api\/runs\/([\w-]+)(\/cancel)?$/);
        if (match && req.method === 'GET' && !match[2]) {
          await manager.ready;
          const run = manager.get(match[1]);
          return run ? json(res, 200, run) : json(res, 404, { error: '找不到该次检测。' });
        }
        if (match && req.method === 'POST' && match[2]) return json(res, 200, { cancelled: manager.cancel(match[1]) });
        return json(res, 404, { error: '接口不存在。' });
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: '请求方法不支持。' });
      const files = { '/': ['index.html', 'text/html; charset=utf-8'], '/index.html': ['index.html', 'text/html; charset=utf-8'], '/styles.css': ['styles.css', 'text/css; charset=utf-8'], '/app.js': ['app.js', 'application/javascript; charset=utf-8'], '/favicon.svg': ['favicon.svg', 'image/svg+xml'] };
      const file = files[url.pathname];
      if (!file) return json(res, 404, { error: '文件不存在。' });
      let content = await fs.readFile(path.join(__dirname, 'public', file[0]));
      if (file[0] === 'index.html') content = Buffer.from(content.toString().replaceAll('__SESSION_TOKEN__', token));
      res.writeHead(200, { 'Content-Type': file[1] });
      res.end(req.method === 'HEAD' ? undefined : content);
    } catch (error) {
      if (!res.headersSent) json(res, error.statusCode || 500, { error: error instanceof InputError ? error.message : '本地服务发生错误，请重试或重新启动。' });
      else res.end();
    }
  });
  server.requestTimeout = 20000;
  server.headersTimeout = 10000;
  return { server, manager, targetStore, token, heartbeat: () => ({ lastHeartbeat, hasHeartbeat }) };
}

async function openDesktop(url) {
  if (process.platform !== 'win32') return;
  const candidates = [
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ];
  for (const browser of candidates) {
    if (await fs.access(browser).then(() => true, () => false)) {
      const child = spawn(browser, [`--app=${url}`, '--window-size=1060,800'], { detached: true, windowsHide: true, stdio: 'ignore' });
      child.on('error', () => {});
      child.unref();
      return;
    }
  }
  const child = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { detached: true, windowsHide: true, stdio: 'ignore' });
  child.on('error', () => {}); child.unref();
}

async function main() {
  const desktop = process.argv.includes('--desktop');
  const app = createApp();
  const preferred = Number(process.env.NODESCOPE_PORT || 47831);
  const listen = port => new Promise((resolve, reject) => {
    const onError = error => { app.server.removeListener('listening', onListening); reject(error); };
    const onListening = () => { app.server.removeListener('error', onError); resolve(); };
    app.server.once('error', onError); app.server.once('listening', onListening); app.server.listen(port, '127.0.0.1');
  });
  try { await listen(preferred); }
  catch (error) {
    if (error.code === 'EADDRINUSE' && desktop) {
      // Recognize this app before reusing an occupied port.
      const existing = await fetch(`http://127.0.0.1:${preferred}/`, { signal: AbortSignal.timeout(1500) }).then(r => r.text()).catch(() => '');
      if (existing.includes('NodeScope') && existing.includes('nodescope-token')) { await openDesktop(`http://127.0.0.1:${preferred}/`); return; }
      await listen(0);
    } else throw error;
  }
  const url = `http://127.0.0.1:${app.server.address().port}/`;
  console.log(`NodeScope listening at ${url}`);
  if (desktop) {
    await openDesktop(url);
    const started = Date.now();
    const interval = setInterval(() => {
      const { lastHeartbeat, hasHeartbeat } = app.heartbeat();
      const expired = hasHeartbeat ? Date.now() - lastHeartbeat > 75000 : Date.now() - started > 180000;
      if (expired && !app.manager.getActive()) { clearInterval(interval); app.server.close(); app.server.closeIdleConnections(); }
    }, 10000);
    app.server.on('close', () => clearInterval(interval));
  }
  const stop = () => { app.manager.stop(); app.server.close(); app.server.closeIdleConnections(); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
}

if (require.main === module) main().catch(error => { console.error(`NodeScope 启动失败：${error.message}`); process.exitCode = 1; });
module.exports = { createApp };
