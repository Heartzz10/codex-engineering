import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadProfile } from '../../src/profile.mjs';
import { readMap } from '../../src/feature-store.mjs';
import { recordAcceptance } from '../../src/feature.mjs';

const profile = await loadProfile(path.resolve('examples/verification-sample/profile.json'));
const relative = process.argv[2];
if (!/^evidence\/cli-observations-[\w-]+\.json$/.test(relative || '')) throw new Error('Explicit CLI observation artifact required');
const bytes = await fs.readFile(path.join(profile.root, relative));
const report = JSON.parse(bytes);
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
if (report.projectId !== profile.id || !Array.isArray(report.observations) || !report.instance?.instanceId) throw new Error('Invalid CLI observation report');
const runId = process.argv[3];
const changeId = process.argv[4];
if (!runId || !changeId) throw new Error('Usage: import-cli-evidence.mjs evidence/cli-observations-*.json RUN_ID CHANGE_ID');

for (const acId of ['AC-0003', 'AC-0004', 'AC-0005', 'AC-0006']) {
  const map = await readMap(profile);
  const ac = map.acceptanceCriteria.find(a => a.id === acId);
  if (ac.verificationMethod !== 'cli') throw new Error(`Only actual CLI observations supported: ${acId}`);
  const observations = ac.requiredTargets.map(target => {
    const matches = report.observations.filter(o => o.targetId === target.targetId && o.entrypointId === target.entrypointId);
    if (matches.length !== 1 || !matches[0].actual) throw new Error(`Missing or duplicate actual observation: ${target.targetId}`);
    return {
      targetId: target.targetId, entrypointId: target.entrypointId,
      roleRef: target.roleRef, environmentRef: target.environmentRef, dataScopeRef: target.dataScopeRef,
      actions: [
        { type: 'invoke', description: `driver.mjs verify-cli invoked ${target.entrypointId} against ${report.instance.url}` },
        { type: 'observe', description: `Captured service result for ${target.targetId} in ${relative}` }
      ],
      actual: matches[0].actual
    };
  });
  const implementationFingerprint = [];
  for (const relative of [...new Set([...ac.implementationRefs.map(ref=>ref.path), ...(profile.uiQualityRef?[profile.uiQualityRef]:[])])]) implementationFingerprint.push({ path: relative, sha256: hash(await fs.readFile(path.join(profile.root, relative))) });
  const receipt = {
    projectId: profile.id, acId, acRevision: ac.revision, runId, method: 'cli',
    observationSource: 'tool_receipt', executedAt: report.executedAt,
    implementationFingerprint, instance: report.instance, observations
  };
  const receiptPath = `evidence/${runId}-${acId}-${crypto.randomUUID()}.json`;
  const receiptBytes = JSON.stringify(receipt, null, 2);
  await fs.writeFile(path.join(profile.root, receiptPath), receiptBytes, { flag: 'wx' });
  const evidence = {
    ...receipt, featureId: ac.featureId, targetIds: ac.requiredTargets.map(t => t.targetId), changeId,
    environmentRef: 'isolated-loopback', roleRef: 'sample-user', dataScopeRef: 'sample-only',
    rawEvidence: [
      { path: receiptPath, sha256: hash(receiptBytes), type: 'execution' },
      { path: relative, sha256: hash(bytes), type: 'driver-report' }
    ],
    sourceRef: `local-tool:node-driver-verify-cli:${relative}`,
    recordedBy: 'codex-agent', createdAt: new Date().toISOString()
  };
  delete evidence.observations;
  console.log(JSON.stringify(await recordAcceptance(profile, evidence, {
    expectedRevision: map.revision, expectedHash: map.contentHash,
    requestId: `${runId}-${acId}-${hash(bytes).slice(0, 12)}`
  })));
}
