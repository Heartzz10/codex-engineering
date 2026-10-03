import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { promisify } from 'node:util';
import { loadModelCapabilities } from '../src/capabilities.mjs';
import { VERSION } from '../src/paths.mjs';

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const now = new Date('2026-09-23T12:00:00Z');
const snapshot = (changes = {}) => ({ schemaVersion: 1, source: 'observed-local-tools', scope: 'subagent',
  observedAt: '2026-09-22T12:00:00Z', expiresAt: '2026-09-24T12:00:00Z',
  models: [{ id: 'gpt-6-luna', efforts: ['low', 'medium'] }], ...changes });

async function fixture(fn) {
  const state = await mkdtemp(path.join(tmpdir(), 'capabilities-'));
  const put = async data => {
    await mkdir(path.join(state, 'capabilities'), { recursive: true });
    await writeFile(path.join(state, 'capabilities', 'models.json'), JSON.stringify(data));
  };
  try { await fn(state, put); }
  finally { await rm(state, { recursive: true, force: true }); }
}

test('missing, valid and stale observations are distinguished', async () => fixture(async (state, put) => {
  assert.equal((await loadModelCapabilities(state, now)).status, 'unavailable');
  await put(snapshot());
  const valid = await loadModelCapabilities(state, now);
  assert.equal(valid.status, 'available');
  assert.equal(valid.scope, 'subagent');
  assert.equal(valid.source, 'observed-local-tools');
  assert.deepEqual(valid.models, [{ id: 'gpt-6-luna', efforts: ['low', 'medium'] }]);
  await put(snapshot({ expiresAt: '2026-09-23T11:00:00Z' }));
  assert.match((await loadModelCapabilities(state, now)).reason, /过期/);
}));

test('future observation, overlong validity, malformed data and duplicate IDs are unavailable', async () => fixture(async (state, put) => {
  for (const data of [
    snapshot({ observedAt: '2026-09-23T12:00:01Z' }),
    snapshot({ expiresAt: '2026-09-30T12:00:01Z' }),
    snapshot({ scope: 'main' }),
    snapshot({ models: [{ id: 'gpt-6-luna', efforts: [] }] }),
    snapshot({ models: [snapshot().models[0], snapshot().models[0]] }),
  ]) {
    await put(data);
    assert.equal((await loadModelCapabilities(state, now)).status, 'unavailable');
  }
  await writeFile(path.join(state, 'capabilities', 'models.json'), '{bad');
  assert.equal((await loadModelCapabilities(state, now)).status, 'unavailable');
}));

test('capability path cannot escape the state root through a symlink', async t => {
  const outside = await mkdtemp(path.join(tmpdir(), 'capabilities-outside-'));
  try {
    await writeFile(path.join(outside, 'models.json'), JSON.stringify(snapshot()));
    await fixture(async state => {
      try { await symlink(outside, path.join(state, 'capabilities'), process.platform === 'win32' ? 'junction' : 'dir'); }
      catch (error) { if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) { t.skip('directory symlinks unavailable here'); return; } throw error; }
      const result = await loadModelCapabilities(state, now);
      assert.equal(result.status, 'unavailable');
      assert.match(result.reason, /越界/);
    });
  } finally { await rm(outside, { recursive: true, force: true }); }
});

test('doctor uses local observation for a subagent recommendation, with no applied setting; explicit models take priority', async () => fixture(async (state, put) => {
  await put(snapshot({observedAt:new Date(Date.now()-60*60*1000).toISOString(),
    expiresAt:new Date(Date.now()+24*60*60*1000).toISOString()}));
  const project = path.join(state, 'project');
  await mkdir(project);
  await writeFile(path.join(project, 'README.md'), 'test');
  const profile = path.join(state, 'profile.json');
  await writeFile(profile, JSON.stringify({ schemaVersion: 1, id: 'test-project', sharedVersion: VERSION, root: project,
    authoritativeDocuments: ['README.md'], environmentRef: 'local', checks: [] }));
  const task = path.join(state, 'task.json');
  const taskSpec = { kind: 'verification', risk: 'low', independent: true, scopeClear: true, workType: 'browser', errorConsequence: 'low', automaticDetection: true, reversible: true };
  await writeFile(task, JSON.stringify(taskSpec));
  const doctor = async extra => JSON.parse((await exec(process.execPath, [path.join(root, 'src', 'cli.mjs'), 'doctor', '--profile', profile,
    '--task', task, '--state-root', state, ...extra])).stdout);
  const local = await doctor([]);
  assert.equal(local.capabilityStatus.status, 'available');
  assert.equal(local.capabilityStatus.scope, 'subagent');
  assert.equal(local.costPolicy.executor, 'subagent');
  assert.equal(local.costPolicy.recommendedModel, 'gpt-6-luna');
  assert.equal(local.costPolicy.effectiveModel, null);
  assert.equal(local.costPolicy.effectiveEffort, null);
  const explicit = path.join(state, 'explicit.json');
  await writeFile(explicit, JSON.stringify([{ id: 'gpt-6-sol', efforts: ['low'] }]));
  const overridden = await doctor(['--models', explicit]);
  assert.equal(overridden.capabilityStatus.source, '--models');
  assert.equal(overridden.costPolicy.recommendedModel, 'gpt-6-sol');
  delete taskSpec.automaticDetection;
  await writeFile(task, JSON.stringify(taskSpec));
  const incomplete = await doctor([]);
  assert.equal(incomplete.costPolicy.executor, 'main');
  assert.equal(incomplete.costPolicy.recommendedModel, null);
  assert.ok(incomplete.costPolicy.route.issues.includes('missing-risk-control'));
}));
