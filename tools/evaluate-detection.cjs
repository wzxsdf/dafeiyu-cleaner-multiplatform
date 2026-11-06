#!/usr/bin/env node
/* Offline, deterministic account-operation evaluation. No network or model calls. */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHash } = require('node:crypto');

const ROOT = path.resolve(__dirname, '..', 'dafeiyu-cleaner');
const STRATEGY_FILES = [
  'src/core/models.js', 'src/core/defaults.js', 'src/detection/common.js',
  'src/detection/bilibili-legacy.js', 'src/detection/douyin.js',
];
const LABELS = ['automatic', 'human', 'unknown'];
const PREDICTIONS = ['fish', 'suspect', 'unknown'];
const SOURCES = ['synthetic', 'user-confirmed', 'controlled-account', 'manual-review', 'documented'];
const sha256 = value => createHash('sha256').update(value).digest('hex');
const plain = value => !!value && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && !!value.trim();
const validId = value => nonempty(value) && value.length <= 1024 && !/[\u0000-\u001f]/.test(value);

function loadRuntime() {
  const context = vm.createContext({ console, URL });
  const sources = {};
  for (const file of STRATEGY_FILES) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    sources[file] = sha256(source);
    vm.runInContext(source, context, { filename: file });
  }
  return { detection: context.DFY.detection, model: context.DFY.model, sources };
}

function readSamples(file) {
  const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').trim();
  if (!raw) return [];
  if (raw.startsWith('[')) return JSON.parse(raw);
  return raw.split(/\r?\n/).flatMap((line, index) => {
    if (!line.trim()) return [];
    try { return [JSON.parse(line)]; }
    catch (error) { throw new Error(`${file}:${index + 1}: ${error.message}`); }
  });
}

function validateSample(sample, index, detection) {
  const errors = [], at = `row ${index + 1}`;
  const add = message => errors.push(`${at}: ${message}`);
  if (!plain(sample)) return [`${at}: sample must be an object`];
  if (!validId(sample.id)) add('id must be a non-empty string of at most 1024 characters');
  if (!['bilibili', 'douyin'].includes(sample.platform) || !detection.get(sample.platform)) add('unsupported platform');
  if (sample.label != null && !LABELS.includes(sample.label)) add('label must be automatic, human, or unknown');
  for (const field of ['accountId', 'pageKey', 'split']) {
    if (sample[field] != null && !validId(sample[field])) add(`${field} must be a non-empty string (numeric IDs lose precision)`);
  }
  for (const field of ['name', 'signature']) {
    if (sample[field] != null && typeof sample[field] !== 'string') add(`${field} must be a string`);
  }
  if (sample.author != null && typeof sample.author !== 'boolean') add('author must be a boolean');
  if (sample.features != null && !plain(sample.features)) add('features must be an object');
  if (sample.comments != null && !Array.isArray(sample.comments)) add('comments must be an array');

  const source = sample.labelSource;
  const labelled = ['automatic', 'human'].includes(sample.label);
  if (labelled || source != null) {
    if (!plain(source) || !SOURCES.includes(source.kind) || !nonempty(source.basis)) {
      add('labelSource requires a supported kind and a non-empty basis');
    } else if (labelled && source.kind !== 'synthetic' && (!validId(sample.accountId) || !validId(sample.pageKey))) {
      add('real labelled samples require accountId and pageKey (pseudonyms allowed)');
    }
  }

  const ids = new Set();
  for (const [commentIndex, comment] of (Array.isArray(sample.comments) ? sample.comments : []).entries()) {
    const prefix = `comment ${commentIndex + 1}`;
    if (!plain(comment)) { add(`${prefix} must be an object`); continue; }
    if (typeof comment.text !== 'string') add(`${prefix} text must be a string`);
    for (const field of ['id', 'rootId', 'parentId']) {
      if (comment[field] != null && !validId(comment[field])) add(`${prefix} ${field} must be a string ID`);
    }
    if (comment.id) {
      if (ids.has(comment.id)) add(`${prefix} has a duplicate comment ID`);
      ids.add(comment.id);
    }
    if (comment.isReply != null && typeof comment.isReply !== 'boolean') add(`${prefix} isReply must be a boolean`);
    if (comment.createdAt != null && !Number.isFinite(comment.createdAt)) add(`${prefix} createdAt must be finite`);
    if (comment.mentions != null && !Array.isArray(comment.mentions)) add(`${prefix} mentions must be an array`);
    for (const mention of Array.isArray(comment.mentions) ? comment.mentions : []) {
      if (!plain(mention) || mention.accountId != null && !validId(mention.accountId) || mention.name != null && typeof mention.name !== 'string') add(`${prefix} has an invalid mention`);
    }
  }
  return errors;
}

function findLeakage(samples) {
  const groups = new Map();
  for (const sample of samples) {
    const split = sample.split || 'unsplit';
    for (const [type, value] of [['account', sample.accountId], ['page', sample.pageKey]]) {
      if (!value) continue;
      const key = JSON.stringify([sample.platform, type, value]);
      if (!groups.has(key)) groups.set(key, { platform: sample.platform, type, id: value, splits: new Set() });
      groups.get(key).splits.add(split);
    }
  }
  return [...groups.values()].filter(group => group.splits.size > 1).map(group => ({ ...group, splits: [...group.splits].sort() }));
}

function normalizeSample(sample, model) {
  const accountId = sample.accountId || `sample-${sample.id}`;
  const pageKey = sample.pageKey || `sample:${sample.id}`;
  const context = { platform: sample.platform, pageKey, sessionId: 'offline-evaluation' };
  const batch = model.normalizeBatch({
    protocolVersion: 2, ...context, authorId: sample.author ? accountId : null,
    accounts: [{ platform: sample.platform, id: accountId, name: sample.name || '', signature: sample.signature ?? null, features: sample.features || {} }],
    comments: (sample.comments || []).map((comment, index) => ({
      ...comment, platform: sample.platform, pageKey, id: comment.id || `${sample.id}-comment-${index}`, accountId,
    })),
  }, context);
  if (!batch) throw new Error(`sample ${sample.id}: production protocol rejected this batch`);
  return { account: batch.accounts[0], comments: batch.comments, context: { ...context, upMid: sample.author ? batch.accounts[0].key : '' } };
}

function evaluate(samples) {
  if (!Array.isArray(samples)) throw new TypeError('samples must be an array');
  const { detection, model, sources } = loadRuntime();
  const errors = [], seen = new Set();
  for (const [index, sample] of samples.entries()) {
    const rowErrors = validateSample(sample, index, detection);
    errors.push(...rowErrors);
    if (rowErrors.length) continue;
    const key = JSON.stringify([sample.platform, sample.id]);
    if (seen.has(key)) errors.push(`row ${index + 1}: duplicate sample ID ${sample.id} on ${sample.platform}`);
    seen.add(key);
  }
  if (errors.length) throw new Error(`Invalid evaluation dataset:\n${errors.join('\n')}`);
  const leakage = findLeakage(samples);
  if (leakage.length) throw new Error(`Dataset split leakage:\n${leakage.map(group => `${group.platform} ${group.type} ${group.id}: ${group.splits.join(', ')}`).join('\n')}`);

  const rows = samples.map(sample => {
    const strategy = detection.get(sample.platform);
    const { account, comments, context } = normalizeSample(sample, model);
    const result = strategy.judge(account, comments, context);
    const score = strategy.combine(result, null, context).score;
    const prediction = strategy.classify(score, result, context);
    if (!PREDICTIONS.includes(prediction)) throw new Error(`Unsupported strategy prediction: ${prediction}`);
    return {
      id: sample.id, platform: sample.platform, accountId: account.id, pageKey: context.pageKey,
      split: sample.split || 'unsplit', label: sample.label || 'unknown', labelSource: sample.labelSource || null,
      prediction, score, strongEvidence: result.strongEvidence === true, confidence: result.confidence || 'insufficient',
      evidenceCodes: [...new Set((result.reasons || []).map(reason => reason.code).filter(Boolean))].sort(),
    };
  });
  const byPlatform = {};
  for (const platform of [...new Set(rows.map(row => row.platform))].sort()) {
    const subset = rows.filter(row => row.platform === platform);
    const byEvidence = {}, bySplit = {};
    for (const code of [...new Set(subset.flatMap(row => row.evidenceCodes.length ? row.evidenceCodes : ['none']))].sort()) {
      byEvidence[code] = summarize(subset.filter(row => code === 'none' ? !row.evidenceCodes.length : row.evidenceCodes.includes(code)));
    }
    for (const split of [...new Set(subset.map(row => row.split))].sort()) bySplit[split] = summarize(subset.filter(row => row.split === split));
    byPlatform[platform] = { ...summarize(subset), byEvidence, bySplit };
  }
  return {
    schemaVersion: 1, total: rows.length, excludedUnknownLabels: rows.filter(row => row.label === 'unknown').length,
    dataset: { sha256: sha256(JSON.stringify(samples)), syntheticRows: rows.filter(row => row.labelSource?.kind === 'synthetic').length, realLabelledRows: rows.filter(row => row.label !== 'unknown' && row.labelSource?.kind !== 'synthetic').length },
    runtime: { node: process.versions.node, sources },
    strategies: ['bilibili', 'douyin'].map(platform => { const strategy = detection.get(platform); return { platform, version: strategy.version, policy: JSON.parse(JSON.stringify(strategy.getPolicy({}))) }; }),
    byPlatform, rows,
  };
}

function summarize(rows) {
  const labelled = rows.filter(row => row.label === 'automatic' || row.label === 'human');
  const automatic = labelled.filter(row => row.label === 'automatic'), human = labelled.filter(row => row.label === 'human');
  const candidate = row => row.prediction === 'fish' || row.prediction === 'suspect';
  const tp = automatic.filter(row => row.prediction === 'fish').length, fp = human.filter(row => row.prediction === 'fish').length;
  const fn = automatic.length - tp, tn = human.length - fp;
  const candidateTp = automatic.filter(candidate).length, candidateFp = human.filter(candidate).length;
  const matrix = {};
  for (const label of LABELS) matrix[label] = Object.fromEntries(PREDICTIONS.map(prediction => [prediction, rows.filter(row => row.label === label && row.prediction === prediction).length]));
  return {
    rows: rows.length, labelled: labelled.length, unknownLabels: rows.length - labelled.length, confusion: { tp, fp, fn, tn }, matrix,
    fishPrecision: ratio(tp, tp + fp), fishRecall: ratio(tp, automatic.length), falsePositiveRate: ratio(fp, human.length),
    candidatePrecision: ratio(candidateTp, candidateTp + candidateFp), candidateRecall: ratio(candidateTp, automatic.length), candidateFalsePositiveRate: ratio(candidateFp, human.length),
    abstainRate: ratio(rows.filter(row => row.prediction === 'unknown').length, rows.length),
    fishPredictions: rows.filter(row => row.prediction === 'fish').length, candidatePredictions: rows.filter(candidate).length,
    errors: rows.filter(row => row.label === 'automatic' && row.prediction !== 'fish' || row.label === 'human' && candidate(row)).map(row => ({
      id: row.id, label: row.label, prediction: row.prediction, score: row.score,
      type: row.label === 'automatic' ? 'missed-fish' : row.prediction === 'fish' ? 'false-fish' : 'false-candidate',
    })),
  };
}

function ratio(numerator, denominator) { return denominator ? Number((numerator / denominator).toFixed(4)) : null; }

function main(argv) {
  const positional = argv.filter(arg => !arg.startsWith('-'));
  if (argv.includes('--help') && argv.length === 1) {
    console.log('Usage: node tools/evaluate-detection.cjs <samples.json|samples.jsonl> [--json]'); return;
  }
  if (positional.length !== 1 || argv.some(arg => arg.startsWith('-') && arg !== '--json')) {
    console.error('Usage: node tools/evaluate-detection.cjs <samples.json|samples.jsonl> [--json]'); process.exitCode = 2; return;
  }
  try {
    const report = evaluate(readSamples(path.resolve(positional[0])));
    if (argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
    else {
      console.log(`rows=${report.total} synthetic=${report.dataset.syntheticRows} real-labelled=${report.dataset.realLabelledRows} unknown-labels=${report.excludedUnknownLabels}`);
      for (const [platform, summary] of Object.entries(report.byPlatform)) console.log(`${platform}: fish-precision=${summary.fishPrecision ?? 'n/a'} fish-recall=${summary.fishRecall ?? 'n/a'} candidate-recall=${summary.candidateRecall ?? 'n/a'} fpr=${summary.falsePositiveRate ?? 'n/a'} abstain=${summary.abstainRate ?? 'n/a'}`);
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

if (require.main === module) main(process.argv.slice(2));
module.exports = { evaluate, readSamples, summarize, findLeakage };
