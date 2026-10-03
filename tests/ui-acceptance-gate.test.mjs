import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {validateEvidence,assessAcceptance,assessCoverage} from '../src/acceptance.mjs';
import {deriveUIQualityConfig} from '../src/ui-quality.mjs';
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
async function setup(t,{targetIds=['member']}={}){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'ui-accept-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 await fs.mkdir(path.join(root,'evidence'));await fs.writeFile(path.join(root,'app.txt'),'current source');
 const unit={ruleId:'business-readback',categoryId:'Q12',featureId:'FEAT-0001',acId:'AC-0001',entrypointId:'web',targetId:'member',state:'saved',platform:'web',method:'business',expected:'persisted',sourceRef:'guide.md'};
 const units=targetIds.map(targetId=>({...unit,targetId}));
 const config=deriveUIQualityConfig({hasUI:true,platforms:['web'],sourceRef:'guide.md',designRefs:['guide.md'],componentRefs:['app.txt'],categories:Array.from({length:18},(_,i)=>({categoryId:`Q${String(i+1).padStart(2,'0')}`,applicability:i===11?'applicable':'not_applicable',reason:'only this bounded task',sourceRef:'guide.md'})),requirements:units,adapters:[{id:'cdp',platform:'web',capabilities:['business'],sourceRef:'app.txt'}]});
 await fs.writeFile(path.join(root,'ui.json'),JSON.stringify(config));
 const fingerprint=[{path:'app.txt',sha256:hash('current source')},{path:'ui.json',sha256:hash(JSON.stringify(config))}];
 const target={targetId:'member',entrypointId:'web',roleRef:'member',environmentRef:'test',dataScopeRef:'isolated'};
 const ac={id:'AC-0001',featureId:'FEAT-0001',revision:1,verificationMethod:'ui',implementationRefs:[{path:'app.txt'}],requiredTargets:targetIds.map(targetId=>({...target,targetId})),effects:{writes:'none',network:false,paid:false},actions:[{type:'input'},{type:'click'},{type:'wait'},{type:'observe'}],assertions:[{id:'saved',operator:'equals',path:'/saved',expected:true}]};
 const profile={id:'sample',root,environmentRef:'test',uiQuality:config,uiQualityRef:'ui.json',featureMapRef:{evidenceDir:'evidence'},acceptanceRoutes:[{kind:'ui',entrypointIds:['web'],available:true,real:true,driverRef:'existing-driver',authorizationRef:'user',effects:{writes:'none',network:false,paid:false}}]};
 const map={projectId:'sample',changes:[{id:'CHG-0001',acIds:['AC-0001']}],acceptanceCriteria:[ac],evidence:[]};
 async function evidence(index,actual,{targetIds:executedTargets=targetIds,nestedUI=false}={}){
 const at=`2026-09-27T00:00:0${index}Z`,runId=`run-${index}`;
 const uiQualityObservations=units.filter(item=>executedTargets.includes(item.targetId)).map(item=>({...item,actual:typeof actual==='object'?actual[item.targetId]:actual,evidenceRef:`evidence/${index}.json`,ruleVersion:config.ruleVersion,environmentRef:'test',actions:[{type:'input'},{type:'click'},{type:'wait'},{type:'readback'}]})).filter(item=>item.actual!==undefined);
 const observations=executedTargets.map(targetId=>({...target,targetId,actions:ac.actions.map(a=>({...a,description:'actual native operation'})),wait:{status:'completed',signal:'saved'},actual:{saved:true},...(nestedUI?{uiQualityObservations:uiQualityObservations.filter(item=>item.targetId===targetId)}:{})}));
 const receipt={projectId:'sample',acId:ac.id,acRevision:1,runId,method:'ui',observationSource:'tool_receipt',executedAt:at,implementationFingerprint:fingerprint,observations,...(!nestedUI?{uiQualityObservations}:{})};
 const bytes=JSON.stringify(receipt);await fs.writeFile(path.join(root,`evidence/${index}.json`),bytes);
 return {projectId:'sample',featureId:ac.featureId,acId:ac.id,acRevision:1,targetIds:executedTargets,changeId:'CHG-0001',runId,method:'ui',observationSource:'tool_receipt',implementationFingerprint:fingerprint,environmentRef:'test',roleRef:'member',dataScopeRef:'isolated',executedAt:at,sourceRef:'original-driver',recordedBy:'main',createdAt:at,rawEvidence:[{path:`evidence/${index}.json`,type:'execution',sha256:hash(bytes)}]};
 }
 return{root,profile,map,evidence};
}
test('UI gate consumes hashed originals and newest repair supersedes old failure',async t=>{
 const f=await setup(t);
 f.map.evidence.push({...await validateEvidence(f.profile,f.map,await f.evidence(1,'wrong')),id:'EVD-0001'});
 assert.equal((await assessAcceptance(f.profile,f.map,'CHG-0001')).uiQuality.status,'failed');
 f.map.evidence.push({...await validateEvidence(f.profile,f.map,await f.evidence(2,'persisted')),id:'EVD-0002'});
 assert.equal((await assessAcceptance(f.profile,f.map,'CHG-0001')).status,'passed');
 await fs.writeFile(path.join(f.root,'ui.json'),'changed rule');
 assert.notEqual((await assessAcceptance(f.profile,f.map,'CHG-0001')).status,'passed');
});
test('newest failed UI business readback cannot hide behind older successful receipt',async t=>{
 const f=await setup(t);
 f.map.evidence.push({...await validateEvidence(f.profile,f.map,await f.evidence(1,'persisted')),id:'EVD-0001'});
 f.map.evidence.push({...await validateEvidence(f.profile,f.map,await f.evidence(2,'wrong')),id:'EVD-0002'});
 assert.notEqual((await assessAcceptance(f.profile,f.map,'CHG-0001')).status,'passed');
});
test('two-target receipt retains only current UI observations after a one-target repair',async t=>{
 const f=await setup(t,{targetIds:['member','second']});
 f.map.evidence.push({...await validateEvidence(f.profile,f.map,await f.evidence(1,{member:'wrong',second:'persisted'})),id:'EVD-0001'});
 f.map.evidence.push({...await validateEvidence(f.profile,f.map,await f.evidence(2,'persisted',{targetIds:['member']})),id:'EVD-0002'});
 const result=await assessAcceptance(f.profile,f.map,'CHG-0001');
 assert.equal(result.status,'passed');
 assert.equal(result.uiQuality.status,'passed');
 assert.deepEqual(result.uiQuality.results.find(item=>item.targetId==='member').evidenceRefs,['evidence/2.json']);
 assert.deepEqual(result.conditions[0].targets.map(item=>item.evidenceIds),[['EVD-0002'],['EVD-0001']]);
});
test('old UI success retained for another target cannot fill a newer execution with no UI evidence',async t=>{
 const f=await setup(t,{targetIds:['member','second']});
 f.map.evidence.push({...await validateEvidence(f.profile,f.map,await f.evidence(1,'persisted',{nestedUI:true})),id:'EVD-0001'});
 f.map.evidence.push({...await validateEvidence(f.profile,f.map,await f.evidence(2,{},{targetIds:['member'],nestedUI:true})),id:'EVD-0002'});
 const result=await assessAcceptance(f.profile,f.map,'CHG-0001');
 assert.equal(result.status,'blocked');
 assert.equal(result.uiQuality.status,'incomplete');
 assert.equal(result.uiQuality.results.find(item=>item.targetId==='member').status,'not_executed');
 assert.equal(result.uiQuality.results.find(item=>item.targetId==='second').status,'passed');
 assert.ok(result.conditions[0].targets.every(item=>item.status==='passed'));
});

test('an exact nonvisual rule target can pass while the ordinary delivery UI gate still blocks',async t=>{
 const f=await setup(t);
 f.map.evidence.push({...await validateEvidence(f.profile,f.map,await f.evidence(1,undefined,{nestedUI:true})),id:'EVD-0001'});
 assert.equal((await assessCoverage(f.profile,f.map,['AC-0001'])).status,'blocked');
 const targeted=await assessCoverage(f.profile,f.map,['AC-0001'],{includeUIQuality:false});
 assert.equal(targeted.status,'passed');
 assert.equal(targeted.conditions[0].targets[0].status,'passed');
 assert.equal((await assessAcceptance(f.profile,f.map,'CHG-0001')).status,'blocked');
});
