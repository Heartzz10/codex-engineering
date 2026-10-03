import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadProfile } from '../src/profile.mjs';
import { runCheck } from '../src/runner.mjs';

async function fixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-governance-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const stateRoot = path.join(base, 'state');
  async function project(name, id = name) {
    const root = path.join(base, name);
    await fs.mkdir(root);
    await fs.writeFile(path.join(root, 'GUIDE.md'), 'Current instructions');
    await fs.writeFile(path.join(root, 'check.mjs'), 'console.log("CHECK_RAN")');
    const profile = {
      schemaVersion: 1, id, sharedVersion: '0.1.0', root,
      authoritativeDocuments: ['GUIDE.md'], environmentRef: 'fixture',
      checks: [{
        id: 'check', executable: process.execPath, args: ['check.mjs'], cwd: '.',
        reviewed: true, authorizationRef: 'isolated-test', timeoutMs: 3000,
        effects: { writes: 'none', network: false, paid: false }, inputs: ['check.mjs'],
      }],
    };
    const save = async () => {
      const file = path.join(base, `${name}-profile.json`);
      await fs.writeFile(file, JSON.stringify(profile));
      return loadProfile(file);
    };
    return { root, profile, save };
  }
  return { stateRoot, project };
}

test('a content shift across fixed file boundaries cannot reuse a passing receipt', async t => {
  const f = await fixture(t);
  const p = await f.project('boundary');
  await fs.writeFile(path.join(p.root, 'a'), 'b');
  await fs.writeFile(path.join(p.root, 'b'), '');
  p.profile.checks[0].inputs.push('a', 'b');
  const loaded = await p.save();
  assert.equal((await runCheck(loaded, 'check', f)).status, 'check_passed');
  await fs.writeFile(path.join(p.root, 'a'), '');
  await fs.writeFile(path.join(p.root, 'b'), 'b');
  assert.equal((await runCheck(loaded, 'check', f)).status, 'check_passed');
});

test('declared environment file and key changes invalidate prior check evidence', async t => {
  const f = await fixture(t);
  const p = await f.project('environment');
  const key = `CODEX_GOVERNANCE_TEST_${process.pid}`;
  const before = process.env[key];
  t.after(() => { if (before === undefined) delete process.env[key]; else process.env[key] = before; });
  process.env[key] = 'first';
  await fs.writeFile(path.join(p.root, 'runtime.conf'), 'version=1');
  p.profile.environmentFiles = ['runtime.conf'];
  p.profile.environmentKeys = [key];
  const loaded = await p.save();
  assert.equal((await runCheck(loaded, 'check', f)).status, 'check_passed');
  assert.equal((await runCheck(loaded, 'check', f)).status, 'repeat_requires_reason');
  await fs.writeFile(path.join(p.root, 'runtime.conf'), 'version=2');
  assert.equal((await runCheck(loaded, 'check', f)).status, 'check_passed');
  process.env[key] = 'second';
  assert.equal((await runCheck(loaded, 'check', f)).status, 'check_passed');
});

test('two roots sharing a project ID cannot reuse each other’s passing evidence', async t => {
  const f = await fixture(t);
  const a = await f.project('project-a', 'same-id');
  const b = await f.project('project-b', 'same-id');
  const first = await runCheck(await a.save(), 'check', f);
  const second = await runCheck(await b.save(), 'check', f);
  assert.equal(first.status, 'check_passed');
  assert.equal(second.status, 'check_passed');
  assert.notEqual(first.runId, second.runId);
  const firstReceipt = JSON.parse(await fs.readFile(first.evidence, 'utf8'));
  const secondReceipt = JSON.parse(await fs.readFile(second.evidence, 'utf8'));
  assert.notEqual(firstReceipt.fingerprint, secondReceipt.fingerprint);
  assert.equal(firstReceipt.cwd, a.root);
  assert.equal(secondReceipt.cwd, b.root);
});
