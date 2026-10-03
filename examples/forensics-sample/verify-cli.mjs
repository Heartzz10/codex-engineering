import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { VERSION } from '../../src/paths.mjs';

const here=path.dirname(fileURLToPath(import.meta.url)),root=path.resolve(here,'../..');
const artifacts=path.join(here,'artifacts');
const latest=(await fs.readdir(artifacts)).filter(x=>x.startsWith('RUN-')).sort().at(-1);
assert.ok(latest,'Capture sample first');
const captured=path.join(artifacts,latest),out=path.join(here,'cli-evidence',`RUN-${Date.now()}`);
await fs.mkdir(out,{recursive:true});
const transcript=[];
const invoke=(args)=>{
  const run=spawnSync(process.execPath,[path.join(root,'skills/codex-engineering/scripts/engineering.mjs'),...args],{encoding:'utf8',timeout:10000});
  transcript.push({args,exitCode:run.status,stdout:run.stdout,stderr:run.stderr});
  assert.equal(run.status,0,run.stderr);
  return JSON.parse(run.stdout);
};
const input=async(name,value)=>{const file=path.join(out,name+'.json');await fs.writeFile(file,JSON.stringify(value,null,2));return file;};
const help=invoke(['--help']);
assert.ok(help.commands.task.includes('route')&&help.commands.debug.includes('plan|audit'));
const catalog=JSON.parse(await fs.readFile(path.join(root,'upstream/pstack/route-catalog.json'),'utf8'));
for(const route of catalog.categories) {
  const result=invoke(['task','route','--input',await input(route.categoryId,{category:route.categoryId})]);
  assert.equal(result.categoryId,route.categoryId);
  assert.equal(result.status,route.executionAdoption==='adopted'?'routed':'not_adopted');
  if(result.status==='not_adopted') {
    assert.equal(result.protocol,null);
    assert.equal(result.nextAction.status,'local_fallback');
    for(const key of ['capability','operation','prerequisite','limit']) assert.ok(result.nextAction[key]);
  }
}
for(const [name,record,status,metaRoute] of [
  ['meta-cross-cutting',{taskScale:'cross-cutting',category:'bug-fix'},'not_adopted','figure-it-out'],
  ['meta-unmatched',{taskScale:'unmatched'},'not_adopted','figure-it-out'],
  ['meta-standing',{taskScale:'standing-program'},'not_adopted','orchestrate'],
  ['meta-conflict',{taskScale:'standing-program',category:'bug-fix'},'intent_conflict','orchestrate'],
]) {
  const result=invoke(['task','route','--input',await input(name,record)]);
  assert.equal(result.status,status);
  assert.equal(result.metaRoute,metaRoute);
  if(status==='not_adopted') assert.equal(result.protocol,null);
}
for(const category of ['investigation','bug-fix','runtime-forensics','trace-forensics']) {
  const destination=path.join(out,category+'.protocol.json');
  invoke(['debug','plan','--input',path.join(out,category+'.json'),'--output',path.relative(process.cwd(),destination)]);
  const protocol=JSON.parse(await fs.readFile(destination,'utf8'));
  assert.equal(protocol.categoryId,category);
  assert.equal(protocol.executed,false);
  for(const ref of protocol.sourceRefs) assert.ok((await fs.stat(ref.localPath)).isFile());
}
const manifest=JSON.parse(await fs.readFile(path.join(captured,'manifest.json'),'utf8'));
const artifact=(name,id,kind)=>{const ref=manifest.files.find(x=>x.path===name);assert.ok(ref);return {id,kind,path:`${latest}/${name}`,sha256:ref.sha256,projectId:'forensics-sample',surface:'cli',environment:'isolated-node',role:'synthetic-owner'};};
const profile=await input('profile',{schemaVersion:2,id:'forensics-sample',sharedVersion:VERSION,root:here,authoritativeDocuments:['README.md'],environmentRef:'clean isolated child environment, no network',checks:[],entrypoints:[],featureMapRef:{schemaVersion:1,path:'feature-map.json',historyDir:'history',evidenceDir:'artifacts'}});
const common={projectId:'forensics-sample',artifacts:[artifact('before.cpuprofile','capture','capture'),artifact('before.cpuprofile.samples.jsonl','samples','queryable-data'),artifact('diagnosis.json','diagnosis','reduced-finding'),artifact('diagnosis.json','symbols','symbol-map')]};
for(const [name,record] of Object.entries({
  'unpaired-trace':{...common,category:'trace-forensics'},
  'paired-trace':{...common,category:'trace-forensics',artifacts:[...common.artifacts,artifact('suppressed.cpuprofile','after','capture'),artifact('live-intervention.json','comparison','paired-comparison')],pairedCapture:{beforeId:'capture',afterId:'after',comparisonEvidenceIds:['comparison']}},
  'live-cpu':{...common,category:'runtime-forensics',captureType:'cpu',artifacts:[...common.artifacts,artifact('live-intervention.json','intervention','mechanism')]}
})) {
  const destination=path.join(out,name+'.result.json');
  invoke(['debug','audit','--profile',profile,'--input',await input(name,record),'--output',path.relative(process.cwd(),destination)]);
  const result=JSON.parse(await fs.readFile(destination,'utf8'));
  assert.equal(result.status,'evidence_ready_for_review');assert.equal(result.behaviorVerified,false);
  if(name==='unpaired-trace') assert.equal(result.confidenceCeiling,'bounded_hypothesis');
}
const uiRuns=(await fs.readdir(artifacts)).filter(name=>name.startsWith('UI-RUN-')).sort().reverse();
let uiCaptured;
for(const name of uiRuns) {
  try {const files=await fs.readdir(path.join(artifacts,name));if(files.includes('manifest.json')&&files.includes('ui-intervention.cpuprofile')) {uiCaptured=name;break;}}catch{}
}
assert.ok(uiCaptured,'Capture a paired synthetic UI trace first');
const uiManifest=JSON.parse(await fs.readFile(path.join(artifacts,uiCaptured,'manifest.json'),'utf8'));
const uiArtifact=(name,id,kind)=>{const ref=uiManifest.files.find(item=>item.path===name);assert.ok(ref);return {id,kind,path:`${uiCaptured}/${name}`,sha256:ref.sha256,projectId:'forensics-sample',surface:'synthetic-ui',environment:'isolated-chromium',role:'synthetic-owner'};};
const uiPair={category:'trace-forensics',projectId:'forensics-sample',artifacts:[
  uiArtifact('ui-cpu.cpuprofile','ui-before','capture'),uiArtifact('ui-intervention.cpuprofile','ui-after','capture'),
  uiArtifact('frames.jsonl','ui-frames','queryable-data'),uiArtifact('ui-diagnosis.json','ui-finding','reduced-finding'),
  uiArtifact('ui-diagnosis.json','ui-symbols','symbol-map'),uiArtifact('ui-diagnosis.json','ui-comparison','paired-comparison')],
  pairedCapture:{beforeId:'ui-before',afterId:'ui-after',comparisonEvidenceIds:['ui-comparison']}};
const uiResultFile=path.join(out,'ui-paired-trace.result.json');
invoke(['debug','audit','--profile',profile,'--input',await input('ui-paired-trace',uiPair),'--output',path.relative(process.cwd(),uiResultFile)]);
const uiPairResult=JSON.parse(await fs.readFile(uiResultFile,'utf8'));
assert.equal(uiPairResult.status,'evidence_ready_for_review');
assert.equal(uiPairResult.confidenceCeiling,'paired_comparison_available_for_review');
assert.equal(uiPairResult.behaviorVerified,false);
await input('transcript',transcript);
await input('result',{status:'passed',publicHelpDiscovered:true,categoryRoutes:23,metaRouteCases:4,selectedProtocols:4,explicitLocalFallbacks:19,rawArtifactAudits:4,liveCapturedArtifacts:captured,uiPairedArtifacts:path.join(artifacts,uiCaptured),scope:'Fresh CLI processes with explicit input/profile only; deterministic discoverability, next-action descriptions, and paired artifact preflight. This is not separate model-context routing or execution of the nineteen fallback tasks. Paired preflight is not proof of a product improvement.',evidencePreserved:true});
console.log(JSON.stringify({status:'passed',routeCount:23,metaRouteCases:4,protocolCount:4,auditCount:4,evidenceDirectory:out}));
