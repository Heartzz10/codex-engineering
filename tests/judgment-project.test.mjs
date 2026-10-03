import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { applyFeatureDraft } from '../src/feature.mjs';
import { readMap, mapHash } from '../src/feature-store.mjs';
import { buildProjectJudgments, verifyProjectJudgmentSources } from '../src/judgment-project.mjs';
import { reviewRoutingPolicy } from '../src/judgment-routing.mjs';
import { prepareJudgments } from '../src/judgment.mjs';

const exclusions = reviewRoutingPolicy.profiles.ordinary_ui_copy_fidelity_v2.excluded_effects;
const review = (targetRef = { path: 'copy.json', pointer: '/status' }) => ({ kind: 'requirement_fidelity', materialScope: 'synthetic', category: 'ordinary_status_copy', targetRef, reviewerRef: 'reviewer:owner', checkedExclusions: [...exclusions], presentEffects: [] });
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'judgment-project-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const profile = { id: 'sample', root, featureMapRef: { schemaVersion: 1, path: 'docs/map.json', historyDir: 'docs/history', evidenceDir: 'evidence' } };
  await fs.writeFile(path.join(root, 'decision.md'), '原决定：保存后显示已保存。\n');
  await fs.writeFile(path.join(root, 'copy.json'), '{"status":"已保存"}');
  const draft = {
    recordedBy: 'test', sourceRef: 'task:test',
    requirements: [{ key: 'req', intent: '保存状态文案', decision: 'accepted', decisionRef: 'decision.md:1', decisionEvidenceRefs: [{ path: 'decision.md', startLine: 1, endLine: 1, sourceLabel: '已批准决定' }], schedule: 'current', featureIds: ['@feature'], openQuestions: [] }],
    features: [{ key: 'feature', title: '状态', user: '成员', scenario: '保存后', goal: '展示状态', scope: ['保存状态'], exclusions: [], humanAutomation: {}, requirementIds: ['@req'], dependencyIds: [], entrypointIds: ['ui'], implementationRefs: [], acceptanceCriteria: ['@ac'], lifecycle: 'active', deliveryStatus: 'planned' }],
    acceptanceCriteria: [{ key: 'ac', featureId: '@feature', requirementIds: ['@req'], preconditions: ['已登录'], actions: [{ type: 'click' }], expected: '展示保存状态', verificationMethod: 'ui', effects: { writes: 'none', network: false, paid: false }, assertions: [{ id: 'copy', operator: 'manual', semanticReview: review() }], requiredEvidenceTypes: ['execution'], dependencyRefs: [], implementationRefs: [], requiredTargets: [{ targetId: 'ui-member', entrypointId: 'ui', roleRef: 'member', scenario: 'normal', environmentRef: 'test', dataScopeRef: 'synthetic' }] }],
    change: { type: 'feature', reason: '用户要求', decision: 'accepted', decisionRef: 'decision.md:1', requirementIds: ['@req'], featureIds: ['@feature'], acIds: ['@ac'], implementationRefs: [], migrationImpact: 'none', recoveryImpact: 'none' }
  };
  await applyFeatureDraft(profile, 'init', draft, { expectedRevision: 0, expectedHash: null, requestId: 'init' });
  return { profile, map: await readMap(profile), root };
}
const refresh = map => { map.contentHash = mapHash(map); return map; };

test('confirmed original and JSON pointer form a bounded candidate with source bindings', async t => {
  const { profile, map, root } = await fixture(t);
  const result = await buildProjectJudgments(profile, map, { changeId: 'CHG-0001' });
  assert.equal(result.map_binding.content_hash, map.contentHash);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].target, '已保存');
  assert.equal(result.candidates[0].evidence[0].quote, '原决定：保存后显示已保存。');
  assert.equal(result.candidates[0].evidence[0].source_file, path.join(root, 'decision.md'));
  assert.equal(result.candidates[0].source_bindings.length, 2);
  assert.equal(result.candidates[0].review_scope.impact, 'low');
  assert.equal(result.codex_tasks.length, 0);
});

test('unconfirmed decision and missing original stay in Codex queue', async t => {
  const { profile, map, root } = await fixture(t);
  map.requirements[0].decision = 'needs_decision'; map.requirements[0].decisionRef = ''; refresh(map);
  let result = await buildProjectJudgments(profile, map, { acIds: ['AC-0001'] });
  assert.equal(result.candidates.length, 0);
  assert.ok(result.codex_tasks[0].reason_codes.includes('requirement_not_accepted'));
  map.requirements[0].decision = 'accepted'; map.requirements[0].decisionRef = 'decision.md:1'; refresh(map);
  await fs.unlink(path.join(root, 'decision.md'));
  result = await buildProjectJudgments(profile, map, { acIds: ['AC-0001'] });
  assert.equal(result.candidates.length, 0);
  assert.ok(result.codex_tasks[0].reason_codes.includes('decision_evidence_unreadable'));
});

test('invalid pointer, duplicate JSON keys and escaping paths never produce a candidate', async t => {
  const { profile, map, root } = await fixture(t);
  map.acceptanceCriteria[0].assertions[0].semanticReview.targetRef.pointer = '/missing'; refresh(map);
  let result = await buildProjectJudgments(profile, map, { acIds: ['AC-0001'] });
  assert.ok(result.codex_tasks[0].reason_codes.includes('target_unreadable'));
  map.acceptanceCriteria[0].assertions[0].semanticReview.targetRef.pointer = '/status'; refresh(map);
  await fs.writeFile(path.join(root, 'copy.json'), '{"status":"A","status":"B"}');
  result = await buildProjectJudgments(profile, map, { acIds: ['AC-0001'] });
  assert.ok(result.codex_tasks[0].reason_codes.includes('target_unreadable'));
  map.acceptanceCriteria[0].assertions[0].semanticReview.targetRef.path = '../outside.json'; refresh(map);
  result = await buildProjectJudgments(profile, map, { acIds: ['AC-0001'] });
  assert.ok(result.codex_tasks[0].reason_codes.includes('target_unreadable'));
});

test('private and incomplete exclusion review stay local', async t => {
  const { profile, map } = await fixture(t);
  const item = map.acceptanceCriteria[0].assertions[0].semanticReview;
  item.materialScope = 'private'; item.checkedExclusions.pop(); refresh(map);
  const result = await buildProjectJudgments(profile, map, { acIds: ['AC-0001'] });
  assert.equal(result.candidates.length, 0);
  assert.ok(result.codex_tasks[0].reason_codes.includes('material_scope'));
  assert.ok(result.codex_tasks[0].reason_codes.includes('exclusions_unchecked'));
});

test('program assertions are referenced only; manual without semantic review is retained', async t => {
  const { profile, map } = await fixture(t);
  map.acceptanceCriteria[0].assertions.push({ id: 'actual', operator: 'equals', path: '/status', expected: null }, { id: 'visual', operator: 'manual', expected: '布局正确' }); refresh(map);
  const result = await buildProjectJudgments(profile, map, { acIds: ['AC-0001'] });
  assert.equal(result.program_tasks.length, 1);
  assert.equal(result.program_tasks[0].kind, 'program_assertion');
  assert.equal(result.program_tasks[0].context.expected, null);
  assert.ok(result.codex_tasks.some(row => row.assertion_id === 'visual' && row.reason_codes.includes('semantic_review_missing')));
});

test('selection rejects duplicate and unknown IDs and detects changed bindings', async t => {
  const { profile, map, root } = await fixture(t);
  await assert.rejects(buildProjectJudgments(profile, map, {}), /selection/);
  await assert.rejects(buildProjectJudgments(profile, map, { acIds: ['AC-0001', 'AC-0001'] }), /duplicate/);
  await assert.rejects(buildProjectJudgments(profile, map, { acIds: ['AC-9999'] }), /unknown/);
  await assert.rejects(buildProjectJudgments(profile, map, { changeId: 'CHG-9999' }), /unknown/);
  await assert.rejects(buildProjectJudgments(profile, map, { changeId: 'CHG-0001', acIds: ['AC-0001'] }), /selection/);
  await fs.writeFile(path.join(root, 'decision.md'), '更改后的决定\n');
  const result = await buildProjectJudgments(profile, map, { acIds: ['AC-0001'] });
  assert.equal(result.candidates[0].source_bindings[0].value, '更改后的决定');
  assert.notEqual(result.candidates[0].evidence[0].quote, '原决定：保存后显示已保存。');
});

test('source verification detects original and map changes without trusting prior output', async t => {
  const { profile, map, root } = await fixture(t);
  const plan = await buildProjectJudgments(profile, map, { acIds: ['AC-0001'] });
  assert.deepEqual(await verifyProjectJudgmentSources(profile, plan), { valid: true, reason_codes: [] });
  await fs.writeFile(path.join(root, 'copy.json'), '{"status":"状态已改变"}');
  assert.ok((await verifyProjectJudgmentSources(profile, plan)).reason_codes.includes('source_changed'));
  await fs.writeFile(path.join(root, 'copy.json'), '{"status":"已保存"}');
  const changed = { ...plan, map_binding: { ...plan.map_binding, content_hash: '0'.repeat(64) } };
  assert.ok((await verifyProjectJudgmentSources(profile, changed)).reason_codes.includes('map_binding_changed'));
});

test('line references preserve exact original and read each file once', async t => {
  const { profile, map, root } = await fixture(t);
  await fs.writeFile(path.join(root, 'copy.txt'), '第一行\r\n实际候选\r\n');
  map.acceptanceCriteria[0].requiredTargets[0].assertions = [{ id: 'one', operator: 'manual', semanticReview: review({ path: 'copy.txt', startLine: 2, endLine: 2 }) }, { id: 'two', operator: 'manual', semanticReview: review({ path: 'copy.txt', startLine: 2, endLine: 2 }) }]; refresh(map);
  const calls = [];
  const plan = await buildProjectJudgments(profile, map, { acIds: ['AC-0001'], readFile: async file => { calls.push(file); return fs.readFile(file, 'utf8'); } });
  assert.equal(plan.candidates.length, 2);
  assert.equal(plan.candidates[0].target, '实际候选');
  assert.equal(calls.filter(file => file === path.join(root, 'copy.txt')).length, 1);
  assert.equal(calls.filter(file => file === path.join(root, 'decision.md')).length, 1);
});

test('oversize source and symbolic link escape remain with Codex', async t => {
  const { profile, map, root } = await fixture(t);
  await fs.writeFile(path.join(root, 'copy.json'), JSON.stringify({ status: '甲'.repeat(360000) }));
  let result = await buildProjectJudgments(profile, map, { acIds: ['AC-0001'] });
  assert.ok(result.codex_tasks[0].reason_codes.includes('target_too_large'));
  const outside = path.join(os.tmpdir(), `judgment-outside-${Date.now()}.json`);
  t.after(() => fs.rm(outside, { force: true }));
  await fs.writeFile(outside, '{"status":"outside"}');
  await fs.unlink(path.join(root, 'copy.json'));
  try { await fs.symlink(outside, path.join(root, 'copy.json')); }
  catch (error) { if (error.code === 'EPERM') return; throw error; }
  result = await buildProjectJudgments(profile, map, { acIds: ['AC-0001'] });
  assert.ok(result.codex_tasks[0].reason_codes.includes('target_unreadable'));
});

test('a short cited line in a source larger than 24 KB remains preparable with full-file hash', async t => {
  const { profile, map, root } = await fixture(t);
  const original = `${'背景资料\n'.repeat(5000)}原决定：保存后显示已保存。\n`;
  await fs.writeFile(path.join(root, 'decision.md'), original);
  map.requirements[0].decisionEvidenceRefs[0].startLine = 5001;
  map.requirements[0].decisionEvidenceRefs[0].endLine = 5001;
  refresh(map);
  const plan = await buildProjectJudgments(profile, map, { acIds: ['AC-0001'] });
  const candidate = plan.candidates[0];
  assert.equal(candidate.evidence[0].quote, '原决定：保存后显示已保存。');
  assert.equal(candidate.source_bindings[0].sha256, (await import('node:crypto')).createHash('sha256').update(original).digest('hex'));
  const prepared = await prepareJudgments({ material_scope: 'synthetic', context: { purpose: '文案需求保真' }, evidence: candidate.evidence,
    judgments: [{ id: candidate.judgment_id, kind: candidate.kind, target: candidate.target, evidence_ids: candidate.evidence.map(item => item.id) }] });
  assert.equal(prepared.requests.length, 1);
});

test('unresolved questions, duplicate assertion IDs and task limit cannot silently pass', async t => {
  const { profile, map } = await fixture(t);
  map.requirements[0].openQuestions = ['谁批准文案']; refresh(map);
  let result = await buildProjectJudgments(profile, map, { acIds: ['AC-0001'] });
  assert.equal(result.candidates.length, 0);
  assert.ok(result.codex_tasks[0].reason_codes.includes('open_questions'));
  map.requirements[0].openQuestions = [];
  map.acceptanceCriteria[0].assertions.push(structuredClone(map.acceptanceCriteria[0].assertions[0])); refresh(map);
  await assert.rejects(buildProjectJudgments(profile, map, { acIds: ['AC-0001'] }), /duplicate_assertion_id/);
  map.acceptanceCriteria[0].assertions = Array.from({ length: 49 }, (_, i) => ({ id: `copy-${i}`, operator: 'manual', semanticReview: review() })); refresh(map);
  await assert.rejects(buildProjectJudgments(profile, map, { acIds: ['AC-0001'] }), /semantic_task_limit/);
});

test('stable readable judgment IDs pass the native preparation contract', async t => {
  const { profile, map } = await fixture(t);
  map.acceptanceCriteria[0].requiredTargets[0].targetId = 'member-with-a-very-long-target-id-'.repeat(5);
  map.acceptanceCriteria[0].assertions[0].id = 'copy-with-a-very-long-assertion-id-'.repeat(5); refresh(map);
  const first = await buildProjectJudgments(profile, map, { acIds: ['AC-0001'] });
  const second = await buildProjectJudgments(profile, map, { changeId: 'CHG-0001' });
  const candidate = first.candidates[0];
  assert.equal(candidate.judgment_id, second.candidates[0].judgment_id);
  assert.match(candidate.judgment_id, /^AC-0001-[a-f0-9]{40}$/);
  const prepared = await prepareJudgments({ material_scope: 'synthetic', context: { purpose: '文案需求保真' }, evidence: candidate.evidence,
    judgments: [{ id: candidate.judgment_id, kind: candidate.kind, target: candidate.target, evidence_ids: candidate.evidence.map(item => item.id) }] });
  assert.equal(prepared.requests[0].judgment_id, candidate.judgment_id);
});

test('networked business acceptance does not itself make an ordinary copy review high impact', async t => {
  const { profile, map } = await fixture(t);
  map.acceptanceCriteria[0].effects = { writes: 'business-data', network: true, paid: true }; refresh(map);
  const result = await buildProjectJudgments(profile, map, { acIds: ['AC-0001'] });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].acceptance_effects.writes, 'business-data');
  assert.equal(result.codex_tasks.length, 0);
});

test('unknown operators and empty assertion slots count toward semantic limit', async t => {
  const { profile, map } = await fixture(t);
  map.acceptanceCriteria[0].assertions = Array.from({ length: 49 }, (_, i) => ({ id: `unknown-${i}`, operator: 'unknown' })); refresh(map);
  await assert.rejects(buildProjectJudgments(profile, map, { acIds: ['AC-0001'] }), /semantic_task_limit/);
  map.acceptanceCriteria[0].assertions = [];
  map.acceptanceCriteria[0].requiredTargets = Array.from({ length: 49 }, (_, i) => ({ ...map.acceptanceCriteria[0].requiredTargets[0], targetId: `target-${i}` })); refresh(map);
  await assert.rejects(buildProjectJudgments(profile, map, { acIds: ['AC-0001'] }), /semantic_task_limit/);
});
