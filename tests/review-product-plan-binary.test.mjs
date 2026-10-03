import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareReview, validateResponse, executeReview, rubric } from '../skills/review-product-plan/scripts/jev-review.mjs';
const source = '本机离线工具。插画尚未决定。方案却承诺蓝色插画。';
const packet = () => ({ context: { purpose: '离线个人工具' }, evidence: [{ id:'E1', source_file:'source.md', source_label:'合成方案', original_locator:'第1行', start_line:1, end_line:1, quote:source }], dimensions:rubric.dimensions.map(d=>({id:d.id, applicability:'applicable', reason:'已确认个人本机用途', evidence_ids:['E1']})) });
const response = (r, choices) => ({model:'jev-1.13.0',usage:{input_tokens:100,output_tokens:10},answers:Object.fromEntries(Object.keys(r.body.questions).map((id,i)=>[id,{type:'choice',choice:choices[i]??'yes',probabilities:{yes:choices[i]==='no'?0.1:choices[i]==='unknown'?0.1:0.8,no:choices[i]==='no'?0.8:0.1,unknown:choices[i]==='unknown'?0.8:0.1},confidence:0.8}]))});
test('binary rubric has explicit atomic IDs and all legacy parents remain represented', async()=>{
  assert.equal(rubric.version,'2.0.0');
  const parents = new Set(rubric.dimensions.flatMap(d=>d.checks.map(c=>c.parent_id)));
  assert.equal(parents.size,71);
  const b=await prepareReview(packet(),{readSource:async()=>source});
  for(const r of b.requests) for(const [id,q] of Object.entries(r.body.questions)){
    assert.deepEqual(Object.keys(q.criteria),['yes','no','unknown']);
    const c=rubric.dimensions.flatMap(d=>d.checks).find(c=>c.question_id===id);
    assert.ok(c?.parent_id && c.proposition && c.unknown_when && c.yes_when && c.no_when);
  }
});
test('first yes cannot hide subsequent no or unknown, and no supersedes unknown',async()=>{
  const b=await prepareReview(packet(),{readSource:async()=>source});const r=b.requests[0];
  assert.equal(validateResponse(response(r,['yes','no']),r).status,'change_needed');
  assert.equal(validateResponse(response(r,['yes','unknown']),r).status,'insufficient');
  assert.equal(validateResponse(response(r,['unknown','no']),r).status,'change_needed');
});
test('documented local non-applicability retains source and is never a model yes',async()=>{
  const p=packet();p.dimensions[0].applicability='not_applicable';
  const b=await prepareReview(p,{readSource:async()=>source});
  assert.equal(b.local_results[0].status,'not_applicable');
  assert.deepEqual(b.local_results[0].evidence_ids,['E1']);
  assert.equal(b.requests.some(r=>r.dimension_id===p.dimensions[0].id),false);
});
test('atomic non-applicability is sourced, excluded from provider questions and not counted yes',async()=>{
  const p=packet();p.dimensions.find(d=>d.id==='quality').check_applicability=Object.fromEntries(rubric.dimensions.find(d=>d.id==='quality').checks.filter(c=>c.parent_id==='quality_5').map(c=>[c.id,{status:'not_applicable',reason:'本地原件明确不包含AI',evidence_ids:['E1']}]));
  const b=await prepareReview(p,{readSource:async()=>source});const r=b.requests.find(r=>r.dimension_id==='quality');
  assert.equal(Object.keys(r.body.questions).some(id=>id.startsWith('quality_5_')),false);
  const result=validateResponse(response(r,[]),r);
  assert.equal(result.parent_results.find(p=>p.parent_id==='quality_5').status,'not_applicable');
  assert(r.question_contracts.every(c=>c.sources.every(s=>s.source_sha256)));
});
test('changed full source cannot send even when its quoted excerpt is unchanged',async()=>{
 const b=await prepareReview(packet(),{readSource:async()=>source+'\n原版本'});let calls=0;
 await assert.rejects(executeReview(b,{apiKey:'fixture',approvedSha:b.request_sha256,budgetUsd:1,readSource:async()=>source+'\n新版本',fetchImpl:async()=>{calls++;}}),/来源全文/);
 assert.equal(calls,0);
});
test('unknown applicability never passes and adequate upgrade alternatives preserve original OR',async()=>{
 const p=packet();p.dimensions[0].applicability='unknown';
 const b=await prepareReview(p,{readSource:async()=>source});
 assert.equal(validateResponse(response(b.requests[0],[]),b.requests[0]).status,'insufficient');
 const r=b.requests.find(r=>r.dimension_id==='maintenance');const raw=response(r,[]);
 for(const [id,a] of Object.entries(raw.answers))if(id.startsWith('maintenance_4_')){a.choice=id.endsWith('_2')?'yes':'no';a.probabilities=a.choice==='yes'?{yes:.8,no:.1,unknown:.1}:{yes:.1,no:.8,unknown:.1};}
 assert.equal(validateResponse(raw,r).parent_results.find(p=>p.parent_id==='maintenance_4').status,'supported');
});
