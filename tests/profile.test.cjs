const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadProfile() {
  const wrap = { appendChild(node) { this.child = node; }, querySelector: () => null };
  const node = () => ({ remove() {}, listeners: {}, addEventListener(name, fn) { this.listeners[name] = fn; }, className: '', style: {}, querySelector: () => ({ style: {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 1, height: 1 }) }), getAnimations: () => [], animate: () => ({ onfinish: null }), getBoundingClientRect: () => ({ left: 0, top: 0, width: 1, height: 1 }), set innerHTML(value) { this.html = value; }, get innerHTML() { return this.html || ''; } });
  const document = { head: { appendChild() {} }, body: {}, querySelector: () => null, querySelectorAll: () => [], getElementById: () => null, createElement: node };
  const context = vm.createContext({ URL, AbortController, DOMException, setTimeout, clearTimeout, location: { href: 'https://space.bilibili.com/123' }, document, performance: { now: () => 1 }, console, fetch: async url => url.includes('/card?') ? { json: async () => ({ code: 0, data: { card: { name: '普通账号', face: '', sign: '本账号由脚本自动运营。', level_info: { current_level: 1 }, official_verify: { type: -1, desc: '' }, follower: 1, archive_count: 1 } } }) } : { json: async () => ({ code: 0, data: { archives: [] } }) }, requestAnimationFrame: fn => fn(), chrome: undefined });
  const load = file => vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../dafeiyu-cleaner', file), 'utf8'), context, { filename: file });
  load('src/core/models.js'); load('src/core/page-session.js'); load('src/platforms/bilibili/shared.js'); load('src/core/defaults.js'); load('src/detection/common.js'); load('src/detector.js'); load('src/detection/bilibili-legacy.js');
  const D = context.DFY;
  D.esc = String; D.icon = () => ''; D.mascotCSS = ''; D.actors = { CSS: '', src: () => null }; D.lists = { block: {}, white: {} }; D.settings = { ...D.DEFAULTS.settings, enabled: true, llmEnabled: true, llmKey: 'key', llmAuto: false, llmModel: 'model-a', llmVision: false }; D.canLLM = true; D.bump = () => {}; D.ui = { root: { querySelector: () => wrap }, think: () => ({ update() {}, done() {}, close() {} }), say() {}, toast() {} }; D.sfx = { boom() {} }; D.fx = { shake() {}, emit() {} }; D.weapons = {};
  load('src/platforms/bilibili/profile.js');
  const session = D.createSession(D.bilibili, D.bilibili.getPageContext());
  session.sleep = async () => { session.assert(); };
  session.later = fn => { Promise.resolve().then(() => { if (session.active()) fn(); }); return 0; };
  const profile = D.bilibili.createProfile(session);
  const clickLLM = () => wrap.child.listeners.click({ target: { closest: () => ({ dataset: { a: 'llm' } }) } });
  return { D, profile, wrap, session, clickLLM };
}

test('Bilibili profile drops a completed review when model settings change', async () => {
  const { D, profile, wrap, session } = loadProfile();
  D.settings.llmAuto = true;
  D.callBg = async () => ({ ok: true, result: { ai: 80, reason: 'model-a review' }, ms: 1 });
  await profile.run(true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(wrap.child.html.includes('model-a review'), true);
  D.settings.llmModel = 'model-b';
  profile.rejudge();
  assert.equal(wrap.child.html.includes('model-a review'), false);
  D.settings.llmEnabled = false;
  profile.rejudge();
  assert.equal(wrap.child.html.includes('model-a review'), false);
  session.dispose();
});

test('profile invalidates each completed review on vision, enabled, key and strategy changes', async () => {
  for (const change of [
    D => { D.settings.llmVision = true; },
    D => { D.settings.llmEnabled = false; },
    D => { D.settings.llmKey = 'replacement-key'; },
    D => { D.detection.get('bilibili').version = 'next-version'; },
  ]) {
    const { D, profile, wrap, session, clickLLM } = loadProfile();
    D.callBg = async () => ({ ok: true, result: { ai: 99, reason: 'completed-review' }, ms: 1 });
    await profile.run(); await clickLLM(); await new Promise(resolve => setImmediate(resolve));
    assert.ok(wrap.child.html.includes('completed-review'));
    assert.ok(wrap.child.html.includes('线索分 86 / 99'));
    change(D); profile.rejudge();
    assert.equal(wrap.child.html.includes('completed-review'), false);
    assert.ok(wrap.child.html.includes('线索分 70 / 99'));
    session.dispose();
  }
});

test('old in-flight profile review cannot overwrite a newer request after disabling and reenabling', async () => {
  const { D, profile, wrap, session, clickLLM } = loadProfile(), requests = [];
  D.callBg = () => new Promise(resolve => requests.push(resolve));
  await profile.run(); await clickLLM();
  assert.equal(requests.length, 1);
  D.settings.llmEnabled = false; profile.rejudge();
  D.settings.llmEnabled = true; profile.rejudge(); await clickLLM();
  assert.equal(requests.length, 2);
  requests[0]({ ok: true, result: { ai: 99, reason: 'stale-review' }, ms: 1 });
  await new Promise(resolve => setImmediate(resolve)); await clickLLM();
  assert.equal(requests.length, 2, 'old finally must not clear the newer request lock');
  assert.equal(wrap.child.html.includes('stale-review'), false);
  requests[1]({ ok: true, result: { ai: 85, reason: 'fresh-review' }, ms: 1 });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(wrap.child.html.includes('fresh-review')); session.dispose();
});

test('profile review is ignored after page session disposal', async () => {
  const { D, profile, wrap, session, clickLLM } = loadProfile(); let resolve;
  D.callBg = () => new Promise(done => { resolve = done; });
  await profile.run(); await clickLLM(); session.dispose();
  const html = wrap.child.html;
  resolve({ ok: true, result: { ai: 99, reason: 'after-disposal' }, ms: 1 });
  await new Promise(done => setImmediate(done)); assert.equal(wrap.child.html, html);
});
