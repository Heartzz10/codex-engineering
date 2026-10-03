import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { hostname } from 'node:os';
import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const maintenance = await import('../src/maintenance.mjs').catch(() => ({}));
const digest = data => crypto.createHash('sha256').update(data).digest('hex');
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'maintenance-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'evidence'));
  await fs.writeFile(path.join(root, 'app.mjs'), 'export const entrypoints = ["ui", "cli"];');
  const profile = { id: 'sample', root, environmentRef: 'test-env', featureMapRef: { schemaVersion: 1, path: 'map.json', historyDir: 'history', evidenceDir: 'evidence' }, entrypoints: [{ id: 'ui' }, { id: 'cli' }], controls: {
    schemaVersion: 1, launch: { ref: 'project:launch', readySignal: 'ready' }, doctor: { ref: 'project:doctor', readOnly: true },
    drive: { ref: 'project:drive', entrypointIds: ['ui', 'cli'] }, evidence: { ref: 'project:evidence' },
    cleanup: { ref: 'project:cleanup', preservesEvidence: true }, isolation: { instanceRef: 'test-instance', dataScopeRef: 'test-data', sessionExclusive: true },
    sourceReview: { inputs: ['app.mjs'], ref: 'project:source-review' }
  } };
  const map = { projectId: 'sample', revision: 1, features: [{ id: 'FEAT-0001', deliveryStatus: 'implemented', lifecycle: 'active', entrypointIds: ['ui', 'cli'], acceptanceCriteria: ['AC-0001'], implementationRefs: [{ path: 'app.mjs' }] }, { id: 'FEAT-0002', deliveryStatus: 'planned', entrypointIds: ['future'] }], acceptanceCriteria: [{ id: 'AC-0001', revision: 1, featureId: 'FEAT-0001', requiredTargets: [{ targetId: 'ui-admin', entrypointId: 'ui' }, { targetId: 'cli-admin', entrypointId: 'cli' }] }], evidence: [], requirements: [], changes: [] };
  const artifacts = [];
  async function event(runId, type, extra = {}) {
    const value = { type, projectId: profile.id, runId, instanceId: 'instance-1', instanceHash: digest('same controlled process identity'), observationSource: 'tool_receipt', sourceRef: 'test:controlled-fixture', ...extra };
    const rel = `evidence/${crypto.randomUUID()}.json`, text = JSON.stringify(value);
    await fs.writeFile(path.join(root, rel), text); artifacts.push(rel);
    return { ...value, artifact: { path: rel, sha256: digest(text) } };
  }
  return { profile, map, event, artifacts };
}

test('maintenance exposes a callable coordinator, not an invented browser driver', () => {
  assert.equal(typeof maintenance.maintainVerification, 'function');
});
test('empty report cannot mark full maintenance clean and all implemented targets are planned', async t => {
  const { profile, map } = await fixture(t);
  const r = await maintenance.maintainVerification(profile, map, { runId: 'run-1' });
  assert.equal(r.status, 'blocked'); assert.equal(r.executedControls, false);
  assert.deepEqual(r.coverage.map(x => x.targetId).sort(), ['cli-admin', 'ui-admin']);
  assert.ok(r.gaps.some(x => x.code === 'source_review_required'));
  assert.ok(!JSON.stringify(r.coverage).includes('FEAT-0002'));
});
test('new user entrypoint and uncovered known entrypoint remain drift gaps', async t => {
  const { profile, map, event } = await fixture(t);
  map.features[0].entrypointIds.push('export');
  const first = await maintenance.maintainVerification(profile, map, { runId: 'run-1' });
  const r = await maintenance.maintainVerification(profile, map, { runId: 'run-1', resume: 'run-1', expectedRunHash: first.runHash, report: { requestId: 'report-1', events: [await event('run-1', 'source_review', { featureId: 'FEAT-0001', reviewedPaths: ['app.mjs'], discoveredEntrypointIds: ['ui', 'cli', 'export', 'hidden'] })] } });
  assert.equal(r.status, 'blocked');
  assert.ok(r.gaps.some(x => x.code === 'unmapped_entrypoint' && x.entrypointId === 'hidden'));
  assert.ok(r.gaps.some(x => x.code === 'entrypoint_without_target' && x.entrypointId === 'export'));
});
test('drive requires successful doctor and unexpected failure requires a fresh doctor', async t => {
  const { profile, map, event } = await fixture(t);
  let r = await maintenance.maintainVerification(profile, map, { runId: 'run-1' });
  const post = async events => maintenance.maintainVerification(profile, map, { runId: 'run-1', resume: 'run-1', expectedRunHash: r.runHash, report: { requestId: crypto.randomUUID(), events } });
  await assert.rejects(post([await event('run-1', 'drive', { targetId: 'ui-admin', acId: 'AC-0001', outcome: 'passed' })]), /doctor_required/);
  r = await post([await event('run-1', 'launch', { outcome: 'ready' }), await event('run-1', 'doctor', { outcome: 'healthy' }), await event('run-1', 'drive', { targetId: 'ui-admin', acId: 'AC-0001', outcome: 'failed', classification: 'product_bug', changeRef: 'CHG-0001' })]);
  await assert.rejects(post([await event('run-1', 'drive', { targetId: 'cli-admin', acId: 'AC-0001', outcome: 'passed' })]), /doctor_required/);
  assert.ok(r.gaps.some(x => x.classification === 'product_bug'));
});
test('resume rejects source mutation, different instance, and concurrent run ownership', async t => {
  const { profile, map, event } = await fixture(t);
  const r = await maintenance.maintainVerification(profile, map, { runId: 'run-1' });
  await assert.rejects(maintenance.maintainVerification(profile, map, { runId: 'run-2' }), /session_owned/);
  await fs.writeFile(path.join(profile.root, 'app.mjs'), 'changed');
  await assert.rejects(maintenance.maintainVerification(profile, map, { runId: 'run-1', resume: 'run-1', expectedRunHash: r.runHash }), /resume_baseline_changed/);
});
test('report CAS, idempotency, evidence integrity, and immutable event binding are enforced', async t => {
  const { profile, map, event } = await fixture(t);
  const first = await maintenance.maintainVerification(profile, map, { runId: 'run-1' });
  const e = await event('run-1', 'launch', { outcome: 'ready' });
  const options = { runId: 'run-1', resume: 'run-1', expectedRunHash: first.runHash, report: { requestId: 'report-1', events: [e] } };
  const r = await maintenance.maintainVerification(profile, map, options);
  assert.equal((await maintenance.maintainVerification(profile, map, options)).runHash, r.runHash);
  await assert.rejects(maintenance.maintainVerification(profile, map, { ...options, report: { ...options.report, events: [{ ...e, outcome: 'bad' }] } }), /idempotency_conflict/);
  await assert.rejects(maintenance.maintainVerification(profile, map, { ...options, report: { requestId: 'report-2', events: [e] } }), /run_revision_conflict/);
  await assert.rejects(maintenance.maintainVerification(profile, map, { ...options, expectedRunHash: r.runHash, report: { requestId: 'report-2', events: [{ ...e, outcome: 'bad' }] } }), /receipt_mismatch/);
});
test('verified unreachable and cleanup deleting evidence never count as business passed', async t => {
  const { profile, map, event, artifacts } = await fixture(t);
  const first = await maintenance.maintainVerification(profile, map, { runId: 'run-1' });
  const events = [await event('run-1', 'launch', { outcome: 'ready' }), await event('run-1', 'doctor', { outcome: 'healthy' }), await event('run-1', 'drive', { acId: 'AC-0001', targetId: 'ui-admin', outcome: 'verified_unreachable', reason: 'role prerequisite unavailable' }), await event('run-1', 'cleanup', { outcome: 'cleaned', preservedEvidence: true })];
  const r = await maintenance.maintainVerification(profile, map, { runId: 'run-1', resume: 'run-1', expectedRunHash: first.runHash, report: { requestId: 'report-1', events } });
  assert.equal(r.status, 'blocked'); assert.ok(r.gaps.some(x => x.code === 'verified_unreachable'));
  await fs.unlink(path.join(profile.root, artifacts[0]));
  const next = await maintenance.maintainVerification(profile, map, { runId: 'run-1', resume: 'run-1', expectedRunHash: r.runHash });
  assert.ok(next.gaps.some(x => x.code === 'evidence_unavailable'));
});

test('evidence-only map revision can resume but contract and instance changes cannot', async t => {
  const { profile, map, event } = await fixture(t);
  const first = await maintenance.maintainVerification(profile, map, { runId: 'run-1' });
  map.revision++; map.updatedAt = new Date().toISOString();
  map.evidence.push({ id: 'EVD-0001', acId: 'unrelated' });
  let r = await maintenance.maintainVerification(profile, map, { runId: 'run-1', resume: 'run-1', expectedRunHash: first.runHash, report: { requestId: 'r-1', events: [await event('run-1', 'launch', { outcome: 'ready' })] } });
  await assert.rejects(maintenance.maintainVerification(profile, map, { runId: 'run-1', resume: 'run-1', expectedRunHash: r.runHash, report: { requestId: 'r-2', events: [await event('run-1', 'doctor', { instanceId: 'other-instance', outcome: 'healthy' })] } }), /resume_instance_changed/);
  await assert.rejects(maintenance.maintainVerification(profile, map, { runId: 'run-1', resume: 'run-1', expectedRunHash: r.runHash, report: { requestId: 'r-3', events: [await event('run-1', 'doctor', { instanceHash: digest('different process under reused identifier'), outcome: 'healthy' })] } }), /resume_instance_changed/);
  map.acceptanceCriteria[0].revision++;
  await assert.rejects(maintenance.maintainVerification(profile, map, { runId: 'run-1', resume: 'run-1', expectedRunHash: r.runHash }), /resume_baseline_changed/);
});

test('source review includes implementation outside declared discovery scope and unmapped profile entrypoints', async t => {
  const { profile, map } = await fixture(t);
  await fs.writeFile(path.join(profile.root, 'other.mjs'), 'v1');
  map.features[0].implementationRefs.push({ path: 'other.mjs' });
  profile.entrypoints.push({ id: 'unmapped' });
  const first = await maintenance.maintainVerification(profile, map, { runId: 'run-1' });
  assert.ok(first.gaps.some(x => x.code === 'unmapped_entrypoint' && x.entrypointId === 'unmapped'));
  await fs.writeFile(path.join(profile.root, 'other.mjs'), 'v2');
  await assert.rejects(maintenance.maintainVerification(profile, map, { runId: 'run-1', resume: 'run-1', expectedRunHash: first.runHash }), /resume_baseline_changed/);
});

test('real local CLI receipts allow clean; correction yields changed; prior-run evidence cannot satisfy maintenance', async t => {
  const { profile, map, event } = await fixture(t);
  const script = "import fs from 'node:fs'; fs.writeFileSync(process.argv[2], process.argv[3]); console.log(JSON.stringify({value:fs.readFileSync(process.argv[2],'utf8')}));";
  await fs.writeFile(path.join(profile.root, 'app.mjs'), script);
  profile.acceptanceRoutes = [{ id: 'local-cli', kind: 'cli', entrypointIds: ['ui', 'cli'], driverRef: 'node:fixture', available: true, real: true, authorizationRef: 'isolated-test', effects: { writes: 'test-artifacts', network: false, paid: false } }];
  const ac = map.acceptanceCriteria[0];
  Object.assign(ac, { verificationMethod: 'cli', effects: { writes: 'test-artifacts', network: false, paid: false }, actions: [{ type: 'invoke' }, { type: 'observe' }], assertions: [{ id: 'readback', operator: 'equals', path: '/value', expected: 'persisted' }], implementationRefs: [{ path: 'app.mjs' }] });
  for (const target of ac.requiredTargets) Object.assign(target, { roleRef: 'test', environmentRef: 'test-env', dataScopeRef: 'test-data', scenario: 'write-readback' });
  map.changes.push({ id: 'CHG-0001', acIds: [ac.id] });
  const first = await maintenance.maintainVerification(profile, map, { runId: 'run-1' });
  const observations = [];
  for (const target of ac.requiredTargets) {
    const result = await promisify(execFile)(process.execPath, [path.join(profile.root, 'app.mjs'), path.join(profile.root, `${target.targetId}.txt`), 'persisted']);
    observations.push({ ...target, actions: [{ type: 'invoke', description: 'Started local CLI and awaited exit' }, { type: 'observe', description: 'Read JSON emitted after persisted file readback' }], actual: JSON.parse(result.stdout) });
  }
  const fingerprint = [{ path: 'app.mjs', sha256: digest(script) }], executedAt = new Date().toISOString();
  const receipt = { projectId: profile.id, acId: ac.id, acRevision: 1, runId: 'run-1', method: 'cli', observationSource: 'tool_receipt', executedAt, implementationFingerprint: fingerprint, observations };
  const raw = JSON.stringify(receipt); await fs.writeFile(path.join(profile.root, 'evidence/business.json'), raw);
  const { validateEvidence } = await import('../src/acceptance.mjs');
  map.evidence.push({ id: 'EVD-0001', ...await validateEvidence(profile, map, { sourceRef: 'tool:local-fixture', recordedBy: 'test', createdAt: executedAt, projectId: profile.id, featureId: ac.featureId, acId: ac.id, acRevision: 1, runId: 'run-1', changeId: 'CHG-0001', targetIds: ac.requiredTargets.map(x => x.targetId), method: 'cli', observationSource: 'tool_receipt', environmentRef: 'test-env', roleRef: 'test', dataScopeRef: 'test-data', executedAt, implementationFingerprint: fingerprint, rawEvidence: [{ path: 'evidence/business.json', sha256: digest(raw), type: 'execution' }] }) });
  const events = [await event('run-1', 'source_review', { featureId: ac.featureId, reviewedPaths: ['app.mjs'], discoveredEntrypointIds: ['ui', 'cli'] }), await event('run-1', 'launch', { outcome: 'ready' }), await event('run-1', 'doctor', { outcome: 'healthy' })];
  for (const target of ac.requiredTargets) events.push(await event('run-1', 'drive', { acId: ac.id, targetId: target.targetId, outcome: 'passed' }));
  events.push(await event('run-1', 'evidence', { evidenceIds: ['EVD-0001'] }), await event('run-1', 'cleanup', { outcome: 'cleaned', preservedEvidence: true }), await event('run-1', 'retention_check', { outcome: 'retained' }));
  let r = await maintenance.maintainVerification(profile, map, { runId: 'run-1', resume: 'run-1', expectedRunHash: first.runHash, report: { requestId: 'r-1', events } });
  assert.equal(r.status, 'clean', JSON.stringify(r.gaps));
  r = await maintenance.maintainVerification(profile, map, { runId: 'run-1', resume: 'run-1', expectedRunHash: r.runHash, report: { requestId: 'r-2', events: [await event('run-1', 'correction', { classification: 'drift', reason: 'Documentation corrected before source review and tested execution', beforeRef: 'test:before', afterRef: 'test:after' })] } });
  assert.equal(r.status, 'changed');
  const second = await maintenance.maintainVerification(profile, map, { runId: 'run-2' });
  const reused = [];
  for (const e of events) { const { artifact, ...fields } = e; reused.push(await event('run-2', e.type, { ...fields, runId: 'run-2' })); }
  const r2 = await maintenance.maintainVerification(profile, map, { runId: 'run-2', resume: 'run-2', expectedRunHash: second.runHash, report: { requestId: 'r-3', events: reused } });
  assert.equal(r2.status, 'blocked'); assert.ok(r2.gaps.some(x => x.code === 'current_run_evidence_required'));
});

test('failed launch can clean up, and a changed baseline permits cleanup only', async t => {
  const { profile, map, event } = await fixture(t);
  const first = await maintenance.maintainVerification(profile, map, { runId: 'run-1' });
  let r = await maintenance.maintainVerification(profile, map, { runId: 'run-1', resume: 'run-1', expectedRunHash: first.runHash, report: { requestId: 'r-1', events: [await event('run-1', 'launch', { outcome: 'failed' })] } });
  await fs.writeFile(path.join(profile.root, 'app.mjs'), 'changed during failed run');
  r = await maintenance.maintainVerification(profile, map, { runId: 'run-1', resume: 'run-1', expectedRunHash: r.runHash, report: { requestId: 'r-2', events: [await event('run-1', 'cleanup', { outcome: 'cleaned', preservedEvidence: true })] } });
  assert.equal(r.status, 'blocked'); assert.ok(r.gaps.some(x => x.code === 'resume_baseline_changed'));
  const next = await maintenance.maintainVerification(profile, map, { runId: 'run-2' });
  assert.equal(next.status, 'blocked');
});

test('unstarted plan can release ownership without claiming cleanup or success', async t => {
  const { profile, map, event } = await fixture(t);
  const first = await maintenance.maintainVerification(profile, map, { runId: 'run-1' });
  const r = await maintenance.maintainVerification(profile, map, { runId: 'run-1', resume: 'run-1', expectedRunHash: first.runHash, report: { requestId: 'r-1', events: [await event('run-1', 'release', { reason: 'Controls must be corrected before launch' })] } });
  assert.equal(r.status, 'blocked');
  const next = await maintenance.maintainVerification(profile, map, { runId: 'run-2' });
  assert.equal(next.status, 'blocked');
});

test('explicit restored instance transition requires fresh doctor before driving', async t => {
  const { profile, map, event } = await fixture(t);
  const first = await maintenance.maintainVerification(profile, map, { runId: 'run-1' });
  const newHash = digest('restarted controlled instance');
  const r = await maintenance.maintainVerification(profile, map, { runId: 'run-1', resume: 'run-1', expectedRunHash: first.runHash, report: { requestId: 'r-1', events: [await event('run-1', 'launch', { outcome: 'ready' }), await event('run-1', 'doctor', { outcome: 'unhealthy' }), await event('run-1', 'recover', { outcome: 'restored', reason: 'restart isolated failed instance', priorInstanceHash: digest('same controlled process identity'), instanceHash: newHash }), await event('run-1', 'doctor', { outcome: 'healthy', instanceHash: newHash }), await event('run-1', 'drive', { acId: 'AC-0001', targetId: 'ui-admin', outcome: 'passed', instanceHash: newHash })] } });
  assert.equal(r.status, 'blocked');
  assert.ok(!r.gaps.some(x => x.code === 'healthy_doctor_required'));
});

test('removing journal integrity hash cannot authorize externally edited run state', async t => {
  const { profile, map } = await fixture(t);
  const first = await maintenance.maintainVerification(profile, map, { runId: 'run-1' });
  const journal = JSON.parse(await fs.readFile(first.runFile, 'utf8'));
  delete journal.journalHash;
  await fs.writeFile(first.runFile, JSON.stringify(journal));
  await assert.rejects(maintenance.maintainVerification(profile, map, { runId: 'run-1', resume: 'run-1', expectedRunHash: first.runHash }), /journal_external_edit_detected/);
});

test('concurrent coordinators cannot own one project session or lose a journal commit', async t => {
  const { profile, map } = await fixture(t);
  const outcomes = await Promise.allSettled(['first', 'second'].map(runId => maintenance.maintainVerification(profile, map, { runId })));
  assert.equal(outcomes.filter(x => x.status === 'fulfilled').length, 1);
  const rejected = outcomes.find(x => x.status === 'rejected');
  assert.match(rejected.reason.message, /maintenance_locked|session_owned/);
  const result = outcomes.find(x => x.status === 'fulfilled').value;
  const journal = JSON.parse(await fs.readFile(result.runFile, 'utf8'));
  assert.equal(Object.keys(journal.runs).length, 1); assert.equal(journal.owner, result.runId);
});

test('maintenance lock recovery refuses live or unverifiable owners and only removes a dead owned lock', async t => {
  const { profile, map } = await fixture(t);
  const first = await maintenance.maintainVerification(profile, map, { runId: 'run-1' });
  const lockFile = path.join(path.dirname(first.runFile), '.lock');
  const stale = { pid: process.pid, host: hostname(), startedAt: new Date().toISOString(), runId: 'run-1', token: crypto.randomUUID() };
  await fs.writeFile(lockFile, JSON.stringify(stale));
  await assert.rejects(maintenance.recoverMaintenanceLock(profile), /lock_owner_alive_or_unverifiable/);
  await fs.writeFile(lockFile, JSON.stringify({ ...stale, host: 'different-host' }));
  await assert.rejects(maintenance.recoverMaintenanceLock(profile), /lock_owner_unverifiable/);
  const child = spawn(process.execPath, ['-e', 'process.exit(0)']);
  const deadPid = child.pid;
  await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  await fs.writeFile(lockFile, JSON.stringify({ ...stale, pid: deadPid }));
  const recovered = await maintenance.recoverMaintenanceLock(profile);
  assert.equal(recovered.status, 'lock_recovered');
  await assert.rejects(fs.stat(lockFile), { code: 'ENOENT' });
  const resumed = await maintenance.maintainVerification(profile, map, { runId: 'run-1', resume: 'run-1', expectedRunHash: first.runHash });
  assert.equal(resumed.status, 'blocked');
});
