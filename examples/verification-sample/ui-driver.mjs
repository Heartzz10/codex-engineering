import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { collectVisualSnapshot, assessVisualSnapshot } from '../../src/visual-check.mjs';
import { getDebugProtocol } from '../../src/pstack.mjs';
import { checkUISourceFiles } from '../../src/ui-source-check.mjs';
import { assessUIQualityCoverage } from '../../src/ui-quality.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const runId = `ui-driver-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
const output = path.join(root, 'evidence', runId);
const dataDir = `.runtime/${runId}`;
const exec = promisify(execFile);
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let axeSource, uiConfig;
const uiObservations = [], runtimeAssessments = [];

function uiObservation(ruleId, actual, evidenceRef, actions = [], extra = {}) {
  const requirement = uiConfig?.requirements.find(item => item.ruleId === ruleId);
  if (requirement && actual !== undefined) uiObservations.push({ ...requirement, ruleVersion:uiConfig.ruleVersion, environmentRef:'isolated-loopback', actual,
    evidenceRef, actions, ...extra });
}

async function browserBinary() {
  if (process.env.CODEX_SAMPLE_BROWSER) return path.resolve(process.env.CODEX_SAMPLE_BROWSER);
  const browsers = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright');
  try {
    const names = (await fs.readdir(browsers)).filter(name => name.startsWith('chromium_headless_shell-')).sort().reverse();
    for (const name of names) {
      const binary = path.join(browsers, name, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe');
      try { if ((await fs.stat(binary)).isFile()) return binary; } catch { /* Try next installation. */ }
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const binary of ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe']) {
    try { if ((await fs.stat(binary)).isFile()) return binary; } catch { /* Try next installed browser. */ }
  }
  throw Error('No installed Chrome, Edge or Chromium headless shell');
}

class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    socket.onmessage = event => {
      const message = JSON.parse(event.data);
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      message.error ? pending.reject(Error(message.error.message)) : pending.resolve(message.result);
    };
    socket.onclose = () => {
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(Error('CDP connection closed')); }
      this.pending.clear();
    };
  }
  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('CDP connection timed out')), 10000);
      socket.onopen = () => { clearTimeout(timer); resolve(); };
      socket.onerror = () => { clearTimeout(timer); reject(Error('CDP connection failed')); };
    });
    return new Cdp(socket);
  }
  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(Error(`${method} timed out`)); }, 15000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  close() { this.socket.close(); }
}

async function waitForPort(profileDir, child) {
  const marker = path.join(profileDir, 'DevToolsActivePort');
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw Error(`Browser exited before CDP was ready: ${child.exitCode}`);
    try { return Number((await fs.readFile(marker, 'utf8')).split(/\r?\n/)[0]); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await pause(100);
  }
  throw Error('Browser CDP port did not become ready');
}

async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true });
  assert(!result.exceptionDetails, `Page evaluation failed: ${result.exceptionDetails?.text}`);
  return result.result.value;
}

async function waitUntil(cdp, expression, description) {
  for (let i = 0; i < 100; i++) {
    try { if (await evaluate(cdp, expression)) return; }
    catch { /* Navigation can replace the execution context. */ }
    await pause(100);
  }
  throw Error(`Timed out waiting for ${description}`);
}

async function click(cdp, selector) {
  const rect = await evaluate(cdp, `document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect().toJSON()`);
  assert(rect?.width > 0 && rect?.height > 0, `Missing visible control ${selector}`);
  const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}

async function fill(cdp, selector, value, expectedValue = value) {
  await click(cdp, selector);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'A', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'A', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
  await cdp.send('Input.insertText', { text: value });
  assert.equal(await evaluate(cdp, `document.querySelector(${JSON.stringify(selector)}).value`), expectedValue);
}

async function key(cdp, name) {
  const code = name === 'Tab' ? 9 : name === 'Enter' ? 13 : 27;
  const text = name === 'Enter' ? '\r' : '';
  // Chromium needs Enter's text to produce the keypress/default button activation.
  await cdp.send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key: name, code: name, windowsVirtualKeyCode: code, text, unmodifiedText: text });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code: name, windowsVirtualKeyCode: code });
}

async function view(cdp) {
  return evaluate(cdp, `({url: location.href, title: document.title,
    status: document.querySelector('#status')?.textContent,
    count: document.querySelector('#count')?.textContent,
    noteInput: document.querySelector('#note')?.value,
    noteError: document.querySelector('#note-error')?.textContent,
    noteInvalid: document.querySelector('#note')?.getAttribute('aria-invalid'),
    focusedNote: document.activeElement===document.querySelector('#note'),
    searchInput: document.querySelector('#query')?.value,
    notes: [...document.querySelectorAll('#notes li')].map(el => ({id: el.dataset.noteId, text: el.textContent}))})`);
}

async function saveSnapshot(cdp, label) {
  const dom = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
  const aria = await cdp.send('Accessibility.getFullAXTree');
  const html = await evaluate(cdp, 'document.documentElement.outerHTML');
  const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  await fs.writeFile(path.join(output, `${label}.dom.json`), `${JSON.stringify(dom)}\n`);
  await fs.writeFile(path.join(output, `${label}.aria.json`), `${JSON.stringify(aria)}\n`);
  await fs.writeFile(path.join(output, `${label}.html`), html);
  await fs.writeFile(path.join(output, `${label}.png`), Buffer.from(screenshot.data, 'base64'));
  return view(cdp);
}

async function visual(cdp, label, viewport) {
  const constraints = { goal: '笔记保存/搜索控件在目标视口可读、完整、无遮挡，页面无横向溢出', viewport,
    required: [
      { selector: 'h1', inViewport: true }, { selector: '#note', inViewport: true, interactive: true },
      { selector: '#create-form button', inViewport: true, interactive: true }, { selector: '#status', inViewport: true },
      { selector: '#query', inViewport: true, interactive: true }, { selector: '#search-form button', inViewport: true, interactive: true },
      { selector: '#count', inViewport: true }
    ], rules: [
      { id: 'create-button-contained', type: 'containment', categoryId: 'Q01', selector: '#create-form button', containerSelector: '#create-form', source: 'public/index.html#create-form' },
      { id: 'fields-left-aligned', type: 'alignment', categoryId: 'Q02', selector: '#note', otherSelector: '#query', edge: 'left', tolerance: 1, source: 'public/index.html#form-block-flow' },
      { id: 'status-search-spacing', type: 'spacing', categoryId: 'Q01', selector: '#status', otherSelector: '#search-form', axis: 'vertical', min: 0, source: 'public/index.html#status' },
      { id: 'heading-text-unclipped', type: 'text-clipping', categoryId: 'Q03', selector: 'h1', allowTruncation: false, source: 'GUIDE.md#Browser' },
      { id: 'persistence-disclosure', type: 'text-clipping', categoryId: 'Q14', selector: 'small', allowTruncation: false, source: 'GUIDE.md#Browser' },
      { id: 'status-visible', type: 'state', categoryId: 'Q09', selector: '#status', expect: { visible: true }, source: 'GUIDE.md#Browser' },
      ...['#create-form button', '#search-form button'].map((selector, i) => ({ id: `button-hit-target-${i}`, type: 'hit-target', categoryId: 'Q07', selector,
        minWidth: 24, minHeight: 24, tolerance: 0, inViewport: true, source: 'https://www.w3.org/TR/WCAG22/#target-size-minimum' })),
      { id: 'sample-axe', type: 'axe', categoryId: 'Q05', source: 'docs/ui-interaction-quality-plan-20260927.md#UI-W3' }
    ] };
  if(label==='visual-long-note')constraints.rules.push({id:'long-note-unclipped',type:'text-clipping',categoryId:'Q03',selector:'#notes li:last-child',allowTruncation:false,source:'GUIDE.md#Browser'});
  await cdp.send('Emulation.setDeviceMetricsOverride', { ...viewport, deviceScaleFactor: 1, mobile: false });
  await evaluate(cdp, 'scrollTo(0,0); true');
  const snapshot = await collectVisualSnapshot(cdp, constraints, { axeSource });
  const assessment = assessVisualSnapshot(snapshot, constraints);
  const legacyAssessment = assessVisualSnapshot(snapshot, { ...constraints, rules: undefined });
  const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await fs.writeFile(path.join(output, `${label}.visual.json`), `${JSON.stringify({ constraints, snapshot, assessment, legacyAssessment }, null, 2)}\n`);
  await fs.writeFile(path.join(output, `${label}.png`), Buffer.from(screenshot.data, 'base64'));
  const evidenceRef = `${label}.visual.json`;
  if (!label.includes('fault')) {
    runtimeAssessments.push({ label, status: assessment.status, findings: assessment.findings, evidenceRef });
    const finding = id => assessment.findings.find(item => item.ruleId === id);
    const target = snapshot.elements.find(item => item.selector === '#create-form button')?.rect;
    const container = snapshot.elements.find(item => item.selector === '#create-form')?.rect;
    if (target && container) uiObservation('sample-containment', Math.max(container.x - target.x, container.y - target.y,
      target.x + target.width - container.x - container.width, target.y + target.height - container.y - container.height), evidenceRef);
    uiObservation('sample-alignment', finding('fields-left-aligned')?.actual, evidenceRef);
    uiObservation('sample-title', snapshot.elements.find(item => item.selector === 'h1')?.text, evidenceRef);
    if (viewport.width === 360) uiObservation('sample-narrow-overflow', snapshot.document.scrollWidth - viewport.width, evidenceRef);
    const audit = snapshot.accessibilityChecks?.find(item => item.ruleId === 'sample-axe');
    if (audit?.results) uiObservation('sample-axe', { violations: audit.results.violations.length, incomplete: audit.results.incomplete.length }, evidenceRef, [],
      audit.results.incomplete.length ? { certainty: 'needs_review' } : {});
    const sizes = snapshot.elements.filter(item => ['#create-form button', '#search-form button'].includes(item.selector));
    if (sizes.length === 2 && sizes.every(item => item.rect)) uiObservation('sample-target-size', Math.min(...sizes.flatMap(item => [item.rect.width, item.rect.height])), evidenceRef);
    uiObservation('sample-status-visible', snapshot.elements.find(item => item.selector === '#status')?.state?.visible, evidenceRef);
  }
  return { label, ...assessment, legacyAssessment };
}

async function visualFaultSession(cdp, report, launch) {
  const desktop = { width: 1280, height: 900 }, narrow = { width: 360, height: 1000 };
  report.visual = { desktop: await visual(cdp, 'visual-desktop-correct', desktop),
    narrow: await visual(cdp, 'visual-narrow-correct', narrow) };
  assert.equal(report.visual.desktop.legacyAssessment.status, 'passed');
  assert.equal(report.visual.narrow.legacyAssessment.status, 'passed');
  // Deliberate isolated bad CSS is removed before any normal business scenario.
  await evaluate(cdp, `(() => { const style = document.createElement('style'); style.id = 'visual-overflow-fault'; style.textContent='body{min-width:1000px}'; document.head.append(style); return true; })()`);
  report.visual.badOverflow = await visual(cdp, 'visual-narrow-overflow-fault', narrow);
  assert.equal(report.visual.badOverflow.status, 'failed');
  assert(report.visual.badOverflow.issues.some(item => item.code === 'horizontal_overflow'));
  await evaluate(cdp, `document.querySelector('#visual-overflow-fault').remove(); true`);
  report.visual.overflowRestored = await visual(cdp, 'visual-narrow-overflow-restored', narrow);
  assert.equal(report.visual.overflowRestored.legacyAssessment.status, 'passed');
  await evaluate(cdp, `(() => { const b=document.querySelector('#create-form button').getBoundingClientRect(); const layer=document.createElement('div'); layer.id='visual-button-fault'; layer.style.cssText='position:fixed;z-index:99999;background:rgba(170,0,0,.65);left:'+b.x+'px;top:'+b.y+'px;width:'+b.width+'px;height:'+b.height+'px'; document.body.append(layer); window.effectEvents=[]; document.addEventListener('click',e=>effectEvents.push({type:'click',target:e.target.id||e.target.tagName}),true); document.querySelector('#create-form').addEventListener('submit',()=>effectEvents.push({type:'submit'}),true); return true; })()`);
  report.visual.badObstruction = await visual(cdp, 'visual-button-obstruction-fault', narrow);
  assert(report.visual.badObstruction.issues.some(item => item.code === 'control_obstructed' && item.selector === '#create-form button'));
  const initial = await view(cdp);
  await click(cdp, '#create-form button');
  await pause(200);
  const failed = { expected: '请输入笔记正文', actual: await view(cdp), events: await evaluate(cdp, 'effectEvents') };
  assert.equal(failed.actual.status, initial.status, 'The injected layer did not reproduce the missing feedback');
  assert.equal(failed.events.some(event => event.type === 'submit'), false);
  await fs.writeFile(path.join(output, 'effect-failing-original-click.json'), `${JSON.stringify(failed, null, 2)}\n`);
  // Collect decisive observations before writing the choice of repair.
  const health = await (await fetch(`${launch.url}/health`)).json();
  const notes = await (await fetch(`${launch.url}/api/notes`)).json();
  assert.equal(health.instanceId, launch.instanceId);
  assert.equal(health.sourceHash, launch.sourceHash);
  await evaluate(cdp, `document.querySelector('#create-form').requestSubmit(); true`);
  await waitUntil(cdp, `document.querySelector('#status')?.textContent.includes('请输入笔记正文')`, 'submit handler diagnostic bypass');
  const submitProbe = { action: 'requestSubmit仅用于隔离假设测试，未代替原按钮验收', view: await view(cdp), events: await evaluate(cdp, 'effectEvents') };
  assert(submitProbe.events.some(event => event.type === 'submit'));
  assert.equal(submitProbe.view.notes.length, 0);
  await fs.writeFile(path.join(output, 'effect-submit-handler-probe.json'), `${JSON.stringify(submitProbe, null, 2)}\n`);
  const hypotheses = [
    { id: 'H1', candidate: '服务/读回不可用导致保存无反馈', status: 'refuted', evidence: { health, notes }, reason: '健康实例身份匹配且API正常返回；原点击没有触发表单提交' },
    { id: 'H2', candidate: '提交逻辑未绑定或数据校验失效', status: 'refuted', evidence: submitProbe, reason: '保持遮挡层不变，requestSubmit诊断触发表单原处理器并收到真实API校验错误；提交处理器正常，故障在按钮指针路径' },
    { id: 'H3', candidate: '覆盖层截获保存按钮的指针输入', status: 'supported', evidence: { hitTests: report.visual.badObstruction.issues, events: failed.events }, reason: '五点命中检测和真实点击均指向注入遮挡层' }
  ];
  await fs.writeFile(path.join(output, 'effect-hypotheses.json'), `${JSON.stringify(hypotheses, null, 2)}\n`);
  const choice = { recordedAt: new Date().toISOString(), beforeRepair: true,
    alternatives: [ { action: '移除本会话注入的覆盖层', consequence: '恢复原DOM与原输入路径，不保留故障对象', selected: true },
      { action: '将覆盖层pointer-events设为none', consequence: '允许点击但仍保留视觉遮盖与故障对象', selected: false } ],
    reason: '覆盖层是已知隔离注入；移除直接恢复原件。无跨业务函数改动，无推测性业务保护。' };
  await fs.writeFile(path.join(output, 'effect-design-before-repair.json'), `${JSON.stringify(choice, null, 2)}\n`);
  await evaluate(cdp, `document.querySelector('#visual-button-fault').remove(); true`);
  report.visual.obstructionRestored = await visual(cdp, 'visual-button-obstruction-restored', narrow);
  assert.equal(report.visual.obstructionRestored.legacyAssessment.status, 'passed');
  await click(cdp, '#create-form button');
  await waitUntil(cdp, `document.querySelector('#status')?.textContent.includes('请输入笔记正文')`, 'same button validation after layer removal');
  const passed = { actual: await view(cdp), events: await evaluate(cdp, 'effectEvents') };
  assert(passed.events.some(event => event.type === 'submit'));
  assert.equal(passed.actual.notes.length, 0);
  await fs.writeFile(path.join(output, 'effect-passing-original-click.json'), `${JSON.stringify(passed, null, 2)}\n`);
  report.effectSession = { scope: '当前隔离页面故障注入与原按钮输入复验；非历史AI修复补证', hypotheses,
    failed: 'effect-failing-original-click.json', design: 'effect-design-before-repair.json', passed: 'effect-passing-original-click.json',
    sourceUnchanged: true, trialCodeEdits: false, sameSurface: launch.url, role: 'sample-user', environment: 'isolated-loopback' };
  await cdp.send('Page.reload', { ignoreCache: true });
  await waitUntil(cdp, `document.querySelector('#status')?.textContent === '笔记已加载'`, 'original page restored');
}

async function command(...args) {
  const result = await exec(process.execPath, [path.join(root, 'driver.mjs'), ...args], { cwd: root, windowsHide: true, timeout: 15000 });
  return JSON.parse(result.stdout.trim());
}

async function waitForStop(url) {
  for (let attempt = 0; attempt < 50; attempt++) {
    try { await fetch(`${url}/health`, { signal: AbortSignal.timeout(250) }); }
    catch { return; }
    await pause(100);
  }
  throw Error('Stopped instance still answers health requests');
}

async function main() {
  await fs.mkdir(output); // A run never overwrites existing evidence.
  const report = { runId, projectId: 'verification-sample', environmentRef: 'isolated-loopback', roleRef: 'sample-user', dataScopeRef: 'sample-only',
    source: 'ui-driver.mjs, browser CDP input and DOM/ARIA capture', stages: [], status: 'running' };
  let browser, cdp, profileDir, launched, activeUrl, sourceFiles = [], stage = 'preflight', stderr = '';
  try {
    uiConfig = JSON.parse(await fs.readFile(path.join(root, 'ui-quality.json'), 'utf8'));
    for (const axePath of ['../../vendor/ui-tools/axe.min.js', '../../node_modules/axe-core/axe.min.js']) {
      try { axeSource = await fs.readFile(path.join(root, axePath), 'utf8'); break; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (!axeSource) report.axeToolGap = 'Local axe-core browser bundle is not installed';
    report.sourceCheck = await checkUISourceFiles({ files: [path.join(root, 'public/index.html')] });
    await fs.writeFile(path.join(output, 'ui-source-check.json'), `${JSON.stringify(report.sourceCheck, null, 2)}\n`);
    if (report.sourceCheck.status !== 'gaps') uiObservation('sample-source', report.sourceCheck.findings.length, 'ui-source-check.json');
    for (const [label, file] of [['server', path.join(root, 'server.mjs')], ['driver', path.join(root, 'driver.mjs')],
      ['page', path.join(root, 'public/index.html')], ['ui-driver', fileURLToPath(import.meta.url)],
      ['visual-check', path.join(root, '../../src/visual-check.mjs')], ['ui-runtime-check', path.join(root, '../../src/ui-runtime-check.mjs')],
      ['ui-quality-config', path.join(root, 'ui-quality.json')], ['ui-quality-facts', path.join(root, 'ui-quality-facts.json')]]) {
      const bytes = await fs.readFile(file);
      const snapshot = `source-${label}${path.extname(file)}`;
      await fs.writeFile(path.join(output, snapshot), bytes, { flag: 'wx' });
      sourceFiles.push({ file: path.resolve(file), snapshot, sha256: hash(bytes), bytes: bytes.length });
    }
    report.sourceFiles = sourceFiles;
    const protocol = await getDebugProtocol({ category: 'bug-fix' });
    const plan = { createdAt: new Date().toISOString(), beforeExecution: true, protocol,
      scope: '隔离样例临时窄屏溢出/保存按钮遮挡；现有业务保存搜索与重启回归',
      steps: protocol.steps.map(step => ({ id: step.id, applicability: step.id === 'refuted-hypothesis' ? 'skip' : 'applicable',
        reason: step.id === 'refuted-hypothesis' ? '假设测试仅只读观察，不产生被否定的试改；临时注入层会定点移除' :
          step.id === 'design-fix' ? '比较移除注入层/禁指针两种局部恢复方案；跨函数架构分支不适用' :
          step.id === 'regression' ? '先记录同按钮真实失败，恢复后复验；随后运行现有11目标及重启读回' : '按原CDP入口留当轮原件' })),
      limits: '不补旧CHG-0001～0003，不调用供应商，不执行0→1，不宣称产品修复或视觉风格完全自动判定' };
    await fs.writeFile(path.join(output, 'effect-plan-before-execution.json'), `${JSON.stringify(plan, null, 2)}\n`);
    // Preserve an already healthy user instance; an explicit launch must own its cleanup target.
    try { const active = await command('doctor'); throw Error(`An active sample instance already exists: ${active.instanceId}`); }
    catch (error) { if (!/fetch failed|ECONNREFUSED/.test(error.message)) throw error; }
    stage = 'launch';
    const launch = await command('launch', '--port', '0', '--data-dir', dataDir);
    launched = launch.instanceId;
    activeUrl = launch.url;
    const doctor = await command('doctor');
    assert.equal(doctor.instanceId, launch.instanceId);
    assert.equal(doctor.pid, launch.pid);
    assert.equal(doctor.dataDir, launch.dataDir);
    report.instance = { ...launch, doctor };
    report.stages.push('launch', 'doctor');
    stage = 'browser-launch';
    const binary = await browserBinary();
    profileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-sample-ui-'));
    browser = spawn(binary, ['--headless', '--disable-gpu', '--no-sandbox', '--disable-background-networking', '--no-first-run', '--no-default-browser-check',
      '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${profileDir}`, 'about:blank'],
    { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    browser.stderr.on('data', chunk => { stderr = (stderr + chunk.toString('utf8')).slice(-4000); });
    const port = await waitForPort(profileDir, browser);
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const page = targets.find(target => target.type === 'page');
    assert(page?.webSocketDebuggerUrl, 'Browser did not expose a page target');
    cdp = await Cdp.connect(page.webSocketDebuggerUrl);
    report.browser = { binary, version: (await cdp.send('Browser.getVersion')).product };
    await cdp.send('Page.enable'); await cdp.send('Runtime.enable'); await cdp.send('DOM.enable'); await cdp.send('Accessibility.enable');
    stage = 'navigate';
    await cdp.send('Page.navigate', { url: launch.url });
    await waitUntil(cdp, `document.readyState === 'complete' && document.querySelector('#status')?.textContent === '笔记已加载'`, 'loaded sample page');
    report.initial = await saveSnapshot(cdp, '00-initial');
    assert.equal(report.initial.url, new URL('/', launch.url).href);
    assert.equal(report.initial.notes.length, 0, 'Isolated data was not empty');
    assert.equal(report.initial.count, '还没有笔记', '未搜索时的空列表不能称为没有匹配笔记');
    stage = 'visual-fault-session';
    await visualFaultSession(cdp, report, launch);
    report.stages.push('visual_constraints', 'visual_correct_viewports', 'fault_hypothesis_elimination', 'design_before_repair', 'same_button_replay', 'bad_visuals_detected');
    stage = 'empty-create';
    await click(cdp, '#create-form button');
    await waitUntil(cdp, `document.querySelector('#status')?.textContent.includes('请输入笔记正文')`, 'empty input error');
    report.emptyCreate = await saveSnapshot(cdp, '01-empty-create');
    assert.equal(report.emptyCreate.notes.length, 0);
    assert.equal(report.emptyCreate.noteError,'请输入笔记正文');
    assert.equal(report.emptyCreate.noteInvalid,'true');
    assert.equal(report.emptyCreate.focusedNote,true);
    await fill(cdp,'#note','   ');
    await click(cdp,'#create-form button');
    await waitUntil(cdp,`document.querySelector('#status')?.textContent==='请输入笔记正文'`,'whitespace-only input error');
    report.invalidRetained=await saveSnapshot(cdp,'01-invalid-retained');
    assert.equal(report.invalidRetained.noteInput,'   ');
    assert.equal(report.invalidRetained.noteInvalid,'true');
    assert.equal(report.invalidRetained.focusedNote,true);
    stage = 'create';
    const marker = '工程验收-20260923-真实浏览器持久化';
    report.marker = marker;
    await fill(cdp, '#note', '界'.repeat(2001), '界'.repeat(2000));
    report.boundaryInput = await evaluate(cdp, `({length:document.querySelector('#note').value.length,maxLength:document.querySelector('#note').maxLength})`);
    await fs.writeFile(path.join(output, 'boundary-input.json'), `${JSON.stringify(report.boundaryInput, null, 2)}\n`);
    uiObservation('sample-input-boundary', report.boundaryInput.length, 'boundary-input.json', ['input', 'wait']);
    await fill(cdp, '#note', marker);
    await key(cdp, 'Tab');
    report.keyboard = await evaluate(cdp, `({focusedSelector:document.activeElement===document.querySelector('#create-form button')?'#create-form button':document.activeElement.tagName,
      focusVisible:document.activeElement.matches(':focus-visible'),outlineStyle:getComputedStyle(document.activeElement).outlineStyle,
      outlineWidth:getComputedStyle(document.activeElement).outlineWidth})`);
    assert.equal(report.keyboard.focusedSelector, '#create-form button');
    await fs.writeFile(path.join(output, 'keyboard-focus.json'), `${JSON.stringify(report.keyboard, null, 2)}\n`);
    uiObservation('sample-keyboard-focus', report.keyboard.focusedSelector, 'keyboard-focus.json', ['input', 'key', 'wait']);
    uiObservation('sample-keyboard-focus-visible', report.keyboard.focusVisible, 'keyboard-focus.json', ['input', 'key', 'wait']);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 300, downloadThroughput: -1, uploadThroughput: -1 });
    await evaluate(cdp, `(() => { window.keyboardEvents=[]; for(const type of ['keydown','keypress','keyup','submit'])document.addEventListener(type,event=>keyboardEvents.push({type,key:event.key,target:event.target.id||event.target.tagName,isTrusted:event.isTrusted}),true); return true; })()`);
    await key(cdp, 'Enter');
    await waitUntil(cdp, `document.querySelector('#status')?.textContent === '正在保存并读取结果…'`, 'pending save feedback');
    report.pendingSave = await saveSnapshot(cdp, 'pending-save');
    uiObservation('sample-pending-save', report.pendingSave.status, 'pending-save.dom.json', ['input', 'key', 'wait']);
    await waitUntil(cdp, `document.querySelector('#status')?.textContent === '已保存并读回笔记' && [...document.querySelectorAll('#notes li')].some(el => el.textContent === ${JSON.stringify(marker)})`, 'saved note readback');
    report.created = await saveSnapshot(cdp, '02-created');
    uiObservation('sample-persistence-disclosure', await evaluate(cdp, `document.querySelector('small')?.textContent`), '02-created.dom.json', ['input', 'key', 'wait']);
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    report.visual.savedNarrow = await visual(cdp, 'visual-narrow-saved', { width: 360, height: 1000 });
    assert.equal(report.visual.savedNarrow.legacyAssessment.status, 'passed');
    assert.equal(report.created.notes.length, 1);
    assert.equal(report.created.notes[0].text, marker);
    stage = 'reload';
    await cdp.send('Page.reload', { ignoreCache: true });
    await waitUntil(cdp, `document.readyState === 'complete' && document.querySelector('#status')?.textContent === '笔记已加载' && [...document.querySelectorAll('#notes li')].some(el => el.textContent === ${JSON.stringify(marker)})`, 'persisted note after reload');
    report.reloaded = await saveSnapshot(cdp, '03-reloaded');
    assert.deepEqual(report.reloaded.notes, report.created.notes);
    uiObservation('sample-refresh', report.reloaded.notes[0].text, '03-reloaded.dom.json', ['input', 'key', 'wait', 'readback']);
    stage = 'search-match';
    const query = marker.slice(0, 7);
    await fill(cdp, '#query', query);
    await click(cdp, '#search-form button');
    await waitUntil(cdp, `document.querySelector('#status')?.textContent === '搜索完成' && document.querySelector('#count')?.textContent === '共 1 条笔记'`, 'matching search');
    report.searchMatch = await saveSnapshot(cdp, '04-search-match');
    assert.deepEqual(report.searchMatch.notes, report.created.notes);
    stage = 'search-absent';
    await fill(cdp, '#query', `absent-${marker}`);
    await click(cdp, '#search-form button');
    await waitUntil(cdp, `document.querySelector('#status')?.textContent === '搜索完成' && document.querySelector('#count')?.textContent === '没有匹配笔记'`, 'absent search');
    report.searchAbsent = await saveSnapshot(cdp, '05-search-absent');
    assert.equal(report.searchAbsent.notes.length, 0);
    stage = 'search-clear';
    await fill(cdp, '#query', '');
    await click(cdp, '#search-form button');
    await waitUntil(cdp, `document.querySelector('#status')?.textContent === '搜索完成' && document.querySelector('#count')?.textContent === '共 1 条笔记'`, 'clear search');
    report.searchClear = await saveSnapshot(cdp, '06-search-clear');
    assert.deepEqual(report.searchClear.notes, report.created.notes);
    stage = 'search-late-response';
    await evaluate(cdp, `(() => { const original=window.fetch.bind(window); window.__race={held:false,released:false,release:null,original}; window.fetch=async (...args)=>{ const response=await original(...args); if(String(args[0]).endsWith('/api/notes?q=')&&!window.__race.held){ window.__race.held=true; await new Promise(resolve=>window.__race.release=resolve); window.__race.released=true; } return response; }; return true; })()`);
    await click(cdp, '#search-form button');
    await waitUntil(cdp, `window.__race?.held === true`, 'first real search response held by test');
    await fill(cdp, '#query', `absent-${marker}`);
    await click(cdp, '#search-form button');
    await waitUntil(cdp, `document.querySelector('#status')?.textContent === '搜索完成' && document.querySelector('#count')?.textContent === '没有匹配笔记'`, 'newer real search completed');
    await evaluate(cdp, `window.__race.release(); true`);
    await waitUntil(cdp, `window.__race?.released === true`, 'older real search response released');
    await pause(150);
    report.searchRace = await saveSnapshot(cdp, '06-search-late-response');
    assert.equal(report.searchRace.searchInput,`absent-${marker}`);
    assert.equal(report.searchRace.count,'没有匹配笔记','An older response must not replace the latest search');
    assert.equal(report.searchRace.notes.length,0);
    await evaluate(cdp, `window.fetch=window.__race.original; delete window.__race; true`);
    await fill(cdp, '#query', '');
    await click(cdp, '#search-form button');
    await waitUntil(cdp, `document.querySelector('#status')?.textContent === '搜索完成' && document.querySelector('#count')?.textContent === '共 1 条笔记'`, 'search recovered after late response');
    report.searchRaceRecovery=await saveSnapshot(cdp,'06-search-late-response-recovered');
    assert.deepEqual(report.searchRaceRecovery.notes,report.created.notes);
    stage = 'internal-error-recovery';
    const notesFile=path.join(launch.dataDir,'notes.json');
    const beforeFailure=await fs.readFile(notesFile);
    try {
      await fs.writeFile(notesFile,'FAKE_PASSWORD_DO_NOT_EXPOSE');
      await click(cdp, '#search-form button');
      await waitUntil(cdp, `document.querySelector('#status')?.textContent.startsWith('搜索未完成：')`, 'internal failure shown');
      report.internalError=await saveSnapshot(cdp,'internal-error');
      assert.ok(report.internalError.status.includes('暂时无法完成操作'));
      assert.ok(!/FAKE_PASSWORD|Unexpected|JSON|SyntaxError|stack/.test(report.internalError.status));
      assert.deepEqual(report.internalError.notes,report.created.notes);
    } finally {await fs.writeFile(notesFile,beforeFailure);}
    await click(cdp, '#search-form button');
    await waitUntil(cdp, `document.querySelector('#status')?.textContent === '搜索完成' && document.querySelector('#count')?.textContent === '共 1 条笔记'`, 'internal failure recovered with saved data');
    report.internalRecovery=await saveSnapshot(cdp,'internal-error-recovery');
    assert.deepEqual(report.internalRecovery.notes,report.created.notes);
    stage = 'offline-recovery';
    await cdp.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    try {
      await click(cdp, '#search-form button');
      await waitUntil(cdp, `document.querySelector('#status')?.textContent.startsWith('搜索未完成：')`, 'real offline request error');
      report.offlineSearch = await saveSnapshot(cdp, 'offline-search');
      assert.deepEqual(report.offlineSearch.notes, report.created.notes);
    } finally { await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }); }
    await click(cdp, '#search-form button');
    await waitUntil(cdp, `document.querySelector('#status')?.textContent === '搜索完成'`, 'recovered search');
    report.recoveredSearch = await saveSnapshot(cdp, 'recovered-search');
    assert.deepEqual(report.recoveredSearch.notes, report.created.notes);
    uiObservation('sample-recovery', report.recoveredSearch.notes[0].text, 'recovered-search.dom.json', ['input', 'click', 'wait', 'readback']);
    const data = JSON.parse(await fs.readFile(path.join(launch.dataDir, 'notes.json'), 'utf8'));
    assert(data.some(note => note.id === report.created.notes[0].id && note.text === marker), 'Browser result not present in persisted data');
    report.persistedData = { file: path.join(launch.dataDir, 'notes.json'), sha256: hash(await fs.readFile(path.join(launch.dataDir, 'notes.json'))), matchedNote: data.find(note => note.id === report.created.notes[0].id) };
    uiObservation('sample-persistence', report.persistedData.matchedNote?.text, 'report.json#persistedData', ['input', 'key', 'wait', 'readback']);
    stage = 'duplicate-submit';
    const duplicateText='重复点击仍只有一条';
    await fill(cdp,'#note',duplicateText);
    await evaluate(cdp, `(() => {const original=window.fetch.bind(window);window.__dup={original,postCount:0,held:false,release:null};window.fetch=async(...args)=>{if(args[1]?.method==='POST'){window.__dup.postCount++;const response=await original(...args);if(window.__dup.postCount===1){window.__dup.held=true;await new Promise(resolve=>window.__dup.release=resolve);}return response;}return original(...args);};return true;})()`);
    await click(cdp,'#create-form button');
    await waitUntil(cdp,`window.__dup?.held===true && document.querySelector('#create-form button').disabled`,'first save held after real write');
    await click(cdp,'#create-form button');
    assert.equal(await evaluate(cdp,'window.__dup.postCount'),1);
    await evaluate(cdp,'window.__dup.release(); true');
    await waitUntil(cdp,`document.querySelector('#status')?.textContent==='已保存并读回笔记'`,'single save confirmed');
    report.duplicateSubmit=await saveSnapshot(cdp,'duplicate-submit');
    assert.equal(report.duplicateSubmit.notes.filter(item=>item.text===duplicateText).length,1);
    await evaluate(cdp,'window.fetch=window.__dup.original;delete window.__dup;true');
    stage = 'unknown-save-and-retry';
    const unknownText='断线重试只留一条';
    await fill(cdp,'#note',unknownText);
    await cdp.send('Network.emulateNetworkConditions',{offline:true,latency:0,downloadThroughput:-1,uploadThroughput:-1});
    await click(cdp,'#create-form button');
    await waitUntil(cdp,`document.querySelector('#status')?.textContent.startsWith('保存结果暂时无法确认')`,'offline save remains unknown');
    report.unknownSave=await saveSnapshot(cdp,'unknown-save');
    assert.equal(report.unknownSave.noteInput,unknownText);
    assert.equal(report.unknownSave.notes.filter(item=>item.text===unknownText).length,0);
    await cdp.send('Network.emulateNetworkConditions',{offline:false,latency:0,downloadThroughput:-1,uploadThroughput:-1});
    await click(cdp,'#create-form button');
    await waitUntil(cdp,`document.querySelector('#status')?.textContent==='已保存并读回笔记'`,'retry confirmed');
    report.unknownRecovered=await saveSnapshot(cdp,'unknown-save-recovered');
    assert.equal(report.unknownRecovered.notes.filter(item=>item.text===unknownText).length,1);
    stage = 'lost-response-readback';
    const lostText='响应丢失但服务器已保存';
    await fill(cdp,'#note',lostText);
    await evaluate(cdp,`(() => {const original=window.fetch.bind(window);window.__lost={original,postCount:0};window.fetch=async(...args)=>{const response=await original(...args);if(args[1]?.method==='POST'&&++window.__lost.postCount===1)throw TypeError('Injected response loss');return response;};return true;})()`);
    await click(cdp,'#create-form button');
    await waitUntil(cdp,`document.querySelector('#status')?.textContent==='已保存并读回笔记'`,'lost response resolved by real GET');
    report.lostResponse=await saveSnapshot(cdp,'lost-response-readback');
    assert.equal(report.lostResponse.notes.filter(item=>item.text===lostText).length,1);
    assert.equal(await evaluate(cdp,'window.__lost.postCount'),1);
    await evaluate(cdp,'window.fetch=window.__lost.original;delete window.__lost;true');
    const guarded=JSON.parse(await fs.readFile(path.join(launch.dataDir,'notes.json'),'utf8'));
    for(const value of [duplicateText,unknownText,lostText])assert.equal(guarded.filter(item=>item.text===value).length,1);
    report.guardedWrites={texts:[duplicateText,unknownText,lostText],count:guarded.length,file:path.join(launch.dataDir,'notes.json')};
    stage = 'long-text-and-concurrent-readback';
    const longText='长中文笔记'.repeat(300);
    await fill(cdp,'#note',longText);
    await click(cdp,'#create-form button');
    await waitUntil(cdp,`document.querySelector('#status')?.textContent==='已保存并读回笔记'`,'long note saved');
    report.longText=await saveSnapshot(cdp,'long-note');
    assert.equal(report.longText.notes.at(-1)?.text,longText);
    report.visual.longText=await visual(cdp,'visual-long-note',{width:360,height:1000});
    assert.equal(report.visual.longText.status,'passed');
    const parallelTexts=Array.from({length:6},(_,i)=>`并发页面读回 ${i}`);
    const parallel=await Promise.all(parallelTexts.map(text=>fetch(`${launch.url}/api/notes`,{method:'POST',headers:{'content-type':'application/json','idempotency-key':crypto.randomUUID()},body:JSON.stringify({text})})));
    assert(parallel.every(response=>response.status===201));
    const parallelCreated=await Promise.all(parallel.map(response=>response.json()));
    await cdp.send('Page.reload',{ignoreCache:true});
    await waitUntil(cdp,`document.querySelector('#status')?.textContent==='笔记已加载' && [...document.querySelectorAll('#notes li')].filter(li=>li.textContent.startsWith('并发页面读回')).length===6`,'concurrent notes visible after reload');
    report.concurrent=await saveSnapshot(cdp,'concurrent-reloaded');
    const concurrentFile=JSON.parse(await fs.readFile(path.join(launch.dataDir,'notes.json'),'utf8'));
    for(const item of parallelCreated)assert(concurrentFile.some(note=>note.id===item.note.id&&note.text===item.note.text));
    assert.equal(new Set(parallelCreated.map(item=>item.note.id)).size,6);
    report.concurrentReadback={requested:6,persisted:parallelTexts.filter(text=>concurrentFile.some(note=>note.text===text)).length,
      visible:parallelTexts.filter(text=>report.concurrent.notes.some(note=>note.text===text)).length,uniqueIds:new Set(parallelCreated.map(item=>item.note.id)).size};
    report.stages.push('browser_input', 'save_readback', 'reload_readback', 'match_search', 'absent_search', 'clear_search', 'late_response_isolation', 'data_readback');
    report.stages.push('duplicate_submit_guard','unknown_result_retained_and_retried','lost_response_resolved_by_readback');
    report.stages.push('long_chinese_text_unclipped','parallel_create_restart_readback');
    stage = 'cli';
    const cli = await command('verify-cli');
    assert.equal(cli.instance.instanceId, launch.instanceId);
    assert.equal(cli.instance.pid, launch.pid);
    assert.equal(cli.instance.dataDir, launch.dataDir);
    const cliByTarget = new Map(cli.observations.map(item => [item.targetId, item.actual]));
    const cliCreate = cliByTarget.get('cli-create');
    assert.equal(cliCreate.note.text, cliCreate.input);
    assert.equal(cliCreate.readback.text, cliCreate.input);
    assert.equal(cliCreate.readback.id, cliCreate.note.id);
    assert.equal(cliByTarget.get('cli-list').matchedText, cliCreate.input);
    assert.equal(cliByTarget.get('cli-search').matchedText, cliCreate.input);
    assert.equal(cliByTarget.get('cli-search').count, 1);
    assert.equal(cliByTarget.get('cli-search-empty').count, 0);
    assert.equal(cliByTarget.get('cli-search-clear').matchedText, cliCreate.input);
    const dry = cliByTarget.get('cli-dry-run');
    assert.equal(dry.dry.dryRun, true);
    assert.equal(dry.dry.wouldCreate.text, dry.input);
    assert.equal(dry.before, dry.after);
    report.cli = cli;
    report.stages.push('cli_create_readback', 'cli_list', 'cli_search_match', 'cli_search_absent', 'cli_search_clear', 'cli_dry_run_hash');
    const target = (entrypointId, targetId, actual, rawRef) => ({ entrypointId, targetId, actual, rawRef, passed: true });
    report.targetResults = [
      target('ui-create', 'ui-create-empty', { error: report.emptyCreate.status }, '01-empty-create.dom.json'),
      target('ui-create', 'ui-create-invalid-retained', {input:report.invalidRetained.noteInput,error:report.invalidRetained.noteError,invalid:report.invalidRetained.noteInvalid,focused:report.invalidRetained.focusedNote}, '01-invalid-retained.dom.json'),
      target('ui-create', 'ui-create', { savedText: report.created.notes[0].text, reloadedText: report.reloaded.notes[0].text }, '02-created.dom.json; 03-reloaded.dom.json'),
      target('ui-create', 'ui-create-duplicate', {text:duplicateText,visible:report.duplicateSubmit.notes.filter(item=>item.text===duplicateText).length,postCount:1}, 'duplicate-submit.dom.json'),
      target('ui-create', 'ui-create-unknown', {input:report.unknownSave.noteInput,status:report.unknownSave.status,visible:report.unknownSave.notes.filter(item=>item.text===unknownText).length}, 'unknown-save.dom.json'),
      target('ui-create', 'ui-create-unknown-retry', {text:unknownText,visible:report.unknownRecovered.notes.filter(item=>item.text===unknownText).length}, 'unknown-save-recovered.dom.json'),
      target('ui-create', 'ui-create-lost-response', {text:lostText,visible:report.lostResponse.notes.filter(item=>item.text===lostText).length,postCount:1}, 'lost-response-readback.dom.json'),
      target('ui-create', 'ui-create-long-text', {input:longText,rendered:report.longText.notes.at(-1).text,unclipped:report.visual.longText.status==='passed'}, 'long-note.dom.json; visual-long-note.visual.json'),
      target('ui-create', 'ui-create-concurrent', report.concurrentReadback, 'concurrent-reloaded.dom.json'),
      target('ui-create', 'ui-layout-review', {desktop:report.visual.desktop.status,narrow:report.visual.narrow.status,restored:report.visual.obstructionRestored.status,
        obstructionDetected:report.visual.badObstruction.issues.some(item=>item.code==='control_obstructed')}, 'visual-desktop-correct.visual.json; visual-narrow-correct.visual.json; visual-button-obstruction-fault.visual.json'),
      target('ui-search', 'ui-search', { matchedText: report.searchMatch.notes[0].text }, '04-search-match.dom.json'),
      target('ui-search', 'ui-error-meanings', {input:report.invalidRetained.status,internal:report.internalError.status,offline:report.offlineSearch.status,unknown:report.unknownSave.status}, '01-invalid-retained.dom.json; internal-error.dom.json; offline-search.dom.json; unknown-save.dom.json'),
      target('ui-search', 'ui-search-empty', { message: report.searchAbsent.count }, '05-search-absent.dom.json'),
      target('ui-search', 'ui-search-clear', { containsSavedText: report.searchClear.notes[0].text }, '06-search-clear.dom.json'),
      target('ui-search', 'ui-search-late-response', { submittedQuery:`absent-${marker}`, query:report.searchRace.searchInput, count:report.searchRace.count, notes:report.searchRace.notes, olderResponseReleased:true }, '06-search-late-response.dom.json'),
      ...cli.observations.map(item => target(item.entrypointId, item.targetId, item.actual, cli.artifact.path))
    ];
    assert.equal(report.targetResults.length, 21);
    stage = 'restart';
    const beforeRestart = hash(await fs.readFile(path.join(launch.dataDir, 'notes.json')));
    const firstCleanup = await command('cleanup');
    assert.equal(firstCleanup.instanceId, launch.instanceId);
    launched = null;
    await waitForStop(launch.url);
    const secondLaunch = await command('launch', '--port', '0', '--data-dir', dataDir);
    launched = secondLaunch.instanceId;
    activeUrl = secondLaunch.url;
    const secondDoctor = await command('doctor');
    assert.notEqual(secondLaunch.instanceId, launch.instanceId);
    assert.equal(secondLaunch.dataDir, launch.dataDir);
    assert.equal(secondDoctor.instanceId, secondLaunch.instanceId);
    assert.equal(secondDoctor.pid, secondLaunch.pid);
    const afterRestart = hash(await fs.readFile(path.join(secondLaunch.dataDir, 'notes.json')));
    assert.equal(afterRestart, beforeRestart);
    const restartedList = await command('list');
    assert(restartedList.notes.some(note => note.id === report.created.notes[0].id && note.text === marker));
    assert(restartedList.notes.some(note => note.id === cliCreate.note.id && note.text === cliCreate.input));
    for(const item of parallelCreated)assert(restartedList.notes.some(note=>note.id===item.note.id&&note.text===item.note.text));
    await cdp.send('Page.navigate', { url: secondLaunch.url });
    await waitUntil(cdp, `document.readyState === 'complete' && document.querySelector('#status')?.textContent === '笔记已加载' && [...document.querySelectorAll('#notes li')].some(el => el.textContent === ${JSON.stringify(marker)})`, 'browser note after service restart');
    const restartedPage = await saveSnapshot(cdp, '07-restarted');
    assert(restartedPage.notes.some(note => note.id === report.created.notes[0].id && note.text === marker));
    assert(restartedPage.notes.some(note => note.id === cliCreate.note.id && note.text === cliCreate.input));
    for(const item of parallelCreated)assert(restartedPage.notes.some(note=>note.id===item.note.id&&note.text===item.note.text));
    report.concurrentReadback.restartVisible=parallelCreated.filter(item=>restartedPage.notes.some(note=>note.id===item.note.id)).length;
    report.restart = { firstCleanup, secondLaunch, secondDoctor, beforeRestart, afterRestart, restartedList, restartedPage };
    report.stages.push('first_cleanup', 'same_data_dir_restart', 'second_doctor', 'cli_restart_readback', 'browser_restart_readback');
    report.businessStatus = 'verified';
    report.uiQuality = { ...assessUIQualityCoverage(uiConfig, uiObservations), runtimeAssessments,
      sourceCheckStatus: report.sourceCheck.status, observedBusinessScope: 'Existing 11 targets, late-response search and restart readback' };
    await fs.writeFile(path.join(output, 'ui-quality-observations.json'), `${JSON.stringify({ config: uiConfig, observations: uiObservations, assessment: report.uiQuality }, null, 2)}\n`);
    report.verifiedScope = 'Existing 11 business targets, late-response search and restart; UI quality status and gaps are reported separately';
    report.status = runtimeAssessments.some(item => item.status === 'failed') || report.sourceCheck.status === 'failed' || report.uiQuality.status === 'failed' ? 'failed' : 'verified';
    if (report.status === 'failed') process.exitCode = 1;
  } catch (error) {
    if (cdp) {
      try {
        report.failureView = await saveSnapshot(cdp, 'failure-current');
        report.failureKeyboardEvents = await evaluate(cdp, 'window.keyboardEvents ?? []');
        await fs.writeFile(path.join(output, 'failure-keyboard-events.json'), `${JSON.stringify(report.failureKeyboardEvents, null, 2)}\n`);
      } catch (captureError) { report.failureCaptureError = captureError.message; }
    }
    report.status = 'failed';
    report.failure = { stage, message: error.message, browserStderr: stderr };
    process.exitCode = 1;
  } finally {
    cdp?.close();
    if (launched) {
      try {
        report.cleanup = await command('cleanup');
        await waitForStop(activeUrl);
        let stopped = false;
        for (let attempt = 0; attempt < 50; attempt++) {
          try { process.kill(report.cleanup.stoppedPid, 0); }
          catch (error) { if (error.code === 'ESRCH') { stopped = true; break; } throw error; }
          await pause(100);
        }
        assert(stopped, 'Cleaned instance process still exists');
        report.cleanup.processExited = true;
        report.cleanup.healthStopped = true;
        report.stages.push('cleanup');
      }
      catch (error) { report.cleanupFailure = error.message; report.status = 'failed'; process.exitCode = 1; }
    }
    if (browser && browser.exitCode === null) {
      browser.kill();
      await Promise.race([new Promise(resolve => browser.once('exit', resolve)), pause(3000)]);
    }
    if (profileDir) {
      assert(path.resolve(profileDir).startsWith(path.resolve(os.tmpdir()) + path.sep), 'Refusing to remove browser profile outside temp');
      for (let attempt = 0; attempt < 10; attempt++) {
        try { await fs.rm(profileDir, { recursive: true, force: true }); break; }
        catch (error) {
          if (error.code !== 'EBUSY' && error.code !== 'EPERM') { report.browserProfileCleanupFailure = error.message; break; }
          if (attempt === 9) report.browserProfileCleanupFailure = error.message;
          else await pause(500);
        }
      }
    }
    report.sourcePreservedAfterCleanup = [];
    for (const item of sourceFiles) {
      const actual = hash(await fs.readFile(item.file));
      report.sourcePreservedAfterCleanup.push({ file: item.file, sha256: actual, unchanged: actual === item.sha256 });
      if (actual !== item.sha256) { report.status = 'failed'; report.sourceFailure = 'Source changed while this run was executing'; process.exitCode = 1; }
    }
    await fs.writeFile(path.join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
    const files = (await fs.readdir(output)).filter(name => name !== 'manifest.json');
    const manifest = { runId, projectId: report.projectId, instanceId: launched, status: report.status, files: [] };
    for (const name of files) { const bytes = await fs.readFile(path.join(output, name)); manifest.files.push({ path: name, bytes: bytes.length, sha256: hash(bytes) }); }
    await fs.writeFile(path.join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    // Read the persisted evidence after cleanup, when its preservation matters most.
    for (const file of manifest.files) assert.equal(hash(await fs.readFile(path.join(output, file.path))), file.sha256);
    console.log(JSON.stringify({ status: report.status, runId, evidence: output, instanceId: launched, stages: report.stages, failure: report.failure, cleanupFailure: report.cleanupFailure }));
  }
}

await main();
