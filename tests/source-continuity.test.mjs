import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sourceSnapshot } from '../src/source-diff.mjs';
import { sourceContinuity } from '../src/source-continuity.mjs';

test('expanded scope exposes prior changes even when a newer baseline has empty diff', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ce-continuity-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'old.txt'), 'before');
  const oldProfile = { id: 'isolated', root, sourceScopes: ['old.txt'] };
  const old = await sourceSnapshot(oldProfile);
  await fs.writeFile(path.join(root, 'old.txt'), 'after');
  await fs.writeFile(path.join(root, 'new.txt'), 'new asset');
  const expandedProfile = { ...oldProfile, sourceScopes: ['old.txt', 'new.txt'] };
  const fresh = await sourceSnapshot(expandedProfile);
  const map = { revision: 2, contentHash: 'recorded-history', changes: [
    { id: 'CHG-0001', status: 'implemented_pending_verification', sourceRef: 'original-task', sourceBaseline: old },
    { id: 'CHG-0002', status: 'open', sourceRef: 'continuation', sourceBaseline: fresh }
  ] };
  const report = await sourceContinuity(expandedProfile, map);
  assert.equal(report.status, 'needs_review');
  assert.deepEqual(report.unresolvedChangeIds, ['CHG-0001', 'CHG-0002']);
  assert.equal(report.changes[0].originalScopeDiffCount, 1);
  assert.deepEqual(report.changes[0].expandedInputs, ['new.txt']);
  assert.equal(report.changes[1].originalScopeDiffCount, 0);
  assert.equal(report.changes[0].status, 'implemented_pending_verification');
});

test('closed change does not cover source drift introduced after acceptance', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ce-continuity-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'app.txt');
  const profile = { id: 'isolated', root, sourceScopes: ['app.txt'] };
  await fs.writeFile(file, 'before');
  const baseline = await sourceSnapshot(profile);
  await fs.writeFile(file, 'accepted implementation');
  const accepted = await sourceSnapshot(profile);
  const map = { revision: 1, contentHash: 'recorded-history', changes: [
    { id: 'CHG-0001', status: 'closed', sourceRef: 'accepted-task', sourceBaseline: baseline,
      impactReport: { status: 'impact_resolved', observation: { currentHash: accepted.hash } } }
  ] };
  const acceptedReport = await sourceContinuity(profile, map);
  assert.equal(acceptedReport.status, 'history_reviewed');

  await fs.writeFile(file, 'unregistered later change');
  const driftedReport = await sourceContinuity(profile, map);
  assert.equal(driftedReport.status, 'needs_review');
  assert.equal(driftedReport.currentScopeReview.status, 'drifted');
  assert.equal(driftedReport.currentScopeReview.closedChangeId, 'CHG-0001');
  assert.equal(driftedReport.unresolvedChangeIds.length, 0);
});
