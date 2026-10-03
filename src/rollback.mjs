import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { assert, within } from './paths.mjs';

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const samePath = (a, b) => path.relative(a, b) === '';
const hashPattern = /^[a-f0-9]{64}$/;

async function regularFile(file) {
  const stat = await fs.lstat(file);
  assert(stat.isFile() && !stat.isSymbolicLink(), 'Expected a regular file without links');
  return fs.readFile(file);
}

async function missing(file) {
  try { await fs.lstat(file); return false; }
  catch (error) { if (error.code === 'ENOENT') return true; throw error; }
}

async function skillFileHashes(skill) {
  const files = {};
  let count = 0, bytes = 0;
  async function walk(directory, prefix = '') {
    for (const name of (await fs.readdir(directory)).sort()) {
      const full = path.join(directory, name);
      const stat = await fs.lstat(full);
      assert(!stat.isSymbolicLink(), 'Skill link prevents rollback');
      const relative = prefix ? `${prefix}/${name}` : name;
      if (stat.isDirectory()) await walk(full, relative);
      else {
        assert(stat.isFile(), 'Unexpected skill entry prevents rollback');
        count++; bytes += stat.size;
        assert(count <= 10000 && bytes <= 100 * 1024 * 1024, 'Skill directory exceeds rollback verification limit');
        files[relative] = sha256(await fs.readFile(full));
      }
    }
  }
  await walk(skill);
  return files;
}

function validRelativeFile(relative) {
  return typeof relative === 'string' && relative.length > 0 && !relative.includes('\\') &&
    !path.posix.isAbsolute(relative) && relative.split('/').every(part => part && part !== '.' && part !== '..');
}

async function verifySkill(skill, expected) {
  assert(expected && typeof expected === 'object' && !Array.isArray(expected), 'Invalid skillFiles manifest');
  const names = Object.keys(expected).sort();
  assert(names.length > 0 && names.every(name => validRelativeFile(name) && hashPattern.test(expected[name])), 'Invalid skillFiles manifest');
  const actual = await skillFileHashes(skill);
  assert(JSON.stringify(Object.keys(actual).sort()) === JSON.stringify(names), 'Skill file set changed after installation');
  for (const name of names) assert(actual[name] === expected[name], 'Skill file hash changed after installation');
}

async function preflight(stateRoot) {
  assert(typeof stateRoot === 'string' && path.isAbsolute(stateRoot), 'Absolute stateRoot required');
  const state = await fs.realpath(stateRoot);
  const backupRoot = await fs.realpath(path.join(state, 'backups'));
  assert(within(state, backupRoot) && !samePath(state, backupRoot), 'Backup root escapes state');
  const installationPath = path.join(state, 'installation.json');
  const installationBytes = await regularFile(installationPath);
  const installation = JSON.parse(installationBytes.toString('utf8'));
  assert(installation.status !== 'rolled_back', 'Installation is already rolled back');
  assert(typeof installation.skill === 'string' && path.isAbsolute(installation.skill), 'Invalid installed skill path');
  const skill = path.resolve(installation.skill);
  assert(path.basename(skill) === 'codex-engineering' && path.basename(path.dirname(skill)) === 'skills', 'Unexpected installed skill path');
  const codexRoot = path.dirname(path.dirname(skill));
  const realCodexRoot = await fs.realpath(codexRoot);
  const skillsRoot = await fs.realpath(path.join(codexRoot, 'skills'));
  assert(samePath(realCodexRoot, codexRoot) && samePath(skillsRoot, path.join(codexRoot, 'skills')), 'Codex root or skills directory is linked');
  assert((await fs.lstat(skill)).isDirectory() && samePath(await fs.realpath(skill), skill), 'Installed skill must be a real directory');
  assert(typeof installation.backup === 'string' && path.isAbsolute(installation.backup), 'Invalid backup path');
  const backup = await fs.realpath(installation.backup);
  assert(within(backupRoot, backup) && !samePath(backupRoot, backup), 'Backup outside state/backups');
  assert((await fs.stat(backup)).isDirectory(), 'Backup is not a directory');
  const disabledSkill = path.join(backup, 'disabled-skill');
  assert(await missing(disabledSkill), 'Disabled skill destination already exists');

  const manifest = JSON.parse((await regularFile(path.join(backup, 'manifest.json'))).toString('utf8'));
  assert(manifest.version === installation.version && manifest.createdSkill === installation.skill, 'Installation and backup manifest differ');
  assert(Array.isArray(manifest.changed) && manifest.changed.length <= 2, 'Invalid changed files manifest');
  const allowed = new Set(['AGENTS.md', 'config.toml'].map(name => path.join(codexRoot, name)));
  const seen = new Set();
  const changed = [];
  for (const entry of manifest.changed) {
    assert(entry && typeof entry.target === 'string' && allowed.has(entry.target) && !seen.has(entry.target), 'Changed target outside Codex globals');
    seen.add(entry.target);
    assert(validRelativeFile(entry.backup) && hashPattern.test(entry.installedHash), 'Invalid backup entry');
    const backupFile = path.resolve(backup, entry.backup);
    assert(within(backup, backupFile) && !samePath(backup, backupFile) && !samePath(backupFile, path.join(backup, 'manifest.json')), 'Backup file escapes backup directory');
    assert(within(backup, await fs.realpath(backupFile)), 'Backup file link escapes backup directory');
    const original = await regularFile(backupFile);
    assert(samePath(await fs.realpath(entry.target), entry.target), 'Changed target is linked');
    const installed = await regularFile(entry.target);
    assert(sha256(installed) === entry.installedHash, `Installed global file modified: ${path.basename(entry.target)}`);
    changed.push({ target: entry.target, original, installed, installedHash: entry.installedHash });
  }
  await verifySkill(skill, manifest.skillFiles);
  return { state, backup, backupRoot, skill, skillsRoot, codexRoot, disabledSkill, installationPath, installationBytes, installation, manifest, changed };
}

async function replaceIfHash(target, bytes, expectedHash) {
  assert(samePath(await fs.realpath(target), target), 'Changed target is linked');
  assert(sha256(await regularFile(target)) === expectedHash, `Global file changed during rollback: ${path.basename(target)}`);
  const temporary = `${target}.${crypto.randomUUID()}.rollback-tmp`;
  try {
    await fs.writeFile(temporary, bytes, { flag: 'wx' });
    // Recheck after staging so a later user edit is never silently replaced.
    assert(sha256(await regularFile(target)) === expectedHash, `Global file changed during rollback: ${path.basename(target)}`);
    await fs.rename(temporary, target);
  } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
}

/** Preview or revert exactly one recorded installation, without deleting its skill. */
export async function rollbackInstallation(stateRoot, { apply = false } = {}) {
  assert(typeof apply === 'boolean', 'apply must be boolean');
  const plan = await preflight(stateRoot);
  const summary = { status: apply ? 'rolled_back' : 'ready', apply, skill: plan.skill, backup: plan.backup, changedTargets: plan.changed.map(x => x.target) };
  if (!apply) return summary;

  // Resolve both move ends immediately before the recursive directory move.
  assert(samePath(await fs.realpath(plan.skill), plan.skill) && within(plan.skillsRoot, plan.skill), 'Skill move source escapes skills');
  assert(samePath(await fs.realpath(plan.backup), plan.backup) && within(plan.backupRoot, plan.disabledSkill), 'Skill move destination escapes backup');
  assert(await missing(plan.disabledSkill), 'Disabled skill destination already exists');
  await verifySkill(plan.skill, plan.manifest.skillFiles);
  for (const item of plan.changed) assert(sha256(await regularFile(item.target)) === item.installedHash, `Installed global file modified: ${path.basename(item.target)}`);

  const restored = [];
  let moved = false;
  try {
    await fs.rename(plan.skill, plan.disabledSkill);
    moved = true;
    for (const item of plan.changed) {
      await replaceIfHash(item.target, item.original, item.installedHash);
      restored.push(item);
    }
    const status = { ...plan.installation, status: 'rolled_back', rolledBackAt: new Date().toISOString() };
    await replaceIfHash(plan.installationPath, Buffer.from(`${JSON.stringify(status, null, 2)}\n`), sha256(plan.installationBytes));
    return summary;
  } catch (error) {
    const recoveryErrors = [];
    for (const item of restored.reverse()) {
      try { await replaceIfHash(item.target, item.installed, sha256(item.original)); }
      catch (recoveryError) { recoveryErrors.push(recoveryError.message); }
    }
    if (moved) {
      try {
        assert(await missing(plan.skill), 'Skill path occupied during recovery');
        await verifySkill(plan.disabledSkill, plan.manifest.skillFiles);
        await fs.rename(plan.disabledSkill, plan.skill);
      } catch (recoveryError) { recoveryErrors.push(recoveryError.message); }
    }
    if (recoveryErrors.length) throw new Error(`Rollback incomplete; inspect installation and backup: ${recoveryErrors.join('; ')}`, { cause: error });
    throw error;
  }
}
