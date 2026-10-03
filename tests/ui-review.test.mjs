import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { deriveUIQualityConfig } from '../src/ui-quality.mjs';

const reviewModule = await import('../src/ui-review.mjs').catch(() => ({}));
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ui-review-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const write = async (name, value) => {
    const bytes = JSON.stringify(value), file = path.join(root, name);
    await fs.writeFile(file, bytes);
    return { path: file, sha256: hash(bytes) };
  };
  const finding = (status, ruleId = 'save') => ({ status, ruleId, code: status === 'passed' ? 'state_matches' : 'state_mismatch',
    type: 'state', method: 'measurement', categoryId: 'Q09', entrypointId: 'settings', targetId: '#save', state: 'ready', platform: 'web',
    sourceRef: 'app.css:2', actual: { visible: status === 'passed' }, expected: { visible: true } });
  const report = async (name, findings, notes = [], extra = {}) => write(name, {
    id: name, surface: 'settings', role: 'member', state: 'ready', notes,
    assessment: { status: 'passed', viewport: { width: 390, height: 800 }, findings, ...extra }
  });
  return { root, write, finding, report };
}

test('script alerts, review and adapter gaps all become work items despite producer passed', async t => {
  const f = await fixture(t);
  const original = await f.report('original.json', [f.finding('failed'), f.finding('review', 'hit')],
    Array.from({ length: 49 }, (_, i) => ({ status: 'capability_gap', categoryId: 'Q03', targetSelector: `#native-${i}`, reason: 'Native glyphs unmeasured', sourceRef: 'collector.mjs' })));
  const result = await reviewModule.reviewUIQuality({ reportFiles: [original.path] });
  assert.equal(result.counts.alerts, 1); assert.equal(result.counts.needsReview, 1); assert.equal(result.counts.capabilityGaps, 49);
  assert.equal(result.workItems.filter(x => x.kind === 'coverage_gap').length, 49);
  assert.equal(result.status, 'needs_review'); assert.equal(result.businessAcceptance, false);
  assert.equal(result.originals[0].sha256, original.sha256);
});
test('a coverage note copied into reducer gaps remains one bounded work item', async t => {
  const f = await fixture(t), note = { status: 'capability_gap', targetId: '#native', reason: 'Unmeasured', sourceRef: 'collector' };
  const original = await f.report('coverage.json', [f.finding('passed')], [note], { coverageNotes: [note], gaps: [{ ...note, code: 'adapter_capability_gap' }] });
  const result = await reviewModule.reviewUIQuality({ reportFiles: [original.path] });
  assert.equal(result.counts.capabilityGaps, 1);
});

test('normal pages still require bounded contextual and representative passed-page sampling', async t => {
  const f = await fixture(t);
  const a = await f.report('a.json', [f.finding('passed')]);
  const b = await f.report('b.json', [f.finding('passed')]);
  const result = await reviewModule.reviewUIQuality({ reportFiles: [a.path, b.path] });
  assert.ok(result.workItems.some(x => x.kind === 'passed_sample'));
  assert.ok(result.workItems.some(x => x.kind === 'blind_spot'));
  assert.ok(result.sampling.pages.every(x => x.entrypointId && x.roleRef && x.state && x.originalRef));
  assert.ok(result.sampling.checks.includes('wording_and_action_hierarchy'));
  assert.equal(result.status, 'needs_review');
});
test('same page IDs in different role or viewport originals retain every sample group', async t => {
  const f = await fixture(t);
  const a = await f.write('member.json', { id: 'settings', surface: 'settings', role: 'member', state: 'ready', assessment: { viewport: { width: 390, height: 800 }, findings: [f.finding('passed')] } });
  const b = await f.write('admin.json', { id: 'settings', surface: 'settings', role: 'admin', state: 'ready', assessment: { viewport: { width: 1440, height: 900 }, findings: [f.finding('passed')] } });
  const result = await reviewModule.reviewUIQuality({ reportFiles: [a.path, b.path] });
  assert.deepEqual(result.sampling.pages.map(x => x.roleRef).sort(), ['admin','member']);
  assert.equal(result.counts.blindSpots, 2); assert.equal(result.counts.passedSamples, 2);
  assert.deepEqual(result.sampling.excludedPageIds, []);
});

test('a file containing only a producer pass cannot create a clean review', async t => {
  const f = await fixture(t), original = await f.write('self.json', { status: 'passed', pass: true });
  const result = await reviewModule.reviewUIQuality({ reportFiles: [original.path] });
  assert.ok(result.workItems.some(x => x.code === 'missing_assessment_material'));
  assert.notEqual(result.status, 'review_complete');
});
test('faithful_saved_copy_is_not_saved_business_evidence', async t => {
  const f = await fixture(t);
  const original = await f.write('saved-copy.json', { status: 'passed', review_routing: [{ judgment_id: 'COPY-1', action: 'reuse_supported' }], note: '已保存' });
  const result = await reviewModule.reviewUIQuality({ reportFiles: [original.path], review_routing: [{ judgment_id: 'COPY-1', action: 'reuse_supported' }] });
  assert.equal(result.status, 'needs_review');
  assert.equal(result.businessAcceptance, false);
  assert.ok(result.workItems.some(item => item.code === 'missing_assessment_material'));
});
test('a declared passed finding without observed values is a coverage gap', async t => {
  const f = await fixture(t), original = await f.report('self-finding.json', [{ ...f.finding('passed'), actual: undefined, expected: undefined }]);
  const result = await reviewModule.reviewUIQuality({ reportFiles: [original.path] });
  assert.ok(result.workItems.some(x => x.code === 'missing_observation_material'));
});

test('actual review records and evidence are read; missing or changed evidence stays unresolved', async t => {
  const f = await fixture(t), original = await f.report('good.json', [f.finding('passed')]);
  const plan = await reviewModule.reviewUIQuality({ reportFiles: [original.path] });
  const evidence = await f.write('operation.json', { role: 'member', state: 'ready', actions: ['click', 'wait'], observation: 'save result visible' });
  const reviewFiles = [];
  for (const item of plan.workItems) {
    reviewFiles.push((await f.write(`${item.itemId}.json`, { itemId: item.itemId, reviewerRef: 'Codex review chat',
      decision: 'verified', reason: 'Inspected original screenshot and actual operation', scope: item.scope,
      reportRefs: [original], evidenceRefs: [evidence] })).path);
  }
  const accepted = await reviewModule.reviewUIQuality({ reportFiles: [original.path], reviewFiles });
  assert.equal(accepted.status, 'review_complete'); assert.equal(accepted.businessAcceptance, false);
  await fs.writeFile(evidence.path, 'changed');
  const changed = await reviewModule.reviewUIQuality({ reportFiles: [original.path], reviewFiles });
  assert.equal(changed.status, 'needs_review'); assert.ok(changed.workItems.every(x => x.review?.status === 'invalid'));
});

test('review cannot erase confirmed issues or unresolved capability gaps', async t => {
  const f = await fixture(t), original = await f.report('bad.json', [f.finding('failed')]);
  const plan = await reviewModule.reviewUIQuality({ reportFiles: [original.path] });
  const evidence = await f.write('proof.json', { actual: 'button hidden' });
  const reviewFiles = [];
  for (const item of plan.workItems) reviewFiles.push((await f.write(`${item.itemId}.json`, {
    itemId: item.itemId, reviewerRef: 'Codex', decision: item.kind === 'alert' ? 'confirmed_issue' : 'verified',
    reason: 'Checked the affected entrypoint', scope: item.scope, reportRefs: [original], evidenceRefs: [evidence]
  })).path);
  const result = await reviewModule.reviewUIQuality({ reportFiles: [original.path], reviewFiles });
  assert.equal(result.status, 'requires_repair'); assert.equal(result.counts.alerts, 1);
});

test('fixed alerts require same-entrypoint retest evidence instead of a verbal fix', async t => {
  const f = await fixture(t), original = await f.report('bad.json', [f.finding('failed')]);
  const plan = await reviewModule.reviewUIQuality({ reportFiles: [original.path] }), item = plan.workItems.find(x => x.kind === 'alert');
  const evidence = await f.write('proof.json', { actual: 'I fixed it', pass: true });
  const decision = await f.write('review.json', { itemId: item.itemId, reviewerRef: 'Codex', decision: 'fixed', reason: 'Fixed',
    scope: item.scope, reportRefs: [original], evidenceRefs: [evidence] });
  const result = await reviewModule.reviewUIQuality({ reportFiles: [original.path], reviewFiles: [decision.path] });
  assert.equal(result.workItems.find(x => x.itemId === item.itemId).review.status, 'invalid');
});
test('a measured legal repair closes only its current same-entrypoint alert', async t => {
  const f = await fixture(t), original = await f.report('bad.json', [f.finding('failed')]);
  const plan = await reviewModule.reviewUIQuality({ reportFiles: [original.path] }), item = plan.workItems.find(x => x.kind === 'alert');
  const retest = await f.write('retest.json', { id: 'settings', role: 'member', state: 'ready', actions: ['click', 'wait'],
    layout: { measurementVersion: '1.0.0', platform: 'web', viewport: { width: 390, height: 800 }, document: { scrollWidth: 390 }, elements: [{ selector: '#save', found: true, rect: { x: 10, y: 10, width: 80, height: 30 }, visible: true, enabled: true, state: { visible: true, enabled: true } }], capabilities: {} },
    viewport: { width: 390, height: 800 }, rules: [{ id: 'save', type: 'state', categoryId: 'Q09', entrypointId: 'settings', targetId: '#save', selector: '#save', state: 'ready', platform: 'web', sourceRef: 'app.css:2', expect: { visible: true } }] });
  const decision = await f.write('review.json', { itemId: item.itemId, reviewerRef: 'Codex', decision: 'fixed', reason: 'Clicked same button and waited for result', scope: item.scope,
    reportRefs: [original], evidenceRefs: [retest], retestRef: retest });
  const result = await reviewModule.reviewUIQuality({ reportFiles: [original.path], reviewFiles: [decision.path] });
  assert.equal(result.workItems.find(x => x.itemId === item.itemId).review.status, 'completed', result.workItems.find(x => x.itemId === item.itemId).review.reason);
  const weakened = JSON.parse(await fs.readFile(retest.path)); weakened.rules[0].expect = { enabled: true };
  const weakProof = await f.write('weakened.json', weakened);
  const weakDecision = await f.write('weak-review.json', { itemId: item.itemId, reviewerRef: 'Codex', decision: 'fixed', reason: 'Changed rule', scope: item.scope,
    reportRefs: [original], evidenceRefs: [weakProof], retestRef: weakProof });
  const weak = await reviewModule.reviewUIQuality({ reportFiles: [original.path], reviewFiles: [weakDecision.path] });
  assert.equal(weak.workItems.find(x => x.itemId === item.itemId).review.status, 'invalid');
  const sourceChanged = JSON.parse(await fs.readFile(retest.path)); sourceChanged.rules[0].sourceRef = 'unrelated-contract.md';
  const sourceProof = await f.write('other-source.json', sourceChanged);
  const sourceDecision = await f.write('source-review.json', { itemId: item.itemId, reviewerRef: 'Codex', decision: 'fixed', reason: 'Changed source contract', scope: item.scope,
    reportRefs: [original], evidenceRefs: [sourceProof], retestRef: sourceProof });
  const changedSource = await reviewModule.reviewUIQuality({ reportFiles: [original.path], reviewFiles: [sourceDecision.path] });
  assert.equal(changedSource.workItems.find(x => x.itemId === item.itemId).review.status, 'invalid');
  const moved = JSON.parse(await fs.readFile(retest.path)); moved.rules[0].entrypointId = 'other-page';
  const different = await f.write('different.json', moved);
  const wrongDecision = await f.write('wrong-review.json', { itemId: item.itemId, reviewerRef: 'Codex', decision: 'fixed', reason: 'Different page', scope: item.scope,
    reportRefs: [original], evidenceRefs: [different], retestRef: different });
  const wrong = await reviewModule.reviewUIQuality({ reportFiles: [original.path], reviewFiles: [wrongDecision.path] });
  assert.equal(wrong.workItems.find(x => x.itemId === item.itemId).review.status, 'invalid');
});
test('a coverage-contract failure retains its expectation and accepts a valid contract retest', async t => {
  const f = await fixture(t);
  const config = deriveUIQualityConfig({ sourceRef: 'map.md', hasUI: true, platforms: ['web'],
    categories: Array.from({ length: 18 }, (_, i) => ({ categoryId: `Q${String(i + 1).padStart(2, '0')}`, applicability: i === 11 ? 'applicable' : 'not_applicable', reason: 'Bounded save task', sourceRef: 'map.md' })),
    adapters: [{ id: 'driver', platform: 'web', capabilities: ['business'], sourceRef: 'driver.mjs' }],
    requirements: [{ ruleId: 'save-readback', categoryId: 'Q12', featureId: 'F1', acId: 'A1', entrypointId: 'settings', targetId: 'save', state: 'saved', platform: 'web', method: 'business', expected: 'persisted', sourceRef: 'map.md#save', roleRef: 'member', environmentRef: 'test', dataScopeRef: 'isolated' }] });
  const observe = actual => ({ ...config.requirements[0], ruleVersion: config.ruleVersion, actual, evidenceRef: 'raw-operation.json', actions: ['input','click','wait','readback'] });
  const original = await f.write('original-contract.json', { config, observations: [observe('wrong')] });
  const plan = await reviewModule.reviewUIQuality({ reportFiles: [original.path] }), item = plan.workItems.find(x => x.kind === 'alert');
  assert.equal(item.expected, 'persisted');
  const retest = await f.write('retest-contract.json', { config, observations: [observe('persisted')] });
  const decision = await f.write('contract-decision.json', { itemId: item.itemId, reviewerRef: 'Codex', decision: 'fixed', reason: 'Operated same save target and read back persisted result', scope: item.scope,
    reportRefs: [original], evidenceRefs: [retest], retestRef: retest });
  const result = await reviewModule.reviewUIQuality({ reportFiles: [original.path], reviewFiles: [decision.path] });
  assert.equal(result.workItems.find(x => x.itemId === item.itemId).review.status, 'completed');
  const missingAdapter = structuredClone(config); missingAdapter.adapters = [];
  const incomplete = await f.write('incomplete-contract.json', { config: missingAdapter, observations: [observe('persisted')] });
  const incompleteDecision = await f.write('incomplete-decision.json', { itemId: item.itemId, reviewerRef: 'Codex', decision: 'fixed', reason: 'Result equals expectation but required adapter missing', scope: item.scope,
    reportRefs: [original], evidenceRefs: [incomplete], retestRef: incomplete });
  const gapResult = await reviewModule.reviewUIQuality({ reportFiles: [original.path], reviewFiles: [incompleteDecision.path] });
  assert.equal(gapResult.workItems.find(x => x.itemId === item.itemId).review.status, 'invalid');
  const otherConfig = structuredClone(config); otherConfig.requirements.push({ ...config.requirements[0], ruleId: 'other-save', targetId: 'other-button' });
  const other = await f.write('other-failure-contract.json', { config: otherConfig, observations: [observe('persisted'), { ...observe('wrong'), ruleId: 'other-save', targetId: 'other-button' }] });
  const otherDecision = await f.write('other-decision.json', { itemId: item.itemId, reviewerRef: 'Codex', decision: 'fixed', reason: 'The same save is repaired; independent target still fails', scope: item.scope,
    reportRefs: [original], evidenceRefs: [other], retestRef: other });
  const separate = await reviewModule.reviewUIQuality({ reportFiles: [original.path], reviewFiles: [otherDecision.path] });
  assert.equal(separate.workItems.find(x => x.itemId === item.itemId).review.status, 'completed');
});

test('a nonexistent evidence path or missing reviewer never completes a decision', async t => {
  const f = await fixture(t), original = await f.report('good.json', [f.finding('passed')]);
  const plan = await reviewModule.reviewUIQuality({ reportFiles: [original.path] }), item = plan.workItems[0];
  for (const patch of [{ reviewerRef: '' }, { evidenceRefs: [{ path: 'missing.png', sha256: '0'.repeat(64) }] }, { scope: {} }, { reportRefs: [] }]) {
    const evidence = await f.write('proof.json', { actions: ['click', 'wait'], actual: 'checked' });
    const decision = await f.write('decision.json', { itemId: item.itemId, reviewerRef: 'Codex', decision: 'verified', reason: 'Inspected original', scope: item.scope,
      reportRefs: [original], evidenceRefs: [evidence], ...patch });
    const result = await reviewModule.reviewUIQuality({ reportFiles: [original.path], reviewFiles: [decision.path] });
    assert.equal(result.workItems.find(x => x.itemId === item.itemId).review.status, 'invalid');
  }
});

test('batch capture manifests follow every original rather than manifest self-reported status', async t => {
  const f = await fixture(t), a = await f.report('a.json', [f.finding('failed')]), b = await f.report('b.json', [f.finding('passed')]);
  const manifest = await f.write('batch.json', { status: 'passed', captures: [{ id: 'a', status: 'passed', evidence: a.path }, { id: 'b', status: 'passed', evidence: b.path }] });
  const result = await reviewModule.reviewUIQuality({ reportFiles: [manifest.path] });
  assert.equal(result.counts.alerts, 1); assert.ok(result.originals.some(x => x.path === a.path));
  assert.ok(result.originals.some(x => x.path === b.path));
});

test('CLI saves full review plan but defaults to a short output with truthful counts', async t => {
  const f = await fixture(t), original = await f.report('original.json', [f.finding('failed')],
    Array.from({ length: 49 }, (_, i) => ({ status: 'capability_gap', targetSelector: `#field-${i}`, sourceRef: 'collector', reason: 'Unmeasured' })));
  const output = path.join(f.root, 'plan.json');
  const result = spawnSync(process.execPath, [path.resolve('src/cli.mjs'), 'ui', 'review', '--file', original.path, '--output', 'plan.json'], { cwd: f.root, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 2);
  assert.ok(result.stdout, result.stderr);
  const brief = JSON.parse(result.stdout), full = JSON.parse(await fs.readFile(output));
  assert.equal(brief.counts.capabilityGaps, 49); assert.equal(brief.detailRef, output);
  assert.ok(result.stdout.length < 2048); assert.equal(full.workItems.filter(x => x.kind === 'coverage_gap').length, 49);
});
