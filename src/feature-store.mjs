import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { assert, within, mkdirInside, VERSION } from './paths.mjs';

// JSON.parse alone silently accepts duplicate keys and overflowing numbers.
export function parseStrictJson(text) {
  text = text.replace(/^\uFEFF/, ''); let i = 0;
  const ws = () => { while (/\s/.test(text[i] || '') && i < text.length) i++; };
  function string() {
    const start = i++; let escape = false;
    while (i < text.length) { const c = text[i++]; if (c === '"' && !escape) return JSON.parse(text.slice(start, i)); if (c === '\\' && !escape) escape = true; else escape = false; }
    throw Error('Invalid JSON string');
  }
  function value() {
    ws(); const c = text[i];
    if (c === '"') return string();
    if (c === '{') {
      i++; ws(); const result = Object.create(null), keys = new Set();
      if (text[i] === '}') { i++; return result; }
      for (;;) { ws(); assert(text[i] === '"', 'Invalid JSON key'); const k = string(); assert(!keys.has(k), `duplicate JSON key: ${k}`); keys.add(k); ws(); assert(text[i++] === ':', 'Invalid JSON colon'); result[k] = value(); ws(); if (text[i] === '}') { i++; return result; } assert(text[i++] === ',', 'Invalid JSON object'); }
    }
    if (c === '[') {
      i++; ws(); const result = []; if (text[i] === ']') { i++; return result; }
      for (;;) { result.push(value()); ws(); if (text[i] === ']') { i++; return result; } assert(text[i++] === ',', 'Invalid JSON array'); }
    }
    const match = /^(true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(i));
    assert(match, 'Invalid JSON value'); i += match[0].length; const n = JSON.parse(match[0]); assert(typeof n !== 'number' || Number.isFinite(n), 'JSON number must be finite'); return n;
  }
  value(); ws(); assert(i === text.length, 'Trailing JSON content'); return JSON.parse(text);
}
export function canonicalize(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') { assert(Number.isFinite(value), 'JSON number must be finite'); return JSON.stringify(value); }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  assert(value && typeof value === 'object', 'Non JSON value');
  return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(',')}}`;
}
export const hashContent = value => crypto.createHash('sha256').update(canonicalize(value)).digest('hex');
export const mapHash = value => { const { contentHash, ...rest } = value; return hashContent(rest); };

export async function scopedPath(root, relative, { createParent = false } = {}) {
  assert(typeof relative === 'string' && relative && !path.isAbsolute(relative), 'Relative scoped path required');
  const base = await fs.realpath(root), target = path.resolve(base, relative);
  assert(within(base, target) && target !== base, 'Path escapes declared root');
  let current = base;
  for (const part of path.relative(base, target).split(path.sep)) {
    current = path.join(current, part);
    try { assert(within(base, await fs.realpath(current)), 'Link escapes declared root'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  if (createParent) await mkdirInside(base, path.relative(base, path.dirname(target)));
  return target;
}
export async function mapPaths(profile, create = false) {
  const ref = profile.featureMapRef;
  assert(ref?.schemaVersion === 1, 'needs_feature_map: bind one versioned featureMapRef');
  const file = await scopedPath(profile.root, ref.path, { createParent: create });
  const history = await scopedPath(profile.root, ref.historyDir);
  const evidence = await scopedPath(profile.root, ref.evidenceDir);
  assert(file !== history && file !== evidence && history !== evidence && !within(history, file) && !within(evidence, file), 'Map, history and evidence must be separate');
  return { file, history, evidence, summary: file.replace(/\.json$/, '') + '.md' };
}
export async function readMap(profile, { allowAbsent = false } = {}) {
  const { file } = await mapPaths(profile);
  let text;
  try { text = await fs.readFile(file, 'utf8'); } catch (e) { if (allowAbsent && e.code === 'ENOENT') return null; throw e; }
  const map = parseStrictJson(text);
  assert(map.projectId === profile.id, 'wrong_project');
  assert(map.contentHash === mapHash(map), 'external_edit_detected: current map hash differs');
  return map;
}
async function durableTemp(file, text) {
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  const handle = await fs.open(temp, 'wx');
  try { await handle.writeFile(text, 'utf8'); await handle.sync(); } finally { await handle.close(); }
  return temp;
}
async function lock(file) {
  const lockFile = `${file}.lock`;
  const token = crypto.randomUUID();
  // An existing lock is never removed on time alone. Explicit recovery verifies
  // host and dead PID; PID reuse conservatively keeps the lock blocked.
  let handle;
  try { handle = await fs.open(lockFile, 'wx'); } catch (e) { if (e.code === 'EEXIST') throw Error('map_locked: inspect lock owner; use feature recover-lock after process exit'); throw e; }
  await handle.writeFile(JSON.stringify({ pid: process.pid, host: os.hostname(), startedAt: new Date().toISOString(), token })); await handle.sync(); await handle.close();
  return async () => { const current = parseStrictJson(await fs.readFile(lockFile, 'utf8')); assert(current.token === token, 'lock_owner_changed'); await fs.unlink(lockFile); };
}
export async function recoverLock(profile) {
  const { file } = await mapPaths(profile); const lockFile = `${file}.lock`;
  const raw = await fs.readFile(lockFile, 'utf8'), owner = parseStrictJson(raw);
  assert(owner.host === os.hostname() && Number.isInteger(owner.pid) && owner.pid > 0, 'lock_owner_unverifiable');
  let dead = false; try { process.kill(owner.pid, 0); } catch (e) { if (e.code === 'ESRCH') dead = true; }
  assert(dead, 'lock_owner_alive_or_unverifiable');
  assert(await fs.readFile(lockFile, 'utf8') === raw, 'lock_owner_changed');
  await fs.unlink(lockFile); return { status: 'lock_recovered', owner };
}
export async function rebuildProjection(profile, map = null) {
  map ||= await readMap(profile); const { summary } = await mapPaths(profile);
  const lines = [`# Feature map: ${map.projectId}`, '', `只读投影；权威记录 ${profile.featureMapRef.path}，修订 ${map.revision}。`, '', ...map.features.flatMap(f => [
    `## ${f.id} ${f.title}`, `${f.lifecycle} / ${f.deliveryStatus}`, `用途：${f.goal}`, `需求：${f.requirementIds.join(', ') || '未关联'}；来源：${f.sourceRef || '未记录'}`, `入口：${(f.entrypointIds || []).join(', ') || '未登记'}`, `范围：${JSON.stringify(f.scope)}；排除：${JSON.stringify(f.exclusions)}`, `人机分工：${JSON.stringify(f.humanAutomation)}`,
    '### 子功能与成功条件', ...map.acceptanceCriteria.filter(ac => ac.featureId === f.id).map(ac => `- ${ac.id}：${ac.expected}（${(ac.requiredTargets || []).map(t => t.targetId).join(', ') || '未登记目标'}）`),
    ...map.acceptanceCriteria.filter(ac => ac.featureId === f.id).flatMap(ac => [`### ${ac.id} r${ac.revision}`, `前提：${JSON.stringify(ac.preconditions)}`, `操作：${JSON.stringify(ac.actions)}`, `成功条件：${JSON.stringify(ac.expected)}`, `验证方式：${ac.verificationMethod || '未登记'}`, `目标与断言：${JSON.stringify(ac.requiredTargets)}`, `陷阱：${(ac.pitfalls || []).length ? JSON.stringify(ac.pitfalls) : '暂无已知项'}`, `证据：${map.evidence.filter(e => e.acId === ac.id).map(e => e.id).join(', ') || '未运行'}`]), '' ])];
  const temp = await durableTemp(summary, lines.join('\n') + '\n'); try { await fs.rename(temp, summary); } finally { await fs.unlink(temp).catch(() => {}); }
  return summary;
}
export async function transact(profile, command, input, options, mutate, validate = () => {}) {
  const { expectedRevision, expectedHash, requestId, preview = false } = options;
  assert(Number.isInteger(expectedRevision) && expectedRevision >= 0 && (expectedHash === null || /^[a-f0-9]{64}$/.test(expectedHash || '')), 'expected_revision_and_hash_required');
  assert(typeof requestId === 'string' && requestId.length > 0 && requestId.length <= 160, 'request_id_required');
  const paths = await mapPaths(profile, !preview);
  const release = preview ? async () => {} : await lock(paths.file);
  try {
    const before = await readMap(profile, { allowAbsent: true });
    const requestHash = hashContent({ command, projectId: profile.id, input });
    const committed = before?.committedRequests.find(r => r.requestId === requestId);
    if (committed) { assert(committed.requestHash === requestHash, 'idempotency_conflict: request content differs'); return committed.result; }
    assert((before?.revision || 0) === expectedRevision, 'revision_conflict');
    assert((before?.contentHash || null) === expectedHash, 'external_edit_detected: expected hash differs');
    assert(command !== 'init' || !before, 'map_already_exists');
    assert(command === 'init' || before, 'needs_feature_map');
    const map = before ? structuredClone(before) : { schemaVersion: 1, projectId: profile.id, sharedVersion: VERSION, revision: 0, requirements: [], features: [], acceptanceCriteria: [], changes: [], evidence: [], iterations: [], carryForward: [], committedRequests: [] };
    const detail = await mutate(map, before) || {};
    map.revision++; map.updatedAt = new Date().toISOString(); map.previousRevisionHash = before?.contentHash || null;
    const result = { status: preview ? 'preview' : 'committed', revision: map.revision, ...detail };
    map.committedRequests.push({ requestId, requestHash, committedRevision: map.revision, assignedIds: detail.assignedIds || [], result });
    await validate(map, before); map.contentHash = mapHash(map);
    if (preview) return { ...result, proposedHash: map.contentHash };
    if (before) {
      await mkdirInside(profile.root, profile.featureMapRef.historyDir);
      const historyFile = path.join(paths.history, `${before.revision}-${before.contentHash}.json`);
      try {
        const existing = parseStrictJson(await fs.readFile(historyFile, 'utf8'));
        assert(existing.contentHash === before.contentHash && mapHash(existing) === before.contentHash, 'history_corrupt');
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
        const temp = await durableTemp(historyFile, JSON.stringify(before, null, 2) + '\n');
        try { await fs.link(temp, historyFile); } catch (e) { if (e.code !== 'EEXIST') throw e; const existing = parseStrictJson(await fs.readFile(historyFile, 'utf8')); assert(mapHash(existing) === before.contentHash, 'history_corrupt'); } finally { await fs.unlink(temp).catch(() => {}); }
      }
    }
    const temp = await durableTemp(paths.file, JSON.stringify(map, null, 2) + '\n');
    try {
      const current = await readMap(profile, { allowAbsent: true });
      assert((current?.revision || 0) === expectedRevision && (current?.contentHash || null) === expectedHash, 'revision_conflict');
      await fs.rename(temp, paths.file);
    } finally { await fs.unlink(temp).catch(() => {}); }
    // Once the map commits, response/reprojection failure must not roll it back.
    await rebuildProjection(profile, map).catch(() => {});
    return result;
  } finally { await release(); }
}
