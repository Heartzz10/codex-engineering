import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyFeatureDraft } from '../../src/feature.mjs';
import { VERSION, PACKAGE_ROOT, writeJson } from '../../src/paths.mjs';
const root=path.dirname(fileURLToPath(import.meta.url));
const entrypoints=['ui-create','ui-search','cli-create','cli-list','cli-search','cli-dry-run'];
const effects={writes:'test-artifacts',network:true,paid:false};
const sourceCheck=()=>({id:'ui-html-source',executable:process.execPath,args:[path.join(PACKAGE_ROOT,'scripts','ui-source-check.mjs'),'public/index.html'],cwd:'.',timeoutMs:30000,reviewed:true,authorizationRef:'GUIDE.md#UI-quality',effects:{writes:'none',network:false,paid:false},inputs:['public/index.html','ui-quality.json']});
export const profile={schemaVersion:2,id:'verification-sample',sharedVersion:VERSION,root,authoritativeDocuments:['GUIDE.md'],environmentRef:'isolated-loopback',uiQualityRef:'ui-quality.json',checks:[sourceCheck()],entrypoints:entrypoints.map(id=>({id,kind:'real',url:'http://127.0.0.1:43187/'})),featureMapRef:{schemaVersion:1,path:'docs/feature-map.json',historyDir:'docs/feature-history',evidenceDir:'evidence'},acceptanceRoutes:['ui','cli'].map(kind=>({id:`${kind}-driver`,kind,entrypointIds:entrypoints.filter(id=>id.startsWith(kind)),driverRef:kind==='ui'?'GUIDE.md#browser':'driver.mjs',available:true,real:true,effects,authorizationRef:'isolated-local-sample-no-paid-services',guards:{permissionRef:'sample-user',isolationRef:'sample-data-only'}})),controls:{schemaVersion:1,launch:{ref:'node driver.mjs launch',readySignal:'health.status=ready'},doctor:{ref:'node driver.mjs doctor',readOnly:true},drive:{ref:'GUIDE.md',entrypointIds:entrypoints},evidence:{ref:'evidence/*.json'},cleanup:{ref:'node driver.mjs cleanup',preservesEvidence:true},sourceReview:{ref:'GUIDE.md',inputs:['server.mjs','driver.mjs','public/index.html']},isolation:{instanceRef:'local-sample-port-43187',dataScopeRef:'sample-only',sessionExclusive:true}}};
const req=(key,intent,feature,decision='accepted',schedule='current')=>({key,intent,decision,decisionRef:'parent-task:authorized-isolated-verification-sample',schedule,featureIds:[`@${feature}`],openQuestions:[]});
const feature=(key,title,reqKey,entries,acs)=>({key,title,user:'sample-user',scenario:title,goal:title,scope:[title],exclusions:['external services','private data','production use'],humanAutomation:{human:'UI操作与语义观察',automation:'CLI操作、文件指纹与断言'},requirementIds:[`@${reqKey}`],dependencyIds:[],entrypointIds:entries,implementationRefs:[],acceptanceCriteria:acs.map(a=>`@${a}`),lifecycle:'active',deliveryStatus:'planned'});
const ac=(key,featureKey,reqKey,entry,method,expected)=>({key,featureId:`@${featureKey}`,requirementIds:[`@${reqKey}`],preconditions:['isolated local service healthy'],actions:(method==='ui'?entry==='ui-create'?['input','click','submit','wait','observe']:['input','click','wait','observe']:['invoke','observe']).map(type=>({type})),expected,verificationMethod:method,requiredEvidenceTypes:['execution'],dependencyRefs:[],implementationRefs:[],effects,assertions:[{id:'result',operator:'equals',path:'/verified',expected:true}],requiredTargets:[{targetId:entry,entrypointId:entry,roleRef:'sample-user',scenario:expected,environmentRef:'isolated-loopback',dataScopeRef:'sample-only'}]});
export const draft={recordedBy:'codex-agent',sourceRef:'parent-task:authorized-isolated-verification-sample',requirements:[req('req-notes','创建笔记并持久化；UI和CLI可搜索、CLI可列出','notes'),req('req-dry','dry-run必须不写入','dry'),req('req-sync','未来同步，当前不实施','sync','proposed','backlog')],features:[feature('notes','笔记创建与查询','req-notes',entrypoints.filter(x=>x!=='cli-dry-run'),['ui-create','ui-search','cli-create','cli-list','cli-search']),feature('dry','无副作用预演','req-dry',['cli-dry-run'],['cli-dry-run']),feature('sync','未来同步','req-sync',[],['ac-sync'])],acceptanceCriteria:[...entrypoints.map(entry=>ac(entry,entry==='cli-dry-run'?'dry':'notes',entry==='cli-dry-run'?'req-dry':'req-notes',entry,entry.startsWith('ui')?'ui':'cli',entry==='cli-dry-run'?'预演后数据未改变':entry.endsWith('create')?'输入笔记成功保存并读回':entry.endsWith('search')?'搜索返回匹配项，空结果和清除搜索可观察':'列出当前持久化笔记')),ac('ac-sync','sync','req-sync','future-sync','background','未来同步，未实现')],change:{type:'new',reason:'0→1隔离验证样例',decision:'accepted',decisionRef:'parent-task:authorized-isolated-verification-sample',requirementIds:['@req-notes','@req-dry'],featureIds:['@notes','@dry'],acIds:entrypoints.map(x=>`@${x}`),implementationRefs:[],migrationImpact:'新建隔离测试数据目录',recoveryImpact:'只停止样例进程；保留数据和证据'}};
export async function configureSampleProfile({sampleRoot=root}={}) {
  const profileFile=path.join(sampleRoot,'profile.json');
  let existing=null;
  try {existing=JSON.parse(await fs.readFile(profileFile,'utf8'));} catch(error) {if(error.code!=='ENOENT') throw error;}
  if(existing && !Array.isArray(existing.checks)) throw new Error('Existing sample checks must be an array; preserve and repair the profile explicitly');
  const next={...structuredClone(profile),...(existing||{}),root:sampleRoot,uiQualityRef:'ui-quality.json'};
  next.checks=[...(existing?.checks||[])];
  if(!next.checks.some(check=>check.id==='ui-html-source')) next.checks.push(sourceCheck());
  await writeJson(profileFile,next);
  return next;
}

async function bootstrap() {
  if(process.argv.includes('--init')) {
    try {await fs.access(path.join(root,'docs','feature-map.json')); throw new Error('Historical sample map exists; bootstrap --init must not reinitialize it');}
    catch(error) {if(error.code!=='ENOENT') throw error;}
  }
  const configured=await configureSampleProfile();
  await fs.mkdir(path.join(root,'evidence'),{recursive:true});
  await fs.writeFile(path.join(root,'initial-draft.json'),JSON.stringify(draft,null,2)+'\n',{flag:'wx'}).catch(error=>{if(error.code!=='EEXIST') throw error;});
  if(process.argv.includes('--init')) console.log(JSON.stringify(await applyFeatureDraft(configured,'init',draft,{expectedRevision:0,expectedHash:null,requestId:'sample-initial'}),null,2));
  else console.log(JSON.stringify({status:'configured',uiQualityRef:configured.uiQualityRef,checkIds:configured.checks.map(check=>check.id),mapInitialization:false}));
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) await bootstrap();
