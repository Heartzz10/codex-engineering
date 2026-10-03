import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assert, existingInside, within } from './paths.mjs';
import { mapHash, parseStrictJson, scopedPath } from './feature-store.mjs';
import { verifyStableRelease } from './stable-release.mjs';

const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const same = (a, b) => path.relative(a, b) === '';
const hex = /^[a-f0-9]{64}$/i;
function newerVersion(current, candidate) {
  const parse = version => /^([0-9]+)\.([0-9]+)\.([0-9]+)$/.exec(version)?.slice(1).map(Number);
  const from = parse(current), to = parse(candidate);
  assert(from && to && [...from, ...to].every(Number.isSafeInteger),
    'Only three-part stable release versions support automatic upgrade');
  for (let i = 0; i < 3; i++) if (to[i] !== from[i]) return to[i] > from[i];
  return false;
}

async function regular(file) {
  const stat = await fs.lstat(file);
  assert(stat.isFile() && !stat.isSymbolicLink(), `Expected regular file: ${file}`);
  return fs.readFile(file);
}

async function candidateContract(root, version) {
  const source = (await regular(path.join(root, 'src', 'paths.mjs'))).toString('utf8');
  const declared = /^export const VERSION = ['"]([^'"]+)['"];?\s*$/m.exec(source)?.[1];
  assert(declared === version, 'Candidate source VERSION differs from package version');
  const profile = JSON.parse((await regular(path.join(root, 'schemas', 'profile.schema.json'))).toString('utf8'));
  const map = JSON.parse((await regular(path.join(root, 'schemas', 'feature-map.schema.json'))).toString('utf8'));
  assert(profile.properties?.schemaVersion?.enum?.includes(1) &&
    profile.properties?.sharedVersion?.enum?.includes(version), 'Candidate profile schema cannot load migrated profile');
  assert(map.properties?.schemaVersion?.const === 1 && map.properties?.sharedVersion?.type === 'string',
    'Candidate map schema cannot retain versioned map');
  return { profileSchemas: profile.properties.schemaVersion.enum, mapSchema: 1 };
}

async function profilePlan(file, stateRoot, currentVersion, nextVersion, contract, candidateLoader) {
  const profilesRoot = path.join(stateRoot, 'profiles');
  assert(within(profilesRoot, file) && !same(profilesRoot, file), 'Profile must remain in state/profiles');
  const before = await regular(file);
  const profile = parseStrictJson(before.toString('utf8'));
  assert(contract.profileSchemas.includes(profile.schemaVersion), 'Candidate does not support profile schemaVersion');
  assert(profile.sharedVersion === currentVersion, 'Profile sharedVersion differs from installed release');
  assert(typeof profile.id === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(profile.id), 'Invalid profile ID');
  assert(typeof profile.root === 'string' && path.isAbsolute(profile.root), 'Invalid profile root');
  const root = await fs.realpath(profile.root);
  assert((await fs.stat(root)).isDirectory(), 'Project root is not a directory');
  assert(Array.isArray(profile.authoritativeDocuments) && profile.authoritativeDocuments.length > 0,
    'Authoritative documents are required');
  for (const ref of profile.authoritativeDocuments) {
    assert((await fs.stat(await existingInside(root, ref))).isFile(), 'Authoritative document must be a file');
  }
  if (profile.featureMapDocument !== undefined) {
    assert((await fs.stat(await existingInside(root, profile.featureMapDocument))).isFile(),
      'Feature map document must be a file');
  }
  let map = null;
  if (profile.featureMapRef) {
    assert(profile.featureMapRef.schemaVersion === 1, 'Unsupported featureMapRef schema');
    const mapFile = await scopedPath(root, profile.featureMapRef.path);
    const bytes = await regular(mapFile);
    const data = parseStrictJson(bytes.toString('utf8'));
    assert(data.schemaVersion === contract.mapSchema && data.projectId === profile.id &&
      typeof data.sharedVersion === 'string' && data.contentHash === mapHash(data),
    'Feature map identity, schema or content hash differs');
    map = { path: mapFile, sha256: sha256(bytes), revision: data.revision,
      sharedVersion: data.sharedVersion, contentHash: data.contentHash };
  }
  const after = Buffer.from(`${JSON.stringify({ ...profile, sharedVersion: nextVersion }, null, 2)}\n`);
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'release-profile-check-'));
  try {
    const migratedCopy = path.join(temporary, 'profile.json');
    await fs.writeFile(migratedCopy, after, { flag: 'wx', mode: 0o600 });
    const loaded = await candidateLoader(migratedCopy);
    assert(loaded.id === profile.id && loaded.sharedVersion === nextVersion &&
      loaded.compatibility === 'current' && loaded.root === root,
    'Candidate profile loader did not accept migrated profile as current');
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
  return { path: file, beforeBase64: before.toString('base64'), beforeSha256: sha256(before),
    afterBase64: after.toString('base64'), afterSha256: sha256(after), projectId: profile.id,
    schemaVersion: profile.schemaVersion, map };
}

async function exactProfiles(stateRoot, profilePaths) {
  const root = await fs.realpath(path.join(stateRoot, 'profiles'));
  assert(same(root, path.join(stateRoot, 'profiles')), 'Profile directory is linked');
  const actual = (await fs.readdir(root)).filter(name => name.endsWith('.json')).map(name => path.join(root, name)).sort();
  assert(actual.length <= 100, 'Too many installed profiles');
  const selected = [...new Set(profilePaths.map(file => path.resolve(file)))].sort();
  assert(JSON.stringify(selected) === JSON.stringify(actual), 'Upgrade must include every installed profile');
  return actual;
}

/** Read-only gate for a staged, pinned release. Maps and evidence remain byte-for-byte unchanged. */
export async function preflightStableUpgrade({ currentManifestPath, candidateManifestPath, runtimePath, profilePaths }) {
  const [current, candidate] = await Promise.all([
    verifyStableRelease(currentManifestPath), verifyStableRelease(candidateManifestPath),
  ]);
  assert(newerVersion(current.version, candidate.version), 'Candidate must be a newer stable version');
  assert(path.isAbsolute(runtimePath) && path.basename(runtimePath) === 'runtime.json' &&
    path.basename(path.dirname(runtimePath)) === 'codex-engineering' &&
    path.basename(path.dirname(path.dirname(runtimePath))) === 'skills', 'Installed Skill runtime path required');
  const before = await regular(runtimePath);
  const runtime = parseStrictJson(before.toString('utf8'));
  assert(path.isAbsolute(runtime.packageRoot) && path.isAbsolute(runtime.stateRoot), 'Invalid installed runtime');
  assert(same(path.resolve(runtime.packageRoot), current.packageRoot) && runtime.packageVersion === current.version,
    'Installed runtime is not the verified current release');
  const stateRoot = await fs.realpath(runtime.stateRoot);
  assert(same(stateRoot, runtime.stateRoot), 'State directory is linked');
  const contract = await candidateContract(candidate.packageRoot, candidate.version);
  const candidateModule = await import(pathToFileURL(path.join(candidate.packageRoot, 'src', 'profile.mjs')).href);
  assert(typeof candidateModule.loadProfile === 'function', 'Candidate profile loader is missing');
  assert(Array.isArray(profilePaths), 'Explicit installed profile list required');
  const paths = await exactProfiles(stateRoot, profilePaths);
  const profiles = [];
  for (const file of paths) profiles.push(await profilePlan(file, stateRoot, current.version, candidate.version,
    contract, candidateModule.loadProfile));
  const runtimeAfter = Buffer.from(`${JSON.stringify({ ...runtime, packageRoot: candidate.packageRoot,
    packageVersion: candidate.version }, null, 2)}\n`);
  return { status: 'ready', currentVersion: current.version, candidateVersion: candidate.version, stateRoot,
    currentRoot: current.packageRoot, candidateRoot: candidate.packageRoot,
    runtime: { path: runtimePath, beforeBase64: before.toString('base64'), beforeSha256: sha256(before),
      afterBase64: runtimeAfter.toString('base64'), afterSha256: sha256(runtimeAfter) },
    profiles, mapsPreserved: profiles.filter(item => item.map).length };
}

async function replaceIfHash(file, next, expected) {
  assert(same(await fs.realpath(file), file), 'Upgrade target is linked');
  assert(sha256(await regular(file)) === expected, `Upgrade target changed: ${file}`);
  const temp = `${file}.${crypto.randomUUID()}.upgrade-tmp`;
  try {
    await fs.writeFile(temp, next, { flag: 'wx' });
    assert(sha256(await regular(file)) === expected, `Upgrade target changed during switch: ${file}`);
    await fs.rename(temp, file);
  } finally { await fs.rm(temp, { force: true }).catch(() => {}); }
}

/** Record backups first; change installed profiles, then make the new runtime visible last. */
export async function applyStableUpgrade(options) {
  const plan = await preflightStableUpgrade(options);
  assert(typeof options.recordPath === 'string' && path.isAbsolute(options.recordPath),
    'Absolute upgrade record path required');
  const recordPath = path.resolve(options.recordPath);
  assert(within(plan.stateRoot, recordPath) && !same(plan.stateRoot, recordPath), 'Upgrade record must be inside state root');
  assert(!within(path.join(plan.stateRoot, 'profiles'), recordPath), 'Upgrade record cannot become an installed profile');
  assert(same(await fs.realpath(path.dirname(recordPath)), path.dirname(recordPath)), 'Upgrade record parent is linked');
  const record = { schemaVersion: 1, kind: 'stable-upgrade', createdAt: new Date().toISOString(),
    currentManifestPath: options.currentManifestPath, candidateManifestPath: options.candidateManifestPath,
    currentVersion: plan.currentVersion, candidateVersion: plan.candidateVersion,
    runtime: plan.runtime, profiles: plan.profiles };
  await fs.writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' });
  try {
    for (const item of plan.profiles) {
      if (item.map) assert(sha256(await regular(item.map.path)) === item.map.sha256,
        `Feature map changed during upgrade: ${item.map.path}`);
    }
    for (const item of plan.profiles) await replaceIfHash(item.path, Buffer.from(item.afterBase64, 'base64'), item.beforeSha256);
    await replaceIfHash(plan.runtime.path, Buffer.from(plan.runtime.afterBase64, 'base64'), plan.runtime.beforeSha256);
  } catch (error) {
    try { await revertStableUpgrade(recordPath); }
    catch (revertError) { throw new Error(`${error.message}; automatic revert blocked: ${revertError.message}; record: ${recordPath}`); }
    throw error;
  }
  return { status: 'upgraded', version: plan.candidateVersion, profiles: plan.profiles.length,
    mapsPreserved: plan.mapsPreserved, recordPath };
}

function checkedBytes(item, side) {
  assert(typeof item.path === 'string' && path.isAbsolute(item.path) && hex.test(item[`${side}Sha256`]), 'Invalid upgrade record target');
  const bytes = Buffer.from(item[`${side}Base64`], 'base64');
  assert(sha256(bytes) === item[`${side}Sha256`], 'Upgrade record backup changed');
  return bytes;
}

/** Also handles an interrupted upgrade; refuse all changes if any target has a later user edit. */
export async function revertStableUpgrade(recordPath) {
  const record = parseStrictJson((await regular(recordPath)).toString('utf8'));
  assert(record.schemaVersion === 1 && record.kind === 'stable-upgrade' && Array.isArray(record.profiles), 'Invalid upgrade record');
  const priorRuntime = parseStrictJson(checkedBytes(record.runtime, 'before').toString('utf8'));
  const current = await verifyStableRelease(record.currentManifestPath);
  assert(priorRuntime.packageVersion === current.version &&
    same(path.resolve(priorRuntime.packageRoot), current.packageRoot),
    'Previous stable release no longer matches upgrade record');
  const stateRoot = await fs.realpath(priorRuntime.stateRoot);
  await exactProfiles(stateRoot, record.profiles.map(item => item.path));
  const items = [record.runtime, ...record.profiles];
  const states = [];
  for (const item of record.profiles) {
    if (item.map) assert(sha256(await regular(item.map.path)) === item.map.sha256,
      `Feature map changed after upgrade: ${item.map.path}`);
  }
  for (const item of items) {
    checkedBytes(item, 'before'); checkedBytes(item, 'after');
    const current = sha256(await regular(item.path));
    assert(current === item.beforeSha256 || current === item.afterSha256,
      `Upgrade target has a later edit: ${item.path}`);
    states.push(current === item.afterSha256 ? 'after' : 'before');
  }
  for (let i = 0; i < items.length; i++) {
    if (states[i] === 'after') await replaceIfHash(items[i].path, checkedBytes(items[i], 'before'), items[i].afterSha256);
  }
  return { status: 'reverted', version: record.currentVersion,
    restored: states.filter(state => state === 'after').length, recordPath };
}
