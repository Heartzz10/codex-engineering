import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url)),runtime=path.join(root,'.runtime'),evidenceDir=path.join(root,'evidence');
const args=process.argv.slice(2),command=args[0],at=key=>args[args.indexOf(key)+1],hash=data=>crypto.createHash('sha256').update(data).digest('hex');
const readInstance=async()=>JSON.parse(await fs.readFile(path.join(runtime,'instance.json'),'utf8'));
const instance=async()=>args.includes('--url')?{url:at('--url')}:readInstance();
const request=async(url,options)=>{const response=await fetch(url,{...options,signal:AbortSignal.timeout(4000)});const data=await response.json();if(!response.ok)throw new Error(data.error||`HTTP ${response.status}`);return data;};
const sourceHash=async()=>hash(await fs.readFile(path.join(root,'server.mjs')));
const sameProcess=(info,health)=>health.status==='ready'&&info.instanceId===health.instanceId&&info.pid===health.pid&&typeof info.dataDir==='string'&&typeof health.dataDir==='string'&&path.resolve(info.dataDir)===path.resolve(health.dataDir);
const sameBuild=async(info,health)=>health.sourceHash&&info.sourceHash===health.sourceHash&&health.sourceHash===await sourceHash();
async function assertHealthy(info,health) {
  if(!sameProcess(info,health))throw new Error('Instance identity changed');
  if(!await sameBuild(info,health))throw new Error('Instance build changed; cleanup before driving');
}
async function writeEvidence(type,data) {await fs.mkdir(evidenceDir,{recursive:true});const file=`${type}-${Date.now()}-${crypto.randomUUID()}.json`,body=JSON.stringify(data,null,2);await fs.writeFile(path.join(evidenceDir,file),body,{flag:'wx'});return {path:`evidence/${file}`,sha256:hash(body)};}
try {
  let result;
  if(command==='launch') {
    await fs.mkdir(runtime,{recursive:true});
    let active=null;
    try {const old=await readInstance();const health=await request(old.url+'/health');if(sameProcess(old,health))active={...old,buildCurrent:await sameBuild(old,health)};}catch{}
    if(active) {
      if(!active.buildCurrent)throw new Error('Active sample build changed; cleanup before launch');
      if(args.includes('--port')||args.includes('--data-dir'))throw new Error(`Active sample instance ${active.instanceId}; cleanup before explicit launch`);
      const {buildCurrent,...ready}=active;console.log(JSON.stringify({...ready,reused:true}));process.exit(0);
    }
    const instanceId=crypto.randomUUID(),port=args.includes('--port')?at('--port'):'43187';
    const dataDir=args.includes('--data-dir')?path.resolve(root,at('--data-dir')):runtime;
    if(dataDir!==runtime&&!dataDir.startsWith(runtime+path.sep))throw new Error('Isolated data directory must be inside .runtime');
    await fs.mkdir(dataDir,{recursive:true});
    const logfile=await fs.open(path.join(runtime,'server.log'),'a');
    const child=spawn(process.execPath,[path.join(root,'server.mjs'),'--port',port,'--data-dir',dataDir,'--instance',instanceId],{cwd:root,detached:true,windowsHide:true,stdio:['ignore',logfile.fd,logfile.fd]});child.unref();await logfile.close();
    const deadline=Date.now()+5000;
    while(Date.now()<deadline) {try{const info=JSON.parse(await fs.readFile(path.join(dataDir,'instance.json'),'utf8'));if(info.instanceId===instanceId){await assertHealthy(info,await request(info.url+'/health'));result=info;break;}}catch{}await new Promise(r=>setTimeout(r,100));}
    if(!result)throw new Error('Launch failed: inspect .runtime/server.log');
    await fs.writeFile(path.join(runtime,'instance.json'),JSON.stringify(result,null,2));
    result={...result,artifact:await writeEvidence('launch',result)};
  } else if(command==='doctor') {const info=await instance();result=await request(info.url+'/health');if(info.instanceId)await assertHealthy(info,result);else if(result.status!=='ready')throw new Error('Instance not ready');}
  else if(command==='cleanup') {
    const info=await readInstance();const health=await request(info.url+'/health');
    if(!sameProcess(info,health))throw new Error('Refusing cleanup: instance mismatch');
    process.kill(info.pid,'SIGTERM');result={stoppedPid:info.pid,instanceId:info.instanceId,preservedEvidence:true,artifact:await writeEvidence('cleanup',{...info,preservedEvidence:true})};
  } else if(['create','list','search','dry-run'].includes(command)) {
    const info=await instance(),{url}=info;
    if(info.instanceId)await assertHealthy(info,await request(url+'/health'));
    if(command==='create'||command==='dry-run') result=await request(url+'/api/notes',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:args[1],dryRun:command==='dry-run'})});
    else result=await request(url+'/api/notes'+(command==='search'?'?q='+encodeURIComponent(args[1]||''):''));
  } else if(command==='verify-cli') {
    const info=await instance(),health=await request(info.url+'/health'),execute=promisify(execFile),run=async(...a)=>JSON.parse((await execute(process.execPath,[fileURLToPath(import.meta.url),...a,'--url',info.url])).stdout);
    if(info.instanceId)await assertHealthy(info,health);
    const marker='CLI验收-'+crypto.randomUUID(),observations=[];
    const create=await run('create',marker),readback=(await run('list')).notes.find(n=>n.id===create.note.id);
    observations.push({entrypointId:'cli-create',targetId:'cli-create',actual:{input:marker,note:create.note,readback}});
    const list=await run('list');observations.push({entrypointId:'cli-list',targetId:'cli-list',actual:{input:marker,notes:list.notes,texts:list.notes.map(n=>n.text),matchedText:list.notes.find(n=>n.id===create.note.id)?.text}});
    const search=await run('search',marker),empty=await run('search','absent-'+marker),clear=await run('search','');
    observations.push({entrypointId:'cli-search',targetId:'cli-search',actual:{input:marker,notes:search.notes,count:search.notes.length,matchedText:search.notes[0]?.text}});
    observations.push({entrypointId:'cli-search',targetId:'cli-search-empty',actual:{notes:empty.notes,count:empty.notes.length}});
    observations.push({entrypointId:'cli-search',targetId:'cli-search-clear',actual:{input:marker,notes:clear.notes,texts:clear.notes.map(n=>n.text),matchedText:clear.notes.find(n=>n.id===create.note.id)?.text}});
    const proposed='预演-'+marker,before=hash(await fs.readFile(path.join(health.dataDir,'notes.json'))),dry=await run('dry-run',proposed),after=hash(await fs.readFile(path.join(health.dataDir,'notes.json')));
    observations.push({entrypointId:'cli-dry-run',targetId:'cli-dry-run',actual:{input:proposed,dry,before,after}});
    result={projectId:'verification-sample',executedAt:new Date().toISOString(),marker,instance:{...info,...health},observations};
    if(!args.includes('--url'))result.artifact=await writeEvidence('cli-observations',result);
  } else throw new Error('Use launch | doctor | cleanup | create TEXT | list | search TEXT | dry-run TEXT | verify-cli');
  console.log(JSON.stringify(result,null,2));
} catch(error) {console.error(error.message);process.exitCode=1;}
