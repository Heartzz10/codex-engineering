import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareJudgments, validateJudgmentBundle } from '../src/judgment.mjs';
import * as routing from '../src/judgment-routing.mjs';

const source = '请求进行时显示正在保存。\n结果未知时显示待确认。';
const packet = () => ({ material_scope: 'synthetic', context: { purpose: '状态文案' },
  evidence: [{ id: 'E1', source_file: 'source.md', source_label: '既有需求',
    original_locator: '第2行', start_line: 2, end_line: 2 }],
  judgments: [{ id: 'COPY1', kind: 'requirement_fidelity', target: '结果未知时显示待确认。', evidence_ids: ['E1'] }] });
const prepare = value => prepareJudgments(value, { readSource: async () => source });

test('source locations produce the same authorized request as explicitly copied quotes', async () => {
  const automatic = await prepare(packet());
  const explicit = packet(); explicit.evidence[0].quote = source.split('\n')[1];
  const copied = await prepare(explicit);
  assert.deepEqual(automatic.requests, copied.requests);
  assert.equal(automatic.request_sha256, copied.request_sha256);
  assert.equal(automatic.requests[0].body.state.evidence[0].quote, '结果未知时显示待确认。');
  explicit.evidence[0].quote = '错误的原文';
  await assert.rejects(prepare(explicit), /引文/);
});

test('automatic quotes do not conceal empty or out of range source locations', async () => {
  const outside = packet(); outside.evidence[0].end_line = 9;
  await assert.rejects(prepare(outside), /引文|范围/);
  const blank = packet();
  await assert.rejects(prepareJudgments(blank, { readSource: async () => '首行\n  ' }), /引文|范围/);
});

test('local fallback retains the original question so Codex can review it without reopening a packet', async () => {
  const value = packet(); value.evidence = []; value.judgments[0].evidence_ids = [];
  const bundle = await prepare(value);
  assert.equal(bundle.requests.length, 0);
  assert.equal(bundle.local_results[0].review_material.judgment.target, value.judgments[0].target);
  assert.deepEqual(bundle.local_results[0].review_material.context, value.context);
  assert.deepEqual(bundle.local_results[0].review_material.evidence, []);
  assert.equal(bundle.local_results[0].review_required, true);
  assert.doesNotThrow(() => validateJudgmentBundle(bundle));
  const old = structuredClone(bundle); delete old.local_results[0].review_material;
  assert.doesNotThrow(() => validateJudgmentBundle(old));
  bundle.local_results[0].review_material.judgment.kind = 'unrelated';
  assert.throws(() => validateJudgmentBundle(bundle), /材料/);
});

test('worklist routing cannot trust caller-authored or deserialized reuse decisions', () => {
  assert.equal(typeof routing.trustedReviewRouting, 'function');
  const bundle = { request_sha256: 'fake', routing_sha256: 'fake' };
  const run = { status: 'completed', evidence_kind: 'provider_response',
    review_routing: [{ judgment_id: 'COPY1', action: 'reuse_supported', reason_codes: [] }] };
  assert.equal(routing.trustedReviewRouting(bundle, run), false);
  assert.equal(routing.trustedReviewRouting(bundle, JSON.parse(JSON.stringify(run))), false);
  assert.equal(routing.trustedReviewRouting(null, null), false);
});
