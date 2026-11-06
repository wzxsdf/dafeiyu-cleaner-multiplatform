const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { validateTree, createSnapshot } = require('../tools/validate-release.cjs');

test('release validator checks production references and JavaScript syntax', () => {
  const report = validateTree(path.resolve(__dirname, '../dafeiyu-cleaner'));
  assert.equal(report.ok, true, report.errors.join('\n'));
  assert.ok(report.files.some(file => file.path === 'manifest.json'));
  assert.ok(report.files.some(file => file.path === 'src/content.js'));
});

function fixture(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dfy-release-test-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const source = path.join(temp, 'source'); fs.mkdirSync(source);
  const write = (name, content) => { const file = path.join(source, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); };
  write('manifest.json', JSON.stringify({ manifest_version: 3, version: '1.0', action: { default_popup: 'popup/popup.html' }, background: { service_worker: 'src/background.js' }, content_scripts: [{ js: ['src/content.js'], css: ['src/content.css'] }], web_accessible_resources: [{ resources: ['assets/*.webp'] }] }));
  write('popup/popup.html', '<script src="popup.js"></script><link href="popup.css" rel="stylesheet">');
  write('popup/popup.js', 'void 0;'); write('popup/popup.css', 'x { background:url(../assets/image.webp) }');
  write('src/background.js', "importScripts('dependency.js');"); write('src/dependency.js', 'void 0;');
  write('src/content.js', "chrome.runtime.getURL('assets/image.webp');"); write('src/content.css', 'x{}'); write('assets/image.webp', 'fixture');
  return { source, temp, write };
}

test('release validation catches missing popup, CSS, worker imports and direct web resources', t => {
  const { source } = fixture(t);
  assert.equal(validateTree(source).ok, true);
  for (const file of ['popup/popup.js', 'src/dependency.js', 'src/content.css', 'assets/image.webp']) {
    const absolute = path.join(source, file), saved = fs.readFileSync(absolute);
    fs.unlinkSync(absolute);
    const report = validateTree(source);
    assert.equal(report.ok, false, file);
    assert.ok(report.errors.some(error => error.includes(path.basename(file)) || error.includes('assets/*.webp')), report.errors.join('\n'));
    fs.writeFileSync(absolute, saved);
  }
});

test('snapshot creates distinct directories, preserves file hashes and refuses output in source', t => {
  const { source, temp } = fixture(t);
  const first = createSnapshot(source, path.join(temp, 'out'));
  const second = createSnapshot(source, path.join(temp, 'out'));
  assert.notEqual(first.target, second.target);
  assert.equal(validateTree(first.target).ok, true);
  const info = JSON.parse(fs.readFileSync(path.join(first.target, 'BUILD-INFO.json'), 'utf8'));
  assert.deepEqual(info.files, first.report.files);
  assert.throws(() => createSnapshot(source, path.join(source, 'nested')), /outside the extension source/);
});
