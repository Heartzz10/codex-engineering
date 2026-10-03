import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { rollbackInstallation } from '../src/rollback.mjs';

const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');

async function fixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-rollback-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const codexRoot = path.join(base, '.codex');
  const skill = path.join(codexRoot, 'skills', 'codex-engineering');
  const stateRoot = path.join(base, 'state', 'engineering');
  const backup = path.join(stateRoot, 'backups', 'batch');
  await fs.mkdir(skill, { recursive: true });
  await fs.mkdir(backup, { recursive: true });
  const skillFiles = { 'SKILL.md': hash('installed skill'), 'scripts/engineering.mjs': hash('installed script') };
  await fs.mkdir(path.join(skill, 'scripts'));
  await fs.writeFile(path.join(skill, 'SKILL.md'), 'installed skill');
  await fs.writeFile(path.join(skill, 'scripts', 'engineering.mjs'), 'installed script');
  const changed = [];
  for (const [name, original, installed] of [
    ['AGENTS.md', 'original agents', 'installed agents'],
    ['config.toml', 'original config', 'installed config'],
  ]) {
    await fs.writeFile(path.join(codexRoot, name), installed);
    await fs.writeFile(path.join(backup, name), original);
    changed.push({ target: path.join(codexRoot, name), backup: name, installedHash: hash(installed) });
  }
  const manifest = { version: '0.1.0', createdSkill: skill, changed, skillFiles };
  const installation = { version: '0.1.0', skill, source: path.join(base, 'source'), backup, status: 'installed' };
  const save = async () => {
    await fs.writeFile(path.join(backup, 'manifest.json'), JSON.stringify(manifest));
    await fs.writeFile(path.join(stateRoot, 'installation.json'), JSON.stringify(installation));
  };
  await save();
  return { base, codexRoot, skill, stateRoot, backup, manifest, installation, save };
}

test('preview is read-only; apply restores globals and parks the exact skill directory', async t => {
  const f = await fixture(t);
  const preview = await rollbackInstallation(f.stateRoot);
  assert.equal(preview.status, 'ready');
  assert.equal(preview.apply, false);
  assert.equal(await fs.readFile(path.join(f.codexRoot, 'AGENTS.md'), 'utf8'), 'installed agents');
  assert.equal(await fs.readFile(path.join(f.skill, 'SKILL.md'), 'utf8'), 'installed skill');
  const applied = await rollbackInstallation(f.stateRoot, { apply: true });
  assert.equal(applied.status, 'rolled_back');
  assert.equal(await fs.readFile(path.join(f.codexRoot, 'AGENTS.md'), 'utf8'), 'original agents');
  assert.equal(await fs.readFile(path.join(f.codexRoot, 'config.toml'), 'utf8'), 'original config');
  assert.equal(await fs.readFile(path.join(f.backup, 'disabled-skill', 'SKILL.md'), 'utf8'), 'installed skill');
  await assert.rejects(fs.stat(f.skill), { code: 'ENOENT' });
  const installation = JSON.parse(await fs.readFile(path.join(f.stateRoot, 'installation.json'), 'utf8'));
  assert.equal(installation.status, 'rolled_back');
});

test('a global file changed after installation blocks the whole rollback', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.codexRoot, 'AGENTS.md'), 'user edits after install');
  await assert.rejects(rollbackInstallation(f.stateRoot, { apply: true }), /modified|hash|changed/i);
  assert.equal(await fs.readFile(path.join(f.codexRoot, 'AGENTS.md'), 'utf8'), 'user edits after install');
  assert.equal(await fs.readFile(path.join(f.codexRoot, 'config.toml'), 'utf8'), 'installed config');
  assert.equal(await fs.readFile(path.join(f.skill, 'SKILL.md'), 'utf8'), 'installed skill');
  await assert.rejects(fs.stat(path.join(f.backup, 'disabled-skill')), { code: 'ENOENT' });
});

test('extra or edited skill files block rollback before touching globals', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.skill, 'extra.txt'), 'user addition');
  await assert.rejects(rollbackInstallation(f.stateRoot, { apply: true }), /skill|file|hash/i);
  assert.equal(await fs.readFile(path.join(f.codexRoot, 'config.toml'), 'utf8'), 'installed config');
  assert.equal(await fs.readFile(path.join(f.skill, 'extra.txt'), 'utf8'), 'user addition');
  await fs.rm(path.join(f.skill, 'extra.txt'));
  await fs.writeFile(path.join(f.skill, 'SKILL.md'), 'user edit');
  await assert.rejects(rollbackInstallation(f.stateRoot, { apply: true }), /skill|file|hash/i);
  assert.equal(await fs.readFile(path.join(f.codexRoot, 'AGENTS.md'), 'utf8'), 'installed agents');
});

test('backup or target outside the declared installation boundary is refused', async t => {
  const f = await fixture(t);
  f.installation.backup = path.join(f.base, 'outside');
  await fs.mkdir(f.installation.backup);
  await f.save();
  await assert.rejects(rollbackInstallation(f.stateRoot, { apply: true }), /backup|outside|escape/i);
  f.installation.backup = f.backup;
  f.manifest.changed[0].target = path.join(f.base, 'other', 'AGENTS.md');
  await f.save();
  await assert.rejects(rollbackInstallation(f.stateRoot, { apply: true }), /target|AGENTS|config/i);
  assert.equal(await fs.readFile(path.join(f.codexRoot, 'AGENTS.md'), 'utf8'), 'installed agents');
});

test('an installation with no global file changes can still park its skill', async t => {
  const f = await fixture(t);
  f.manifest.changed = [];
  await f.save();
  const result = await rollbackInstallation(f.stateRoot, { apply: true });
  assert.equal(result.status, 'rolled_back');
  assert.deepEqual(result.changedTargets, []);
  assert.equal(await fs.readFile(path.join(f.backup, 'disabled-skill', 'SKILL.md'), 'utf8'), 'installed skill');
  assert.equal(await fs.readFile(path.join(f.codexRoot, 'AGENTS.md'), 'utf8'), 'installed agents');
});
