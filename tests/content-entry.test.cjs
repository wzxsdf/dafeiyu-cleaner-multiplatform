const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

test('content entry resumes repeated BFCache visits, cancels old work and respects settings while suspended', async () => {
  const listeners = new Map(), timers = new Set(), timeouts = new Map(), sessions = [];
  let storeChanged, observerActive = false, starts = 0, timerId = 0;
  const window = { addEventListener: (type, fn) => { const list = listeners.get(type) || []; list.push(fn); listeners.set(type, list); }, top: null };
  window.top = window;
  const document = { head: { appendChild() {} }, body: { appendChild() {} }, documentElement: { appendChild() {} }, getElementById: () => null, createElement: () => ({}) };
  const platform = { id: 'douyin', getCapabilities: () => ({}), start(session) { starts++; observerActive = true; session.signal.addEventListener('abort', () => { observerActive = false; }); }, dispose() { observerActive = false; }, createProfile: () => null };
  const D = {
    platform, platformContext: { platform: 'douyin', pageKey: 'video:1' }, platformStatus: {}, DEFAULTS: { settings: { enabled: true } },
    settings: {}, lists: {}, booted: false, canLLM: false, memory: { load: async () => {}, flush: async () => {} },
    store: { get: async keys => keys.includes('settings') ? { settings: { enabled: true }, blocklist: {}, whitelist: {} } : {}, onChange: fn => { storeChanged = fn; } },
    effectiveSettings: settings => ({ enabled: true, showMascot: false, quiet: true, ...settings }),
    ui: { mount() {}, look() {}, show() {}, setCount() {}, setCustom() {}, say() {} },
    createCommentController: () => ({ hasComments: () => false, stats: () => ({}), render() {}, rejudgeAll() {}, snap() {}, rescan() {}, llmPage() {} }),
    refreshPlatformContext: () => false, icon: () => '', say: () => '',
  };
  const context = vm.createContext({ DFY: D, window, document, AbortController, DOMException, crypto: webcrypto, location: { href: 'https://www.douyin.com/video/1' }, setInterval: fn => { const id = { fn }; timers.add(id); return id; }, clearInterval: id => timers.delete(id), setTimeout: fn => { timeouts.set(++timerId, fn); return timerId; }, clearTimeout: id => timeouts.delete(id), console });
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../dafeiyu-cleaner/src/core/page-session.js'), 'utf8'), context);
  const create = D.createSession;
  D.createSession = (...args) => { const session = create(...args); sessions.push(session); return session; };
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../dafeiyu-cleaner/src/content.js'), 'utf8'), context);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sessions.length, 1);
  const pagehide = listeners.get('pagehide')[0], pageshow = listeners.get('pageshow')[0];
  let oldWrites = 0;
  D.session.later(() => oldWrites++, 10);
  const sleepRejected = assert.rejects(D.session.sleep(50), { name: 'AbortError' });
  pagehide({ persisted: true });
  await sleepRejected;
  assert.equal(timers.size, 0);
  assert.equal(timeouts.size, 0);
  assert.equal(observerActive, false);
  pageshow({ persisted: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sessions.length, 2);
  assert.notEqual(sessions[0].sessionId, sessions[1].sessionId);
  assert.equal(timers.size, 1);
  assert.equal(observerActive, true);
  assert.equal(oldWrites, 0);
  pageshow({ persisted: true });
  assert.equal(sessions.length, 2);
  pagehide({ persisted: true });
  pageshow({ persisted: true });
  assert.equal(sessions.length, 3);
  assert.equal(timers.size, 1); assert.equal(starts, 3);
  pagehide({ persisted: true });
  storeChanged({ settings: { enabled: false } });
  assert.equal(starts, 3);
  pageshow({ persisted: true });
  assert.equal(sessions.length, 4); assert.equal(starts, 3); assert.equal(observerActive, false);
  assert.equal(timers.size, 1);
  storeChanged({ settings: { enabled: true } });
  assert.equal(sessions.length, 5); assert.equal(starts, 4); assert.equal(observerActive, true);
  assert.equal(sessions[3].active(), false);
  D.refreshPlatformContext = () => {
    D.platformContext = { platform: 'douyin', pageKey: 'video:2' };
    D.refreshPlatformContext = () => false;
    return true;
  };
  D.checkRoute();
  assert.equal(sessions.length, 6); assert.equal(starts, 5);
  assert.equal(sessions[4].active(), false); assert.equal(D.session.pageKey, 'video:2');
  assert.equal(timers.size, 1);
  pagehide({ persisted: false });
  pageshow({ persisted: false });
  assert.equal(sessions.length, 6);
  assert.equal(timers.size, 0);
  assert.equal(listeners.get('pageshow').length, 1);
  assert.equal(listeners.get('pagehide').length, 1);
});
