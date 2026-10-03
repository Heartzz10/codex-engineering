import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION } from '../src/paths.mjs';

async function run(args, input) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'engineering-cli-'));
  try {
    const file = path.join(root, 'input.json');
    await fs.writeFile(file, JSON.stringify(input));
    const result = spawnSync(process.execPath, ['src/cli.mjs', ...args, '--input', file, '--state-root', root], { encoding: 'utf8', windowsHide: true });
    return { code: result.status, body: JSON.parse(result.stdout || result.stderr) };
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}
test('native cost command keeps unknown costs unknown', async () => {
  const result = await run(['model', 'cost'], { attempts: [], checks: [], humanWork: [], qualification: { status: 'pending', evidenceRefs: [] } });
  assert.equal(result.body.comparable, false);
  assert.equal(result.body.costs.total.amount, null);
});
test('native retry command stops identical failed attempts without new evidence', async () => {
  const result = await run(['model', 'retry'], { attempts: [{ fingerprint: 'same', status: 'check_failed', evidenceRefs: ['receipt:1'] }], nextAttempt: { fingerprint: 'same', evidenceRefs: ['receipt:1'] } });
  assert.equal(result.code, 2);
  assert.equal(result.body.action, 'stop-and-investigate');
});
test('native visual command rejects fabricated pass without measurements', async () => {
  const result = await run(['visual', 'assess'], { snapshot: { status: 'passed' }, constraints: { goal: 'Can submit', viewport: { width: 360, height: 800 }, required: [{ selector: 'button', interactive: true }] } });
  assert.equal(result.code, 2);
  assert.equal(result.body.status, 'failed');
  assert.ok(result.body.issues.some(x => x.code === 'missing_layout_measurement'));
});
test('native judgment preparation refuses private scope before making calls', async () => {
  const result = await run(['judge', 'prepare', '--out', path.join(os.tmpdir(), 'never-written-private-preview.json')], { material_scope: 'private', context: {}, evidence: [], judgments: [] });
  assert.equal(result.code, 2);
  assert.match(result.body.error, /private/);
});

test('judgment help exposes the actual budget and request limits', () => {
  const result = spawnSync(process.execPath, ['src/cli.mjs', 'judge', '--help'], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0);
  assert.match(JSON.parse(result.stdout).help, /--max-requests/);
  assert.match(JSON.parse(result.stdout).help, /--budget-usd/);
});
test('native selective judge returns a normal no-request review fallback without a key', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'judgment-native-fallback-'));
  try {
    const source = '服务端确认并读回后才显示已保存。';
    await fs.writeFile(path.join(root, 'source.md'), source);
    const packet = { material_scope: 'synthetic', context: { purpose: '合成状态文案' }, evidence: [{ id: 'E1', source_file: 'source.md', source_label: '合成决定', original_locator: '第1行', start_line: 1, end_line: 1, quote: source }], judgments: [{ id: 'COPY-1', kind: 'requirement_fidelity', target: '候选文案保留确认条件。', evidence_ids: ['E1'] }], review_policy: { mode: 'selective', profile_id: 'ordinary_ui_copy_fidelity_v2' } };
    const { prepareJudgments } = await import('../src/judgment.mjs');
    const preview = await prepareJudgments(packet, { baseDir: root });
    const previewFile = path.join(root, 'preview.json'); await fs.writeFile(previewFile, JSON.stringify(preview));
    const result = spawnSync(process.execPath, ['src/cli.mjs', 'judge', 'run', '--input', previewFile, '--out', path.join(root, 'result.json'), '--ledger', path.join(root, 'ledger.json'), '--approved-sha', preview.request_sha256, '--budget-usd', '0.05', '--max-requests', '1', '--state-root', root], { encoding: 'utf8', windowsHide: true, env: { ...process.env, TYPESAFE_API_KEY: '' } });
    assert.equal(result.status, 0, result.stderr);
    const body = JSON.parse(result.stdout);
    assert.equal(body.status, 'review_fallback');
    assert.equal(body.attempts, 0);
    assert.ok(body.review_routing.every(row => row.action === 'codex_review'));
    await assert.rejects(fs.access(path.join(root, 'ledger.json')), /ENOENT/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('doctor exposes the structured map and control routes when baseline checks are empty', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'engineering-discovery-'));
  try {
    await fs.writeFile(path.join(root, 'GUIDE.md'), 'Existing project controls');
    const profile = { schemaVersion: 2, id: 'sample', sharedVersion: VERSION, root, authoritativeDocuments: ['GUIDE.md'], environmentRef: 'local', checks: [], featureMapRef: { schemaVersion: 1, path: 'docs/map.json', historyDir: 'docs/history', evidenceDir: 'evidence' }, controls: { drive: { ref: 'existing-driver.mjs' } }, acceptanceRoutes: [{ id: 'ui', driverRef: 'existing-driver.mjs' }] };
    const file = path.join(root, 'profile.json'); await fs.writeFile(file, JSON.stringify(profile));
    const r = spawnSync(process.execPath, ['src/cli.mjs', 'doctor', '--profile', file, '--state-root', root], { encoding: 'utf8', windowsHide: true });
    assert.equal(r.status, 0, r.stderr);
    const result = JSON.parse(r.stdout);
    assert.equal(result.featureMapRef.path, 'docs/map.json');
    assert.equal(result.controls.drive.ref, 'existing-driver.mjs');
    assert.equal(result.acceptanceRoutes[0].driverRef, 'existing-driver.mjs');
    assert.equal(result.registeredCheckCount, 0);
    assert.equal(result.status, 'needs_setup');
    assert.equal(result.startup.status, 'needs_setup');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('doctor reports a missing authority file as a setup gap without treating it as valid project evidence', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'engineering-missing-document-'));
  try {
    const file = path.join(root, 'profile.json');
    await fs.writeFile(file, JSON.stringify({ schemaVersion: 2, id: 'missing-doc', sharedVersion: VERSION,
      root, authoritativeDocuments: ['GUIDE.md'], environmentRef: 'local', checks: [] }));
    const result = spawnSync(process.execPath, ['src/cli.mjs', 'doctor', '--profile', file], { encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    const body = JSON.parse(result.stdout);
    assert.equal(body.status, 'needs_setup');
    assert(body.startup.gaps.some(gap => gap.id === 'documents'));
    assert.deepEqual(body.missingAuthoritativeDocuments, ['GUIDE.md']);
    const strict = spawnSync(process.execPath, ['src/cli.mjs', 'feature', 'show', '--profile', file], { encoding: 'utf8', windowsHide: true });
    assert.equal(strict.status, 2);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('project command writes relative output inside the project when invoked elsewhere', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'engineering-output-'));
  try {
    const project = path.join(root, 'project');
    const invocation = path.join(root, 'invocation');
    await fs.mkdir(project); await fs.mkdir(invocation);
    await fs.writeFile(path.join(project, 'GUIDE.md'), '# Project');
    const file = path.join(project, 'profile.json');
    await fs.writeFile(file, JSON.stringify({ schemaVersion: 2, id: 'output-project', sharedVersion: VERSION,
      root: project, authoritativeDocuments: ['GUIDE.md'], environmentRef: 'local', checks: [] }));
    const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [cli, 'doctor', '--profile', file,
      '--state-root', root, '--output', 'reports/doctor.json'],
      { cwd: invocation, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    const expected = path.join(project, 'reports', 'doctor.json');
    assert.equal(JSON.parse(result.stdout).detailRef, expected);
    assert.equal(JSON.parse(await fs.readFile(expected, 'utf8')).projectId, 'output-project');
    await assert.rejects(fs.access(path.join(invocation, 'reports', 'doctor.json')), /ENOENT/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('verify recover-lock removes a dead local lock through the public CLI without completing a run', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'engineering-maintenance-recovery-'));
  try {
    await fs.writeFile(path.join(root, 'GUIDE.md'), '# Project');
    const profileFile = path.join(root, 'profile.json');
    await fs.writeFile(profileFile, JSON.stringify({ schemaVersion: 2, id: 'recover-project', sharedVersion: VERSION,
      root, authoritativeDocuments: ['GUIDE.md'], environmentRef: 'local', checks: [],
      featureMapRef: { schemaVersion: 1, path: 'map.json', historyDir: 'history', evidenceDir: 'evidence' } }));
    const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { windowsHide: true });
    const deadPid = child.pid;
    await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    const lockDir = path.join(root, 'evidence', 'maintenance'); await fs.mkdir(lockDir, { recursive: true });
    await fs.writeFile(path.join(lockDir, '.lock'), JSON.stringify({ pid: deadPid, host: os.hostname(),
      runId: 'run-1', startedAt: new Date().toISOString(), token: crypto.randomUUID() }));
    const result = spawnSync(process.execPath, ['src/cli.mjs', 'verify', 'recover-lock', '--profile', profileFile], { encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).status, 'lock_recovered');
    await assert.rejects(fs.stat(path.join(lockDir, '.lock')), { code: 'ENOENT' });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
