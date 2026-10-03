import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { verifyStableRelease, switchStableRuntime, revertStableRuntime } from '../src/stable-release.mjs';

const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

async function fixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'stable-release-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const source = path.join(base, 'dev');
  const stable = path.join(base, 'stable');
  await fs.mkdir(source);
  await fs.mkdir(stable);
  const packageBytes = Buffer.from('{"version":"0.1.0"}');
  await fs.writeFile(path.join(stable, 'package.json'), packageBytes);
  const archive = path.join(base, 'archive.zip');
  await fs.writeFile(archive, 'archive bytes');
  const manifestPath = path.join(base, 'stable.manifest.json');
  const manifest = { schemaVersion: 1, version: '0.1.0', commit: 'fixture', archive,
    archiveSha256: hash('archive bytes'), packageRoot: stable, developmentRoot: source, files: { 'package.json': hash(packageBytes) } };
  const runtimePath = path.join(base, 'runtime.json');
  const before = Buffer.from(JSON.stringify({ packageRoot: source, stateRoot: path.join(base, 'state'), packageVersion: '0.1.0' }));
  const recordPath = path.join(base, 'switch.json');
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  await fs.writeFile(runtimePath, before);
  return { base, source, stable, archive, manifestPath, manifest, runtimePath, before, recordPath };
}

test('stable binding uses verified release and can revert exact runtime bytes', async t => {
  const f = await fixture(t);
  assert.equal((await verifyStableRelease(f.manifestPath)).status, 'verified');
  const switched = await switchStableRuntime(f);
  assert.equal(switched.status, 'switched');
  assert.equal(JSON.parse(await fs.readFile(f.runtimePath, 'utf8')).packageRoot, f.stable);
  assert.equal((await revertStableRuntime(f.recordPath)).status, 'reverted');
  assert.deepEqual(await fs.readFile(f.runtimePath), f.before);
});

test('damaged release and wrong installed version block switch', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.stable, 'package.json'), '{"version":"0.2.0"}');
  await assert.rejects(switchStableRuntime(f), /files changed/);
  assert.deepEqual(await fs.readFile(f.runtimePath), f.before);
  await fs.writeFile(path.join(f.stable, 'package.json'), '{"version":"0.1.0"}');
  await fs.writeFile(f.runtimePath, JSON.stringify({ packageRoot: f.source, stateRoot: path.join(f.base, 'state'), packageVersion: '0.2.0' }));
  await assert.rejects(switchStableRuntime(f), /versions differ/);
});

test('path conflict and later runtime edit are rejected without overwrite', async t => {
  const f = await fixture(t);
  f.manifest.packageRoot = f.source;
  await fs.writeFile(f.manifestPath, JSON.stringify(f.manifest));
  await assert.rejects(verifyStableRelease(f.manifestPath), /overlap/);
  f.manifest.packageRoot = f.stable;
  await fs.writeFile(f.manifestPath, JSON.stringify(f.manifest));
  await switchStableRuntime(f);
  const userEdit = Buffer.from('{"user":"edited binding"}');
  await fs.writeFile(f.runtimePath, userEdit);
  await assert.rejects(revertStableRuntime(f.recordPath), /binding changed/);
  assert.deepEqual(await fs.readFile(f.runtimePath), userEdit);
});

test('native skill wrapper rejects a mismatched package version', async t => {
  const f = await fixture(t);
  const skill = path.join(f.base, 'skills', 'codex-engineering');
  await fs.mkdir(path.join(skill, 'scripts'), { recursive: true });
  await fs.copyFile(new URL('../skills/codex-engineering/scripts/engineering.mjs', import.meta.url), path.join(skill, 'scripts', 'engineering.mjs'));
  await fs.writeFile(path.join(skill, 'runtime.json'), JSON.stringify({ packageRoot: f.stable, stateRoot: path.join(f.base, 'state'), packageVersion: '9.9.9' }));
  const result = spawnSync(process.execPath, [path.join(skill, 'scripts', 'engineering.mjs'), '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /runtime versions differ/);
});
