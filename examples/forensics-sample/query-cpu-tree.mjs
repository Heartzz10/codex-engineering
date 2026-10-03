import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const artifacts = path.join(here, 'artifacts');
const evidence = path.join(here, 'cli-evidence');
const args = process.argv.slice(2);
const value = flag => args[args.indexOf(flag) + 1];
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const focus = value('--focus');
assert(typeof focus === 'string' && focus && !focus.startsWith('--'), 'Provide --focus FUNCTION');

async function loadProfile(flag) {
  const supplied = value(flag);
  assert(typeof supplied === 'string' && supplied && !supplied.startsWith('--'), `Provide ${flag} FILE`);
  const file = path.resolve(supplied);
  assert(file.startsWith(`${artifacts}${path.sep}`) && file.endsWith('.cpuprofile'), 'CPU profile must be a saved sample artifact');
  const bytes = await fs.readFile(file);
  const profile = JSON.parse(bytes.toString('utf8'));
  assert(Array.isArray(profile.nodes) && Array.isArray(profile.samples) && profile.samples.length > 0, 'Invalid CPU profile');
  assert(profile.timeDeltas.length === profile.samples.length, 'CPU sample durations missing');
  const nodes = new Map(profile.nodes.map(node => [node.id, node]));
  const parents = new Map();
  for (const node of profile.nodes) for (const child of node.children || []) {
    assert(nodes.has(child) && !parents.has(child), 'Invalid CPU call tree');
    parents.set(child, node.id);
  }
  const framePath = id => {
    const frames = [], seen = new Set();
    while (id != null) {
      assert(nodes.has(id) && !seen.has(id), 'CPU call tree is cyclic or incomplete');
      seen.add(id);
      const frame = nodes.get(id).callFrame;
      frames.push({ nodeId:id, symbol:frame.functionName, file:frame.url || null, line:frame.lineNumber >= 0 ? frame.lineNumber + 1 : null });
      id = parents.get(id);
    }
    return frames.reverse();
  };
  const rows = profile.samples.map((id, sample) => ({ sample, microseconds:profile.timeDeltas[sample], frames:framePath(id) }));
  const paths = new Map();
  for (const row of rows) {
    const key = row.frames.map(frame => frame.nodeId).join('>');
    const aggregate = paths.get(key) || { frames:row.frames, samples:0, microseconds:0 };
    aggregate.samples++;
    aggregate.microseconds += row.microseconds;
    paths.set(key, aggregate);
  }
  const focusRows = rows.filter(row => row.frames.some(frame => frame.symbol === focus));
  const ranked = [...paths.values()].sort((left, right) => right.microseconds - left.microseconds);
  const focusPath = ranked.find(row => row.frames.some(frame => frame.symbol === focus))?.frames || null;
  return { file, rawSha256:digest(bytes), rawBytes:bytes.length, samples:rows.length,
    focusSamples:focusRows.length, focusMicroseconds:focusRows.reduce((sum, row) => sum + row.microseconds, 0),
    focusPath, topCallPaths:ranked.slice(0, 10), rows };
}

const before = await loadProfile('--before');
const after = await loadProfile('--after');
assert(path.dirname(before.file) === path.dirname(after.file), 'Pair must come from the same capture directory');
assert(before.focusSamples > 0 && after.focusSamples < before.focusSamples, 'No observed reduction in the selected call path');
const output = path.join(evidence, `CALL-TREE-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`);
await fs.mkdir(output);
const save = async (name, bytes) => fs.writeFile(path.join(output, name), bytes, { flag:'wx' });
for (const [label, capture] of [['before',before],['after',after]]) {
  await save(`${label}.callpaths.jsonl`, capture.rows.map(row => JSON.stringify(row)).join('\n') + '\n');
}
const scriptBytes = await fs.readFile(fileURLToPath(import.meta.url));
const result = { status:'paired_call_tree_queried', focus, capturedEnvironment:'synthetic sample; same capture directory',
  sourceScriptSha256:digest(scriptBytes), before:{file:before.file,sha256:before.rawSha256,bytes:before.rawBytes,samples:before.samples,focusSamples:before.focusSamples,focusMicroseconds:before.focusMicroseconds,focusPath:before.focusPath,topCallPaths:before.topCallPaths},
  after:{file:after.file,sha256:after.rawSha256,bytes:after.rawBytes,samples:after.samples,focusSamples:after.focusSamples,focusMicroseconds:after.focusMicroseconds,focusPath:after.focusPath,topCallPaths:after.topCallPaths},
  interpretation:'A read-only call-tree query on saved synthetic CPU profiles. Lower samples after live diagnostic intervention do not establish a shipped product improvement.' };
await save('result.json', `${JSON.stringify(result,null,2)}\n`);
const files = [];
for (const name of ['before.callpaths.jsonl','after.callpaths.jsonl','result.json']) {
  const bytes = await fs.readFile(path.join(output,name));
  files.push({path:name,bytes:bytes.length,sha256:digest(bytes)});
}
await save('manifest.json', `${JSON.stringify({schemaVersion:1,files},null,2)}\n`);
assert(digest(await fs.readFile(before.file)) === before.rawSha256 && digest(await fs.readFile(after.file)) === after.rawSha256, 'Source CPU profile changed during analysis');
process.stdout.write(`${JSON.stringify({status:result.status,focus,before:before.focusSamples,after:after.focusSamples,beforePath:before.focusPath,output})}\n`);
