const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const root = path.resolve(__dirname, '../dafeiyu-cleaner');
function runtime(extra = {}) {
  const context = vm.createContext({ URL, AbortController, DOMException, crypto: webcrypto, console, setTimeout, clearTimeout, setInterval, clearInterval, ...extra });
  const load = name => vm.runInContext(fs.readFileSync(path.join(root, name), 'utf8'), context, { filename: name });
  for (const name of ['src/core/models.js', 'src/core/page-session.js', 'src/platforms/douyin/shared.js']) load(name);
  return { context, load, D: context.DFY };
}
const videoId = '90071992547409931234', accountId = 'MS4wLjABAAAA_example-secUID';

test('Douyin resolves modal, direct and same-path feed identities without numeric conversion', () => {
  let feedId = null;
  const { D } = runtime({ document: { querySelector: () => feedId ? { getAttribute: () => feedId } : null } });
  const page = url => D.douyin.getPageContext(new URL(url));
  assert.equal(D.platforms.match('https://www.douyin.com/video/' + videoId).id, 'douyin');
  assert.equal(D.platforms.match('https://live.douyin.com/123'), null);
  assert.equal(D.platforms.match('https://evil-douyin.com/'), null);
  assert.equal(page('https://www.douyin.com/jingxuan?modal_id=' + videoId).pageKey, 'video:' + videoId);
  assert.equal(page('https://www.douyin.com/video/' + videoId).pageKey, 'video:' + videoId);
  assert.equal(page('https://www.douyin.com/jingxuan').type, 'other');
  feedId = videoId;
  assert.equal(page('https://www.douyin.com/jingxuan').pageKey, 'video:' + videoId);
  assert.equal(page('https://www.douyin.com/video/123').pageKey, 'video:123');
  feedId = '567';
  assert.equal(page('https://www.douyin.com/jingxuan').pageKey, 'video:567');
  assert.equal(D.douyin.getCapabilities().commentAnimation, false);
  assert.equal(D.douyin.getCapabilities().profileInspection, false);
});

test('Douyin host never assigns previous-video comments to the new URL', () => {
  const host = {}, video = { getAttribute: () => '123', querySelector: () => host };
  const location = new URL('https://www.douyin.com/jingxuan?modal_id=456');
  const { D } = runtime({ location, document: { querySelector: () => video } });
  assert.equal(D.douyin.comments.host(), null);
  location.href = 'https://www.douyin.com/jingxuan?modal_id=123';
  assert.equal(D.douyin.comments.host(), host);
});

// Anonymized DOM contract: own header, injected badge, emoji body and nested replies.
function commentFixture({ id = videoId, uid = accountId, parent = null, missingId = false } = {}) {
  const text = value => ({ nodeType: 3, nodeValue: value });
  const link = { childNodes: [text('示例昵称')], getAttribute: () => uid ? '//www.douyin.com/user/' + uid : '/deleted' };
  const mention = { childNodes: [text('@示例对象')], getAttribute: () => 'https://www.douyin.com/user/mention-id' };
  const body = { childNodes: [text('你好'), { tagName: 'IMG', getAttribute: () => '[微笑]' }, { tagName: 'BR' }, mention], matches: () => false, contains: () => false, querySelectorAll: () => [mention] };
  const badge = { matches: () => true, nextElementSibling: body };
  const root = {}, attrs = {};
  const info = { parentElement: root, nextElementSibling: badge, closest: () => el, querySelector: selector => selector.includes('tooltip_') ? missingId ? null : { id: 'tooltip_' + id } : link };
  const avatar = { closest: () => el, getAttribute: () => 'https://example.org/avatar@raw.jpg' };
  const nestedInfo = { closest: () => ({}) };
  const el = { isConnected: true, style: { display: 'flex' }, dataset: {}, parentElement: { closest: () => parent }, matches: () => true, querySelectorAll: selector => selector.includes('info-wrap') ? [nestedInfo, info] : [avatar], getAttribute: k => attrs[k], setAttribute: (k, v) => attrs[k] = v, removeAttribute: k => delete attrs[k] };
  return { el, info, body, link, root };
}

test('Douyin DOM reading preserves IDs, emoji, mentions and own reply authors', () => {
  const { D } = runtime();
  const top = commentFixture(), reply = commentFixture({ id: '90071992547409931235', uid: 'reply-secUID', parent: top.el });
  const row = D.douyin.comments.read(reply.el, 'video:123');
  assert.equal(row.account.id, 'reply-secUID');
  assert.equal(row.account.name, '示例昵称');
  assert.equal(row.comment.id, '90071992547409931235');
  assert.equal(row.comment.text, '你好[微笑]\n@示例对象');
  assert.equal(row.comment.rootId, videoId);
  assert.equal(row.comment.isReply, true);
  assert.equal(row.comment.mentions[0].accountId, 'mention-id');
  assert.equal(row.comment.createdAt, null);
  assert.equal(Object.keys(row.account.features).length, 0);
  assert.equal(D.douyin.resolveProfileUrl(accountId), 'https://www.douyin.com/user/' + accountId);
  assert.equal(D.douyin.resolveProfileUrl('../bad'), null);
  assert.equal(D.douyin.resolveAvatarUrl(row.account), 'https://example.org/avatar@raw.jpg');
});

test('Douyin unknown layout and missing account fail safely without invented identities', () => {
  const { D } = runtime();
  assert.equal(D.douyin.comments.read(commentFixture({ missingId: true }).el, 'video:123'), null);
  const fixture = commentFixture({ uid: null });
  const row = D.douyin.comments.read(fixture.el, 'video:123');
  assert.equal(row.account, null);
  assert.equal(row.comment.accountId, null);
  fixture.info.nextElementSibling = null;
  assert.equal(D.douyin.comments.read(fixture.el, 'video:123'), null);
});

test('Douyin author badges stay separate from names and survive protocol normalization', () => {
  const { D } = runtime(), fixture = commentFixture();
  fixture.link.querySelector = () => ({ childNodes: [{ nodeType: 3, nodeValue: '示例昵称' }] });
  fixture.link.querySelectorAll = () => [{ childNodes: [{ nodeType: 3, nodeValue: '作者' }] }];
  fixture.link.childNodes.push({ childNodes: [{ nodeType: 3, nodeValue: '作者' }] });
  const row = D.douyin.comments.read(fixture.el, 'video:123');
  assert.equal(row.account.name, '示例昵称');
  assert.equal(row.comment.isAuthor, true);
  const context = { platform: 'douyin', pageKey: 'video:123', sessionId: 'author' };
  const packet = D.model.normalizeBatch({ protocolVersion: 2, ...context, accounts: [row.account], comments: [row.comment], authorId: accountId }, context);
  assert.equal(packet.comments[0].isAuthor, true);
  assert.equal(packet.authorId, accountId);
});

function adapterRuntime() {
  const timers = new Map(), observers = []; let seq = 0;
  const r = runtime({ document: { documentElement: {} }, MutationObserver: class { constructor(fn) { this.fn = fn; observers.push(this); } observe() {} disconnect() { this.stopped = true; } }, setTimeout: fn => { timers.set(++seq, fn); return seq; }, clearTimeout: id => timers.delete(id), setInterval: () => ++seq, clearInterval() {} });
  const { D } = r, A = D.douyin;
  let rows = [], pageKey = 'video:123', host = { querySelector: () => null };
  Object.assign(A.comments, { host: () => host, eachRenderer: cb => rows.forEach(row => cb(row.el)), read: el => rows.find(row => row.el === el)?.data, identity: el => el.identity, partsOf: el => ({ root: el.root, host: el.root }), accountHref: el => el.account, isRenderer: () => true });
  A.getPageContext = () => ({ platform: A.id, pageKey, type: 'video' });
  D.platformStatus = {};
  r.load('src/platforms/douyin/adapter.js');
  const attrs = {};
  const el = { identity: videoId, account: accountId, root: { getAttribute: k => attrs[k], setAttribute: (k, v) => attrs[k] = v, removeAttribute: k => delete attrs[k] }, isConnected: true, style: { display: 'flex' }, dataset: {} };
  const data = { account: { platform: 'douyin', id: accountId, name: '示例', features: {} }, comment: { platform: 'douyin', pageKey, id: videoId, accountId, text: 'example' } };
  rows = [{ el, data }];
  const session = D.createSession(A, A.getPageContext()), batches = [];
  let rebound = 0;
  A.start(session, { comments: b => { batches.push(b); D.platformStatus.state = b.comments.length ? 'ready' : 'waiting'; }, bindingsChanged: () => rebound++ }, session.signal);
  const scan = () => { A.rescan(); for (const [id, fn] of [...timers]) { timers.delete(id); fn(); } };
  return { ...r, A, el, session, batches, observers, scan, timers, setRows: value => rows = value, setHost: value => host = value, setPage: value => pageKey = value, rebound: () => rebound };
}

test('Douyin bindings clean owned DOM on reuse, host removal and cancellation', () => {
  const r = adapterRuntime(), { A, el, session } = r;
  assert.equal(r.batches[0].comments[0].id, videoId);
  const old = A.comments.binding(el); old.setStyle('display', 'none');
  let removed = 0; old.track({ remove: () => removed++ });
  el.identity = 'new-comment';
  const next = A.comments.binding(el);
  assert.equal(old.valid(), false); assert.equal(removed, 1); assert.equal(el.style.display, 'flex');
  assert.notEqual(old.generation, next.generation);
  next.setStyle('display', 'none'); el.style.display = 'grid';
  el.account = 'another-account'; const third = A.comments.binding(el);
  assert.equal(next.valid(), false); assert.equal(el.style.display, 'grid');
  third.setStyle('display', 'none'); r.setRows([]); r.setHost(null); r.scan();
  assert.equal(third.valid(), false); assert.equal(el.style.display, 'grid');
  session.dispose(); assert.equal(r.observers[0].stopped, true); assert.equal(r.timers.size, 0);
  A.dispose();
});

test('Douyin marks unsupported comment layouts limited and stops collecting after route change', () => {
  const r = adapterRuntime();
  r.setRows([]); r.setHost({ querySelector: () => ({}) }); r.scan();
  assert.equal(r.D.platformStatus.state, 'limited');
  const count = r.batches.length; let changed = 0;
  r.D.checkRoute = () => { changed++; r.session.dispose(); };
  r.setPage('video:456'); r.scan();
  assert.equal(changed, 1); assert.equal(r.batches.length, count);
  assert.equal(r.session.active(), false);
});

test('Douyin uses one unambiguous author badge as context and abstains on conflicting badges', () => {
  const r = adapterRuntime();
  const row = (id, author) => ({ el: r.el, data: { account: { platform: 'douyin', id, name: '示例', features: {} }, comment: { platform: 'douyin', pageKey: 'video:123', id: 'comment-' + id, accountId: id, text: '回复', isAuthor: author } } });
  r.setRows([row('author', true)]); r.scan();
  assert.equal(r.batches.at(-1).authorId, 'author');
  // The adapter fixture resolves rows by element, so use a distinct renderer for the second author.
  const other = { ...r.el, identity: 'other' }, second = row('other', true); second.el = other;
  r.setRows([row('author', true), second]); r.scan();
  assert.equal(r.batches.at(-1).authorId, null);
  r.session.dispose();
});

test('Douyin injection uses isolated DOM collection and platform-aware popup lists', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json')));
  const groups = manifest.content_scripts.filter(g => g.matches.some(m => m.includes('douyin.com')));
  assert.equal(groups.length, 1); assert.notEqual(groups[0].world, 'MAIN');
  assert.ok(groups[0].js.indexOf('src/platforms/douyin/adapter.js') < groups[0].js.indexOf('src/platform-registry.js'));
  const { D, load } = runtime(); load('src/core/list-codec.js');
  const key = D.model.accountKey('douyin', accountId);
  const exported = JSON.stringify({ schemaVersion: 2, blocklist: { [key]: { platform: 'douyin', id: accountId, n: '示例' } } });
  const imported = D.normalizeList(JSON.parse(exported).blocklist);
  assert.equal(imported[key].n, '示例');
  assert.equal(D.detection.get('douyin'), null);
});
