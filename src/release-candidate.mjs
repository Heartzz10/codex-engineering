import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { assert, within } from './paths.mjs';

const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const same = (a, b) => path.relative(a, b) === '';
export const isPrivateOrRawReleasePath = name =>
  /(^|\/)(?:local-state|evidence|artifacts|cli-evidence|runs|node_modules|\.runtime)(?:\/|$)|(^|\/)\.env(?:\.|$)|(^|\/)runtime(?:\.local)?\.json$/i.test(name);

function git(root, args) {
  const safe = root.replaceAll('\\', '/');
  return execFileSync('git', ['-c', `safe.directory=${safe}`, ...args],
    { cwd: root, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }).toString('utf8').trim();
}

/** Build an immutable candidate only from a clean, pinned Git HEAD. */
export async function buildReleaseCandidate({ sourceRoot, archivePath, releaseFile }) {
  assert(path.isAbsolute(sourceRoot) && path.isAbsolute(archivePath) && path.isAbsolute(releaseFile),
    'Absolute source, archive and record paths required');
  const source = await fs.realpath(sourceRoot);
  assert(same(source, sourceRoot), 'Candidate source must be a real directory');
  assert(same(git(source, ['rev-parse', '--show-toplevel']), source), 'Candidate source must be the Git root');
  assert(!git(source, ['status', '--porcelain', '--untracked-files=all']),
    'Dirty source cannot become a release candidate');
  const commit = git(source, ['rev-parse', 'HEAD']);
  assert(/^[a-f0-9]{40,64}$/.test(commit), 'Invalid pinned commit');
  const tracked = git(source, ['ls-tree', '-r', '--name-only', commit]).split(/\r?\n/);
  const rawOrPrivate = tracked.filter(isPrivateOrRawReleasePath);
  assert(!rawOrPrivate.length, `Candidate contains private or raw evidence paths: ${rawOrPrivate.slice(0, 3).join(', ')}`);
  const pkg = JSON.parse(git(source, ['show', `${commit}:package.json`]));
  const sourceVersion = /^export const VERSION = ['"]([^'"]+)['"];?\s*$/m.exec(git(source, ['show', `${commit}:src/paths.mjs`]))?.[1];
  assert(/^\d+\.\d+\.\d+$/.test(pkg.version) && sourceVersion === pkg.version,
    'Package and runtime source versions differ');
  const archive = path.resolve(archivePath), record = path.resolve(releaseFile);
  assert(archive !== record && !within(source, archive) && !within(source, record),
    'Candidate outputs must be outside source directory');
  assert(same(await fs.realpath(path.dirname(archive)), path.dirname(archive)) &&
    same(await fs.realpath(path.dirname(record)), path.dirname(record)), 'Candidate output parent is linked');
  for (const file of [archive, record]) {
    try { await fs.lstat(file); throw new Error(`Candidate output already exists: ${file}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  // Git archive excludes runtime.json and any untracked private state by construction.
  execFileSync('git', ['-c', `safe.directory=${source.replaceAll('\\', '/')}`, 'archive',
    '--format=zip', '--prefix=codex-engineering/', '-o', archive, commit],
  { cwd: source, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  try {
    assert(!git(source, ['status', '--porcelain', '--untracked-files=all']) &&
      git(source, ['rev-parse', 'HEAD']) === commit, 'Source changed during candidate build');
    const bytes = await fs.readFile(archive);
    const release = { version: pkg.version, commit, archive, sha256: hash(bytes),
      contains: 'tracked committed source only; no runtime binding/private state' };
    await fs.writeFile(record, `${JSON.stringify(release, null, 2)}\n`, { flag: 'wx' });
    return { status: 'candidate_built', version: pkg.version, commit, archive,
      sha256: release.sha256, releaseFile: record };
  } catch (error) {
    await fs.rm(archive, { force: true }).catch(() => {});
    throw error;
  }
}
