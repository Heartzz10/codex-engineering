import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
test('source baseline detects additions edits deletions without attributing pre-existing work', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'source-diff-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'src')); await fs.writeFile(path.join(root, 'src/a.txt'), 'user work');
  const { sourceSnapshot, sourceDiff } = await import('../src/source-diff.mjs');
  const p = { root, sourceScopes: ['src'] }; const before = await sourceSnapshot(p);
  assert.deepEqual((await sourceDiff(p, before)).files, []);
  await fs.writeFile(path.join(root, 'src/a.txt'), 'new'); await fs.writeFile(path.join(root, 'src/b.txt'), 'added');
  assert.deepEqual((await sourceDiff(p, before)).files, ['src/a.txt','src/b.txt']);
  await fs.unlink(path.join(root, 'src/a.txt'));
  assert.equal((await sourceDiff(p, before)).changes[0].kind, 'deleted');
});
