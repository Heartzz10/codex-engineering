import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadProfile } from '../../src/profile.mjs';
import { readMap } from '../../src/feature-store.mjs';
import { recordAcceptance } from '../../src/feature.mjs';

const profile = await loadProfile(path.resolve('examples/verification-sample/profile.json'));
const relative = process.argv[2];
const runId = process.argv[3];
const changeId = process.argv[4];
const selectedAcIds = process.argv[5] ? [process.argv[5]] : ['AC-0001','AC-0002'];
if(selectedAcIds.some(id=>!/^AC-\d{4}$/.test(id)))throw Error('Acceptance criterion ID required');
if (!/^evidence\/ui-observations-[\w-]+\.json$/.test(relative || '') || !runId || !changeId) {
  throw new Error('Usage: import-ui-evidence.mjs evidence/ui-observations-*.json RUN_ID CHANGE_ID');
}
const bytes = await fs.readFile(path.join(profile.root, relative));
const report = JSON.parse(bytes);
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
if (report.projectId !== profile.id || !Array.isArray(report.observations) || !report.attestation?.sourceRef) throw new Error('Invalid attributed UI observation report');
if (!/^evidence\/ui-driver-[\w-]+\/report\.json$/.test(report.driverReportRef || '')) throw new Error('Raw UI driver report required');
const driverBytes = await fs.readFile(path.join(profile.root, report.driverReportRef));
const driverReport = JSON.parse(driverBytes);
const qualityRef = report.driverReportRef.replace(/report\.json$/, 'ui-quality-observations.json');
const qualityBytes = profile.uiQuality ? await fs.readFile(path.join(profile.root, qualityRef)) : null;
const quality = qualityBytes ? JSON.parse(qualityBytes) : null;
if (quality && JSON.stringify(quality.config) !== JSON.stringify(profile.uiQuality)) throw new Error('UI quality configuration differs from actual driver run');
if (driverReport.status !== 'verified' || driverReport.projectId !== profile.id || driverReport.runId !== runId || driverReport.instance?.instanceId !== report.instanceId) {
  throw new Error('UI driver report identity mismatch');
}
for (const observed of report.observations) {
  const raw = driverReport.targetResults?.filter(target => target.targetId === observed.targetId && target.entrypointId === observed.entrypointId);
  const actual = {...observed.actual};
  delete actual.visualLayoutSafe;
  const layoutResults = quality?.assessment?.results?.filter(item => item.method === 'measurement') || [];
  const layoutSafe = layoutResults.length > 0 && layoutResults.every(item => item.status === 'passed');
  if (raw?.length !== 1 || !raw[0].passed || JSON.stringify(raw[0].actual) !== JSON.stringify(actual) ||
      (observed.actual?.visualLayoutSafe !== undefined && (observed.actual.visualLayoutSafe !== true || !layoutSafe))) {
    throw new Error(`UI observation differs from raw driver result: ${observed.targetId}`);
  }
}

for (const acId of selectedAcIds) {
  const map = await readMap(profile);
  const ac = map.acceptanceCriteria.find(a => a.id === acId);
  if (ac.verificationMethod !== 'ui') throw new Error(`Only actual UI observations supported: ${acId}`);
  const observations = ac.requiredTargets.map(target => {
    const matches = report.observations.filter(o => o.targetId === target.targetId && o.entrypointId === target.entrypointId);
    if (matches.length !== 1 || !matches[0].actual) throw new Error(`Missing or duplicate actual observation: ${target.targetId}`);
    return {
      ...matches[0], roleRef: target.roleRef,
      environmentRef: target.environmentRef, dataScopeRef: target.dataScopeRef
    };
  });
  const implementationFingerprint = [];
  for (const relative of [...new Set([...ac.implementationRefs.map(ref=>ref.path), ...(profile.uiQualityRef?[profile.uiQualityRef]:[])])]) implementationFingerprint.push({ path: relative, sha256: hash(await fs.readFile(path.join(profile.root, relative))) });
  const receipt = {
    projectId: profile.id, acId, acRevision: ac.revision, runId,
    method: 'ui', observationSource: 'manual_attestation',
    executedAt: report.executedAt, implementationFingerprint,
    attestation: report.attestation, browser: report.browser,
    instanceId: report.instanceId, url: report.url, observations,
    ...(quality ? {uiQualityObservations: quality.observations.filter(item=>item.acId===acId)} : {})
  };
  const receiptPath = `evidence/${runId}-${acId}-${crypto.randomUUID()}.json`;
  const receiptBytes = JSON.stringify(receipt, null, 2);
  await fs.writeFile(path.join(profile.root, receiptPath), receiptBytes, { flag: 'wx' });
  const layoutRefs = [...new Set((quality?.observations || [])
    .filter(item => item.method === 'measurement')
    .map(item => item.evidenceRef)
    .filter(ref => typeof ref === 'string' && /^[\w-]+\.visual\.json$/.test(ref)))];
  if (profile.uiQuality && !layoutRefs.length) throw new Error(`No actual layout measurements for ${acId}`);
  const layoutEvidence = [];
  for (const ref of layoutRefs) {
    const measuredRef = report.driverReportRef.replace(/report\.json$/, ref);
    const measuredBytes = await fs.readFile(path.join(profile.root, measuredRef));
    layoutEvidence.push({path: measuredRef, sha256: hash(measuredBytes), type: 'layout-measurement'});
  }
  const evidence = {
    ...receipt, featureId: ac.featureId, targetIds: ac.requiredTargets.map(t => t.targetId), changeId,
    environmentRef: report.environmentRef, roleRef: report.roleRef, dataScopeRef: report.dataScopeRef,
    rawEvidence: [
      { path: receiptPath, sha256: hash(receiptBytes), type: 'execution' },
      ...layoutEvidence,
      { path: relative, sha256: hash(bytes), type: 'browser-observation' },
      { path: report.driverReportRef, sha256: hash(driverBytes), type: 'browser-driver-report' }
      , ...(quality ? [{path:qualityRef,sha256:hash(qualityBytes),type:'ui-quality-original'}] : [])
    ],
    sourceRef: report.attestation.sourceRef,
    recordedBy: report.attestation.by, createdAt: new Date().toISOString()
  };
  delete evidence.observations;
  console.log(JSON.stringify(await recordAcceptance(profile, evidence, {
    expectedRevision: map.revision, expectedHash: map.contentHash,
    requestId: `${runId}-${acId}-${hash(bytes).slice(0, 12)}`
  })));
}
