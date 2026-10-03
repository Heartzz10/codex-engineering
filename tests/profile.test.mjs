import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadProfile } from '../src/profile.mjs';
import { VERSION } from '../src/paths.mjs';

test('an existing project document can be the discoverable feature map', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'profile-map-doc-'));
  try {
    await mkdir(path.join(root, 'docs'));
    await writeFile(path.join(root, 'AGENTS.md'), '# Project');
    await writeFile(path.join(root, 'docs', 'feature-map.md'), '# Features');
    const file = path.join(root, 'profile.json');
    const profile = {schemaVersion:1,id:'existing-project',sharedVersion:'0.1.0',root,
      authoritativeDocuments:['AGENTS.md'],featureMapDocument:'docs/feature-map.md',environmentRef:'local',checks:[]};
    await writeFile(file, JSON.stringify(profile));
    const loaded = await loadProfile(file);
    assert.equal(loaded.featureMapStatus, 'documented');
    assert.equal(loaded.featureMapDocumentPath, path.join(root, 'docs', 'feature-map.md'));
    profile.featureMapDocument = '../outside.md';
    await writeFile(file, JSON.stringify(profile));
    await assert.rejects(loadProfile(file), /escape|inside|exist/i);
  } finally { await rm(root, {recursive:true,force:true}); }
});

test('project entrypoint IDs are unique even when their URLs differ', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'profile-entrypoint-'));
  try {
    await writeFile(path.join(root, 'GUIDE.md'), '# Project');
    const file = path.join(root, 'profile.json');
    const profile = { schemaVersion: 2, id: 'entrypoint-project', sharedVersion: VERSION, root,
      authoritativeDocuments: ['GUIDE.md'], environmentRef: 'local', checks: [],
      entrypoints: [
        { id: 'ui-main', kind: 'real', url: 'http://127.0.0.1:4001/' },
        { id: 'ui-main', kind: 'real', url: 'http://127.0.0.1:4002/' }
      ] };
    await writeFile(file, JSON.stringify(profile));
    await assert.rejects(loadProfile(file), /duplicate entrypoint/i);
    profile.entrypoints[1].id = 'ui-secondary';
    await writeFile(file, JSON.stringify(profile));
    assert.equal((await loadProfile(file)).entrypoints.length, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});
