import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { runUISourceChecks } from '../src/ui-source-check.mjs';

async function isolatedBootstrap(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sample-bootstrap-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'docs')); await fs.mkdir(path.join(root, 'public'));
  const profileBytes = Buffer.from(JSON.stringify({ schemaVersion: 2, id: 'verification-sample', root,
    environmentRef: 'isolated-loopback', checks: [], userPreference: 'retain exact user setting' }));
  const mapBytes = Buffer.from('{"revision":55,"history":"must remain intact"}');
  await fs.writeFile(path.join(root, 'profile.json'), profileBytes);
  await fs.writeFile(path.join(root, 'docs/feature-map.json'), mapBytes);
  await fs.writeFile(path.join(root, 'public/index.html'), '<label for="n">Note</label><input id="n"><button type="submit">Save</button>');
  await fs.writeFile(path.join(root, 'ui-quality.json'), '{}');
  let source = await fs.readFile(new URL('../examples/verification-sample/bootstrap.mjs', import.meta.url), 'utf8');
  source = source.replace("'../../src/feature.mjs'", JSON.stringify(new URL('../src/feature.mjs', import.meta.url).href))
    .replace("'../../src/paths.mjs'", JSON.stringify(new URL('../src/paths.mjs', import.meta.url).href));
  const file = path.join(root, 'bootstrap.mjs'); await fs.writeFile(file, source);
  const module = await import(pathToFileURL(file).href);
  return { root, module, profileBytes, mapBytes };
}

test('importing sample bootstrap is side effect free and leaves existing profile and historical map intact', async t => {
  const f = await isolatedBootstrap(t);
  assert.ok((await fs.readFile(path.join(f.root, 'profile.json'))).equals(f.profileBytes), 'import preserves profile bytes');
  assert.ok((await fs.readFile(path.join(f.root, 'docs/feature-map.json'))).equals(f.mapBytes), 'import preserves historical map bytes');
  assert.equal(typeof f.module.configureSampleProfile, 'function');
});
test('sample UI binding and source runner are additive and do not reinitialize history', async t => {
  const f = await isolatedBootstrap(t);
  assert.equal(typeof f.module.configureSampleProfile, 'function');
  const profile = await f.module.configureSampleProfile({ sampleRoot: f.root });
  assert.equal(profile.userPreference, 'retain exact user setting'); assert.equal(profile.uiQualityRef, 'ui-quality.json');
  assert.equal(profile.checks.length, 1); assert.equal(profile.checks[0].id, 'ui-html-source');
  assert.deepEqual(profile.checks[0].effects, { writes: 'none', network: false, paid: false });
  assert.deepEqual(await fs.readFile(path.join(f.root, 'docs/feature-map.json')), f.mapBytes);
  const again = await f.module.configureSampleProfile({ sampleRoot: f.root }); assert.equal(again.checks.length, 1);
  const actual = await runUISourceChecks(profile, { sourceChecks: [{ checkId: 'ui-html-source', categoryIds: ['Q03','Q05','Q06','Q08','Q09'], sourceRef: 'GUIDE.md' }] }, { stateRoot: path.join(f.root, 'runner-state') });
  assert.equal(actual.status, 'passed'); assert.equal(actual.results[0].status, 'check_passed');
  assert.deepEqual(await fs.readFile(path.join(f.root, 'docs/feature-map.json')), f.mapBytes);
});
test('bootstrap --init rejects an existing historical map before changing profile or drafts', async t => {
  const f = await isolatedBootstrap(t);
  const result = spawnSync(process.execPath, [path.join(f.root, 'bootstrap.mjs'), '--init'], { cwd: f.root, windowsHide: true, encoding: 'utf8' });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /Historical sample map exists/);
  assert.ok((await fs.readFile(path.join(f.root, 'profile.json'))).equals(f.profileBytes));
  assert.ok((await fs.readFile(path.join(f.root, 'docs/feature-map.json'))).equals(f.mapBytes));
  await assert.rejects(fs.stat(path.join(f.root, 'initial-draft.json')), { code: 'ENOENT' });
});
