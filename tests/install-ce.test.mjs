import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const packageRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const installer = path.join(packageRoot, 'scripts/install-ce.mjs');
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ce-first-install-'));
  t.after(async () => {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await fs.rm(root, { recursive: true, force: true });
  });
  return root;
}
const run = (file, home) => spawnSync(process.execPath, [file, '--home', home], {
  encoding: 'utf8', windowsHide: true, timeout: 30000,
});

test('fresh installation connects the real CE entry and preserves existing private project state', async t => {
  const home = await fixture(t);
  const state = path.join(home, '.codex/ce-state');
  await fs.mkdir(path.join(state, 'profiles'), { recursive: true });
  const original = Buffer.from('{"history":"keep exact bytes"}\r\n');
  await fs.writeFile(path.join(state, 'profiles/existing.json'), original);
  const result = run(installer, home);
  assert.equal(result.status, 0, result.stderr);
  const installed = path.join(home, '.agents/skills/codex-engineering');
  const runtime = JSON.parse(await fs.readFile(path.join(installed, 'runtime.json')));
  assert.equal(runtime.packageRoot, packageRoot);
  assert.equal(runtime.stateRoot, state);
  assert.equal(runtime.packageVersion, '0.5.14');
  const help = spawnSync(process.execPath, [path.join(installed, 'scripts/engineering.mjs'), '--help'], {
    encoding: 'utf8', windowsHide: true, timeout: 30000,
  });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /0\.5\.14/);
  assert.deepEqual(await fs.readFile(path.join(state, 'profiles/existing.json')), original);
  const before = await fs.readFile(path.join(installed, 'runtime.json'));
  const repeated = run(installer, home);
  assert.notEqual(repeated.status, 0);
  assert.match(repeated.stderr, /已有 CE/);
  assert.deepEqual(await fs.readFile(path.join(installed, 'runtime.json')), before);
});

test('legacy custom installation is preserved and a duplicate Skill is not created', async t => {
  const home = await fixture(t);
  const legacy = path.join(home, '.codex/skills/codex-engineering');
  await fs.mkdir(legacy, { recursive: true });
  const original = Buffer.from('custom instructions\r\n');
  await fs.writeFile(path.join(legacy, 'SKILL.md'), original);
  const result = run(installer, home);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /已有 CE/);
  assert.deepEqual(await fs.readFile(path.join(legacy, 'SKILL.md')), original);
  await assert.rejects(fs.stat(path.join(home, '.agents')), { code: 'ENOENT' });
});

test('a damaged download is rejected before installing any files', async t => {
  const home = await fixture(t);
  const damaged = path.join(home, 'download');
  await fs.mkdir(path.join(damaged, 'scripts'), { recursive: true });
  await fs.copyFile(installer, path.join(damaged, 'scripts/install-ce.mjs'));
  await fs.copyFile(path.join(packageRoot, 'package.json'), path.join(damaged, 'package.json'));
  await fs.copyFile(path.join(packageRoot, 'PUBLIC-MANIFEST.json'), path.join(damaged, 'PUBLIC-MANIFEST.json'));
  const result = run(path.join(damaged, 'scripts/install-ce.mjs'), path.join(home, 'target-home'));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /清单校验失败/);
  await assert.rejects(fs.stat(path.join(home, 'target-home')), { code: 'ENOENT' });
});
