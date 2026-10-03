import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { readMap } from '../src/feature-store.mjs';

export function draft() { return {
  recordedBy: 'agent:test', sourceRef: 'task:test/local-excerpt/2026-09-23',
  requirements: [{ key: 'req', intent: '保存笔记', decision: 'accepted', decisionRef: 'task:test', schedule: 'current', featureIds: ['@note'], openQuestions: [] }],
  features: [{ key: 'note', title: '笔记', user: '成员', scenario: '记录内容', goal: '可读回笔记', scope: ['保存'], exclusions: ['同步'], humanAutomation: { human: '输入', automatic: '保存' }, requirementIds: ['@req'], dependencyIds: [], entrypointIds: ['cli'], implementationRefs: [], acceptanceCriteria: ['@save'], lifecycle: 'active', deliveryStatus: 'planned' }],
  acceptanceCriteria: [{ key: 'save', featureId: '@note', requirementIds: ['@req'], preconditions: ['项目就绪'], actions: [{ type: 'invoke', description: '保存' }], expected: '读回一致', verificationMethod: 'cli', effects: { writes: 'test-artifacts', network: false, paid: false }, requiredEvidenceTypes: ['execution'], dependencyRefs: [], implementationRefs: [], requiredTargets: [{ targetId: 'save-cli', entrypointId: 'cli', roleRef: 'member', scenario: 'normal', environmentRef: 'test', dataScopeRef: 'isolated' }] }],
  change: { type: 'feature', reason: '用户直接要求', decision: 'accepted', decisionRef: 'task:test', requirementIds: ['@req'], featureIds: ['@note'], acIds: ['@save'], implementationRefs: [], migrationImpact: 'none', recoveryImpact: 'none' }
}; }
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'feature-life-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { id: 'sample', root, featureMapRef: { schemaVersion: 1, path: 'docs/map.json', historyDir: 'docs/history', evidenceDir: 'evidence' } };
}
const initOpts = { expectedRevision: 0, expectedHash: null, requestId: 'init' };
test('0 to 1 assigns stable IDs, enhancement versions AC, title edit does not', async t => {
  const { applyFeatureDraft } = await import('../src/feature.mjs'); const p = await fixture(t);
  await applyFeatureDraft(p, 'init', draft(), initOpts); let map = await readMap(p);
  assert.equal(map.features[0].id, 'FEAT-0001'); assert.equal(map.acceptanceCriteria[0].revision, 1);
  const change = { recordedBy: 'agent:test', sourceRef: 'task:test/next', updates: [{ entity: 'features', id: 'FEAT-0001', patch: { title: '笔记标题' } }], change: { ...draft().change, requirementIds: ['REQ-0001'], featureIds: ['FEAT-0001'], acIds: ['AC-0001'] } };
  await applyFeatureDraft(p, 'change', change, { expectedRevision: map.revision, expectedHash: map.contentHash, requestId: 'rename' }); map = await readMap(p);
  assert.equal(map.acceptanceCriteria[0].revision, 1);
  change.updates = [{ entity: 'acceptanceCriteria', id: 'AC-0001', patch: { expected: '持久化且重启读回一致' } }];
  await applyFeatureDraft(p, 'change', change, { expectedRevision: map.revision, expectedHash: map.contentHash, requestId: 'enhance' }); map = await readMap(p);
  assert.equal(map.acceptanceCriteria[0].revision, 2); assert.equal(map.changes.length, 3);
});
test('unresolved decisions, orphan requirements, hidden lineage and ID tampering are rejected', async t => {
  const { applyFeatureDraft } = await import('../src/feature.mjs'); const p = await fixture(t); const d = draft();
  d.requirements[0].decisionRef = ''; await assert.rejects(applyFeatureDraft(p, 'init', d, initOpts), /decisionRef/);
  d.requirements[0].decisionRef = 'task:test'; d.requirements[0].featureIds = [];
  await assert.rejects(applyFeatureDraft(p, 'init', d, initOpts), /orphan/);
  await applyFeatureDraft(p, 'init', draft(), initOpts); const m = await readMap(p);
  const base = { recordedBy: 'agent:test', sourceRef: 'task:next', change: { ...draft().change, requirementIds: ['REQ-0001'], featureIds: ['FEAT-0001'], acIds: ['AC-0001'] } };
  await assert.rejects(applyFeatureDraft(p, 'change', { ...base, updates: [{ entity: 'features', id: 'FEAT-0001', patch: { id: 'FEAT-0002' } }] }, { expectedRevision: 1, expectedHash: m.contentHash, requestId: 'tamper' }), /immutable/);
  await assert.rejects(applyFeatureDraft(p, 'change', { ...base, updates: [{ entity: 'features', id: 'FEAT-0001', patch: { splitInto: ['FEAT-0001'] } }] }, { expectedRevision: 1, expectedHash: m.contentHash, requestId: 'split' }), /lineage/);
});
test('actual diff reports unknown files and only related evidence becomes stale', async t => {
  const { applyFeatureDraft, featureImpact, featureCheck } = await import('../src/feature.mjs'); const p = await fixture(t);
  const d = draft(); d.features[0].implementationRefs = [{ path: 'note.mjs' }];
  await applyFeatureDraft(p, 'init', d, initOpts); const map = await readMap(p);
  const impact = featureImpact(map, 'CHG-0001', { files: ['note.mjs', 'unknown.mjs'], sourceRef: 'diff:test' });
  assert.deepEqual(impact.affectedFeatureIds, ['FEAT-0001']); assert.deepEqual(impact.unexplainedFiles, ['unknown.mjs']);
  const checked = featureCheck(map, 'CHG-0001'); assert.equal(checked.status, 'ready_for_implementation');
});
test('accepted requirement without its own applicable AC cannot be registered', async t => {
  const { applyFeatureDraft } = await import('../src/feature.mjs'); const p = await fixture(t); const d = draft();
  d.requirements.push({ ...structuredClone(d.requirements[0]), key: 'extra', intent: '未覆盖的导出权限' });
  d.features[0].requirementIds.push('@extra'); d.change.requirementIds.push('@extra');
  await assert.rejects(applyFeatureDraft(p, 'init', d, initOpts), /requirement.*AC/);
});
