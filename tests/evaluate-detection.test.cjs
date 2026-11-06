const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluate, readSamples, findLeakage } = require('../tools/evaluate-detection.cjs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const sample = (id, platform, label, text, extra = {}) => ({
  id, platform, label, labelSource: { kind: 'synthetic', basis: 'unit-test fixture' },
  accountId: `account-${id}`, pageKey: `video:${id}`, name: '普通观众', comments: [{ id: `${id}-c`, text }], ...extra,
});

test('evaluation reports platform metrics and excludes unknown labels from confusion counts', () => {
  const report = evaluate([
    sample('b-auto', 'bilibili', 'automatic', '这条评论由程序自动发送。'),
    sample('b-human', 'bilibili', 'human', '我觉得这个教程讲得很清楚，准备回去试试。'),
    sample('b-unknown', 'bilibili', 'unknown', '本鲸替主人刷到这个视频，来汇报啦。'),
    sample('d-auto', 'douyin', 'automatic', '本账号由脚本自动运营。'),
    sample('d-human', 'douyin', 'human', '这个视频讲得很有意思。'),
  ]);
  assert.equal(report.total, 5);
  assert.equal(report.excludedUnknownLabels, 1);
  assert.equal(report.byPlatform.bilibili.labelled, 2);
  assert.equal(report.byPlatform.bilibili.confusion.tp, 1);
  assert.equal(report.byPlatform.bilibili.confusion.tn, 1);
  assert.equal(report.byPlatform.douyin.fishRecall, 1);
  assert.equal(report.byPlatform.douyin.fishPrecision, 1);
});

test('evaluation never treats ordinary AI discussion as an automatic-account negative or positive label', () => {
  const report = evaluate([sample('unknown', 'douyin', 'unknown', '这条视频是 AI 生成的，大家觉得效果怎么样？')]);
  const summary = report.byPlatform.douyin;
  assert.equal(summary.labelled, 0);
  assert.equal(summary.unknownLabels, 1);
  assert.equal(summary.fishPrecision, null);
  assert.equal(summary.fishRecall, null);
});

test('evaluation reports explicit abstentions, evidence groups, errors and reproducible source hashes', () => {
  const samples = [
    sample('true', 'douyin', 'automatic', '本账号由脚本自动运营。'),
    sample('missed', 'douyin', 'automatic', '普通短回复'),
    sample('false', 'douyin', 'human', '本账号由脚本自动运营。'),
    sample('human', 'douyin', 'human', '普通评论'),
    sample('unknown', 'douyin', 'unknown', 'AI 话题讨论'),
  ];
  const report = evaluate(samples), summary = report.byPlatform.douyin;
  assert.equal(summary.matrix.automatic.fish, 1);
  assert.equal(summary.matrix.automatic.unknown, 1);
  assert.equal(summary.matrix.unknown.unknown, 1);
  assert.equal(summary.falsePositiveRate, .5);
  assert.equal(summary.fishPrecision, .5);
  assert.equal(summary.fishRecall, .5);
  assert.equal(summary.abstainRate, .6);
  assert.deepEqual(summary.errors.map(row => row.type), ['missed-fish', 'false-fish']);
  assert.equal(summary.byEvidence['automation-comment'].matrix.human.fish, 1);
  assert.equal(report.dataset.syntheticRows, 5);
  assert.equal(report.dataset.realLabelledRows, 0);
  assert.match(report.runtime.sources['src/detection/common.js'], /^[a-f0-9]{64}$/);
  assert.deepEqual(evaluate(samples), report);
});

test('evaluation refuses invalid labels, missing provenance, numeric IDs, malformed comments and duplicates', () => {
  const valid = sample('a', 'douyin', 'automatic', '本账号由脚本自动运营。');
  for (const patch of [
    { platform: 'unsupported' }, { label: 'bot' }, { labelSource: null },
    { accountId: 123 }, { comments: 'bad' }, { comments: [null] }, { comments: [{ text: 123 }] },
    { comments: [{ text: 'hi', parentId: 9007199254740992 }] },
    { comments: [{ text: 'hi', mentions: [{ accountId: 123 }] }] },
    { comments: [{ id: 'same', text: 'one' }, { id: 'same', text: 'two' }] },
  ]) assert.throws(() => evaluate([{ ...valid, ...patch }]), /Invalid evaluation dataset/);
  assert.throws(() => evaluate([valid, valid]), /duplicate sample ID/);
  assert.throws(() => evaluate([{ ...valid, accountId: undefined, labelSource: { kind: 'user-confirmed', basis: 'owner confirms' } }]), /real labelled samples require/);
  const long = '90071992547409931234567890';
  assert.equal(evaluate([{ ...valid, accountId: long }]).rows[0].accountId, long);
});

test('evaluation refuses both account and video leakage across splits and reports splits separately', () => {
  const a = sample('a', 'douyin', 'automatic', '本账号由脚本自动运营。', { split: 'train' });
  const b = sample('b', 'douyin', 'human', '普通评论', { split: 'test' });
  for (const field of ['accountId', 'pageKey']) assert.throws(() => evaluate([a, { ...b, [field]: a[field] }]), /Dataset split leakage/);
  assert.equal(findLeakage([a, { ...b, accountId: a.accountId }])[0].type, 'account');
  const report = evaluate([
    a, b,
    sample('c', 'bilibili', 'unknown', '评论', { accountId: a.accountId, pageKey: a.pageKey, split: 'test' }),
  ]);
  assert.equal(report.byPlatform.douyin.bySplit.test.labelled, 1);
  assert.equal(report.byPlatform.douyin.bySplit.test.fishRecall, null);
});

test('evaluation CLI produces JSON for synthetic examples and rejects unknown flags', () => {
  const file = path.resolve(__dirname, 'fixtures/detection-synthetic.json');
  const parsed = readSamples(file), report = evaluate(parsed);
  assert.equal(report.total, parsed.length);
  const cli = path.resolve(__dirname, '../tools/evaluate-detection.cjs');
  const good = spawnSync(process.execPath, [cli, file, '--json'], { encoding: 'utf8' });
  assert.equal(good.status, 0, good.stderr);
  assert.equal(JSON.parse(good.stdout).dataset.syntheticRows, parsed.length);
  const bad = spawnSync(process.execPath, [cli, file, '--typo'], { encoding: 'utf8' });
  assert.equal(bad.status, 2);
});
