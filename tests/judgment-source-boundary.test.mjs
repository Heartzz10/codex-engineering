import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { prepareJudgments, executeJudgments, evaluateJudgments } from '../src/judgment.mjs';
import { buildJudgmentWorklist } from '../src/judgment-worklist.mjs';
import { runJudgmentCommand } from '../scripts/engineering-judge.mjs';
import { fixtureResponse } from './helpers/judgment-response.mjs';

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(),'ce-judge-source-boundary-'));
  const source = '收到服务端确认并读回后才显示已保存。', file = path.join(root,'source.md'); await writeFile(file,source);
  const packet = { material_scope:'synthetic',context:{},evidence:[{id:'E',source_file:'source.md',source_label:'已确认原件',original_locator:'1',start_line:1,end_line:1}],judgments:['FIRST','SECOND'].map(id=>({id,kind:'requirement_fidelity',target:'已保存需有服务端确认。',evidence_ids:['E']})) };
  const bundle = await prepareJudgments(packet,{baseDir:root}); return {root,source,file,packet,bundle};
}
const options = bundle => ({ apiKey:'fixture-only',approvedSha:bundle.request_sha256,budgetUsd:.02,maxRequests:4 });

test('advisory API verifies each dispatch and response; changed first response stops the second call',async()=>{
  const f=await fixture(); let calls=0,reads=0;const ledger={schema_version:1,entries:[],cache:{}};
  const result=await executeJudgments(f.bundle,{...options(f.bundle),ledger,readSource:async file=>{reads++;return readFile(file,'utf8');},fetchImpl:async(_url,init)=>{calls++;await writeFile(f.file,'原件已改变');return{ok:true,json:async()=>fixtureResponse({body:JSON.parse(init.body)})};}});
  assert.equal(calls,1);assert.ok(reads>=3);assert.equal(result.status,'review_fallback');assert.equal(result.failure_code,'source_changed');assert.equal(result.source_valid,false);
  assert.equal(result.results.length,1);assert.ok(result.results[0].raw_response);assert.equal(ledger.entries.length,1);assert.equal(ledger.entries[0].status,'completed');
  const list=buildJudgmentWorklist(f.bundle,result);assert.equal(list.counts.codex_review,2);assert.ok(list.codex_tasks.every(row=>row.provider_choice===null));
});

test('advisory API rejects stale or unreadable originals before dispatch and cannot reuse stale cache',async()=>{
  const f=await fixture(); let calls=0;const ledger={schema_version:1,entries:[],cache:{}};
  const opt={...options(f.bundle),ledger,fetchImpl:async(_url,init)=>{calls++;return{ok:true,json:async()=>fixtureResponse({body:JSON.parse(init.body)})};}};
  const warm=await executeJudgments(f.bundle,opt);assert.equal(warm.status,'completed');assert.equal(calls,2);
  await writeFile(f.file,'同摘录之外原件已变化');
  const stale=await executeJudgments(f.bundle,opt);assert.equal(stale.status,'review_fallback');assert.equal(stale.failure_code,'source_changed');assert.equal(stale.attempts,0);assert.equal(stale.cache_hits,0);assert.equal(calls,2);
  const absent=await executeJudgments(f.bundle,{...opt,readSource:async()=>{throw Error('missing');}});assert.equal(absent.failure_code,'source_unreadable');assert.equal(absent.attempts,0);
});

test('direct CLI uses the same per-request source barrier and retains first charged receipt',async()=>{
  const f=await fixture();const input=path.join(f.root,'packet.json'),out=path.join(f.root,'result.json'),ledger=path.join(f.root,'ledger.json');await writeFile(input,JSON.stringify(f.packet));let calls=0;
  const result=await runJudgmentCommand(['review','--input',input,'--out',out,'--ledger',ledger,'--approved-sha',f.bundle.request_sha256,'--budget-usd','.02','--max-requests','4'],{resolveApiKey:async()=> 'fixture-only',fetchImpl:async(_url,init)=>{calls++;await writeFile(f.file,'供应商等待期间原件变化');return{ok:true,json:async()=>fixtureResponse({body:JSON.parse(init.body)})};}});
  assert.equal(calls,1);assert.equal(result.status,'review_fallback');assert.equal(result.failure_code,'source_changed');assert.equal(result.attempts,1);assert.equal(result.worklist.counts.codex_review,2);assert.ok(result.results[0].raw_response);
  assert.equal(JSON.parse(await readFile(ledger,'utf8')).entries.length,1);
});

test('source changing while the first cached receipt is persisted stops subsequent cache reuse',async()=>{
  const f=await fixture();let calls=0,changed=false;const ledger={schema_version:1,entries:[],cache:{}};
  const opt={...options(f.bundle),ledger,fetchImpl:async(_url,init)=>{calls++;return{ok:true,json:async()=>fixtureResponse({body:JSON.parse(init.body)})};}};
  await executeJudgments(f.bundle,opt);
  const result=await executeJudgments(f.bundle,{...opt,save:async progress=>{if(progress.cache_hits===1&&!changed){changed=true;await writeFile(f.file,'缓存读回期间原件已变化');}}});
  assert.equal(calls,2);assert.equal(result.cache_hits,1);assert.equal(result.status,'review_fallback');assert.equal(result.failure_code,'source_changed');assert.equal(result.results.length,1);assert.equal(result.results[0].combined_choice,'unknown');assert.equal(ledger.entries.length,2);
});

test('source-invalid receipts remain unknown in scoring even if a caller marks the batch completed',async()=>{
  const f=await fixture();f.packet.judgments=Array.from({length:12},(_,i)=>({...f.packet.judgments[0],id:`CASE${i}`}));const b=await prepareJudgments(f.packet,{baseDir:f.root});
  const dataset={schema_version:1,material_scope:'synthetic',standard_sha256:b.standard_sha256,request_sha256:b.request_sha256,requests:b.requests,cases:b.requests.map(r=>({id:r.judgment_id,kind:r.kind,split:'holdout',expected_choice:'yes',baseline_choice:'yes',critical:true}))};
  const run={status:'completed',source_valid:false,failure_code:'source_changed',evidence_kind:'provider_response',model_requested:b.model,standard_sha256:b.standard_sha256,request_sha256:b.request_sha256,results:b.requests.map(r=>({judgment_id:r.judgment_id,origin:'live',raw_response:fixtureResponse(r)}))};
  const report=evaluateJudgments(dataset,[run]);assert.equal(report.online_quality_passed,false);assert.equal(report.runs[0].holdout.correct,0);assert.equal(report.runs[0].holdout.abstentions,12);assert.ok(report.runs[0].question_rows.every(r=>r.choice==='unknown'&&r.reason==='source_changed'));
});
