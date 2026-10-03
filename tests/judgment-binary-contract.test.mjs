import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareJudgments, validateJudgmentResponse, judgmentPolicy, executeJudgments, evaluateJudgments } from '../src/judgment.mjs';
import { prepareContextRelevance, validateContextRelevanceResponse, rankContextRelevance } from '../src/context-relevance.mjs';
import { combineBinaryAnswers } from '../src/judgment-binary.mjs';
import { hash, requestKey } from '../skills/review-product-plan/scripts/jev-client.mjs';

const source = '空清单显示暂无记录。是否配插画尚未决定。';
const packet = (kind = 'requirement_fidelity') => ({ material_scope: 'synthetic', context: {}, evidence: [{ id: 'E', source_file: 's.md', source_label: '已确认决定', original_locator: '第1行', start_line: 1, end_line: 1 }], judgments: [{ id: 'T03', kind, target: '空清单显示暂无记录并配蓝色插画。', evidence_ids: ['E'] }] });
const raw = (r, choices) => ({ model: 'jev-1.13.0', answers: Object.fromEntries(Object.keys(r.body.questions).map((id, i) => [id, { type: 'choice', choice: choices[i] ?? 'yes', probabilities: Object.fromEntries(['yes', 'no', 'unknown'].map(c => [c, c === (choices[i] ?? 'yes') ? 1 : 0])), confidence: 1 }])), usage: { input_tokens: 5, output_tokens: 0 } });

test('binary contract binds source identity and all T03 propositions; first yes cannot override no', async () => {
  const b = await prepareJudgments(packet(), { readSource: async () => source });
  assert.equal(judgmentPolicy.version, 'engineering-judgments-2.0.0');
  const r = b.requests[0]; assert.ok(Object.keys(r.body.questions).length >= 2);
  for (const q of r.question_contracts) { assert.equal(q.parent_id, 'T03'); assert.ok(q.sources[0].source_sha256); assert.ok(q.yes_boundary && q.no_boundary && q.unknown_condition); }
  assert.equal(validateJudgmentResponse(raw(r, ['yes', 'no']), r).combined_choice, 'no');
  assert.equal(validateJudgmentResponse(raw(r, ['unknown', 'yes']), r).combined_choice, 'unknown');
  const missing = raw(r, ['yes']); delete missing.answers[Object.keys(missing.answers)[1]];
  assert.throws(() => validateJudgmentResponse(missing, r), /问题/);
});

test('method selection keeps multiple matches and unknown rather than inventing one winner', async () => {
  const p = packet('method_selection'); p.judgments[0].candidates = [{ id: 'first', description: '文本归纳' }, { id: 'second', description: '原件定位' }];
  const b = await prepareJudgments(p, { readSource: async () => source }), r = b.requests[0];
  const yes = validateJudgmentResponse(raw(r, ['yes', 'yes']), r);
  assert.equal(r.combination_version, r.question_contracts[0].combination_rule);
  assert.equal(yes.combination.status, 'multi_match'); assert.deepEqual(yes.combination.matches, ['first', 'second']);
  assert.equal(validateJudgmentResponse(raw(r, ['no', 'unknown']), r).combination.status, 'unknown');
});

test('relevance v2 asks direct evidence including counterevidence and background independently', async () => {
  const ref = id => ({ id, source_file: 's.md', source_label: '合成原件', original_locator: '1', start_line: 1, end_line: 1, material_scope: 'synthetic' });
  const b = await prepareContextRelevance({ project_id: 'p', task: ref('T'), candidates: [{ ...ref('C'), optional: true }], mandatory_materials: [], mandatory_checks: [] }, { readSource: async () => source });
  assert.equal(b.variant, 'independent_candidate_binary_v2'); assert.equal(b.question_count, 2);
  assert.ok(Object.values(b.requests[0].body.questions)[0].instructions.includes('反证'));
  assert.ok(Object.values(b.requests[0].body.questions).every(q => Object.keys(q.criteria).join(',') === 'yes,no,unknown'));
  const r = b.requests[0];
  assert.equal(r.question_contracts[0].standard_sha256, b.standard_sha256);
  assert.equal(r.question_contracts[0].combination_rule, r.combination_version);
  assert.equal(validateContextRelevanceResponse(raw(r, ['yes', 'yes']), r).choice, 'directly_relevant');
  assert.equal(validateContextRelevanceResponse(raw(r, ['no', 'yes']), r).choice, 'context_helpful');
  assert.equal(validateContextRelevanceResponse(raw(r, ['no', 'no']), r).choice, 'not_contributing');
  assert.equal(validateContextRelevanceResponse(raw(r, ['yes', 'unknown']), r).choice, 'unknown');
  assert.equal(rankContextRelevance(b.candidates,[{ candidate_id:'C',choice:'directly_relevant' },{ candidate_id:'C',choice:'not_contributing' }]).unknown.length,1);
});

for (const kind of ['requirement_fidelity','change_impact','issue_duplicate','qa_coverage','delivery_fidelity']) {
  test(`${kind}: all questions enter yes/no/unknown combination regardless of response order`, async () => {
    const b = await prepareJudgments(packet(kind), { readSource: async () => source }), r = b.requests[0];
    const allYes = raw(r, []); allYes.answers = Object.fromEntries(Object.entries(allYes.answers).reverse());
    assert.equal(validateJudgmentResponse(allYes,r).combined_choice,'yes');
    const choices = Array(Object.keys(r.body.questions).length).fill('yes'); choices[choices.length - 1] = 'no';
    assert.equal(validateJudgmentResponse(raw(r,choices),r).combined_choice,'no');
    choices[choices.length - 1] = 'unknown';
    assert.equal(validateJudgmentResponse(raw(r,choices),r).combined_choice,'unknown');
    const uncertain = raw(r,[]); Object.values(uncertain.answers).at(-1).confidence=.79;
    const low = validateJudgmentResponse(uncertain,r); assert.equal(low.combined_choice,'unknown'); assert.ok(low.combination.reason_codes.includes('model_uncertain'));
    const facts=validateJudgmentResponse(allYes,r).answers;
    assert.equal(combineBinaryAnswers(r,[...facts,facts[0]]).choice,'unknown');
    assert.equal(combineBinaryAnswers(r,facts.slice(0,-1)).choice,'unknown');
  });
}

test('separate method conditions require every candidate and exclude a candidate with any explicit no', async () => {
  const p=packet('method_selection'); const j=p.judgments[0];
  j.candidates=[{id:'offline',description:'本机读取'},{id:'cloud',description:'外部读取'}];
  j.propositions=[{id:'offline_task',candidate_id:'offline',proposition:'本机读取是否提供原件定位？'},{id:'offline_privacy',candidate_id:'offline',proposition:'本机读取是否符合禁止外发要求？'},{id:'cloud_task',candidate_id:'cloud',proposition:'外部读取是否提供原件定位？'}];
  const b=await prepareJudgments(p,{readSource:async()=>source}),r=b.requests[0];
  assert.deepEqual(validateJudgmentResponse(raw(r,['yes','no','yes']),r).combination.matches,['cloud']);
  j.propositions.pop(); await assert.rejects(prepareJudgments(p,{readSource:async()=>source}),/每个候选/);
});

test('v1 caches and full-source changes cannot share a binary request key; disabled remains zero-call', async () => {
  const b=await prepareJudgments(packet(),{readSource:async()=>source}), changed=await prepareJudgments(packet(),{readSource:async()=>source+'\n新版本'});
  assert.notEqual(requestKey(b.requests[0],b.standard_sha256),requestKey(changed.requests[0],changed.standard_sha256));
  const old=JSON.parse(await (await import('node:fs/promises')).readFile('policies/judgments-1.0.1.json','utf8'));
  assert.notEqual(requestKey(b.requests[0],hash(old)),requestKey(b.requests[0],b.standard_sha256));
  let calls=0; const run=await executeJudgments(b,{enabled:false,fetchImpl:async()=>{calls++;}}); assert.equal(calls,0);assert.equal(run.attempts,0);
});

test('atom and parent denominators retain missing answers and model unknown separately', async () => {
  const b=await prepareJudgments(packet('qa_coverage'),{readSource:async()=>source}),r=b.requests[0];
  const dataset={schema_version:1,material_scope:'synthetic',standard_sha256:b.standard_sha256,request_sha256:b.request_sha256,requests:b.requests,cases:[{id:'T03',kind:'qa_coverage',split:'holdout',expected_choice:'yes',baseline_choice:'yes',critical:true,expected_answers:Object.fromEntries(Object.keys(r.body.questions).map(id=>[id,'yes']))}]};
  const run={status:'failed',request_sha256:b.request_sha256,standard_sha256:b.standard_sha256,model_requested:b.model,results:[],local_results:[]};
  const report=evaluateJudgments(dataset,[run]).runs[0]; assert.equal(report.holdout.cases,1);assert.equal(report.question_count,4);assert.equal(report.unknown_reasons.missing_receipt,4);assert.equal(report.holdout.fallback_required,1);
});
