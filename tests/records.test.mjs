import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { queryRecords, rebuildRecordsIndex } from '../src/records.mjs';

const record = (id, scope, text, extra = {}) => ({
  id, kind: 'preference', scope, text, sourceRef: `user:${id}`, status: 'active',
  updatedAt: '2026-09-23T00:00:00Z', ...extra,
});

async function fixture(fn) {
  const root = await mkdtemp(join(tmpdir(), 'codex-records-'));
  const add = async (folder, name, value) => {
    await mkdir(join(root, folder), { recursive: true });
    await writeFile(join(root, folder, name), JSON.stringify(value));
  };
  try { await fn(root, add); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test('missing directories yield an empty index without source text', async () => fixture(async root => {
  assert.deepEqual(await rebuildRecordsIndex(root), { count: 0 });
  assert.deepEqual(await queryRecords(root), []);
  const index = JSON.parse(await readFile(join(root, 'records', 'index.json'), 'utf8'));
  assert.deepEqual(index.entries, []);
}));

test('Chinese sentence query recalls shared phrases without requiring spaces', async () => fixture(async (root, add) => {
  await add('decisions', 'save.json', record('save', 'project:a', '保存必须持久化；刷新页面之后应能读回笔记正文。'));
  await add('decisions', 'noise.json', record('noise', 'project:a', '设置页支持主题颜色。'));
  assert.deepEqual((await queryRecords(root, { scope: 'project:a', query: '保存后刷新不见了' })).map(row => row.id), ['save']);
}));

test('full scoped reading keeps every small-library record and full original identity', async () => fixture(async (root, add) => {
  const { readScopedRecords } = await import('../src/records.mjs');
  for (let i = 0; i < 10; i++) await add('decisions', `${i}.json`, record(`d${i}`, 'project:a', 'x'.repeat(700)));
  await add('decisions', 'private.json', record('other', 'project:b', 'other'));
  const result = await readScopedRecords(root, { scope: 'project:a' });
  assert.equal(result.records.length, 10);
  assert.equal(result.records[0].text.length, 700);
  assert.equal(result.records[0].binding.path.startsWith('decisions/'), true);
  assert.match(result.records[0].binding.sha256, /^[a-f0-9]{64}$/);
  assert.equal(result.manifest.length, 10);
}));

test('project queries include global records but isolate other projects and superseded records', async () => fixture(async (root, add) => {
  await add('preferences', 'global.json', record('g', 'global', 'Use concise reports', { tags: ['reports'] }));
  await add('decisions', 'a.json', record('a', 'project:a', 'Project A reports'));
  await add('decisions', 'b.json', record('b', 'project:b', 'Project B reports'));
  await add('decisions', 'old.json', record('old', 'global', 'Old reports', { status: 'superseded' }));
  const a = await queryRecords(root, { scope: 'project:a', query: 'reports' });
  assert.deepEqual(a.map(x => x.id).sort(), ['a', 'g']);
  assert.deepEqual((await queryRecords(root, { scope: 'global' })).map(x => x.id), ['g']);
  assert.deepEqual((await queryRecords(root, { scope: 'project:b' })).map(x => x.id).sort(), ['b', 'g']);
  const index = await readFile(join(root, 'records', 'index.json'), 'utf8');
  assert.ok(!index.includes('Use concise reports'));
  assert.ok(!index.includes('Old reports'));
}));

test('source edits and damaged index rebuild from source, with bounded summaries and result count', async () => fixture(async (root, add) => {
  await add('preferences', 'one.json', record('one', 'global', 'Initial'));
  await rebuildRecordsIndex(root);
  await add('preferences', 'one.json', record('one', 'global', 'Updated ' + 'x'.repeat(900)));
  let results = await queryRecords(root, { query: 'Updated' });
  assert.equal(results[0].summary.length, 500);
  await writeFile(join(root, 'records', 'index.json'), '{bad');
  results = await queryRecords(root, { query: 'Updated' });
  assert.equal(results[0].id, 'one');
  const index = JSON.parse(await readFile(join(root, 'records', 'index.json'), 'utf8'));
  assert.equal(index.entries.length, 1);
  for (let i = 0; i < 10; i++) await add('decisions', `extra-${i}.json`, record(`extra-${i}`, 'global', 'Other', { tags: ['Updated'] }));
  assert.equal((await queryRecords(root, { query: 'Updated', limit: 99 })).length, 8);
}));

test('duplicate IDs reject rebuild and preserve prior index', async () => fixture(async (root, add) => {
  await add('preferences', 'one.json', record('same', 'global', 'First'));
  await rebuildRecordsIndex(root);
  const before = await readFile(join(root, 'records', 'index.json'), 'utf8');
  await add('decisions', 'two.json', record('same', 'project:a', 'Second', { kind: 'decision' }));
  await assert.rejects(rebuildRecordsIndex(root), /Duplicate record ID/);
  await assert.rejects(queryRecords(root), /Duplicate record ID/);
  assert.equal(await readFile(join(root, 'records', 'index.json'), 'utf8'), before);
}));

test('exact IDs resolve a decision beyond the default eight without crossing scopes', async () => fixture(async (root, add) => {
  for (let i = 0; i < 12; i++) await add('decisions', `${i}.json`, record(`d${i}`, 'global', 'Common choice'));
  await add('decisions', 'target.json', record('target', 'project:a', 'Specific approved choice', { updatedAt: '2020-01-01T00:00:00Z' }));
  await add('decisions', 'other.json', record('other', 'project:b', 'Another project choice'));
  assert.ok(!(await queryRecords(root, { scope: 'project:a' })).some(x => x.id === 'target'));
  assert.deepEqual((await queryRecords(root, { scope: 'project:a', ids: ['target', 'other'] })).map(x => x.id), ['target']);
  assert.deepEqual(await queryRecords(root, { ids: [] }), []);
  await assert.rejects(queryRecords(root, { ids: [''] }), /Invalid ids/);
}));

test('source size and required fields are checked before index replacement', async () => fixture(async (root, add) => {
  await add('preferences', 'valid.json', record('valid', 'global', 'Good'));
  await rebuildRecordsIndex(root);
  const before = await readFile(join(root, 'records', 'index.json'), 'utf8');
  await add('decisions', 'invalid.json', { id: 'bad', text: 'missing fields' });
  await assert.rejects(rebuildRecordsIndex(root), /Invalid/);
  assert.equal(await readFile(join(root, 'records', 'index.json'), 'utf8'), before);
  await rm(join(root, 'decisions', 'invalid.json'));
  await writeFile(join(root, 'decisions', 'large.json'), 'x'.repeat(128 * 1024 + 1));
  await assert.rejects(queryRecords(root), /Source too large/);
}));

test('symlinked source and index directories cannot escape the state root', async t => {
  const outside = await mkdtemp(join(tmpdir(), 'codex-records-outside-'));
  try {
    await fixture(async root => {
      try { await symlink(outside, join(root, 'preferences'), process.platform === 'win32' ? 'junction' : 'dir'); }
      catch (error) { if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) { t.skip('directory symlinks unavailable here'); return; } throw error; }
      await assert.rejects(rebuildRecordsIndex(root), /Symlink directory refused/);
      await rm(join(root, 'preferences'), { force: true });
      await symlink(outside, join(root, 'records'), process.platform === 'win32' ? 'junction' : 'dir');
      await assert.rejects(rebuildRecordsIndex(root), /Symlink directory refused/);
    });
  } finally { await rm(outside, { recursive: true, force: true }); }
});
