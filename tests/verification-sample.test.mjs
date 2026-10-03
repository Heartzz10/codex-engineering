import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const sample=await import('../examples/verification-sample/server.mjs').catch(e=>{if(e.code!=='ERR_MODULE_NOT_FOUND')throw e;return {};});
const execute=promisify(execFile);
test('sample exposes real HTTP service for both browser and CLI',()=>assert.equal(typeof sample.startServer,'function'));
test('actual CLI creates/searches persisted notes, dry-run does not write, restart retains data',async t=>{
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'sample-notes-'));t.after(()=>fs.rm(dataDir,{recursive:true,force:true}));
  let service=await sample.startServer({port:0,dataDir});t.after(()=>service.close());
  const cli=async(...args)=>JSON.parse((await execute(process.execPath,['examples/verification-sample/driver.mjs',...args,'--url',service.url])).stdout);
  const created=await cli('create','verifiable persistence');assert.equal(created.note.text,'verifiable persistence');
  assert.equal((await cli('list')).notes.length,1);assert.equal((await cli('search','persistence')).notes[0].id,created.note.id);
  assert.equal((await cli('search','absent')).notes.length,0);
  const before=await fs.readFile(path.join(dataDir,'notes.json'),'utf8');
  assert.equal((await cli('dry-run','no write')).dryRun,true);assert.equal(await fs.readFile(path.join(dataDir,'notes.json'),'utf8'),before);
  const report=await cli('verify-cli');
  const observed=id=>report.observations.find(o=>o.targetId===id).actual;
  assert.deepEqual(report.observations.map(o=>o.targetId),['cli-create','cli-list','cli-search','cli-search-empty','cli-search-clear','cli-dry-run']);
  assert.equal(observed('cli-create').note.text,report.marker);
  assert.equal(observed('cli-create').readback.id,observed('cli-create').note.id);
  assert.equal(observed('cli-create').readback.text,report.marker);
  assert.equal(observed('cli-list').matchedText,report.marker);
  assert.equal(observed('cli-search').count,1);
  assert.equal(observed('cli-search').matchedText,report.marker);
  assert.equal(observed('cli-search-empty').count,0);
  assert.equal(observed('cli-search-clear').matchedText,report.marker);
  assert.equal(observed('cli-dry-run').dry.dryRun,true);
  assert.equal(observed('cli-dry-run').dry.wouldCreate.text,observed('cli-dry-run').input);
  assert.equal(observed('cli-dry-run').before,observed('cli-dry-run').after);
  assert.equal((await fetch(service.url+'/api/notes',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:'   '})})).status,400);
  await service.close();service=await sample.startServer({port:0,dataDir});
  assert.equal((await cli('list')).notes[0].text,'verifiable persistence');
  assert.match(await (await fetch(service.url)).text(),/保存笔记/);
});

test('explicit launch rejects a second live instance without losing cleanup ownership',async t=>{
  const packageRoot=await fs.mkdtemp(path.join(os.tmpdir(),'sample-launch-'));
  const root=path.join(packageRoot,'examples','verification-sample');
  await fs.mkdir(root,{recursive:true});
  await fs.mkdir(path.join(packageRoot,'src'));
  for(const file of ['business-contracts.mjs','paths.mjs'])await fs.copyFile(path.resolve('src',file),path.join(packageRoot,'src',file));
  await fs.copyFile(path.resolve('examples/verification-sample/driver.mjs'),path.join(root,'driver.mjs'));
  await fs.copyFile(path.resolve('examples/verification-sample/server.mjs'),path.join(root,'server.mjs'));
  const spawned=[];
  t.after(async()=>{
    for(const instance of spawned){
      try {
        const health=await (await fetch(instance.url+'/health',{signal:AbortSignal.timeout(1000)})).json();
        if(health.instanceId===instance.instanceId&&health.pid===instance.pid)process.kill(instance.pid,'SIGTERM');
      } catch {}
    }
    await new Promise(resolve=>setTimeout(resolve,100));
    await fs.rm(packageRoot,{recursive:true,force:true});
  });
  const driver=(...args)=>execute(process.execPath,[path.join(root,'driver.mjs'),...args]);
  const first=JSON.parse((await driver('launch','--port','0','--data-dir','.runtime/first')).stdout);
  spawned.push(first);
  const second=await driver('launch','--port','0','--data-dir','.runtime/second').then(
    result=>({exitCode:0,stderr:result.stderr}),
    error=>({exitCode:error.code,stderr:error.stderr})
  );
  assert.equal(second.exitCode,1);
  assert.match(second.stderr,/Active sample instance .*cleanup before explicit launch/);
  const pointer=JSON.parse(await fs.readFile(path.join(root,'.runtime','instance.json'),'utf8'));
  assert.equal(pointer.instanceId,first.instanceId);
  assert.equal(pointer.pid,first.pid);
  assert.equal((JSON.parse((await driver('doctor')).stdout)).instanceId,first.instanceId);
  const pointerFile=path.join(root,'.runtime','instance.json');
  await fs.writeFile(pointerFile,JSON.stringify({...pointer,pid:pointer.pid+1}));
  await assert.rejects(driver('doctor'),/Instance identity changed/);
  await fs.writeFile(pointerFile,JSON.stringify({...pointer,dataDir:path.join(root,'.runtime','wrong-data')}));
  await assert.rejects(driver('doctor'),/Instance identity changed/);
  await fs.writeFile(pointerFile,JSON.stringify(pointer));
  const serverFile=path.join(root,'server.mjs'),serverBytes=await fs.readFile(serverFile);
  await fs.appendFile(serverFile,'\n// changed after launch\n');
  await assert.rejects(driver('doctor'),/Instance build changed/);
  await fs.writeFile(serverFile,serverBytes);
  assert.equal((JSON.parse((await driver('doctor')).stdout)).pid,first.pid);
  const cleanup=JSON.parse((await driver('cleanup')).stdout);
  assert.equal(cleanup.instanceId,first.instanceId);
});
