#!/usr/bin/env node
/* Check local Chromium packaging inputs. Browser validation remains separate. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');

function walk(root) {
  const out = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'release' || entry.name === 'node_modules') continue;
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...walk(file)); else out.push(file);
  }
  return out;
}

function checkReference(root, ref, errors) {
  const file = path.resolve(root, ref);
  if (!inside(root, file) || !fs.existsSync(file) || !fs.statSync(file).isFile()) errors.push(`missing or invalid resource: ${ref}`);
}

function expandGlob(root, pattern) {
  if (!pattern.includes('*')) return fs.existsSync(path.resolve(root, pattern)) && inside(root, path.resolve(root, pattern)) ? [pattern] : [];
  const regex = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
  return walk(root).map(file => path.relative(root, file).replaceAll(path.sep, '/')).filter(file => regex.test(file));
}

function inside(root, file) {
  const relative = path.relative(path.resolve(root), file);
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

function localReference(root, sourceFile, value, errors) {
  if (!value || /^(?:https?:|data:|blob:|#|\/\/)/i.test(value)) return;
  const clean = value.split(/[?#]/)[0];
  const absolute = value.startsWith('/') ? path.resolve(root, '.' + clean) : path.resolve(path.dirname(sourceFile), clean);
  checkReference(root, path.relative(root, absolute), errors);
}

function validateTree(root) {
  const manifestFile = path.join(root, 'manifest.json'), errors = [], warnings = [];
  if (!fs.existsSync(manifestFile)) return { ok: false, errors: ['manifest.json is missing'], warnings: [], files: [] };
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')); } catch (error) { return { ok: false, errors: [`manifest.json: ${error.message}`], warnings: [], files: [] }; }
  if (manifest.manifest_version !== 3) errors.push('expected Chromium manifest_version 3');
  if (!/^\d+(?:\.\d+){0,3}$/.test(manifest.version || '')) errors.push('invalid extension version');
  for (const group of manifest.content_scripts || []) for (const file of [...(group.js || []), ...(group.css || [])]) checkReference(root, file, errors);
  for (const file of [manifest.background?.service_worker, manifest.action?.default_popup, manifest.options_ui?.page].filter(Boolean)) checkReference(root, file, errors);
  for (const icon of Object.values(manifest.icons || {})) checkReference(root, icon, errors);
  for (const actionIcon of Object.values(manifest.action?.default_icon || {})) checkReference(root, actionIcon, errors);
  for (const resource of (manifest.web_accessible_resources || []).flatMap(group => group.resources || [])) {
    const matches = expandGlob(root, resource); if (!matches.length) errors.push(`missing resource glob: ${resource}`);
    for (const file of matches) checkReference(root, file, errors);
  }
  const tree = walk(root);
  for (const file of tree.filter(file => /\.(?:html|css|js)$/.test(file))) {
    const source = fs.readFileSync(file, 'utf8');
    if (file.endsWith('.html')) {
      for (const match of source.matchAll(/<(script|link|img)\b[^>]*?\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)) localReference(root, file, match[2], errors);
    }
    if (file.endsWith('.css')) {
      for (const match of source.matchAll(/url\(\s*["']?([^\s"')]+)["']?\s*\)/g)) localReference(root, file, match[1], errors);
    }
    if (file.endsWith('.js')) {
      for (const call of source.matchAll(/\bimportScripts\(([^)]+)\)/g)) for (const match of call[1].matchAll(/["']([^"']+)["']/g)) localReference(root, file, match[1], errors);
      for (const match of source.matchAll(/\bgetURL\(["']([^"']+)["']\)/g)) checkReference(root, match[1], errors);
      for (const match of source.matchAll(/\bgetURL\(`([^`]+)`\)/g)) {
        const pattern = match[1].replace(/\$\{[^}]+\}/g, '*');
        if (!expandGlob(root, pattern).length) errors.push(`missing runtime asset pattern: ${pattern}`);
      }
    }
  }
  for (const file of tree.filter(file => file.endsWith('.js'))) {
    try { childProcess.execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' }); } catch (error) { errors.push(`syntax error: ${path.relative(root, file)}: ${String(error.stderr || error.message).trim()}`); }
  }
  if (manifest.browser_specific_settings) warnings.push('browser_specific_settings is present; browser compatibility still requires manual testing');
  const files = tree.map(file => ({ path: path.relative(root, file).replaceAll(path.sep, '/'), bytes: fs.statSync(file).size, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') }));
  return { ok: errors.length === 0, errors, warnings, version: manifest.version, files };
}

function createSnapshot(root, outputRoot = path.resolve(__dirname, '..', 'release')) {
  if (path.resolve(root) === path.resolve(outputRoot) || inside(root, path.resolve(outputRoot))) throw new Error('snapshot output must be outside the extension source tree');
  const report = validateTree(root); if (!report.ok) throw new Error(report.errors.join('\n'));
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  fs.mkdirSync(outputRoot, { recursive: true });
  const target = fs.mkdtempSync(path.join(outputRoot, `chromium-${report.version}-${stamp}-`));
  for (const file of report.files) {
    const dest = path.join(target, file.path); fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(root, file.path), dest, fs.constants.COPYFILE_EXCL);
    const hash = crypto.createHash('sha256').update(fs.readFileSync(dest)).digest('hex');
    if (hash !== file.sha256) throw new Error(`source changed while packaging: ${file.path}; discard ${target}`);
  }
  fs.writeFileSync(path.join(target, 'BUILD-INFO.json'), JSON.stringify({ kind: 'chromium-unpacked', version: report.version, generatedAt: new Date().toISOString(), files: report.files }, null, 2));
  return { target, report };
}

if (require.main === module) {
  const argv = process.argv.slice(2), positional = argv.filter(arg => !arg.startsWith('-'));
  if (positional.length > 1 || argv.some(arg => arg.startsWith('-') && !['--snapshot', '--json'].includes(arg))) {
    console.error('Usage: node tools/validate-release.cjs [extension-folder] [--snapshot] [--json]'); process.exitCode = 2;
  } else try {
    const root = path.resolve(positional[0] || path.join(__dirname, '..', 'dafeiyu-cleaner'));
    const result = argv.includes('--snapshot') ? createSnapshot(root) : { report: validateTree(root) };
    console.log(JSON.stringify(argv.includes('--json') ? result : { ok: result.report.ok, target: result.target, files: result.report.files.length, version: result.report.version, errors: result.report.errors, warnings: result.report.warnings }, null, 2));
    if (!result.report.ok) process.exitCode = 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { walk, validateTree, createSnapshot };
