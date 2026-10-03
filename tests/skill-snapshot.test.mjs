import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { applySkillSnapshot, revertSkillSnapshot } from '../src/skill-snapshot.mjs';

const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
async function fixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-snapshot-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const stable = path.join(base, 'stable'), development = path.join(base, 'development'), skillRoot = path.join(base, 'skills');
  await fs.mkdir(stable); await fs.mkdir(development); await fs.mkdir(skillRoot);
  const publicFiles = {
    'package.json': '{"version":"0.3.0"}\n',
    'skills/codex-engineering/SKILL.md': '# New engineering skill\n',
    'skills/codex-engineering/runtime.json': '{"candidate":"template must be ignored"}',
    'skills/codex-engineering/scripts/engineering.mjs': 'export const VERSION = "0.3.0";\n',
    'skills/review-product-plan/SKILL.md': '# New review skill\n',
    'skills/review-product-plan/runtime.local.json': '{"candidate":"private template must be ignored"}',
    'src/public.mjs': 'export const VERSION = "0.3.0";\n'
  };
  const files = {};
  for (const [relative, content] of Object.entries(publicFiles).sort(([a], [b]) => a.localeCompare(b))) {
    const target = path.join(stable, relative); await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content); files[relative] = hash(content);
  }
  // verifyStableRelease walks lexicographic names with JS sort.
  const sortedFiles = Object.fromEntries(Object.entries(files).sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0));
  const archive = path.join(base, 'archive.zip'); await fs.writeFile(archive, 'verified fixture archive');
  const manifestPath = path.join(base, 'stable.manifest.json');
  await fs.writeFile(manifestPath, JSON.stringify({ schemaVersion: 1, version: '0.3.0', commit: 'fixture', archive,
    archiveSha256: hash('verified fixture archive'), packageRoot: stable, developmentRoot: development, files: sortedFiles }));
  const prior = new Map([
    ['codex-engineering/SKILL.md', Buffer.from('# User old skill\r\n\0binary-safe')],
    ['codex-engineering/runtime.json', Buffer.from('{ "private": "binding" }\r\n')],
    ['codex-engineering/runtime.local.json', Buffer.from('{ "private": "token" }\r\n')],
    ['codex-engineering/user-notes.md', Buffer.from('personal file')],
    ['review-product-plan/SKILL.md', Buffer.from('# Prior review\r\n')],
    ['review-product-plan/runtime.local.json', Buffer.from('{"private":"review binding"}')]
  ]);
  for (const [relative, bytes] of prior) { const target = path.join(skillRoot, relative); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, bytes); }
  return { base, stable, skillRoot, manifestPath, backupDir: path.join(base, 'backup'), prior, publicFiles };
}

test('manifest skill refresh retains both private runtimes and unlisted user files', async t => {
  const f = await fixture(t), result = await applySkillSnapshot(f);
  assert.equal(result.status, 'applied');
  for (const relative of ['codex-engineering/runtime.json', 'codex-engineering/runtime.local.json', 'codex-engineering/user-notes.md', 'review-product-plan/runtime.local.json'])
    assert.deepEqual(await fs.readFile(path.join(f.skillRoot, relative)), f.prior.get(relative));
  assert.equal(await fs.readFile(path.join(f.skillRoot, 'codex-engineering/scripts/engineering.mjs'), 'utf8'), 'export const VERSION = "0.3.0";\n');
  await assert.rejects(fs.stat(path.join(f.skillRoot, 'src/public.mjs')), /ENOENT/);
});
test('revert restores exact old bytes and removes only its own new files while retaining backup', async t => {
  const f = await fixture(t), result = await applySkillSnapshot(f);
  assert.equal((await revertSkillSnapshot(result.recordPath)).status, 'reverted');
  for (const [relative, bytes] of f.prior) assert.deepEqual(await fs.readFile(path.join(f.skillRoot, relative)), bytes);
  await assert.rejects(fs.stat(path.join(f.skillRoot, 'codex-engineering/scripts/engineering.mjs')), /ENOENT/);
  assert((await fs.stat(result.recordPath)).isFile());
});
test('later user edit rejects the entire revert before any other file is restored', async t => {
  const f = await fixture(t), result = await applySkillSnapshot(f);
  await fs.writeFile(path.join(f.skillRoot, 'review-product-plan/SKILL.md'), 'later user edit');
  await assert.rejects(revertSkillSnapshot(result.recordPath), /later edit|changed/);
  assert.equal(await fs.readFile(path.join(f.skillRoot, 'codex-engineering/SKILL.md'), 'utf8'), '# New engineering skill\n');
  assert.equal(await fs.readFile(path.join(f.skillRoot, 'review-product-plan/SKILL.md'), 'utf8'), 'later user edit');
  assert((await fs.stat(path.join(f.skillRoot, 'codex-engineering/scripts/engineering.mjs'))).isFile());
});
test('linked target parent is rejected before touching any skill', async t => {
  const f = await fixture(t), outside = path.join(f.base, 'outside'); await fs.mkdir(outside);
  await fs.symlink(outside, path.join(f.skillRoot, 'codex-engineering/scripts'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(applySkillSnapshot(f), /link/);
  assert.deepEqual(await fs.readFile(path.join(f.skillRoot, 'codex-engineering/SKILL.md')), f.prior.get('codex-engineering/SKILL.md'));
});
test('a real file write failure restores earlier targets without erasing a later user edit', async t => {
  const f = await fixture(t);
  const originalRename = fs.rename, edited = path.join(f.skillRoot, 'codex-engineering/SKILL.md');
  fs.rename = async (from, to) => {
    if (to === path.join(f.skillRoot, 'review-product-plan/SKILL.md')) {
      await fs.writeFile(edited, 'user edit after apply began');
      throw Error('controlled filesystem write failure');
    }
    return originalRename(from, to);
  };
  try { await assert.rejects(applySkillSnapshot(f), /controlled filesystem write failure/); }
  finally { fs.rename = originalRename; }
  assert.equal(await fs.readFile(edited, 'utf8'), 'user edit after apply began');
  assert.deepEqual(await fs.readFile(path.join(f.skillRoot, 'review-product-plan/SKILL.md')), f.prior.get('review-product-plan/SKILL.md'));
  await assert.rejects(fs.stat(path.join(f.skillRoot, 'codex-engineering/scripts/engineering.mjs')), /ENOENT/);
});
test('write failure restores every prior successful overwrite and newly created file', async t => {
  const f = await fixture(t), originalRename = fs.rename;
  fs.rename = async (from, to) => {
    if (to === path.join(f.skillRoot, 'review-product-plan/SKILL.md')) throw Error('controlled final-file failure');
    return originalRename(from, to);
  };
  try { await assert.rejects(applySkillSnapshot(f), /controlled final-file failure.*restore completed/); }
  finally { fs.rename = originalRename; }
  for (const [relative, bytes] of f.prior) assert.deepEqual(await fs.readFile(path.join(f.skillRoot, relative)), bytes);
  await assert.rejects(fs.stat(path.join(f.skillRoot, 'codex-engineering/scripts/engineering.mjs')), /ENOENT/);
});
test('changed stable source is rejected before installing any snapshot file', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.stable, 'skills/codex-engineering/SKILL.md'), '# changed after manifest');
  await assert.rejects(applySkillSnapshot(f), /Stable release files changed/);
  for (const [relative, bytes] of f.prior) assert.deepEqual(await fs.readFile(path.join(f.skillRoot, relative)), bytes);
});
test('later user edit of a newly added file cannot be deleted by revert', async t => {
  const f = await fixture(t), result = await applySkillSnapshot(f);
  const added = path.join(f.skillRoot, 'codex-engineering/scripts/engineering.mjs');
  await fs.writeFile(added, '// later user script');
  await assert.rejects(revertSkillSnapshot(result.recordPath), /later edit/);
  assert.equal(await fs.readFile(added, 'utf8'), '// later user script');
  assert.equal(await fs.readFile(path.join(f.skillRoot, 'codex-engineering/SKILL.md'), 'utf8'), '# New engineering skill\n');
});
test('a traversal target in a structurally rehashed record is still rejected', async t => {
  const f = await fixture(t), result = await applySkillSnapshot(f);
  const record = JSON.parse(await fs.readFile(result.recordPath, 'utf8'));
  record.entries[0].relative = 'codex-engineering/../../outside.txt';
  delete record.contentHash; record.contentHash = hash(Buffer.from(JSON.stringify(record)));
  await fs.writeFile(result.recordPath, JSON.stringify(record));
  await assert.rejects(revertSkillSnapshot(result.recordPath), /Unsafe snapshot path/);
  assert.equal(await fs.readFile(path.join(f.skillRoot, 'codex-engineering/SKILL.md'), 'utf8'), '# New engineering skill\n');
});
