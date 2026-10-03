import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { runPilot, validateReadingOutput, collectNativeWindows } from './run.mjs';
import { contextRelevancePolicy } from '../../../src/context-relevance.mjs';
import { hash, requestKey, RESERVED_REQUEST_USD } from '../../../skills/review-product-plan/scripts/jev-client.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const jsonFile = async (file, value) => writeFile(file, JSON.stringify(value, null, 2) + '\n');
const json = async file => JSON.parse(await readFile(file, 'utf8'));
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ce-relevance-pilot-'));
  await writeFile(path.join(root, 'source.md'), '合成任务：寻找保存证据。\n合成候选：保存后读回一条。\n');
  const ref = (id, line) => ({ id, material_scope: 'synthetic', source_file: 'source.md', source_label: 'local fixture only', original_locator: `line ${line}`, start_line: line, end_line: line });
  const batches = [], references = [];
  for (let i = 0; i < 8; i++) {
    const id = `Q${i + 1}`, candidate = `C${i + 1}`, file = path.join(root, `${id}.json`);
    await jsonFile(file, { project_id: 'fixture-only', task: ref(`T${i + 1}`, 1), candidates: [{ ...ref(candidate, 2), optional: true }], mandatory_materials: ['REQ'], mandatory_checks: ['CHECK'] });
    batches.push({ id, packet_file: `${id}.json`, packet_sha256: sha(await readFile(file)) });
    references.push({ batch_id: id, candidate_id: candidate, category: ['direct_evidence', 'direct_counterevidence', 'same_topic', 'missing_material'][Math.floor(i / 2)], expected: { [`${candidate}__direct`]: 'yes', [`${candidate}__background`]: 'yes' } });
  }
  const reference = path.join(root, 'reference.json');
  await jsonFile(reference, { schema_version: 1, reference_kind: 'synthetic_program_fixture_not_gold', cases: references });
  const pkg = await json(new URL('../../../package.json', import.meta.url));
  const protocol = { schema_version: 1, study_id: 'fixture-pilot', frozen_at: '2026-09-30T00:00:00Z', phase: 'Q', codex: { model: 'gpt-6.1-sol', effort: 'high' }, software: { package_version: pkg.version, standard_sha256: hash(contextRelevancePolicy) }, ledger_file: 'ledger.json', limits: { Q: { requests: 8, usd: .025 }, E: { requests: 20, usd: .06 }, total: { requests: 28, usd: .085 }, automatic_retries: 0 }, authorization: { provider: 'TypeSafe Jev', material_scopes: ['public', 'synthetic'], scope_ref: 'fixture: no real provider authorization' }, prepared_dir: 'prepared', run_dir: 'run', batches, quality_reference: { file: 'reference.json', sha256: sha(await readFile(reference)) }, measurement_file: 'measurement.json', completion_rule: 'all eight valid and independently scored; fixture never qualifies' };
  const file = path.join(root, 'protocol.json'); await jsonFile(file, protocol);
  return { root, file, protocol, prepare: ['prepare', '--protocol', file, '--out', path.join(root, 'prepared')], run: ['run', '--protocol', file, '--out', path.join(root, 'run')] };
}
const reply = body => ({ model: 'jev-1.13.0', answers: Object.fromEntries(Object.keys(body.questions).map(id => [id, { type: 'choice', choice: 'yes', confidence: 1, probabilities: { yes: 1, no: 0, unknown: 0 } }])), usage: { input_tokens: 100, output_tokens: 0 } });

test('model/source drift fails before dispatch; preparation binds full sources and keeps missing cost windows unknown', async () => {
  const f = await fixture();
  const prepared = await runPilot(f.prepare);
  assert.equal(prepared.status, 'prepared');
  const frozen = await json(path.join(f.root, 'prepared', 'prepared.json'));
  assert.equal(frozen.batches.length, 8);
  assert.equal(frozen.batches[0].bundle.question_count, 2);
  assert.equal(frozen.batches[0].bundle.task.quote, '合成任务：寻找保存证据。');
  assert.equal(frozen.batches[0].bundle.candidates[0].quote, '合成候选：保存后读回一条。');
  await writeFile(path.join(f.root, 'source.md'), '合成任务：寻找保存证据。\n合成候选：保存后读回一条。\n全文尾部也改变身份\n');
  let calls = 0, keyReads = 0;
  await assert.rejects(runPilot(f.run, { readApiKey: async () => { keyReads++; return 'fixture'; }, fetchImpl: async () => { calls++; throw Error('no dispatch'); } }), /来源|source/i);
  assert.equal(calls, 0); assert.equal(keyReads, 0);
  const journal = path.join(f.root, 'native.jsonl');
  const rows = [
    { type: 'session_meta', timestamp: '2026-09-30T00:00:01Z', payload: { id: 'one' } },
    { type: 'turn_context', timestamp: '2026-09-30T00:00:02Z', payload: { model: 'gpt-6-luna', effort: 'medium' } },
    ...['before', 'after'].map((id, i) => ({ type: 'token_usage_record', timestamp: `2026-09-30T00:00:0${i + 3}Z`, payload: { thread_id: 'one', response_id: id, thread_token_usage: { input_tokens: 100 + i * 10, cached_input_tokens: 10, output_tokens: 5, reasoning_output_tokens: 0, total_tokens: 105 + i * 10 } } }))
  ];
  await writeFile(journal, rows.map(row => JSON.stringify(row)).join('\n'));
  await assert.rejects(collectNativeWindows([{ journal, session_id: 'one', start_response_id: 'before', end_response_id: 'after', scope: 'task' }], f.protocol.codex), /model|模型/i);
  const missing = await collectNativeWindows([], f.protocol.codex);
  assert.equal(missing.tokens, null); assert.equal(missing.status, 'unknown');
});

test('bad output and wrong reading order preserve raw; valid IDs/quotes need no semantic re-answer', async () => {
  const candidates = [{ id: 'C1', quote: '正文甲' }, { id: 'C2', quote: '正文乙' }];
  assert.throws(() => validateReadingOutput('not-json', candidates, ['C1', 'C2']), /format|格式/i);
  assert.throws(() => validateReadingOutput([{ id: 'C2', quote: '正文乙', limitations: '' }, { id: 'C1', quote: '正文甲', limitations: '' }], candidates, ['C1', 'C2']), /order|顺序/i);
  assert.throws(() => validateReadingOutput([{ id: 'C1', quote: '杜撰', limitations: '' }], candidates, ['C1', 'C2']), /quote|引文/i);
  assert.deepEqual(validateReadingOutput([{ id: 'C1', quote: '正文甲', limitations: '合成' }], candidates, ['C1', 'C2']), [{ id: 'C1', quote: '正文甲', limitations: '合成' }]);
  const f = await fixture(); await runPilot(f.prepare);
  await runPilot(f.run, { apiKey: 'fixture', fetchImpl: async (_, init) => ({ ok: true, json: async () => reply(JSON.parse(init.body)) }) });
  const report = await runPilot(['collect', '--protocol', f.file, '--out', path.join(f.root, 'collection')]);
  assert.equal(report.quality.passed, false); assert.equal(report.quality.evidence_kind, 'adapter_fixture');
  assert.equal(report.metrics.codex_tokens, null); assert.equal(report.metrics.whole_workflow_ms, null);
  assert.equal(report.production_enabled, false);
});

test('same-key unknown blocks new calls with full reserve and the shared stage/total ledger cannot be reset', async () => {
  const f = await fixture(); await runPilot(f.prepare);
  const frozen = await json(path.join(f.root, 'prepared', 'prepared.json')), bundle = frozen.batches[0].bundle;
  await jsonFile(path.join(f.root, 'ledger.json'), { schema_version: 1, entries: [{ id: 'prior-unknown', request_key: requestKey(bundle.requests[0], bundle.standard_sha256, bundle.plan_sha256), status: 'uncertain', reserved_cost_usd: RESERVED_REQUEST_USD, estimated_cost_usd: 0 }], cache: {} });
  let calls = 0, credentials = 0;
  const result = await runPilot(f.run, { readApiKey: async () => { credentials++; return 'fixture'; }, fetchImpl: async () => { calls++; throw Error('no request'); } });
  assert.equal(result.status, 'recovery_required'); assert.equal(result.attempts, 0); assert.equal(result.cumulative_budget_used_usd, RESERVED_REQUEST_USD);
  assert.equal(calls, 0); assert.equal(credentials, 0);
  const other = await fixture(); await runPilot(other.prepare);
  await jsonFile(path.join(other.root, 'ledger.json'), { schema_version: 1, entries: Array.from({ length: 28 }, (_, i) => ({ id: `old-${i}`, request_key: `old-${i}`, status: 'completed', reserved_cost_usd: RESERVED_REQUEST_USD, estimated_cost_usd: .00001 })), cache: {} });
  await assert.rejects(runPilot(other.run, { apiKey: 'fixture', fetchImpl: async () => { calls++; throw Error('no request'); } }), /累计|limit|请求/i);
  assert.equal(calls, 0);
});

test('prepared batches cannot be removed or substituted under the original protocol hash', async () => {
  const f=await fixture();await runPilot(f.prepare);
  const file=path.join(f.root,'prepared','prepared.json'),prepared=await json(file);prepared.batches.pop();await jsonFile(file,prepared);
  let calls=0,keys=0;
  await assert.rejects(runPilot(f.run,{readApiKey:async()=>{keys++;return 'fixture';},fetchImpl:async()=>{calls++;throw Error('blocked');}}),/prepared|准备|身份|batch/i);
  assert.equal(calls,0);assert.equal(keys,0);
});

test('historical completed entries without phase ownership cannot reset the Q request cap', async()=>{
  const f=await fixture();await runPilot(f.prepare);
  await jsonFile(path.join(f.root,'ledger.json'),{schema_version:1,entries:Array.from({length:7},(_,i)=>({id:`past-${i}`,request_key:`past-${i}`,status:'completed',reserved_cost_usd:RESERVED_REQUEST_USD,estimated_cost_usd:.00001})),cache:{}});
  let calls=0,keys=0;
  await assert.rejects(runPilot(f.run,{readApiKey:async()=>{keys++;return 'fixture';},fetchImpl:async(_,init)=>{calls++;return{ok:true,json:async()=>reply(JSON.parse(init.body))};}}),/阶段|phase|历史|ownership/i);
  assert.equal(calls,0);assert.equal(keys,0);
});

test('changing fixture labels into provider evidence cannot make Q quality pass',async()=>{
  const f=await fixture();await runPilot(f.prepare);await runPilot(f.run,{apiKey:'fixture',fetchImpl:async(_,init)=>({ok:true,json:async()=>reply(JSON.parse(init.body))})});
  const file=path.join(f.root,'run','run.json'),raw=await json(file);
  for(const row of raw.runs)row.result.evidence_kind='provider_response';await jsonFile(file,raw);
  const report=await runPilot(['collect','--protocol',f.file,'--out',path.join(f.root,'collection')]);
  assert.equal(report.quality.passed,false);assert.equal(report.quality.complete,false);
});

test('Q raw low confidence cannot be overwritten by a derived yes fact',async()=>{
  const f=await fixture();await runPilot(f.prepare);await runPilot(f.run,{apiKey:'fixture',fetchImpl:async(_,init)=>({ok:true,json:async()=>reply(JSON.parse(init.body))})});
  const file=path.join(f.root,'run','run.json'),raw=await json(file),row=raw.runs[0].result.results[0];
  row.raw_response.answers.C1__direct.confidence=.2;row.facts[0].choice='yes';await jsonFile(file,raw);
  const report=await runPilot(['collect','--protocol',f.file,'--out',path.join(f.root,'collection')]);
  assert.equal(report.quality.rows[0].effective_choice,'unknown');assert.equal(report.quality.rows[0].correct,false);assert.equal(report.quality.passed,false);
});

test('phase reserve insufficient blocks before key access and provider dispatch',async()=>{
  const f=await fixture();f.protocol.limits.Q.usd=RESERVED_REQUEST_USD/2;await jsonFile(f.file,f.protocol);await runPilot(f.prepare);
  let calls=0,keys=0;
  await assert.rejects(runPilot(f.run,{readApiKey:async()=>{keys++;return 'fixture';},fetchImpl:async()=>{calls++;throw Error('blocked');}}),/预算|budget/i);
  assert.equal(calls,0);assert.equal(keys,0);
});

test('E rejects a passed Q summary when original eight receipts are only fixtures',async()=>{
  const f=await fixture();await runPilot(f.prepare);await runPilot(f.run,{apiKey:'fixture',fetchImpl:async(_,init)=>({ok:true,json:async()=>reply(JSON.parse(init.body))})});
  const collected=await runPilot(['collect','--protocol',f.file,'--out',path.join(f.root,'collection')]);
  collected.quality.passed=true;const gate=path.join(f.root,'collection','collection.json');await jsonFile(gate,collected);
  const ids=Array.from({length:6},(_,i)=>`E${i}`),arm={session_rule:'one_dedicated_session',continuation_rule:'explicit_session_id_new_material_only',initial_count:5,order:ids};
  const protocol={...f.protocol,phase:'E',prepared_dir:'E-prepared',run_dir:'E-run',quality_gate:{file:gate,sha256:sha(await readFile(gate))},workflow:{tasks:[1,2].map(i=>({source_group:`source-${i}`,candidate_ids:ids,A:{reading_rule:'original',comparable:false},B:arm,C:arm,mandatory_materials:[],mandatory_checks:[],completion_rule:'complete',expand_rule:'when needed'}))}};
  const file=path.join(f.root,'E-protocol.json');await jsonFile(file,protocol);await runPilot(['prepare','--protocol',file,'--out',path.join(f.root,'E-prepared')]);let calls=0,keys=0;
  await assert.rejects(runPilot(['run','--protocol',file,'--out',path.join(f.root,'E-run')],{readApiKey:async()=>{keys++;return 'fixture';},fetchImpl:async()=>{calls++;throw Error('blocked');}}),/Q原回执|Q.*未通过/i);
  assert.equal(calls,0);assert.equal(keys,0);
});
