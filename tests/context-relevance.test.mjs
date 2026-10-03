import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareContextRelevance, executeContextRelevance, rankContextRelevance, validateContextRelevanceBundle, verifyContextRelevanceSources } from '../src/context-relevance.mjs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { requestKey, RESERVED_REQUEST_USD } from '../skills/review-product-plan/scripts/jev-client.mjs';
import { runContextRelevanceCommand } from '../scripts/context-relevance.mjs';

const source = '找保存失败后保留输入的证据。\n断线后仍保留正文，恢复后读回一条。\n搜索没有匹配。\n';
const ref = (id, line, extra = {}) => ({ id, material_scope: 'synthetic', source_file: 'sample.md', source_label: '合成验收', original_locator: `第${line}行`, start_line: line, end_line: line, ...extra });
const packet = () => ({ project_id: 'isolated-sample', task: ref('TASK', 1), candidates: [ref('C1', 2, { optional: true }), ref('C2', 3, { optional: true })], mandatory_materials: ['REQ-1'], mandatory_checks: ['CHECK-1'] });
const prepare = () => prepareContextRelevance(packet(), { readSource: async () => source });
const response = request => ({ model: 'jev-1.13.0', answers: Object.fromEntries(Object.keys(request.body.questions).map(id => [id,{ type: 'choice', choice: 'yes', probabilities: { yes: 1, no: 0, unknown: 0 }, confidence: 1 }])), usage: { input_tokens: 1000, output_tokens: 0 } });

test('daily and disabled validation do not read credentials or ledger', async () => {
  const bundle = await prepare(); let reads = 0;
  const options = { readApiKey: async () => { reads++; throw Error(); }, loadLedger: async () => { reads++; throw Error(); } };
  const daily = await executeContextRelevance(bundle, options);
  assert.equal(daily.attempts, 0); assert.equal(daily.production_enabled, false); assert.equal(reads, 0);
  const off = await executeContextRelevance(bundle, { ...options, purpose: 'validation', enabled: false });
  assert.equal(off.attempts, 0); assert.equal(reads, 0);
  assert.deepEqual(daily.mandatory_checks, ['CHECK-1']); assert.equal(daily.candidates.length, 2);
});

test('private task/candidate and mandatory candidate are rejected before source reads', async () => {
  for (const edit of [p => p.task.material_scope = 'private', p => p.candidates[0].material_scope = 'private', p => p.candidates[0].optional = false]) {
    const p = packet(); edit(p); let read = false;
    await assert.rejects(prepareContextRelevance(p, { readSource: async () => { read = true; return source; } }));
    assert.equal(read, false);
  }
});

test('source and full candidate-set changes bind authorization; body contains no local paths', async () => {
  const b = await prepare(); assert(!JSON.stringify(b.requests.map(r => r.body)).includes(process.cwd()));
  const changed = structuredClone(b); changed.candidates.pop(); assert.throws(() => validateContextRelevanceBundle(changed));
  const changedTask = structuredClone(b); changedTask.requests[0].body.state.task.quote = 'changed'; assert.throws(() => validateContextRelevanceBundle(changedTask));
  let keys = 0;
  const stale = await executeContextRelevance(b, { purpose: 'validation', approvedSha: b.plan_sha256, readSource: async () => source + '无关尾部也改变全文', readApiKey: async () => { keys++; return 'synthetic'; } });
  assert.equal(stale.status, 'local_fallback'); assert.equal(stale.attempts, 0); assert.equal(keys, 0);
});

test('unknown remains separate; ordering does not remove candidates or hard checks', () => {
  const candidates = [{ id: 'C2' }, { id: 'C1' }, { id: 'C3' }];
  const ranked = rankContextRelevance(candidates, [{ candidate_id: 'C2', choice: 'unknown', probabilities: { directly_relevant: .4, context_helpful: .1 } }, { candidate_id: 'C1', choice: 'context_helpful', probabilities: { directly_relevant: .1, context_helpful: .8 } }]);
  assert.deepEqual(ranked.ranked.map(x => x.id), ['C1']); assert.deepEqual(ranked.unknown.map(x => x.id), ['C2', 'C3']); assert.equal(ranked.all.length, 3);
});

test('validation reuses fixed ledger/cache and preserves unknown charge without retry', async () => {
  const b = await prepare(); const ledger = { schema_version: 1, entries: [], cache: {} }; let calls = 0;
  const options = { purpose: 'validation', approvedSha: b.plan_sha256, apiKey: 'synthetic-secret', ledger, readSource: async () => source, budgetUsd: .02, maxRequests: 2, fetchImpl: async (_, init) => { calls++; const body = JSON.parse(init.body); return { ok: true, json: async () => response({ body, judgment_id: Object.keys(body.questions)[0] }) }; } };
  const first = await executeContextRelevance(b, options); assert.equal(first.attempts, 2); assert.equal(first.production_enabled, false);
  const warm = await executeContextRelevance(b, options); assert.equal(warm.attempts, 0); assert.equal(warm.cache_hits, 2); assert.equal(calls, 2);
  const failed = await executeContextRelevance(b, { ...options, ledger: { schema_version: 1, entries: [], cache: {} }, fetchImpl: async () => { calls++; return { ok: false, status: 429 }; } });
  assert.equal(failed.attempts, 1); assert.equal(failed.uncertain_charge, true); assert.equal(failed.status, 'local_fallback'); assert.equal(failed.candidates.length, 2);
});

test('a source change during the first response stops remaining requests and rejects ordering', async () => {
  const b = await prepare(); let current = source, calls = 0;
  const result = await executeContextRelevance(b, { purpose: 'validation', approvedSha: b.plan_sha256, apiKey: 'synthetic-secret', ledger: { schema_version: 1, entries: [], cache: {} }, budgetUsd: .02, maxRequests: 2, readSource: async () => current, fetchImpl: async (_, init) => { calls++; const body = JSON.parse(init.body); current += 'changed'; return { ok: true, json: async () => response({ body, judgment_id: Object.keys(body.questions)[0] }) }; } });
  assert.equal(calls, 1); assert.equal(result.status, 'local_fallback'); assert.equal(result.ordering_accepted, false); assert.equal(result.uncertain_charge, true);
});

test('prepared relative references verify from their original directory in another working directory', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ce-relevance-'));
  try {
    await writeFile(path.join(directory, 'sample.md'), source);
    const bundle = await prepareContextRelevance(packet(), { baseDir: directory });
    assert.equal(await verifyContextRelevanceSources(bundle), true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('wrong approval and inadequate budget cannot access credentials or ledger', async () => {
  const bundle = await prepare(); let reads = 0;
  const options = { purpose: 'validation', readApiKey: async () => { reads++; return 'secret'; }, withLedger: () => { reads++; throw Error(); }, readSource: async () => source };
  const missing = await executeContextRelevance(bundle, options); assert.equal(missing.reason, 'authorization_missing_or_mismatch');
  await assert.rejects(executeContextRelevance(bundle, { ...options, approvedSha: bundle.plan_sha256, budgetUsd: .001, maxRequests: 2 }), /预算/);
  assert.equal(reads, 0);
});

test('invalid/missing supplier labels remain fallback with full uncertain reserve', async () => {
  const bundle = await prepare(); const ledger = { schema_version: 1, entries: [], cache: {} };
  const result = await executeContextRelevance(bundle, { purpose: 'validation', approvedSha: bundle.plan_sha256, apiKey: 'synthetic-secret', ledger, readSource: async () => source, budgetUsd: .02, maxRequests: 2, fetchImpl: async (_, init) => {
    const body = JSON.parse(init.body), raw = response({ body, judgment_id: Object.keys(body.questions)[0] });
    Object.values(raw.answers)[0].choice = 'unsupported'; return { ok: true, json: async () => raw };
  } });
  assert.equal(result.attempts, 1); assert.equal(result.provider_status, 'failed'); assert.equal(result.unknown.length, 2); assert.equal(result.ordering_accepted, false); assert.equal(result.uncertain_charge, true); assert.equal(ledger.entries[0].status, 'uncertain');
});

test('source changes outside selected excerpts and changes to derived upstream invalidate receipt', async () => {
  const packetWithUpstream = packet(); packetWithUpstream.upstream_sources = [{ source_file: 'upstream.json', sha256: (await import('node:crypto')).createHash('sha256').update('{"synthetic":true}').digest('hex') }];
  const bundle = await prepareContextRelevance(packetWithUpstream, { readSource: async file => file.endsWith('upstream.json') ? '{"synthetic":true}' : source });
  await assert.rejects(verifyContextRelevanceSources(bundle, { readSource: async file => file.endsWith('upstream.json') ? '{"synthetic":false}' : source }), /上游全文/);
});

test('failed progress persistence blocks provider and remains local fallback', async () => {
  const b = await prepare(); let calls = 0;
  const result = await executeContextRelevance(b, { purpose: 'validation', approvedSha: b.plan_sha256, apiKey: 'synthetic-secret', ledger: { schema_version: 1, entries: [], cache: {} }, readSource: async () => source, budgetUsd: .02, maxRequests: 2, saveLedger: async () => { throw Error('fixture'); }, fetchImpl: async () => { calls++; throw Error('must not dispatch'); } });
  assert.equal(result.provider_status, 'persistence_failed'); assert.equal(result.attempts, 0); assert.equal(calls, 0); assert.equal(result.ordering_accepted, false);
});

test('a prior uncertain or reserved same-key request blocks redispatch across runs', async () => {
  const b = await prepare(); let calls = 0, credentials = 0;
  for (const status of ['uncertain', 'reserved']) {
    const ledger = { schema_version: 1, entries: [{ id: 'prior', request_key: requestKey(b.requests[0], b.standard_sha256, b.plan_sha256), status, reserved_cost_usd: RESERVED_REQUEST_USD, estimated_cost_usd: 0 }], cache: {} };
    const result = await executeContextRelevance(b, { purpose: 'validation', approvedSha: b.plan_sha256, readApiKey: async () => { credentials++; return 'secret'; }, ledger, readSource: async () => source, budgetUsd: .02, maxRequests: 3, fetchImpl: async () => { calls++; throw Error('must not send'); } });
    assert.equal(result.attempts, 0); assert.equal(result.reason, 'same_request_charge_unresolved'); assert.equal(result.uncertain_charge, true); assert.equal(result.cumulative_budget_used_usd, RESERVED_REQUEST_USD); assert.equal(ledger.entries.length, 1);
  }
  assert.equal(calls, 0); assert.equal(credentials, 0);
});

test('fixture cache is never reused or promoted as provider evidence in a real run', async () => {
  const b = await prepare(), ledger = { schema_version: 1, entries: [], cache: {} };
  const syntheticFetch = async (_, init) => { const body = JSON.parse(init.body); return { ok: true, json: async () => response({ body, judgment_id: Object.keys(body.questions)[0] }) }; };
  const common = { purpose: 'validation', approvedSha: b.plan_sha256, apiKey: 'synthetic-secret', ledger, readSource: async () => source, budgetUsd: .02, maxRequests: 4 };
  const fixture = await executeContextRelevance(b, { ...common, fetchImpl: syntheticFetch }); assert.equal(fixture.evidence_kind, 'adapter_fixture');
  const originalFetch = globalThis.fetch; let realCalls = 0;
  try {
    globalThis.fetch = async (...args) => { realCalls++; return syntheticFetch(...args); };
    const real = await executeContextRelevance(b, common);
    assert.equal(real.cache_hits, 0); assert.equal(real.attempts, 2); assert.equal(realCalls, 2); assert.equal(real.evidence_kind, 'provider_response');
    assert.equal(ledger.entries.filter(x => x.evidence_kind === 'adapter_fixture').length, 2); assert.equal(ledger.entries.length, 4);
  } finally { globalThis.fetch = originalFetch; }
});

test('daily CLI refuses to overwrite bundle, ledger or existing source without credential access', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ce-relevance-out-'));
  try {
    const bundle = await prepare(); const input = path.join(directory, 'bundle.json'), ledger = path.join(directory, 'ledger.json'), original = path.join(directory, 'source.md');
    await writeFile(input, JSON.stringify(bundle)); await writeFile(ledger, '{"preserve":"ledger"}'); await writeFile(original, source);
    let keys = 0;
    for (const output of [input, ledger, original]) await assert.rejects(runContextRelevanceCommand(['run', '--input', input, '--out', output, '--ledger', ledger], { resolveApiKey: async () => { keys++; throw Error(); } }), /已存在|覆盖|EEXIST/);
    assert.equal(keys, 0);
    assert.equal((await import('node:fs/promises')).readFile ? await (await import('node:fs/promises')).readFile(ledger, 'utf8') : '', '{"preserve":"ledger"}');
    assert.equal(await (await import('node:fs/promises')).readFile(original, 'utf8'), source);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
