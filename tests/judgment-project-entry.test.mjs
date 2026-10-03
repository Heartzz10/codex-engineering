import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { runProjectJudgmentCommand } from '../scripts/engineering-judge-project.mjs';
import { RESERVED_REQUEST_USD, withFileLedger, requestKey, hash, MODEL } from '../skills/review-product-plan/scripts/jev-client.mjs';
import * as routing from '../src/judgment-routing.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const quote = '只有服务端确认后才显示已保存。';
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'judge-project-entry-'));
  t.after(async () => { const { rm } = await import('node:fs/promises'); await rm(root, { recursive: true, force: true }); });
  const sourceFile = path.join(root, 'decision.md');
  const targetFile = path.join(root, 'copy.txt');
  await writeFile(sourceFile, `${quote}\n`); await writeFile(targetFile, '已保存\n');
  const profile = { id: 'example', root, featureMapRef: { schemaVersion: 1, path: 'map.json', historyDir: 'history', evidenceDir: 'evidence' } };
  const map = { projectId: 'example', revision: 1, contentHash: 'a'.repeat(64) };
  const task = {
    judgment_id: 'AC-0001-r1-ui-copy', ac_id: 'AC-0001', ac_revision: 1, target_id: 'ui', assertion_id: 'copy',
    kind: 'requirement_fidelity', target: '已保存', context: { expected: '只有服务端确认后才显示已保存。', preconditions: ['已登录'], actions: ['保存'] },
    evidence: [{ id: 'E1', source_file: sourceFile, source_label: '确认决定', original_locator: '第1行', start_line: 1, end_line: 1, quote, kind: 'user_decision' }],
    reason_codes: [], source_bindings: [
      { path: 'decision.md', sha256: digest(`${quote}\n`), selector: { startLine: 1, endLine: 1 }, value: quote },
      { path: 'copy.txt', sha256: digest('已保存\n'), selector: { startLine: 1, endLine: 1 }, value: '已保存' }
    ],
    material_scope: 'synthetic', review_scope: { category: 'ordinary_status_copy', impact: 'low', decision_ref: 'decision.md:1', reviewer_ref: 'reviewer:owner', checked_exclusions: [], present_effects: [] }
  };
  const plan = { schema_version: 1, project_id: profile.id, map_binding: { path: 'map.json', content_hash: map.contentHash, revision: 1 }, program_tasks: [{ judgment_id: 'PROGRAM-1', ac_id: 'AC-0001', kind: 'program_assertion', target: 'state', reason_codes: ['program_check_reference'] }], codex_tasks: [{ ...task, judgment_id: 'LOCAL-1', reason_codes: ['semantic_review_missing'] }], candidates: [task], counts: { total: 3 } };
  const deps = {
    loadProfile: async () => profile, readMap: async () => map, buildProjectJudgments: async () => structuredClone(plan),
    verifyProjectJudgmentSources: async () => ({ valid: digest(await readFile(sourceFile, 'utf8')) === task.source_bindings[0].sha256 && digest(await readFile(targetFile, 'utf8')) === task.source_bindings[1].sha256, reason_codes: ['source_changed'] })
  };
  return { root, sourceFile, targetFile, profile, map, task, deps };
}
const options = (f, name, more = {}) => ({ profile: path.join(f.root, 'profile.json'), change: 'CHG-0001', out: path.join(f.root, name), 'state-root': f.root, ...more });
const answer = body => ({ model: 'jev-1.13.0', answers: Object.fromEntries(Object.entries(body.questions).map(([id, q]) => [id, { type: 'choice', choice: 'yes', probabilities: Object.fromEntries(Object.keys(q.criteria).map(k => [k, k === 'yes' ? 1 : 0])), confidence: 1 }])), usage: { input_tokens: 1000, output_tokens: 0 } });

test('unscoped request keys retain the old format while plan scopes isolate cache entries', () => {
  const request = { body: { questions: { A: 'same' } } }; const standard = 'standard';
  assert.equal(requestKey(request, standard), hash({ model: MODEL, standard_sha256: standard, body: request.body }));
  assert.notEqual(requestKey(request, standard, 'plan-a'), requestKey(request, standard, 'plan-b'));
});

test('routing verifies a cached receipt using the same optional plan scope', () => {
  const request = { body: { questions: { A: 'same' } } }; const standard = 'standard';
  const raw = { model: MODEL, answers: { A: 'supported' } };
  const key = requestKey(request, standard, 'plan-a');
  const row = { origin: 'cache', source_entry: 'entry-1', source_evidence_kind: 'provider_response', raw_response: raw };
  const ledger = { entries: [{ id: 'entry-1', status: 'completed', evidence_kind: 'provider_response', request_key: key }],
    cache: { [key]: { evidence_kind: 'provider_response', source_entry: 'entry-1', request_sha256: hash(request.body), raw_response: raw } } };
  assert.equal(routing.validCachedReviewReceipt(request, row, ledger, standard, 'plan-a'), true);
  assert.equal(routing.validCachedReviewReceipt(request, row, ledger, standard, 'plan-b'), false);
  assert.equal(routing.validCachedReviewReceipt(request, row, ledger, standard), false);
  const legacyKey = requestKey(request, standard);
  const legacyLedger = { entries: [{ ...ledger.entries[0], request_key: legacyKey }], cache: { [legacyKey]: ledger.cache[key] } };
  assert.equal(routing.validCachedReviewReceipt(request, row, legacyLedger, standard), true);
  assert.equal(routing.validCachedReviewReceipt(request, row, legacyLedger, standard, 'plan-a'), false);
});

test('daily unqualified plan and project produce complete Codex queue without credentials or network', async t => {
  const f = await fixture(t); let keys = 0, calls = 0, ledgers = 0;
  const deps = { ...f.deps, resolveApiKey: async () => { keys++; return 'key'; }, fetchImpl: async () => { calls++; }, withFileLedger: async () => { ledgers++; } };
  const planned = await runProjectJudgmentCommand('plan', options(f, 'plan.json'), deps);
  const run = await runProjectJudgmentCommand('project', options(f, 'daily.json', { 'approved-sha': planned.plan_sha256 }), deps);
  assert.equal(planned.status, 'planned'); assert.equal(run.status, 'review_fallback');
  assert.equal(run.worklist.counts.codex_review, 2); assert.equal(run.program_tasks.length, 1);
  assert.deepEqual([keys, calls, ledgers], [0, 0, 0]);
  assert.equal(run.cost_reduction_proven, false); assert.equal(run.enabled, false);
  assert.equal(run.project_id, 'example'); assert.equal(run.max_requests, 0); assert.equal(run.reserved_cost_usd, 0);
  assert.equal(run.program_tasks[0].passed, undefined);
  assert.equal(run.worklist.codex_tasks.every(task => !Object.hasOwn(task, 'source_bindings')), true);
  assert.equal(JSON.parse(await readFile(run.output_path, 'utf8')).plan_sha256, planned.plan_sha256);
});

test('validation requires the current whole-plan approval and stays advisory', async t => {
  const f = await fixture(t); const calls = []; let keys = 0;
  const deps = { ...f.deps, resolveApiKey: async () => { keys++; return 'key'; }, fetchImpl: async (_url, init) => { const body = JSON.parse(init.body); calls.push(body); return { ok: true, json: async () => answer(body) }; } };
  const planned = await runProjectJudgmentCommand('plan', options(f, 'validation-plan.json', { purpose: 'validation' }), deps);
  const bad = await runProjectJudgmentCommand('project', options(f, 'bad-sha.json', { purpose: 'validation', 'approved-sha': '0'.repeat(64), ledger: path.join(f.root, 'ledger.json'), 'budget-usd': '0.05', 'max-requests': '2' }), deps);
  assert.equal(bad.status, 'blocked'); assert.equal(keys, 0); assert.equal(calls.length, 0);
  const run = await runProjectJudgmentCommand('project', options(f, 'validation.json', { purpose: 'validation', 'approved-sha': planned.plan_sha256, ledger: path.join(f.root, 'ledger.json'), 'budget-usd': '0.05', 'max-requests': '2', cache: 'off' }), deps);
  assert.equal(run.status, 'completed'); assert.equal(keys, 1); assert.equal(calls.length, 1);
  assert.equal(JSON.stringify(calls[0]).includes(f.root), false);
  assert.equal(run.max_requests, 1); assert.equal(run.reserved_cost_usd, RESERVED_REQUEST_USD);
  assert.equal(run.worklist.counts.codex_review, 2); assert.equal(run.worklist.counts.reused, 0);
  assert.ok(run.runs[0].results[0].raw_response); assert.equal(run.cost_reduction_proven, false);
});

test('explicitly disabled validation never reads credentials or ledger', async t => {
  const f = await fixture(t); let keys = 0, ledgers = 0;
  const run = await runProjectJudgmentCommand('project', options(f, 'disabled.json', { purpose: 'validation', enabled: 'false' }), {
    ...f.deps, resolveApiKey: async () => { keys++; return 'key'; }, withFileLedger: async () => { ledgers++; }
  });
  assert.equal(run.status, 'disabled'); assert.equal(run.worklist.counts.codex_review, 2);
  assert.deepEqual([keys, ledgers], [0, 0]);
});

test('incomplete local task remains explicit and is not claimed as embedded material', async t => {
  const f = await fixture(t);
  const deps = { ...f.deps, buildProjectJudgments: async () => {
    const plan = await f.deps.buildProjectJudgments();
    plan.codex_tasks[0].target = { pointer: '/missing' };
    plan.codex_tasks[0].evidence = [];
    return plan;
  } };
  const result = await runProjectJudgmentCommand('plan', options(f, 'incomplete.json'), deps);
  const task = result.worklist.codex_tasks.find(row => row.judgment_id === 'LOCAL-1');
  assert.equal(task.material_embedded, false); assert.ok(task.reason_codes.includes('local_material_not_embedded'));
  assert.equal(Object.hasOwn(task, 'source_bindings'), false);
});

test('whole-batch budget preflight blocks before any call and preserves all tasks', async t => {
  const f = await fixture(t); let calls = 0;
  const deps = { ...f.deps, resolveApiKey: async () => 'key', fetchImpl: async () => { calls++; } };
  deps.buildProjectJudgments = async () => {
    const plan = await f.deps.buildProjectJudgments();
    plan.candidates.push({ ...structuredClone(plan.candidates[0]), judgment_id: 'AC-0001-r1-ui-copy-2' });
    return plan;
  };
  const planned = await runProjectJudgmentCommand('plan', options(f, 'budget-plan.json', { purpose: 'validation' }), deps);
  const run = await runProjectJudgmentCommand('project', options(f, 'budget.json', { purpose: 'validation', 'approved-sha': planned.plan_sha256, ledger: path.join(f.root, 'ledger.json'), 'budget-usd': String(RESERVED_REQUEST_USD), 'max-requests': '2' }), deps);
  assert.equal(run.status, 'blocked'); assert.equal(run.attempts, 0); assert.equal(calls, 0);
  assert.equal(run.worklist.counts.codex_review, 3); assert.equal(run.program_tasks.length, 1);
  assert.equal(run.cumulative_budget_used_usd, 0);
});

test('source changing during provider call retains charged receipt and returns all semantic work to Codex', async t => {
  const f = await fixture(t);
  const deps = { ...f.deps, resolveApiKey: async () => 'key', fetchImpl: async (_url, init) => {
    await writeFile(f.targetFile, '已变更\n'); const body = JSON.parse(init.body); return { ok: true, json: async () => answer(body) };
  } };
  deps.buildProjectJudgments = async () => {
    const plan = await f.deps.buildProjectJudgments();
    plan.candidates.push({ ...structuredClone(plan.candidates[0]), judgment_id: 'AC-0001-r1-ui-copy-2' });
    return plan;
  };
  const planned = await runProjectJudgmentCommand('plan', options(f, 'source-plan.json', { purpose: 'validation' }), deps);
  const ledger = path.join(f.root, 'ledger.json');
  const run = await runProjectJudgmentCommand('project', options(f, 'source-run.json', { purpose: 'validation', 'approved-sha': planned.plan_sha256, ledger, 'budget-usd': '0.05', 'max-requests': '2', cache: 'off' }), deps);
  assert.equal(run.status, 'review_fallback'); assert.equal(run.attempts, 1);
  assert.equal(run.worklist.counts.codex_review, 3); assert.ok(run.runs[0].results[0].raw_response);
  assert.equal(run.worklist.codex_tasks.every(task => task.provider_choice === null && task.reason_codes.includes('source_changed')), true);
  assert.equal(run.runs[1], null);
  assert.equal(JSON.parse(await readFile(ledger, 'utf8')).entries[0].status, 'completed');
});

test('uncertain transport charge is retained in ledger and never presented as a known fee', async t => {
  const f = await fixture(t); let calls = 0;
  const deps = { ...f.deps, resolveApiKey: async () => 'key', fetchImpl: async () => { calls++; throw Error('offline'); } };
  const planned = await runProjectJudgmentCommand('plan', options(f, 'uncertain-plan.json', { purpose: 'validation' }), deps);
  const ledger = path.join(f.root, 'uncertain-ledger.json');
  const run = await runProjectJudgmentCommand('project', options(f, 'uncertain.json', { purpose: 'validation', 'approved-sha': planned.plan_sha256, ledger, 'budget-usd': '0.05', 'max-requests': '2', cache: 'off' }), deps);
  assert.equal(calls, 1); assert.equal(run.attempts, 1); assert.equal(run.uncertain_charge, true);
  assert.equal(run.estimated_cost_usd, null); assert.equal(run.worklist.counts.codex_review, 2);
  assert.equal(JSON.parse(await readFile(ledger, 'utf8')).entries[0].status, 'uncertain');
});

test('cache reuses only the same approved whole plan and full source identity', async t => {
  const f = await fixture(t); const calls = [];
  const deps = { ...f.deps,
    buildProjectJudgments: async () => {
      const plan = await f.deps.buildProjectJudgments();
      plan.candidates[0].source_bindings[0].sha256 = digest(await readFile(f.sourceFile, 'utf8'));
      return plan;
    },
    verifyProjectJudgmentSources: async (_profile, plan) => ({
      valid: plan.candidates[0].source_bindings[0].sha256 === digest(await readFile(f.sourceFile, 'utf8')),
      reason_codes: ['source_changed']
    }),
    resolveApiKey: async () => 'key',
    fetchImpl: async (_url, init) => { const body = JSON.parse(init.body); calls.push(body); return { ok: true, json: async () => answer(body) }; }
  };
  const ledger = path.join(f.root, 'cache-ledger.json');
  const common = { purpose: 'validation', ledger, 'budget-usd': '0.05', 'max-requests': '3' };
  const plan1 = await runProjectJudgmentCommand('plan', options(f, 'cache-plan-1.json', common), deps);
  const first = await runProjectJudgmentCommand('project', options(f, 'cache-run-1.json', { ...common, 'approved-sha': plan1.plan_sha256 }), deps);
  const plan2 = await runProjectJudgmentCommand('plan', options(f, 'cache-plan-2.json', common), deps);
  const second = await runProjectJudgmentCommand('project', options(f, 'cache-run-2.json', { ...common, 'approved-sha': plan2.plan_sha256 }), deps);
  assert.equal(plan1.plan_sha256, plan2.plan_sha256); assert.equal(first.attempts, 1);
  assert.equal(second.attempts, 0); assert.equal(second.cache_hits, 1); assert.equal(calls.length, 1);
  await writeFile(f.sourceFile, `${quote}\n未引用的补充行。\n`);
  const plan3 = await runProjectJudgmentCommand('plan', options(f, 'cache-plan-3.json', common), deps);
  assert.notEqual(plan3.plan_sha256, plan1.plan_sha256);
  const third = await runProjectJudgmentCommand('project', options(f, 'cache-run-3.json', { ...common, 'approved-sha': plan3.plan_sha256 }), deps);
  assert.equal(third.attempts, 1); assert.equal(third.cache_hits, 0); assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].questions, calls[1].questions); assert.notDeepEqual(calls[0].state.source_identity, calls[1].state.source_identity);
});

test('failure after charged progress keeps the original output and writes recovery', async t => {
  const f = await fixture(t); let calls = 0;
  const deps = { ...f.deps, resolveApiKey: async () => 'key', fetchImpl: async (_url, init) => { calls++; const body = JSON.parse(init.body); return { ok: true, json: async () => answer(body) }; }, withFileLedger: async (file, fn) => { await withFileLedger(file, fn); throw Error('cleanup failed'); } };
  const planned = await runProjectJudgmentCommand('plan', options(f, 'recovery-plan.json', { purpose: 'validation' }), deps);
  const run = await runProjectJudgmentCommand('project', options(f, 'recovery.json', { purpose: 'validation', 'approved-sha': planned.plan_sha256, ledger: path.join(f.root, 'ledger.json'), 'budget-usd': '0.05', 'max-requests': '2' }), deps);
  assert.equal(calls, 1); assert.equal(run.status, 'recovery_required'); assert.equal(run.attempts, 1);
  assert.ok(run.recovery_path); assert.ok(JSON.parse(await readFile(run.output_path, 'utf8')).runs[0].results[0].raw_response);
  await access(run.recovery_path);
});

test('input and output paths cannot collide or replace existing files', async t => {
  const f = await fixture(t);
  await assert.rejects(runProjectJudgmentCommand('plan', options(f, 'x.json', { out: f.sourceFile }), f.deps), /覆盖|冲突/);
  const out = path.join(f.root, 'exists.json'); await writeFile(out, 'keep');
  await assert.rejects(runProjectJudgmentCommand('plan', options(f, 'x.json', { out }), f.deps), /EEXIST/);
  assert.equal(await readFile(out, 'utf8'), 'keep');
  await assert.rejects(runProjectJudgmentCommand('project', options(f, 'different.json', { purpose: 'validation', ledger: f.sourceFile, 'approved-sha': '0'.repeat(64) }), f.deps), /冲突/);
});
