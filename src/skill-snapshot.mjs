import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { verifyStableRelease } from './stable-release.mjs';
import { assert, within } from './paths.mjs';

const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const hex = /^[a-f0-9]{64}$/;
const skills = new Set(['codex-engineering', 'review-product-plan']);
const privateNames = new Set(['runtime.json', 'runtime.local.json']);
const same = (a, b) => path.relative(a, b) === '';
function safeRelative(relative) {
  assert(typeof relative === 'string' && relative && !path.isAbsolute(relative) && !relative.includes('\\') &&
    !relative.includes(':') && !relative.includes('\0') && relative.split('/').every(part => part && part !== '.' && part !== '..'),
  'Unsafe snapshot path/traversal');
  return relative;
}
function publicRelative(relative) {
  safeRelative(relative);
  const parts = relative.split('/');
  assert(parts.length > 1 && skills.has(parts[0]) && !parts.some(part => privateNames.has(part.toLowerCase())),
    'Snapshot target must be a public file of an approved Skill');
  return relative;
}
async function directory(root) {
  assert(typeof root === 'string' && path.isAbsolute(root), 'Absolute directory required');
  const stat = await fs.lstat(root);
  assert(stat.isDirectory() && !stat.isSymbolicLink() && same(await fs.realpath(root), root), 'Snapshot directory is linked or not a directory');
  return path.resolve(root);
}
async function checkedPath(root, relative, makeParents = false) {
  safeRelative(relative); await directory(root);
  let current = root;
  const parts = relative.split('/');
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    let stat;
    try { stat = await fs.lstat(current); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    assert(!stat?.isSymbolicLink(), `Snapshot target is linked: ${current}`);
    if (i < parts.length - 1) {
      if (!stat && makeParents) { await fs.mkdir(current); stat = await fs.lstat(current); }
      assert(!stat || stat.isDirectory(), `Snapshot parent is not a directory: ${current}`);
    } else assert(!stat || stat.isFile(), `Snapshot target is not a regular file: ${current}`);
  }
  assert(within(root, current), 'Snapshot path escapes root');
  return current;
}
async function readState(root, relative) {
  const file = await checkedPath(root, relative);
  try { const bytes = await fs.readFile(file); return { sha256: hash(bytes), bytes }; }
  catch (error) { if (error.code !== 'ENOENT') throw error; return { sha256: null, bytes: null }; }
}
async function compare(root, relative, expected) {
  assert((await readState(root, relative)).sha256 === expected, `Snapshot target changed/later edit: ${relative}`);
}
async function replace(root, relative, bytes, expected) {
  await compare(root, relative, expected);
  const file = await checkedPath(root, relative, bytes !== null);
  if (bytes === null) { await compare(root, relative, expected); await fs.unlink(file); return; }
  const temp = `${file}.${crypto.randomUUID()}.skill-snapshot-tmp`;
  try {
    await fs.writeFile(temp, bytes, { flag: 'wx', mode: 0o600 });
    await compare(root, relative, expected);
    // An initially absent file gets an atomic no-overwrite create.
    if (expected === null) await fs.link(temp, file);
    else await fs.rename(temp, file);
  } finally { await fs.rm(temp, { force: true }).catch(() => {}); }
}
async function backupBytes(root, relative, expected) {
  const state = await readState(root, relative);
  assert(state.bytes !== null && state.sha256 === expected, `Snapshot backup changed: ${relative}`);
  return state.bytes;
}
async function saveNew(root, relative, bytes) {
  const file = await checkedPath(root, relative, true);
  await fs.writeFile(file, bytes, { flag: 'wx', mode: 0o600 });
}
async function receipt(backupDir, kind, content) {
  await saveNew(backupDir, `${kind}-${crypto.randomUUID()}.json`, Buffer.from(JSON.stringify(content, null, 2) + '\n'));
}
async function undoChanged(record, changed, direction) {
  const gaps = [];
  for (const item of [...changed].reverse()) {
    const expected = direction === 'before' ? item.afterSha256 : item.beforeSha256;
    const wanted = direction === 'before' ? item.beforeSha256 : item.afterSha256;
    const stored = direction === 'before' ? item.beforeBackup : item.afterBackup;
    try {
      const bytes = wanted === null ? null : await backupBytes(record.backupDir, stored, wanted);
      await replace(record.skillRoot, item.relative, bytes, expected);
    } catch (error) { gaps.push({ relative: item.relative, reason: error.message }); }
  }
  return gaps;
}

/** Refresh only verified manifest Skill files; installed runtime bindings remain private. */
export async function applySkillSnapshot({ manifestPath, skillRoot, backupDir }) {
  assert(typeof manifestPath === 'string' && path.isAbsolute(manifestPath), 'Absolute manifest path required');
  const manifestBytes = await fs.readFile(manifestPath);
  const stable = await verifyStableRelease(manifestPath);
  assert((await fs.readFile(manifestPath)).equals(manifestBytes), 'Stable manifest changed during verification');
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  skillRoot = await directory(skillRoot);
  assert(typeof backupDir === 'string' && path.isAbsolute(backupDir), 'Absolute backup directory required');
  backupDir = path.resolve(backupDir);
  await directory(path.dirname(backupDir));
  assert(!within(skillRoot, backupDir) && !within(backupDir, skillRoot) &&
    !within(stable.packageRoot, skillRoot) && !within(skillRoot, stable.packageRoot) &&
    !within(stable.packageRoot, backupDir) && !within(backupDir, stable.packageRoot), 'Snapshot directories overlap');
  const entries = [], afterBytes = new Map();
  for (const manifestRelative of Object.keys(manifest.files).sort()) {
    safeRelative(manifestRelative);
    if (!manifestRelative.startsWith('skills/')) continue;
    const relative = manifestRelative.slice('skills/'.length), parts = relative.split('/');
    if (!skills.has(parts[0]) || parts.some(part => privateNames.has(part.toLowerCase()))) continue;
    publicRelative(relative);
    const source = await readState(stable.packageRoot, manifestRelative);
    assert(source.bytes !== null && source.sha256 === manifest.files[manifestRelative], 'Verified Skill source changed during preparation');
    const before = await readState(skillRoot, relative);
    entries.push({ relative, beforeSha256: before.sha256, beforeBackup: before.bytes === null ? null : `before/${relative}`,
      afterSha256: source.sha256, afterBackup: `after/${relative}`, beforeBytes: before.bytes });
    afterBytes.set(relative, source.bytes);
  }
  assert([...skills].every(name => entries.some(item => item.relative === `${name}/SKILL.md`)), 'Both approved Skills must have a manifest SKILL.md');
  // All target paths and old hashes are captured before the first write or backup creation.
  for (const item of entries) await compare(skillRoot, item.relative, item.beforeSha256);
  await fs.mkdir(backupDir); // A backup is always new and never reused.
  for (const item of entries) {
    if (item.beforeBytes !== null) await saveNew(backupDir, item.beforeBackup, item.beforeBytes);
    await saveNew(backupDir, item.afterBackup, afterBytes.get(item.relative));
    delete item.beforeBytes;
  }
  const record = { schemaVersion: 1, kind: 'skill-snapshot', createdAt: new Date().toISOString(),
    manifestPath, stableRoot: stable.packageRoot, version: stable.version, skillRoot, backupDir, entries };
  record.contentHash = hash(Buffer.from(JSON.stringify(record)));
  const recordPath = path.join(backupDir, 'record.json');
  await saveNew(backupDir, 'record.json', Buffer.from(JSON.stringify(record, null, 2) + '\n'));
  const changed = [];
  try {
    for (const item of entries) await compare(skillRoot, item.relative, item.beforeSha256);
    for (const item of entries) if (item.beforeSha256 !== item.afterSha256) {
      await replace(skillRoot, item.relative, await backupBytes(backupDir, item.afterBackup, item.afterSha256), item.beforeSha256);
      changed.push(item);
    }
    await receipt(backupDir, 'applied', { status: 'applied', changed: changed.length, recordPath });
    return { status: 'applied', version: stable.version, changed: changed.length, recordPath, backupDir,
      preservedPrivateRuntime: true, skills: [...skills] };
  } catch (error) {
    const restorationGaps = await undoChanged(record, changed, 'before');
    await receipt(backupDir, 'apply-failed', { error: error.message, recordPath, restorationGaps }).catch(() => {});
    throw new Error(`${error.message}; automatic restore ${restorationGaps.length ? 'blocked for scoped targets: ' + JSON.stringify(restorationGaps) : 'completed'}; record: ${recordPath}`);
  }
}

/** Preflight every current hash first; never partially revert over a later user edit. */
export async function revertSkillSnapshot(recordPath) {
  assert(typeof recordPath === 'string' && path.isAbsolute(recordPath), 'Absolute snapshot record path required');
  const backupDir = await directory(path.dirname(recordPath));
  assert(path.basename(recordPath) === 'record.json', 'Snapshot record must be record.json in its backup directory');
  const raw = await readState(backupDir, 'record.json');
  assert(raw.bytes !== null, 'Snapshot record missing');
  const record = JSON.parse(raw.bytes.toString('utf8')), { contentHash, ...body } = record;
  assert(hex.test(contentHash || '') && hash(Buffer.from(JSON.stringify(body))) === contentHash, 'Snapshot record changed');
  assert(record.schemaVersion === 1 && record.kind === 'skill-snapshot' && same(record.backupDir, backupDir) && Array.isArray(record.entries), 'Invalid snapshot record');
  await directory(record.skillRoot);
  assert(!within(record.skillRoot, backupDir) && !within(backupDir, record.skillRoot), 'Snapshot backup overlaps target');
  const seen = new Set(), states = [], data = new Map();
  for (const item of record.entries) {
    publicRelative(item.relative);
    assert(!seen.has(item.relative) && hex.test(item.afterSha256) && (item.beforeSha256 === null || hex.test(item.beforeSha256)), 'Invalid or duplicate snapshot entry');
    seen.add(item.relative);
    assert(item.afterBackup === `after/${item.relative}` && item.beforeBackup === (item.beforeSha256 === null ? null : `before/${item.relative}`), 'Snapshot backup path differs from target');
    const before = item.beforeSha256 === null ? null : await backupBytes(backupDir, item.beforeBackup, item.beforeSha256);
    await backupBytes(backupDir, item.afterBackup, item.afterSha256);
    data.set(item.relative, before);
    const current = (await readState(record.skillRoot, item.relative)).sha256;
    assert(current === item.afterSha256 || current === item.beforeSha256, `Snapshot target has a later edit: ${item.relative}`);
    states.push(current);
  }
  const changed = [];
  try {
    for (let i = 0; i < record.entries.length; i++) {
      const item = record.entries[i];
      if (states[i] !== item.beforeSha256) {
        await replace(record.skillRoot, item.relative, data.get(item.relative), item.afterSha256);
        changed.push(item);
      }
    }
    await receipt(backupDir, 'reverted', { status: 'reverted', restored: changed.length, recordPath });
    return { status: 'reverted', restored: changed.length, recordPath, backupRetained: true };
  } catch (error) {
    const restorationGaps = await undoChanged(record, changed, 'after');
    await receipt(backupDir, 'revert-failed', { error: error.message, recordPath, restorationGaps }).catch(() => {});
    throw new Error(`${error.message}; revert recovery ${restorationGaps.length ? 'blocked for scoped targets: ' + JSON.stringify(restorationGaps) : 'completed'}; record: ${recordPath}`);
  }
}
