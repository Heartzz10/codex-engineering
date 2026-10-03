import { parseArgs } from 'node:util';
import { rollbackInstallation } from './rollback.mjs';
import path from 'node:path';
import { loadProfile } from './profile.mjs';
import { runCheck } from './runner.mjs';
import { chooseCostPolicy, summarizeDeliveryCost, assessRetry } from './cost-policy.mjs';
import { summarizeUsage } from './usage.mjs';
import { queryRecords, rebuildRecordsIndex } from './records.mjs';
import { selectResources } from './catalog.mjs';
import { loadModelCapabilities } from './capabilities.mjs';
import { resolveProjectBinding } from './binding.mjs';
import { DEFAULT_STATE, PACKAGE_ROOT, VERSION, json, assert } from './paths.mjs';
import fs from 'node:fs/promises';
import { readMap, parseStrictJson, rebuildProjection, recoverLock } from './feature-store.mjs';
import { applyFeatureDraft, featureShow, featureImpact, featureCheck, recordImpact, recordAcceptance, closeFeatureChange } from './feature.mjs';
import { planAcceptance, assessAcceptance } from './acceptance.mjs';
import { startupReadiness } from './startup-readiness.mjs';

const strictFile = async file => parseStrictJson(await fs.readFile(file, 'utf8'));
function compact(result) {
  if (Buffer.byteLength(JSON.stringify(result)) <= 2048) return result;
  const counts = Object.fromEntries(Object.entries(result).filter(([,v]) => Array.isArray(v)).map(([k,v]) => [k, v.length]));
  return { status: result.status, projectId: result.projectId, revision: result.revision, contentHash: result.contentHash, truncated: true, counts: result.counts || counts, blockerCount: result.blockerCount ?? result.gaps?.length, changeId: result.changeId, runId: result.runId, runHash: result.runHash, mapRef: result.mapRef, detailRef: result.journalPath || result.detailRef, action: 'Use --output FILE for the complete result or feature show --ids ID; truncation is not a pass.' };
}

async function main() {
  const rawArgs = process.argv.slice(2);
  if (['context', 'context-relevance'].includes(rawArgs[0])) {
    const result = rawArgs[0] === 'context'
      ? await (await import('../scripts/task-context.mjs')).runTaskContextCommand(rawArgs.slice(1))
      : await (await import('../scripts/context-relevance.mjs')).runContextRelevanceCommand(rawArgs.slice(1));
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (['blocked', 'failed', 'stale', 'recovery_required'].includes(result.status)) process.exitCode = 2;
    return;
  }
  const { values: v, positionals } = parseArgs({ allowPositionals: true, options: {
    profile: { type: 'string' }, project: { type: 'string' }, check: { type: 'string' }, 'state-root': { type: 'string' },
    'repeat-reason': { type: 'string' }, task: { type: 'string' }, models: { type: 'string' },
    'new-evidence': { type: 'string', multiple: true },
    run: { type: 'string' }, file: { type: 'string', multiple: true }, scope: { type: 'string' },
    query: { type: 'string' }, rebuild: { type: 'boolean' }, help: { type: 'boolean' }, apply: { type: 'boolean' },
    draft: { type: 'string' }, change: { type: 'string' }, ids: { type: 'string' }, diff: { type: 'string' }, evidence: { type: 'string' },
    'expected-revision': { type: 'string' }, 'expected-hash': { type: 'string' }, 'request-id': { type: 'string' }, preview: { type: 'boolean' },
    resume: { type: 'string' }, report: { type: 'string' }, 'expected-run-hash': { type: 'string' }, output: { type: 'string' }, input: { type: 'string' },
    out: { type: 'string' }, 'approved-sha': { type: 'string' }, 'budget-usd': { type: 'string' }, 'max-requests': { type: 'string' },
    ledger: { type: 'string' }, 'key-config': { type: 'string' }, 'timeout-ms': { type: 'string' }, cache: { type: 'string' }, enabled: { type: 'string' }, dataset: { type: 'string' }, costs: { type: 'string' }, purpose: { type: 'string' }
  } });
  const command = positionals[0];
  const stateRoot = path.resolve(v['state-root'] || DEFAULT_STATE);
  let result;
  if (command === 'judge' && v.help) {
    const { runJudgmentCommand } = await import('../scripts/engineering-judge.mjs');
    result = await runJudgmentCommand(['--help']);
  } else if (v.help || !command) {
    result = { version: VERSION, commands: {
      doctor: '(--profile FILE | --project DIR) [--task FILE --models FILE]',
      run: '--profile FILE --check ID [--repeat-reason TEXT] [--new-evidence PROJECT_RELATIVE_FILE]',
      usage: '--run SESSION_ID --file ROLLOUT_JSONL [--file CHILD_JSONL]',
      records: '[--rebuild] [--scope global|project:ID --query TEXT]',
      context: 'prepare|resume (--profile FILE|--project DIR) [--task FILE --change ID|--ids AC_IDS] --out NEW_FILE [resume --from SAVED_CONTEXT]; local only',
      'context-relevance': 'prepare --input PACKET --out BUNDLE | run --input BUNDLE --out RESULT [--purpose daily|validation]; validation only, daily remains local',
      rules: 'prepare|run|assess --profile FILE [--scope ui,interaction,errors,logs,permissions,data,architecture,external] [--output FULL_JSON]; reuses registered checks and existing acceptance',
      rollback: '[--apply] (without --apply: preflight only)'
      , feature: 'init|change|show|impact|check|continuity|close|project|recover-lock --profile FILE [--draft FILE --expected-revision N --expected-hash HASH|absent --request-id ID]',
      accept: 'plan|record|assess --profile FILE --change ID [--evidence FILE --run ID + CAS options]',
      verify: 'maintain --profile FILE --run ID [--resume ID --report FILE --expected-run-hash HASH] | recover-lock --profile FILE (dead owner only)'
      , task: 'route --input FILE', debug: 'plan|audit --input FILE [--profile FILE]',
      model: 'route|cost|retry --input FILE [--models FILE]', understand: 'check --input FILE',
      visual: 'assess --input FILE (measured snapshot and constraints; not a screenshot verdict)',
      ui: 'prepare|derive|assess|source --input FILE | prepare|source --profile FILE | review --file ORIGINAL [--file ORIGINAL] [--input REVIEW_MANIFEST] [--output FULL_PLAN]'
      , judge: 'plan|project (--profile FILE|--project DIR) (--change ID|--ids AC_IDS) --out FILE [--purpose daily|validation]; review|prepare|run|evaluate --input FILE --out FILE; judge --help for usage'
    }, stateRoot, packageRoot: PACKAGE_ROOT, limits: 'No global interception; no model switching; real acceptance is separate from process checks.' };
  } else if (command === 'doctor') {
    assert(!(v.profile && v.project), 'Choose --profile or --project, not both');
    let profileFile = v.profile, binding = null;
    if (!profileFile) {
      assert(v.project, '--profile or --project is required');
      binding = await resolveProjectBinding(stateRoot, path.resolve(v.project));
      if (binding.status !== 'bound') {
        process.stdout.write(`${JSON.stringify({ ...binding, version: VERSION, action: 'Resolve the project binding; do not substitute another project.' })}\n`);
        process.exitCode = 2;
        return;
      }
      profileFile = binding.profile;
    }
    const p = await loadProfile(profileFile, { allowMissingDocuments: true });
    const task = v.task ? await json(v.task) : { kind: 'verification', scopeClear: true, risk: 'medium', independent: false, workType: 'analysis' };
    const capability = v.models
      ? { status: 'available', reason: '', source: '--models', scope: 'caller-provided', models: await json(v.models) }
      : await loadModelCapabilities(stateRoot);
    if (v.models) assert(Array.isArray(capability.models), '--models must contain an array');
    const models = capability.status === 'available' ? capability.models : [];
    const costPolicy = chooseCostPolicy(task, models);
    // A local snapshot describes subagent choices, not the main conversation.
    if (!v.models && costPolicy.executor !== 'subagent') {
      costPolicy.recommendedModel = null;
      costPolicy.recommendedEffort = null;
      costPolicy.supportStatus = 'unavailable';
    }
    const startup = startupReadiness(p, task);
    result = { status: startup.status === 'needs_setup' ? 'needs_setup' : 'ready_for_registered_checks', version: VERSION, packageRoot: PACKAGE_ROOT, projectId: p.id, root: p.root, binding,
      authoritativeDocuments: p.authoritativeDocuments, missingAuthoritativeDocuments: p.missingAuthoritativeDocuments, missingFeatureMapDocument: p.missingFeatureMapDocument,
      checks: p.checks.map(c => ({ id: c.id, effects: c.effects })),
      entrypoints: p.entrypoints || [], costPolicy,
      startup,
      featureMapStatus: p.featureMapStatus, featureMapDocument: p.featureMapDocument || null, featureMapRef: p.featureMapRef || null, compatibility: p.compatibility,
      registeredCheckCount: p.checks.length, controls: p.controls || null, acceptanceRoutes: p.acceptanceRoutes || [],
      uiQuality: {status:p.uiQualityStatus,ref:p.uiQualityRef||null,action:p.uiQuality?'ui prepare --profile PROFILE':'Configure applicable UI categories before claiming new coverage.'},
      engineeringRules: {status:p.engineeringRules?'configured':'not_configured',ref:p.engineeringRulesRef||null,action:'rules prepare --profile PROFILE; not a business acceptance claim'},
      capabilityStatus: { status: capability.status, reason: capability.reason, source: capability.source,
        scope: capability.scope, observedAt: capability.observedAt || null, expiresAt: capability.expiresAt || null },
      selectedResources: await selectResources(task, p),
      limits: ['Role and live environment must be checked at the real entry.', 'Recommended model/effort is not an applied setting.'] };
  } else if (command === 'rules') {
    assert(v.profile, '--profile required');
    const p=await loadProfile(v.profile);
    const {prepareEngineeringRules,runEngineeringRules,assessEngineeringRules}=await import('./engineering-rules.mjs');
    const scope=v.scope?v.scope.split(','):undefined;
    const options={stateRoot,scope,repeatReason:v['repeat-reason']||'',newEvidence:v['new-evidence']||[]};
    if(positionals[1]==='prepare')result=await prepareEngineeringRules(p,scope);
    else if(positionals[1]==='run')result=await runEngineeringRules(p,options);
    else if(positionals[1]==='assess')result=await assessEngineeringRules(p,options);
    else throw Error('Unknown rules subcommand');
    if(!['ready','passed','not_applicable'].includes(result.status))process.exitCode=2;
  } else if (command === 'judge') {
    const { runJudgmentCommand } = await import('../scripts/engineering-judge.mjs');
    const allowed = ['input','out','approved-sha','budget-usd','max-requests','ledger','key-config','timeout-ms','cache','enabled','dataset','costs', ...(['plan','project'].includes(positionals[1]) ? ['profile','project','change','ids','purpose'] : [])];
    const args = [positionals[1] || '--help', ...allowed.flatMap(key => v[key] === undefined ? [] : [`--${key}`, v[key]]), ...(['run','review','plan','project'].includes(positionals[1]) ? ['--state-root', stateRoot] : [])];
    result = await runJudgmentCommand(args);
    if (result.status && !['completed','disabled','review_fallback','planned'].includes(result.status)) process.exitCode = 2;
  } else if (command === 'model') {
    assert(v.input, '--input required'); const input = await strictFile(v.input);
    if (positionals[1] === 'route') {
      const capability = v.models ? { models: await strictFile(v.models) } : await loadModelCapabilities(stateRoot);
      result = chooseCostPolicy(input, capability.models || []);
      if (!v.models && result.executor !== 'subagent') { result.recommendedModel = null; result.recommendedEffort = null; result.supportStatus = 'unavailable'; }
    } else if (positionals[1] === 'cost') result = summarizeDeliveryCost(input);
    else if (positionals[1] === 'retry') result = assessRetry(input.attempts, input.nextAttempt);
    else throw Error('Unknown model subcommand');
    if (result.action === 'stop-and-investigate' || result.supportStatus === 'unsupported') process.exitCode = 2;
  } else if (command === 'understand' && positionals[1] === 'check') {
    assert(v.input, '--input required'); const input = await strictFile(v.input);
    const { evaluateUnderstanding, checkUnderstanding } = await import('./understanding.mjs');
    result = input.decisionBindings ? await checkUnderstanding({ ...input, stateRoot }) : evaluateUnderstanding(input);
    if (result.status !== 'accepted') process.exitCode = 2;
  } else if (command === 'ui') {
    const {deriveUIQualityConfig,prepareUIQuality,assessUIQualityCoverage}=await import('./ui-quality.mjs');
    const p=v.profile?await loadProfile(v.profile):null;
    const input=v.input?await strictFile(v.input):null;
    const sub=positionals[1];
    if(sub==='derive') {assert(input,'--input required');result=deriveUIQualityConfig(input);}
    else if(sub==='prepare') result=p?.uiQuality?prepareUIQuality(p.uiQuality):input?prepareUIQuality(input.config||input):{status:'not_configured',limits:'New UI quality coverage has not been configured.'};
    else if(sub==='assess') {assert(input,'--input required');result=assessUIQualityCoverage(p?.uiQuality||input.config,input.observations||[],{...(input.context||{}),...(p?{environmentRef:p.environmentRef}:{})});}
    else if(sub==='source') {const {assessUISource,runUISourceChecks}=await import('./ui-source-check.mjs');result=p?await runUISourceChecks(p,p.uiQuality,{stateRoot}):assessUISource(input);}
    else if(sub==='review') {const {reviewUIQuality}=await import('./ui-review.mjs');result=await reviewUIQuality({...input,reportFiles:v.file?.map(file=>path.resolve(file))||input?.reportFiles},{baseDir:v.input?path.dirname(path.resolve(v.input)):process.cwd()});}
    else throw Error('Unknown ui subcommand');
    if(['blocked','failed','not_run','not_configured','needs_review','incomplete','gaps','requires_repair'].includes(result.status)) process.exitCode=2;
  } else if (command === 'visual' && positionals[1] === 'assess') {
    assert(v.input, '--input required'); const input = await strictFile(v.input);
    const { assessVisualSnapshot } = await import('./visual-check.mjs');
    result = assessVisualSnapshot(input.snapshot, input.constraints);
    if (result.status !== 'passed') process.exitCode = 2;
  } else if (['task','debug'].includes(command)) {
    assert(v.input, '--input required'); const input = await strictFile(v.input);
    const { routeTask, getDebugProtocol, auditDebugEvidence } = await import('./pstack.mjs');
    if (command === 'task' && positionals[1] === 'route') result = await routeTask(input);
    else if (command === 'debug' && positionals[1] === 'plan') result = await getDebugProtocol(input);
    else if (command === 'debug' && positionals[1] === 'audit') { assert(v.profile, '--profile required'); result = await auditDebugEvidence(await loadProfile(v.profile), input); }
    else throw Error('Unknown task/debug subcommand');
  } else if (['feature','accept','verify'].includes(command)) {
    assert(v.profile, '--profile required'); const p = await loadProfile(v.profile); const sub = positionals[1];
    const draft = v.draft ? await strictFile(v.draft) : {};
    const tx = { expectedRevision: Number(v['expected-revision'] ?? draft.expectedRevision), expectedHash: v['expected-hash'] === 'absent' ? null : v['expected-hash'] ?? draft.expectedHash, requestId: v['request-id'] ?? draft.requestId, preview: v.preview === true };
    const { expectedRevision, expectedHash, requestId, ...businessDraft } = draft;
    if (command === 'feature' && ['init','change'].includes(sub)) result = await applyFeatureDraft(p, sub, businessDraft, tx);
    else if (command === 'feature' && sub === 'show') result = await featureShow(p, (v.ids || '').split(',').filter(Boolean));
    else if (command === 'feature' && sub === 'check') result = featureCheck(await readMap(p), v.change);
    else if (command === 'feature' && sub === 'continuity') { const { sourceContinuity } = await import('./source-continuity.mjs'); result = await sourceContinuity(p, await readMap(p)); }
    else if (command === 'feature' && sub === 'impact') { assert(v.diff, '--diff required'); const diff = await strictFile(v.diff); result = v.apply ? await recordImpact(p, v.change, diff, tx) : featureImpact(await readMap(p), v.change, diff); }
    else if (command === 'feature' && sub === 'close') result = await closeFeatureChange(p, v.change, businessDraft, {...tx,stateRoot});
    else if (command === 'feature' && sub === 'project') result = { status: 'rebuilt', path: await rebuildProjection(p) };
    else if (command === 'feature' && sub === 'recover-lock') result = await recoverLock(p);
    else if (command === 'accept' && sub === 'plan') result = planAcceptance(p, await readMap(p), v.change);
    else if (command === 'accept' && sub === 'assess') result = await assessAcceptance(p, await readMap(p), v.change, {stateRoot});
    else if (command === 'accept' && sub === 'record') { assert(v.evidence && v.run, '--evidence and --run required'); const evidence = await strictFile(v.evidence); assert(evidence.runId === v.run, 'run_mismatch'); result = await recordAcceptance(p, evidence, tx); }
    else if (command === 'verify' && sub === 'maintain') { const { maintainVerification } = await import('./maintenance.mjs'); result = await maintainVerification(p, await readMap(p), { runId: v.run, resume: v.resume, stateRoot, expectedRunHash: v['expected-run-hash'], report: v.report ? await strictFile(v.report) : undefined }); }
    else if (command === 'verify' && sub === 'recover-lock') { const { recoverMaintenanceLock } = await import('./maintenance.mjs'); result = await recoverMaintenanceLock(p); }
    else throw Error('Unknown feature/accept/verify subcommand');
    if (['blocked','failed','stale','not_run','impact_unknown'].includes(result.status)) process.exitCode = 2;
  } else if (command === 'run') {
    assert(v.profile && v.check, '--profile and --check are required');
    result = await runCheck(await loadProfile(v.profile), v.check, { stateRoot, repeatReason: v['repeat-reason'] || '', newEvidence: v['new-evidence'] || [] });
    if (result.status !== 'check_passed') process.exitCode = 2;
  } else if (command === 'usage') {
    assert(v.run && v.file?.length, '--run and explicit --file list are required');
    result = await summarizeUsage({ runId: v.run, files: v.file });
  } else if (command === 'rollback') {
    result = await rollbackInstallation(stateRoot, { apply: v.apply === true });
  } else if (command === 'records') {
    if (v.rebuild) result = await rebuildRecordsIndex(stateRoot);
    else result = await queryRecords(stateRoot, { scope: v.scope || 'global', query: v.query || '', ids: v.ids?.split(',').filter(Boolean), limit: 8 });
  } else throw new Error('Unknown command; use --help');
  if (v.output) {
    const { scopedPath } = await import('./feature-store.mjs');
    const projectCommand = ['doctor','rules','ui','feature','accept','verify','run','debug'].includes(command);
    const outputRoot = projectCommand && v.profile ? (await loadProfile(v.profile)).root
      : command === 'doctor' && v.project ? result.root : process.cwd();
    const file = await scopedPath(outputRoot, v.output, { createParent: true });
    await fs.writeFile(file, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
    result.detailRef = file;
  }
  const display = command === 'rules' ? {status:result.status,projectId:result.projectId,ruleVersion:result.ruleVersion,counts:result.counts,configRef:result.configRef,readRefs:result.readRefs,detailRef:result.detailRef||null,checks:result.checks?.map(c=>({checkId:c.checkId,status:c.status,evidence:c.evidence})),action:'Use --output PROJECT_RELATIVE_JSON for per-rule gaps and evidence. Only selected scope is assessed.',businessAcceptance:false} : command === 'ui' && positionals[1] === 'review' ? (await import('./ui-review.mjs')).summarizeUIReview(result) : ['feature','accept','verify'].includes(command) ? compact(result) : result;
  const printed = command === 'judge' && ['prepare', 'run', 'review', 'plan', 'project'].includes(positionals[1])
    ? (await import('../scripts/engineering-judge.mjs')).summarizeJudgmentCommand(result) : display;
  process.stdout.write(`${JSON.stringify(printed)}\n`);
}

main().catch(error => { process.stderr.write(`${JSON.stringify({ status: 'blocked', error: error.message })}\n`); process.exitCode = 2; });
