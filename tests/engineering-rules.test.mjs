import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadProfile } from '../src/profile.mjs';
import { VERSION } from '../src/paths.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'engineering-baseline-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'decisions.md'), '本测试约定：输出错误不得包含内部诊断。没有页面和业务权限服务。');
  await fs.writeFile(path.join(root, 'check.mjs'), 'process.exit(0);');
  const p = { schemaVersion: 2, id: 'rule-fixture', sharedVersion: VERSION, root, authoritativeDocuments: ['decisions.md'], environmentRef: 'isolated', engineeringRulesRef: 'rules.json', checks: [{ id:'contracts',executable:process.execPath,args:['check.mjs'],cwd:'.',timeoutMs:10000,inputs:['check.mjs'],reviewed:true,authorizationRef:'decisions.md',effects:{writes:'none',network:false,paid:false} }] };
  const { ENGINEERING_RULES } = await import('../src/engineering-rules.mjs');
  const config = {schemaVersion:1,ruleVersion:ENGINEERING_RULES.ruleVersion,domains:ENGINEERING_RULES.domains.map(domain=>({domain,applicability:domain==='errors'?'applicable':'not_applicable',reason:'测试范围仅错误转换',sourceRef:'decisions.md'})),bindings:[{ruleId:'ERR-3',implementationRefs:['check.mjs'],decisionRefs:['decisions.md'],checkIds:['contracts'],acIds:[]}]};
  const save = async () => {await fs.writeFile(path.join(root,'rules.json'),JSON.stringify(config));await fs.writeFile(path.join(root,'profile.json'),JSON.stringify(p));return loadProfile(path.join(root,'profile.json'));};
  return {root,p,config,save,stateRoot:path.join(root,'state')};
}

test('unbound baseline is not a pass and scope never hides unknown applicability', async t => {
  const f = await fixture(t);
  const {prepareEngineeringRules} = await import('../src/engineering-rules.mjs');
  const prepared = await prepareEngineeringRules(await f.save());
  assert.equal(prepared.status,'needs_binding');
  assert.ok(prepared.rules.some(x=>x.ruleId==='ERR-1'&&x.status==='needs_binding'));
  f.config.domains[0].applicability='unknown';
  assert.equal((await prepareEngineeringRules(await f.save(),['ui'])).status,'needs_binding');
  await assert.rejects(prepareEngineeringRules(await f.save(),['typo']),/Unknown domain/);
});

test('one absent behavior can be sourced as not applicable without hiding its applicable neighbors', async t => {
  const f=await fixture(t);
  const {prepareEngineeringRules}=await import('../src/engineering-rules.mjs');
  f.config.domains.find(x=>x.domain==='interaction').applicability='applicable';
  f.config.ruleApplicability=[{ruleId:'INT-3',applicability:'not_applicable',reason:'The sample has no modal dialog',sourceRef:'decisions.md'}];
  const profile=await f.save();
  const result=await prepareEngineeringRules(profile,['interaction']);
  assert.equal(result.rules.find(x=>x.ruleId==='INT-3').status,'not_applicable');
  assert.equal(result.rules.find(x=>x.ruleId==='INT-2').status,'needs_binding');
  f.config.ruleApplicability[0].sourceRef='missing.md';
  await assert.rejects(f.save(),/ENOENT|reference/i);
  f.config.ruleApplicability[0].sourceRef='decisions.md';
  f.config.ruleApplicability.push({...f.config.ruleApplicability[0]});
  await assert.rejects(f.save(),/duplicate/i);
});

test('rule run executes registered check, records evidence and refuses changed input as current', async t => {
  const f=await fixture(t);
  const {runEngineeringRules,assessEngineeringRules}=await import('../src/engineering-rules.mjs');
  const profile=await f.save();
  const before=await assessEngineeringRules(profile,{stateRoot:f.stateRoot});
  assert.equal(before.rules.find(x=>x.ruleId==='ERR-3').status,'not_run');
  const run=await runEngineeringRules(profile,{stateRoot:f.stateRoot});
  assert.equal(run.checks[0].status,'check_passed');
  assert.equal(run.rules.find(x=>x.ruleId==='ERR-3').status,'passed');
  assert.equal(run.status,'needs_binding'); // Remaining error rules are never silently passed.
  await fs.writeFile(path.join(f.root,'check.mjs'),'process.exit(1);');
  assert.equal((await assessEngineeringRules(profile,{stateRoot:f.stateRoot})).rules.find(x=>x.ruleId==='ERR-3').status,'stale');
  const failed=await runEngineeringRules(profile,{stateRoot:f.stateRoot});
  assert.equal(failed.rules.find(x=>x.ruleId==='ERR-3').status,'failed');
});

test('binding is fingerprinted by ordinary runner and legitimate old profile remains usable', async t => {
  const f=await fixture(t);
  const {runEngineeringRules,assessEngineeringRules}=await import('../src/engineering-rules.mjs');
  await runEngineeringRules(await f.save(),{stateRoot:f.stateRoot});
  f.config.bindings[0].decisionRefs=['decisions.md#new'];
  const p=await f.save();
  assert.equal((await assessEngineeringRules(p,{stateRoot:f.stateRoot})).rules.find(x=>x.ruleId==='ERR-3').status,'stale');
  delete f.p.engineeringRulesRef;
  assert.equal((await assessEngineeringRules(await f.save(),{stateRoot:f.stateRoot})).status,'not_configured');
});

test('duplicate/unknown rules, escaped decision refs and engineering receipts as business bindings are rejected', async t => {
  const f=await fixture(t);
  f.config.bindings.push(structuredClone(f.config.bindings[0]));
  await assert.rejects(f.save(),/duplicate/i);
  f.config.bindings.pop();f.config.bindings[0].ruleId='made-up';
  await assert.rejects(f.save(),/ruleId/);
  f.config.bindings[0].ruleId='ERR-3';f.config.bindings[0].decisionRefs=['../outside'];
  await assert.rejects(f.save(),/escapes/);
});

test('allow and deny business evidence cannot be replaced by a successful engineering check', async t => {
  const f=await fixture(t);
  f.config.domains=f.config.domains.map(x=>({...x,applicability:x.domain==='permissions'?'applicable':'not_applicable'}));
  f.config.bindings=[{ruleId:'AUTH-1',implementationRefs:['check.mjs'],decisionRefs:['decisions.md'],checkIds:['contracts'],acIds:[]}];
  const {runEngineeringRules}=await import('../src/engineering-rules.mjs');
  const r=await runEngineeringRules(await f.save(),{stateRoot:f.stateRoot});
  assert.notEqual(r.rules.find(x=>x.ruleId==='AUTH-1').status,'passed');
});

test('AC-only bindings must fingerprint rule decisions and each effective target needs manual judgment', async () => {
  const { acceptanceBindingStatus }=await import('../src/engineering-rules.mjs');
  const profile={engineeringRulesRef:'rules.json',entrypoints:[{id:'api',kind:'real'}]};
  const rule={requiresReal:true,requiresReview:true,domainSourceRef:'applicability.md',implementationRefs:['app.mjs'],decisionRefs:['decision.md#roles']};
  const ac={verificationMethod:'api',implementationRefs:[{path:'app.mjs'}],assertions:[{operator:'manual'}],requiredTargets:[{targetId:'member',entrypointId:'api'}]};
  assert.equal(acceptanceBindingStatus(profile,rule,[ac]),'needs_binding');
  ac.dependencyRefs=['rules.json','decision.md','applicability.md'];
  assert.equal(acceptanceBindingStatus(profile,rule,[ac]),'ready');
  ac.requiredTargets[0].assertions=[{operator:'equals'}];
  assert.equal(acceptanceBindingStatus(profile,rule,[ac]),'needs_review');
  ac.requiredTargets[0].assertions=[{operator:'manual'}];
  ac.verificationMethod='baseline';
  assert.equal(acceptanceBindingStatus(profile,rule,[ac]),'needs_acceptance');
  ac.verificationMethod='api';profile.entrypoints[0].kind='simulation';
  assert.equal(acceptanceBindingStatus(profile,rule,[ac]),'needs_acceptance');
});

test('unsupported adapters and expired or current exceptions never count as passes', async t => {
  const f=await fixture(t);
  const {prepareEngineeringRules}=await import('../src/engineering-rules.mjs');
  f.config.bindings[0].adapterStatus='unsupported';
  assert.equal((await prepareEngineeringRules(await f.save())).rules.find(r=>r.ruleId==='ERR-3').status,'unsupported');
  delete f.config.bindings[0].adapterStatus;
  f.config.bindings[0].exception={reason:'临时等待适配',sourceRef:'decisions.md',expiresAt:new Date(Date.now()+60000).toISOString()};
  assert.equal((await prepareEngineeringRules(await f.save())).rules.find(r=>r.ruleId==='ERR-3').status,'deferred');
  f.config.bindings[0].exception.expiresAt=new Date(Date.now()-60000).toISOString();
  assert.equal((await prepareEngineeringRules(await f.save())).rules.find(r=>r.ruleId==='ERR-3').status,'exception_expired');
});

test('explicit no-applicable scope is legitimate but cannot claim execution', async t => {
  const f=await fixture(t);
  const {prepareEngineeringRules,ENGINEERING_RULES}=await import('../src/engineering-rules.mjs');
  f.config.domains.forEach(d=>d.applicability='not_applicable');f.config.bindings=[];
  const r=await prepareEngineeringRules(await f.save());
  assert.equal(r.status,'not_applicable');
  assert.equal(r.counts.not_applicable,ENGINEERING_RULES.rules.length);
  assert.equal(r.businessAcceptance,false);
  for(const rule of ENGINEERING_RULES.rules)for(const field of ['prevents','when','enforce','verify','exception'])assert.ok(rule[field].length>0);
});

test('rule checks share ordinary engineering authorization instead of expanding it', async t => {
  const f=await fixture(t);
  f.p.checks[0].effects={writes:'business-data',network:true,paid:false};
  const {runEngineeringRules}=await import('../src/engineering-rules.mjs');
  await assert.rejects(runEngineeringRules(await f.save(),{stateRoot:f.stateRoot}),/Business-data writes/);
  f.p.checks[0].effects={writes:'none',network:false,paid:true};
  await assert.rejects(runEngineeringRules(await f.save(),{stateRoot:f.stateRoot}),/Paid checks/);
});

test('missing or modified raw check output cannot preserve a passed rule', async t => {
  const f=await fixture(t);
  const {runEngineeringRules,assessEngineeringRules}=await import('../src/engineering-rules.mjs');
  const p=await f.save();const r=await runEngineeringRules(p,{stateRoot:f.stateRoot});
  const receipt=JSON.parse(await fs.readFile(r.checks[0].evidence,'utf8'));
  await fs.writeFile(receipt.stdoutFile,'overwritten');
  assert.equal((await assessEngineeringRules(p,{stateRoot:f.stateRoot})).rules.find(x=>x.ruleId==='ERR-3').status,'stale');
  await fs.unlink(receipt.stdoutFile);
  assert.equal((await assessEngineeringRules(p,{stateRoot:f.stateRoot})).rules.find(x=>x.ruleId==='ERR-3').status,'stale');
});

test('existing delivery acceptance refuses an enabled baseline with gaps', async t => {
  const f=await fixture(t);const p=await f.save();
  const {assessDeliveryCoverage}=await import('../src/acceptance.mjs');
  const result=await assessDeliveryCoverage(p,{projectId:p.id,acceptanceCriteria:[],evidence:[]},[],{stateRoot:f.stateRoot});
  assert.equal(result.engineeringRules.status,'needs_binding');
  assert.notEqual(result.status,'passed');
});

test('maintenance with no covered business targets still reports enabled rule gaps', async t => {
  const f=await fixture(t);const p=await f.save();
  p.featureMapRef={schemaVersion:1,path:'map.json',historyDir:'history',evidenceDir:'evidence'};
  const {maintainVerification}=await import('../src/maintenance.mjs');
  const r=await maintainVerification(p,{projectId:p.id,features:[],acceptanceCriteria:[]},{runId:'baseline-empty'});
  assert.ok(r.gaps.some(g=>g.code==='engineering_rules_incomplete'));
});
