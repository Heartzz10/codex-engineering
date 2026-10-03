import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { assert, existingInside, mkdirInside, fingerprint, within, DEFAULT_STATE } from './paths.mjs';
import { canonicalize as canonical, hashContent as hash, parseStrictJson, scopedPath } from './feature-store.mjs';

const fileHash = value => crypto.createHash('sha256').update(value).digest('hex');
const token = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/;
const latest = (events, type, predicate = () => true) => events.filter(e => e.type === type && predicate(e)).at(-1);
function controlsGaps(c) {
  const gaps = [];
  for (const name of ['launch', 'doctor', 'drive', 'evidence', 'cleanup', 'sourceReview']) if (!c?.[name]?.ref) gaps.push({ code: 'missing_control', classification: 'driver_gap', control: name });
  if (!c?.launch?.readySignal) gaps.push({ code: 'ready_signal_required', classification: 'driver_gap' });
  if (c?.doctor?.readOnly !== true) gaps.push({ code: 'readonly_doctor_required', classification: 'driver_gap' });
  if (c?.cleanup?.preservesEvidence !== true) gaps.push({ code: 'evidence_retention_required', classification: 'driver_gap' });
  if (!c?.isolation?.instanceRef || !c.isolation.dataScopeRef || c.isolation.sessionExclusive !== true) gaps.push({ code: 'isolation_required', classification: 'driver_gap' });
  if (!Array.isArray(c?.sourceReview?.inputs) || !c.sourceReview.inputs.length) gaps.push({ code: 'source_scope_required', classification: 'driver_gap' });
  return gaps;
}
async function baseline(profile, map) {
  const inputs = [...new Set([...(profile.controls?.sourceReview?.inputs || []), ...map.features.filter(f => f.deliveryStatus === 'implemented').flatMap(f => (f.implementationRefs || []).map(r => r.path)), ...map.acceptanceCriteria.flatMap(ac => (ac.implementationRefs || []).map(r => r.path))])];
  const { evidence, revision, contentHash, previousRevisionHash, committedRequests, updatedAt, ...contract } = map;
  return { mapHash: hash(map), contractHash: hash(contract), controlsHash: hash({ controls: profile.controls || {}, entrypoints: profile.entrypoints || [], routes: profile.acceptanceRoutes || [], ...(profile.uiQuality?{uiQuality:profile.uiQuality}: {}), ...(profile.engineeringRules?{engineeringRules:profile.engineeringRules,catalogHash:profile.engineeringCatalogHash}: {}) }), sourceHash: inputs.length ? (await fingerprint(profile.root, inputs, { environmentRef: profile.environmentRef || null })).digest : null, environmentRef: profile.environmentRef || null };
}
const recoveryHash = ({ mapHash, ...rest }) => hash(rest);
async function checkArtifact(profile, event) {
  const ref = event.artifact;
  assert(ref && typeof ref.path === 'string' && /^[a-f0-9]{64}$/.test(ref.sha256 || ''), 'raw_receipt_required');
  const evidenceRoot = await existingInside(profile.root, profile.featureMapRef.evidenceDir);
  const file = await existingInside(profile.root, ref.path);
  assert(within(evidenceRoot, file), 'evidence_path_outside_scope');
  const stat = await fs.stat(file); assert(stat.size <= 2 * 1024 * 1024, 'receipt_too_large');
  const bytes = await fs.readFile(file); assert(fileHash(bytes) === ref.sha256, 'evidence_hash_mismatch');
  const payload = parseStrictJson(bytes.toString('utf8'));
  const { artifact, ...expected } = event;
  assert(canonical(payload) === canonical(expected), 'receipt_mismatch');
  assert(['tool_receipt', 'manual_attestation'].includes(event.observationSource) && typeof event.sourceRef === 'string' && event.sourceRef.trim(), 'observation_source_required');
}
function coverageFor(map) {
  const features = map.features.filter(f => f.deliveryStatus === 'implemented' && f.lifecycle !== 'retired');
  const coverage = [], gaps = [];
  for (const f of features) {
    const conditions = map.acceptanceCriteria.filter(ac => ac.featureId === f.id);
    if (!conditions.length) gaps.push({ code: 'feature_without_conditions', classification: 'drift', featureId: f.id });
    for (const ac of conditions) {
      if (!ac.requiredTargets?.length) gaps.push({ code: 'condition_without_targets', classification: 'drift', featureId: f.id, acId: ac.id });
      for (const target of ac.requiredTargets || []) coverage.push({ featureId: f.id, acId: ac.id, acRevision: ac.revision, targetId: target.targetId, entrypointId: target.entrypointId });
    }
    for (const entrypointId of f.entrypointIds || []) if (!coverage.some(t => t.featureId === f.id && t.entrypointId === entrypointId)) gaps.push({ code: 'entrypoint_without_target', classification: 'drift', featureId: f.id, entrypointId });
    if (!f.entrypointIds?.length) gaps.push({ code: 'feature_without_entrypoints', classification: 'drift', featureId: f.id });
  }
  return { features, coverage, gaps };
}
function validateSequence(run, additions, coverage) {
  let healthy = false, launched = false, attemptedLaunch = false, cleaned = false, released = false, instanceId = null, instanceHash = null;
  for (const e of [...run.events, ...additions]) {
    assert(e.projectId === run.projectId && e.runId === run.runId, 'cross_run_receipt');
    assert(typeof e.instanceId === 'string' && e.instanceId.trim(), 'instance_required');
    assert(/^[a-f0-9]{64}$/.test(e.instanceHash || ''), 'instance_hash_required');
    if (!instanceId) instanceId = e.instanceId;
    if (!instanceHash) instanceHash = e.instanceHash;
    if (e.type === 'recover' && e.instanceHash !== instanceHash) {
      assert(e.priorInstanceHash === instanceHash && instanceId === e.instanceId, 'recovery_prior_instance_required');
      instanceHash = e.instanceHash;
    }
    assert(instanceId === e.instanceId && instanceHash === e.instanceHash, 'resume_instance_changed');
    assert(!released, 'run_released');
    switch (e.type) {
      case 'source_review':
        assert(Array.isArray(e.reviewedPaths) && e.reviewedPaths.length && Array.isArray(e.discoveredEntrypointIds), 'source_review_scope_required'); break;
      case 'launch':
        assert(['ready', 'failed'].includes(e.outcome), 'invalid_launch_outcome');
        attemptedLaunch = true; launched = e.outcome === 'ready'; healthy = false; cleaned = false; break;
      case 'doctor':
        assert(launched && !cleaned, 'launch_required');
        assert(['healthy', 'unhealthy'].includes(e.outcome), 'invalid_doctor_outcome');
        healthy = e.outcome === 'healthy'; break;
      case 'recover':
        assert(launched && e.outcome === 'restored' && e.reason, 'recovery_evidence_required'); healthy = false; cleaned = false; break;
      case 'drive':
        assert(healthy && !cleaned, 'doctor_required');
        assert(coverage.some(t => t.acId === e.acId && t.targetId === e.targetId), 'unknown_maintenance_target');
        assert(['passed', 'failed', 'verified_unreachable'].includes(e.outcome), 'invalid_drive_outcome');
        if (e.outcome === 'failed') {
          assert(['drift', 'driver_gap', 'product_bug'].includes(e.classification), 'failure_classification_required');
          if (e.classification === 'product_bug') assert(e.changeRef, 'product_bug_change_required');
          healthy = false;
        }
        if (e.outcome === 'verified_unreachable') assert(e.reason, 'unreachable_reason_required');
        break;
      case 'evidence':
        assert(Array.isArray(e.evidenceIds) && e.evidenceIds.length, 'evidence_ids_required'); break;
      case 'cleanup':
        assert(attemptedLaunch && ['cleaned', 'failed'].includes(e.outcome), 'invalid_cleanup');
        cleaned = e.outcome === 'cleaned'; healthy = false; break;
      case 'retention_check':
        assert(cleaned && e.outcome === 'retained', 'cleanup_required'); break;
      case 'correction':
        assert(['drift', 'driver_gap'].includes(e.classification) && e.reason && e.beforeRef && e.afterRef, 'invalid_maintenance_correction'); break;
      case 'release':
        assert(!attemptedLaunch && e.reason, 'cleanup_required_before_release'); released = true; break;
      default: throw new Error('unknown_maintenance_event');
    }
  }
  run.instanceId = instanceId || null;
  run.instanceHash = instanceHash || null;
}
async function assess(profile, map, run, stateRoot) {
  const { features, coverage, gaps } = coverageFor(map);
  gaps.push(...controlsGaps(profile.controls));
  const add = (code, more = {}) => gaps.push({ code, classification: 'driver_gap', ...more });
  if (run.invalidatedBaseline) add('resume_baseline_changed');
  for (const entry of profile.entrypoints || []) if (entry.kind !== 'simulation' && !map.features.some(f => f.entrypointIds?.includes(entry.id))) add('unmapped_entrypoint', { classification: 'drift', entrypointId: entry.id });
  for (const e of run.events) {
    try { await checkArtifact(profile, e); } catch (err) { add('evidence_unavailable', { evidence: e.artifact?.path, reason: err.message }); }
  }
  for (const f of features) {
    const review = latest(run.events, 'source_review', e => e.featureId === f.id);
    if (!review) add('source_review_required', { featureId: f.id });
    else {
      for (const ref of f.implementationRefs || []) if (!review.reviewedPaths.includes(ref.path)) add('source_review_incomplete', { featureId: f.id, path: ref.path });
      for (const id of review.discoveredEntrypointIds) if (!f.entrypointIds?.includes(id)) add('unmapped_entrypoint', { classification: 'drift', featureId: f.id, entrypointId: id });
      for (const id of f.entrypointIds || []) if (!review.discoveredEntrypointIds.includes(id)) add('entrypoint_not_reviewed', { classification: 'drift', featureId: f.id, entrypointId: id });
    }
  }
  if (!latest(run.events, 'launch', e => e.outcome === 'ready')) add('launch_required');
  const doctor = latest(run.events, 'doctor');
  if (doctor?.outcome !== 'healthy') add('healthy_doctor_required');
  for (const row of coverage) {
    if (!profile.controls?.drive?.entrypointIds?.includes(row.entrypointId)) add('driver_entrypoint_missing', row);
    const drive = latest(run.events, 'drive', e => e.acId === row.acId && e.targetId === row.targetId);
    row.status = drive?.outcome || 'not_run';
    if (!drive) add('target_not_run', row);
    else if (drive.outcome !== 'passed') add(drive.outcome === 'failed' ? 'target_failed' : 'verified_unreachable', { ...row, classification: drive.classification || 'driver_gap' });
  }
  const ids = [...new Set(coverage.map(x => x.acId))];
  if (ids.length) {
    const { assessDeliveryCoverage } = await import('./acceptance.mjs');
    const acceptance = await assessDeliveryCoverage(profile, map, ids, {stateRoot});
    for (const gap of acceptance.gaps) add('acceptance_not_passed', gap);
    for (const row of coverage) {
      const target = acceptance.conditions.find(a => a.acId === row.acId)?.targets.find(t => t.targetId === row.targetId);
      const recorded = new Set(run.events.filter(e => e.type === 'evidence').flatMap(e => e.evidenceIds));
      if (target?.status !== 'passed') row.status = target?.status || 'not_run';
      if (!target?.evidenceIds?.some(id => recorded.has(id))) add('evidence_capture_required', row);
      if (!target?.evidenceIds?.some(id => recorded.has(id) && map.evidence.some(e => e.id === id && e.runId === run.runId))) { row.status = 'not_run'; add('current_run_evidence_required', row); }
    }
  } else if(profile.engineeringRulesRef) {
    const {assessEngineeringRules}=await import('./engineering-rules.mjs');
    const rules=await assessEngineeringRules(profile,{stateRoot,map});
    if(!['passed','not_applicable'].includes(rules.status))add('engineering_rules_incomplete',{status:rules.status});
  }
  const cleanup = latest(run.events, 'cleanup');
  if (cleanup?.outcome !== 'cleaned' || cleanup.preservedEvidence !== true) add('cleanup_required');
  const retention = latest(run.events, 'retention_check');
  if (!retention || run.events.indexOf(retention) < run.events.indexOf(cleanup)) add('retention_check_required');
  return { status: gaps.length ? 'blocked' : run.events.some(e => e.type === 'correction') ? 'changed' : 'clean', projectId: profile.id, runId: run.runId, coverage, gaps, counts: { features: features.length, targets: coverage.length, passed: coverage.filter(t => t.status === 'passed').length, gaps: gaps.length }, nextActions: [...new Set(gaps.map(g => g.code))], executedControls: false, limitation: 'This coordinator records host/project control receipts; it does not itself operate a browser or prove unobserved business behavior.' };
}
async function atomic(file, value) {
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  let handle;
  try {
    handle = await fs.open(temp, 'wx'); await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync(); await handle.close(); handle = null;
    await fs.rename(temp, file);
  } finally { await handle?.close(); await fs.unlink(temp).catch(() => {}); }
}

/** Remove only a lock created on this host whose process has exited. This never changes run status. */
export async function recoverMaintenanceLock(profile) {
  assert(profile.featureMapRef, 'needs_feature_map');
  const directory = await mkdirInside(profile.root, `${profile.featureMapRef.evidenceDir}/maintenance`);
  const lockPath = await scopedPath(profile.root, path.relative(profile.root, path.join(directory, '.lock')));
  const stat = await fs.lstat(lockPath);
  assert(stat.isFile() && !stat.isSymbolicLink(), 'lock_owner_unverifiable');
  const raw = await fs.readFile(lockPath, 'utf8');
  const owner = parseStrictJson(raw);
  assert(owner.host === os.hostname() && Number.isInteger(owner.pid) && owner.pid > 0 &&
    typeof owner.token === 'string' && /^[0-9a-f-]{36}$/i.test(owner.token), 'lock_owner_unverifiable');
  let dead = false;
  try { process.kill(owner.pid, 0); } catch (error) { if (error.code === 'ESRCH') dead = true; }
  assert(dead, 'lock_owner_alive_or_unverifiable');
  assert(await fs.readFile(lockPath, 'utf8') === raw, 'lock_owner_changed');
  await fs.unlink(lockPath);
  return { status: 'lock_recovered', projectId: profile.id, owner: { pid: owner.pid, host: owner.host, runId: owner.runId, startedAt: owner.startedAt }, action: 'Resume the recorded run; recovery does not validate or complete it.' };
}

/** Append externally observed maintenance receipts. Never executes project controls. */
export async function maintainVerification(profile, map, { runId, resume, report, expectedRunHash, stateRoot=DEFAULT_STATE } = {}) {
  assert(profile.featureMapRef, 'needs_feature_map');
  assert(profile.id === map.projectId, 'cross_project_map');
  assert(token.test(runId || ''), 'invalid_run_id');
  assert(!resume || resume === runId, 'resume_run_id_mismatch');
  const directory = await mkdirInside(profile.root, `${profile.featureMapRef.evidenceDir}/maintenance`);
  const lockPath = await scopedPath(profile.root, path.relative(profile.root, path.join(directory, '.lock'))), journalPath = await scopedPath(profile.root, path.relative(profile.root, path.join(directory, 'journal.json')));
  const lock = await fs.open(lockPath, 'wx').catch(e => { if (e.code === 'EEXIST') throw new Error('maintenance_locked: inspect owner; use verify recover-lock only after process exit'); throw e; });
  const lockToken = crypto.randomUUID();
  let lockWritten = false;
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, host: os.hostname(), startedAt: new Date().toISOString(), runId, token: lockToken })); await lock.sync(); lockWritten = true;
    let journal, existed = true;
    try { journal = parseStrictJson(await fs.readFile(journalPath, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; existed = false; journal = { schemaVersion: 1, projectId: profile.id, owner: null, runs: {} }; }
    assert(journal.projectId === profile.id, 'cross_project_journal');
    if (existed) { const { journalHash, ...body } = journal; assert(hash(body) === journalHash, 'journal_external_edit_detected'); }
    let run = Object.hasOwn(journal.runs, runId) ? journal.runs[runId] : null;
    const currentBaseline = await baseline(profile, map);
    const requestHash = report ? hash(report.events) : null;
    if (run) {
      assert(resume === runId, 'resume_required');
      if (recoveryHash(run.baseline) !== recoveryHash(currentBaseline)) {
        assert(report?.events?.length && report.events.every(e => ['cleanup', 'retention_check', 'release'].includes(e.type)), 'resume_baseline_changed');
        run.invalidatedBaseline = true;
      }
      const prior = report && run.requests.find(r => r.requestId === report.requestId);
      if (prior) { assert(prior.requestHash === requestHash, 'idempotency_conflict'); return prior.result; }
      assert(expectedRunHash === run.runHash, 'run_revision_conflict');
    } else {
      assert(!resume, 'resume_run_missing');
      assert(!journal.owner || journal.owner === runId, 'session_owned');
      run = { runId, projectId: profile.id, baseline: currentBaseline, events: [], requests: [], instanceId: null, revision: 0 };
      journal.runs[runId] = run;
    }
    assert(!journal.owner || journal.owner === runId, 'session_owned');
    if (report) {
      assert(typeof report.requestId === 'string' && token.test(report.requestId) && Array.isArray(report.events) && report.events.length, 'report_request_required');
      for (const event of report.events) await checkArtifact(profile, event);
      validateSequence(run, report.events, coverageFor(map).coverage);
      run.events.push(...report.events);
    }
    const result = await assess(profile, map, run, stateRoot);
    run.revision++; run.updatedAt = new Date().toISOString();
    run.runHash = hash({ runId, revision: run.revision, baseline: run.baseline, events: run.events });
    result.runHash = run.runHash; result.runFile = journalPath; result.baseline = run.baseline;
    if (report) run.requests.push({ requestId: report.requestId, requestHash, result });
    run.status = result.status;
    // Release only after observed cleanup; blocked unfinished runs retain exclusive ownership.
    const lastLaunch = run.events.findLastIndex(e => e.type === 'launch');
    const lastCleanup = run.events.findLastIndex(e => e.type === 'cleanup');
    journal.owner = latest(run.events, 'release') || (lastCleanup > lastLaunch && run.events[lastCleanup]?.outcome === 'cleaned') ? null : runId;
    delete journal.journalHash; journal.journalHash = hash(journal);
    await atomic(journalPath, journal);
    return result;
  } finally {
    await lock.close();
    if (lockWritten) {
      const current = parseStrictJson(await fs.readFile(lockPath, 'utf8'));
      assert(current.token === lockToken, 'lock_owner_changed');
    }
    await fs.unlink(lockPath);
  }
}
