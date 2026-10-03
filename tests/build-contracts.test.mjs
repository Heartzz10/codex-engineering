import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { VERSION } from '../src/paths.mjs';

test('contract build preserves released profile versions and the current runtime version', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'contract-build-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const folder of ['scripts', 'schemas', 'src']) await fs.mkdir(path.join(root, folder));
  for (const file of ['scripts/build-contracts.mjs', 'src/paths.mjs']) await fs.copyFile(file, path.join(root, file));
  const profile = JSON.parse(await fs.readFile('schemas/profile.schema.json', 'utf8'));
  profile.properties.sharedVersion.enum = ['0.1.0', '0.2.0', '0.2.1', '0.3.0', '0.3.1'];
  await fs.writeFile(path.join(root, 'schemas/profile.schema.json'), JSON.stringify(profile));
  for (let i = 0; i < 2; i++) {
    const run = spawnSync(process.execPath, ['scripts/build-contracts.mjs'], { cwd: root, encoding: 'utf8', windowsHide: true });
    assert.equal(run.status, 0, run.stderr);
    const built = JSON.parse(await fs.readFile(path.join(root, 'schemas/profile.schema.json'), 'utf8'));
    assert.ok(built.properties.sharedVersion.enum.includes('0.3.0'));
    assert.ok(built.properties.sharedVersion.enum.includes('0.3.1'));
    assert.ok(built.properties.sharedVersion.enum.includes(VERSION));
    assert.equal(new Set(built.properties.sharedVersion.enum).size, built.properties.sharedVersion.enum.length);
  }
});
