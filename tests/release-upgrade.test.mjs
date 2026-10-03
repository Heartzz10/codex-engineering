import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mapHash } from '../src/feature-store.mjs';
import { preflightStableUpgrade, applyStableUpgrade, revertStableUpgrade } from '../src/release-upgrade.mjs';

const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

async function fixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'release-upgrade-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const state = path.join(base, 'state');
  const project = path.join(base, 'project');
  await fs.mkdir(path.join(state, 'profiles'), { recursive: true });
  await fs.mkdir(path.join(project, 'docs'), { recursive: true });
  const mapFile = path.join(project, 'docs', 'map.json');
  const map = { schemaVersion: 1, projectId: 'fixture', sharedVersion: '0.1.0', revision: 1,
    requirements: [], features: [], acceptanceCriteria: [], changes: [], evidence: [], iterations: [] };
  map.contentHash = mapHash(map);
  const mapBytes = Buffer.from(JSON.stringify(map));
  await fs.writeFile(mapFile, mapBytes);
  const profilePath = path.join(state, 'profiles', 'fixture.json');
  const profileBytes = Buffer.from(JSON.stringify({ schemaVersion: 1, id: 'fixture', sharedVersion: '0.1.0',
    root: project, authoritativeDocuments: ['docs/map.json'], environmentRef: 'test', checks: [],
    featureMapRef: { schemaVersion: 1, path: 'docs/map.json', historyDir: 'docs/history', evidenceDir: 'evidence' },
    userField: 'keep this exactly' }));
  await fs.writeFile(profilePath, profileBytes);

  async function release(version, name) {
    const root = path.join(base, name);
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    await fs.mkdir(path.join(root, 'schemas'));
    await fs.mkdir(path.join(root, 'catalog'));
    const paths = (await fs.readFile(new URL('../src/paths.mjs', import.meta.url), 'utf8'))
      .replace(/^export const VERSION = '[^']+';/m, `export const VERSION = '${version}';`);
    const contents = {
      'package.json': JSON.stringify({ version }),
      'src/paths.mjs': paths,
      'src/feature-store.mjs': await fs.readFile(new URL('../src/feature-store.mjs', import.meta.url), 'utf8'),
      'src/profile.mjs': await fs.readFile(new URL('../src/profile.mjs', import.meta.url), 'utf8'),
      'src/ui-quality.mjs': await fs.readFile(new URL('../src/ui-quality.mjs', import.meta.url), 'utf8'),
      'catalog/ui-quality-rules.json': await fs.readFile(new URL('../catalog/ui-quality-rules.json', import.meta.url), 'utf8'),
      'schemas/profile.schema.json': JSON.stringify({ properties: { schemaVersion: { enum: [1, 2] }, sharedVersion: { enum: ['0.1.0', '0.2.0'] } } }),
      'schemas/feature-map.schema.json': JSON.stringify({ properties: { schemaVersion: { const: 1 }, sharedVersion: { type: 'string' } } }),
    };
    const files = {};
    for (const name of Object.keys(contents).sort()) {
      const bytes = Buffer.from(contents[name]);
      await fs.writeFile(path.join(root, name), bytes);
      files[name] = hash(bytes);
    }
    const archive = path.join(base, `${name}.zip`);
    await fs.writeFile(archive, `${name} archive`);
    const manifestPath = path.join(base, `${name}.manifest.json`);
    await fs.writeFile(manifestPath, JSON.stringify({ schemaVersion: 1, version, commit: `${name}-commit`,
      archive, archiveSha256: hash(`${name} archive`), packageRoot: root,
      developmentRoot: path.join(base, 'dev'), files }));
    return { root, manifestPath };
  }
  const current = await release('0.1.0', 'current');
  const candidate = await release('0.2.0', 'candidate');
  const runtimePath = path.join(base, 'skills', 'codex-engineering', 'runtime.json');
  await fs.mkdir(path.dirname(runtimePath), { recursive: true });
  const runtimeBytes = Buffer.from(JSON.stringify({ packageRoot: current.root, stateRoot: state,
    packageVersion: '0.1.0', custom: 'untouched' }));
  await fs.writeFile(runtimePath, runtimeBytes);
  return { base, state, project, current, candidate, runtimePath, runtimeBytes,
    profilePath, profileBytes, mapFile, mapBytes, recordPath: path.join(state, 'upgrade.json'),
    options: { currentManifestPath: current.manifestPath, candidateManifestPath: candidate.manifestPath,
      runtimePath, profilePaths: [profilePath], recordPath: path.join(state, 'upgrade.json') } };
}

test('preflight is read-only; upgrade changes binding and profile and restores exact prior bytes', async t => {
  const f = await fixture(t);
  const plan = await preflightStableUpgrade(f.options);
  assert.equal(plan.status, 'ready');
  assert.equal(plan.mapsPreserved, 1);
  assert.deepEqual(await fs.readFile(f.runtimePath), f.runtimeBytes);
  assert.deepEqual(await fs.readFile(f.profilePath), f.profileBytes);
  assert.deepEqual(await fs.readFile(f.mapFile), f.mapBytes);
  const result = await applyStableUpgrade(f.options);
  assert.equal(result.status, 'upgraded');
  assert.equal(JSON.parse(await fs.readFile(f.runtimePath, 'utf8')).packageRoot, f.candidate.root);
  assert.equal(JSON.parse(await fs.readFile(f.profilePath, 'utf8')).sharedVersion, '0.2.0');
  assert.deepEqual(await fs.readFile(f.mapFile), f.mapBytes);
  assert.equal((await revertStableUpgrade(f.recordPath)).restored, 2);
  assert.deepEqual(await fs.readFile(f.runtimePath), f.runtimeBytes);
  assert.deepEqual(await fs.readFile(f.profilePath), f.profileBytes);
  assert.deepEqual(await fs.readFile(f.mapFile), f.mapBytes);
});

test('version mismatch, missing installed profile and changed map block before editing', async t => {
  const f = await fixture(t);
  await assert.rejects(preflightStableUpgrade({ ...f.options, profilePaths: [] }), /every installed profile/);
  await fs.writeFile(path.join(f.candidate.root, 'src', 'paths.mjs'), "export const VERSION = '9.9.9';\n");
  await assert.rejects(preflightStableUpgrade(f.options), /files changed/);
  await fs.writeFile(path.join(f.candidate.root, 'src', 'paths.mjs'),
    (await fs.readFile(new URL('../src/paths.mjs', import.meta.url), 'utf8'))
      .replace(/^export const VERSION = '[^']+';/m, "export const VERSION = '0.2.0';"));
  const map = JSON.parse(f.mapBytes.toString('utf8'));
  map.revision = 2;
  await fs.writeFile(f.mapFile, JSON.stringify(map));
  await assert.rejects(preflightStableUpgrade(f.options), /content hash|identity|schema/);
  assert.deepEqual(await fs.readFile(f.profilePath), f.profileBytes);
});

test('later user edit blocks entire revert; interrupted binding switch can be recovered', async t => {
  const f = await fixture(t);
  await applyStableUpgrade(f.options);
  const edited = Buffer.from('{"user":"new preference"}');
  await fs.writeFile(f.profilePath, edited);
  await assert.rejects(revertStableUpgrade(f.recordPath), /later edit/);
  assert.equal(JSON.parse(await fs.readFile(f.runtimePath, 'utf8')).packageVersion, '0.2.0');
  assert.deepEqual(await fs.readFile(f.profilePath), edited);
  const record = JSON.parse(await fs.readFile(f.recordPath, 'utf8'));
  await fs.writeFile(f.profilePath, Buffer.from(record.profiles[0].afterBase64, 'base64'));
  await fs.writeFile(f.runtimePath, f.runtimeBytes); // Simulate a crash before the runtime switch.
  assert.equal((await revertStableUpgrade(f.recordPath)).restored, 1);
  assert.deepEqual(await fs.readFile(f.profilePath), f.profileBytes);
  assert.deepEqual(await fs.readFile(f.runtimePath), f.runtimeBytes);
});

test('map changes after upgrade block downgrade without touching user data', async t => {
  const f = await fixture(t);
  await applyStableUpgrade(f.options);
  await fs.writeFile(f.mapFile, '{"user":"new map"}');
  await assert.rejects(revertStableUpgrade(f.recordPath), /Feature map changed/);
  assert.equal(JSON.parse(await fs.readFile(f.runtimePath, 'utf8')).packageVersion, '0.2.0');
});

test('new installed profile blocks old-version revert until its compatibility is resolved', async t => {
  const f = await fixture(t);
  await applyStableUpgrade(f.options);
  const extra = path.join(f.state, 'profiles', 'new-project.json');
  await fs.writeFile(extra, '{"sharedVersion":"0.2.0"}');
  await assert.rejects(revertStableUpgrade(f.recordPath), /every installed profile/);
  assert.equal(JSON.parse(await fs.readFile(f.runtimePath, 'utf8')).packageVersion, '0.2.0');
});

test('candidate declared source version must match its verified file manifest', async t => {
  const f = await fixture(t);
  const file = path.join(f.candidate.root, 'src', 'paths.mjs');
  const bytes = Buffer.from("export const VERSION = '0.3.0';\n");
  await fs.writeFile(file, bytes);
  const manifest = JSON.parse(await fs.readFile(f.candidate.manifestPath, 'utf8'));
  manifest.files['src/paths.mjs'] = hash(bytes);
  await fs.writeFile(f.candidate.manifestPath, JSON.stringify(manifest));
  await assert.rejects(preflightStableUpgrade(f.options), /source VERSION differs/);
  assert.deepEqual(await fs.readFile(f.runtimePath), f.runtimeBytes);
});

test('candidate real profile loader can reject a schema-compatible migrated copy', async t => {
  const f = await fixture(t);
  const candidateLoader = path.join(f.candidate.root, 'src', 'profile.mjs');
  const bytes = Buffer.from("export async function loadProfile() { throw new Error('candidate_loader_rejects_profile'); }\n");
  await fs.writeFile(candidateLoader, bytes);
  const manifest = JSON.parse(await fs.readFile(f.candidate.manifestPath, 'utf8'));
  manifest.files['src/profile.mjs'] = hash(bytes);
  await fs.writeFile(f.candidate.manifestPath, JSON.stringify(manifest));
  await assert.rejects(preflightStableUpgrade(f.options), /candidate_loader_rejects_profile/);
  assert.deepEqual(await fs.readFile(f.profilePath), f.profileBytes);
});

test('CLI preflight exposes only summary, never profile backup bytes', async t => {
  const f = await fixture(t);
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/release-upgrade.mjs', import.meta.url)),
    'preflight', '--current', f.current.manifestPath, '--candidate', f.candidate.manifestPath,
    '--runtime', f.runtimePath, '--profile', f.profilePath], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).installedProfiles, 1);
  assert.doesNotMatch(result.stdout, /beforeBase64|keep this exactly|userField/);
});
