import { assert } from './paths.mjs';
import { transact, canonicalize, readMap } from './feature-store.mjs';

const collections = { requirements: 'REQ', features: 'FEAT', acceptanceCriteria: 'AC', changes: 'CHG', evidence: 'EVD', iterations: 'ITER' };
const contractFields = ['featureId','requirementIds','preconditions','actions','expected','verificationMethod','effects','requiredEvidenceTypes','dependencyRefs','requiredTargets','assertions'];
const present = v => typeof v === 'string' && v.trim().length > 0;
const nonempty = (v, name) => assert(present(v), `${name} required`);
const array = (v, name) => assert(Array.isArray(v), `${name} must be array`);
const changed = (a, b) => canonicalize(a ?? null) !== canonicalize(b ?? null);
const refs = list => (list || []).map(x => typeof x === 'string' ? x : x.path).filter(Boolean);
const touches = (file, ref) => file === ref || file.startsWith(ref.replace(/\/$/, '') + '/');

export function allocateId(map, collection) {
  const prefix = collections[collection]; assert(prefix, 'unknown_entity');
  return `${prefix}-${String(Math.max(0, ...map[collection].map(e => Number(e.id.slice(prefix.length + 1)))) + 1).padStart(4, '0')}`;
}
function hasReferences(values, table, field) {
  array(values, field); assert(new Set(values).size === values.length, `duplicate ${field}`);
  for (const value of values) assert(table.has(value), `${field}: missing reference ${value}`);
}
export function validateMap(map, before = null) {
  assert(map.schemaVersion === 1 && Number.isInteger(map.revision) && map.revision > 0, 'Invalid map version');
  const tables = {};
  for (const [name, prefix] of Object.entries(collections)) {
    array(map[name], name); tables[name] = new Map();
    for (const e of map[name]) {
      assert(new RegExp(`^${prefix}-[0-9]{4,}$`).test(e.id) && !tables[name].has(e.id), `Invalid or duplicate ${name} ID`);
      tables[name].set(e.id, e); nonempty(e.createdAt, 'createdAt'); nonempty(e.recordedBy, 'recordedBy'); nonempty(e.sourceRef, 'sourceRef');
      const old = before?.[name].find(x => x.id === e.id);
      if (old) for (const field of ['id','createdAt','recordedBy','sourceRef']) assert(!changed(old[field], e[field]), `immutable ${field}`);
    }
    if (before) for (const e of before[name]) assert(tables[name].has(e.id), `history deletion prohibited: ${e.id}`);
  }
  for (const r of map.requirements) {
    nonempty(r.intent, 'intent'); assert(['proposed','needs_decision','accepted','rejected','superseded','withdrawn'].includes(r.decision), 'Invalid requirement decision');
    if (!['proposed','needs_decision'].includes(r.decision)) nonempty(r.decisionRef, 'decisionRef');
    assert(['current','backlog','deferred'].includes(r.schedule), 'Invalid schedule');
    if (r.schedule === 'deferred') { nonempty(r.scheduleReason, 'scheduleReason'); nonempty(r.scheduleDecisionRef, 'scheduleDecisionRef'); }
    hasReferences(r.featureIds, tables.features, 'featureIds'); array(r.openQuestions, 'openQuestions');
    if (r.decision === 'accepted') {
      assert(r.featureIds.length > 0, `orphan requirement ${r.id}`);
      for (const featureId of r.featureIds) assert(map.acceptanceCriteria.some(ac => ac.featureId === featureId && ac.requirementIds.includes(r.id)), `requirement ${r.id} has no applicable AC for ${featureId}`);
    }
    if (r.supersedes) assert(tables.requirements.has(r.supersedes) && r.supersedes !== r.id, 'Invalid supersedes');
    const old = before?.requirements.find(x => x.id === r.id);
    if (old && changed(old.intent, r.intent)) assert(r.correction?.kind === 'wording' && present(r.correction.reason) && present(r.correction.sourceRef), 'Changed requirement intent requires a new REQ or explicit wording correction');
  }
  for (const f of map.features) {
    for (const key of ['title','user','scenario','goal']) nonempty(f[key], key);
    for (const key of ['scope','exclusions','entrypointIds','implementationRefs']) array(f[key], key);
    assert(f.humanAutomation && typeof f.humanAutomation === 'object', 'humanAutomation required');
    assert(['active','deprecated','retired'].includes(f.lifecycle), 'Invalid lifecycle');
    assert(['planned','in_progress','implemented'].includes(f.deliveryStatus), 'Invalid deliveryStatus');
    hasReferences(f.requirementIds, tables.requirements, 'requirementIds'); hasReferences(f.dependencyIds || [], tables.features, 'dependencyIds'); hasReferences(f.acceptanceCriteria, tables.acceptanceCriteria, 'acceptanceCriteria');
    for (const field of ['splitInto','mergedFrom']) if (f[field]) { hasReferences(f[field], tables.features, `lineage ${field}`); assert(!f[field].includes(f.id), 'lineage cannot reference self'); }
    assert(f.requirementIds.length > 0 && f.acceptanceCriteria.length > 0, `feature coverage missing ${f.id}`);
    for (const id of f.requirementIds) assert(tables.requirements.get(id).featureIds.includes(f.id), `requirement/feature reverse link missing ${id}`);
    for (const id of f.acceptanceCriteria) assert(tables.acceptanceCriteria.get(id).featureId === f.id, 'AC feature ownership mismatch');
    if (f.deliveryStatus === 'implemented') assert(f.implementationRefs.length > 0, `implementationRefs required ${f.id}`);
    const old = before?.features.find(x => x.id === f.id);
    if (old && old.lifecycle !== f.lifecycle) { nonempty(f.lifecycleReason, 'lifecycleReason'); nonempty(f.lifecycleDecisionRef, 'lifecycleDecisionRef'); }
  }
  for (const ac of map.acceptanceCriteria) {
    assert(tables.features.has(ac.featureId), 'AC feature missing'); hasReferences(ac.requirementIds, tables.requirements, 'AC requirementIds');
    assert(Number.isInteger(ac.revision) && ac.revision >= 1, 'Invalid AC revision');
    array(ac.preconditions, 'preconditions'); array(ac.actions, 'actions'); assert(ac.actions.length, 'actions required');
    assert(ac.expected && ['baseline','ui','api','cli','background'].includes(ac.verificationMethod), 'AC observable expected and verificationMethod required');
    assert(ac.effects && ['none','test-artifacts','business-data'].includes(ac.effects.writes) && typeof ac.effects.network === 'boolean' && typeof ac.effects.paid === 'boolean', 'AC effects required');
    array(ac.requiredEvidenceTypes, 'requiredEvidenceTypes'); array(ac.dependencyRefs, 'dependencyRefs');
    array(ac.requiredTargets, 'requiredTargets'); assert(ac.requiredTargets.length > 0, 'requiredTargets empty');
    const targetIds = new Set();
    for (const t of ac.requiredTargets) { for (const k of ['targetId','entrypointId','roleRef','scenario','environmentRef','dataScopeRef']) nonempty(t[k], k); assert(!targetIds.has(t.targetId), 'duplicate targetId'); targetIds.add(t.targetId); }
    const old = before?.acceptanceCriteria.find(x => x.id === ac.id);
    if (old) { assert(old.featureId === ac.featureId, 'immutable AC featureId: inherit via a new AC'); const bump = contractFields.some(k => changed(old[k], ac[k])); assert(ac.revision === old.revision + Number(bump), 'AC revision must reflect contract change'); }
  }
  for (const c of map.changes) {
    for (const k of ['type','reason','decision','decisionRef','migrationImpact','recoveryImpact']) nonempty(c[k], k);
    assert(['open','implemented_pending_verification','closed','cancelled'].includes(c.status), 'Invalid change status');
    assert(Number.isInteger(c.baseRevision) && c.baseRevision >= 0, 'baseRevision required');
    hasReferences(c.requirementIds, tables.requirements, 'change requirements'); hasReferences(c.featureIds, tables.features, 'change features'); hasReferences(c.acIds, tables.acceptanceCriteria, 'change ACs');
    array(c.implementationRefs, 'change implementationRefs'); array(c.differences, 'differences'); array(c.impact, 'impact'); array(c.lineageTransfers, 'lineageTransfers');
    for (const id of c.requirementIds) assert(tables.requirements.get(id).featureIds.every(f => c.featureIds.includes(f) || c.excludedFeatureIds?.includes(f)), `change omits requirement feature ${id}`);
    if (c.status === 'cancelled') { nonempty(c.cancelReason, 'cancelReason'); nonempty(c.cancelDecisionRef, 'cancelDecisionRef'); }
  }
  if (before) {
    const latest = map.changes.at(-1);
    for (const f of before.features) {
      const now = tables.features.get(f.id);
      const involved = changed(f.splitInto, now.splitInto) || map.features.some(n => n.mergedFrom?.includes(f.id) && !before.features.find(o => o.id === n.id)?.mergedFrom?.includes(f.id));
      if (!involved) continue;
      const oldEntities = [...f.requirementIds.map(id => ({ id, revision: before.revision })), ...f.acceptanceCriteria.map(id => ({ id, revision: before.acceptanceCriteria.find(a => a.id === id).revision }))];
      for (const old of oldEntities) {
        const transfer = latest.lineageTransfers.find(t => t.sourceId === old.id && t.sourceRevision === old.revision);
        assert(transfer && ['inherited','replaced','retired','needs_decision'].includes(transfer.disposition) && present(transfer.reason) && present(transfer.decisionRef), `lineage missing ${old.id}`);
        assert(Array.isArray(transfer.targets), 'lineage targets required');
        if (['inherited','replaced'].includes(transfer.disposition)) assert(transfer.targets.length, 'lineage target missing');
        for (const t of transfer.targets) {
          const targetFeature = tables.features.get(t.featureId); assert(targetFeature && t.featureId !== f.id, 'lineage feature missing');
          if (['inherited','replaced'].includes(transfer.disposition)) assert(old.id.startsWith('REQ-') ? t.requirementIds?.length : t.acIds?.length, 'lineage requires actual entity destinations');
          for (const id of t.requirementIds || []) assert(tables.requirements.has(id) && targetFeature.requirementIds.includes(id), 'lineage requirement missing');
          for (const id of t.acIds || []) assert(tables.acceptanceCriteria.get(id)?.featureId === t.featureId && targetFeature.acceptanceCriteria.includes(id), 'lineage AC missing');
        }
      }
    }
  }
  for (const e of map.evidence) assert(tables.features.has(e.featureId) && tables.acceptanceCriteria.has(e.acId) && tables.changes.has(e.changeId), 'evidence relation missing');
  return { status: 'valid', counts: Object.fromEntries(Object.keys(collections).map(k => [k, map[k].length])) };
}

function resolve(value, ids) {
  if (typeof value === 'string' && value.startsWith('@')) { assert(ids[value.slice(1)], `Unknown draft reference ${value}`); return ids[value.slice(1)]; }
  if (Array.isArray(value)) return value.map(v => resolve(v, ids));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([k]) => k !== 'key').map(([k,v]) => [k, resolve(v, ids)]));
  return value;
}
export async function applyFeatureDraft(profile, command, draft, options) {
  assert(['init','change'].includes(command), 'unsupported feature mutation');
  return transact(profile, command, draft, options, async (map, before) => {
    nonempty(draft.recordedBy, 'recordedBy'); nonempty(draft.sourceRef, 'sourceRef'); assert(draft.change, 'CHG required');
    const ids = {}, assignedIds = [], createdAt = new Date().toISOString(), differences = [];
    for (const name of ['requirements','features','acceptanceCriteria','iterations']) {
      for (const item of draft[name] || []) {
        assert(!item.id, 'IDs allocated by transaction'); assert(present(item.key) && !ids[item.key], 'unique draft key required');
        const id = allocateId(map, name); ids[item.key] = id; assignedIds.push(id);
        map[name].push({ ...item, id });
      }
    }
    for (const name of ['requirements','features','acceptanceCriteria','iterations']) map[name] = map[name].map(e => {
      if (!assignedIds.includes(e.id)) return e;
      const resolved = { ...resolve(e, ids), createdAt, recordedBy: draft.recordedBy, sourceRef: e.sourceRef || draft.sourceRef };
      if (name === 'acceptanceCriteria') resolved.revision = 1;
      differences.push({ entity: name, id: e.id, before: null, after: resolved }); return resolved;
    });
    for (const update of draft.updates || []) {
      assert(['requirements','features','acceptanceCriteria','changes'].includes(update.entity), 'update entity prohibited');
      const id = resolve(update.id, ids), entity = map[update.entity].find(e => e.id === id); assert(entity, `entity missing ${id}`);
      for (const key of ['id','createdAt','recordedBy','sourceRef','revision']) assert(!(key in update.patch), `immutable ${key}`);
      if (update.entity === 'changes') {
        assert(Object.keys(update.patch).every(k => ['status','cancelReason','cancelDecisionRef','implementationRefs'].includes(k)), 'change patch restricted to delivery/cancellation');
        assert(!('status' in update.patch) || ['open','implemented_pending_verification','cancelled'].includes(update.patch.status), 'Use feature close to close a change');
        assert(entity.status !== 'closed', 'closed change immutable; create a new CHG');
      }
      const old = structuredClone(entity); Object.assign(entity, resolve(update.patch, ids));
      if (update.entity === 'acceptanceCriteria' && contractFields.some(k => changed(old[k], entity[k]))) entity.revision++;
      differences.push({ entity: update.entity, id, before: old, after: structuredClone(entity) });
    }
    const c = { ...resolve(draft.change, ids), id: allocateId(map, 'changes'), createdAt, recordedBy: draft.recordedBy, sourceRef: draft.sourceRef,
      baseRevision: before?.revision || 0, status: 'open', differences, impact: draft.change.impact || [], lineageTransfers: resolve(draft.change.lineageTransfers || [], ids) };
    if (profile.sourceScopes || profile.controls?.sourceReview?.inputs) { const { sourceSnapshot } = await import('./source-diff.mjs'); c.sourceBaseline = await sourceSnapshot(profile); }
    map.changes.push(c); assignedIds.push(c.id);
    for (const d of differences) {
      if (!d.before) continue;
      const acChanged = d.entity === 'acceptanceCriteria' && d.after.revision !== d.before.revision;
      const implChanged = d.entity === 'features' && ['implementationRefs','dependencyIds','entrypointIds'].some(k => changed(d.before[k], d.after[k]));
      if (acChanged || implChanged) for (const e of map.evidence) if (acChanged ? e.acId === d.id : e.featureId === d.id) { e.applicability = 'stale'; e.invalidatedBy = c.id; e.invalidationReason = acChanged ? 'acceptance_contract_changed' : 'implementation_or_entry_changed'; }
    }
    for (const transfer of resolve(draft.carryForward || [], ids)) map.carryForward.push({ ...transfer, recordedBy: draft.recordedBy, sourceRef: draft.sourceRef, createdAt });
    return { changeId: c.id, assignedIds, ids };
  }, validateMap);
}

export function featureImpact(map, changeId, diff) {
  const change = map.changes.find(c => c.id === changeId); assert(change, 'change_not_found');
  assert(diff && Array.isArray(diff.files) && present(diff.sourceRef), 'Actual diff files and sourceRef required');
  const affected = new Set(), affectedACs = new Set(), unexplainedFiles = [];
  for (const file of diff.files) {
    const owners = map.features.filter(f => refs(f.implementationRefs).some(r => touches(file, r)));
    const conditions = map.acceptanceCriteria.filter(ac => refs([...(ac.implementationRefs || []), ...ac.dependencyRefs]).some(r => touches(file, r)));
    owners.forEach(f => affected.add(f.id)); conditions.forEach(ac => { affected.add(ac.featureId); affectedACs.add(ac.id); });
    if (!owners.length && !conditions.length && !(diff.nonProduct || []).some(n => n.path === file && present(n.reason) && present(n.sourceRef))) unexplainedFiles.push(file);
  }
  for (const id of diff.featureIds || []) { assert(map.features.some(f => f.id === id), 'impact feature missing'); affected.add(id); }
  let growth = true; while (growth) { growth = false; for (const f of map.features) if (!affected.has(f.id) && (f.dependencyIds || []).some(id => affected.has(id))) { affected.add(f.id); growth = true; } }
  for (const ac of map.acceptanceCriteria) if (affected.has(ac.featureId) || (diff.acIds || []).includes(ac.id)) affectedACs.add(ac.id);
  const unknown = unexplainedFiles.length > 0 || (diff.unknownDependencies || []).length > 0;
  return { status: unknown ? 'impact_unknown' : 'impact_resolved', sourceRef: diff.sourceRef, files: diff.files, affectedFeatureIds: [...affected], affectedAcIds: [...affectedACs], staleEvidenceIds: map.evidence.filter(e => affectedACs.has(e.acId)).map(e => e.id), unexplainedFiles, unknownDependencies: diff.unknownDependencies || [], unassociatedFeatureIds: [...affected].filter(id => !change.featureIds.includes(id)), nonProduct: diff.nonProduct || [] };
}
export function featureCheck(map, changeId) {
  validateMap(map); const c = map.changes.find(c => c.id === changeId); assert(c, 'change_not_found'); const blockers = [];
  for (const id of c.requirementIds) { const r = map.requirements.find(r => r.id === id); if (r.decision !== 'accepted' && r.schedule === 'current') blockers.push({ id, reason: 'requirement_not_accepted' }); if (r.openQuestions.some(q => typeof q === 'string' || q.critical !== false)) blockers.push({ id, reason: 'critical_question_unresolved' }); if (r.sourceRef === 'source_unresolved') blockers.push({ id, reason: 'source_unresolved' }); }
  for (const t of c.lineageTransfers) if (t.disposition === 'needs_decision') blockers.push({ id: t.sourceId, reason: 'lineage_needs_decision' });
  if (c.impactReport?.status === 'impact_unknown' || c.impactReport?.unassociatedFeatureIds?.length) blockers.push({ id: c.id, reason: 'impact_unresolved' });
  return { status: blockers.length ? 'blocked' : 'ready_for_implementation', blockerCount: blockers.length, blockers, changeId };
}
export async function recordImpact(profile, changeId, diff, options) {
  return transact(profile, 'impact', { changeId, diff }, options, async map => {
    const c = map.changes.find(c => c.id === changeId); assert(c, 'change_not_found');
    let observed = diff;
    if (c.sourceBaseline) { const { sourceDiff } = await import('./source-diff.mjs'); observed = { ...diff, ...await sourceDiff(profile, c.sourceBaseline) }; }
    const report = featureImpact(map, changeId, observed); report.observation = observed;
    c.impactReport = report; c.impact = report.affectedFeatureIds;
    for (const e of map.evidence) if (report.staleEvidenceIds.includes(e.id)) { e.applicability = 'stale'; e.invalidationReason = 'actual_diff'; e.invalidatedBy = changeId; }
    return { changeId, impact: report };
  }, validateMap);
}
export async function recordAcceptance(profile, evidence, options) {
  const { validateEvidence } = await import('./acceptance.mjs');
  return transact(profile, 'accept-record', evidence, options, async map => {
    const validated = await validateEvidence(profile, map, evidence);
    const id = allocateId(map, 'evidence'); map.evidence.push({ ...validated, id, createdAt: new Date().toISOString(), recordedBy: evidence.recordedBy, sourceRef: evidence.sourceRef });
    return { assignedIds: [id], evidenceId: id, result: validated.result };
  }, validateMap);
}
export async function closeFeatureChange(profile, changeId, input, options) {
  return transact(profile, 'close', { changeId, ...input }, options, async map => {
    const check = featureCheck(map, changeId); assert(!check.blockerCount, `change_blocked: ${JSON.stringify(check.blockers)}`);
    const c = map.changes.find(c => c.id === changeId);
    assert(c.status !== 'cancelled', 'cancelled_change');
    assert(c.impactReport?.status === 'impact_resolved' && !c.impactReport.unassociatedFeatureIds.length, 'actual_impact_required');
    assert(c.sourceBaseline, 'source_baseline_required: configure sourceScopes before change registration');
    const { sourceDiff } = await import('./source-diff.mjs');
    const currentDiff = await sourceDiff(profile, c.sourceBaseline);
    assert(currentDiff.currentHash === c.impactReport.observation?.currentHash, 'source_changed_after_impact');
    assert(input.implementationRefs?.length && present(input.sourceRef), 'implementationRefs and sourceRef required');
    const required = new Set(c.acIds);
    for (const id of c.requirementIds) {
      const r = map.requirements.find(r => r.id === id);
      if (r.decision === 'accepted' && r.schedule === 'current') for (const fId of r.featureIds) { const f = map.features.find(f => f.id === fId); assert(f.deliveryStatus === 'implemented', `feature_unimplemented ${fId}`); for (const ac of map.acceptanceCriteria) if (ac.featureId === fId && ac.requirementIds.includes(id)) required.add(ac.id); }
    }
    const { assessDeliveryCoverage } = await import('./acceptance.mjs');
    const assessment = await assessDeliveryCoverage(profile, map, [...required], {stateRoot:options.stateRoot});
    assert(assessment.status === 'passed', `acceptance_incomplete: ${JSON.stringify(assessment)}`);
    c.implementationRefs = input.implementationRefs; c.status = 'closed'; c.closedAt = new Date().toISOString(); c.closeSourceRef = input.sourceRef; c.assessment = assessment;
    return { changeId, status: 'closed' };
  }, validateMap);
}
export async function featureShow(profile, ids) {
  const map = await readMap(profile); assert(ids?.length, 'Specify IDs; full map is available at featureMapRef.path');
  const entities = Object.keys(collections).flatMap(k => map[k]).filter(e => ids.includes(e.id));
  return { projectId: map.projectId, revision: map.revision, contentHash: map.contentHash, mapRef: profile.featureMapRef.path, count: entities.length, entities };
}
