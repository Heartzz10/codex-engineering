import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { assert, within } from './paths.mjs';

const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const same = (a, b) => path.relative(a, b) === '';
const hex = /^[a-f0-9]{64}$/i;

async function regular(file) {
  const stat = await fs.lstat(file);
  assert(stat.isFile() && !stat.isSymbolicLink(), `Expected regular file: ${file}`);
  return fs.readFile(file);
}

async function filesUnder(root) {
  const found = {};
  async function walk(dir) {
    for (const name of (await fs.readdir(dir)).sort()) {
      const file = path.join(dir, name);
      const stat = await fs.lstat(file);
      assert(!stat.isSymbolicLink(), 'Stable release contains a link');
      if (stat.isDirectory()) await walk(file);
      else {
        assert(stat.isFile(), 'Stable release contains an unusual entry');
        const relative = path.relative(root, file).replaceAll(path.sep, '/');
        found[relative] = hash(await fs.readFile(file));
      }
    }
  }
  await walk(root);
  return found;
}

function run(file, args, cwd) {
  return execFileSync(file, args, { cwd, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
}

/** Unpack only the archive recorded for the pinned commit, into a new directory. */
export async function stageStableRelease({ releaseFile, packageRoot, sourceRoot }) {
  const release = JSON.parse((await regular(releaseFile)).toString('utf8'));
  assert(release.version && release.commit && release.archive && hex.test(release.sha256), 'Invalid release record');
  assert(path.isAbsolute(packageRoot) && path.isAbsolute(sourceRoot), 'Absolute release and source paths required');
  const source = await fs.realpath(sourceRoot);
  const destination = path.resolve(packageRoot);
  assert(!within(source, destination) && !within(destination, source), 'Stable release must be outside the development directory');
  assert(same(await fs.realpath(path.dirname(destination)), path.dirname(destination)), 'Release parent must be a real directory');
  assert(hash(await regular(release.archive)) === release.sha256, 'Archive hash differs from release record');
  const safeSource = source.replaceAll('\\', '/');
  const tree = new Map();
  const entriesFromGit = run('git', ['-c', `safe.directory=${safeSource}`, 'ls-tree', '-r', '-z', release.commit], source).toString('utf8').split('\0').filter(Boolean);
  for (const entry of entriesFromGit) {
    const match = /^(100644|100755) blob ([a-f0-9]{40,64})\t(.+)$/s.exec(entry);
    assert(match && !tree.has(match[3]), 'Pinned commit contains an unsupported or duplicate entry');
    tree.set(match[3], match[2]);
  }
  const names = [...tree.keys()].sort();
  const entries = run('tar', ['-tf', release.archive], source).toString('utf8').trimEnd().split(/\r?\n/);
  const prefix = 'codex-engineering/';
  const archiveNames = entries.filter(x => !x.endsWith('/')).map(x => {
    assert(x.startsWith(prefix), 'Archive entry outside package root');
    const relative = x.slice(prefix.length);
    assert(relative && !relative.includes('\\') && relative.split('/').every(p => p && p !== '.' && p !== '..'), 'Unsafe archive entry');
    return relative;
  });
  assert(new Set(archiveNames).size === archiveNames.length && JSON.stringify(archiveNames.sort()) === JSON.stringify(names.sort()), 'Archive file set differs from pinned commit');
  let created = false;
  try { await fs.mkdir(destination); created = true; }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  // An interrupted extraction may be resumed only when every byte matches the archive.
  if (created) run('tar', ['-xf', release.archive, '-C', destination, '--strip-components', '1'], source);
  const actual = await filesUnder(destination);
  assert(JSON.stringify(Object.keys(actual).sort()) === JSON.stringify(names), 'Extracted file set differs from pinned commit');
  for (const name of names) {
    const bytes = await regular(path.join(destination, name));
    assert(bytes.equals(run('tar', ['-xOf', release.archive, `${prefix}${name}`], source)), `Extracted content differs from archive: ${name}`);
    // Blob IDs avoid Windows path-length failures from `git show <commit>:<long path>`.
    const committed = run('git', ['-c', `safe.directory=${safeSource}`, 'cat-file', 'blob', tree.get(name)], source);
    // The Windows release archive was built from an autocrlf checkout.
    const normalized = Buffer.from(bytes.toString('utf8').replaceAll('\r\n', '\n'));
    assert(bytes.equals(committed) || normalized.equals(committed), `Archive content differs from pinned commit: ${name}`);
  }
  const pkg = JSON.parse((await regular(path.join(destination, 'package.json'))).toString('utf8'));
  assert(pkg.version === release.version, 'Archive package version differs from release record');
  const manifest = { schemaVersion: 1, version: release.version, commit: release.commit, archive: release.archive,
    archiveSha256: release.sha256.toLowerCase(), packageRoot: destination, developmentRoot: source, files: actual };
  const manifestPath = `${destination}.manifest.json`;
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  return { status: 'staged', manifestPath, version: manifest.version, files: names.length, packageRoot: destination };
}

export async function verifyStableRelease(manifestPath) {
  const manifest = JSON.parse((await regular(manifestPath)).toString('utf8'));
  assert(manifest.schemaVersion === 1 && path.isAbsolute(manifest.packageRoot) && path.isAbsolute(manifest.developmentRoot), 'Invalid stable manifest');
  const root = await fs.realpath(manifest.packageRoot);
  assert(same(root, manifest.packageRoot) && !within(manifest.developmentRoot, root) && !within(root, manifest.developmentRoot), 'Stable and development directories overlap');
  assert(hash(await regular(manifest.archive)) === manifest.archiveSha256, 'Stable archive changed');
  const actual = await filesUnder(root);
  assert(JSON.stringify(actual) === JSON.stringify(manifest.files), 'Stable release files changed');
  const pkg = JSON.parse((await regular(path.join(root, 'package.json'))).toString('utf8'));
  assert(pkg.version === manifest.version, 'Stable package version changed');
  return { status: 'verified', packageRoot: root, version: manifest.version, commit: manifest.commit, files: Object.keys(actual).length };
}

async function replaceIfHash(file, bytes, expected) {
  assert(same(await fs.realpath(file), file), 'Runtime file is linked');
  assert(hash(await regular(file)) === expected, 'Runtime binding changed');
  const temp = `${file}.${crypto.randomUUID()}.stable-tmp`;
  try {
    await fs.writeFile(temp, bytes, { flag: 'wx' });
    assert(hash(await regular(file)) === expected, 'Runtime binding changed during switch');
    await fs.rename(temp, file);
  } finally { await fs.rm(temp, { force: true }).catch(() => {}); }
}

/** Preserve the original runtime bytes, and refuse to replace any later user edit. */
export async function switchStableRuntime({ manifestPath, runtimePath, recordPath }) {
  const stable = await verifyStableRelease(manifestPath);
  const before = await regular(runtimePath);
  const binding = JSON.parse(before.toString('utf8'));
  assert(path.isAbsolute(binding.packageRoot) && path.isAbsolute(binding.stateRoot), 'Invalid installed runtime binding');
  assert(binding.packageVersion === stable.version, 'Installed and stable versions differ');
  assert(!same(path.resolve(binding.packageRoot), stable.packageRoot), 'Runtime already points at stable release');
  assert(same(await fs.realpath(binding.packageRoot), binding.packageRoot), 'Development root is linked');
  const after = Buffer.from(`${JSON.stringify({ ...binding, packageRoot: stable.packageRoot }, null, 2)}\n`);
  const record = { schemaVersion: 1, runtimePath, manifestPath, beforeBase64: before.toString('base64'), beforeSha256: hash(before), afterSha256: hash(after),
    previousRoot: binding.packageRoot, stableRoot: stable.packageRoot, switchedAt: new Date().toISOString() };
  await fs.writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' });
  await replaceIfHash(runtimePath, after, record.beforeSha256);
  return { status: 'switched', runtimePath, stableRoot: stable.packageRoot, version: stable.version, recordPath };
}

export async function revertStableRuntime(recordPath) {
  const record = JSON.parse((await regular(recordPath)).toString('utf8'));
  assert(record.schemaVersion === 1 && path.isAbsolute(record.runtimePath) && hex.test(record.afterSha256) && hex.test(record.beforeSha256), 'Invalid switch record');
  const before = Buffer.from(record.beforeBase64, 'base64');
  assert(hash(before) === record.beforeSha256, 'Switch backup changed');
  await replaceIfHash(record.runtimePath, before, record.afterSha256);
  return { status: 'reverted', runtimePath: record.runtimePath, previousRoot: record.previousRoot };
}
