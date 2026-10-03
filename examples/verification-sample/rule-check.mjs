import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {startServer} from './server.mjs';

const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');

export async function checkSampleApi() {
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'codex-rule-check-'));
  const events=[];
  let service;
  const cases=[];
  try {
    service=await startServer({port:0,dataDir,logger:event=>events.push(event)});
    const url=`${service.url}/api/notes`;
    const post=(body,contentType='application/json',requestId)=>fetch(url,{method:'POST',headers:{'content-type':contentType,...(requestId?{'idempotency-key':requestId}:{})},body});
    const before=await (await fetch(url)).json();
    assert.deepEqual(before.notes,[]);
    assert.equal((await post('{"text":"must not save"}','text/plain')).status,415);
    cases.push('wrong_content_type_rejected');
    for(const [name,body] of [
      ['malformed_json','{'],['missing_text','{}'],['wrong_field_type','{"text":17}'],
      ['empty_text','{"text":"   "}'],['too_long',JSON.stringify({text:'界'.repeat(2001)})]
    ]) {assert.equal((await post(body)).status,400,name);cases.push(`${name}_rejected`);}
    assert.deepEqual((await (await fetch(url)).json()).notes,[],'Invalid requests must not write a note');
    cases.push('invalid_requests_no_write');
    const saved=await post(JSON.stringify({text:'  合法笔记  '}));
    assert.equal(saved.status,201);
    const note=(await saved.json()).note;
    assert.equal(note.text,'合法笔记');
    assert.deepEqual((await (await fetch(url)).json()).notes,[note]);
    cases.push('legal_create_and_readback');
    const file=path.join(dataDir,'notes.json');
    const preserved=await fs.readFile(file);
    const dry=await post(JSON.stringify({text:'只预演',dryRun:true}));
    assert.equal(dry.status,200);
    assert.equal((await dry.json()).dryRun,true);
    assert.equal(sha(await fs.readFile(file)),sha(preserved));
    cases.push('dry_run_no_write');
    await fs.writeFile(file,'FAKE_PASSWORD_DO_NOT_EXPOSE');
    const broken=await fetch(url),publicResult=await broken.json();
    assert.equal(broken.status,500);
    assert.match(publicResult.eventId,/^[a-f0-9-]{36}$/);
    assert.ok(!JSON.stringify(publicResult).includes('FAKE_PASSWORD'));
    assert.equal(events.length,1);
    assert.equal(events[0].eventId,publicResult.eventId);
    assert.ok(!JSON.stringify(events).includes('FAKE_PASSWORD'));
    cases.push('internal_failure_redacted_and_correlated');
    await fs.writeFile(file,preserved);
    assert.deepEqual((await (await fetch(url)).json()).notes,[note]);
    cases.push('failure_recovered_and_data_preserved');
    const requestId=crypto.randomUUID();
    const identified=(text,key=requestId)=>post(JSON.stringify({text}),'application/json',key);
    const first=await identified('同一请求只创建一次');
    assert.equal(first.status,201);
    const firstNote=(await first.json()).note;
    assert.deepEqual((await (await fetch(`${url}?requestId=${requestId}`)).json()).notes,[firstNote]);
    const replay=await identified('同一请求只创建一次');
    assert.equal(replay.status,200);
    assert.deepEqual((await replay.json()).note,firstNote);
    assert.equal((await identified('冲突正文')).status,409);
    assert.equal((await post(JSON.stringify({text:'坏标识'}),'application/json','not-a-uuid')).status,400);
    const parallel=await Promise.all(Array.from({length:8},(_,index)=>
      post(JSON.stringify({text:`并发笔记 ${index}`}),'application/json',crypto.randomUUID())));
    assert(parallel.every(response=>response.status===201));
    const parallelNotes=await Promise.all(parallel.map(response=>response.json()));
    const all=(await (await fetch(url)).json()).notes;
    assert.equal(all.length,10);
    assert.equal(new Set(all.map(item=>item.id)).size,10);
    for(const item of parallelNotes)assert(all.some(note=>note.id===item.note.id&&note.text===item.note.text));
    cases.push('idempotent_replay_conflict_and_parallel_no_loss');
    await service.close();service=await startServer({port:0,dataDir,logger:event=>events.push(event)});
    const restartedUrl=`${service.url}/api/notes`;
    const afterRestart=await fetch(restartedUrl,{method:'POST',headers:{'content-type':'application/json','idempotency-key':requestId},body:JSON.stringify({text:'同一请求只创建一次'})});
    assert.equal(afterRestart.status,200);
    assert.deepEqual((await afterRestart.json()).note,firstNote);
    assert.equal((await (await fetch(restartedUrl)).json()).notes.length,10);
    cases.push('idempotency_survives_restart');
    return {status:'passed',cases,dataScope:'new isolated loopback temp directory',businessAcceptance:false};
  } finally {
    if(service)await service.close();
    const realTemp=await fs.realpath(os.tmpdir());
    const realDir=await fs.realpath(dataDir);
    assert(realDir.startsWith(realTemp+path.sep),'Refusing cleanup outside temp');
    await fs.rm(realDir,{recursive:true,force:true});
  }
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {console.log(JSON.stringify(await checkSampleApi()));}
  catch(error) {console.error(error);process.exitCode=1;}
}
