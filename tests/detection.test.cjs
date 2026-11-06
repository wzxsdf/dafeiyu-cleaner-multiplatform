const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '../dafeiyu-cleaner');
function runtime(extra = {}) {
  const ctx = vm.createContext({ console, URL, AbortController, DOMException, setTimeout, clearTimeout, ...extra });
  const load = f => vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), ctx, { filename: f });
  for (const f of ['src/core/models.js', 'src/core/page-session.js', 'src/core/defaults.js', 'src/detection/common.js', 'src/detection/bilibili-legacy.js', 'src/detection/douyin.js']) load(f);
  return { D: ctx.DFY, ctx, load };
}
const acc = (platform, extra = {}) => ({ platform, id: '1', key: platform + ':1', name: '普通观众', signature: null, features: {}, ...extra });
const row = (text, extra = {}) => ({ id: '1', text, isReply: false, ...extra });
function decide(D, platform, a, rows, ctx = {}, llm = null) {
  const strategy = D.detection.get(platform), result = strategy.judge(a, rows, ctx);
  const score = strategy.combine(result, llm, ctx).score;
  return { ...result, combined: score, level: strategy.classify(score, result, ctx) };
}

test('weak names, Bilibili metadata, AI topic and ordinary phrases cannot prove automation on either platform', () => {
  const { D } = runtime();
  for (const platform of ['bilibili', 'douyin']) for (const text of [
    '让我来解释一下这道数学题的解法', '照镜子才发现今天头发乱了', '我今天过来打卡，顺便看看大家',
    '不是我发的，是朋友分享的', '这条值得收藏，首先解释了安装过程，其次展示了操作流程。总的来说很适合新手。',
    '@朋友 叫饭友吧，抢白饭听着就有参与感', '小肥鱼好听诶，我投这个一票。',
  ]) {
    const a = acc(platform, { name: '小凌家的大肥鱼', features: { level: 2 }, avatarBlue: .9 });
    const result = decide(D, platform, a, [row(text)], { threshold: 1, calledOut: 20, priorPages: 20, videoAiGenerated: true });
    assert.equal(result.level, 'unknown', `${platform}: ${text}`);
    assert.equal(result.strongEvidence, false);
  }
});

test('direct automation claims are candidates while quotations, negations, tutorials and questions abstain', () => {
  const { D } = runtime();
  for (const platform of ['bilibili', 'douyin']) {
    const direct = decide(D, platform, acc(platform), [row('这条评论由程序自动发送。')]);
    assert.equal(direct.level, 'fish');
    assert.equal(direct.confidence, 'self_claimed');
    assert.equal(direct.reasons[0].kind, 'self_claimed');
    for (const text of [
      '示例原文：“这条评论由程序自动发送。”请勿模仿。', '这条评论不是由程序自动发送。',
      '你说这条评论由程序自动发送，是在玩梗吗？', '教程：如何让这条评论由程序自动发送',
      '“本鲸替主人刷视频”（尾巴摇了摇），请勿模仿。',
      '这条评论由AI生成。', '内容由AI生成。', '我看到这条评论由程序自动发送。',
    ]) assert.notEqual(decide(D, platform, acc(platform), [row(text)]).level, 'fish', text);
  }
});

test('ecosystem self-descriptions remain unverified; author badges give no human exemption', () => {
  const { D } = runtime();
  for (const platform of ['bilibili', 'douyin']) {
    const a = acc(platform, { name: '小凌家的大肥鱼' });
    const r = decide(D, platform, a, [row('本鲸替主人刷到这个视频，来汇报啦。')]);
    assert.equal(r.level, 'suspect');
    assert.equal(r.strongEvidence, false);
    const author = decide(D, platform, a, [row('这条评论由程序自动发送。')], { upMid: a.key });
    assert.equal(author.level, 'fish');
    assert.ok(author.evidence.some(e => e.code === 'page-author'));
  }
});

test('field availability is explicit and duplication requires 3 long identical top-level comments', () => {
  const { D } = runtime(); const p = 'douyin';
  const a = acc(p), text = '这是一段超过十四个字的普通完整评论，用来验证重复。';
  const rows = [row(text, { id: 'a' }), row(text, { id: 'b' }), row(text, { id: 'c' })];
  const repeated = decide(D, p, a, rows);
  assert.ok(repeated.reasons.some(e => e.code === 'repeated-template'));
  assert.equal(repeated.level, 'unknown');
  assert.ok(repeated.missingFeatures.includes('level'));
  assert.ok(repeated.missingFeatures.includes('signature'));
  assert.equal(decide(D, p, a, rows.map(r => ({ ...r, isReply: true }))).score, 0);
  assert.equal(decide(D, p, a, [row('好看'), row('好看'), row('好看')]).score, 0);
  const known = decide(D, p, acc(p, { signature: '', features: { level: 2 } }), []);
  assert.ok(known.availableFeatures.includes('signature'));
  assert.ok(known.availableFeatures.includes('level'));
});

test('classification and best evidence are invariant under comment order', () => {
  const { D } = runtime();
  for (const platform of ['bilibili', 'douyin']) {
    const a = acc(platform, { name: '小澪家的大肥鱼' });
    const rows = [row('小肥鱼好听诶，我投这个一票。'), row('哈哈哈你也这么觉得嘛', { id: '2', isReply: true })];
    assert.equal(decide(D, platform, a, rows).score, decide(D, platform, a, [...rows].reverse()).score);
    const strong = [...rows, row('这条评论由程序自动发送。', { id: '3' })];
    assert.equal(decide(D, platform, a, strong).score, decide(D, platform, a, strong.reverse()).score);
  }
});

test('platform policies are isolated and model output cannot create a strong identity claim', () => {
  const { D } = runtime();
  const bili = D.detection.get('bilibili'), dy = D.detection.get('douyin');
  assert.equal(bili.getPolicy().threshold, 60);
  assert.equal(dy.getPolicy({ threshold: 1 }).threshold, 80);
  for (const strategy of [bili, dy]) {
    assert.equal(strategy.getPolicy().autoBlock, false);
    assert.equal(strategy.shouldRemember({ raw: 99, strongEvidence: true }), false);
  }
  const a = acc('bilibili', { name: '小凌家的大肥鱼' });
  const weak = decide(D, 'bilibili', a, [row('本鲸替主人刷到这个视频。')], {}, { ai: 100 });
  assert.notEqual(weak.level, 'fish');
  const rejected = decide(D, 'bilibili', a, [row('这条评论由程序自动发送。')], {}, { ai: 0 });
  assert.equal(rejected.level, 'suspect');
});

test('model payload and digest match, are order stable, and invalidate on reply/mention/author changes', () => {
  const { D } = runtime(), s = D.detection.get('bilibili'), a = acc('bilibili');
  const rows = [row('评论', { id: 'b' }), row('回复', { id: 'a', isReply: true, rootId: 'b', mentions: [{ accountId: '2', name: '朋友' }] })];
  const context = { pageKey: 'video:a' }, digest = s.digest(a, rows, context);
  assert.equal(digest, JSON.stringify(s.payload(a, rows, context)));
  assert.equal(digest, s.digest(a, [...rows].reverse(), context));
  assert.notEqual(digest, s.digest(a, [rows[0], { ...rows[1], isReply: false }], context));
  assert.notEqual(digest, s.digest(a, [rows[0], { ...rows[1], mentions: [] }], context));
  assert.notEqual(digest, s.digest(a, rows, { ...context, upMid: a.key }));
});

function controllerRuntime(platform = 'bilibili') {
  const r = runtime({ requestAnimationFrame: () => 0 }), D = r.D;
  D.esc = String; D.settings = { ...D.DEFAULTS.settings, llmEnabled: true, llmKey: 'placeholder', llmAuto: false };
  D.lists = { block: {}, white: {} }; D.platformStatus = {};
  D.memory = { mark() { throw Error('unexpected history write'); }, prior: () => 20, llmGet: () => null, llmPut() {} };
  D.ui = { tip() {}, setBusy() {}, cannon() {}, say() {}, think: () => ({ close() {}, done() {}, update() {} }) };
  D.actors = { clear() {} }; D.say = () => ''; D.bump = () => {}; D.canLLM = true;
  const adapter = { id: platform, getCapabilities: () => ({ commentAnimation: false }), comments: { host: () => null, eachRenderer() {} } };
  D.session = D.createSession(adapter, { platform, pageKey: 'video:a' });
  r.load('src/comments.js'); const C = D.createCommentController(D.session); C.render = () => {};
  const receive = (text, extra = {}) => C.receive(D.model.normalizeBatch({ protocolVersion: 2, platform, pageKey: 'video:a', sessionId: D.session.sessionId, accounts: [acc(platform, { name: '小凌家的大肥鱼' })], comments: [{ platform, pageKey: 'video:a', accountId: '1', ...row(text), ...extra }] }, D.session));
  return { ...r, C, receive };
}

test('controller applies platform policy, separates manual lists, and Douyin never sends model requests', async () => {
  const { D, C, receive } = controllerRuntime('douyin'); let calls = 0;
  D.callBg = async () => { calls++; return { ok: true }; };
  receive('普通评论'); assert.equal(C.stats().unknown, 1);
  receive('这条评论由程序自动发送。'); assert.equal(C.stats().candidates, 1);
  assert.equal(C.stats().automaticHandling, false);
  D.lists.block['douyin:1'] = { n: '手动' }; C.rejudgeAll();
  assert.equal(C.stats().listed, 1); assert.equal(C.stats().candidates, 0);
  D.lists.white['douyin:1'] = {}; C.rejudgeAll(); assert.equal(C.stats().listed, 0);
  await C.llmPage(); assert.equal(calls, 0); D.session.dispose();
});

test('in-flight model results are discarded after model, reply structure, or whitelist changes', async () => {
  for (const change of ['model', 'reply', 'white']) {
    const { D, C, receive } = controllerRuntime(); let finish, writes = 0;
    D.callBg = () => new Promise(resolve => finish = resolve); D.memory.llmPut = () => writes++;
    receive('这条评论由程序自动发送。'); const request = C.llmPage();
    assert.equal(typeof finish, 'function');
    if (change === 'model') { D.settings.llmModel = 'another-model'; C.rejudgeAll(); }
    if (change === 'reply') receive('这条评论由程序自动发送。', { isReply: true, rootId: 'root' });
    if (change === 'white') D.lists.white['bilibili:1'] = {};
    finish({ ok: true, results: [{ id: 'bilibili:1', ai: 99 }], ms: 1 });
    await request; assert.equal(writes, 0); D.session.dispose();
  }
});

test('model responses accept only requested IDs with finite numeric scores', async () => {
  const { D, C, receive } = controllerRuntime(); const writes = [];
  D.memory.llmPut = (...args) => writes.push(args);
  D.callBg = async msg => { assert.equal(typeof msg.items[0].comments[0], 'object'); return { ok: true, ms: 1, results: [{ id: 'bilibili:2', ai: 99 }, { id: 'bilibili:1', ai: '99' }, { id: 'bilibili:1', ai: NaN }, { id: 'bilibili:1', ai: 88, reason: '存在自述，但未验证' }] }; };
  receive('这条评论由程序自动发送。'); await C.llmPage();
  assert.equal(writes.length, 1);
  assert.ok(writes[0][3].includes('comments-evidence-v1'));
  assert.ok(writes[0][3].includes(D.settings.llmModel)); D.session.dispose();
});
