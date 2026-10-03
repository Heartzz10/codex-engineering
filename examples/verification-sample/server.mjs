import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {publicError,businessEvent} from '../../src/business-contracts.mjs';
const root=path.dirname(fileURLToPath(import.meta.url));
export async function startServer({port=43187,dataDir=path.join(root,'.runtime'),instanceId=crypto.randomUUID(),logger=null}={}) {
  await fs.mkdir(dataDir,{recursive:true});
  const sourceHash=crypto.createHash('sha256').update(await fs.readFile(fileURLToPath(import.meta.url))).digest('hex');
  const dataFile=path.join(dataDir,'notes.json');
  const read=async()=>{try{return JSON.parse(await fs.readFile(dataFile,'utf8'));}catch(e){if(e.code==='ENOENT')return [];throw e;}};
  let writes=Promise.resolve();
  const server=http.createServer(async(req,res)=>{
    const send=(status,value)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(value));};
    try {
      const url=new URL(req.url,'http://127.0.0.1');
      if(req.method==='GET'&&url.pathname==='/health')return send(200,{status:'ready',instanceId,pid:process.pid,dataDir,sourceHash});
      if(req.method==='GET'&&url.pathname==='/') {res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'});return res.end(await fs.readFile(path.join(root,'public/index.html')));}
      if(req.method==='GET'&&url.pathname==='/api/notes') {
        await writes;const query=(url.searchParams.get('q')||'').toLowerCase(),requestId=url.searchParams.get('requestId');
        if(requestId&&!/^[a-f0-9-]{36}$/i.test(requestId))return send(400,{error:'请求标识格式错误'});
        return send(200,{notes:(await read()).filter(n=>(!requestId||n.requestId===requestId)&&n.text.toLowerCase().includes(query))});
      }
      if(req.method==='POST'&&url.pathname==='/api/notes') {
        if(!/^application\/json(?:\s*;|\s*$)/i.test(req.headers['content-type']||''))return send(415,{error:'请使用 JSON 请求格式'});
        let body='';for await(const chunk of req){body+=chunk;if(body.length>16384)return send(413,{error:'正文过长'});}
        let input;try{input=JSON.parse(body);}catch{return send(400,{error:'请求格式错误'});}
        const text=typeof input.text==='string'?input.text.trim():'';
        if(!text||text.length>2000)return send(400,{error:'请输入 1–2000 字的笔记正文'});
        if(input.dryRun===true)return send(200,{dryRun:true,wouldCreate:{text}});
        const requestId=req.headers['idempotency-key'];
        if(requestId!==undefined&&(typeof requestId!=='string'||!/^[a-f0-9-]{36}$/i.test(requestId)))return send(400,{error:'请求标识格式错误'});
        const operation=writes.then(async()=>{
          const notes=await read();
          const existing=requestId&&notes.find(n=>n.requestId===requestId);
          if(existing)return existing.text===text?{status:200,note:existing,replayed:true}:{status:409,error:'该请求标识已用于另一条笔记'};
          const note={id:crypto.randomUUID(),text,createdAt:new Date().toISOString(),...(requestId?{requestId}:{})};
          notes.push(note);const temp=dataFile+'.tmp';await fs.writeFile(temp,JSON.stringify(notes,null,2));await fs.rename(temp,dataFile);
          return {status:201,note};
        });
        writes=operation.then(()=>{},()=>{});
        const result=await operation;return send(result.status,result.error?{error:result.error}:{note:result.note,replayed:result.replayed||false});
      }
      send(404,{error:'入口不存在'});
    } catch(error) {
      const eventId=crypto.randomUUID();
      const problem=publicError(error,{},eventId);
      // An optional project sink receives only selected fields; raw exception/body is excluded.
      if(logger) {try {logger(businessEvent({event:'notes.request_failed',time:new Date().toISOString(),level:'error',outcome:'unknown',eventId}));} catch { /* Sink failure must not leak its own error into the user response. */ }}
      send(500,{error:problem.message,eventId});
    }
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  return {url:`http://127.0.0.1:${server.address().port}`,instanceId,sourceHash,close:()=>new Promise((resolve,reject)=>server.close(e=>e?reject(e):resolve()))};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const at=key=>process.argv[process.argv.indexOf(key)+1];
  const dataDir=process.argv.includes('--data-dir')?path.resolve(at('--data-dir')):path.join(root,'.runtime');
  const instanceId=at('--instance');
  const service=await startServer({port:process.argv.includes('--port')?Number(at('--port')):43187,dataDir,instanceId});
  const instance={url:service.url,instanceId:service.instanceId,pid:process.pid,startedAt:new Date().toISOString(),dataDir,sourceHash:service.sourceHash};
  await fs.writeFile(path.join(dataDir,'instance.json'),JSON.stringify(instance,null,2));
  console.log(JSON.stringify(instance));
  for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>service.close().then(()=>process.exit(0)));
}
