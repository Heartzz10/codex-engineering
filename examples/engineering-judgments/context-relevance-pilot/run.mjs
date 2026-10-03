import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {prepareContextRelevance,executeContextRelevance,verifyContextRelevanceSources,validateContextRelevanceResponse,contextRelevancePolicy} from '../../../src/context-relevance.mjs';
import {hash,invariant,atomicJson,withFileLedger,validateLedger,ledgerCost,requestKey,RESERVED_REQUEST_USD,resolveApiKey} from '../../../skills/review-product-plan/scripts/jev-client.mjs';
import {extractNativeWindow} from '../ui-copy-pilot/compare-jev-codex.mjs';
const pkg=JSON.parse(await fs.readFile(new URL('../../../package.json',import.meta.url),'utf8'));
const sha=x=>createHash('sha256').update(x).digest('hex');
const json=async file=>JSON.parse(await fs.readFile(file,'utf8'));
const writeNew=(file,value)=>fs.writeFile(file,JSON.stringify(value,null,2)+'\n',{flag:'wx'});
const stages=['preparation','extraction','provider','reading','failure','fallback','organization','summary'];
const abs=(base,file)=>path.resolve(base,file);
const same=(a,b)=>path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase();

export function validateReadingOutput(raw,candidates,order){
 let rows=raw;try{if(typeof raw==='string')rows=JSON.parse(raw);}catch{throw Error('output format / 格式无效；保留raw，不重答语义');}
 invariant(Array.isArray(rows)&&rows.length<=candidates.length,'output format / 格式数量无效');
 const seen=new Set();let prior=-1;
 for(const r of rows){invariant(r&&typeof r.id==='string'&&!seen.has(r.id)&&typeof r.quote==='string'&&typeof r.limitations==='string','output format / 格式无效');seen.add(r.id);
  const index=order.indexOf(r.id);invariant(index>prior,'reading order / 顺序无效');prior=index;
  const c=candidates.find(c=>c.id===r.id);invariant(c&&r.quote.trim()&&c.quote.includes(r.quote),'quote / 引文不匹配');
 }
 return rows;
}
export async function collectNativeWindows(configs=[],settings){
 if(!configs.length)return {status:'unknown',tokens:null,windows:[]};
 const windows=[];
 for(const c of configs){const r=await extractNativeWindow({file:c.journal,sessionId:c.session_id,startResponseId:c.start_response_id??null,endResponseId:c.end_response_id,scope:c.scope,dedicatedSessionDeclaration:c.dedicated_session_declaration});
  invariant(r.modelConsistent&&r.model===settings.model&&r.effort===settings.effort,'native model / 模型或档位漂移');
  invariant(!windows.some(w=>w.sessionId===r.sessionId&&(w.scope==='dedicated_session'||r.scope==='dedicated_session'||Date.parse(w.receiptTimestamps.start)<Date.parse(r.receiptTimestamps.end)&&Date.parse(r.receiptTimestamps.start)<Date.parse(w.receiptTimestamps.end))),'native windows overlap / 不重复相加');
  windows.push({...r,arm:c.arm,task_id:c.task_id,stage:c.stage});
 }
 return {status:'observed_scope_review_required',tokens:windows.reduce((n,w)=>n+w.codexTokens.total,0),windows};
}
async function loadProtocol(file){
 const bytes=await fs.readFile(file),p=JSON.parse(bytes),base=path.dirname(file);
 invariant(p.schema_version===1&&typeof p.study_id==='string'&&Number.isFinite(Date.parse(p.frozen_at))&&['Q','E'].includes(p.phase),'invalid frozen protocol');
 invariant(p.codex?.model==='gpt-6.1-sol'&&p.codex.effort==='high','模型或档位不符合冻结');
 invariant(p.software?.package_version===pkg.version&&p.software.standard_sha256===hash(contextRelevancePolicy),'software/model/标准漂移');
 invariant(p.authorization?.provider==='TypeSafe Jev'&&p.authorization.scope_ref&&p.authorization.material_scopes.every(s=>['public','synthetic'].includes(s)),'外发必须明确public/synthetic已有授权');
 const caps={Q:{requests:8,usd:.025},E:{requests:20,usd:.06},total:{requests:28,usd:.085}};
 for(const key of Object.keys(caps))for(const metric of ['requests','usd'])invariant(Number.isFinite(p.limits?.[key]?.[metric])&&p.limits[key][metric]>0&&p.limits[key][metric]<=caps[key][metric],'累计limit超过授权');
 invariant(p.limits.automatic_retries===0&&p.completion_rule&&Array.isArray(p.batches)&&p.batches.length>0,'无重试协议和完成条件缺失');
 const ids=p.batches.map(b=>b.id);invariant(new Set(ids).size===ids.length&&ids.every(id=>/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(id)),'batch ID无效');
 for(const b of p.batches)invariant(sha(await fs.readFile(abs(base,b.packet_file)))===b.packet_sha256,'packet来源漂移');
 const ref=p.phase==='Q'?p.quality_reference:p.quality_gate;invariant(ref?.file&&sha(await fs.readFile(abs(base,ref.file)))===ref.sha256,'参考或Q gate来源漂移');
 if(p.phase==='Q')invariant(p.batches.length===8,'Q必须一次冻结完整八例');
 if(p.phase==='E')validateWorkflow(p.workflow);
 return {p,base,protocol_sha256:sha(bytes),file};
}
function validateWorkflow(workflow){
 invariant(workflow&&Array.isArray(workflow.tasks)&&workflow.tasks.length===2,'E必须两项不同来源且确有阅读负担的冻结任务');
 invariant(new Set(workflow.tasks.map(t=>t.source_group)).size===2,'E独立来源组不足');
 for(const t of workflow.tasks){invariant(t.candidate_ids?.length>=6&&t.candidate_ids.length<=10&&new Set(t.candidate_ids).size===t.candidate_ids.length,'E候选数量/阅读负担不足');
  invariant(t.A?.reading_rule&&typeof t.A.comparable==='boolean','A原规则独立冻结，不可比须明确');
  for(const arm of ['B','C']){const a=t[arm];invariant(a?.session_rule==='one_dedicated_session'&&a.continuation_rule==='explicit_session_id_new_material_only'&&a.initial_count===5&&Array.isArray(a.order)&&hash([...a.order].sort())===hash([...t.candidate_ids].sort()),'B/C同候选同数量和明确接续规则缺失');}
  invariant(Array.isArray(t.mandatory_materials)&&Array.isArray(t.mandatory_checks)&&t.completion_rule&&t.expand_rule,'必读/检查/完成/扩读不能隐藏');
 }
}
function scoreBatches(prepared,runs,reference,ledger){
 const rows=[];let complete=true,live=true,critical=false;
 if(reference.reference_kind!=='independent_agent_not_human_gold'||!Array.isArray(runs)||runs.length!==prepared.batches.length||new Set(runs.map(r=>r.batch_id)).size!==runs.length)complete=false;
 for(const b of prepared.batches){const run=runs.find(r=>r.batch_id===b.id)?.result;
  if(!run||run.status!=='validation_completed'||run.uncertain_charge||!run.source_valid||run.plan_sha256!==b.bundle.plan_sha256||run.request_sha256!==b.bundle.request_sha256||(run.standard_sha256!==undefined&&run.standard_sha256!==b.bundle.standard_sha256)||run.results?.length!==b.bundle.requests.length)complete=false;
  if(run?.evidence_kind!=='provider_response')live=false;
  for(const request of b.bundle.requests){const ref=reference.cases.find(c=>c.batch_id===b.id&&c.candidate_id===request.candidate_id);
   const result=run?.results?.find(r=>r.candidate_id===request.candidate_id);let validated=null;
   try{validated=validateContextRelevanceResponse(result?.raw_response,request);}catch{complete=false;}
   const key=requestKey(request,b.bundle.standard_sha256,b.bundle.plan_sha256),cache=ledger?.cache?.[key],entry=ledger?.entries?.find(e=>e.id===cache?.source_entry);
   const bound=cache?.evidence_kind==='provider_response'&&cache.model===b.bundle.model&&cache.standard_sha256===b.bundle.standard_sha256&&cache.request_sha256===hash(request.body)&&entry?.status==='completed'&&entry.evidence_kind==='provider_response'&&entry.request_key===key&&hash(cache.raw_response)===hash(result?.raw_response??null)&&['live','cache'].includes(result?.origin);
   if(!bound){complete=false;live=false;}
   const answerMap=new Map((validated?.answers??[]).map(a=>[a.criterion_id,a]));
   for(const id of Object.keys(request.body.questions)){const a=answerMap.get(id),expected=ref?.expected?.[id],effective=validated?.facts?.find(f=>f.question_id===id);
    invariant(['yes','no','unknown'].includes(expected),'独立参考题组缺失');
    const effectiveChoice=effective?.choice??null;
    const correct=!!a&&a.provider_choice===expected&&effectiveChoice===expected;
    const unsafe=!!a&&((expected!=='yes'&&a.provider_choice==='yes')||(expected==='yes'&&a.provider_choice==='no')||(expected==='unknown'&&a.provider_choice==='no'));
    critical ||= unsafe;rows.push({batch_id:b.id,candidate_id:request.candidate_id,question_id:id,expected,provider_choice:a?.provider_choice??null,effective_choice:effectiveChoice,confidence:a?.confidence??null,correct,critical:unsafe,reason:effective?.reason??(!a?'missing_answer':null)});
   }
  }
 }
 const passed=complete&&live&&prepared.batches.length===8&&rows.every(r=>r.correct);
 return {passed,complete,evidence_kind:live?'provider_response':'adapter_fixture',questions:rows.length,correct:rows.filter(r=>r.correct).length,critical,rows,reference_kind:reference.reference_kind,qualification:false};
}
async function readPrepared(info){
 const f=abs(info.base,info.p.prepared_dir),prepared=await json(path.join(f,'prepared.json'));
 invariant(prepared.protocol_sha256===info.protocol_sha256,'prepared协议漂移');
 invariant(Array.isArray(prepared.batches)&&prepared.batches.length===info.p.batches.length,'prepared batch / 准备包批次数改变');
 for(let i=0;i<prepared.batches.length;i++){
  const b=prepared.batches[i],frozen=info.p.batches[i],file=abs(info.base,frozen.packet_file);
  invariant(b.id===frozen.id&&b.packet_sha256===frozen.packet_sha256&&same(b.packet_file,file),'prepared batch / 准备包身份改变');
  const current=await prepareContextRelevance(await json(file),{baseDir:path.dirname(file)});
  const stable=({created_at,...rest})=>rest;
  invariant(hash(stable(b.bundle))===hash(stable(current)),'prepared bundle / 来源或准备包请求候选身份改变');
  await verifyContextRelevanceSources(b.bundle);
 }
 return prepared;
}
async function validateQGate(info){
 const gateFile=abs(info.base,info.p.quality_gate.file),gate=await json(gateFile);
 invariant(gate.quality?.passed===true&&gate.protocol_file&&gate.run_dir,'Q未完整通过，不进入E');
 const qInfo=await loadProtocol(gate.protocol_file);invariant(qInfo.p.phase==='Q'&&qInfo.p.study_id===info.p.study_id&&same(abs(qInfo.base,qInfo.p.ledger_file),abs(info.base,info.p.ledger_file)),'E不能借其他study或账本的Q');
 const qPrepared=await readPrepared(qInfo),reference=await json(abs(qInfo.base,qInfo.p.quality_reference.file));
 const rawBytes=await fs.readFile(path.join(abs(qInfo.base,qInfo.p.run_dir),'run.json')),raw=JSON.parse(rawBytes),ledger=await json(abs(qInfo.base,qInfo.p.ledger_file));validateLedger(ledger);
 invariant(gate.protocol_sha256===qInfo.protocol_sha256&&same(gate.run_dir,abs(qInfo.base,qInfo.p.run_dir))&&gate.run_sha256===sha(rawBytes),'Q gate与原运行身份不匹配');
 invariant(raw.status==='completed'&&!raw.uncertain_charge&&raw.protocol_sha256===qInfo.protocol_sha256&&raw.study_id===qInfo.p.study_id&&ledger.pilot?.protocols?.Q===qInfo.protocol_sha256,'Q运行或账本身份不匹配');
 invariant(!ledger.entries.some(e=>e.status!=='completed')&&scoreBatches(qPrepared,raw.runs,reference,ledger).passed,'Q原回执重新核验未通过');
}

export async function runPilot(args,dependencies={}){
 const {values,positionals}=parseArgs({args,allowPositionals:true,options:{protocol:{type:'string'},out:{type:'string'},'key-config':{type:'string'}}});
 const command=positionals[0];invariant(['prepare','run','collect'].includes(command)&&positionals.length===1&&values.protocol&&values.out,'prepare|run|collect --protocol FILE --out NEW_DIR');
 const info=await loadProtocol(path.resolve(values.protocol)),{p,base}=info,out=path.resolve(values.out),start=Date.now();
 invariant(!same(out,path.dirname(info.file))&&!same(out,abs(base,p.ledger_file)),'输出不得覆盖协议或账本');
 await fs.mkdir(out);
 if(command==='prepare'){
  invariant(same(out,abs(base,p.prepared_dir)),'prepare out需匹配冻结prepared_dir');
  const batches=[];for(const b of p.batches){const file=abs(base,b.packet_file),bundle=await prepareContextRelevance(await json(file),{baseDir:path.dirname(file)});batches.push({id:b.id,packet_file:file,packet_sha256:b.packet_sha256,bundle});}
  const prepared={schema_version:1,protocol_sha256:info.protocol_sha256,protocol_file:info.file,batches,prepared_at:new Date().toISOString(),local_prepare_ms:Date.now()-start,candidate_ids:batches.flatMap(b=>b.bundle.candidates.map(c=>c.id)),production_enabled:false};
  await writeNew(path.join(out,'prepared.json'),prepared);return {status:'prepared',batches:batches.length,request_count:batches.reduce((n,b)=>n+b.bundle.request_count,0),provider_calls:0};
 }
 const prepared=await readPrepared(info);
 if(command==='run'){
  invariant(same(out,abs(base,p.run_dir)),'run out需匹配冻结run_dir');if(p.phase==='E')await validateQGate(info);
  const reference=p.phase==='Q'?await json(abs(base,p.quality_reference.file)):null,ledgerFile=abs(base,p.ledger_file);await fs.mkdir(path.dirname(ledgerFile),{recursive:true});
  const report={schema_version:1,study_id:p.study_id,phase:p.phase,protocol_file:info.file,protocol_sha256:info.protocol_sha256,started_at:new Date().toISOString(),status:'running',attempts:0,runs:[],events:[],production_enabled:false};
  const reportFile=path.join(out,'run.json');await writeNew(reportFile,report);const save=()=>atomicJson(reportFile,report);
  const result=await (dependencies.withFileLedger??withFileLedger)(ledgerFile,async(ledger,saveLedger)=>{
   validateLedger(ledger);
   if(ledger.entries.some(e=>['reserved','uncertain'].includes(e.status))){report.status='recovery_required';report.cumulative_budget_used_usd=ledgerCost(ledger);report.reason='charge_unresolved';await save();return report;}
   invariant(ledger.entries.length<p.limits.total.requests,'累计请求limit已达到，不创建新ledger绕过');
   invariant(ledger.pilot||ledger.entries.length===0,'历史账本缺少阶段phase ownership，不能重置阶段计数');
   const meta=ledger.pilot??{study_id:p.study_id,limits_sha256:hash(p.limits),protocols:{},phase_entries:{Q:[],E:[]}};
   invariant(meta.study_id===p.study_id&&meta.limits_sha256===hash(p.limits),'账本study或累计限额改变');
   const phaseIds=[...(meta.phase_entries?.Q??[]),...(meta.phase_entries?.E??[])];
   invariant(Array.isArray(meta.phase_entries?.Q)&&Array.isArray(meta.phase_entries?.E)&&phaseIds.length===ledger.entries.length&&new Set(phaseIds).size===phaseIds.length&&phaseIds.every(id=>ledger.entries.some(e=>e.id===id)),'历史账本阶段phase ownership不完整');
   invariant(!meta.protocols[p.phase]||meta.protocols[p.phase]===info.protocol_sha256,'同阶段不能换题/协议重启');meta.protocols[p.phase]=info.protocol_sha256;ledger.pilot=meta;await saveLedger(ledger);
   const stageCount=()=>meta.phase_entries[p.phase].length;
   const stageCost=()=>ledger.entries.filter(e=>meta.phase_entries[p.phase].includes(e.id)).reduce((n,e)=>n+(e.status==='completed'?e.estimated_cost_usd:e.reserved_cost_usd),0);
   for(const batch of prepared.batches){
    await verifyContextRelevanceSources(batch.bundle);
    const needed=batch.bundle.requests.filter(r=>{const key=requestKey(r,batch.bundle.standard_sha256,batch.bundle.plan_sha256),cache=ledger.cache[key];return !cache||cache.evidence_kind!=='provider_response'||!ledger.entries.some(e=>e.id===cache.source_entry&&e.status==='completed'&&e.request_key===key&&e.evidence_kind==='provider_response');}).length;
    invariant(stageCount()+needed<=p.limits[p.phase].requests&&ledger.entries.length+needed<=p.limits.total.requests,'累计阶段/总请求limit不足');
    invariant(stageCost()+needed*RESERVED_REQUEST_USD<=p.limits[p.phase].usd&&ledgerCost(ledger)+needed*RESERVED_REQUEST_USD<=p.limits.total.usd,'累计阶段/总预算不足');
    const prior=new Set(ledger.entries.map(e=>e.id));
    const recordLedger=async current=>{for(const e of current.entries)if(!prior.has(e.id)&&!meta.phase_entries[p.phase].includes(e.id))meta.phase_entries[p.phase].push(e.id);current.pilot=meta;await saveLedger(current);};
    const callStart=Date.now(),rawFile=path.join(out,`${batch.id}.raw.json`);
    const row=await executeContextRelevance(batch.bundle,{purpose:'validation',approvedSha:batch.bundle.plan_sha256,budgetUsd:Math.min(p.limits.total.usd,ledgerCost(ledger)+Math.max(0,p.limits[p.phase].usd-stageCost())),maxRequests:Math.min(p.limits.total.requests,ledger.entries.length+Math.max(0,p.limits[p.phase].requests-stageCount())),ledger,saveLedger:recordLedger,save:value=>atomicJson(rawFile,value),apiKey:dependencies.apiKey,readApiKey:dependencies.readApiKey??(()=>resolveApiKey(values['key-config']?{configPath:path.resolve(values['key-config'])}:{})),...(dependencies.fetchImpl?{fetchImpl:dependencies.fetchImpl}:{}),useCache:true});
    report.runs.push({batch_id:batch.id,result:row});report.attempts+=row.attempts;report.events.push({stage:'provider',batch_id:batch.id,elapsed_ms:Date.now()-callStart,attempts:row.attempts});await save();
    if(row.status!=='validation_completed'||row.uncertain_charge){report.status='stopped';report.reason=row.reason??row.failure_code??'invalid_or_unknown_charge';break;}
    if(reference&&scoreBatches({...prepared,batches:[batch]},[{batch_id:batch.id,result:row}],reference,ledger).critical){report.status='quality_stopped';report.reason='critical_quality_error';break;}
   }
   if(report.status==='running')report.status='completed';report.cumulative_budget_used_usd=ledgerCost(ledger);report.cumulative_attempts=ledger.entries.length;report.estimated_cost_usd=report.runs.reduce((n,r)=>n+(r.result.estimated_cost_usd??0),0);report.uncertain_charge=ledger.entries.some(e=>e.status!=='completed');return report;
  });result.finished_at=new Date().toISOString();result.run_window_ms=Date.now()-start;await save();return result;
 }
 const rawBytes=await fs.readFile(path.join(abs(base,p.run_dir),'run.json')),raw=JSON.parse(rawBytes);
 invariant(raw.protocol_sha256===info.protocol_sha256&&raw.study_id===p.study_id&&raw.phase===p.phase,'运行身份不符合冻结协议');
 const ledger=await json(abs(base,p.ledger_file));validateLedger(ledger);
 const reference=p.phase==='Q'?await json(abs(base,p.quality_reference.file)):null;
 const quality=reference?scoreBatches(prepared,raw.runs,reference,ledger):{passed:false,reason:'E质量需独立业务引用审查，原生窗口不代表质量'};
 if(raw.status!=='completed'||raw.uncertain_charge||ledger.entries.some(e=>e.status!=='completed')){quality.passed=false;quality.complete=false;}
 let measurement=null;try{measurement=await json(abs(base,p.measurement_file));}catch(e){if(e.code!=='ENOENT')throw e;}
 const native=await collectNativeWindows(measurement?.native_windows??[],p.codex);
 const intervals=measurement?.stages??[];const completeCost=measurement?.complete===true&&stages.every(s=>intervals.some(e=>e.stage===s&&Number.isFinite(e.elapsed_ms)&&e.elapsed_ms>=0))&&measurement?.whole_window&&Number.isFinite(measurement.whole_window.started_ms)&&Number.isFinite(measurement.whole_window.finished_ms)&&measurement.whole_window.finished_ms>=measurement.whole_window.started_ms;
 const reading=[];for(const r of measurement?.reading_outputs??[]){const bytes=await fs.readFile(r.file,'utf8');await fs.writeFile(path.join(out,`${r.task_id}-${r.arm}.raw.txt`),bytes,{flag:'wx'});try{reading.push({task_id:r.task_id,arm:r.arm,status:'valid',rows:validateReadingOutput(bytes,r.candidates,r.order)});}catch(e){reading.push({task_id:r.task_id,arm:r.arm,status:'invalid',error:e.message});}}
 const report={schema_version:1,protocol_file:info.file,protocol_sha256:info.protocol_sha256,phase:p.phase,run_dir:abs(base,p.run_dir),quality,metrics:{codex_tokens:native.tokens,whole_workflow_ms:completeCost?measurement.whole_window.finished_ms-measurement.whole_window.started_ms:null,native,stages:intervals,known_provider_ms:raw.events.reduce((n,e)=>n+e.elapsed_ms,0),known_prepare_ms:prepared.local_prepare_ms,provider_estimated_usd:raw.estimated_cost_usd??null,provider_reserved_or_estimated_usd:raw.cumulative_budget_used_usd??null,invoice_usd:null,shared_one_time:measurement?.shared_one_time??null},reading,comparisons:{A_to_B:null,B_to_C:null,A_to_C:null,reason:'需相同任务/模型/完整各臂窗和独立质量判定；缺项不分摊父窗、不推算净收益'},production_enabled:false,qualification:false,limits:['代理参考不是人工金标；Q筛查不代替20+60或文案资格。','原始格式/顺序错误保留raw，不能让模型重答整批语义。','子集不重复相加，native窗范围仍需审查，缺完整阶段记未知。']};
 report.run_sha256=sha(rawBytes);
 await writeNew(path.join(out,'collection.json'),report);return report;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){try{console.log(JSON.stringify(await runPilot(process.argv.slice(2))));}catch(e){console.error(e.message);process.exitCode=2;}}
