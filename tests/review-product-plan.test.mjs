import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { prepareReview, validateResponse, executeReview, resolveApiKey, rubric, hash } from '../skills/review-product-plan/scripts/jev-review-1.2.0.mjs';

const source = '个人兴趣练习，每周整理10条读书记录。\n完全离线，CSV导出，每周手动备份。\n启动时必须联网把全部清单发送给云端模型，断网禁用。';
function packet() {
  return {
    context: { purpose: '个人兴趣练习', constraints: ['接受每周手动备份', '不处理敏感数据'] },
    evidence: [{ id: 'E1', source_file: 'source.md', source_label: '方案', original_locator: '第1—3段', start_line: 1, end_line: 3, quote: source }],
    dimensions: rubric.dimensions.map(d => ({ id: d.id, applicability: 'applicable', reason: '个人本地项目', evidence_ids: ['E1'] }))
  };
}
const prepare = p => prepareReview(p, { readSource: async () => source });
function answer(request) {
  return { model: 'jev-1.13.0', answers: Object.fromEntries(Object.keys(request.body.questions).map(id => [id, {
    type: 'choice', choice: 'supported', probabilities: { supported: 0.7, change_needed: 0.1, insufficient: 0.1, not_applicable: 0.1 }, confidence: 0.5
  }])), usage: { input_tokens: 1200, output_tokens: 50 } };
}

test('13 dimensions produce grounded atomic questions without local paths or preliminary verdicts', async () => {
  const b = await prepare(packet());
  assert.equal(b.requests.length, 13);
  assert.equal(new Set(b.requests.map(r => r.dimension_id)).size, 13);
  const request = b.requests[0];
  assert.ok(Object.keys(request.body.questions).length >= 4);
  assert.equal(request.body.state.evidence[0].quote, source);
  assert.equal(JSON.stringify(b.requests).includes('source_file'), false);
  assert.equal(request.body.model, 'jev-1.13.0');
});

test('fabricated quotes and invalid line ranges are rejected before any network call', async () => {
  const p = packet(); p.evidence[0].quote = '此方案全部通过';
  await assert.rejects(prepare(p), /quote|引文/);
  const q = packet(); q.evidence[0].start_line = 0;
  await assert.rejects(prepare(q), /line|行/);
});

test('missing, duplicate, unknown dimensions and evidence references are rejected', async () => {
  const p = packet(); p.dimensions.pop(); await assert.rejects(prepare(p), /dimension|维度/);
  const q = packet(); q.dimensions[1].id = q.dimensions[0].id; await assert.rejects(prepare(q), /dimension|维度/);
  const r = packet(); r.dimensions[0].evidence_ids = ['invented']; await assert.rejects(prepare(r), /evidence|证据/);
});

test('no evidence remains insufficient; documented non-applicability is not treated as a passing score', async () => {
  const p = packet(); p.dimensions[0].evidence_ids = [];
  p.dimensions[1].applicability = 'not_applicable'; p.dimensions[1].reason = '该流程不在用户范围内';
  const b = await prepare(p);
  assert.equal(b.local_results[0].status, 'insufficient');
  assert.equal(b.local_results[1].status, 'not_applicable');
  assert.equal(b.requests.length, 11);
});

test('response preserves probability and provenance without inventing explanations', async () => {
  const b = await prepare(packet()); const request = b.requests[0];
  const result = validateResponse(answer(request), request);
  assert.equal(result.answers[0].provider_choice, 'supported');
  assert.equal(result.answers[0].confidence, 0.5);
  assert.equal(result.answers[0].review_required, true);
  assert.equal('reasoning' in result.answers[0], false);
});

test('invalid probability distributions, missing answers, model drift and wrong winner fail closed', async () => {
  const b = await prepare(packet()); const r = b.requests[0]; const id = Object.keys(r.body.questions)[0];
  const cases = [
    a => { a.answers[id].probabilities.supported = 1.2; },
    a => { delete a.answers[id]; },
    a => { a.model = 'jev-latest'; },
    a => { a.answers[id].choice = 'change_needed'; },
    a => { a.usage.input_tokens = -1; },
    a => { a.answers[id].probabilities.other = 0; },
    a => { a.answers[id].confidence = null; }
  ];
  for (const mutate of cases) { const a = answer(r); mutate(a); assert.throws(() => validateResponse(a, r)); }
});

test('no key, no authorization, changed bundle or inadequate budget never calls network', async () => {
  const b = await prepare(packet()); let calls = 0;
  const options = { apiKey: 'test-secret', approvedSha: b.request_sha256, budgetUsd: 1, fetchImpl: async () => { calls++; } };
  await assert.rejects(executeReview(b, { ...options, apiKey: '' }), /key|密钥/);
  await assert.rejects(executeReview(b, { ...options, approvedSha: '' }), /approve|授权|指纹/);
  await assert.rejects(executeReview(b, { ...options, budgetUsd: 0.001 }), /budget|预算/);
  const changed = structuredClone(b); changed.requests[0].body.state.context.purpose = 'changed';
  await assert.rejects(executeReview(changed, options), /hash|指纹/);
  assert.equal(calls, 0);
});

test('live transport is fixed to TypeSafe, stops on failure and never automatically retries', async () => {
  const b = await prepare(packet()); let calls = 0;
  const result = await executeReview(b, {
    apiKey: 'test-secret', approvedSha: b.request_sha256, budgetUsd: 1,
    fetchImpl: async (url, options) => {
      calls++; assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
      assert.equal(options.redirect, 'error'); assert.equal(options.headers.Authorization, 'Bearer test-secret');
      return { ok: false, status: 429 };
    }
  });
  assert.equal(calls, 1); assert.equal(result.status, 'failed');
  assert.equal(result.attempts, 1); assert.equal(result.results.length, 0);
  assert.equal(JSON.stringify(result).includes('test-secret'), false);
});

test('successful mocked transport records actual usage, model and raw response separately from estimates', async () => {
  const b = await prepare(packet()); let calls = 0;
  const result = await executeReview(b, {
    apiKey: 'test-secret', approvedSha: b.request_sha256, budgetUsd: 1,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => answer(b.requests[calls++]) })
  });
  assert.equal(result.status, 'completed'); assert.equal(calls, 13);
  assert.equal(result.usage.input_tokens, 15600);
  assert.equal(result.results[0].model, 'jev-1.13.0');
  assert.ok(result.results[0].raw_response);
  assert.ok(result.estimated_cost_usd < result.reserved_cost_usd);
});

test('escaped credentials in unexpected provider fields never survive into saved results', async () => {
  const b = await prepare(packet()); const secret = 'secret-"quote\\backslash'; let n = 0;
  const r = await executeReview(b, { apiKey: secret, approvedSha: b.request_sha256, budgetUsd: 1,
    fetchImpl: async () => ({ ok: true, json: async () => ({ ...answer(b.requests[n++]), echoed: secret }) }) });
  assert.equal(r.status, 'completed');
  assert.equal(JSON.stringify(r).includes(JSON.stringify(secret).slice(1, -1)), false);
});

test('run rechecks complete dimension coverage even when a modified preview has a fresh matching hash', async () => {
  const b = await prepare(packet()); b.requests = b.requests.slice(0, 1); b.request_sha256 = hash(b.requests);
  let calls = 0;
  await assert.rejects(executeReview(b, { apiKey: 'test-secret', approvedSha: b.request_sha256, budgetUsd: 1,
    fetchImpl: async () => { calls++; } }), /维度|dimension/);
  assert.equal(calls, 0);
});

test('response validation failure retains sanitized raw diagnostic evidence and never silently retries', async () => {
  const b = await prepare(packet()); const raw = answer(b.requests[0]); raw.answers.value_1.probabilities.supported = 0.4;
  const r = await executeReview(b, { apiKey: 'test-secret', approvedSha: b.request_sha256, budgetUsd: 1,
    fetchImpl: async () => ({ ok: true, json: async () => raw }) });
  assert.equal(r.status, 'failed'); assert.equal(r.attempts, 1);
  assert.equal(r.failed_response.raw_response.answers.value_1.probabilities.supported, 0.4);
  assert.match(r.error, /概率/);
});

test('post-response storage failure stops and returns completed response for recovery while marking uncertainty', async () => {
  const b = await prepare(packet()); let saves = 0; let calls = 0;
  const r = await executeReview(b, { apiKey: 'test-secret', approvedSha: b.request_sha256, budgetUsd: 1,
    fetchImpl: async () => { calls++; return { ok: true, json: async () => answer(b.requests[0]) }; },
    save: async () => { if (++saves >= 3) throw new Error('disk full'); } });
  assert.equal(r.status, 'persistence_failed'); assert.equal(r.uncertain_charge, true);
  assert.equal(r.attempts, 1); assert.equal(calls, 1); assert.equal(r.results.length, 1);
  assert.equal(r.usage.input_tokens, 1200);
});

test('oversized evidence is rejected instead of silently truncated', async () => {
  const p = packet(); const huge = '字'.repeat(30000); p.evidence[0].quote = huge; p.evidence[0].end_line = 1;
  await assert.rejects(prepareReview(p, { readSource: async () => huge }), /size|长度|大小/);
});

test('local credential reference reads only the labeled Jev value and never silently picks a different provider', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'product-review-key-'));
  const keys = path.join(dir, 'keys.txt'); const config = path.join(dir, 'runtime.local.json');
  await writeFile(keys, 'deepseek: other-provider-secret\njev： synthetic-jev-secret-value\nother: another-secret');
  await writeFile(config, JSON.stringify({ key_file: keys }));
  assert.equal(await resolveApiKey({ env: {}, configPath: config }), 'synthetic-jev-secret-value');
  assert.equal(await resolveApiKey({ env: { TYPESAFE_API_KEY: 'environment-value' }, configPath: config }), 'environment-value');
  await writeFile(keys, 'deepseek: other-provider-secret');
  await assert.rejects(resolveApiKey({ env: {}, configPath: config }), /Jev|jev/);
  await writeFile(keys, 'jev: synthetic-one-key\njev: synthetic-two-key');
  await assert.rejects(resolveApiKey({ env: {}, configPath: config }), /多个|ambiguous/);
});

test('CLI prepares a file-based preview, protects existing files, and blocks send without key', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'product-review-'));
  await writeFile(path.join(dir, 'source.md'), source);
  await writeFile(path.join(dir, 'packet.json'), JSON.stringify(packet()));
  const cli = path.resolve('skills/review-product-plan/scripts/jev-review-1.2.0.mjs');
  const run = args => spawnSync(process.execPath, [cli, ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, TYPESAFE_API_KEY: '', JEV_API_KEY: '' } });
  const p = run(['prepare', '--input', 'packet.json', '--out', 'preview.json']);
  assert.equal(p.status, 0, p.stderr);
  const b = JSON.parse(await readFile(path.join(dir, 'preview.json'), 'utf8'));
  assert.equal(b.request_sha256, hash(b.requests));
  assert.notEqual(run(['prepare', '--input', 'packet.json', '--out', 'preview.json']).status, 0);
  const live = run(['run', '--input', 'preview.json', '--out', 'run.json', '--approved-sha', b.request_sha256, '--budget-usd', '1']);
  assert.notEqual(live.status, 0);
  assert.match(live.stderr, /key|密钥/);
});
