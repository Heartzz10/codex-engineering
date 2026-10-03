import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { buildReleaseCandidate } from '../src/release-candidate.mjs';
import { stageStableRelease, verifyStableRelease } from '../src/stable-release.mjs';

function git(root, args) {
  return execFileSync('git', args, { cwd: root, windowsHide: true }).toString('utf8').trim();
}

async function fixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'release-candidate-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const source = path.join(base, 'source');
  await fs.mkdir(path.join(source, 'src'), { recursive: true });
  await fs.writeFile(path.join(source, 'package.json'), '{"version":"0.2.0"}\n');
  await fs.writeFile(path.join(source, 'src', 'paths.mjs'), "export const VERSION = '0.2.0';\n");
  git(source, ['init']);
  git(source, ['config', 'user.name', 'Fixture']);
  git(source, ['config', 'user.email', 'fixture@example.invalid']);
  git(source, ['add', '.']);
  git(source, ['commit', '-m', 'Pinned candidate fixture']);
  return { base, source, sourceRoot: source, archivePath: path.join(base, 'candidate.zip'),
    releaseFile: path.join(base, 'release.json'), packageRoot: path.join(base, 'stable') };
}

test('clean commit builds a repeatable candidate that stages and verifies against Git', async t => {
  const f = await fixture(t);
  const built = await buildReleaseCandidate(f);
  assert.equal(built.status, 'candidate_built');
  assert.equal(built.commit, git(f.source, ['rev-parse', 'HEAD']));
  assert.equal((await stageStableRelease({ releaseFile: f.releaseFile,
    packageRoot: f.packageRoot, sourceRoot: f.source })).status, 'staged');
  assert.equal((await verifyStableRelease(`${f.packageRoot}.manifest.json`)).version, '0.2.0');
  const next = await buildReleaseCandidate({ sourceRoot: f.source,
    archivePath: path.join(f.base, 'candidate-second.zip'),
    releaseFile: path.join(f.base, 'release-second.json') });
  assert.equal(next.sha256, built.sha256);
});

test('staging verifies a committed file through its blob ID when its path is long', async t => {
  const f = await fixture(t);
  const relative = path.join('docs', ...Array.from({ length: 8 }, (_, n) => `long-path-segment-${n}`), 'reference.md');
  const file = path.join(f.source, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, 'Long path content\n');
  git(f.source, ['-c', 'core.longpaths=true', 'add', '.']);
  git(f.source, ['commit', '-m', 'Long path regression']);
  await buildReleaseCandidate(f);
  const staged = await stageStableRelease({ releaseFile: f.releaseFile,
    packageRoot: f.packageRoot, sourceRoot: f.source });
  assert.equal(staged.status, 'staged');
  assert.equal((await fs.readFile(path.join(f.packageRoot, relative), 'utf8')).replaceAll('\r\n', '\n'), 'Long path content\n');
  assert.equal((await verifyStableRelease(`${f.packageRoot}.manifest.json`)).files, staged.files);
});

test('dirty or mismatched source version blocks candidate without creating an archive', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.source, 'extra.txt'), 'not committed');
  await assert.rejects(buildReleaseCandidate(f), /Dirty source/);
  await assert.rejects(fs.stat(f.archivePath), { code: 'ENOENT' });
  await fs.rm(path.join(f.source, 'extra.txt'));
  await fs.writeFile(path.join(f.source, 'src', 'paths.mjs'), "export const VERSION = '9.9.9';\n");
  git(f.source, ['add', '.']);
  git(f.source, ['commit', '-m', 'Bad version']);
  await assert.rejects(buildReleaseCandidate(f), /versions differ/);
  await assert.rejects(fs.stat(f.releaseFile), { code: 'ENOENT' });
});

test('tracked raw evidence is excluded from a distributable candidate', async t => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.source, 'examples', 'fixture', 'evidence'), { recursive: true });
  await fs.writeFile(path.join(f.source, 'examples', 'fixture', 'evidence', 'raw.json'), '{}');
  git(f.source, ['add', '.']);
  git(f.source, ['commit', '-m', 'Raw evidence']);
  await assert.rejects(buildReleaseCandidate(f), /raw evidence paths/);
  await assert.rejects(fs.stat(f.archivePath), { code: 'ENOENT' });
});

test('local review configuration is excluded before candidate archive creation', async t => {
  const f = await fixture(t);
  const privateFile = path.join(f.source, 'skills', 'review-product-plan', 'runtime.local.json');
  await fs.mkdir(path.dirname(privateFile), { recursive: true });
  const bytes = '{"keyFile":"synthetic-local-reference"}\n';
  await fs.writeFile(privateFile, bytes);
  git(f.source, ['add', '.']);
  git(f.source, ['commit', '-m', 'Synthetic private configuration']);
  await assert.rejects(buildReleaseCandidate(f), /private or raw evidence paths/);
  await assert.rejects(fs.stat(f.archivePath), { code: 'ENOENT' });
  assert.equal(await fs.readFile(privateFile, 'utf8'), bytes);
});
