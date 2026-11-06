const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '../dafeiyu-cleaner');
const tick = () => new Promise(resolve => setImmediate(resolve));
async function settle() { for (let n = 0; n < 8; n++) await tick(); }

function element() {
  const classes = new Set();
  return {
    value: '', textContent: '', innerHTML: '', checked: false, disabled: false, dataset: {}, children: [],
    classList: { contains: name => classes.has(name), add: name => classes.add(name), remove: name => classes.delete(name), toggle(name, on) { if (on ?? !classes.has(name)) classes.add(name); else classes.delete(name); } },
    insertAdjacentHTML() {}, appendChild() {}, querySelector: () => null,
  };
}

function backend() {
  let data = {}, owner, fail = false;
  const subscribers = [];
  const local = {
    get: async () => structuredClone(data),
    async set(update) {
      if (fail) throw new Error('disk failure');
      Object.assign(data, structuredClone(update));
      const changes = Object.fromEntries(Object.entries(update).map(([key, value]) => [key, { newValue: structuredClone(value) }]));
      for (const fn of subscribers) fn(changes, 'local');
    },
  };
  return {
    attach(D) { owner ||= D.createStorageEngine(local); },
    restart(D) { owner = D.createStorageEngine(local); },
    fail(value) { fail = value; }, data: () => structuredClone(data),
    chrome: {
      storage: { local, onChanged: { addListener: fn => subscribers.push(fn) } },
      runtime: {
        id: 'test', getURL: p => 'chrome-extension://test/' + p,
        sendMessage(msg, cb) { owner.request(msg).then(cb, error => cb({ ok: false, error: error.message })); },
      },
      tabs: { query: async () => [] },
    },
  };
}

async function panel(back) {
  const html = fs.readFileSync(path.join(root, 'popup/popup.html'), 'utf8');
  const els = Object.fromEntries([...html.matchAll(/\bid="([^"]+)"/g)].map(match => [match[1], element()]));
  const panels = ['detect', 'ds', 'lists', 'look'].map(name => ({ ...element(), dataset: { panel: name } }));
  els.tabs.children = panels.map(p => ({ ...element(), dataset: { tab: p.dataset.panel } }));
  for (const [id, values] of Object.entries({ mode: ['mark', 'fold', 'auto'], weapon: ['random', 'slap', 'gatling', 'broom', 'sock', 'rice'] })) {
    els[id].children = values.map(value => ({ ...element(), dataset: { v: value } }));
  }
  const listeners = {};
  const document = {
    activeElement: null, body: element(), head: element(), getElementById: id => els[id], createElement: element,
    querySelector: selector => selector === '[data-panel=detect]' ? panels[0] : selector === '.ds' ? panels[1] : element(),
    querySelectorAll: selector => selector === '.panel' ? panels : [],
    addEventListener: (type, fn) => { listeners[type] = fn; },
  };
  const context = vm.createContext({ URL, Blob, console, structuredClone, document, chrome: back.chrome,
    location: { search: '' }, window: { innerWidth: 400 }, localStorage: { getItem: () => null, setItem() {} }, setTimeout: () => 1, clearTimeout() {}, setInterval() {} });
  for (const file of ['src/core/models.js', 'src/platforms/bilibili/shared.js', 'src/platforms/douyin/shared.js', 'src/core/defaults.js', 'src/core/storage-engine.js', 'src/core/list-codec.js']) {
    vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context);
  }
  back.attach(context.DFY);
  vm.runInContext(fs.readFileSync(path.join(root, 'src/storage.js'), 'utf8'), context);
  Object.assign(context.DFY, { mascotCSS: '', icon: () => '', say: () => '', mascotSVG: () => '' });
  await vm.runInContext(fs.readFileSync(path.join(root, 'popup/popup.js'), 'utf8'), context);
  return { D: context.DFY, els, document, listeners };
}

test('two settings panels save only edited fields, sync external changes and survive owner/panel restart', async () => {
  const back = backend(), a = await panel(back), b = await panel(back);
  a.els.quiet.checked = true; a.els.quiet.onchange();
  b.els.sound.checked = false; b.els.sound.onchange();
  await settle();
  assert.equal(back.data().settings.quiet, true);
  assert.equal(back.data().settings.sound, false);
  assert.equal(b.els.quiet.checked, true); assert.equal(a.els.sound.checked, false);
  back.restart(a.D);
  const reloaded = await panel(back);
  assert.equal(reloaded.els.quiet.checked, true); assert.equal(reloaded.els.sound.checked, false);
  assert.equal(reloaded.els.mode.children.find(b => b.dataset.v === 'auto').disabled, true);
});

test('rapid slider edits keep their order and storage failure reports failure without claiming success', async () => {
  const back = backend(), p = await panel(back);
  for (const size of [110, 120, 130]) { p.els.mascotSize.value = size; p.els.mascotSize.oninput(); }
  await settle();
  assert.equal(back.data().settings.mascotSize, 130);
  assert.equal(p.els['save-status'].textContent, '设置已保存到本机');
  back.fail(true);
  p.els.quiet.checked = true; p.els.quiet.onchange();
  await settle();
  assert.equal(back.data().settings.quiet, false);
  assert.equal(p.els.quiet.checked, false);
  assert.match(p.els['save-status'].textContent, /保存失败/);
  back.fail(false);
  p.els.quiet.checked = true; p.els.quiet.onchange();
  await settle();
  assert.equal(back.data().settings.quiet, true);
});

test('list removal stays platform scoped, persists across restart and does not lie on failure', async () => {
  const back = backend(), p = await panel(back);
  await p.D.store.listAction('bilibili:1', { n: '同名', t: 1 }, 'block');
  await p.D.store.listAction('douyin:1', { n: '同名', t: 1 }, 'block');
  assert.match(p.els.bl.innerHTML, /抖音/); assert.match(p.els.bl.innerHTML, /B 站/);
  back.fail(true);
  await p.listeners.click({ target: { dataset: { un: 'douyin:1' } } });
  assert.ok(back.data().blocklist['douyin:1']);
  assert.match(p.els.bl.innerHTML, /data-un="douyin:1"/);
  assert.match(p.els['save-status'].textContent, /保存失败/);
  back.fail(false);
  await p.listeners.click({ target: { dataset: { un: 'douyin:1' } } });
  await p.D.store.listAction('douyin:1', { n: '同名', t: 1 }, 'white');
  back.restart(p.D);
  const reloaded = await panel(back);
  assert.match(reloaded.els.bl.innerHTML, /data-un="bilibili:1"/);
  assert.doesNotMatch(reloaded.els.bl.innerHTML, /data-un="douyin:1"/);
  assert.match(reloaded.els.wl.innerHTML, /data-unw="douyin:1"/);
});

test('external settings refresh preserves an API key being edited until it is saved', async () => {
  const back = backend(), p = await panel(back);
  p.document.activeElement = p.els.llmKey; p.els.llmKey.value = 'draft-test-key';
  await p.D.store.patch('settings', s => { s.sound = false; });
  assert.equal(p.els.llmKey.value, 'draft-test-key');
  p.document.activeElement = null; p.els.llmKey.onchange();
  await settle();
  assert.equal(back.data().settings.llmKey, 'draft-test-key');
});

test('popup import merges current lists, preserves platform IDs and gives whitelist precedence', async () => {
  const back = backend(), p = await panel(back);
  await p.D.store.listAction('bilibili:1', { n: 'original', t: 1 }, 'block');
  p.els['io-import'].files = [{ text: async () => JSON.stringify({ app: 'dafeiyu-cleaner', v: 2,
    blocklist: { 'douyin:1': { n: 'imported' }, 'bilibili:2': { n: 'blocked' } }, whitelist: { 'bilibili:2': { n: 'keep' } },
  }) }];
  await Promise.all([p.els['io-import'].onchange(), p.D.store.listAction('douyin:3', { n: 'other tab', t: 1 }, 'block')]);
  const data = back.data();
  for (const key of ['bilibili:1', 'douyin:1', 'douyin:3']) assert.ok(data.blocklist[key], key);
  assert.equal(data.blocklist['bilibili:2'], undefined);
  assert.equal(data.whitelist['bilibili:2'].n, 'keep');
});

test('Douyin panel keeps disabled/limited explanations and offers local actions without animation controls', async () => {
  for (const state of ['disabled', 'limited', 'ready']) {
    const back = backend();
    back.chrome.tabs.query = async () => [{ id: 1 }];
    back.chrome.tabs.sendMessage = (id, msg, callback) => callback({
      platform: 'douyin', enabled: state !== 'disabled', comments: true, accounts: 2,
      fish: 1, candidates: 0, listed: 1, suspect: 0, unknown: 1,
      platformStatus: { state, capabilities: { commentAnimation: false } },
    });
    const p = await panel(back); await settle();
    if (state === 'disabled') assert.match(p.els['here-s'].textContent, /打开右上角/);
    else if (state === 'limited') assert.match(p.els['here-s'].textContent, /缺少可识别字段/);
    else {
      assert.match(p.els['here-btns'].innerHTML, /全部隐藏/);
      assert.doesNotMatch(p.els['here-btns'].innerHTML, /cannon|响指清场/);
    }
  }
});

test('panel distinguishes a loading comment host from a page without comments', async () => {
  const back = backend();
  back.chrome.tabs.query = async () => [{ id: 1 }];
  back.chrome.tabs.sendMessage = (id, msg, callback) => callback({
    platform: 'bilibili', enabled: true, comments: true, accounts: 0,
    platformStatus: { state: 'waiting', capabilities: { commentAnimation: true } },
  });
  const p = await panel(back); await settle();
  assert.equal(p.els['here-t'].textContent, '评论区正在加载');
  assert.match(p.els['here-s'].textContent, /重新读取/);
  assert.match(p.els['here-btns'].innerHTML, /data-here="rescan"/);
});
