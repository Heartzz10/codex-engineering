import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { applyFeatureDraft } from '../src/feature.mjs';
import { readMap, mapHash } from '../src/feature-store.mjs';
import { hash, requestKey, MODEL, RESERVED_REQUEST_USD } from '../skills/review-product-plan/scripts/jev-client.mjs';
import { createHash } from 'node:crypto';
import { runProjectJudgmentCommand } from '../scripts/engineering-judge-project.mjs';
import { reviewRoutingPolicy } from '../src/judgment-routing.mjs';
import { execFileSync } from 'node:child_process';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-context-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const stateRoot = path.join(root, 'state');
  const profile = { id: 'sample', root, authoritativeDocuments: ['GUIDE.md'], environmentRef: 'test', checks: [], featureMapRef: { schemaVersion: 1, path: 'docs/map.json', historyDir: 'docs/history', evidenceDir: 'evidence' } };
  await fs.writeFile(path.join(root, 'GUIDE.md'), '当前约定：保存之后刷新必须读回。\n另一个未选中的原文段落。\n');
  await fs.writeFile(path.join(root, 'app.mjs'), 'export const save = () => true;\n');
  await applyFeatureDraft(profile, 'init', {
    recordedBy: 'test', sourceRef: 'task:fixture',
    requirements: [{ key: 'req', intent: '保存并刷新读回', decision: 'accepted', decisionRef: 'GUIDE.md:1', decisionEvidenceRefs: [{ path: 'GUIDE.md', startLine: 1, endLine: 1 }], schedule: 'current', featureIds: ['@feature'], openQuestions: [] }],
    features: [{ key: 'feature', title: '笔记', user: '用户', scenario: '保存后', goal: '持久化', scope: ['笔记'], exclusions: ['同步'], humanAutomation: {}, requirementIds: ['@req'], dependencyIds: [], entrypointIds: ['ui'], implementationRefs: ['app.mjs'], acceptanceCriteria: ['@ac'], lifecycle: 'active', deliveryStatus: 'implemented' }],
    acceptanceCriteria: [{ key: 'ac', featureId: '@feature', requirementIds: ['@req'], preconditions: ['已登录'], actions: [{ type: 'click' }, { type: 'refresh' }, { type: 'readback' }], expected: '正文一致', verificationMethod: 'ui', effects: { writes: 'none', network: false, paid: false }, requiredEvidenceTypes: ['execution'], dependencyRefs: [], requiredTargets: [{ targetId: 'saved', entrypointId: 'ui', roleRef: 'user', scenario: 'normal', environmentRef: 'test', dataScopeRef: 'synthetic' }] }],
    change: { type: 'repair', reason: '刷新丢笔记', decision: 'accepted', decisionRef: 'GUIDE.md:1', requirementIds: ['@req'], featureIds: ['@feature'], acIds: ['@ac'], implementationRefs: ['app.mjs'], migrationImpact: 'none', recoveryImpact: 'none' }
  }, { expectedRevision: 0, expectedHash: null, requestId: 'init' });
  return { root, stateRoot, profile };
}

async function cachedResumeFixture(t) {
  const value = await fixture(t), { root, profile, stateRoot } = value;
  await fs.writeFile(path.join(root, 'copy.json'), '{"status":"已保存"}');
  const map = await readMap(profile);
  map.acceptanceCriteria[0].assertions = [{ id: 'copy', operator: 'manual', semanticReview: { kind: 'requirement_fidelity', materialScope: 'synthetic', category: 'ordinary_status_copy', targetRef: { path: 'copy.json', pointer: '/status' }, reviewerRef: 'test:reviewer', checkedExclusions: [...reviewRoutingPolicy.profiles.ordinary_ui_copy_fidelity_v2.excluded_effects], presentEffects: [] } }];
  map.contentHash = mapHash(map); await fs.writeFile(path.join(root, 'docs/map.json'), JSON.stringify(map));
  await fs.mkdir(path.join(root, 'evidence'), { recursive: true });
  const { runTaskContextCommand } = await import('../scripts/task-context.mjs');
  const taskFile = path.join(root, 'task.json'), previousFile = path.join(root, 'evidence/previous.json');
  await fs.writeFile(taskFile, JSON.stringify({ id: 'old', kind: 'implementation', description: '核对保存状态' }));
  const dependencies = { loadProfile: async () => profile }, profileFile = path.join(root, 'profile.json');
  await runTaskContextCommand(['prepare', '--profile', profileFile, '--task', taskFile, '--ids', 'AC-0001', '--out', previousFile, '--state-root', stateRoot], dependencies);
  const executionFile = path.join(root, 'evidence/execution.json'), ledgerFile = path.join(root, 'evidence/ledger.json');
  const execution = await runProjectJudgmentCommand('plan', { profile: profileFile, ids: 'AC-0001', out: executionFile, purpose: 'validation', 'state-root': stateRoot }, dependencies);
  assert.equal(execution.prepared.length, 1);
  const writeCachedExecution = async () => {
    const item = execution.prepared[0], request = item.bundle.requests[0];
    const key = requestKey(request, item.bundle.standard_sha256, execution.plan_sha256);
    const raw = { model: MODEL, answers: Object.fromEntries(Object.entries(request.body.questions).map(([id, question]) => [id, {
      type: 'choice', choice: 'yes', probabilities: Object.fromEntries(Object.keys(question.criteria).map(label => [label, label === 'yes' ? 1 : 0])), confidence: 1
    }])), usage: { input_tokens: 1, output_tokens: 0 } };
    const ledger = { schema_version: 1, entries: [{ id: 'synthetic-completed', request_key: key, status: 'completed', evidence_kind: 'provider_response', reserved_cost_usd: RESERVED_REQUEST_USD, estimated_cost_usd: 0 }],
      cache: { [key]: { model: MODEL, standard_sha256: item.bundle.standard_sha256, request_sha256: hash(request.body), source_entry: 'synthetic-completed', evidence_kind: 'provider_response', raw_response: raw } } };
    await fs.writeFile(executionFile, JSON.stringify(execution)); await fs.writeFile(ledgerFile, JSON.stringify(ledger)); return ledger;
  };
  await writeCachedExecution();
  const resume = async (name, extra = []) => runTaskContextCommand(['resume', '--profile', profileFile, '--from', previousFile, '--execution', executionFile, '--ledger', ledgerFile, '--out', path.join(root, `evidence/${name}.json`), '--state-root', stateRoot, ...extra], dependencies);
  return { ...value, execution, executionFile, ledgerFile, taskFile, writeCachedExecution, resume };
}

test('resume accepts only the same task and selection; changed task still rebuilds local context', async t => {
  const { root, execution, taskFile, resume } = await cachedResumeFixture(t);
  const unchanged = await resume('unchanged');
  assert.equal(unchanged.resume.requests.completed_reusable.length, 1);
  await fs.writeFile(taskFile, JSON.stringify({ id: 'new', kind: 'implementation', description: '改成另一份任务' }));
  const changed = await resume('changed', ['--task', taskFile]);
  assert.equal(changed.resume.requests.completed_reusable.length, 0);
  assert.equal(changed.resume.requests.completed_unusable.length, 1);
  assert.equal(JSON.parse(await fs.readFile(changed.output_path, 'utf8')).task.id, 'new');
  const changedSelection = await resume('selection', ['--change', 'CHG-0001']);
  assert.equal(changedSelection.resume.requests.completed_reusable.length, 0);
});

test('resume rejects plan membership, unknown standards, wrong candidate content and approval hash forgery', async t => {
  const value = await cachedResumeFixture(t), { execution, executionFile, writeCachedExecution, resume } = value;
  const original = structuredClone(execution);
  execution.plan.candidates = []; await writeCachedExecution();
  assert.equal((await resume('empty-plan')).resume.requests.completed_reusable.length, 0);
  Object.assign(execution, structuredClone(original)); execution.prepared[0].bundle.standard_sha256 = 'a'.repeat(64); await writeCachedExecution();
  assert.equal((await resume('unknown-standard')).resume.requests.completed_reusable.length, 0);
  Object.assign(execution, structuredClone(original)); execution.prepared[0].bundle.requests[0].body.state.context.expected = '另一个任务的结果';
  execution.prepared[0].bundle.request_sha256 = hash(execution.prepared[0].bundle.requests);
  const project = bundle => { const { created_at, pricing, note, ...rest } = bundle; return rest; };
  execution.plan_sha256 = hash({ purpose: execution.purpose, selection: { acIds: ['AC-0001'] }, plan: execution.plan, prepared: execution.prepared.map(item => ({ judgment_id: item.judgment_id, bundle: project(item.bundle), route: item.route ?? null, error: null })) });
  await writeCachedExecution();
  const content = await resume('wrong-content');
  assert.equal(content.resume.requests.completed_reusable.length, 0);
  assert.equal(content.resume.requests.completed_unusable.length, 1);
  Object.assign(execution, structuredClone(original)); execution.plan_sha256 = 'forged-scope'; const ledger = await writeCachedExecution();
  assert.equal((await resume('wrong-sha')).resume.requests.completed_reusable.length, 0);
  ledger.entries[0].status = 'uncertain'; await fs.writeFile(value.ledgerFile, JSON.stringify(ledger));
  const unknown = await resume('unknown-charge');
  assert.equal(unknown.resume.requests.charge_unknown.length, 1);
  assert.equal(unknown.resume.requests.not_started.length, 0);
});

test('repair preparation binds mandatory originals and keeps pending business acceptance', async t => {
  const { buildTaskContext } = await import('../src/task-context.mjs');
  const { profile, stateRoot } = await fixture(t);
  const context = await buildTaskContext(profile, { stateRoot, task: { id: 'repair', kind: 'debugging', description: '保存后刷新不见了' }, changeId: 'CHG-0001' });
  assert.equal(context.provider_calls, 0);
  assert.equal(context.business_verified, false);
  assert.ok(context.must_read.some(row => row.kind === 'requirement' && row.value.intent === '保存并刷新读回'));
  assert.ok(context.must_read.some(row => row.binding?.path === 'app.mjs'));
  assert.ok(context.todo.some(row => row.kind === 'acceptance' && row.ac_id === 'AC-0001'));
  assert.ok(context.gaps.some(row => row.code === 'acceptance_not_recorded'));
  assert.equal((await readMap(profile)).changes[0].status, 'open');
});

test('freshness invalidates untouched original text, added records and context tampering', async t => {
  const { buildTaskContext, verifyTaskContext } = await import('../src/task-context.mjs');
  const { root, stateRoot, profile } = await fixture(t);
  const options = { stateRoot, task: { id: 'add', kind: 'implementation', description: '增加帮助说明' }, acIds: ['AC-0001'] };
  let context = await buildTaskContext(profile, options);
  assert.equal((await verifyTaskContext(profile, context, { stateRoot })).valid, true);
  context.must_read[0].value = '伪造原文';
  assert.equal((await verifyTaskContext(profile, context, { stateRoot })).valid, false);
  context = await buildTaskContext(profile, options);
  await fs.appendFile(path.join(root, 'GUIDE.md'), '变化在引用之外。\n');
  assert.equal((await verifyTaskContext(profile, context, { stateRoot })).valid, false);
  context = await buildTaskContext(profile, options);
  await fs.mkdir(path.join(stateRoot, 'decisions'), { recursive: true });
  await fs.writeFile(path.join(stateRoot, 'decisions/new.json'), JSON.stringify({ id: 'new', kind: 'decision', scope: 'project:sample', status: 'active', text: '不能删除历史笔记', sourceRef: 'user:new', updatedAt: '2026-09-30T00:00:00Z' }));
  assert.equal((await verifyTaskContext(profile, context, { stateRoot })).valid, false);
});

test('existing documented feature map is mandatory and full-text changes invalidate local context', async t => {
  const { buildTaskContext, verifyTaskContext } = await import('../src/task-context.mjs');
  const { root, stateRoot, profile } = await fixture(t);
  delete profile.featureMapRef; profile.featureMapDocument = 'map.md'; profile.featureMapStatus = 'documented';
  await fs.writeFile(path.join(root, 'map.md'), '当前功能：只能本地保存，禁止上传。\n');
  const options = { stateRoot, task: { id: 'docs-map', kind: 'implementation', description: '修正现有功能' } };
  const context = await buildTaskContext(profile, options);
  assert.ok(context.must_read.some(row => row.binding?.path === 'map.md'));
  await fs.appendFile(path.join(root, 'map.md'), '新增决定：禁止删除旧笔记。\n');
  assert.equal((await verifyTaskContext(profile, context, { stateRoot })).valid, false);
  await fs.unlink(path.join(root, 'map.md'));
  const missing = await buildTaskContext(profile, options);
  assert.ok(missing.gaps.some(row => row.path === 'map.md'));
});

test('explicit small change has short local path and no optional playbook requirement', async t => {
  const { buildTaskContext } = await import('../src/task-context.mjs');
  const { profile, stateRoot } = await fixture(t);
  const context = await buildTaskContext(profile, { stateRoot, task: { id: 'small', kind: 'implementation', smallChange: true, description: '修正文案错字' } });
  assert.equal(context.path, 'short');
  assert.equal(context.provider_calls, 0);
  assert.equal(context.optional_read.length, 0);
  assert.equal(context.judgment_plan, null);
});

test('pure explanation kind or workType schedules no engineering execution while retaining unresolved history', async t => {
  const { buildTaskContext } = await import('../src/task-context.mjs');
  const { profile, stateRoot } = await fixture(t);
  profile.checks = [{ id: 'app', inputs: ['app.mjs'], authorizationRef: 'GUIDE.md' }, { id: 'other', inputs: ['other.mjs'], authorizationRef: 'GUIDE.md' }];
  for (const category of ['explanation', 'consultation', 'concept']) for (const task of [{ kind: category }, { kind: 'implementation', workType: category }]) {
    const context = await buildTaskContext(profile, { stateRoot, acIds: ['AC-0001'], task: { ...task, description: '只解释已有保存机制' } });
    assert.equal(context.todo.length, 0);
    assert.equal(context.provider_calls, 0);
    assert.ok(context.gaps.some(row => row.code === 'acceptance_not_recorded'));
    assert.ok(context.historical_changes.some(row => row.id === 'CHG-0001' && row.status === 'open'));
  }
});

test('documentation and writing can be real edits and retain required engineering checks', async t => {
  const { buildTaskContext } = await import('../src/task-context.mjs');
  const { profile, stateRoot } = await fixture(t);
  profile.checks = [{ id: 'doc-contract', inputs: ['GUIDE.md'], authorizationRef: 'GUIDE.md' }];
  for (const task of [{ kind: 'documentation' }, { kind: 'implementation', workType: 'writing' }]) {
    const context = await buildTaskContext(profile, { stateRoot, task: { ...task, description: '编辑约定中的帮助说明' } });
    assert.deepEqual(context.todo.filter(row => row.kind === 'program_check').map(row => row.check_id), ['doc-contract']);
  }
});

test('small implementation preserves cross-cutting checks when fingerprint inputs do not establish applicability', async t => {
  const { buildTaskContext } = await import('../src/task-context.mjs');
  const { profile, stateRoot, root } = await fixture(t);
  profile.checks = [
    { id: 'app', inputs: ['app.mjs'], authorizationRef: 'GUIDE.md' },
    { id: 'unrelated-ui', inputs: ['public/index.html'], authorizationRef: 'GUIDE.md' },
    { id: 'whole-project', inputs: ['.'], authorizationRef: 'GUIDE.md' },
    { id: 'missing-inputs', inputs: [], authorizationRef: 'GUIDE.md' },
    { id: 'rule-linked', inputs: ['rule-check.mjs'], authorizationRef: 'GUIDE.md' },
    { id: 'fingerprint-rule-input', inputs: ['other-check.mjs'], authorizationRef: 'GUIDE.md' },
    { id: 'integration-all-src', inputs: ['scripts/check-all.mjs', 'package.json'], args: ['scripts/check-all.mjs'], authorizationRef: 'GUIDE.md' }
  ];
  profile.engineeringRuleInputs = { 'fingerprint-rule-input': ['app.mjs'] };
  profile.engineeringRules = { bindings: [{ checkIds: ['rule-linked'], acIds: ['AC-0001'], implementationRefs: [], decisionRefs: [] }] };
  const task = { kind: 'implementation', smallChange: true, description: '只修保存逻辑' };
  const mapScoped = await buildTaskContext(profile, { stateRoot, acIds: ['AC-0001'], task });
  assert.equal(mapScoped.todo.filter(row => row.kind === 'program_check').length, profile.checks.length);
  assert.ok(mapScoped.todo.some(row => row.kind === 'acceptance' && row.ac_id === 'AC-0001'));
  assert.ok(mapScoped.gaps.some(row => row.code === 'acceptance_not_recorded'));
  const explicit = await buildTaskContext(profile, { stateRoot, task: { ...task, affectedFiles: ['app.mjs'] } });
  assert.equal(explicit.todo.filter(row => row.kind === 'program_check').length, profile.checks.length);
  assert.ok(explicit.todo.some(row => row.check_id === 'integration-all-src'));
  assert.match(explicit.check_scope_note, /未声明|保留/);
  const unknown = await buildTaskContext(profile, { stateRoot, task });
  assert.equal(unknown.todo.filter(row => row.kind === 'program_check').length, profile.checks.length);
});

test('bad references remain visible instead of legitimizing resume', async t => {
  const { buildTaskContext, verifyTaskContext } = await import('../src/task-context.mjs');
  const { profile, stateRoot, root } = await fixture(t);
  const map = await readMap(profile);
  map.features[0].implementationRefs.push('../outside.md');
  map.acceptanceCriteria[0].assertions = [{ id: 'copy', operator: 'manual', semanticReview: { targetRef: { path: 'missing-copy.json', pointer: '/status' } } }];
  map.contentHash = mapHash(map);
  await fs.writeFile(path.join(root, 'docs/map.json'), JSON.stringify(map));
  const context = await buildTaskContext(profile, { stateRoot, task: { kind: 'implementation', description: '修改状态文案' }, acIds: ['AC-0001'] });
  assert.ok(context.gaps.some(row => row.path === '../outside.md'));
  assert.ok(context.gaps.some(row => row.path === 'missing-copy.json'));
  assert.equal((await verifyTaskContext(profile, context, { stateRoot })).valid, false);
});

test('binary historical evidence keeps original hash and unresolved status without decoding pixels as text', async t => {
  const { buildTaskContext } = await import('../src/task-context.mjs');
  const { profile, stateRoot, root } = await fixture(t);
  await fs.mkdir(path.join(root, 'evidence'), { recursive: true });
  const pixels = Buffer.from([137, 80, 78, 71, 255, 0]);
  await fs.writeFile(path.join(root, 'evidence/picture.png'), pixels);
  const map = await readMap(profile);
  map.evidence.push({ id: 'EVD-0001', createdAt: '2026-09-30T00:00:00Z', recordedBy: 'test', sourceRef: 'evidence/picture.png', featureId: 'FEAT-0001', acId: 'AC-0001', changeId: 'CHG-0001', result: 'blocked', applicability: 'stale', rawEvidence: [{ path: 'evidence/picture.png', sha256: createHash('sha256').update(pixels).digest('hex'), type: 'screenshot' }] });
  map.contentHash = mapHash(map); await fs.writeFile(path.join(root, 'docs/map.json'), JSON.stringify(map));
  const context = await buildTaskContext(profile, { stateRoot, task: { kind: 'verification', description: '核对旧验收缺口' }, acIds: ['AC-0001'] });
  assert.ok(context.must_read.some(row => row.binding?.path === 'evidence/picture.png'));
  assert.ok(!context.gaps.some(row => row.path === 'evidence/picture.png'));
  assert.ok(context.gaps.some(row => row.code === 'historical_acceptance_unresolved'));
});

test('CLI prepares then resumes current local originals without overwriting packet or marking work done', async t => {
  const { runTaskContextCommand } = await import('../scripts/task-context.mjs');
  const { profile, stateRoot, root } = await fixture(t);
  const taskFile = path.join(root, 'task.json');
  await fs.writeFile(taskFile, JSON.stringify({ id: 'small', kind: 'implementation', description: '修正错字', smallChange: true }));
  const out = path.join(root, 'evidence/prepare.json');
  const dependencies = { loadProfile: async () => profile };
  const args = ['prepare', '--profile', path.join(root, 'profile.json'), '--task', taskFile, '--out', out, '--state-root', stateRoot];
  const prepared = await runTaskContextCommand(args, dependencies);
  assert.equal(prepared.provider_calls, 0);
  await assert.rejects(runTaskContextCommand(args, dependencies), /EEXIST/);
  await fs.appendFile(path.join(root, 'GUIDE.md'), '新增约定。\n');
  const resumed = await runTaskContextCommand(['resume', '--profile', path.join(root, 'profile.json'), '--from', out, '--out', path.join(root, 'evidence/resume.json'), '--state-root', stateRoot], dependencies);
  assert.equal(resumed.resume.freshness.valid, false);
  assert.equal(resumed.business_verified, false);
  assert.equal(JSON.parse(await fs.readFile(resumed.output_path, 'utf8')).must_read[0].value.includes('新增约定'), true);
  await assert.rejects(runTaskContextCommand(['prepare', '--profile', path.join(root, 'profile.json'), '--task', taskFile, '--out', taskFile, '--state-root', stateRoot], dependencies), /evidence|conflicts/);
});

test('resume groups only verified completed cache and blocks unknown-charge retransmission', async t => {
  const { classifyRequestResume } = await import('../src/task-context.mjs');
  const body = { state: 'synthetic', questions: {} }, request = { judgment_id: 'q1', body };
  const bundle = { model: MODEL, standard_sha256: 'a'.repeat(64), requests: [request] };
  const key = requestKey(request, bundle.standard_sha256, 'scope');
  const entry = { id: 'done', request_key: key, status: 'completed', evidence_kind: 'provider_response', reserved_cost_usd: RESERVED_REQUEST_USD, estimated_cost_usd: 0 };
  const ledger = { schema_version: 1, entries: [entry], cache: { [key]: { model: MODEL, standard_sha256: bundle.standard_sha256, request_sha256: hash(body), source_entry: 'done', evidence_kind: 'provider_response', raw_response: { model: MODEL } } } };
  const result = classifyRequestResume({ fresh: true }, { prepared: [{ bundle }], ledger, cacheScope: 'scope', validateResponse: raw => { assert.equal(raw.model, MODEL); } });
  assert.equal(result.completed_reusable.length, 1);
  ledger.entries.push({ ...entry, id: 'unknown', status: 'uncertain' });
  const blocked = classifyRequestResume({ fresh: true }, { prepared: [{ bundle }], ledger, cacheScope: 'scope', validateResponse: () => {} });
  assert.equal(blocked.charge_unknown.length, 1);
  assert.equal(blocked.not_started.length, 0);
  assert.equal(blocked.completed_reusable.length, 0);
});

test('stale, damaged and fixture completion never becomes reusable or unstarted work', async () => {
  const { classifyRequestResume } = await import('../src/task-context.mjs');
  const request = { judgment_id: 'q', body: { state: '公开资料', questions: {} } };
  const bundle = { model: MODEL, standard_sha256: 'b'.repeat(64), requests: [request] };
  const key = requestKey(request, bundle.standard_sha256, 'scope');
  const ledger = { schema_version: 1, entries: [{ id: 'fixture', request_key: key, status: 'completed', evidence_kind: 'adapter_fixture', reserved_cost_usd: RESERVED_REQUEST_USD, estimated_cost_usd: 0 }],
    cache: { [key]: { model: MODEL, standard_sha256: bundle.standard_sha256, request_sha256: hash(request.body), source_entry: 'fixture', evidence_kind: 'adapter_fixture', raw_response: { model: MODEL } } } };
  for (const freshness of [{ valid: true }, { valid: false }]) {
    const result = classifyRequestResume(freshness, { prepared: [{ bundle }], ledger, cacheScope: 'scope', validateResponse: () => {} });
    assert.equal(result.completed_reusable.length, 0);
    assert.equal(result.completed_unusable.length, 1);
    assert.equal(result.not_started.length, 0);
  }
  ledger.entries[0].evidence_kind = 'provider_response'; ledger.cache[key].evidence_kind = 'provider_response';
  const invalid = classifyRequestResume({ valid: true }, { prepared: [{ bundle }], ledger, cacheScope: 'scope', validateResponse: () => { throw Error('bad response'); } });
  assert.equal(invalid.completed_unusable.length, 1);
  ledger.entries = []; ledger.cache = {};
  const pending = classifyRequestResume({ valid: true }, { prepared: [{ bundle }], ledger, cacheScope: 'scope', validateResponse: () => {} });
  assert.equal(pending.not_started.length, 1);
});

async function checkedContextFixture(t, code = 'console.log("context-check")') {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'environment.json'), '{"role":"member"}');
  f.profile.environmentFiles = ['environment.json'];
  f.profile.permissions = { testArtifacts: false, network: false };
  f.profile.checks = [{ id: 'app', executable: process.execPath, args: ['-e', code], cwd: '.',
    reviewed: true, authorizationRef: 'test:isolated', effects: { writes: 'none', network: false, paid: false },
    timeoutMs: 2000, inputs: ['app.mjs', 'GUIDE.md'] }];
  f.task = { kind: 'implementation', smallChange: true, description: '修正保存行为', affectedFiles: ['app.mjs'] };
  return f;
}

test('verification projection reuses hash-checked runner evidence without executing or passing business work', async t => {
  const { buildTaskContext, verifyTaskContext } = await import('../src/task-context.mjs');
  const { runCheck } = await import('../src/runner.mjs');
  const f = await checkedContextFixture(t);
  const options = { stateRoot: f.stateRoot, task: f.task, acIds: ['AC-0001'] };
  const missing = await buildTaskContext(f.profile, options);
  assert.equal(missing.verification.required_checks[0].status, 'not_run');
  assert.equal(missing.verification.required_checks[0].entrypoint, 'run');
  const receipt = await runCheck(f.profile, 'app', f);
  assert.equal(receipt.status, 'check_passed');
  const context = await buildTaskContext(f.profile, options);
  assert.equal(context.verification.required_checks[0].status, 'passed');
  assert.equal(context.verification.reusable.filter(row => row.kind === 'program_check').length, 1);
  assert.equal(context.todo.some(row => row.kind === 'program_check'), false);
  assert.equal(context.verification.required_targets[0].roleRef, 'user');
  assert.equal(context.verification.completion.status, 'pending');
  assert.equal(context.business_verified, false);
  assert.equal((await runCheck(f.profile, 'app', f)).status, 'repeat_requires_reason');
  assert.equal((await verifyTaskContext(f.profile, context, { stateRoot: f.stateRoot })).valid, true);
  await fs.writeFile(path.join(f.root, 'environment.json'), '{"role":"admin"}');
  assert.equal((await verifyTaskContext(f.profile, context, { stateRoot: f.stateRoot })).valid, false);
  const changed = await buildTaskContext(f.profile, options);
  assert.equal(changed.verification.required_checks[0].status, 'stale');
  assert.equal(changed.todo.some(row => row.kind === 'program_check'), true);
});

test('failed check projection keeps investigation pending and never makes a reason sufficient for retry', async t => {
  const { buildTaskContext } = await import('../src/task-context.mjs');
  const { runCheck } = await import('../src/runner.mjs');
  const f = await checkedContextFixture(t, 'process.exit(7)');
  await runCheck(f.profile, 'app', f);
  const context = await buildTaskContext(f.profile, { stateRoot: f.stateRoot, task: f.task });
  assert.equal(context.verification.required_checks[0].status, 'failed');
  assert.equal(context.verification.required_checks[0].next_action, 'inspect_evidence_change_hypothesis');
  assert.equal(context.verification.reusable.length, 0);
  assert.equal(context.verification.completion.status, 'pending');
  assert.equal((await runCheck(f.profile, 'app', { ...f, repeatReason: 'try again' })).status, 'repeat_requires_evidence');
});

test('verification expansion facts bind their originals; an unsupported assertion cannot clear pending work', async t => {
  const { buildTaskContext, verifyTaskContext } = await import('../src/task-context.mjs');
  const f = await checkedContextFixture(t);
  await fs.writeFile(path.join(f.root, 'diagnosis.md'), '新增事实：管理员权限也使用保存入口。');
  const options = { stateRoot: f.stateRoot, task: { ...f.task, verificationFacts: [
    { kind: 'permission_change', fact: '管理员权限也使用保存入口', sourceRef: 'diagnosis.md' }
  ] } };
  const context = await buildTaskContext(f.profile, options);
  assert.equal(context.verification.expansion_facts.length, 1);
  assert.equal(context.verification.expansion_facts[0].binding.path, 'diagnosis.md');
  assert.equal(context.verification.required_checks.length, 1);
  assert.equal(context.verification.completion.status, 'pending');
  await fs.appendFile(path.join(f.root, 'diagnosis.md'), '\n新观察改变了调查。');
  assert.equal((await verifyTaskContext(f.profile, context, { stateRoot: f.stateRoot })).valid, false);
  const missing = await buildTaskContext(f.profile, { stateRoot: f.stateRoot, task: { ...f.task,
    verificationFacts: [{ kind: 'new_failure', fact: '保存失败', sourceRef: 'missing.md' }] } });
  assert.ok(missing.gaps.some(row => row.kind === 'verification_expansion_fact'));
  assert.equal(missing.verification.expansion_facts.length, 0);
  await assert.rejects(buildTaskContext(f.profile, { stateRoot: f.stateRoot, task: { ...f.task,
    verificationFacts: [{ kind: 'try_again', fact: '再运行一次', sourceRef: 'GUIDE.md' }] } }), /verification_fact_invalid/);
});

test('recorded acceptance projects exact current targets but does not prove unchanged external business state', async t => {
  const { buildTaskContext, verifyTaskContext } = await import('../src/task-context.mjs');
  const { validateEvidence } = await import('../src/acceptance.mjs');
  const f = await fixture(t), map = await readMap(f.profile), ac = map.acceptanceCriteria[0];
  await fs.mkdir(path.join(f.root, 'evidence'), { recursive: true });
  ac.verificationMethod = 'cli'; ac.actions = [{ type: 'invoke' }, { type: 'readback' }];
  ac.assertions = [{ id: 'saved', operator: 'equals', path: '/body', expected: 'real-context-input' }];
  ac.implementationRefs = [{ path: 'app.mjs' }];
  const target = ac.requiredTargets[0]; target.entrypointId = 'cli';
  f.profile.acceptanceRoutes = [{ id: 'cli-driver', kind: 'cli', entrypointIds: ['cli'], driverRef: 'test:existing-cli', available: true, real: true,
    authorizationRef: 'test:isolated', effects: { writes: 'test-artifacts', network: false, paid: false } }];
  const actualFile = path.join(f.root, 'evidence', 'actual.txt');
  execFileSync(process.execPath, ['-e', 'require("node:fs").writeFileSync(process.argv[1], process.argv[2])', actualFile, 'real-context-input'], { windowsHide: true });
  const body = execFileSync(process.execPath, ['-e', 'process.stdout.write(require("node:fs").readFileSync(process.argv[1]))', actualFile], { encoding: 'utf8', windowsHide: true });
  const fingerprint = [{ path: 'app.mjs', sha256: createHash('sha256').update(await fs.readFile(path.join(f.root, 'app.mjs'))).digest('hex') }];
  const executedAt = '2026-09-30T00:00:00Z';
  const receipt = { projectId: f.profile.id, acId: ac.id, acRevision: ac.revision, runId: 'actual-save', method: 'cli', observationSource: 'tool_receipt', executedAt,
    implementationFingerprint: fingerprint, observations: [{ ...target, actions: ac.actions.map(row => ({ ...row, description: 'Actual save command and separate process readback' })), actual: { body } }] };
  const bytes = JSON.stringify(receipt); await fs.writeFile(path.join(f.root, 'evidence', 'receipt.json'), bytes);
  const evidence = { id: 'EVD-0001', projectId: f.profile.id, featureId: ac.featureId, acId: ac.id, acRevision: ac.revision,
    changeId: 'CHG-0001', runId: 'actual-save', method: 'cli', observationSource: 'tool_receipt', executedAt, createdAt: executedAt, recordedBy: 'test', sourceRef: 'test:actual-cli',
    environmentRef: target.environmentRef, roleRef: target.roleRef, dataScopeRef: target.dataScopeRef, targetIds: [target.targetId], applicability: 'current',
    implementationFingerprint: fingerprint, rawEvidence: [{ path: 'evidence/receipt.json', type: 'execution', sha256: createHash('sha256').update(bytes).digest('hex') }] };
  map.evidence.push(await validateEvidence(f.profile, map, evidence));
  map.contentHash = mapHash(map); await fs.writeFile(path.join(f.root, 'docs/map.json'), JSON.stringify(map));
  const options = { stateRoot: f.stateRoot, task: { kind: 'verification', smallChange: true, description: '核现有保存目标' }, acIds: [ac.id] };
  const context = await buildTaskContext(f.profile, options);
  assert.equal(context.verification.required_targets[0].status, 'passed');
  assert.equal(context.verification.reusable[0].reuse_condition, 'review_current_external_state_with_existing_acceptance_gate');
  assert.equal(context.todo.find(row => row.kind === 'acceptance').status, 'review_current_external_state');
  assert.equal(context.verification.completion.status, 'pending');
  assert.equal(context.business_verified, false);
  target.roleRef = 'admin'; map.contentHash = mapHash(map); await fs.writeFile(path.join(f.root, 'docs/map.json'), JSON.stringify(map));
  assert.equal((await verifyTaskContext(f.profile, context, { stateRoot: f.stateRoot })).valid, false);
  const changed = await buildTaskContext(f.profile, options);
  assert.equal(changed.verification.required_targets[0].status, 'stale');
  assert.equal(changed.verification.reusable.length, 0);
});

test('rule-linked verification shares existing rules runner and retains unresolved rule gates', async t => {
  const { buildTaskContext, verifyTaskContext } = await import('../src/task-context.mjs');
  const { ENGINEERING_RULES, runEngineeringRules } = await import('../src/engineering-rules.mjs');
  const f = await checkedContextFixture(t);
  f.profile.engineeringRulesRef = 'rules.json';
  const config = { schemaVersion: 1, ruleVersion: ENGINEERING_RULES.ruleVersion,
    domains: ENGINEERING_RULES.domains.map(domain => ({ domain, applicability: domain === 'errors' ? 'applicable' : 'not_applicable', reason: 'Only error conversion applies', sourceRef: 'GUIDE.md' })),
    bindings: [{ ruleId: 'ERR-3', implementationRefs: ['app.mjs'], decisionRefs: ['GUIDE.md'], checkIds: ['app'], acIds: [] }] };
  await fs.writeFile(path.join(f.root, 'rules.json'), JSON.stringify(config));
  const options = { stateRoot: f.stateRoot, task: f.task };
  const missing = await buildTaskContext(f.profile, options);
  assert.equal(missing.verification.required_checks[0].entrypoint, 'rules run');
  const run = await runEngineeringRules(f.profile, { stateRoot: f.stateRoot });
  assert.equal(run.checks[0].status, 'check_passed');
  const context = await buildTaskContext(f.profile, options);
  assert.equal(context.verification.required_checks[0].status, 'passed');
  assert.equal(context.verification.engineering_rules.status, 'needs_binding');
  assert.equal(context.verification.completion.conditions.find(row => row.kind === 'engineering_rules').status, 'pending');
  assert.equal(context.verification.completion.status, 'pending');
  config.domains[0].sourceRef = 'missing.md'; await fs.writeFile(path.join(f.root, 'rules.json'), JSON.stringify(config));
  const unreadable = await buildTaskContext(f.profile, options);
  assert.equal(unreadable.verification.required_checks[0].status, 'unknown');
  assert.equal(unreadable.verification.reusable.length, 0);
  assert.equal((await verifyTaskContext(f.profile, unreadable, { stateRoot: f.stateRoot })).valid, false);
});

test('changed raw runner output removes local reuse even when the receipt still says passed', async t => {
  const { buildTaskContext, verifyTaskContext } = await import('../src/task-context.mjs');
  const { runCheck } = await import('../src/runner.mjs');
  const f = await checkedContextFixture(t);
  const run = await runCheck(f.profile, 'app', f);
  const options = { stateRoot: f.stateRoot, task: f.task };
  const previous = await buildTaskContext(f.profile, options);
  const receipt = JSON.parse(await fs.readFile(run.evidence, 'utf8'));
  await fs.appendFile(receipt.stdoutFile, 'unrecorded output');
  assert.equal((await verifyTaskContext(f.profile, previous, { stateRoot: f.stateRoot })).valid, false);
  const context = await buildTaskContext(f.profile, options);
  assert.equal(context.verification.required_checks[0].status, 'stale');
  assert.equal(context.verification.required_checks[0].reason, 'raw_output_changed');
  assert.equal(context.verification.reusable.length, 0);
  assert.equal(context.todo.some(row => row.kind === 'program_check'), true);
});
