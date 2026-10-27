'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { TARGETS, InputError } = require('./probe.cjs');

function validateTarget(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new InputError('测试网址参数不正确。');
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name || name.length > 40) throw new InputError('请输入 1～40 个字符的网站名称。');
  if (typeof input.url !== 'string' || input.url.trim().length > 2048 || !input.url.trim()) throw new InputError('请输入有效的网址，最多 2048 个字符。');
  let raw = input.url.trim();
  if (!raw.includes('://')) raw = 'https://' + raw;
  let url;
  try { url = new URL(raw); } catch { throw new InputError('网址格式不正确，例如 https://example.com/。'); }
  if (!['https:', 'http:'].includes(url.protocol)) throw new InputError('测试网址仅支持 HTTP 和 HTTPS。');
  if (url.username || url.password) throw new InputError('测试网址不能包含账号或密码。');
  if (url.hash || raw.includes('#')) throw new InputError('请去掉网址中的 # 片段。');
  if (!url.hostname) throw new InputError('请输入完整的网站地址。');
  return { name, url: url.href };
}

function createTargetStore({ dataDir }) {
  let custom = [];
  let writing = Promise.resolve();
  const file = path.join(dataDir, 'targets.json');
  const ready = fs.readFile(file, 'utf8').then(text => {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) {
      const urls = new Set(TARGETS.map(target => target.url));
      for (const item of parsed.slice(0, 20)) {
        try {
          const clean = validateTarget(item);
          if (typeof item.id === 'string' && /^custom-[\w-]+$/.test(item.id) && !urls.has(clean.url) && !custom.some(target => target.id === item.id)) {
            custom.push({ id: item.id, ...clean, category: '自定义', description: '自定义 HTTP 检测', icon: 'globe', custom: true });
            urls.add(clean.url);
          }
        } catch { /* Ignore invalid saved targets, retain usable definitions. */ }
      }
    }
  }).catch(() => {});
  const list = () => [...TARGETS.map(target => ({ ...target, custom: false })), ...custom.map(target => ({ ...target }))];
  function mutate(operation) {
    writing = writing.catch(() => {}).then(async () => {
      await ready;
      const next = [...custom];
      const value = operation(next);
      await fs.mkdir(dataDir, { recursive: true });
      await fs.writeFile(file + '.tmp', JSON.stringify(next, null, 2), { mode: 0o600 });
      await fs.rename(file + '.tmp', file);
      custom = next;
      return value;
    });
    return writing;
  }
  const add = input => mutate(next => {
    const clean = validateTarget(input);
    if (next.length >= 20) throw new InputError('最多添加 20 个自定义网站。');
    if ([...TARGETS, ...next].some(target => target.url === clean.url)) throw new InputError('这个测试网址已经存在。');
    const target = { id: 'custom-' + randomUUID(), ...clean, category: '自定义', description: '自定义 HTTP 检测', icon: 'globe', custom: true };
    next.push(target);
    return { ...target };
  });
  const remove = id => mutate(next => {
    if (TARGETS.some(target => target.id === id)) throw new InputError('内置测试服务不能删除，可以取消勾选。');
    const index = next.findIndex(target => target.id === id);
    if (index < 0) throw new InputError('找不到这个自定义网站。');
    next.splice(index, 1);
    return true;
  });
  return { ready, list, add, remove };
}
module.exports = { createTargetStore, validateTarget };
