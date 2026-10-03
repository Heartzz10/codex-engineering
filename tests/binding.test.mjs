import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveProjectBinding } from '../src/binding.mjs';
import { VERSION } from '../src/paths.mjs';

async function fixture(fn) {
  const root = await mkdtemp(path.join(tmpdir(), 'binding-'));
  const state = path.join(root, 'state');
  const projects = path.join(root, 'projects');
  await mkdir(path.join(state, 'profiles'), { recursive: true });
  await mkdir(projects);
  const project = async name => { const directory = path.join(projects, name); await mkdir(directory, { recursive: true }); return directory; };
  const profile = async (name, id, directory) => {
    const file = path.join(state, 'profiles', `${name}.json`);
    await writeFile(file, JSON.stringify({ id, root: directory, sharedVersion: VERSION, ignored: 'not read as a document' }));
    return file;
  };
  try { await fn({ root, state, projects, project, profile }); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test('different projects do not inherit an unrelated profile', async () => fixture(async ({ state, project, profile }) => {
  const a = await project('a');
  const b = await project('b');
  const file = await profile('a', 'project-a', a);
  assert.deepEqual(await resolveProjectBinding(state, a), { status: 'bound', profile: file, projectId: 'project-a' });
  assert.deepEqual(await resolveProjectBinding(state, b), { status: 'unbound' });
}));

test('nested project chooses the most specific matching root', async () => fixture(async ({ state, project, profile }) => {
  const a = await project('a');
  const child = path.join(a, 'child');
  const deep = path.join(child, 'src');
  await mkdir(deep, { recursive: true });
  await profile('parent', 'parent', a);
  const expected = await profile('child', 'child', child);
  assert.deepEqual(await resolveProjectBinding(state, deep), { status: 'bound', profile: expected, projectId: 'child' });
}));

test('equal roots are ambiguous and return no profile', async () => fixture(async ({ state, project, profile }) => {
  const a = await project('a');
  await profile('first', 'first', a);
  await profile('second', 'second', a);
  const result = await resolveProjectBinding(state, a);
  assert.equal(result.status, 'ambiguous');
  assert.equal(result.profile, undefined);
}));

test('bad profile blocks binding instead of silently selecting another', async () => fixture(async ({ state, project, profile }) => {
  const a = await project('a');
  await profile('good', 'good', a);
  await writeFile(path.join(state, 'profiles', 'bad.json'), '{bad');
  assert.equal((await resolveProjectBinding(state, a)).status, 'unavailable');
}));

test('missing profiles directory and absent matches are unbound', async () => fixture(async ({ state, project }) => {
  const a = await project('a');
  await rm(path.join(state, 'profiles'), { recursive: true });
  assert.deepEqual(await resolveProjectBinding(state, a), { status: 'unbound' });
}));

test('profile count and file size limits fail closed', async () => fixture(async ({ state, project }) => {
  const a = await project('a');
  await writeFile(path.join(state, 'profiles', 'oversize.json'), 'x'.repeat(128 * 1024 + 1));
  assert.equal((await resolveProjectBinding(state, a)).status, 'unavailable');
  await rm(path.join(state, 'profiles', 'oversize.json'));
  for (let i = 0; i < 101; i++) await writeFile(path.join(state, 'profiles', `${i}.json`), '{}');
  assert.match((await resolveProjectBinding(state, a)).reason, /100/);
}));

test('profile directory link outside state is unavailable when supported', async t => {
  const outside = await mkdtemp(path.join(tmpdir(), 'binding-outside-'));
  try {
    await fixture(async ({ state, project }) => {
      const a = await project('a');
      const external = path.join(outside, 'external.json');
      await writeFile(external, JSON.stringify({ id: 'external', root: a, sharedVersion: VERSION }));
      await rm(path.join(state, 'profiles'), { recursive: true });
      try { await symlink(outside, path.join(state, 'profiles'), process.platform === 'win32' ? 'junction' : 'dir'); }
      catch (error) { if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) { t.skip('symlinks unavailable here'); return; } throw error; }
      assert.equal((await resolveProjectBinding(state, a)).status, 'unavailable');
    });
  } finally { await rm(outside, { recursive: true, force: true }); }
});
