import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { assert, within } from './paths.mjs';
import { scopedPath, hashContent } from './feature-store.mjs';
export async function sourceSnapshot(profile) {
  const inputs = profile.sourceScopes || profile.controls?.sourceReview?.inputs;
  assert(Array.isArray(inputs) && inputs.length > 0, 'sourceScopes required to establish actual diff baseline');
  const root = await fs.realpath(profile.root), files = {}, seen = new Set(); let bytes = 0;
  async function visit(file) {
    let stat; try { stat = await fs.stat(file); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
    const real = await fs.realpath(file); assert(within(root, real), 'source_scope_escape'); if (seen.has(real)) return; seen.add(real);
    if (stat.isDirectory()) { for (const name of (await fs.readdir(file)).sort()) if (!['.git','node_modules','.venv','__pycache__'].includes(name)) await visit(path.join(file,name)); }
    else if (stat.isFile()) { bytes += stat.size; assert(bytes <= 100 * 1024 * 1024 && Object.keys(files).length < 10000, 'source_scope_too_large'); files[path.relative(root, file).replaceAll('\\','/')] = crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex'); }
  }
  for (const ref of inputs) await visit(await scopedPath(root, ref));
  const snapshot = { schemaVersion: 1, inputs: [...inputs], files }; return { ...snapshot, hash: hashContent(snapshot) };
}
export async function sourceDiff(profile, baseline) {
  const { hash, ...snapshot } = baseline; assert(hashContent(snapshot) === hash, 'source_baseline_corrupt');
  return diffSourceSnapshots(baseline, await sourceSnapshot(profile));
}
// The caller must obtain current from sourceSnapshot in the same observation.
export function diffSourceSnapshots(baseline, current) {
  const { hash, ...snapshot } = baseline; assert(hashContent(snapshot) === hash, 'source_baseline_corrupt');
  const { hash: currentHash, ...currentBody } = current;
  assert(hashContent(currentBody) === currentHash, 'source_observation_corrupt');
  assert(hashContent(current.inputs) === hashContent(baseline.inputs), 'source_scope_changed');
  const changes = [...new Set([...Object.keys(baseline.files), ...Object.keys(current.files)])].sort().filter(file => baseline.files[file] !== current.files[file]).map(file => ({ path: file, kind: !baseline.files[file] ? 'added' : !current.files[file] ? 'deleted' : 'modified', beforeHash: baseline.files[file] || null, afterHash: current.files[file] || null }));
  return { files: changes.map(c => c.path), changes, sourceRef: `source-baseline:${baseline.hash}`, baselineHash: baseline.hash, currentHash: current.hash, origin: 'filesystem_observation' };
}
