import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// These tests catch accepting labels instead of actual files, observations and per-target coverage.
const api = await import('../src/acceptance.mjs').catch(e => {
  if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e;
  return {};
});
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'acceptance-'));
  t.after(() => fs.rm(root, {recursive:true,force:true}));
  await fs.mkdir(path.join(root,'evidence'));
  await fs.writeFile(path.join(root,'app.txt'),'implementation-v1');
  const target = {targetId:'member',entrypointId:'app',roleRef:'member',scenario:'create',environmentRef:'test',dataScopeRef:'isolated'};
  const ac = {id:'AC-0001',revision:1,featureId:'FEAT-0001',verificationMethod:'ui',actions:[{type:'input'},{type:'click'},{type:'submit'},{type:'wait'},{type:'observe'}],assertions:[{id:'saved',operator:'equals',path:'/saved',expected:true}],implementationRefs:[{path:'app.txt'}],requiredEvidenceTypes:['execution'],requiredTargets:[target]};
  ac.effects={writes:'none',network:false,paid:false};
  const profile = {id:'test-project',root,featureMapRef:{evidenceDir:'evidence'},acceptanceRoutes:[{id:'browser',kind:'ui',entrypointIds:['app'],driverRef:'existing-browser',available:true,real:true,authorizationRef:'existing-authorization',effects:{writes:'business-data',paid:false,network:true},guards:{permissionRef:'test-member',isolationRef:'test-data'}}]};
  const map = {projectId:profile.id,acceptanceCriteria:[ac],changes:[{id:'CHG-0001',acIds:[ac.id]}],evidence:[]};
  const fingerprint = [{path:'app.txt',sha256:hash('implementation-v1')}];
  const receipt = {projectId:profile.id,acId:ac.id,acRevision:1,runId:'run-1',method:'ui',observationSource:'tool_receipt',executedAt:'2026-09-23T00:00:00Z',implementationFingerprint:fingerprint,observations:[{...target,actions:ac.actions.map(x=>({...x,description:'Recorded actual operation'})),wait:{status:'completed',signal:'record read back'},actual:{saved:true}}]};
  const evidence = {projectId:profile.id,featureId:ac.featureId,acId:ac.id,acRevision:1,targetIds:['member'],changeId:'CHG-0001',runId:'run-1',method:'ui',observationSource:'tool_receipt',implementationFingerprint:fingerprint,environmentRef:'test',roleRef:'member',dataScopeRef:'isolated',executedAt:receipt.executedAt,sourceRef:'tool:run-1',recordedBy:'test',createdAt:receipt.executedAt};
  async function save() {
    const raw = JSON.stringify(receipt);
    await fs.writeFile(path.join(root,'evidence','run-1.json'),raw);
    evidence.rawEvidence=[{path:'evidence/run-1.json',sha256:hash(raw),type:'execution'}];
    return evidence;
  }
  return {root,profile,map,ac,target,receipt,evidence,save};
}
test('acceptance API is implemented',()=>assert.equal(typeof api.validateEvidence,'function'));
test('real hashed observations evaluate assertions and detect overwritten evidence',async t=>{
  const f=await fixture(t); const e=await api.validateEvidence(f.profile,f.map,await f.save());
  assert.equal(e.result,'passed'); f.map.evidence.push({...e,id:'EVD-0001'});
  assert.equal((await api.assessAcceptance(f.profile,f.map,'CHG-0001')).status,'passed');
  await fs.writeFile(path.join(f.root,'evidence/run-1.json'),'overwritten');
  assert.equal((await api.assessAcceptance(f.profile,f.map,'CHG-0001')).status,'stale');
});
test('handwritten passed, cross-project, stale code and wrong role do not pass',async t=>{
  const f=await fixture(t); await f.save();
  await assert.rejects(api.validateEvidence(f.profile,f.map,{...f.evidence,rawEvidence:[],result:'passed'}),/raw_evidence/);
  await assert.rejects(api.validateEvidence(f.profile,f.map,{...f.evidence,projectId:'another'}),/project/);
  f.receipt.observations[0].roleRef='admin'; await f.save();
  await assert.rejects(api.validateEvidence(f.profile,f.map,f.evidence),/target_context/);
  f.receipt.observations[0].roleRef='member'; await f.save(); await fs.writeFile(path.join(f.root,'app.txt'),'changed');
  await assert.rejects(api.validateEvidence(f.profile,f.map,f.evidence),/fingerprint/);
});
test('UI requires actual actions and completed wait, API and toast cannot substitute',async t=>{
  const f=await fixture(t);
  f.receipt.observations[0].actions=[{type:'observe',description:'screenshot'}]; await f.save();
  await assert.rejects(api.validateEvidence(f.profile,f.map,f.evidence),/missing_action/);
  f.receipt.observations[0].actions=f.ac.actions.map(x=>({...x,description:'actual'}));
  f.receipt.observations[0].wait.status='timed_out'; await f.save();
  assert.equal((await api.validateEvidence(f.profile,f.map,f.evidence)).result,'failed');
  f.receipt.method='api'; f.evidence.method='api'; await f.save();
  await assert.rejects(api.validateEvidence(f.profile,f.map,f.evidence),/method/);
});
test('every target requires own observation and expected denial only covers negative target',async t=>{
  const f=await fixture(t); f.ac.requiredTargets.push({...f.target,targetId:'admin',roleRef:'admin'});
  f.map.evidence.push({...await api.validateEvidence(f.profile,f.map,await f.save()),id:'EVD-0001'});
  const assessment=await api.assessAcceptance(f.profile,f.map,'CHG-0001');
  assert.equal(assessment.status,'not_run'); assert.equal(assessment.gaps.length,1);
  await assert.rejects(api.validateEvidence(f.profile,f.map,{...f.evidence,roleRef:'multiple',targetIds:['member','admin']}),/observation/);
});
test('authorized project route works while missing guard blocks without fallback bypass',async t=>{
  const f=await fixture(t);
  assert.equal(api.planAcceptance(f.profile,f.map,'CHG-0001').targets[0].status,'ready');
  delete f.profile.acceptanceRoutes[0].guards.isolationRef;
  assert.equal(api.planAcceptance(f.profile,f.map,'CHG-0001').targets[0].status,'blocked_guard');
  f.profile.acceptanceRoutes=[];
  assert.equal(api.planAcceptance(f.profile,f.map,'CHG-0001').targets[0].status,'unsupported_route');
});
test('paid route requires provider budget and raw paths cannot escape evidence scope',async t=>{
  const f=await fixture(t); f.profile.acceptanceRoutes[0].effects.paid=true;
  assert.equal(api.planAcceptance(f.profile,f.map,'CHG-0001').targets[0].status,'blocked_guard');
  f.profile.acceptanceRoutes[0].guards.budgetRef='enforced-provider-cap';
  assert.equal(api.planAcceptance(f.profile,f.map,'CHG-0001').targets[0].status,'ready');
  await f.save(); f.evidence.rawEvidence[0].path='app.txt';
  await assert.rejects(api.validateEvidence(f.profile,f.map,f.evidence),/evidence_path/);
});
test('manual judgment names its source and unresolved uncertainty prevents passing',async t=>{
  const f=await fixture(t); f.ac.assertions=[{id:'visual',operator:'manual',expected:'correct layout'}];
  f.receipt.observations[0].judgments=[{assertionId:'visual',by:'reviewer',sourceRef:'observation:1',basis:'read actual screenshot',uncertainties:['unreadable label'],result:true}];
  f.receipt.observationSource='manual_attestation'; f.evidence.observationSource='manual_attestation';
  f.receipt.attestation={by:'reviewer',sourceRef:'observation:1',basis:'performed scenario'};
  assert.equal((await api.validateEvidence(f.profile,f.map,await f.save())).result,'blocked');
  f.receipt.observations[0].judgments[0].uncertainties=[];
  assert.equal((await api.validateEvidence(f.profile,f.map,await f.save())).result,'passed');
});
test('AC revision cannot silently reuse previous evidence',async t=>{
  const f=await fixture(t); f.map.evidence.push({...await api.validateEvidence(f.profile,f.map,await f.save()),id:'EVD-0001'});
  f.ac.revision=2;
  assert.equal((await api.assessAcceptance(f.profile,f.map,'CHG-0001')).status,'stale');
});
test('carryForward requires explicit unchanged contract and current scope proof',async t=>{
  const f=await fixture(t); f.map.evidence.push({...await api.validateEvidence(f.profile,f.map,await f.save()),id:'EVD-0001'});
  f.ac.revision=2;
  const c={evidenceId:'EVD-0001',fromAcId:'AC-0001',fromAcRevision:1,fromTargetId:'member',toAcId:'AC-0001',toAcRevision:2,toTargetId:'member',equivalenceBasis:'only another target was added',sourceRef:'decision:2',recordedBy:'reviewer',currentVerification:{implementationFingerprint:f.evidence.implementationFingerprint,roleRef:'member',environmentRef:'test',dataScopeRef:'isolated'}};
  f.map.carryForward=[c];
  assert.equal((await api.assessAcceptance(f.profile,f.map,'CHG-0001')).status,'passed');
  f.ac.assertions[0].expected=false;
  assert.equal((await api.assessAcceptance(f.profile,f.map,'CHG-0001')).status,'stale');
});
test('route cannot underreport AC write/paid effects to avoid guards',async t=>{
  const f=await fixture(t);f.ac.effects={writes:'business-data',network:true,paid:true};
  f.profile.acceptanceRoutes[0].effects={writes:'none',network:false,paid:false};
  f.profile.acceptanceRoutes[0].guards={};
  assert.equal(api.planAcceptance(f.profile,f.map,'CHG-0001').targets[0].status,'blocked_guard');
});
test('real CLI input, persisted output and new-process readback produce consumable evidence',async t=>{
  const f=await fixture(t);f.ac.verificationMethod='cli'; f.ac.actions=[{type:'invoke'},{type:'observe'}];
  f.profile.acceptanceRoutes[0].kind='cli';f.profile.acceptanceRoutes[0].effects={writes:'test-artifacts',network:false,paid:false};
  f.receipt.method='cli';f.evidence.method='cli';
  const execute=promisify(execFile);
  await execute(process.execPath,['-e','require("node:fs").writeFileSync(process.argv[1], JSON.stringify({value:process.argv[2]}))',path.join(f.root,'result.json'),'actual-input']);
  const {stdout}=await execute(process.execPath,['-e','console.log(require("node:fs").readFileSync(process.argv[1],"utf8"))',path.join(f.root,'result.json')]);
  const actual=JSON.parse(stdout);
  f.receipt.observations[0].actions=[{type:'invoke',description:'executed Node CLI with actual-input'},{type:'observe',description:'second process read back result.json'}];
  f.receipt.observations[0].actual={saved:actual.value==='actual-input'};
  assert.equal((await api.validateEvidence(f.profile,f.map,await f.save())).result,'passed');
});
test('newer failed rerun is not hidden by historical pass',async t=>{
  const f=await fixture(t);await f.save();
  await fs.copyFile(path.join(f.root,'evidence/run-1.json'),path.join(f.root,'evidence/old.json'));
  f.evidence.rawEvidence[0].path='evidence/old.json';
  f.map.evidence.push({...await api.validateEvidence(f.profile,f.map,f.evidence),id:'EVD-0001'});
  f.receipt.executedAt='2026-09-23T01:00:00Z';f.evidence.executedAt=f.receipt.executedAt;
  f.receipt.observations[0].actual.saved=false;
  f.map.evidence.push({...await api.validateEvidence(f.profile,f.map,await f.save()),id:'EVD-0002'});
  assert.equal((await api.assessAcceptance(f.profile,f.map,'CHG-0001')).status,'failed');
});
test('corrected attribution from the same actual run supersedes an earlier failed record',async t=>{
  const f=await fixture(t);
  f.receipt.observations[0].actual.saved=false;
  await f.save();
  await fs.copyFile(path.join(f.root,'evidence/run-1.json'),path.join(f.root,'evidence/old.json'));
  f.evidence.rawEvidence[0].path='evidence/old.json';
  f.map.evidence.push({...await api.validateEvidence(f.profile,f.map,f.evidence),id:'EVD-0001'});
  f.receipt.observations[0].actual.saved=true;
  f.evidence.rawEvidence[0].path='evidence/run-1.json';
  f.evidence.createdAt='2026-09-23T01:00:00Z';
  f.map.evidence.push({...await api.validateEvidence(f.profile,f.map,await f.save()),id:'EVD-0002'});
  assert.equal((await api.assessAcceptance(f.profile,f.map,'CHG-0001')).status,'passed');
});
test('explicit impact invalidation cannot be ignored or cleared by carryForward',async t=>{
  const f=await fixture(t); const e={...await api.validateEvidence(f.profile,f.map,await f.save()),id:'EVD-0001',applicability:'stale',invalidationReason:'actual_diff'};f.map.evidence=[e];
  assert.equal((await api.assessAcceptance(f.profile,f.map,'CHG-0001')).status,'stale');
  f.ac.revision=2;f.map.carryForward=[{evidenceId:e.id,fromAcId:'AC-0001',fromAcRevision:1,fromTargetId:'member',toAcId:'AC-0001',toAcRevision:2,toTargetId:'member',equivalenceBasis:'unchanged target',sourceRef:'decision:2',recordedBy:'reviewer',currentVerification:{implementationFingerprint:e.implementationFingerprint,roleRef:'member',environmentRef:'test',dataScopeRef:'isolated'}}];
  assert.equal((await api.assessAcceptance(f.profile,f.map,'CHG-0001')).status,'stale');
  e.invalidationReason='acceptance_contract_changed';
  assert.equal((await api.assessAcceptance(f.profile,f.map,'CHG-0001')).status,'passed');
});
test('missing AC effects cannot be accepted as safe zero effects',async t=>{
  const f=await fixture(t);delete f.ac.effects;
  assert.equal(api.planAcceptance(f.profile,f.map,'CHG-0001').targets[0].status,'blocked_guard');
});
test('carryForward refuses changed preconditions even when assertions still match',async t=>{
  const f=await fixture(t);f.ac.preconditions=['fresh account'];
  const e={...await api.validateEvidence(f.profile,f.map,await f.save()),id:'EVD-0001'};f.map.evidence=[e];f.ac.revision=2;f.ac.preconditions=['existing paid account'];
  f.map.carryForward=[{evidenceId:e.id,fromAcId:'AC-0001',fromAcRevision:1,fromTargetId:'member',toAcId:'AC-0001',toAcRevision:2,toTargetId:'member',equivalenceBasis:'claimed equivalent',sourceRef:'decision:2',recordedBy:'reviewer',currentVerification:{implementationFingerprint:e.implementationFingerprint,roleRef:'member',environmentRef:'test',dataScopeRef:'isolated'}}];
  assert.equal((await api.assessAcceptance(f.profile,f.map,'CHG-0001')).status,'stale');
});
test('environment and declared dependency files must be fingerprinted before reuse',async t=>{
  const f=await fixture(t);await fs.writeFile(path.join(f.root,'config.json'),'old-config');
  f.profile.environmentFiles=['config.json'];
  await assert.rejects(api.validateEvidence(f.profile,f.map,await f.save()),/fingerprint_scope/);
  f.receipt.implementationFingerprint.push({path:'config.json',sha256:hash('old-config')});await f.save();
  const e=await api.validateEvidence(f.profile,f.map,f.evidence);f.map.evidence=[{...e,id:'EVD-0001'}];
  await fs.writeFile(path.join(f.root,'config.json'),'new-config');
  assert.equal((await api.assessAcceptance(f.profile,f.map,'CHG-0001')).status,'stale');
});
test('equalsPath compares observed values and missing values cannot equal each other',async t=>{
  const f=await fixture(t);f.ac.assertions=[{id:'unchanged',operator:'equalsPath',path:'/before',expected:'/after'}];
  f.receipt.observations[0].actual={before:'hash-a',after:'hash-a'};
  assert.equal((await api.validateEvidence(f.profile,f.map,await f.save())).result,'passed');
  f.receipt.observations[0].actual.after='hash-b';
  assert.equal((await api.validateEvidence(f.profile,f.map,await f.save())).result,'failed');
  f.receipt.observations[0].actual={};
  assert.equal((await api.validateEvidence(f.profile,f.map,await f.save())).result,'failed');
});
