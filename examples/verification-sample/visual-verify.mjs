import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assessVisualSnapshot } from '../../src/visual-check.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const supplied = process.argv[2];
assert(supplied, 'Provide the saved UI driver evidence directory');
const directory = path.resolve(supplied);
assert(directory.startsWith(path.join(root, 'evidence') + path.sep), 'UI evidence must stay in this sample');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const read = async name => JSON.parse(await fs.readFile(path.join(directory, name), 'utf8'));
const manifest = await read('manifest.json');
const names = (await fs.readdir(directory)).filter(name => name !== 'manifest.json').sort();
assert.deepEqual(names, manifest.files.map(item => item.path).sort());
for (const item of manifest.files) {
  const bytes = await fs.readFile(path.join(directory, item.path));
  assert.equal(bytes.length, item.bytes); assert.equal(hash(bytes), item.sha256);
}
const report = await read('report.json');
assert.equal(report.status, 'verified');
assert.equal(report.targetResults.length, 11); assert(report.targetResults.every(result => result.passed));
const results = [];
for (const name of names.filter(name => name.endsWith('.visual.json'))) {
  const saved = await read(name), derived = assessVisualSnapshot(saved.snapshot, saved.constraints);
  assert.deepEqual(derived, saved.assessment);
  assert(manifest.files.some(item => item.path === name.replace('.visual.json', '.png')));
  results.push({ file: name, status: derived.status, issues: derived.issues.map(issue => issue.code) });
}
assert(results.some(item => item.file.includes('overflow-fault') && item.issues.includes('horizontal_overflow')));
assert(results.some(item => item.file.includes('obstruction-fault') && item.issues.includes('control_obstructed')));
assert(results.filter(item => !item.file.includes('fault')).every(item => item.status === 'passed'));
const plan = await read('effect-plan-before-execution.json');
assert.equal(plan.beforeExecution, true);
assert(new Date(plan.createdAt) < new Date(report.instance.startedAt));
const fail = await read('effect-failing-original-click.json'), pass = await read('effect-passing-original-click.json');
assert(fail.events.some(event => event.target === 'visual-button-fault'));
assert(!fail.events.some(event => event.type === 'submit'));
assert(pass.events.some(event => event.type === 'submit'));
assert(pass.actual.status.includes('请输入 1–2000 字的笔记正文'));
assert.equal(report.cleanup.processExited, true); assert.equal(report.cleanup.healthStopped, true);
assert.equal(report.restart.beforeRestart, report.restart.afterRestart);
for (const source of report.sourceFiles) {
  assert.equal(hash(await fs.readFile(path.join(directory, source.snapshot))), source.sha256);
  assert.equal(hash(await fs.readFile(source.file)), source.sha256);
}
const persisted = await fs.readFile(path.join(report.restart.secondLaunch.dataDir, 'notes.json'));
assert.equal(hash(persisted), report.restart.afterRestart);
for (const note of report.restart.restartedPage.notes) assert(JSON.parse(persisted).some(item => item.id === note.id && item.text === note.text));
const externalReceipts = [report.instance.artifact, report.cli.artifact, report.restart.firstCleanup.artifact, report.restart.secondLaunch.artifact, report.cleanup.artifact];
for (const receipt of externalReceipts) assert.equal(hash(await fs.readFile(path.join(root, receipt.path))), receipt.sha256);
console.log(JSON.stringify({ status: 'verified_existing_visual_and_business_evidence', directory, rawFiles: manifest.files.length,
  sourceSnapshots: report.sourceFiles.length, externalReceipts: externalReceipts.length, visualResults: results, businessTargets: 11,
  persistedNotes: report.restart.restartedPage.notes.length, rawOriginalsUnchanged: true, noRecapture: true,
  limits: 'Independent read-only reduction and hash review; visual style still requires screenshot inspection. Temporary fault exercise does not backfill old product history.' }));
