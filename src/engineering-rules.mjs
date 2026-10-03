import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { assert, existingInside, json } from './paths.mjs';
import { parseStrictJson, readMap } from './feature-store.mjs';
import { runCheck, fingerprintCheck } from './runner.mjs';
import { assessCoverage } from './acceptance.mjs';

const catalogBytes = await fs.readFile(new URL('../catalog/engineering-rules.json', import.meta.url));
export const ENGINEERING_RULES = JSON.parse(catalogBytes);
const catalogHash = crypto.createHash('sha256').update(catalogBytes).digest('hex');
const text = value => typeof value === 'string' && !!value.trim();
const strings = value => Array.isArray(value) && value.every(text) && new Set(value).size === value.length;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
function only(item, fields, at) { assert(object(item), `${at}: object required`); for (const key of Object.keys(item)) assert(fields.includes(key), `${at}.${key}: unknown field`); }
const refPath = ref => ref.split('#')[0];

export async function loadEngineeringRules(profile) {
  if (profile.engineeringRulesRef === undefined) return { status:'not_configured', config:null };
  const file = await existingInside(profile.root, profile.engineeringRulesRef);
  const config = parseStrictJson(await fs.readFile(file, 'utf8'));
  only(config, ['schemaVersion','ruleVersion','domains','ruleApplicability','bindings'], 'engineeringRules');
  assert(config.schemaVersion === 1 && config.ruleVersion === ENGINEERING_RULES.ruleVersion, 'Unsupported engineering rule version');
  assert(Array.isArray(config.domains) && Array.isArray(config.bindings), 'Rule domains/bindings required');
  const domainIds = new Set(), ruleIds = new Set(), ruleApplicability = new Map(), checkInputs = {};
  const reference = async ref => {
    assert(text(ref), 'Rule reference required');
    const target = await existingInside(profile.root, refPath(ref));
    assert((await fs.stat(target)).isFile(), 'Rule reference must identify a file');
  };
  for (const domain of config.domains) {
    only(domain, ['domain','applicability','reason','sourceRef'], 'domain');
    assert(ENGINEERING_RULES.domains.includes(domain.domain) && !domainIds.has(domain.domain), 'Unknown or duplicate domain');
    domainIds.add(domain.domain);
    assert(['applicable','not_applicable','unknown'].includes(domain.applicability) && text(domain.reason), 'Domain applicability/reason required');
    await reference(domain.sourceRef);
  }
  assert(ENGINEERING_RULES.domains.every(id => domainIds.has(id)), 'All eight domain applicability decisions required');
  assert(config.ruleApplicability === undefined || Array.isArray(config.ruleApplicability), 'ruleApplicability must be an array');
  for (const choice of config.ruleApplicability || []) {
    only(choice, ['ruleId','applicability','reason','sourceRef'], 'ruleApplicability');
    const rule = ENGINEERING_RULES.rules.find(item => item.id === choice.ruleId);
    assert(rule && !ruleApplicability.has(rule.id), 'Unknown or duplicate rule applicability');
    assert(['applicable','not_applicable','unknown'].includes(choice.applicability) && text(choice.reason), 'Rule applicability/reason required');
    assert(config.domains.find(item => item.domain === rule.domain).applicability !== 'not_applicable' || choice.applicability === 'not_applicable', 'Rule applicability contradicts non-applicable domain');
    await reference(choice.sourceRef);
    ruleApplicability.set(rule.id,choice);
  }
  for (const binding of config.bindings) {
    only(binding, ['ruleId','implementationRefs','decisionRefs','checkIds','acIds','adapterStatus','exception'], 'binding');
    const rule = ENGINEERING_RULES.rules.find(rule => rule.id === binding.ruleId);
    assert(rule && !ruleIds.has(rule.id), 'Unknown or duplicate ruleId'); ruleIds.add(rule.id);
    assert(config.domains.find(d => d.domain === rule.domain).applicability !== 'not_applicable' && ruleApplicability.get(rule.id)?.applicability !== 'not_applicable', 'Binding contradicts non-applicable rule or domain');
    for (const field of ['implementationRefs','decisionRefs','checkIds','acIds']) assert(strings(binding[field]), `${field}: unique string array required`);
    assert(binding.adapterStatus === undefined || ['available','unsupported'].includes(binding.adapterStatus), 'Invalid adapterStatus');
    for (const ref of [...binding.implementationRefs, ...binding.decisionRefs]) await reference(ref);
    for (const checkId of binding.checkIds) {
      assert(profile.checks.some(c => c.id === checkId), 'Rule check must be registered in existing profile');
      checkInputs[checkId] = [...new Set([...(checkInputs[checkId] || []), profile.engineeringRulesRef, ...binding.implementationRefs.map(refPath), ...binding.decisionRefs.map(refPath), ...config.domains.map(d => refPath(d.sourceRef)), ...(config.ruleApplicability || []).map(choice => refPath(choice.sourceRef))])];
    }
    if (binding.exception !== undefined) {
      only(binding.exception, ['reason','sourceRef','expiresAt'], 'exception');
      assert(text(binding.exception.reason) && Number.isFinite(Date.parse(binding.exception.expiresAt)), 'Exception reason/expiry required');
      await reference(binding.exception.sourceRef);
    }
  }
  return {status:'configured',config,configPath:file,checkInputs,catalogHash};
}

async function configuration(profile) {
  const loaded = await loadEngineeringRules(profile);
  return { ...profile, engineeringRules:loaded.config, engineeringRuleInputs:loaded.checkInputs || {}, engineeringCatalogHash:loaded.catalogHash || null };
}

function selectedRules(config, scope) {
  const selected = scope || ENGINEERING_RULES.domains;
  assert(strings(selected) && selected.length && selected.every(d => ENGINEERING_RULES.domains.includes(d)), 'Unknown domain scope');
  return ENGINEERING_RULES.rules.filter(rule => selected.includes(rule.domain));
}
function preparedRule(config, rule) {
  const domain = config.domains.find(d => d.domain === rule.domain);
  const decision = config.ruleApplicability?.find(item => item.ruleId === rule.id);
  const applicability = decision?.applicability || domain.applicability;
  const binding = config.bindings.find(b => b.ruleId === rule.id);
  let status;
  if (applicability === 'not_applicable') status='not_applicable';
  else if (applicability === 'unknown') status='needs_binding';
  else if (!binding || !binding.implementationRefs.length || !binding.decisionRefs.length || (!binding.checkIds.length && !binding.acIds.length)) status='needs_binding';
  else if (binding.adapterStatus === 'unsupported') status='unsupported';
  else if (binding.exception) status=Date.parse(binding.exception.expiresAt)<=Date.now()?'exception_expired':'deferred';
  else status='ready';
  return {ruleId:rule.id,domain:rule.domain,domainSourceRef:domain.sourceRef,ruleSourceRef:decision?.sourceRef || null,applicabilityReason:decision?.reason || domain.reason,status,checkIds:binding?.checkIds || [],acIds:binding?.acIds || [],requiresReal:rule.real,requiresReview:rule.review,decisionRefs:binding?.decisionRefs || [],implementationRefs:binding?.implementationRefs || [],exception:binding?.exception || null};
}
function summarize(rules) {
  const counts={};for(const rule of rules) counts[rule.status]=(counts[rule.status]||0)+1;
  const status=['failed','stale','exception_expired','needs_binding','unsupported','deferred','not_run','needs_review','needs_acceptance','ready'].find(s=>counts[s]) || (counts.passed?'passed':'not_applicable');
  return {status,counts,rules,coverage:'Only the selected domains and declared project bindings; no claim about other projects/platforms.',businessAcceptance:false};
}

export async function prepareEngineeringRules(profile, scope) {
  const p=await configuration(profile);
  if(!p.engineeringRules) return {status:'not_configured',rules:[],businessAcceptance:false};
  const rules=selectedRules(p.engineeringRules,scope).map(rule=>preparedRule(p.engineeringRules,rule));
  return {...summarize(rules),projectId:p.id,ruleVersion:ENGINEERING_RULES.ruleVersion,readRefs:[...new Set(rules.filter(r=>r.status!=='not_applicable').map(r=>`standards/rules/${r.domain}.md`))],configRef:p.engineeringRulesRef};
}

export async function currentCheck(profile, checkId, stateRoot) {
  const check=profile.checks.find(c=>c.id===checkId);
  const folder=path.join(stateRoot,'runs',profile.id,checkId);
  let names;
  try { names=(await fs.readdir(folder)).filter(n=>/^\d{13}-[a-f0-9-]+$/.test(n)).sort().reverse(); }
  catch(error) {if(error.code==='ENOENT')return {status:'not_run',checkId};throw error;}
  if(!names.length)return {status:'not_run',checkId};
  const receiptFile=await existingInside(stateRoot,`runs/${profile.id}/${checkId}/${names[0]}/receipt.json`);
  const receipt=await json(receiptFile);
  assert(receipt.projectId===profile.id&&receipt.checkId===checkId&&receipt.runId===names[0], 'Check evidence identity mismatch');
  for(const stream of ['stdout','stderr']) {
    try {
      const output=await existingInside(stateRoot,`runs/${profile.id}/${checkId}/${names[0]}/${stream}.log`);
      const expected=receipt[`${stream}Sha256`];
      if(path.resolve(receipt[`${stream}File`]||'')!==output || !/^[a-f0-9]{64}$/.test(expected) || crypto.createHash('sha256').update(await fs.readFile(output)).digest('hex')!==expected)return {status:'stale',checkId,evidence:receiptFile,reason:'raw_output_changed'};
    } catch {return {status:'stale',checkId,evidence:receiptFile,reason:'raw_output_missing'};}
  }
  const fp=await fingerprintCheck(profile,check);
  if(receipt.fingerprint!==fp.digest)return {status:'stale',checkId,evidence:receiptFile};
  return {status:receipt.status==='check_passed'?'passed':'failed',checkId,evidence:receiptFile};
}

export function acceptanceBindingStatus(profile, rule, acs) {
  const required=[profile.engineeringRulesRef,...(rule.domainSourceRef?[rule.domainSourceRef]:[]),...(rule.ruleSourceRef?[rule.ruleSourceRef]:[]),...rule.implementationRefs,...rule.decisionRefs].map(refPath);
  if(acs.some(ac=>!required.every(ref=>[...(ac.implementationRefs||[]),...(ac.dependencyRefs||[])].some(item=>refPath(typeof item==='string'?item:item.path)===ref))))return 'needs_binding';
  if(rule.requiresReal && acs.some(ac=>ac.verificationMethod==='baseline' || !ac.requiredTargets?.length || ac.requiredTargets.some(target=>!profile.entrypoints?.some(entry=>entry.id===target.entrypointId&&entry.kind==='real'))))return 'needs_acceptance';
  if(rule.requiresReview && acs.some(ac=>!ac.requiredTargets?.length || ac.requiredTargets.some(target=>!(target.assertions||ac.assertions||[]).some(a=>a.operator==='manual'))))return 'needs_review';
  return 'ready';
}

export async function assessEngineeringRules(profile, {stateRoot,scope,map:providedMap}={}) {
  assert(text(stateRoot), 'Existing runner stateRoot required');
  const p=await configuration(profile), prepared=await prepareEngineeringRules(p,scope);
  if(!p.engineeringRules)return prepared;
  const checks=new Map();let map=providedMap;
  for(const rule of prepared.rules) {
    if(rule.status!=='ready')continue;
    const results=[];
    for(const id of rule.checkIds) {
      if(!checks.has(id))checks.set(id,await currentCheck(p,id,stateRoot));
      results.push(checks.get(id));
    }
    rule.checkEvidence=results;
    rule.status=['failed','stale','not_run'].find(s=>results.some(r=>r.status===s)) || 'passed';
    if(rule.status!=='passed')continue;
    if(rule.requiresReal || rule.requiresReview || rule.acIds.length) {
      if(!p.featureMapRef || !rule.acIds.length) {rule.status=rule.requiresReview?'needs_review':'needs_acceptance';continue;}
      map ||= await readMap(p);
      const acs=rule.acIds.map(id=>map.acceptanceCriteria.find(a=>a.id===id));
      assert(acs.every(Boolean), 'Rule references unknown existing acceptance criterion');
      const bindingStatus=acceptanceBindingStatus(p,rule,acs);
      if(bindingStatus!=='ready') {rule.status=bindingStatus;continue;}
      // A rule-specific AC checks its own current target. The separate delivery gate
      // still evaluates the complete UI matrix, including project-wide unknowns.
      const assessment=await assessCoverage(p,map,rule.acIds,{includeUIQuality:false});
      rule.acceptance={status:assessment.status,counts:assessment.counts,gaps:assessment.gaps};
      if(assessment.status!=='passed')rule.status=assessment.status==='failed'?'failed':assessment.status==='stale'?'stale':'needs_acceptance';
    }
  }
  return {...summarize(prepared.rules),projectId:p.id,ruleVersion:ENGINEERING_RULES.ruleVersion,configRef:p.engineeringRulesRef,checks:[...checks.values()]};
}

export async function runEngineeringRules(profile, {stateRoot,scope,repeatReason='',newEvidence=[]}={}) {
  const p=await configuration(profile), prepared=await prepareEngineeringRules(p,scope);
  if(!p.engineeringRules)return prepared;
  const ids=[...new Set(prepared.rules.filter(r=>r.status==='ready').flatMap(r=>r.checkIds))];
  const checks=[];
  // Existing runner owns execution authorization, lock, retries and raw evidence.
  for(const id of ids)checks.push(await runCheck(p,id,{stateRoot,repeatReason,newEvidence}));
  const assessed=await assessEngineeringRules(p,{stateRoot,scope});
  return {...assessed,checks};
}
