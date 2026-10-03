import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Session } from 'node:inspector';
import { getDebugProtocol, auditDebugEvidence } from '../../src/pstack.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
if (process.argv.includes('--allocation-worker')) {
  const directory = path.resolve(process.argv[process.argv.indexOf('--output') + 1]);
  assert(directory.startsWith(path.join(here, 'artifacts') + path.sep), 'Allocation evidence must stay in this sample');
  await fs.mkdir(directory);
  const session = new Session(); session.connect();
  const post = (method, params = {}) => new Promise((resolve, reject) => session.post(method, params, (error, result) => error ? reject(error) : resolve(result)));
  const chunks = [], listener = ({ params }) => chunks.push(params.chunk);
  session.on('HeapProfiler.addHeapSnapshotChunk', listener);
  await post('HeapProfiler.enable');
  await post('HeapProfiler.startTrackingHeapObjects', { trackAllocations: true });
  class ForensicProbeNote { constructor(id) { this.id = id; this.payload = `tracked-synthetic-${id}`; } }
  function captureAllocationProbe() {
    globalThis.forensicRetainedNotes = Array.from({ length: 800 }, (_, id) => new ForensicProbeNote(id));
  }
  captureAllocationProbe();
  await post('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
  session.off('HeapProfiler.addHeapSnapshotChunk', listener);
  await fs.writeFile(path.join(directory, 'tracked.heapsnapshot'), chunks.join(''), { flag: 'wx' });
  await fs.copyFile(fileURLToPath(import.meta.url), path.join(directory, 'source-effect-session.mjs'));
  globalThis.forensicRetainedNotes = null;
  await post('HeapProfiler.collectGarbage');
  chunks.length = 0;
  session.on('HeapProfiler.addHeapSnapshotChunk', listener);
  await post('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
  session.off('HeapProfiler.addHeapSnapshotChunk', listener);
  await fs.writeFile(path.join(directory, 'released.heapsnapshot'), chunks.join(''), { flag: 'wx' });
  const capturedFiles = [];
  for (const name of ['tracked.heapsnapshot', 'released.heapsnapshot', 'source-effect-session.mjs']) {
    const bytes = await fs.readFile(path.join(directory, name));
    capturedFiles.push({ path: name, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
  }
  await fs.writeFile(path.join(directory, 'capture-manifest.json'), JSON.stringify({ capturedFiles }, null, 2) + '\n', { flag: 'wx' });
  await post('HeapProfiler.stopTrackingHeapObjects', { reportProgress: false });
  session.disconnect();
  console.log(JSON.stringify({ status: 'captured_allocation_tracking', pid: process.pid, trackAllocations: true, directory,
    source: fileURLToPath(import.meta.url), externalCalls: 0 }));
  process.exit(0);
}
if (process.argv.includes('--help')) {
  console.log('node effect-session.mjs --trace-dir <existing Chromium trace directory with manifest.json>\nRead-only supplied evidence import; new synthetic Node capture stays in this sample.');
  process.exit(0);
}
const inputIndex = process.argv.indexOf('--trace-dir');
assert(inputIndex >= 0 && process.argv[inputIndex + 1] && !process.argv[inputIndex + 1].startsWith('--'),
  'Provide --trace-dir with an existing captured Chromium evidence directory; no development-history default is used');
const runId = `EFFECT-SESSION-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
const output = path.join(here, 'cli-evidence', runId);
const liveDir = path.join(here, 'artifacts', runId);
const supplied = path.resolve(process.argv[inputIndex + 1]);
const localTraceDir = path.join(here, 'artifacts', `${runId}-supplied-trace`);
const exec = promisify(execFile);
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const save = async (name, value) => fs.writeFile(path.join(output, name), `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
const call = async (script, args) => {
  const result = await exec(process.execPath, [path.join(here, script), ...args], { windowsHide: true, timeout: 60000, maxBuffer: 2_000_000 });
  return { command: { script, args }, exitCode: 0, stdout: result.stdout, stderr: result.stderr, result: JSON.parse(result.stdout) };
};
async function verifyManifest(dir) {
  const manifestBytes = await fs.readFile(path.join(dir, 'manifest.json'));
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  assert(Array.isArray(manifest.files) && manifest.files.length > 0, 'A nonempty immutable evidence manifest is required');
  const names = new Set();
  for (const item of manifest.files) {
    assert(typeof item.path === 'string' && item.path && path.basename(item.path) === item.path &&
      !item.path.includes('/') && !item.path.includes('\\') && item.path !== 'manifest.json' && !names.has(item.path),
    'Manifest entries must be unique direct files');
    names.add(item.path);
    const raw = await fs.readFile(path.join(dir, item.path));
    assert.equal(hash(raw), item.sha256, `Original changed: ${item.path}`);
    assert.equal(raw.length, item.bytes);
  }
  return [...manifest.files.map(item => ({ absolutePath: path.join(dir, item.path), ...item })),
    { absolutePath: path.join(dir, 'manifest.json'), path: 'manifest.json', bytes: manifestBytes.length, sha256: hash(manifestBytes) }];
}
async function artifact(id, kind, file, surface, extra = {}) {
  const bytes = await fs.readFile(file);
  return { id, kind, path: path.relative(here, file), sha256: hash(bytes), projectId: 'forensics-sample',
    surface, environment: 'isolated-loopback', role: 'sample-owner', ...extra };
}

async function reduceAllocation(directory) {
  const raw = await fs.readFile(path.join(directory, 'tracked.heapsnapshot'));
  const heap = JSON.parse(raw.toString('utf8')), meta = heap.snapshot.meta;
  const fields = Object.fromEntries(meta.node_fields.map((key, index) => [key, index])), width = meta.node_fields.length;
  const traceFields = Object.fromEntries(meta.trace_function_info_fields.map((key, index) => [key, index]));
  const traceWidth = meta.trace_function_info_fields.length;
  const functions = [];
  for (let at = 0; at < heap.trace_function_infos.length; at += traceWidth) functions.push({
    functionId: heap.trace_function_infos[at + traceFields.function_id],
    functionName: heap.strings[heap.trace_function_infos[at + traceFields.name]],
    file: heap.strings[heap.trace_function_infos[at + traceFields.script_name]],
    line: heap.trace_function_infos[at + traceFields.line], column: heap.trace_function_infos[at + traceFields.column] });
  const treeFields = Object.fromEntries(meta.trace_node_fields.map((key, index) => [key, index])), treeWidth = meta.trace_node_fields.length;
  const paths = new Map();
  const walk = (siblings, parents) => {
    for (let at = 0; at < siblings.length; at += treeWidth) {
      const id = siblings[at + treeFields.id], frame = functions[siblings[at + treeFields.function_info_index]];
      const frames = [...parents, frame]; paths.set(id, frames);
      walk(siblings[at + treeFields.children] || [], frames);
    }
  };
  walk(heap.trace_tree, []);
  const nodes = [];
  for (let at = 0; at < heap.nodes.length; at += width) nodes.push({ index: at / width,
    type: meta.node_types[fields.type][heap.nodes[at + fields.type]], name: heap.strings[heap.nodes[at + fields.name]],
    id: heap.nodes[at + fields.id], selfSize: heap.nodes[at + fields.self_size], traceNodeId: heap.nodes[at + fields.trace_node_id] });
  const probes = nodes.filter(node => node.type === 'object' && node.name === 'ForensicProbeNote');
  assert.equal(probes.length, 800);
  const allocationRows = probes.map(node => ({ ...node, allocationStack: paths.get(node.traceNodeId) || [] }));
  assert(allocationRows.every(row => row.traceNodeId > 0 && row.allocationStack.some(frame => frame.functionName === 'captureAllocationProbe' && frame.file && frame.line > 0)),
    'Tracked probe objects must carry runtime allocation stacks and source positions');
  const probe = allocationRows[0], allocationFrame = probe.allocationStack.filter(frame => frame.file && frame.line > 0).at(-1);
  const source = await fs.readFile(path.join(directory, 'source-effect-session.mjs'), 'utf8');
  assert(source.split(/\r?\n/)[allocationFrame.line - 1]?.includes('new ForensicProbeNote'), 'Runtime allocation position does not match the captured source');
  const edgeFields = Object.fromEntries(meta.edge_fields.map((key, index) => [key, index])), edgeWidth = meta.edge_fields.length;
  const reverse = Array.from({ length: nodes.length }, () => []); let edgeOffset = 0;
  for (const node of nodes) {
    const count = heap.nodes[node.index * width + fields.edge_count];
    for (let edge = 0; edge < count; edge++) {
      const at = edgeOffset + edge * edgeWidth, type = meta.edge_types[edgeFields.type][heap.edges[at + edgeFields.type]];
      const rawName = heap.edges[at + edgeFields.name_or_index], target = heap.edges[at + edgeFields.to_node] / width;
      if (type !== 'weak') reverse[target].push({ from: node.index, type, name: ['element', 'hidden'].includes(type) ? String(rawName) : heap.strings[rawName] });
    }
    edgeOffset += count * edgeWidth;
  }
  const queue = [probe.index], seen = new Set(queue), toward = new Map(); let at = 0;
  while (at < queue.length && !seen.has(0)) { const target = queue[at++]; for (const edge of reverse[target]) if (!seen.has(edge.from)) {
    seen.add(edge.from); toward.set(edge.from, { to: target, edge }); queue.push(edge.from);
  } }
  assert(seen.has(0)); const chain = []; let current = 0;
  while (current !== probe.index) { const hop = toward.get(current); chain.push({ from: nodes[current], edge: hop.edge, to: nodes[hop.to] }); current = hop.to; }
  assert(chain.some(hop => hop.edge.name === 'forensicRetainedNotes'));
  const releasedRaw = await fs.readFile(path.join(directory, 'released.heapsnapshot'));
  const released = JSON.parse(releasedRaw.toString('utf8')), releaseFields = Object.fromEntries(released.snapshot.meta.node_fields.map((key, index) => [key, index]));
  const releaseWidth = released.snapshot.meta.node_fields.length; let releasedProbeCount = 0;
  for (let at = 0; at < released.nodes.length; at += releaseWidth)
    if (released.snapshot.meta.node_types[releaseFields.type][released.nodes[at + releaseFields.type]] === 'object' &&
      released.strings[released.nodes[at + releaseFields.name]] === 'ForensicProbeNote') releasedProbeCount++;
  assert.equal(releasedProbeCount, 0, 'Removing the live global retainer must release all tracked probe objects');
  await fs.writeFile(path.join(directory, 'tracked.nodes.jsonl'), nodes.map(node => JSON.stringify(node)).join('\n') + '\n', { flag: 'wx' });
  await fs.writeFile(path.join(directory, 'tracked.allocations.jsonl'), allocationRows.map(row => JSON.stringify(row)).join('\n') + '\n', { flag: 'wx' });
  const result = { status: 'runtime_allocation_attributed', snapshotSha256: hash(raw), probeCount: probes.length, allocationFrame,
    allocationStack: probe.allocationStack, sourceLine: source.split(/\r?\n/)[allocationFrame.line - 1],
    proof: 'object trace_node_id → trace_tree(function_info_index) → trace_function_infos(script_name,line,column)',
    query: '800 object nodes named ForensicProbeNote; trace_node_id>0 and constructor frame in trace path; reverse non-weak edges to GC root 0',
    chain, attribution: 'runtime_allocation_stack', historicalUntrackedSnapshot: 'source_inference_only',
    mechanism: { intervention: 'same live worker: forensicRetainedNotes=null; HeapProfiler.collectGarbage; take second snapshot',
      beforeObjects: 800, afterObjects: releasedProbeCount, releasedSnapshotSha256: hash(releasedRaw), productCodeChanged: false } };
  await fs.writeFile(path.join(directory, 'allocation-diagnosis.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  const files = [];
  for (const name of await fs.readdir(directory)) { const bytes = await fs.readFile(path.join(directory, name)); files.push({ path: name, bytes: bytes.length, sha256: hash(bytes) }); }
  await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify({ files }, null, 2) + '\n', { flag: 'wx' });
  return result;
}

await fs.mkdir(output);
let stage = 'plan';
try {
  const liveProtocol = await getDebugProtocol({ category: 'runtime-forensics' });
  const traceProtocol = await getDebugProtocol({ category: 'trace-forensics' });
  await save('plan-before-execution.json', { createdAt: new Date().toISOString(), beforeExecution: true,
    question: '在现有合成样例核新Node现场完整诊断；对已给定UI trace仅只读查询与符号归因。',
    live: { protocol: liveProtocol, steps: liveProtocol.steps.map(step => ({ id: step.id, applicability: 'applicable',
      detail: step.id === 'attribute' ? 'CPU使用profile运行时文件/符号/行；当前新heap启allocation tracking，经trace_node_id与trace_function_infos归因，旧heap不回填' : '复用现有run.mjs受控Node采集、同进程抑制、JSONL和GC-root链' })) },
    trace: { protocol: traceProtocol, supplied, localTraceDir,
      steps: traceProtocol.steps.map(step => ({ id: step.id, applicability: 'applicable', detail: '固定已存UI JSON trace和配对cpuprofile；只读verify与call-tree查询，不重采' })) },
    skips: [ { branch: 'spindump', reason: '给定数据为Chromium JSON trace/CPU与Node heap；没有spindump，不支持Windows活线程转采' },
      { branch: 'gzip', reason: '给定原件未压缩；按已有JSON格式加载，不凭空制造另一现场' },
      { branch: 'product-fix/perf-issue', reason: '本任务仅诊断现有隔离样例，不发布产品优化；19类仍not_adopted' },
      { branch: 'historical heap allocator line', reason: '旧快照无allocation stack，保留其源码推断；本轮另采带分配栈快照证明当前能力' } ],
    throughput: 'throughput checkpoint: n/a, read-only forensics', largeArtifactHandling: '复用现有隔离采集/解析脚本，主会话仅输出有界结果；本执行任务已由root独立委派' });
  stage = 'preserve-existing';
  const suppliedFiles = await verifyManifest(supplied);
  for (const name of ['ui-trace.json', 'ui-cpu.cpuprofile', 'ui-intervention.cpuprofile', 'ui-diagnosis.json', 'events.jsonl', 'frames.jsonl'])
    assert(suppliedFiles.some(item => item.path === name), `Selected paired Chromium diagnosis requires ${name}`);
  await save('supplied-originals-before.json', suppliedFiles);
  // Keep existing parsers confined to sample artifacts while accepting portable external input.
  await fs.mkdir(localTraceDir);
  for (const item of suppliedFiles) await fs.writeFile(path.join(localTraceDir, item.path), await fs.readFile(item.absolutePath), { flag: 'wx' });
  const importedFiles = await verifyManifest(localTraceDir);
  assert.deepEqual(importedFiles.map(({ absolutePath, ...item }) => item), suppliedFiles.map(({ absolutePath, ...item }) => item));
  await save('supplied-import.json', { source: supplied, copy: localTraceDir, importedFiles, originalBytesPreserved: true, recaptured: false });
  stage = 'live-capture';
  const liveReceipt = await call('run.mjs', ['--output', liveDir]);
  await save('live-capture.receipt.json', liveReceipt);
  const liveFiles = await verifyManifest(liveDir);
  const liveTree = await call('query-cpu-tree.mjs', ['--before', path.join(liveDir, 'before.cpuprofile'), '--after', path.join(liveDir, 'suppressed.cpuprofile'), '--focus', 'forensicBusyLoop']);
  await save('live-call-tree.receipt.json', liveTree);
  const liveDiagnosis = JSON.parse(await fs.readFile(path.join(liveDir, 'diagnosis.json'), 'utf8'));
  const chain = JSON.parse(await fs.readFile(path.join(liveDir, 'heap-retainer-chain.json'), 'utf8'));
  const hot = liveDiagnosis.before.hotFrames.find(frame => frame.functionName === 'forensicBusyLoop');
  assert(hot?.line > 0 && hot.url && liveDiagnosis.heap.probeCount === 800);
  assert(chain.chain.some(hop => hop.edge.name === 'forensicRetainedNotes'));
  stage = 'heap-allocation-tracking';
  const allocationDirectory = path.join(here, 'artifacts', `${runId}-allocation`);
  const allocationReceipt = await call('effect-session.mjs', ['--allocation-worker', '--output', allocationDirectory]);
  await save('allocation-tracking.receipt.json', allocationReceipt);
  const allocation = await reduceAllocation(allocationDirectory);
  const allocationFiles = await verifyManifest(allocationDirectory);
  stage = 'existing-trace';
  const traceReceipt = await call('ui-trace.mjs', ['verify', '--output', localTraceDir]);
  await save('existing-trace.receipt.json', traceReceipt);
  const traceTree = await call('query-cpu-tree.mjs', ['--before', path.join(localTraceDir, 'ui-cpu.cpuprofile'), '--after', path.join(localTraceDir, 'ui-intervention.cpuprofile'), '--focus', 'forensicRenderLoop']);
  await save('existing-trace-call-tree.receipt.json', traceTree);
  const suppliedAfter = await verifyManifest(supplied);
  assert.deepEqual(suppliedAfter, suppliedFiles);
  await save('supplied-originals-after.json', suppliedAfter);
  const findings = { signal: '新Node现场CPU+heap；旧Chromium JSON UI trace与CPU固定数据集',
    live: { scope: 'isolated Node synthetic process', hotFrame: hot, callTree: liveTree.result,
      mechanism: '同一活进程spinning=false抑制后，相同capture路径中forensicBusyLoop的累积调用树样本降为0；产品源码未改',
      retainer: { probeCount: chain.probeCount, rootChain: chain.chain, proof: 'retained.heapsnapshot → heap.nodes.jsonl → heap-retainer-chain.json' },
      allocator: { ...allocation, directory: allocationDirectory, files: allocationFiles.length, workerExited: allocationReceipt.exitCode === 0,
        historicalLimit: '旧未跟踪快照仍无分配栈；只有本轮tracked.heapsnapshot独立定位分配位置' },
      cleanup: liveDiagnosis.cleanup },
    suppliedTrace: { format: 'Chromium JSON trace + cpuprofile', ...traceReceipt.result, callTree: traceTree.result,
      pairedStatus: '同一旧会话移除点击处理器的已有配对采集支持合成机制；本轮未重采或改UI', originalsUnchanged: true },
    limits: ['仅所述隔离合成现场与给定格式', '本轮无产品修复/性能发布', '旧未跟踪heap分配行仍保留推断，当前tracked快照有直接归因'],
    throughput: 'throughput checkpoint: n/a, read-only forensics', businessFee: 0 };
  await save('full-diagnosis.json', findings);
  const profile = { id: 'forensics-sample', root: here };
  const liveArtifacts = await Promise.all([
    artifact('live-cpu', 'capture', path.join(liveDir, 'before.cpuprofile'), 'node'),
    artifact('live-finding', 'reduced-finding', path.join(output, 'full-diagnosis.json'), 'node'),
    artifact('live-mechanism', 'mechanism', path.join(liveDir, 'live-intervention.json'), 'node'),
    artifact('live-symbols', 'symbol-map', path.join(liveTree.result.output, 'result.json'), 'node')
  ]);
  await save('live-audit.json', await auditDebugEvidence(profile, { category: 'runtime-forensics', projectId: profile.id, captureType: 'cpu', artifacts: liveArtifacts }));
  const traceArtifacts = await Promise.all([
    artifact('trace-before', 'capture', path.join(localTraceDir, 'ui-cpu.cpuprofile'), 'supplied-chromium'),
    artifact('trace-after', 'capture', path.join(localTraceDir, 'ui-intervention.cpuprofile'), 'supplied-chromium'),
    artifact('trace-query', 'queryable-data', path.join(traceTree.result.output, 'before.callpaths.jsonl'), 'supplied-chromium'),
    artifact('trace-finding', 'reduced-finding', path.join(output, 'full-diagnosis.json'), 'supplied-chromium'),
    artifact('trace-symbols', 'symbol-map', path.join(traceTree.result.output, 'result.json'), 'supplied-chromium'),
    artifact('trace-pair', 'paired-comparison', path.join(localTraceDir, 'ui-diagnosis.json'), 'supplied-chromium')
  ]);
  await save('trace-audit.json', await auditDebugEvidence(profile, { category: 'trace-forensics', projectId: profile.id, artifacts: traceArtifacts,
    pairedCapture: { beforeId: 'trace-before', afterId: 'trace-after', comparisonEvidenceIds: ['trace-pair'] } }));
  await save('result.json', { status: 'verified_scoped_forensics', runId, output, liveDir, supplied, localTraceDir,
    liveFiles: liveFiles.length, suppliedFiles: suppliedFiles.length, liveFocusSamples: liveTree.result.before,
    liveAfter: liveTree.result.after, traceFocusSamples: traceTree.result.before, traceAfter: traceTree.result.after,
    heapAllocator: 'runtime_allocation_stack', allocationDirectory, productFix: false });
} catch (error) {
  await save('failure.json', { status: 'failed', stage, message: error.message, stdout: error.stdout, stderr: error.stderr });
  process.exitCode = 1;
} finally {
  await fs.copyFile(fileURLToPath(import.meta.url), path.join(output, 'source-effect-session.mjs'));
  const files = [];
  for (const name of await fs.readdir(output)) { const bytes = await fs.readFile(path.join(output, name)); files.push({ path: name, bytes: bytes.length, sha256: hash(bytes) }); }
  await save('manifest.json', { runId, files });
  await verifyManifest(output);
  console.log(JSON.stringify({ status: process.exitCode ? 'failed' : 'verified_scoped_forensics', output, evidenceFiles: files.length }));
}
