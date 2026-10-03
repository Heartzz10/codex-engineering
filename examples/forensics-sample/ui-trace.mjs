import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const artifacts = path.join(here, 'artifacts');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const mode = process.argv[2] || 'capture';
const outputFlag = process.argv.indexOf('--output');
const output = outputFlag < 0 ? path.join(artifacts, `UI-RUN-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`) : path.resolve(process.argv[outputFlag + 1]);
assert(output.startsWith(`${artifacts}${path.sep}`), 'UI trace evidence must stay inside the sample artifacts directory');

async function browserBinary() {
  if (process.env.CODEX_UI_TRACE_BROWSER) return path.resolve(process.env.CODEX_UI_TRACE_BROWSER);
  for (const binary of ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe']) {
    try { if ((await fs.stat(binary)).isFile()) return binary; } catch { /* Try another installed browser. */ }
  }
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright');
  const names = (await fs.readdir(root)).filter(name => name.startsWith('chromium_headless_shell-')).sort().reverse();
  for (const name of names) {
    const binary = path.join(root, name, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe');
    try { if ((await fs.stat(binary)).isFile()) return binary; } catch { /* Try the next installed version. */ }
  }
  throw new Error('No installed Playwright Chromium headless shell; UI trace capture not run');
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.waiting = new Map();
    ws.onmessage = event => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (pending) { this.pending.delete(message.id); message.error ? pending.reject(Error(message.error.message)) : pending.resolve(message.result); }
      } else if (message.method && this.waiting.has(message.method)) {
        const waiting = this.waiting.get(message.method);
        this.waiting.delete(message.method);
        waiting.resolve(message.params);
      }
    };
    ws.onclose = () => {
      for (const pending of this.pending.values()) pending.reject(Error('CDP connection closed'));
      for (const waiting of this.waiting.values()) waiting.reject(Error('CDP connection closed'));
      this.pending.clear(); this.waiting.clear();
    };
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('CDP connection timed out')), 10000);
      ws.onopen = () => { clearTimeout(timer); resolve(); };
      ws.onerror = () => { clearTimeout(timer); reject(Error('CDP connection failed')); };
    });
    return new Cdp(ws);
  }
  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(Error(`CDP ${method} timed out`)); }, 20000);
      this.pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  event(method) {
    assert(!this.waiting.has(method), `Already waiting for ${method}`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiting.delete(method); reject(Error(`CDP ${method} event timed out`)); }, 30000);
      this.waiting.set(method, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
    });
  }
  close() { this.ws.close(); }
}

async function waitForPort(profileDir, child) {
  const file = path.join(profileDir, 'DevToolsActivePort');
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw Error(`Chromium exited before CDP became ready: ${child.exitCode}`);
    try { return Number((await fs.readFile(file, 'utf8')).split(/\r?\n/)[0]); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await pause(100);
  }
  throw Error('Chromium CDP port did not become ready');
}

async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true });
  assert(!result.exceptionDetails, `Page evaluation failed: ${result.exceptionDetails?.text}`);
  return result.result.value;
}

async function waitForPage(cdp) {
  for (let i = 0; i < 100; i++) {
    try { if (await evaluate(cdp, 'document.readyState === "complete" && !!document.querySelector("#run")')) return; }
    catch { /* Navigation may still be replacing the execution context. */ }
    await pause(100);
  }
  throw Error('Synthetic UI did not become ready');
}

async function readTrace(cdp, stream) {
  const chunks = [];
  for (let i = 0; i < 10000; i++) {
    const part = await cdp.send('IO.read', { handle: stream });
    chunks.push(part.base64Encoded ? Buffer.from(part.data, 'base64') : Buffer.from(part.data, 'utf8'));
    if (part.eof) { await cdp.send('IO.close', { handle: stream }); return Buffer.concat(chunks); }
  }
  throw Error('Trace stream exceeded read limit');
}

function findings(trace, profile, uiResult) {
  assert(Array.isArray(trace.traceEvents) && trace.traceEvents.length > 0, 'Raw UI trace has no events');
  const nodes = new Map(profile.nodes.map(node => [node.id, node.callFrame]));
  const busyFrames = (profile.samples || []).map(id => nodes.get(id)).filter(frame => frame?.functionName === 'forensicRenderLoop');
  const frame = busyFrames[0];
  assert(frame && frame.url.startsWith('file:') && frame.lineNumber >= 0, 'Clicked UI function lacks source-mapped CPU samples');
  const call = trace.traceEvents.find(event => event.name === 'FunctionCall' && event.args?.data?.functionName === 'forensicRenderLoop');
  assert(call?.args?.data?.url === frame.url && call.args.data.lineNumber === frame.lineNumber + 1, 'UI trace call does not map to the sampled source location');
  assert(/^Completed \d+$/.test(uiResult), 'Browser did not complete the clicked UI action');
  const names = new Map();
  for (const event of trace.traceEvents) names.set(event.name, (names.get(event.name) || 0) + 1);
  const clickEvents = trace.traceEvents.filter(event => event.name === 'EventDispatch' && event.args?.data?.type === 'click').length;
  assert(clickEvents > 0, 'Raw trace does not show a click dispatch');
  const start = trace.traceEvents.find(event => event.name === 'forensic-ui-start');
  const end = trace.traceEvents.find(event => event.name === 'forensic-ui-end');
  assert(start && end && end.ts > start.ts, 'UI trace lacks the synthetic action timing marks');
  return { eventCount: trace.traceEvents.length, clickEvents, eventNames: Object.fromEntries([...names].sort((a, b) => b[1] - a[1]).slice(0, 20)),
    busySamples: busyFrames.length, functionCallDurationMicroseconds: call.dur, markedWorkMicroseconds: end.ts - start.ts,
    source: { url: call.args.data.url, functionName: call.args.data.functionName, line: call.args.data.lineNumber }, uiResult };
}

async function capture() {
  await fs.mkdir(output); // Never overwrite an existing observation.
  const binary = await browserBinary();
  const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-ui-trace-chrome-'));
  const browser = spawn(binary, ['--headless', '--disable-gpu', '--disable-background-networking', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${profileDir}`, 'about:blank'],
  { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  let cdp, stage = 'launch', browserStderr = '';
  browser.stderr.on('data', chunk => { browserStderr = (browserStderr + chunk.toString('utf8')).slice(-4000); });
  try {
    const port = await waitForPort(profileDir, browser);
    stage = 'target-discovery';
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const page = targets.find(target => target.type === 'page');
    assert(page?.webSocketDebuggerUrl, 'Chromium did not expose an isolated page target');
    cdp = await Cdp.connect(page.webSocketDebuggerUrl);
    const version = (await cdp.send('Browser.getVersion')).product;
    stage = 'page-navigation';
    await cdp.send('Page.enable'); await cdp.send('Runtime.enable'); await cdp.send('Profiler.enable');
    const uiFile = path.join(here, 'ui-trace.html');
    await cdp.send('Page.navigate', { url: pathToFileURL(uiFile).href });
    await waitForPage(cdp);
    const initial = await evaluate(cdp, 'document.querySelector("#result").textContent');
    assert(initial === 'Idle', 'Synthetic UI initial state changed');
    const rect = await evaluate(cdp, 'document.querySelector("#run").getBoundingClientRect().toJSON()');
    const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
    stage = 'tracing-start';
    await cdp.send('Tracing.start', { categories: 'devtools.timeline,disabled-by-default-devtools.timeline,blink.user_timing,v8,disabled-by-default-v8.cpu_profiler',
      options: 'record-as-much-as-possible', transferMode: 'ReturnAsStream' });
    stage = 'input-and-profile';
    await cdp.send('Profiler.start');
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    const uiResult = await evaluate(cdp, 'document.querySelector("#result").textContent');
    const { profile } = await cdp.send('Profiler.stop');
    stage = 'tracing-end';
    const complete = cdp.event('Tracing.tracingComplete');
    await cdp.send('Tracing.end');
    const { stream } = await complete;
    assert(stream, 'Tracing did not return a raw stream');
    stage = 'trace-read';
    const rawTrace = await readTrace(cdp, stream);
    const rawProfile = Buffer.from(`${JSON.stringify(profile)}\n`);
    const trace = JSON.parse(rawTrace.toString('utf8'));
    stage = 'trace-analysis';
    const result = findings(trace, profile, uiResult);
    stage = 'reversible-live-intervention';
    await evaluate(cdp, 'document.querySelector("#run").removeEventListener("click", forensicRenderLoop); document.querySelector("#result").textContent = "Intervened"; true');
    await cdp.send('Profiler.start');
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    const intervenedResult = await evaluate(cdp, 'document.querySelector("#result").textContent');
    const { profile: intervenedProfile } = await cdp.send('Profiler.stop');
    await evaluate(cdp, 'document.querySelector("#run").addEventListener("click", forensicRenderLoop); document.querySelector("#result").textContent = "Restored"; true');
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    const restoredResult = await evaluate(cdp, 'document.querySelector("#result").textContent');
    const intervenedFrames = new Map(intervenedProfile.nodes.map(node => [node.id, node.callFrame]));
    const intervenedBusySamples = (intervenedProfile.samples || []).filter(id => intervenedFrames.get(id)?.functionName === 'forensicRenderLoop').length;
    assert(intervenedResult === 'Intervened' && intervenedBusySamples === 0 && /^Completed \d+$/.test(restoredResult), 'Synthetic click handler suppression or restoration failed');
    await fs.writeFile(path.join(output, 'ui-trace.json'), rawTrace);
    await fs.writeFile(path.join(output, 'ui-cpu.cpuprofile'), rawProfile);
    await fs.writeFile(path.join(output, 'ui-intervention.cpuprofile'), `${JSON.stringify(intervenedProfile)}\n`);
    await fs.copyFile(uiFile, path.join(output, 'source-ui-trace.html'));
    await fs.copyFile(fileURLToPath(import.meta.url), path.join(output, 'source-ui-trace.mjs'));
    await fs.writeFile(path.join(output, 'events.jsonl'), trace.traceEvents.map(event => JSON.stringify({ name: event.name, cat: event.cat, ts: event.ts, dur: event.dur,
      pid: event.pid, tid: event.tid, type: event.args?.data?.type, functionName: event.args?.data?.functionName,
      url: event.args?.data?.url || event.args?.data?.scriptName, line: event.args?.data?.lineNumber })).join('\n') + '\n');
    const frames = new Map(profile.nodes.map(node => [node.id, node.callFrame]));
    await fs.writeFile(path.join(output, 'frames.jsonl'), profile.samples.map((nodeId, sample) => {
      const frame = frames.get(nodeId);
      return JSON.stringify({ sample, nodeId, microseconds: profile.timeDeltas?.[sample], functionName: frame?.functionName,
        url: frame?.url, line: frame?.lineNumber >= 0 ? frame.lineNumber + 1 : null });
    }).join('\n') + '\n');
    const diagnosis = { status: 'verified_synthetic_ui_trace', scope: 'Isolated Chromium file page with no application network requests; browser background traffic was not measured', browserVersion: version,
      action: 'CDP Input mouse press/release on #run; read #result after completion', ...result,
      liveIntervention: { operation: 'remove click handler, click the same button, profile again, then restore and click again without reloading', result: intervenedResult, busySamples: intervenedBusySamples, restoredResult, file: 'ui-intervention.cpuprofile' },
      interpretation: 'A browser click ran the synthetic busy function. EventDispatch and source-mapped CPU samples identify this sample mechanism; removing the click handler on the same live page suppressed its hot samples. No product fix or performance improvement is claimed.' };
    await fs.writeFile(path.join(output, 'ui-diagnosis.json'), `${JSON.stringify(diagnosis, null, 2)}\n`);
    const names = (await fs.readdir(output)).filter(name => name !== 'manifest.json');
    const files = [];
    for (const name of names) { const bytes = await fs.readFile(path.join(output, name)); files.push({ path: name, bytes: bytes.length, sha256: hash(bytes) }); }
    await fs.writeFile(path.join(output, 'manifest.json'), `${JSON.stringify({ schemaVersion: 1, createdAt: new Date().toISOString(), files }, null, 2)}\n`);
    return { status: diagnosis.status, output, browserVersion: version, eventCount: result.eventCount, clickEvents: result.clickEvents,
      busySamples: result.busySamples, source: result.source, uiResult };
  } catch (error) {
    await fs.writeFile(path.join(output, 'capture-failure.json'), `${JSON.stringify({ stage, error: error.message, browserExitCode: browser.exitCode, browserStderr }, null, 2)}\n`);
    throw Error(`${stage}: ${error.message}`);
  } finally {
    cdp?.close();
    browser.kill();
    await Promise.race([new Promise(resolve => browser.once('exit', resolve)), pause(5000)]);
    const tempRoot = path.resolve(os.tmpdir());
    assert(path.resolve(profileDir).startsWith(`${tempRoot}${path.sep}`) && path.basename(profileDir).startsWith('codex-ui-trace-chrome-'), 'Unexpected browser profile cleanup path');
    await fs.rm(profileDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function verify() {
  const manifest = JSON.parse(await fs.readFile(path.join(output, 'manifest.json'), 'utf8'));
  const names = (await fs.readdir(output)).filter(name => name !== 'manifest.json').sort();
  assert(JSON.stringify(names) === JSON.stringify(manifest.files.map(item => item.path).sort()), 'UI trace file set changed');
  for (const item of manifest.files) {
    const bytes = await fs.readFile(path.join(output, item.path));
    assert(bytes.length === item.bytes && hash(bytes) === item.sha256, `UI trace artifact changed: ${item.path}`);
  }
  const trace = JSON.parse(await fs.readFile(path.join(output, 'ui-trace.json'), 'utf8'));
  const profile = JSON.parse(await fs.readFile(path.join(output, 'ui-cpu.cpuprofile'), 'utf8'));
  const diagnosis = JSON.parse(await fs.readFile(path.join(output, 'ui-diagnosis.json'), 'utf8'));
  const derived = findings(trace, profile, diagnosis.uiResult);
  for (const key of ['eventCount', 'clickEvents', 'busySamples', 'functionCallDurationMicroseconds', 'markedWorkMicroseconds']) assert(derived[key] === diagnosis[key], `UI diagnosis ${key} changed`);
  assert(JSON.stringify(derived.source) === JSON.stringify(diagnosis.source), 'UI source map changed');
  const events = (await fs.readFile(path.join(output, 'events.jsonl'), 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line));
  const frames = (await fs.readFile(path.join(output, 'frames.jsonl'), 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line));
  assert(events.length === derived.eventCount && events.some(row => row.name === 'FunctionCall' && row.functionName === derived.source.functionName && row.line === derived.source.line), 'Queryable UI events differ from raw trace');
  assert(frames.length === profile.samples.length && frames.filter(row => row.functionName === derived.source.functionName).length === derived.busySamples, 'Queryable UI frames differ from raw profile');
  if (diagnosis.liveIntervention) {
    const intervened = JSON.parse(await fs.readFile(path.join(output, diagnosis.liveIntervention.file), 'utf8'));
    const nodes = new Map(intervened.nodes.map(node => [node.id, node.callFrame]));
    const busy = (intervened.samples || []).filter(id => nodes.get(id)?.functionName === derived.source.functionName).length;
    assert(diagnosis.liveIntervention.result === 'Intervened' && busy === diagnosis.liveIntervention.busySamples && busy === 0 && /^Completed \d+$/.test(diagnosis.liveIntervention.restoredResult), 'Live UI intervention differs from raw profile');
  }
  return { status: 'verified_existing_ui_trace', output, files: manifest.files.length, ...derived };
}

try {
  const result = mode === 'capture' ? await capture() : mode === 'verify' ? await verify() : (() => { throw Error('Use capture or verify'); })();
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ status: 'blocked', error: error.message, output })}\n`);
  process.exitCode = 2;
}
