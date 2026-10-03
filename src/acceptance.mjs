import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { existingInside, within, DEFAULT_STATE } from './paths.mjs';
import { parseStrictJson } from './feature-store.mjs';
import { assessUIQualityCoverage, prepareUIQuality } from './ui-quality.mjs';

const text = x => typeof x === 'string' && x.trim().length > 0;
const sha = x => crypto.createHash('sha256').update(x).digest('hex');
const kinds = ['baseline','ui','api','cli','background'];
function requireThat(ok, code) { if (!ok) throw new Error(code); }
function idsForChange(map, changeId) {
  if (!changeId) return map.acceptanceCriteria.map(a=>a.id);
  const change=map.changes.find(c=>c.id===changeId);
  requireThat(change,'unknown_change');
  return [...new Set([...(change.acIds||change.acceptanceCriteriaIds||[]),...map.acceptanceCriteria.filter(a=>(change.featureIds||[]).includes(a.featureId)).map(a=>a.id)])];
}
function contract(ac,target) {
  return structuredClone({verificationMethod:ac.verificationMethod,preconditions:ac.preconditions||[],expected:ac.expected||null,dependencyRefs:ac.dependencyRefs||[],actions:target.actions||ac.actions,assertions:target.assertions||ac.assertions,effects:target.effects||ac.effects,requiredEvidenceTypes:ac.requiredEvidenceTypes||['execution'],implementationRefs:ac.implementationRefs||[],target});
}
function routeFor(profile,ac,target) {
  const routes=(profile.acceptanceRoutes||[]).filter(r=>r.kind===ac.verificationMethod && (r.entrypointIds||[]).includes(target.entrypointId));
  const candidates=routes.filter(r=>r.available===true && r.real===true && text(r.driverRef));
  if (!candidates.length) return {status:'unsupported_route',reasons:['No available real project driver for this method and entrypoint']};
  const checked=candidates.map(route=>{
    const reasons=[],e=route.effects,g=route.guards||{};
    if (!text(route.authorizationRef)) reasons.push('authorizationRef missing');
    if (!e || !['none','test-artifacts','business-data'].includes(e.writes) || typeof e.network!=='boolean' || typeof e.paid!=='boolean') reasons.push('explicit effects missing');
    const expected=target.effects||ac.effects;
    const writeRanks={'none':0,'test-artifacts':1,'business-data':2};
    if(!expected || !Object.hasOwn(writeRanks,expected.writes) || typeof expected.network!=='boolean' || typeof expected.paid!=='boolean') reasons.push('AC effects contract missing');
    if(expected && (writeRanks[e?.writes]<writeRanks[expected.writes] || (expected.network&&!e?.network) || (expected.paid&&!e?.paid))) reasons.push('route underreports required effects');
    if (e?.writes==='business-data' && (!text(g.permissionRef)||!text(g.isolationRef))) reasons.push('business write permission/isolation guard missing');
    if (e?.paid && !text(g.budgetRef)) reasons.push('enforced provider budget guard missing');
    // A baseline wrapper never represents business execution even when the profile adds guard labels.
    if (route.kind==='baseline' && (e?.paid||e?.writes==='business-data')) reasons.push('baseline runner cannot enforce these business effects');
    return {status:reasons.length?'blocked_guard':'ready',route,reasons};
  });
  return checked.find(r=>r.status==='ready')||checked[0];
}
export function planAcceptance(profile,map,changeId) {
  requireThat(map.projectId===profile.id,'project_mismatch');
  const targets=[];
  for (const id of idsForChange(map,changeId)) {
    const ac=map.acceptanceCriteria.find(a=>a.id===id); requireThat(ac,'unknown_ac');
    for (const target of ac.requiredTargets||[]) {
      const route=routeFor(profile,ac,target);
      targets.push({acId:ac.id,acRevision:ac.revision,...target,...route,actions:target.actions||ac.actions,assertions:target.assertions||ac.assertions,sideEffects:route.route?.effects||null});
    }
  }
  const uiQuality=profile.uiQuality?prepareUIQuality(profile.uiQuality):{status:'not_configured',limits:'New UI coverage is not configured; old acceptance contract only.'};
  return {projectId:profile.id,changeId:changeId||null,status:targets.length&&targets.every(t=>t.status==='ready')?'ready':'blocked',targets,uiQuality,executesActions:false};
}
function pointer(value,p) {
  requireThat(typeof p==='string' && (p===''||p.startsWith('/')),'invalid_assertion_pointer');
  for(const part of p===''?[]:p.slice(1).split('/').map(x=>x.replace(/~1/g,'/').replace(/~0/g,'~'))) {
    if (value===null || typeof value!=='object' || !Object.hasOwn(value,part)) return undefined;
    value=value[part];
  }
  return value;
}
async function checkFingerprint(profile,ac,evidence) {
  const refs=ac.implementationRefs||[];
  requireThat(refs.length>0 && refs.every(r=>text(r.path)),'implementation_scope_missing');
  const entries=evidence.implementationFingerprint;
  requireThat(Array.isArray(entries)&&entries.length>0,'fingerprint_missing');
  requireThat(new Set(entries.map(r=>r.path)).size===entries.length,'fingerprint_duplicate');
  const scope=[...refs,...(ac.dependencyRefs||[]),...(profile.environmentFiles||[]),...(profile.uiQualityRef?[profile.uiQualityRef]:[])].map(r=>typeof r==='string'?r:r.path).filter(Boolean);
  for(const file of scope) requireThat(entries.some(e=>e.path===file),'fingerprint_scope_missing');
  for(const item of entries) {
    requireThat(/^[a-f0-9]{64}$/.test(item.sha256),'fingerprint_hash_invalid');
    const file=await existingInside(profile.root,item.path);
    requireThat((await fs.stat(file)).isFile(),'fingerprint_requires_file');
    requireThat(sha(await fs.readFile(file))===item.sha256,'fingerprint_changed');
  }
}
export async function validateEvidence(profile,map,evidence) {
  requireThat(evidence && evidence.projectId===profile.id && map.projectId===profile.id,'project_mismatch');
  requireThat(!['stale','unavailable'].includes(evidence.applicability),'evidence_applicability_stale');
  const ac=map.acceptanceCriteria.find(a=>a.id===evidence.acId);
  requireThat(ac && ac.featureId===evidence.featureId,'unknown_ac_or_feature');
  requireThat(ac.revision===evidence.acRevision,'ac_revision_stale');
  requireThat(kinds.includes(evidence.method)&&evidence.method===ac.verificationMethod,'method_mismatch');
  requireThat(['tool_receipt','manual_attestation'].includes(evidence.observationSource),'observation_source_invalid');
  requireThat(text(evidence.runId)&&text(evidence.executedAt)&&Number.isFinite(Date.parse(evidence.executedAt)),'execution_identity_missing');
  requireThat(text(evidence.sourceRef)&&text(evidence.recordedBy)&&text(evidence.createdAt),'evidence_provenance_missing');
  requireThat(map.changes.some(c=>c.id===evidence.changeId),'unknown_change');
  requireThat(Array.isArray(evidence.targetIds)&&evidence.targetIds.length>0&&new Set(evidence.targetIds).size===evidence.targetIds.length,'target_ids_invalid');
  requireThat(Array.isArray(evidence.rawEvidence)&&evidence.rawEvidence.length>0,'raw_evidence_required');
  await checkFingerprint(profile,ac,evidence);
  requireThat(text(profile.featureMapRef?.evidenceDir),'evidence_directory_missing');
  const evidenceRoot=await existingInside(profile.root,profile.featureMapRef.evidenceDir);
  const receipts=[];
  for(const ref of evidence.rawEvidence) {
    const file=await existingInside(profile.root,ref.path);
    requireThat(within(evidenceRoot,file)&&file!==evidenceRoot,'evidence_path_outside_scope');
    const stat=await fs.stat(file); requireThat(stat.isFile()&&stat.size<=10*1024*1024,'raw_evidence_file_invalid');
    const bytes=await fs.readFile(file);
    requireThat(/^[a-f0-9]{64}$/.test(ref.sha256)&&sha(bytes)===ref.sha256,'raw_evidence_hash_mismatch');
    if(ref.type==='execution') receipts.push(parseStrictJson(bytes.toString('utf8')));
  }
  for(const type of ac.requiredEvidenceTypes||['execution']) requireThat(evidence.rawEvidence.some(r=>r.type===type),'required_evidence_type_missing');
  requireThat(receipts.length>0,'execution_observation_required');
  const observations=[];
  for(const receipt of receipts) {
    for(const field of ['projectId','acId','acRevision','runId','method','observationSource','executedAt']) requireThat(receipt[field]===evidence[field],`receipt_${field}_mismatch`);
    requireThat(isDeepStrictEqual(receipt.implementationFingerprint,evidence.implementationFingerprint),'receipt_fingerprint_mismatch');
    requireThat(receipt.example!==true && receipt.simulation!==true,'example_evidence_rejected');
    if(receipt.observationSource==='manual_attestation') requireThat(text(receipt.attestation?.by)&&text(receipt.attestation?.sourceRef)&&text(receipt.attestation?.basis),'manual_attestation_source_missing');
    requireThat(Array.isArray(receipt.observations),'execution_observation_required');
    observations.push(...receipt.observations);
  }
  const targetResults=[],contracts=[];
  for(const targetId of evidence.targetIds) {
    const target=ac.requiredTargets.find(t=>t.targetId===targetId); requireThat(target,'unknown_target');
    const matches=observations.filter(o=>o.targetId===targetId); requireThat(matches.length===1,'target_observation_missing_or_duplicate');
    const o=matches[0];
    for(const field of ['entrypointId','roleRef','environmentRef','dataScopeRef']) requireThat(text(target[field])&&o[field]===target[field],'target_context_mismatch');
    const contexts=ac.requiredTargets.filter(t=>evidence.targetIds.includes(t.targetId));
    for(const field of ['roleRef','environmentRef','dataScopeRef']) {
      const expected=new Set(contexts.map(t=>t[field]));
      requireThat(evidence[field]===(expected.size===1?[...expected][0]:'multiple'),'evidence_context_mismatch');
    }
    const route=routeFor(profile,ac,target); requireThat(route.status==='ready',route.status);
    const c=contract(ac,target); contracts.push({targetId,...c});
    requireThat(Array.isArray(c.actions)&&c.actions.length>0,'actions_contract_missing');
    requireThat(Array.isArray(o.actions)&&o.actions.every(a=>text(a.type)&&text(a.description)),'actual_actions_missing');
    // Required actions must occur in order; a screenshot alone cannot cover an input/submit flow.
    let position=0;
    for(const action of c.actions) {
      const found=o.actions.findIndex((a,i)=>i>=position&&a.type===action.type);
      requireThat(found>=0,`missing_action:${action.type}`); position=found+1;
    }
    requireThat(Array.isArray(c.assertions)&&c.assertions.length>0,'assertions_contract_missing');
    let status='passed'; const reasons=[],uncertainties=[],assertionResults=[];
    if(c.actions.some(a=>a.type==='wait')) {
      requireThat(text(o.wait?.signal)&&['completed','timed_out','failed'].includes(o.wait?.status),'wait_observation_missing');
      if(o.wait.status!=='completed') { status='failed'; reasons.push(`wait_${o.wait.status}`); }
    }
    for(const assertion of c.assertions) {
      let passed=false;
      if(assertion.operator==='manual') {
        const j=(o.judgments||[]).find(j=>j.assertionId===assertion.id);
        requireThat(j&&text(j.by)&&text(j.sourceRef)&&text(j.basis)&&Array.isArray(j.uncertainties)&&typeof j.result==='boolean','manual_judgment_source_missing');
        uncertainties.push(...j.uncertainties); passed=j.result;
        assertionResults.push({assertionId:assertion.id,passed,judgmentSource:'manual_attestation',by:j.by,sourceRef:j.sourceRef,basis:j.basis,uncertainties:j.uncertainties});
      } else {
        const actual=pointer(o.actual,assertion.path);
        requireThat(['equals','equalsPath','includes'].includes(assertion.operator),'unsupported_assertion');
        const expected=assertion.operator==='equalsPath'?pointer(o.actual,assertion.expected):assertion.expected;
        passed=['equals','equalsPath'].includes(assertion.operator)?actual!==undefined&&expected!==undefined&&isDeepStrictEqual(actual,expected):typeof actual==='string'&&typeof expected==='string'?actual.includes(expected):Array.isArray(actual)&&actual.some(x=>isDeepStrictEqual(x,expected));
        assertionResults.push({assertionId:assertion.id,passed,actual:actual??null,expected:expected??null});
      }
      if(!passed) {status='failed';reasons.push(`assertion_failed:${assertion.id}`);}
    }
    if(uncertainties.length&&status==='passed') status='blocked';
    targetResults.push({targetId,status,reasons,assertionResults,uncertainties});
  }
  const uiQualityObservations=receipts.flatMap(r=>[...(r.uiQualityObservations||[]),...(r.observations||[]).flatMap(o=>o.uiQualityObservations||[])]);
  const uiQuality=profile.uiQuality?assessUIQualityCoverage(profile.uiQuality,uiQualityObservations,{acIds:[ac.id],targetIds:evidence.targetIds,ruleVersion:profile.uiQuality.ruleVersion,environmentRef:profile.environmentRef}):{status:'not_configured'};
  return {...structuredClone(evidence),result:summarize([...targetResults.map(t=>t.status),...(profile.uiQuality&&!['passed','not_applicable'].includes(uiQuality.status)?['blocked']:[])]),targetResults,uiQuality,uiQualityObservations,validation:{checkedAt:new Date().toISOString(),contracts,judgmentBoundary:'Files, recorded actions and declared assertions checked; tool provenance and business completeness require trusted executor review.'}};
}
function summarize(statuses) {
  if(!statuses.length) return 'not_run';
  return ['failed','blocked','stale','not_run'].find(s=>statuses.includes(s))||'passed';
}
async function carriedEvidence(profile,map,ac,target,carry) {
  requireThat(text(carry.equivalenceBasis)&&text(carry.sourceRef)&&text(carry.recordedBy),'carry_forward_basis_missing');
  const original=map.evidence.find(e=>e.id===carry.evidenceId);
  requireThat(original&&original.acId===carry.fromAcId&&original.acRevision===carry.fromAcRevision,'carry_forward_source_missing');
  requireThat(original.applicability!=='unavailable' && (original.applicability!=='stale'||original.invalidationReason==='acceptance_contract_changed'),'carry_forward_source_invalidated');
  const old=original.validation?.contracts?.find(c=>c.targetId===carry.fromTargetId);
  requireThat(old,'carry_forward_contract_missing');
  const current=contract(ac,target);
  for(const key of ['verificationMethod','preconditions','expected','dependencyRefs','actions','assertions','effects','implementationRefs','requiredEvidenceTypes']) requireThat(isDeepStrictEqual(old[key],current[key]),'carry_forward_contract_changed');
  for(const key of ['entrypointId','roleRef','environmentRef','dataScopeRef','scenario']) requireThat(old.target[key]===target[key],'carry_forward_target_changed');
  requireThat(isDeepStrictEqual(carry.currentVerification?.implementationFingerprint,original.implementationFingerprint),'carry_forward_current_fingerprint_missing');
  for(const key of ['roleRef','environmentRef','dataScopeRef']) requireThat(carry.currentVerification?.[key]===target[key],'carry_forward_current_context_missing');
  const oldAc={...ac,id:original.acId,featureId:original.featureId,revision:original.acRevision,...old,requiredTargets:[old.target]};
  const validated=await validateEvidence(profile,{...map,acceptanceCriteria:[oldAc]}, {...original,applicability:'current',roleRef:old.target.roleRef,environmentRef:old.target.environmentRef,dataScopeRef:old.target.dataScopeRef,targetIds:[carry.fromTargetId]});
  return validated.targetResults.find(t=>t.targetId===carry.fromTargetId);
}
export async function assessCoverage(profile,map,acIds,{includeUIQuality=true}={}) {
  requireThat(map.projectId===profile.id,'project_mismatch');
  const conditions=[],gaps=[],uncertainties=[],counts={passed:0,failed:0,blocked:0,stale:0,not_run:0};
  const validationCache=new Map();
  for(const id of [...new Set(acIds)]) {
    const ac=map.acceptanceCriteria.find(a=>a.id===id); requireThat(ac,'unknown_ac');
    const targets=[];
    for(const target of ac.requiredTargets||[]) {
      const candidates=(map.evidence||[]).filter(e=>e.acId===id&&(e.targetIds||[]).includes(target.targetId));
      const results=[];
      for(const e of candidates) {
        if(!validationCache.has(e)) validationCache.set(e,validateEvidence(profile,map,e).catch(error=>({error:error.message})));
        const validated=await validationCache.get(e);
        if(validated.error) results.push({status:'stale',reasons:[validated.error],evidenceId:e.id});
        else {const r=validated.targetResults.find(r=>r.targetId===target.targetId);results.push({...r,evidenceId:e.id,executedAt:e.executedAt,createdAt:e.createdAt,sequence:results.length});}
      }
      for(const carry of (map.carryForward||[]).filter(c=>c.toAcId===id&&c.toAcRevision===ac.revision&&c.toTargetId===target.targetId)) {
        try { results.push({...await carriedEvidence(profile,map,ac,target,carry),evidenceId:carry.evidenceId}); }
        catch(error) {results.push({status:'stale',reasons:[error.message],evidenceId:carry.evidenceId});}
      }
      // Latest valid execution governs. A newer failed rerun cannot be hidden by an older pass.
      const valid=results.filter(r=>r.status!=='stale').sort((a,b)=>
        Date.parse(b.executedAt||'1970')-Date.parse(a.executedAt||'1970') ||
        Date.parse(b.createdAt||'1970')-Date.parse(a.createdAt||'1970') ||
        (b.sequence??-1)-(a.sequence??-1));
      const route=routeFor(profile,ac,target);
      const selected=route.status!=='ready'?{status:'blocked',reasons:[route.status,...route.reasons]}:valid[0]||results[0]||{status:'not_run',reasons:['No current target observation']};
      const record={targetId:target.targetId,status:selected.status,evidenceIds:selected.evidenceId?[selected.evidenceId]:[],reasons:selected.reasons||[],uncertainties:selected.uncertainties||[]};
      targets.push(record); counts[record.status]++; uncertainties.push(...record.uncertainties);
      if(record.status!=='passed') gaps.push({acId:id,...record});
    }
    if(!targets.length) gaps.push({acId:id,status:'not_run',reasons:['required_targets_missing']});
    conditions.push({acId:id,acRevision:ac.revision,status:summarize(targets.map(t=>t.status)),targets});
  }
  let uiQuality={status:'not_assessed',limits:'Only exact acceptance targets were assessed; normal delivery still applies the full UI gate.'};
  if(includeUIQuality) {
    const uiObservations=[];
    // Quality observations must come from the same hash-checked executions. Never trust a summary in the map.
    // A receipt can remain current for one target while a newer receipt supersedes another.
    const selectedTargets=new Set(conditions.flatMap(c=>c.targets.flatMap(t=>t.evidenceIds.map(id=>JSON.stringify([c.acId,t.targetId,id])))));
    for(const [e,validatedPromise] of validationCache.entries()) {
      const validated=await validatedPromise;
      if(!validated.error) uiObservations.push(...(validated.uiQualityObservations||[]).filter(o=>o.acId===e.acId&&selectedTargets.has(JSON.stringify([o.acId,o.targetId,e.id]))));
    }
    uiQuality=profile.uiQuality?assessUIQualityCoverage(profile.uiQuality,uiObservations,{acIds,ruleVersion:profile.uiQuality.ruleVersion,environmentRef:profile.environmentRef}):{status:'not_configured',limits:'Old business contract only; new UI categories have not been verified.'};
    if(profile.uiQuality&&!['passed','not_applicable'].includes(uiQuality.status)) gaps.push({status:'blocked',code:'ui_quality_not_passed',reasons:[uiQuality.status],detail:uiQuality.gaps});
  }
  return {status:summarize([...conditions.map(c=>c.status),...(includeUIQuality&&profile.uiQuality&&!['passed','not_applicable'].includes(uiQuality.status)?['blocked']:[])]),conditions,counts,gaps,uncertainties,uiQuality,businessSemantics:'automatic_assertions_and_attributed_judgment_only'};
}
export async function assessDeliveryCoverage(profile,map,acIds,{stateRoot=DEFAULT_STATE}={}) {
  const assessment=await assessCoverage(profile,map,acIds);
  if(!profile.engineeringRulesRef)return assessment;
  const {assessEngineeringRules}=await import('./engineering-rules.mjs');
  const rules=await assessEngineeringRules(profile,{stateRoot,map});
  return {...assessment,status:['passed','not_applicable'].includes(rules.status)?assessment.status:assessment.status==='failed'?'failed':'blocked',engineeringRules:{status:rules.status,counts:rules.counts,configRef:rules.configRef,checks:rules.checks},gaps:[...assessment.gaps,...(!['passed','not_applicable'].includes(rules.status)?[{code:'engineering_rules_incomplete',status:rules.status}]:[])]};
}
export async function assessAcceptance(profile,map,changeId,options) {return assessDeliveryCoverage(profile,map,idsForChange(map,changeId),options);}
