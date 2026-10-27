'use strict';

const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const runFile = promisify(execFile);
const CURL = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'curl.exe') : 'curl';

const TARGETS = [
  { id: 'chatgpt', name: 'ChatGPT', category: 'AI 服务', description: '首页与登录认证站点网络', url: 'https://chatgpt.com/', icon: 'chatgpt' },
  { id: 'cloudflare', name: 'Cloudflare', category: '网络基础设施', description: '出口 IP、地区与边缘节点', url: 'https://www.cloudflare.com/cdn-cgi/trace', icon: 'cloudflare' },
  { id: 'youtube', name: 'YouTube', category: '视频服务', description: '站点轻量连通性检测', url: 'https://www.youtube.com/generate_204', icon: 'youtube' },
  { id: 'google', name: 'Google', category: '搜索服务', description: '站点轻量连通性检测', url: 'https://www.google.com/generate_204', icon: 'google' },
];

class InputError extends Error {
  constructor(message) { super(message); this.name = 'InputError'; this.statusCode = 400; }
}

function normalizeProxy(value) {
  if (typeof value !== 'string' || !value.trim()) throw new InputError('请填写代理地址，例如 http://127.0.0.1:7890。');
  let raw = value.trim();
  if (!raw.includes('://')) raw = `http://${raw}`;
  let parsed;
  try { parsed = new URL(raw); } catch { throw new InputError('代理地址格式不正确。'); }
  if (!['http:', 'https:', 'socks5:', 'socks5h:'].includes(parsed.protocol)) throw new InputError('支持 HTTP、HTTPS 和 SOCKS5 代理。');
  if (parsed.username || parsed.password) throw new InputError('第一版暂不支持带账号密码的代理，请使用本地代理端口。');
  if (parsed.pathname !== '/' && parsed.pathname !== '' || parsed.search || parsed.hash) throw new InputError('代理地址只能包含协议、主机和端口。');
  if (!parsed.hostname || /[\s\\]/.test(parsed.hostname)) throw new InputError('代理主机地址不正确。');
  if (parsed.protocol === 'socks5:') parsed.protocol = 'socks5h:';
  return `${parsed.protocol}//${parsed.host}`;
}

function parseSystemProxy(values = {}) {
  const enabled = values.ProxyEnable === 1 || values.ProxyEnable === '0x1' || values.ProxyEnable === true;
  const raw = String(values.ProxyServer || '').trim();
  const pac = Boolean(String(values.AutoConfigURL || '').trim());
  if (!enabled || !raw) return { enabled: false, proxy: '', source: 'Windows 系统设置', note: pac ? '检测到 PAC 自动配置，第一版不解析 PAC。请手动填写代理地址，或在 TUN 模式下选择直连。' : '系统 HTTP 代理未启用。请打开代理软件的系统代理开关，或手动填写端口。使用 TUN 时可选择直连。' };
  let candidate = raw;
  if (raw.includes('=')) {
    const entries = Object.fromEntries(raw.split(';').map(part => part.trim().split(/=(.*)/s)).filter(part => part.length > 1).map(([key, value]) => [key.toLowerCase(), value]));
    candidate = entries.https || entries.http || (entries.socks ? `socks5h://${entries.socks.replace(/^\w+:\/\//, '')}` : '');
  }
  try { return { enabled: true, proxy: normalizeProxy(candidate), source: 'Windows 系统设置', note: '所有检测请求强制使用此代理；不会静默改用直连。' }; }
  catch (error) { return { enabled: false, proxy: '', source: 'Windows 系统设置', note: `无法读取系统代理：${error.message}` }; }
}

async function readSystemProxy() {
  if (process.platform !== 'win32') return { enabled: false, proxy: '', source: '当前系统', note: '当前平台请手动填写代理地址，或选择直连。' };
  try {
    const { stdout } = await runFile('reg.exe', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'], { windowsHide: true, timeout: 5000, maxBuffer: 128 * 1024 });
    const values = {};
    for (const line of stdout.split(/\r?\n/)) {
      const match = line.match(/^\s*(ProxyEnable|ProxyServer|AutoConfigURL)\s+REG_\w+\s+(.*?)\s*$/);
      if (match) values[match[1]] = match[2];
    }
    return parseSystemProxy(values);
  } catch { return { enabled: false, proxy: '', source: 'Windows 系统设置', note: '系统代理读取失败，请手动填写代理软件的本地端口。' }; }
}

function validateSettings(input, systemProxy = {}, availableTargets = TARGETS) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new InputError('检测参数不正确。');
  const mode = input.mode ?? 'system';
  if (!['system', 'manual', 'direct'].includes(mode)) throw new InputError('请选择有效的连接模式。');
  let proxy = '';
  if (mode === 'system') {
    if (!systemProxy.enabled || !systemProxy.proxy) throw new InputError(systemProxy.note || '系统代理未启用，请手动填写代理。');
    proxy = normalizeProxy(systemProxy.proxy);
  } else if (mode === 'manual') proxy = normalizeProxy(input.proxy);
  const rounds = input.rounds ?? 3;
  const timeout = input.timeout ?? 12;
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > 1000) throw new InputError('测试次数应为 1～1000 的整数。');
  if (!Number.isInteger(timeout) || timeout < 3 || timeout > 30) throw new InputError('单次超时应为 3～30 秒的整数。');
  const runMode = input.runMode ?? 'count';
  if (!['count', 'duration'].includes(runMode)) throw new InputError('请选择按次数或按时长测试。');
  const duration = input.duration ?? 60;
  const interval = input.interval ?? 1;
  if (!Number.isInteger(duration) || duration < 5 || duration > 3600) throw new InputError('持续时间应为 5～3600 秒的整数。');
  if (typeof interval !== 'number' || !Number.isFinite(interval) || interval < 0.5 || interval > 30) throw new InputError('请求间隔应为 0.5～30 秒。');
  if (runMode === 'duration' && input.speedTest === true) throw new InputError('持续检测时请关闭下载测速，以免影响延迟统计。');
  const ids = input.targets ?? availableTargets.map(target => target.id);
  if (!Array.isArray(ids) || !ids.length || ids.length > availableTargets.length || ids.some(id => !availableTargets.some(target => target.id === id)) || new Set(ids).size !== ids.length) throw new InputError('请至少选择一个有效的检测服务。');
  if (input.speedTest !== undefined && typeof input.speedTest !== 'boolean') throw new InputError('速度测试开关不正确。');
  if (input.nodeLabel !== undefined && typeof input.nodeLabel !== 'string') throw new InputError('节点备注应为文字。');
  const nodeLabel = (input.nodeLabel || '').trim();
  if (nodeLabel.length > 60) throw new InputError('节点备注最多 60 个字符。');
  return { mode, proxy, rounds, timeout, runMode, duration, interval, targets: [...ids], speedTest: input.speedTest === true, nodeLabel };
}

function classifyResponse({ exitCode, httpStatus = 0, body = '', error = '', proxyConnectCode = 0 }) {
  if (exitCode !== 0) {
    const errors = {
      5: ['PROXY_DNS', '代理主机解析失败，请检查代理地址。'],
      6: ['DNS', '目标域名解析失败。'],
      7: ['CONNECT', '无法建立连接，请检查代理是否运行及端口是否正确。'],
      28: ['TIMEOUT', '请求超时，节点可能拥堵或无法访问目标。'],
      35: ['TLS', 'TLS 握手失败。'],
      51: ['CERTIFICATE', '证书校验失败。'],
      60: ['CERTIFICATE', '证书校验失败，请检查系统时间或证书。'],
      97: ['PROXY_HANDSHAKE', '代理握手失败，请检查代理协议和端口。'],
    };
    if (exitCode === 'ABORT_ERR' || exitCode === 'CANCELLED') return { status: 'cancelled', summary: '已取消', errorCode: 'CANCELLED' };
    if (proxyConnectCode === 407 || httpStatus === 407) return { status: 'error', summary: '代理要求身份验证，第一版请使用无需认证的本地代理。', errorCode: 'PROXY_AUTH' };
    const [errorCode, summary] = errors[exitCode] || ['NETWORK', error ? `网络请求失败：${error.slice(0, 180)}` : `网络请求失败（curl ${exitCode}）。`];
    return { status: 'error', summary, errorCode };
  }
  if ([401, 403, 407, 429, 451].includes(httpStatus)) {
    const labels = { 401: '网站要求登录或验证', 403: '网站拒绝访问，可能触发风控或地区限制', 407: '代理要求身份验证', 429: '网站限制请求频率', 451: '网站返回地区或法律限制' };
    return { status: 'restricted', summary: `已收到 HTTP ${httpStatus}：${labels[httpStatus]}。`, errorCode: `HTTP_${httpStatus}` };
  }
  if (httpStatus >= 200 && httpStatus < 300) {
    if (/cf-mitigated|<title>\s*(?:Just a moment|Attention Required)|challenge-platform|unusual traffic from your computer network|our systems have detected unusual traffic/i.test(body)) return { status: 'restricted', summary: '已连接到网站，但响应包含人机验证或访问限制。', errorCode: 'CHALLENGE' };
    return { status: 'ok', summary: 'HTTPS 请求成功。', errorCode: null };
  }
  if (httpStatus >= 300 && httpStatus < 400) return { status: 'restricted', summary: `网站重定向未完成（HTTP ${httpStatus}）。`, errorCode: `HTTP_${httpStatus}` };
  return { status: 'error', summary: httpStatus ? `网站返回 HTTP ${httpStatus}。` : '未收到有效的 HTTP 响应。', errorCode: httpStatus ? `HTTP_${httpStatus}` : 'NO_RESPONSE' };
}

const mean = numbers => numbers.length ? Math.round(numbers.reduce((a, b) => a + b, 0) / numbers.length) : null;
function aggregateSamples(samples) {
  const done = samples.filter(sample => sample.status !== 'cancelled');
  const success = done.filter(sample => sample.status === 'ok');
  const responded = done.filter(sample => sample.httpStatus > 0 && Number.isFinite(sample.ttfbMs) && sample.ttfbMs > 0);
  const jitter = responded.slice(1).map((sample, index) => Math.abs(sample.ttfbMs - responded[index].ttfbMs));
  return {
    latencyMs: mean(responded.map(s => s.ttfbMs)),
    jitterMs: mean(jitter),
    successRate: done.length ? Math.round(success.length / done.length * 100) : null,
    failureRate: done.length ? Math.round(done.filter(s => s.status === 'error').length / done.length * 100) : null,
    dnsMs: mean(responded.map(s => s.dnsMs).filter(Number.isFinite)),
    connectMs: mean(responded.map(s => s.connectMs).filter(Number.isFinite)),
    tlsMs: mean(responded.map(s => s.tlsMs).filter(Number.isFinite)),
    totalMs: mean(responded.map(s => s.totalMs).filter(Number.isFinite)),
  };
}

function cleanProxyEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(http_proxy|https_proxy|all_proxy|no_proxy)$/i.test(key)) delete env[key];
  return env;
}

async function curlRequest(url, settings, { signal, speed = false } = {}) {
  if (signal?.aborted) return { exitCode: 'CANCELLED', data: {}, body: '', error: '' };
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'nodescope-'));
  const bodyFile = path.join(temporary, 'body');
  const headersFile = path.join(temporary, 'headers');
  const args = ['-q', '--silent', '--show-error', '--location', '--max-redirs', '4', '--proto', '=https,http', '--proto-redir', '=https,http', '--connect-timeout', String(Math.min(settings.timeout, 8)), '--max-time', String(settings.timeout), '--max-filesize', String(speed ? 11 * 1024 * 1024 : 2 * 1024 * 1024), '--user-agent', 'NodeScope/1.0 (local connectivity diagnostics)', '--output', bodyFile, '--dump-header', headersFile, '--write-out', '%{json}'];
  // Always override curl environment defaults, including NO_PROXY and user .curlrc.
  args.push('--proxy', settings.proxy || '', '--noproxy', settings.proxy ? '' : '*');
  args.push('--url', url);
  let timer;
  let child;
  try {
    const output = await new Promise(resolve => {
      let stdout = '', stderr = '', spawnError;
      const abort = () => child?.kill();
      child = spawn(CURL, args, { windowsHide: true, env: cleanProxyEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
      timer = setTimeout(() => child.kill(), (settings.timeout + 3) * 1000);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      child.stdout.on('data', chunk => { if (stdout.length < 128 * 1024) stdout += chunk.toString(); });
      child.stderr.on('data', chunk => { if (stderr.length < 8192) stderr += chunk.toString(); });
      child.on('error', error => { spawnError = error; });
      child.on('close', code => {
        signal?.removeEventListener('abort', abort);
        let data = {};
        try { data = JSON.parse(stdout); } catch { /* A killed or missing curl has no timing JSON. */ }
        resolve({ exitCode: signal?.aborted ? 'CANCELLED' : spawnError ? 'SPAWN' : code ?? 28, data, error: spawnError ? `无法启动系统 curl：${spawnError.message}` : stderr.trim() });
      });
    });
    let body = '', headers = '';
    if (!speed) {
      const handle = await fs.open(bodyFile, 'r').catch(() => null);
      if (handle) {
        try { const buffer = Buffer.alloc(128 * 1024); const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0); body = buffer.subarray(0, bytesRead).toString('utf8'); }
        finally { await handle.close(); }
      }
    }
    headers = (await fs.readFile(headersFile, 'utf8').catch(() => '')).slice(-16 * 1024);
    return { ...output, body, headers };
  } finally {
    clearTimeout(timer);
    await fs.rm(temporary, { recursive: true, force: true }).catch(() => {});
  }
}

const milliseconds = value => Number.isFinite(Number(value)) ? Math.max(0, Math.round(Number(value) * 1000)) : 0;
async function probe(target, settings, { signal } = {}) {
  const response = await curlRequest(target.url, settings, { signal });
  const d = response.data;
  const httpStatus = Number(d.http_code || d.response_code || 0);
  const classified = classifyResponse({ exitCode: response.exitCode, httpStatus, body: response.body + '\n' + response.headers, error: response.error, proxyConnectCode: Number(d.http_connect || 0) });
  const redirectTime = Number(d.time_redirect || 0);
  // Curl reports cumulative milestones; phase differences describe the measured request path.
  const connectCumulative = Number(d.time_connect || 0);
  const dnsCumulative = Number(d.time_namelookup || 0);
  const tlsCumulative = Number(d.time_appconnect || 0);
  const sample = {
    status: classified.status,
    httpStatus,
    ttfbMs: httpStatus ? milliseconds(d.time_starttransfer) : null,
    totalMs: milliseconds(d.time_total),
    dnsMs: milliseconds(dnsCumulative),
    connectMs: milliseconds(Math.max(0, connectCumulative - dnsCumulative)),
    tlsMs: tlsCumulative ? milliseconds(Math.max(0, tlsCumulative - connectCumulative)) : null,
    redirectMs: milliseconds(redirectTime),
    httpVersion: d.http_version || null,
    redirects: Number(d.num_redirects || 0),
    remoteIp: d.remote_ip || null,
    proxyUsed: settings.proxy ? true : false,
    bytes: Number(d.size_download || 0),
    error: response.error || null,
    errorCode: classified.errorCode,
    message: classified.summary,
  };
  if (target.id === 'cloudflare' && sample.status === 'ok') {
    const trace = Object.fromEntries(response.body.split(/\r?\n/).filter(line => /^[a-z_]+=/i.test(line)).map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)]; }));
    if (trace.ip && trace.loc && trace.colo) sample.egress = { ip: trace.ip.slice(0, 64), country: trace.loc.slice(0, 8), colo: trace.colo.slice(0, 12), tls: trace.tls?.slice(0, 32) || null, http: trace.http?.slice(0, 12) || null, warp: trace.warp?.slice(0, 16) || null };
    else { sample.status = 'restricted'; sample.message = '已收到响应，但没有有效的 Cloudflare trace 信息。'; sample.errorCode = 'UNEXPECTED_RESPONSE'; }
  }
  return sample;
}

async function probeSpeed(settings, { signal } = {}) {
  const response = await curlRequest(`https://speed.cloudflare.com/__down?bytes=10485760`, { ...settings, timeout: Math.max(settings.timeout, 20) }, { signal, speed: true });
  const code = Number(response.data.http_code || 0);
  const classified = classifyResponse({ exitCode: response.exitCode, httpStatus: code, error: response.error });
  const bytes = Number(response.data.size_download || 0);
  if (classified.status !== 'ok' || bytes !== 10485760) return { status: classified.status === 'cancelled' ? 'cancelled' : 'error', mbps: null, bytes, error: classified.status === 'ok' ? '响应大小不符合 10 MiB，无法计算有效下载速度。' : classified.summary };
  return { status: 'ok', mbps: Math.round(Number(response.data.speed_download || 0) * 8 / 1e6 * 100) / 100, bytes, error: null };
}

async function curlVersion() {
  try { const { stdout } = await runFile(CURL, ['-q', '--version'], { windowsHide: true, timeout: 5000 }); return stdout.split(/\r?\n/)[0]; }
  catch { return '系统 curl 不可用，请确认 Windows 10 / 11 已安装 curl。'; }
}

module.exports = { TARGETS, InputError, normalizeProxy, parseSystemProxy, readSystemProxy, validateSettings, classifyResponse, aggregateSamples, probe, probeSpeed, curlVersion };
