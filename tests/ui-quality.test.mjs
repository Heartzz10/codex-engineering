import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const module = await import('../src/ui-quality.mjs').catch(() => ({}));
const { deriveUIQualityConfig, validateUIQualityConfig, prepareUIQuality, assessUIQualityCoverage, loadUIQualityConfig } = module;
const facts = () => ({ sourceRef: 'docs/map.md', hasUI: true, platforms: ['web'],
  categories: Array.from({ length: 18 }, (_, i) => ({ categoryId: `Q${String(i + 1).padStart(2, '0')}`,
    applicability: i === 11 ? 'applicable' : 'not_applicable', reason: i === 11 ? 'Save task' : 'Excluded by task map', sourceRef: 'docs/map.md' })),
  adapters: [{ id: 'cdp', platform: 'web', capabilities: ['business', 'interaction', 'measurement'], sourceRef: 'qa/cdp.mjs' }],
  requirements: [{ ruleId: 'save-readback', categoryId: 'Q12', featureId: 'F1', acId: 'A1', entrypointId: 'notes', targetId: 'admin',
    state: 'saved', platform: 'web', method: 'business', sourceRef: 'docs/map.md#save', expected: 'note saved' }] });
const observation = (config) => ({ ...config.requirements[0], ruleVersion: config.ruleVersion, actual: 'note saved', evidenceRef: 'evidence/save.json',
  actions: [{ type: 'input' }, { type: 'click' }, { type: 'wait' }, { type: 'readback' }] });

test('contract functions exist before new coverage can be used', () => {
  for (const name of ['deriveUIQualityConfig', 'validateUIQualityConfig', 'prepareUIQuality', 'assessUIQualityCoverage', 'loadUIQualityConfig'])
    assert.equal(typeof module[name], 'function', `${name} must be implemented`);
});
test('all 18 categories carry applicability, provenance and method limits', () => {
  const config = deriveUIQualityConfig(facts());
  assert.equal(config.categories.length, 18);
  const result = prepareUIQuality(config);
  assert.equal(result.categories.length, 18);
  for (const item of result.categories) { assert.ok(item.sourceRef); assert.ok(item.sources.length); assert.ok(item.methods.length); assert.ok(item.limits); }
});
test('different project facts derive different rules without installing an ecosystem', () => {
  const web = deriveUIQualityConfig(facts());
  const nativeFacts = facts(); nativeFacts.platforms = ['android']; nativeFacts.requirements[0].platform = 'android'; nativeFacts.adapters = [];
  const native = deriveUIQualityConfig(nativeFacts);
  assert.notDeepEqual(native.platforms, web.platforms);
  assert.equal(prepareUIQuality(native).status, 'gaps');
  assert.ok(prepareUIQuality(native).capabilityGaps.some(gap => gap.code === 'missing_adapter'));
});
test('absence of features is not guessed from absence of tools', () => {
  const config = deriveUIQualityConfig({ sourceRef: 'docs/map.md', hasUI: true, platforms: ['web'] });
  assert.ok(config.categories.every(item => item.applicability === 'unknown'));
  assert.equal(prepareUIQuality(config).status, 'gaps');
});
test('explicit no UI is not applicable while missing UI facts stay unknown', () => {
  const none = deriveUIQualityConfig({ sourceRef: 'docs/cli.md', hasUI: false });
  assert.equal(prepareUIQuality(none).status, 'not_applicable');
  assert.equal(assessUIQualityCoverage(none, []).status, 'not_applicable');
  assert.equal(prepareUIQuality(deriveUIQualityConfig({ sourceRef: 'docs/unknown.md' })).status, 'gaps');
});
test('unknown platform, missing provenance and unknown fields are validation errors', () => {
  const config = deriveUIQualityConfig(facts());
  config.platforms = ['imaginary']; config.requirements[0].sourceRef = ''; config.silentSkip = true;
  const result = validateUIQualityConfig(config);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(error => error.includes('platform')));
  assert.ok(result.errors.some(error => error.includes('sourceRef')));
  assert.ok(result.errors.some(error => error.includes('silentSkip')));
});
test('malformed nested arrays return actionable validation errors rather than throwing', () => {
  for (const field of ['platforms', 'categories', 'adapters', 'sourceChecks', 'requirements', 'exceptions']) {
    const config = deriveUIQualityConfig(facts()); config[field] = 'invalid';
    assert.equal(validateUIQualityConfig(config).valid, false, field);
  }
  const config = deriveUIQualityConfig(facts()); config.adapters[0].capabilities = {};
  assert.equal(validateUIQualityConfig(config).valid, false);
});
test('category methods enforce boundaries and source-only checks leave runtime unverified', () => {
  const config = deriveUIQualityConfig(facts()); config.requirements[0].method = 'source';
  assert.equal(validateUIQualityConfig(config).valid, false);
  const source = deriveUIQualityConfig(facts()); source.categories[11].applicability = 'not_applicable'; source.categories[4].applicability = 'applicable';
  source.requirements[0].categoryId = 'Q05'; source.requirements[0].method = 'source';
  source.sourceChecks = [{ checkId: 'lint', categoryIds: ['Q05'], sourceRef: 'package.json' }];
  assert.ok(assessUIQualityCoverage(source, [{ ...observation(source), method: 'source' }]).gaps.some(gap => gap.code === 'source_only_category'));
});
test('a contextual review requires a named reviewer and decision tied to evidence', () => {
  const config = deriveUIQualityConfig(facts()); config.requirements[0].method = 'review'; config.adapters[0].capabilities.push('review');
  const actual = { ...observation(config), method: 'review', review: { reviewerRef: 'Codex', decisionRef: 'evidence/review.md', decision: 'accepted' } };
  assert.equal(assessUIQualityCoverage(config, [actual]).status, 'passed');
});
test('an applicable category with no requirement is a coverage gap', () => {
  const config = deriveUIQualityConfig(facts()); config.requirements = [];
  assert.ok(assessUIQualityCoverage(config, []).gaps.some(gap => gap.code === 'category_without_requirement'));
});
test('adapter capability notes cannot hide behind a passed measurement contract', () => {
  const config = deriveUIQualityConfig(facts());
  const result = assessUIQualityCoverage(config, [observation(config)], { coverageNotes: [
    { status: 'capability_gap', categoryId: 'Q03', entrypointId: 'notes', targetId: 'admin', sourceRef: 'collector', reason: 'Native text unmeasured' },
    { status: 'review', categoryId: 'Q02', sourceRef: 'design', reason: 'Action hierarchy needs context' }
  ] });
  assert.equal(result.status, 'incomplete');
  assert.ok(result.gaps.some(x => x.code === 'adapter_capability_gap'));
  assert.ok(result.findings.some(x => x.status === 'needs_review'));
});
test('negative observation statuses remain unresolved even when actual equals expected', () => {
  const config = deriveUIQualityConfig(facts());
  for (const [status, expectedStatus] of [['gap','incomplete'], ['capability_gap','incomplete'], ['failed','failed'], ['review','incomplete'], ['blocked','incomplete'], ['not_executed','incomplete']]) {
    const result = assessUIQualityCoverage(config, [{ ...observation(config), status }]);
    assert.equal(result.status, expectedStatus, `observation ${status}`);
    assert.notEqual(result.results[0].status, 'passed', `coverage unit ${status}`);
  }
});
test('only observed actual value and completed actions satisfy business requirement', () => {
  const config = deriveUIQualityConfig(facts()), actual = observation(config);
  assert.equal(assessUIQualityCoverage(config, [actual]).status, 'passed');
  actual.actual = 'different note'; actual.pass = true;
  assert.equal(assessUIQualityCoverage(config, [actual]).status, 'failed');
});
test('self pass, static receipt and missing readback never replace business verification', () => {
  const config = deriveUIQualityConfig(facts());
  for (const patch of [{ actual: undefined, pass: true }, { method: 'source' }, { actions: [{ type: 'click' }, { type: 'wait' }] }, { evidenceRef: '' }]) {
    const result = assessUIQualityCoverage(config, [{ ...observation(config), ...patch }]);
    assert.notEqual(result.status, 'passed');
  }
});
test('states and targets are independent coverage units', () => {
  const config = deriveUIQualityConfig(facts());
  config.requirements.push({ ...config.requirements[0], state: 'failure' });
  const result = assessUIQualityCoverage(config, [observation(config)]);
  assert.equal(result.status, 'incomplete'); assert.equal(result.summary.notExecuted, 1);
});
test('local acceptance filters AC and target without hiding required categories in full maintenance', () => {
  const config = deriveUIQualityConfig(facts());
  config.requirements.push({ ...config.requirements[0], acId: 'A2', targetId: 'reader', state: 'failure' });
  const local = assessUIQualityCoverage(config, [observation(config)], { acIds: ['A1'], targetIds: ['admin'] });
  assert.equal(local.status, 'passed'); assert.equal(local.counts.required, 1); assert.equal(local.requirements.length, 1);
  assert.equal(assessUIQualityCoverage(config, [observation(config)]).status, 'incomplete');
});
test('a local task with no declared UI units makes no new UI pass claim', () => {
  const result = assessUIQualityCoverage(deriveUIQualityConfig(facts()), [], { acIds: ['CLI-only'] });
  assert.equal(result.status, 'not_applicable'); assert.equal(result.counts.required, 0); assert.ok(result.scope.reason);
});
test('drifted source, rules, environment or requirements invalidate reused observations', () => {
  const config = deriveUIQualityConfig(facts());
  for (const key of ['sourceVersion', 'ruleVersion', 'environmentRef', 'requirementVersion']) {
    const result = assessUIQualityCoverage(config, [{ ...observation(config), [key]: 'old' }], { [key]: 'new' });
    assert.notEqual(result.status, 'passed'); assert.ok(result.gaps.some(gap => gap.code === 'stale_evidence'));
  }
});
test('newly discovered entrypoints expose map coverage gaps', () => {
  const config = deriveUIQualityConfig(facts());
  const result = assessUIQualityCoverage(config, [observation(config)], { discoveredEntrypoints: ['notes', 'unregistered-dialog'] });
  assert.notEqual(result.status, 'passed'); assert.ok(result.gaps.some(gap => gap.code === 'unregistered_entrypoint'));
});
test('current rule version is required even without caller context', () => {
  const config = deriveUIQualityConfig(facts());
  for (const ruleVersion of ['obsolete', undefined]) {
    const result = assessUIQualityCoverage(config, [{ ...observation(config), ruleVersion }]);
    assert.equal(result.status, 'incomplete');
    assert.ok(result.gaps.some(gap => gap.code === 'stale_evidence'));
  }
});
test('caller context cannot replace a requirement environment or version', () => {
  for (const field of ['sourceVersion','environmentRef','requirementVersion','roleRef','dataScopeRef']) {
    const config = deriveUIQualityConfig(facts()); config.requirements[0][field] = 'required-current';
    const result = assessUIQualityCoverage(config, [{ ...observation(config), [field]: 'other' }], { [field]: 'other' });
    assert.equal(result.status, 'incomplete', field);
  }
});
test('unresolved review and conflicting observations cannot become clean', () => {
  const config = deriveUIQualityConfig(facts()); config.requirements[0].method = 'review'; config.adapters[0].capabilities.push('review');
  assert.equal(assessUIQualityCoverage(config, [{ ...observation(config), method: 'review' }]).summary.needsReview, 1);
  const normal = deriveUIQualityConfig(facts());
  assert.notEqual(assessUIQualityCoverage(normal, [observation(normal), { ...observation(normal), actual: 'wrong' }]).status, 'passed');
});
test('exceptions require bounded rule, control, state, source and expiry, and never erase a failing observation', () => {
  const config = deriveUIQualityConfig(facts()); config.exceptions = [{ ruleId: '*', reason: 'ignore' }];
  assert.equal(validateUIQualityConfig(config).valid, false);
  config.exceptions = [{ ruleId: 'save-readback', targetId: 'admin', state: 'saved', sourceRef: 'docs/decision.md', reason: 'Known historic defect', invalidationCondition: 'Next save change' }];
  assert.equal(validateUIQualityConfig(config).valid, true);
  assert.equal(assessUIQualityCoverage(config, [{ ...observation(config), actual: 'wrong' }]).status, 'failed');
});
test('comparison uses meaningful expected values and rejects unknown operators', () => {
  const config = deriveUIQualityConfig(facts()); config.requirements[0].expected = { operator: 'gte', value: 44 };
  assert.equal(assessUIQualityCoverage(config, [{ ...observation(config), actual: 50 }]).status, 'passed');
  assert.equal(assessUIQualityCoverage(config, [{ ...observation(config), actual: 20 }]).status, 'failed');
  config.requirements[0].expected.operator = 'always-pass'; assert.equal(validateUIQualityConfig(config).valid, false);
});
test('legacy profile is distinct from invalid or missing referenced config', async () => {
  assert.deepEqual(await loadUIQualityConfig({ root: process.cwd() }), { status: 'not_configured', config: null });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ui-config-'));
  try {
    await fs.writeFile(path.join(root, 'ui.json'), JSON.stringify(deriveUIQualityConfig(facts())));
    assert.equal((await loadUIQualityConfig({ root, uiQualityRef: 'ui.json' })).status, 'configured');
    await assert.rejects(loadUIQualityConfig({ root, uiQualityRef: 'missing.json' }));
    await assert.rejects(loadUIQualityConfig({ root, uiQualityRef: '../outside.json' }), /escapes/);
    const invalid = deriveUIQualityConfig(facts()); invalid.platforms = ['unknown'];
    await fs.writeFile(path.join(root, 'ui.json'), JSON.stringify(invalid));
    await assert.rejects(loadUIQualityConfig({ root, uiQualityRef: 'ui.json' }), /platform/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
