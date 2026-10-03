import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { inspectReleaseScope, prepareReleaseScope, verifyReleaseScope } from '../src/release-scope.mjs';
import { buildReleaseCandidate } from '../src/release-candidate.mjs';
import { stageStableRelease, verifyStableRelease } from '../src/stable-release.mjs';

const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function git(root, args) {
  return execFileSync('git', args, { cwd: root, windowsHide: true }).toString('utf8').trim();
}

async function fixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'release-scope-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const source = path.join(base, 'dirty-source'), destination = path.join(base, 'candidate');
  await fs.mkdir(path.join(source, 'src'), { recursive: true });
  await fs.mkdir(path.join(source, 'catalog'));
  await fs.mkdir(path.join(source, 'schemas'));
  await fs.mkdir(path.join(source, 'examples'));
  await fs.mkdir(path.join(source, 'upstream', 'pstack', 'sources', 'pstack'), { recursive: true });
  const license = Buffer.from('MIT fixture license\n');
  await fs.writeFile(path.join(source, 'upstream', 'pstack', 'sources', 'pstack', 'LICENSE'), license);
  await fs.writeFile(path.join(source, 'upstream', 'pstack', 'source-lock.json'), JSON.stringify({ files: [
    { verificationStatus: 'verified', snapshotPath: 'upstream/pstack/sources/pstack/LICENSE', sha256: hash(license) },
  ] }));
  await fs.writeFile(path.join(source, 'package.json'), '{"version":"0.2.0"}\n');
  await fs.writeFile(path.join(source, 'src', 'paths.mjs'), "export const VERSION = '0.2.0';\n");
  await fs.writeFile(path.join(source, 'catalog', 'index.json'), JSON.stringify({ version: '0.2.0', resources: [{ version: '0.2.0' }] }));
  await fs.writeFile(path.join(source, 'schemas', 'catalog.schema.json'), JSON.stringify({ properties: {
    version: { const: '0.2.0' }, resources: { items: { properties: { version: { const: '0.2.0' } } } },
  } }));
  await fs.writeFile(path.join(source, 'schemas', 'receipt.schema.json'), JSON.stringify({ properties: { packageVersion: { const: '0.2.0' } } }));
  await fs.writeFile(path.join(source, 'schemas', 'profile.schema.json'), JSON.stringify({ properties: { sharedVersion: { enum: ['0.2.0', '0.3.0'] } } }));
  await fs.writeFile(path.join(source, 'examples', 'project-profile.example.json'), '{"sharedVersion":"0.2.0"}');
  await fs.writeFile(path.join(source, 'README.md'), '# Old development README\n');
  await fs.writeFile(path.join(source, 'CHANGELOG.md'), '# Previous releases\n');
  const scope = { schemaVersion: 1,
    files: ['release-scope.json', 'package.json', 'upstream/pstack/source-lock.json',
      'README.md', 'CHANGELOG.md', 'examples/project-profile.example.json'],
    directories: [{ path: 'src', recursive: false, strict: true, suffixes: ['.mjs'] },
      { path: 'catalog', recursive: false, strict: true, suffixes: ['.json'] },
      { path: 'schemas', recursive: false, strict: true, suffixes: ['.json'] }],
    lockedSources: 'upstream/pstack/source-lock.json' };
  const scopeFile = path.join(source, 'release-scope.json');
  await fs.writeFile(scopeFile, JSON.stringify(scope));
  git(source, ['init']);
  git(source, ['config', 'user.name', 'Fixture']);
  git(source, ['config', 'user.email', 'fixture@example.invalid']);
  git(source, ['add', '.']);
  git(source, ['commit', '-m', 'Base']);
  await fs.mkdir(path.join(source, 'evidence'));
  await fs.writeFile(path.join(source, 'evidence', 'private.txt'), 'private raw result');
  return { base, source, destination, scopeFile, scope };
}

test('dirty development source becomes exact clean candidate with pinned upstream and reproducible archive', async t => {
  const f = await fixture(t);
  const prepared = await prepareReleaseScope({ sourceRoot: f.source,
    destinationRoot: f.destination, scopeFile: f.scopeFile });
  assert.equal(prepared.status, 'snapshot_ready_for_review');
  assert.equal(prepared.sourceWorkingTreeDirty, true);
  assert.equal(prepared.pinnedUpstreamFiles, 1);
  assert.equal((await verifyReleaseScope(f.destination)).status, 'verified_for_review');
  await assert.rejects(fs.stat(path.join(f.destination, 'evidence', 'private.txt')), { code: 'ENOENT' });
  git(f.destination, ['init']);
  git(f.destination, ['config', 'user.name', 'Fixture']);
  git(f.destination, ['config', 'user.email', 'fixture@example.invalid']);
  git(f.destination, ['add', '.']);
  git(f.destination, ['commit', '-m', 'Curated candidate']);
  const archivePath = path.join(f.base, 'candidate.zip');
  const releaseFile = path.join(f.base, 'release.json');
  await buildReleaseCandidate({ sourceRoot: f.destination, archivePath, releaseFile });
  const stable = path.join(f.base, 'stable');
  await stageStableRelease({ sourceRoot: f.destination, releaseFile, packageRoot: stable });
  assert.equal((await verifyStableRelease(`${stable}.manifest.json`)).version, '0.2.0');
});

test('changed candidate bytes and extra files fail scope verification', async t => {
  const f = await fixture(t);
  await prepareReleaseScope({ sourceRoot: f.source, destinationRoot: f.destination, scopeFile: f.scopeFile });
  await fs.writeFile(path.join(f.destination, 'src', 'paths.mjs'), "export const VERSION = '9.9.9';\n");
  await assert.rejects(verifyReleaseScope(f.destination), /Candidate file changed/);
  await fs.writeFile(path.join(f.destination, 'src', 'paths.mjs'), "export const VERSION = '0.2.0';\n");
  await fs.writeFile(path.join(f.destination, 'extra.txt'), 'not in scope');
  await assert.rejects(verifyReleaseScope(f.destination), /unreviewed or missing/);
});

test('traversal and unreviewed code file type block before candidate creation', async t => {
  const f = await fixture(t);
  f.scope.files.push('../private.txt');
  await fs.writeFile(f.scopeFile, JSON.stringify(f.scope));
  await assert.rejects(prepareReleaseScope({ sourceRoot: f.source, destinationRoot: f.destination,
    scopeFile: f.scopeFile }), /Unsafe release selection/);
  await assert.rejects(fs.stat(f.destination), { code: 'ENOENT' });
  f.scope.files.pop();
  await fs.writeFile(f.scopeFile, JSON.stringify(f.scope));
  await fs.writeFile(path.join(f.source, 'src', 'unreviewed.ts'), 'export {}');
  await assert.rejects(prepareReleaseScope({ sourceRoot: f.source, destinationRoot: f.destination,
    scopeFile: f.scopeFile }), /Unreviewed release file type/);
});

test('candidate-only version conversion is explicit, hashed and leaves dirty source unchanged', async t => {
  const f = await fixture(t);
  const sourcePackage = await fs.readFile(path.join(f.source, 'package.json'));
  const planned = await inspectReleaseScope({ sourceRoot: f.source, scopeFile: f.scopeFile,
    candidateVersion: '0.3.0' });
  assert.equal(planned.transformations, 8);
  const prepared = await prepareReleaseScope({ sourceRoot: f.source, destinationRoot: f.destination,
    scopeFile: f.scopeFile, candidateVersion: '0.3.0' });
  assert.equal(prepared.transformations, 8);
  assert.equal((await verifyReleaseScope(f.destination)).candidateVersion, '0.3.0');
  assert.equal(JSON.parse(await fs.readFile(path.join(f.destination, 'package.json'), 'utf8')).version, '0.3.0');
  assert.equal(JSON.parse(await fs.readFile(path.join(f.destination, 'catalog', 'index.json'), 'utf8')).resources[0].version, '0.3.0');
  assert.match(await fs.readFile(path.join(f.destination, 'README.md'), 'utf8'), /0\.3\.0/);
  assert.deepEqual(await fs.readFile(path.join(f.source, 'package.json')), sourcePackage);
  const manifest = JSON.parse(await fs.readFile(path.join(f.destination, 'release-scope-manifest.json'), 'utf8'));
  assert.equal(manifest.transformations['package.json'].sourceSha256, hash(sourcePackage));
  assert.equal(manifest.transformations['package.json'].candidateSha256, manifest.files['package.json']);
  git(f.destination, ['init']);
  git(f.destination, ['config', 'user.name', 'Fixture']);
  git(f.destination, ['config', 'user.email', 'fixture@example.invalid']);
  git(f.destination, ['add', '.']);
  git(f.destination, ['commit', '-m', 'Converted candidate']);
  const archivePath = path.join(f.base, 'converted.zip'), releaseFile = path.join(f.base, 'converted.json');
  await buildReleaseCandidate({ sourceRoot: f.destination, archivePath, releaseFile });
  const stable = path.join(f.base, 'converted-stable');
  await stageStableRelease({ sourceRoot: f.destination, releaseFile, packageRoot: stable });
  assert.equal((await verifyStableRelease(`${stable}.manifest.json`)).version, '0.3.0');
});

test('candidate-only lock version conversion preserves every dependency integrity and source lock bytes', async t => {
  const f = await fixture(t);
  const lock = { name: 'fixture', version: '0.2.0', lockfileVersion: 3, packages: {
    '': { name: 'fixture', version: '0.2.0', devDependencies: { 'html-validate': '10.9.0' } },
    'node_modules/html-validate': { version: '10.9.0', integrity: 'sha512-locked', resolved: 'https://registry.npmjs.org/html-validate/-/html-validate-10.9.0.tgz' }
  } };
  const bytes = Buffer.from(JSON.stringify(lock));
  await fs.writeFile(path.join(f.source, 'package-lock.json'), bytes);
  f.scope.files.push('package-lock.json'); await fs.writeFile(f.scopeFile, JSON.stringify(f.scope));
  await prepareReleaseScope({ sourceRoot: f.source, destinationRoot: f.destination, scopeFile: f.scopeFile, candidateVersion: '0.3.0' });
  const candidate = JSON.parse(await fs.readFile(path.join(f.destination, 'package-lock.json'), 'utf8'));
  assert.equal(candidate.version, '0.3.0'); assert.equal(candidate.packages[''].version, '0.3.0');
  assert.deepEqual(candidate.packages['node_modules/html-validate'], lock.packages['node_modules/html-validate']);
  assert.deepEqual(await fs.readFile(path.join(f.source, 'package-lock.json')), bytes);
  const manifest = JSON.parse(await fs.readFile(path.join(f.destination, 'release-scope-manifest.json'), 'utf8'));
  assert.equal(manifest.transformations['package-lock.json'].sourceSha256, hash(bytes));
});
