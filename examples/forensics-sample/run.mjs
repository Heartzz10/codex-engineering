import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Session } from 'node:inspector';
import assert from 'node:assert/strict';

const here=path.dirname(fileURLToPath(import.meta.url));
const outputArg=process.argv.indexOf('--output');
const dir=outputArg>=0?path.resolve(process.argv[outputArg+1]):path.join(here,'artifacts',`RUN-${Date.now()}-${crypto.randomUUID().slice(0,8)}`);
assert.ok(dir.startsWith(path.join(here,'artifacts')+path.sep),'evidence output must remain in sample artifacts');
const save=async(name,value)=>fs.writeFile(path.join(dir,name),JSON.stringify(value,null,2)+'\n');
const digest=raw=>crypto.createHash('sha256').update(raw).digest('hex');

if(process.argv.includes('--worker')) {
  await fs.mkdir(dir,{recursive:true});
  const session=new Session(); session.connect();
  const post=(method,params={})=>new Promise((resolve,reject)=>session.post(method,params,(error,result)=>error?reject(error):resolve(result)));
  await post('Profiler.enable'); await post('Profiler.setSamplingInterval',{interval:500});
  let spinning=true, work=0;
  function forensicBusyLoop() {
    if(!spinning) return;
    const stop=performance.now()+350;
    while(performance.now()<stop) {for(let i=0;i<12000;i++) work+=Math.sqrt(i+work%11);}
  }
  async function capture(name) {
    await post('Profiler.start');
    forensicBusyLoop();
    await new Promise(resolve=>setTimeout(resolve,120));
    const {profile}=await post('Profiler.stop');
    await save(name,profile);
  }
  await capture('before.cpuprofile');
  spinning=false;
  await capture('suppressed.cpuprofile');
  await save('live-intervention.json',{intervention:'same live process: set spinning=false, re-run identical capture function',productCodeChanged:false,work,expectedMechanism:'forensicBusyLoop consumes CPU only while spinning=true',before:'before.cpuprofile',after:'suppressed.cpuprofile'});
  class ForensicProbeNote { constructor(id){this.id=id;this.payload='synthetic-'+id;} }
  globalThis.forensicRetainedNotes=Array.from({length:800},(_,i)=>new ForensicProbeNote(i));
  const chunks=[]; session.on('HeapProfiler.addHeapSnapshotChunk',({params})=>chunks.push(params.chunk));
  await post('HeapProfiler.enable'); await post('HeapProfiler.takeHeapSnapshot',{reportProgress:false});
  await fs.writeFile(path.join(dir,'retained.heapsnapshot'),chunks.join(''));
  globalThis.forensicRetainedNotes=null;
  session.disconnect();
  process.stdout.write(JSON.stringify({status:'captured',pid:process.pid,captures:['before.cpuprofile','suppressed.cpuprofile','retained.heapsnapshot'],externalCalls:0})+'\n');
} else {
  await fs.mkdir(dir,{recursive:true});
  const child=spawnSync(process.execPath,[fileURLToPath(import.meta.url),'--worker','--output',dir],{encoding:'utf8',env:{SystemRoot:process.env.SystemRoot||'',TEMP:os.tmpdir(),TMP:os.tmpdir()},timeout:30000});
  await fs.writeFile(path.join(dir,'capture-process.txt'),`exit=${child.status}\nstdout=${child.stdout}\nstderr=${child.stderr}\n`);
  assert.equal(child.status,0,child.stderr);
  const summarize=async name=>{
    const profile=JSON.parse(await fs.readFile(path.join(dir,name),'utf8'));
    const nodes=new Map(profile.nodes.map(n=>[n.id,n]));
    const rows=profile.samples.map((id,index)=>({sample:index,nodeId:id,microseconds:profile.timeDeltas[index],...nodes.get(id).callFrame}));
    await fs.writeFile(path.join(dir,name+'.samples.jsonl'),rows.map(row=>JSON.stringify(row)).join('\n')+'\n');
    const summary=new Map();
    for(const row of rows) {const key=`${row.functionName}@${row.url}:${row.lineNumber+1}`; const old=summary.get(key)||{functionName:row.functionName,url:row.url,line:row.lineNumber+1,samples:0,microseconds:0}; old.samples++;old.microseconds+=row.microseconds;summary.set(key,old);}
    return {file:name,samples:rows.length,durationMicroseconds:profile.endTime-profile.startTime,hotFrames:[...summary.values()].sort((a,b)=>b.microseconds-a.microseconds).slice(0,12)};
  };
  const before=await summarize('before.cpuprofile'), after=await summarize('suppressed.cpuprofile');
  const busyBefore=before.hotFrames.find(f=>f.functionName==='forensicBusyLoop');
  const busyAfter=after.hotFrames.find(f=>f.functionName==='forensicBusyLoop');
  assert.ok(busyBefore?.samples>10,'CPU artifact must actually sample busy function');
  assert.ok((busyAfter?.microseconds||0)<busyBefore.microseconds/4,'live suppression must reduce hot-frame observations');
  const heap=JSON.parse(await fs.readFile(path.join(dir,'retained.heapsnapshot'),'utf8'));
  const meta=heap.snapshot.meta,nf=meta.node_fields,ef=meta.edge_fields,nw=nf.length,ew=ef.length;
  const ni=Object.fromEntries(nf.map((x,i)=>[x,i])), ei=Object.fromEntries(ef.map((x,i)=>[x,i]));
  const count=heap.nodes.length/nw,reverse=Array.from({length:count},()=>[]),nodes=[];
  let edgeOffset=0;
  for(let n=0;n<count;n++) {
    const offset=n*nw, type=meta.node_types[0][heap.nodes[offset+ni.type]], name=heap.strings[heap.nodes[offset+ni.name]];
    nodes.push({index:n,type,name,id:heap.nodes[offset+ni.id],selfSize:heap.nodes[offset+ni.self_size]});
    for(let j=0;j<heap.nodes[offset+ni.edge_count];j++) {
      const at=edgeOffset+j*ew, et=meta.edge_types[0][heap.edges[at+ei.type]],rawName=heap.edges[at+ei.name_or_index],target=heap.edges[at+ei.to_node]/nw;
      if(et!=='weak') reverse[target].push({from:n,type:et,name:['element','hidden'].includes(et)?String(rawName):heap.strings[rawName]});
    }
    edgeOffset+=heap.nodes[offset+ni.edge_count]*ew;
  }
  const probe=nodes.find(n=>n.type==='object'&&n.name==='ForensicProbeNote'); assert.ok(probe);
  const queue=[probe.index],seen=new Set(queue),toward=new Map();let at=0;
  while(at<queue.length&&!seen.has(0)) {const target=queue[at++];for(const edge of reverse[target]) if(!seen.has(edge.from)){seen.add(edge.from);toward.set(edge.from,{to:target,edge});queue.push(edge.from);}}
  assert.ok(seen.has(0),'retained instance must connect to GC root');
  const chain=[];let current=0;
  while(current!==probe.index){const hop=toward.get(current);chain.push({from:nodes[current],edge:hop.edge,to:nodes[hop.to]});current=hop.to;}
  assert.ok(chain.some(x=>x.edge.name==='forensicRetainedNotes'),'retainer path must identify the live holding property');
  await fs.writeFile(path.join(dir,'heap.nodes.jsonl'),nodes.map(x=>JSON.stringify(x)).join('\n')+'\n');
  await save('heap-retainer-chain.json',{query:'object nodes named ForensicProbeNote; breadth-first reverse edges excluding weak edges to root node 0',probeCount:nodes.filter(n=>n.type==='object'&&n.name==='ForensicProbeNote').length,chain});
  const report={status:'verified_synthetic_runtime_capture',scope:'Isolated Node process, synthetic data, no business application changes',before,after,mechanism:'Paired same-process suppression reduced observed CPU samples in forensicBusyLoop; diagnostic intervention, not a shipped performance fix.',unpairedInterpretation:'The before capture alone supports a bounded hot-path hypothesis; paired intervention adds causal support for this synthetic loop.',heap:{probeCount:nodes.filter(n=>n.type==='object'&&n.name==='ForensicProbeNote').length,retainerChain:'heap-retainer-chain.json'},uiTrace:{status:'not_run',reason:'This sample exposes a Node/CLI process, no UI surface. No claim of UI-trace coverage.'},cleanup:{workerExited:child.status===0,evidenceRetained:true},businessFee:0};
  await save('diagnosis.json',report);
  await fs.copyFile(fileURLToPath(import.meta.url),path.join(dir,'source-run.mjs'));
  const files=(await fs.readdir(dir)).filter(name=>name!=='manifest.json');
  const manifest=[];for(const name of files){const raw=await fs.readFile(path.join(dir,name));manifest.push({path:name,sha256:digest(raw),bytes:raw.length});}
  await save('manifest.json',{createdAt:new Date().toISOString(),files:manifest});
  process.stdout.write(JSON.stringify({status:report.status,busyBeforeSamples:busyBefore.samples,busyAfterSamples:busyAfter?.samples||0,probeCount:report.heap.probeCount,retainerEdges:chain.length,evidenceFiles:manifest.length,artifactDirectory:dir})+'\n');
}
