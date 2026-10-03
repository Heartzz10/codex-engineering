import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { PACKAGE_ROOT, json, assert, existingInside } from './paths.mjs';

const readCatalog = () => json(path.join(PACKAGE_ROOT, 'upstream/pstack/route-catalog.json'));
const infer = input => input.outcome === 'repair' ? 'bug-fix'
  : input.outcome === 'explanation' ? 'investigation'
  : input.outcome === 'diagnosis' && input.evidenceMode === 'captured' ? 'trace-forensics'
  : input.outcome === 'diagnosis' && input.evidenceMode === 'live' ? 'runtime-forensics' : null;

export async function routeTask(input = {}) {
  const catalog = await readCatalog();
  if ((input.outcome && !['repair','explanation','diagnosis'].includes(input.outcome)) || (input.evidenceMode && !['live','captured'].includes(input.evidenceMode)) || (input.taskScale && !['bounded','cross-cutting','unmatched','standing-program'].includes(input.taskScale))) return {status:'invalid_intent',action:'Use repair/explanation/diagnosis, live/captured, and bounded/cross-cutting/unmatched/standing-program, or an explicit catalog category.'};
  const inferred = infer(input);
  if (input.taskScale==='standing-program' && input.category && input.category!=='orchestrate') return {status:'intent_conflict',categoryId:input.category,metaRoute:'orchestrate',action:'Resolve whether this is a standing program or a bounded task.'};
  if (input.taskScale==='unmatched' && (input.category || inferred)) return {status:'intent_conflict',categoryId:input.category||inferred,metaRoute:'figure-it-out',action:'Check whether the named playbook actually matches before calling the task unmatched.'};
  if (input.category && inferred && input.category!==inferred && input.taskScale!=='standing-program') return {status:'intent_conflict',categoryId:input.category,inferredCategory:inferred,action:'Resolve the stated deliverable and evidence mode before selecting an execution workflow.'};
  if (['cross-cutting','unmatched'].includes(input.taskScale)) {
    const local = await json(path.join(PACKAGE_ROOT,'catalog/pstack-workflows.json'));
    assert(local.pinnedCommit===catalog.pinnedCommit,'fallback_catalog_version_mismatch');
    const nextAction=local.metaFallbacks?.['figure-it-out'];
    assert(nextAction && ['capability','operation','prerequisite','limit'].every(key=>typeof nextAction[key]==='string'&&nextAction[key]),'missing_local_meta_fallback');
    const source=catalog.categories.find(item=>item.categoryId==='investigation').sourceRef;
    return {status:'not_adopted',categoryId:null,metaRoute:'figure-it-out',pendingCategory:input.category||null,protocol:null,fallback:nextAction.operation,nextAction:{status:'local_fallback',...nextAction},pinnedCommit:catalog.pinnedCommit,sourceRef:{...source,lineStart:119,lineEnd:119}};
  }
  const category = input.taskScale==='standing-program' ? 'orchestrate' : input.category || inferred;
  const item = catalog.categories.find(r => r.categoryId === category);
  if (!category) return { status:'needs_intent', required:['category, or outcome and evidenceMode'], categories:catalog.categories.map(r => ({id:r.categoryId,trigger:r.trigger})), limits:'Natural-language intent is interpreted by the agent; this registry does not guess from keywords.' };
  if (!item) return {status:'unknown_category',categoryId:category,allowedCategories:catalog.categories.map(r=>r.categoryId)};
  const expectedOutcome = {'investigation':'explanation','bug-fix':'repair','runtime-forensics':'diagnosis','trace-forensics':'diagnosis'}[category];
  if ((input.outcome && expectedOutcome && input.outcome!==expectedOutcome) || (inferred && category !== inferred && input.taskScale!=='standing-program') || (category === 'runtime-forensics' && input.evidenceMode === 'captured') || (category === 'trace-forensics' && input.evidenceMode === 'live')) return {status:'intent_conflict',categoryId:category,inferredCategory:inferred,action:'Resolve the stated deliverable and evidence mode before selecting an execution workflow.'};
  const adopted = item.executionAdoption === 'adopted';
  const local = adopted ? null : await json(path.join(PACKAGE_ROOT,'catalog/pstack-workflows.json'));
  if (local) assert(local.pinnedCommit === catalog.pinnedCommit,'fallback_catalog_version_mismatch');
  const nextAction = adopted ? null : local.fallbacks?.[category];
  if (!adopted) assert(nextAction && ['capability','operation','prerequisite','limit'].every(key=>typeof nextAction[key]==='string' && nextAction[key]),'missing_local_fallback');
  return {status:adopted ? 'routed' : 'not_adopted', categoryId:category, metaRoute:input.taskScale==='standing-program'?'orchestrate':null, name:item.name, trigger:item.trigger, protocol:adopted ? 'debug plan' : null, fallback:adopted ? null : nextAction.operation, nextAction:adopted ? null : {status:'local_fallback',...nextAction}, pinnedCommit:catalog.pinnedCommit, sourceRef:item.sourceRef};
}

export async function getDebugProtocol(input = {}) {
  const route = await routeTask(input);
  if (route.status !== 'routed') return route;
  const catalog = await json(path.join(PACKAGE_ROOT,'catalog/pstack-workflows.json'));
  const workflow = catalog.workflows[route.categoryId];
  const lock = await json(path.join(PACKAGE_ROOT,'upstream/pstack/source-lock.json'));
  const paths = new Set([workflow.source]);
  for (const dep of workflow.dependencies) {
    for (const source of lock.files) if (source.path.startsWith(`pstack/skills/${dep.id}/`) && source.verificationStatus === 'verified') paths.add(source.path);
  }
  const sourceRefs = [];
  for (const sourcePath of paths) {
    const entry = lock.files.find(f=>f.path===sourcePath);
    assert(entry?.snapshotPath,'missing_pinned_source');
    const localPath = await existingInside(PACKAGE_ROOT,entry.snapshotPath);
    const bytes = await fs.readFile(localPath);
    const hash = crypto.createHash('sha1').update(Buffer.from(`blob ${bytes.length}\0`)).update(bytes).digest('hex');
    assert(hash===entry.blobSha,'pinned_source_changed');
    sourceRefs.push({path:sourcePath,localPath,blobSha:hash});
  }
  return {status:'protocol_ready',executed:false,categoryId:route.categoryId,pinnedCommit:catalog.pinnedCommit,...workflow,sourceRefs,
    requiredRecord:{projectId:'actual bound project',links:'FEAT/AC/CHG for repair; optional for read-only question',artifacts:'immutable raw evidence with hash, kind, project, surface, environment and role',hypotheses:'candidate, supporting/refuting evidence and scoped revert when trial changes were disproved'},
    instruction:'Read the selected pinned playbook and applicable dependency bodies from sourceRefs on demand. Follow project controls and current authorization. A returned protocol is not runtime verification.'};
}

export async function auditDebugEvidence(profile, input) {
  assert(input.projectId === profile.id,'wrong_project');
  const route = await routeTask(input);
  if (route.status !== 'routed') return route;
  assert(Array.isArray(input.artifacts),'artifacts_required');
  const root = await existingInside(profile.root,profile.featureMapRef?.evidenceDir || '.');
  const ids = new Set(), artifacts = [];
  for (const item of input.artifacts) {
    assert(typeof item.id==='string' && item.id && !ids.has(item.id),'duplicate_artifact_or_missing_id'); ids.add(item.id);
    assert(item.projectId===profile.id,'wrong_project_artifact');
    assert(/^[a-f0-9]{64}$/.test(item.sha256||''),'artifact_hash_required');
    const file = await existingInside(root,item.path), stat=await fs.stat(file);
    assert(stat.isFile() && stat.size > 0,'raw_artifact_required');
    const raw = await fs.readFile(file);
    assert(crypto.createHash('sha256').update(raw).digest('hex')===item.sha256,'artifact_hash_mismatch');
    artifacts.push({...item,absolutePath:file,bytes:raw.length});
  }
  const gaps=[], kinds=new Set(artifacts.map(a=>a.kind));
  const need = kind => {if(!kinds.has(kind)) gaps.push(`${kind}_evidence_required`);};
  const validRefs = refs => Array.isArray(refs) && refs.length>0 && refs.every(id=>ids.has(id));
  let confidenceCeiling='requires_human_or_agent_evidence_review', attribution='not_applicable';
  if(route.categoryId==='bug-fix') {
    need('mechanism');
    const before=artifacts.find(a=>a.kind==='reproduction'&&a.result==='failed');
    const after=artifacts.find(a=>a.kind==='replay'&&a.result==='passed');
    if(!before || !after || !['surface','environment','role'].every(k=>before[k] && before[k]===after[k])) gaps.push('same_surface_failed_then_passed_required');
    if(!input.links?.featureIds?.length || !input.links?.acIds?.length || !input.links?.changeId) gaps.push('feature_ac_change_links_required');
    if(!input.hypotheses?.some(h=>h.status==='supported'&&validRefs(h.evidenceIds))) gaps.push('supported_hypothesis_evidence_required');
    for(const h of input.hypotheses||[]) if(h.status==='refuted'&&h.editRefs?.length&&(!h.scopedRevert || !validRefs(h.revertEvidenceIds))) gaps.push(`refuted_edits_require_scoped_revert:${h.id}`);
    if(!validRefs(input.regression?.evidenceIds) || !['failing-first','alternative'].includes(input.regression?.mode) || (input.regression?.mode==='alternative'&&!input.regression.reason)) gaps.push('regression_or_explained_executable_alternative_required');
  } else if(route.categoryId==='runtime-forensics') {
    for(const kind of ['capture','reduced-finding','mechanism','symbol-map']) need(kind);
    if(!['cpu','heap','ui-trace'].includes(input.captureType)) gaps.push('appropriate_cpu_heap_or_ui_capture_required');
    attribution=kinds.has('symbol-map')?'provided_for_review':'unresolved_symbols';
  } else if(route.categoryId==='trace-forensics') {
    for(const kind of ['capture','queryable-data','reduced-finding']) need(kind);
    if(!kinds.has('symbol-map')&&!input.symbolGap) gaps.push('symbols_or_explicit_symbol_gap_required');
    attribution=kinds.has('symbol-map')?'provided_for_review':'unresolved_symbols';
    const pair=input.pairedCapture;
    const byId=new Map(artifacts.map(a=>[a.id,a]));
    const before=byId.get(pair?.beforeId), after=byId.get(pair?.afterId);
    const comparable=pair && pair.beforeId!==pair.afterId && before?.kind==='capture' && after?.kind==='capture' &&
      ['surface','environment','role'].every(key=>before[key] && before[key]===after[key]) &&
      validRefs(pair.comparisonEvidenceIds) && pair.comparisonEvidenceIds.every(id=>byId.get(id)?.kind==='paired-comparison');
    confidenceCeiling=comparable?'paired_comparison_available_for_review':'bounded_hypothesis';
  } else {
    need('code-anchor');
    if(input.motivationQuestion) {
      const required=['source-control','issues','documents','chat','observability','errors','analytics'];
      for(const category of required) {
        const record=input.sourceCoverage?.find(r=>r.category===category);
        if(!record || !['searched','empty','unavailable','justified_skip'].includes(record.status) || !record.detail || (record.status==='searched'&&!validRefs(record.evidenceIds))) gaps.push(`source_coverage_required:${category}`);
      }
    }
  }
  return {status:gaps.length?'blocked_evidence':'evidence_ready_for_review',categoryId:route.categoryId,projectId:profile.id,gaps,artifacts,confidenceCeiling,attribution,behaviorVerified:false,limits:'Checks evidence existence, hashes and declared coverage only. It cannot establish causal truth, UI operation or successful repair from labels. Register reviewed actual acceptance separately.'};
}
