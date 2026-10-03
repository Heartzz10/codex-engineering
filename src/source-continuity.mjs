import { diffSourceSnapshots, sourceSnapshot } from './source-diff.mjs';

// Read-only view across historical scope changes. A fresh baseline or an empty
// continuation diff never certifies older implementation or acceptance.
export async function sourceContinuity(profile, map) {
  const current = await sourceSnapshot(profile);
  const observations = new Map([[JSON.stringify(current.inputs), current]]);
  const changes = [];
  for (const change of map.changes || []) {
    const baseline = change.sourceBaseline;
    if (!baseline) {
      changes.push({ changeId: change.id, status: change.status, gap: 'source_baseline_missing' });
      continue;
    }
    const scopeKey = JSON.stringify(baseline.inputs);
    if (!observations.has(scopeKey)) observations.set(scopeKey, await sourceSnapshot({ ...profile, sourceScopes: baseline.inputs }));
    const observed = diffSourceSnapshots(baseline, observations.get(scopeKey));
    changes.push({ changeId: change.id, status: change.status, sourceRef: change.sourceRef,
      baselineHash: baseline.hash, baselineInputs: baseline.inputs,
      expandedInputs: current.inputs.filter(input => !baseline.inputs.includes(input)),
      originalScopeDiffCount: observed.changes.length, originalScopeDiff: observed.changes,
      currentOriginalScopeHash: observed.currentHash,
      impactRegistered: Boolean(change.impactReport),
      acceptanceClosed: change.status === 'closed' });
  }
  const unresolved = changes.filter(change => change.status !== 'closed' && change.status !== 'cancelled');
  const currentScopeChangeIds = changes.filter(change => change.baselineInputs &&
    JSON.stringify(change.baselineInputs) === JSON.stringify(current.inputs)).map(change => change.changeId);
  const latestClosed = [...(map.changes || [])].reverse().find(change =>
    change.status === 'closed' && currentScopeChangeIds.includes(change.id));
  const closedHash = latestClosed?.impactReport?.observation?.currentHash || null;
  const currentScopeReview = { closedChangeId: latestClosed?.id || null, recordedHash: closedHash,
    status: !latestClosed ? 'not_closed' : !closedHash ? 'missing_close_hash' : closedHash === current.hash ? 'current' : 'drifted' };
  const currentScopeClosed = Boolean(latestClosed);
  return { status: unresolved.length || changes.some(change => change.gap) || currentScopeReview.status !== 'current' ? 'needs_review' : 'history_reviewed',
    projectId: profile.id, mapRevision: map.revision, mapHash: map.contentHash,
    currentScope: { inputs: current.inputs, fileCount: Object.keys(current.files).length, hash: current.hash },
    changes, unresolvedChangeIds: unresolved.map(change => change.changeId), currentScopeChangeIds, currentScopeClosed, currentScopeReview,
    rule: 'An empty new-scope diff does not erase earlier diffs, change history, missing impact registration or unaccepted targets. Review every unresolved change and current business acceptance.' };
}
