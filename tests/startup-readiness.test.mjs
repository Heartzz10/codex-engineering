import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { canonicalize, hashContent, mapHash } from '../src/feature-store.mjs';
import { startupReadiness } from '../src/startup-readiness.mjs';
import { VERSION } from '../src/paths.mjs';

test('startup summary reports applicable gaps and does not require UI for documentation', () => {
  const p = { authoritativeDocuments: ['GUIDE.md'], checks: [], entrypoints: [], featureMapStatus: 'needs_feature_map', acceptanceRoutes: [], controls: {}, uiQualityStatus: 'not_configured' };
  const actual = startupReadiness(p, { kind: 'ui' });
  assert.deepEqual(actual.gaps.map(g => g.id), ['entrypoints', 'checks', 'feature_map', 'source_scope', 'acceptance', 'ui_quality']);
  assert.deepEqual(startupReadiness(p, { workType: 'documentation' }).gaps, []);
  const localPage = startupReadiness({ ...p, entrypoints: [{ id: 'local-html' }],
    acceptanceRoutes: [{ kind: 'ui', driverRef: 'browser', available: true }] });
  assert.equal(localPage.taskScope, 'ui');
  assert(localPage.gaps.some(gap => gap.id === 'ui_quality'));
  const ready = startupReadiness({ ...p, checks: [{}], entrypoints: [{ id: 'ui-create' }], featureMapStatus: 'configured',
    acceptanceRoutes: [{ driverRef: 'driver.mjs', available: true }], controls: { sourceReview: { inputs: ['app.mjs'] } }, uiQualityStatus: 'configured' }, { kind: 'ui' });
  assert.equal(ready.status, 'registered_for_checks');
  assert.match(ready.action, /真实业务验收/);
});

test('shipped draft initializes through the CLI and hash vectors match canonical rules', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ce-template-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'GUIDE.md'), 'isolated template test');
  const profile = { schemaVersion: 2, id: 'template-sample', sharedVersion: VERSION, root,
    authoritativeDocuments: ['GUIDE.md'], environmentRef: 'isolated', checks: [],
    featureMapRef: { schemaVersion: 1, path: 'docs/map.json', historyDir: 'docs/history', evidenceDir: 'evidence' } };
  const profilePath = path.join(root, 'profile.json');
  await fs.writeFile(profilePath, JSON.stringify(profile));
  const draftPath = path.resolve('templates/feature-map.example.json');
  const run = spawnSync(process.execPath, ['src/cli.mjs', 'feature', 'init', '--profile', profilePath, '--draft', draftPath,
    '--expected-revision', '0', '--expected-hash', 'absent', '--request-id', 'template-init'], { encoding: 'utf8', windowsHide: true });
  assert.equal(run.status, 0, run.stderr);
  const map = JSON.parse(await fs.readFile(path.join(root, 'docs/map.json'), 'utf8'));
  assert.equal(map.features[0].id, 'FEAT-0001');
  assert.equal(map.changes[0].status, 'open');
  const vectors = JSON.parse(await fs.readFile('templates/hash-vectors.json', 'utf8'));
  for (const vector of vectors.vectors) {
    const value = vector.operation === 'mapHash' ? (({ contentHash, ...rest }) => rest)(vector.value) : vector.value;
    assert.equal(canonicalize(value), vector.canonical, vector.name);
    assert.equal((vector.operation === 'mapHash' ? mapHash : hashContent)(vector.value), vector.sha256, vector.name);
  }
});
