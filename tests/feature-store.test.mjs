import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const modulePath = '../src/feature-store.mjs';
async function api() { return import(modulePath); }
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'feature-store-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { id: 'fixture', root, featureMapRef: { schemaVersion: 1, path: 'docs/feature-map.json', historyDir: 'docs/history', evidenceDir: 'evidence' } };
}
test('deterministic hash rejects duplicate keys and non-finite JSON', async () => {
  const { parseStrictJson, hashContent } = await api();
  assert.equal(hashContent({ b: 2, a: 1 }), hashContent({ a: 1, b: 2 }));
  assert.throws(() => parseStrictJson('{"a":1,"a":2}'), /duplicate/);
  assert.throws(() => parseStrictJson('{"a":1e400}'), /finite/);
  assert.throws(() => parseStrictJson('{"x":{"a":1,"\\u0061":2}}'), /duplicate/);
});
test('every write is CAS protected and replay returns original result', async t => {
  const p = await fixture(t); const { transact, readMap } = await api();
  const opts = { expectedRevision: 0, expectedHash: null, requestId: 'init' };
  const first = await transact(p, 'init', { name: 'a' }, opts, m => { m.name = 'a'; return { assignedIds: ['REQ-0001'] }; });
  const map = await readMap(p);
  assert.equal(map.revision, 1);
  assert.deepEqual(await transact(p, 'init', { name: 'a' }, opts, () => { throw Error('must not execute'); }), first);
  await assert.rejects(transact(p, 'init', { name: 'b' }, opts, () => {}), /idempotency_conflict/);
  await assert.rejects(transact(p, 'change', {}, opts, () => {}), /request/);
  await assert.rejects(transact(p, 'change', {}, { ...opts, requestId: 'wrong' }, () => {}), /revision_conflict/);
  await transact(p, 'change', {}, { expectedRevision: 1, expectedHash: map.contentHash, requestId: 'next' }, m => { m.name = 'b'; });
  const history = await fs.readdir(path.join(p.root, 'docs/history'));
  assert.equal(history.length, 1);
  const current = await readMap(p); current.name = 'manual';
  await fs.writeFile(path.join(p.root, p.featureMapRef.path), JSON.stringify(current));
  await assert.rejects(readMap(p), /external_edit_detected/);
});
test('parallel writers cannot silently overwrite and paths cannot escape', async t => {
  const p = await fixture(t); const { transact, readMap } = await api();
  await transact(p, 'init', {}, { expectedRevision: 0, expectedHash: null, requestId: 'init' }, () => {});
  const m = await readMap(p);
  const writes = await Promise.allSettled(['a','b'].map(requestId => transact(p, 'change', { requestId }, { expectedRevision: 1, expectedHash: m.contentHash, requestId }, async map => { await new Promise(r => setTimeout(r, 20)); map.label = requestId; })));
  assert.equal(writes.filter(x => x.status === 'fulfilled').length, 1);
  await assert.rejects(readMap({ ...p, featureMapRef: { ...p.featureMapRef, path: '../escape.json' } }), /escape/);
});
test('snapshot-before-commit recovery verifies existing history and never overwrites corruption', async t => {
  const p = await fixture(t); const { transact, readMap } = await api();
  await transact(p, 'init', {}, { expectedRevision: 0, expectedHash: null, requestId: 'init' }, () => {});
  const m = await readMap(p); await fs.mkdir(path.join(p.root, 'docs/history'));
  const snapshot = path.join(p.root, 'docs/history', `${m.revision}-${m.contentHash}.json`);
  await fs.writeFile(snapshot, JSON.stringify(m));
  const options = { expectedRevision: 1, expectedHash: m.contentHash, requestId: 'after-interruption' };
  await transact(p, 'change', {}, options, map => { map.recovered = true; });
  assert.equal((await readMap(p)).recovered, true);
  const now = await readMap(p), corruptPath = path.join(p.root, 'docs/history', `${now.revision}-${now.contentHash}.json`);
  await fs.writeFile(corruptPath, JSON.stringify({ ...now, projectId: 'corrupt' }));
  await assert.rejects(transact(p, 'change', {}, { expectedRevision: 2, expectedHash: now.contentHash, requestId: 'new' }, () => {}), /history_corrupt/);
  assert.equal((await readMap(p)).revision, 2);
});
test('live owner lock is never removed by age and view can be rebuilt after interrupted projection', async t => {
  const p = await fixture(t); const { transact, readMap, recoverLock, rebuildProjection } = await api();
  await transact(p, 'init', {}, { expectedRevision: 0, expectedHash: null, requestId: 'init' }, () => {});
  const lockFile = path.join(p.root, 'docs/feature-map.json.lock');
  await fs.writeFile(lockFile, JSON.stringify({ pid: process.pid, host: os.hostname(), startedAt: '1970-01-01', token: 'live' }));
  await assert.rejects(recoverLock(p), /alive/);
  await fs.unlink(lockFile);
  await fs.unlink(path.join(p.root, 'docs/feature-map.md'));
  await rebuildProjection(p); assert.match(await fs.readFile(path.join(p.root, 'docs/feature-map.md'), 'utf8'), /修订 1/);
  assert.equal((await readMap(p)).revision, 1);
});

test('feature projection exposes source, subfunction, operation and verification for a new reader', async t => {
  const p = await fixture(t); const { rebuildProjection } = await api();
  await fs.mkdir(path.join(p.root, 'docs'));
  await rebuildProjection(p, {
    projectId: p.id, revision: 3,
    features: [{ id: 'FEAT-0001', title: '记录', lifecycle: 'active', deliveryStatus: 'implemented', goal: '保存并查回记录', sourceRef: 'REQ-note', requirementIds: ['REQ-0001'], entrypointIds: ['ui-create'], scope: ['local'], exclusions: [], humanAutomation: {} }],
    acceptanceCriteria: [{ id: 'AC-0001', revision: 2, featureId: 'FEAT-0001', preconditions: ['服务就绪'], actions: [{ type: 'click' }], expected: '刷新后仍可见', verificationMethod: 'ui', requiredTargets: [{ targetId: 'create-and-reload' }], pitfalls: ['先确认使用隔离数据目录'] }],
    evidence: [{ id: 'EVD-0001', acId: 'AC-0001' }]
  });
  const view = await fs.readFile(path.join(p.root, 'docs/feature-map.md'), 'utf8');
  for (const expected of ['用途：保存并查回记录', '来源：REQ-note', '入口：ui-create', '### 子功能与成功条件', 'AC-0001：刷新后仍可见', '前提：["服务就绪"]', '操作：[{"type":"click"}]', '验证方式：ui', '陷阱：["先确认使用隔离数据目录"]', '证据：EVD-0001']) assert.ok(view.includes(expected), expected);
});
