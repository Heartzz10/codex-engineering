import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {loadProfile} from '../src/profile.mjs';
import {VERSION} from '../src/paths.mjs';
import {assessAcceptance} from '../src/acceptance.mjs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile);
async function fixture(t) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'ui-binding-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  await fs.writeFile(path.join(root,'guide.md'),'project');
  const profile={schemaVersion:2,id:'ui-sample',sharedVersion:VERSION,root,authoritativeDocuments:['guide.md'],environmentRef:'loopback',checks:[]};
  const file=path.join(root,'profile.json');
  const save=()=>fs.writeFile(file,JSON.stringify(profile));
  await save();return {root,profile,file,save};
}
test('old profile reports new UI coverage unconfigured without breaking old checks',async t=>{
  const f=await fixture(t),p=await loadProfile(f.file);
  assert.equal(p.uiQualityStatus,'not_configured');
  const {stdout}=await exec(process.execPath,['src/cli.mjs','doctor','--profile',f.file]);
  assert.equal(JSON.parse(stdout).uiQuality.status,'not_configured');
});
test('new UI reference cannot escape project or silently disappear',async t=>{
  const f=await fixture(t);f.profile.uiQualityRef='../outside.json';await f.save();
  await assert.rejects(loadProfile(f.file),/inside|escape|exist/);
  f.profile.uiQualityRef='missing.json';await f.save();
  await assert.rejects(loadProfile(f.file),/exist|ENOENT/);
});
test('new malformed quality config blocks profile load',async t=>{
  const f=await fixture(t);f.profile.uiQualityRef='quality.json';await f.save();
  await fs.writeFile(path.join(f.root,'quality.json'),JSON.stringify({schemaVersion:1,platforms:['unknown']}));
  await assert.rejects(loadProfile(f.file),/quality|platform|config/i);
});
test('UI quality missing observations cannot be reported passed by acceptance',async t=>{
  const f=await fixture(t);
  const p={...f.profile,uiQuality:{schemaVersion:1,ruleVersion:'1.0.0',sourceRef:'guide.md',hasUI:true,platforms:['web'],designRefs:['guide.md'],componentRefs:['guide.md'],categories:Array.from({length:18},(_,i)=>({categoryId:`Q${String(i+1).padStart(2,'0')}`,applicability:i===11?'applicable':'not_applicable',reason:'bounded task',sourceRef:'guide.md'})),adapters:[],sourceChecks:[],requirements:[{ruleId:'saved',categoryId:'Q12',featureId:'FEAT-1',acId:'AC-1',entrypointId:'web',targetId:'member',state:'saved',platform:'web',method:'business',sourceRef:'guide.md',expected:'saved'}],exceptions:[]}};
  const map={projectId:p.id,changes:[],acceptanceCriteria:[{id:'AC-1',revision:1,featureId:'FEAT-1',requiredTargets:[]}],evidence:[]};
  const r=await assessAcceptance(p,map);
  assert(r.uiQuality,'quality coverage must accompany acceptance');
  assert.notEqual(r.uiQuality.status,'passed');
});
