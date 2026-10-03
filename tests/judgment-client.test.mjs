import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareReview, executeReview as realExecuteReview, rubric } from '../skills/review-product-plan/scripts/jev-review.mjs';

const source = '用户要求离线保存，允许每周手动备份。';
const executeReview=(bundle,options)=>realExecuteReview(bundle,{readSource:async()=>source,...options});
const bundle = () => prepareReview({ context: { purpose: '合成离线测试' }, evidence: [{ id: 'E1', source_file: 'source.md', source_label: '合成要求', original_locator: '第1行', start_line: 1, end_line: 1, quote: source }], dimensions: rubric.dimensions.map((d, n) => ({ id: d.id, applicability: 'applicable', reason: '合成测试', evidence_ids: n === 0 ? ['E1'] : [] })) }, { readSource: async () => source });
const response = request => ({ model: 'jev-1.13.0', answers: Object.fromEntries(Object.keys(request.body.questions).map(id => [id, { type: 'choice', choice: 'yes', probabilities: { yes: 1, no: 0, unknown: 0 }, confidence: 1 }])), usage: { input_tokens: 1200, output_tokens: 0 } });

test('cancel before dispatch never sends or converts cancellation into success', async () => {
  const b = await bundle(); const controller = new AbortController(); controller.abort(); let calls = 0;
  const r = await executeReview(b, { apiKey: 'synthetic-secret', approvedSha: b.request_sha256, budgetUsd: 1, signal: controller.signal, fetchImpl: async () => { calls++; return { ok: true, json: async () => response(b.requests[0]) }; } });
  assert.equal(r.status, 'cancelled'); assert.equal(calls, 0); assert.equal(r.attempts, 0);
});

test('a transport ignoring abort cannot turn a response after deadline into accepted evidence', async () => {
  const b = await bundle();
  const r = await executeReview(b, { apiKey: 'synthetic-secret', approvedSha: b.request_sha256, budgetUsd: 1, timeoutMs: 5, fetchImpl: async () => { await new Promise(resolve => setTimeout(resolve, 30)); return { ok: true, json: async () => response(b.requests[0]) }; } });
  assert.equal(r.status, 'failed'); assert.equal(r.failure_code, 'timeout'); assert.equal(r.results.length, 0); assert.equal(r.uncertain_charge, true);
  await new Promise(resolve => setTimeout(resolve, 40)); assert.equal(r.results.length, 0);
});

test('a previous uncertain charge reserves cumulative budget before another request can start', async () => {
  const b = await bundle(); const ledger = { schema_version: 1, entries: [], cache: {} }; let calls = 0;
  const options = { apiKey: 'synthetic-secret', approvedSha: b.request_sha256, budgetUsd: 0.003, ledger, fetchImpl: async () => { calls++; return { ok: false, status: 429 }; } };
  const r = await executeReview(b, options); assert.equal(r.status, 'failed');
  await assert.rejects(executeReview(b, options), /累计|budget|预算/); assert.equal(calls, 1);
});
