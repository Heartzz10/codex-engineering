import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareJudgments } from '../src/judgment.mjs';
import { buildJudgmentWorklist, compactJudgmentWorklist } from '../src/judgment-worklist.mjs';

function expandForTest(compact) {
  const { context_pool, evidence_pool, codex_tasks, ...header } = compact;
  return {
    ...header,
    codex_tasks: codex_tasks.map(({ context_ref, evidence_refs, ...task }) => ({
      ...task,
      context: context_pool[context_ref],
      evidence: evidence_refs.map(ref => evidence_pool[ref])
    }))
  };
}

test('repeated context and citations become shorter while every task material reconstructs', async () => {
  const quote = '原文要求所有判断保留同一条有完整定位的证据。'.repeat(12);
  const packet = {
    material_scope: 'synthetic',
    context: { purpose: '检查全部要求', constraint: '保留逐条证据及上下文'.repeat(10) },
    evidence: [{ id: 'E1', source_file: 'source.md', source_label: '合成原文', original_locator: '第1行', start_line: 1, end_line: 1, quote }],
    judgments: Array.from({ length: 12 }, (_, index) => ({
      id: `REQ-${index + 1}`, kind: 'requirement_fidelity', target: `第 ${index + 1} 项保留原要求。`, evidence_ids: ['E1']
    }))
  };
  const bundle = await prepareJudgments(packet, { readSource: async () => quote });
  const original = buildJudgmentWorklist(bundle, null);
  const compact = compactJudgmentWorklist(original);
  assert.equal(compact.context_pool.length, 1);
  assert.equal(compact.evidence_pool.length, 1);
  assert.ok(compact.codex_tasks.every(task => task.context_ref === 0 && task.evidence_refs[0] === 0));
  assert.ok(compact.codex_tasks.every(task => !Object.hasOwn(task, 'context') && !Object.hasOwn(task, 'evidence')));
  assert.deepEqual(expandForTest(compact), original);
  assert.ok(JSON.stringify(compact).length < JSON.stringify(original).length * 0.8);
  assert.equal(JSON.stringify(compact).includes('raw_response'), false);
  assert.equal(JSON.stringify(compact).includes('ledger'), false);
});

test('same evidence ID with different content remains distinct; status and reuse metadata are copied', () => {
  const original = {
    schema_version: 1, mode: 'selective', status: 'future_unknown_status', provider_choice_role: 'advisory_only',
    counts: { total: 3, codex_review: 2, reused: 1 }, reused_ids: ['REQ-3'],
    standard: { version: 'v1', kinds: { requirement_fidelity: { instruction: '同一标准' } } },
    codex_tasks: [
      { judgment_id: 'REQ-1', kind: 'requirement_fidelity', target: '一', candidates: ['a'], context: { note: '相同' },
        evidence: [{ id: 'E1', quote: '第一段' }, { id: 'E1', quote: '第一段' }], provider_choice: 'supported', reason_codes: ['review'] },
      { judgment_id: 'REQ-2', kind: 'requirement_fidelity', target: '二', candidates: ['b'], context: { note: '相同' },
        evidence: [{ id: 'E1', quote: '第二段' }], provider_choice: null, reason_codes: ['unknown'] }
    ]
  };
  const compact = compactJudgmentWorklist(original);
  assert.equal(compact.evidence_pool.length, 2);
  assert.deepEqual(compact.codex_tasks[0].evidence_refs, [0, 0]);
  assert.deepEqual(compact.codex_tasks[1].evidence_refs, [1]);
  assert.equal(compact.status, 'future_unknown_status');
  assert.deepEqual(compact.counts, original.counts);
  assert.deepEqual(compact.reused_ids, original.reused_ids);
  assert.deepEqual(expandForTest(compact), original);
});

test('empty review queue has empty pools and preserves its header', () => {
  const original = { schema_version: 1, mode: 'selective', status: 'completed', provider_choice_role: 'advisory_only',
    counts: { total: 1, codex_review: 0, reused: 1 }, reused_ids: ['REQ-1'], standard: { version: 'v1' }, codex_tasks: [] };
  const compact = compactJudgmentWorklist(original);
  assert.deepEqual(compact.context_pool, []);
  assert.deepEqual(compact.evidence_pool, []);
  assert.deepEqual(compact.codex_tasks, []);
  assert.deepEqual(expandForTest(compact), original);
});
