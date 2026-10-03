import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { assessUIQualityCoverage } from './ui-quality.mjs';
import { assessVisualSnapshot } from './visual-check.mjs';

const text = value => typeof value === 'string' && !!value.trim();
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const checks = ['wording_and_action_hierarchy', 'error_location_and_recovery', 'permission_and_operation_consequences', 'native_or_unsampled_text', 'hidden_states_and_other_containers'];
const unresolved = ['failed', 'review', 'needs_review', 'gap', 'capability_gap', 'missing_evidence', 'not_executed', 'not_run', 'incomplete', 'not_configured'];
const scopeFields = ['entrypointId', 'targetId', 'state', 'platform', 'roleRef', 'environmentRef', 'dataScopeRef'];
const limits = 'Local review of the supplied script originals and explicitly sampled ranges only. Hashes associate materials and detect drift; they do not prove reviewer identity or business authenticity. No model API is called. Review completion is not business acceptance, whole-page coverage, assistive-technology or native-device acceptance.';

function short(value, depth = 0) {
  if (typeof value === 'string') return value.length > 240 ? `${value.slice(0, 240)}…` : value;
  if (!value || typeof value !== 'object') return value;
  if (depth > 2) return Array.isArray(value) ? { count: value.length } : { keys: Object.keys(value).slice(0, 8) };
  if (Array.isArray(value)) return value.length > 8 ? { count: value.length, sample: value.slice(0, 3).map(x => short(x, depth + 1)) } : value.map(x => short(x, depth + 1));
  return Object.fromEntries(Object.entries(value).slice(0, 10).map(([k, v]) => [k, short(v, depth + 1)]));
}

// Existing reducers are reused when measurements or observations are available. A bare pass is never material.
function assessment(document) {
  if (document.config && Array.isArray(document.observations)) return { result: assessUIQualityCoverage(document.config, document.observations, document.context || {}), calculated: true };
  if (document.layout && Array.isArray(document.rules)) return { result: assessVisualSnapshot(document.layout, { goal: document.id || 'UI review', viewport: document.viewport || document.layout.viewport, required: document.required || [], rules: document.rules }), calculated: true };
  if (document.snapshot && document.constraints) return { result: assessVisualSnapshot(document.snapshot, document.constraints), calculated: true };
  const result = document.assessment || document;
  return { result, calculated: false };
}

export async function reviewUIQuality(input = {}, { baseDir = process.cwd() } = {}) {
  if (!object(input)) throw new Error('UI review input must be an object');
  if (!Array.isArray(input.reportFiles) || !input.reportFiles.length || !input.reportFiles.every(text)) throw new Error('UI review requires reportFiles: paths to existing script originals');
  if (input.reviewFiles !== undefined && (!Array.isArray(input.reviewFiles) || !input.reviewFiles.every(text))) throw new Error('reviewFiles must contain decision-file paths');
  const originals = [], pages = [], workItems = [], seenFiles = new Set();
  const read = async (file, from = baseDir) => {
    const resolved = path.resolve(from, file), bytes = await fs.readFile(resolved);
    return { ref: { path: resolved, sha256: digest(bytes) }, document: JSON.parse(bytes.toString('utf8')) };
  };
  const add = (kind, signal, page, locator) => {
    const scope = Object.fromEntries(scopeFields.map(field => [field, signal[field] ?? (field === 'targetId' ? signal.targetSelector || signal.selector : undefined) ?? page[field] ?? null]));
    scope.viewport = page.viewport || null;
    const item = { itemId: `UIR-${digest(`${page.originalRef.path}:${locator}`).slice(0, 16)}`, kind, code: signal.code || signal.status || kind,
      scope, ruleId: signal.ruleId || null, categoryId: signal.categoryId || null, type: signal.type || null, method: signal.method || null,
      sourceRef: signal.sourceRef || signal.source || null, originalRef: page.originalRef, locator,
      reason: signal.reason || signal.code || 'Inspect this declared range in the original material',
      ...(Object.hasOwn(signal, 'actual') ? { actual: short(signal.actual) } : {}),
      ...(Object.hasOwn(signal, 'expected') ? { expected: signal.expected } : {}),
      nextAction: kind === 'alert' ? 'Codex verify the alarm and cause; fix confirmed issues and retest the same entrypoint' : kind === 'coverage_gap' ? 'Supply the missing method/material or inspect the exact uncovered range; keep unresolved gaps visible' : 'Codex inspect the stated sample and original context',
      review: { status: 'pending' } };
    workItems.push(item); return item;
  };
  const visit = async (file, from = baseDir, hints = {}) => {
    const loaded = await read(file, from);
    if (seenFiles.has(loaded.ref.path)) return;
    seenFiles.add(loaded.ref.path); originals.push(loaded.ref);
    const doc = loaded.document;
    if (Array.isArray(doc.captures)) {
      if (!doc.captures.length) throw new Error(`Empty UI capture manifest: ${loaded.ref.path}`);
      for (const capture of doc.captures) {
        if (!text(capture.evidence)) throw new Error('Each capture requires its actual evidence file');
        await visit(capture.evidence, path.dirname(loaded.ref.path), capture);
      }
      return;
    }
    const { result, calculated } = assessment(doc);
    const page = { id: doc.id || hints.id || path.basename(loaded.ref.path), entrypointId: doc.surface || hints.surface || doc.entrypointId || null,
      roleRef: doc.roleRef || doc.role || hints.role || null, state: doc.state || null, platform: doc.platform || doc.layout?.platform || 'web',
      environmentRef: doc.environmentRef || doc.context?.environmentRef || null, dataScopeRef: doc.dataScopeRef || null,
      viewport: doc.viewport || result.viewport || null, originalRef: loaded.ref, calculated };
    const signals = Array.isArray(result.results) ? result.results : Array.isArray(result.findings) ? result.findings : [];
    // Coverage originals carry entry/role/state per unit rather than per page.
    const first = signals[0] || {};
    for (const field of scopeFields) page[field] ??= first[field] ?? null;
    const local = [];
    for (const [index, signal] of signals.entries()) if (unresolved.includes(signal.status)) local.push(add(signal.status === 'failed' ? 'alert' : ['review','needs_review'].includes(signal.status) ? 'review' : 'coverage_gap', signal, page, `results/${index}`));
    for (const [index, issue] of (result.issues || []).entries()) if (!local.some(item => item.ruleId === issue.ruleId && item.code === issue.code)) local.push(add(issue.status === 'review' ? 'review' : 'alert', issue, page, `issues/${index}`));
    const notes = [...(doc.notes || []), ...(result.coverageNotes || []), ...(result.gaps || []), ...(result.capabilityGaps || [])]
      .filter((note, index, list) => list.findIndex(other => isDeepStrictEqual(Object.fromEntries(Object.entries(other).filter(([key]) => key !== 'code')), Object.fromEntries(Object.entries(note).filter(([key]) => key !== 'code')))) === index);
    for (const [index, note] of notes.entries()) {
      if (note.status === 'not_applicable') continue;
      const status = note.status || 'gap';
      if (unresolved.includes(status) || !note.status) local.push(add(status === 'failed' ? 'alert' : ['review','needs_review'].includes(status) ? 'review' : 'coverage_gap', note, page, `notes/${index}`));
    }
    for (const [index, signal] of signals.entries()) if (!text(signal.sourceRef || signal.source)) local.push(add('coverage_gap', { ...signal, code: 'missing_rule_provenance', reason: 'Rule has no source for its expectation' }, page, `provenance/${index}`));
    for (const [index, signal] of signals.entries()) if (!calculated && signal.status === 'passed' && (!Object.hasOwn(signal, 'actual') || !Object.hasOwn(signal, 'expected')))
      local.push(add('coverage_gap', { ...signal, code: 'missing_observation_material', reason: 'Producer passed without actual or expected values' }, page, `material/${index}`));
    if (!signals.length && !(result.issues || []).length && !notes.length) add('coverage_gap', { code: 'missing_assessment_material', reason: 'No rule observations, measured findings or coverage material; producer pass ignored' }, page, 'missing-material');
    else if (unresolved.includes(result.status) && !local.length) add('coverage_gap', { code: 'unresolved_report', reason: `Original status remains ${result.status}` }, page, 'report-status');
    page.passedRuleIds = signals.filter(x => x.status === 'passed' && text(x.sourceRef || x.source) && (calculated || (Object.hasOwn(x, 'actual') && Object.hasOwn(x, 'expected')))).map(x => x.ruleId).filter(text);
    page.scriptStatus = local.some(x => x.kind === 'alert') ? 'failed' : local.length ? 'incomplete' : page.passedRuleIds.length ? 'passed' : 'unverified';
    pages.push(page);
  };
  for (const file of input.reportFiles) await visit(file);

  // One representative per platform/role/viewport and a second boundary page when available.
  // The caller may add samples; supplied lists never remove the default safety sample.
  const groups = new Map();
  for (const page of [...pages].sort((a, b) => a.id.localeCompare(b.id))) {
    const key = JSON.stringify([page.platform, page.roleRef, page.environmentRef, page.viewport?.width, page.viewport?.height]);
    if (!groups.has(key)) groups.set(key, []); groups.get(key).push(page);
  }
  const samples = new Map();
  for (const group of groups.values()) {
    samples.set(group[0].originalRef.path, group[0]);
    const passed = group.filter(x => x.passedRuleIds.length && x.scriptStatus === 'passed');
    if (passed.length) samples.set(passed[0].originalRef.path, passed[0]);
    if (group.length > 1) samples.set(group.at(-1).originalRef.path, group.at(-1));
  }
  for (const id of input.additionalSampleIds || []) {
    const namedPages = pages.filter(x => x.id === id); if (!namedPages.length) throw new Error(`Unknown additional sample: ${id}`);
    for (const page of namedPages) samples.set(page.originalRef.path, page);
  }
  for (const page of samples.values()) {
    add('blind_spot', { code: 'contextual_sample', reason: 'Inspect applicable wording, action hierarchy, error recovery, permission consequences, native/unsampled text and hidden/container boundaries' }, page, 'blind-spot');
    if (page.passedRuleIds.length) add('passed_sample', { code: 'missed_alarm_sample', reason: 'Inspect representative passed targets and nearby unsampled content for missed alarms' }, page, 'passed-sample');
  }

  const reviewRecords = [];
  for (const file of input.reviewFiles || []) reviewRecords.push(await read(file));
  const referenced = async (ref, from) => {
    if (!object(ref) || !text(ref.path) || !/^[a-f0-9]{64}$/.test(ref.sha256 || '')) throw new Error('Evidence requires path and SHA-256');
    const resolved = path.resolve(from, ref.path), bytes = await fs.readFile(resolved);
    if (digest(bytes) !== ref.sha256) throw new Error(`Evidence drift: ${resolved}`);
    return { path: resolved, bytes };
  };
  for (const item of workItems) {
    const matches = reviewRecords.filter(x => x.document.itemId === item.itemId);
    if (!matches.length) continue;
    try {
      if (matches.length !== 1) throw new Error('Conflicting review records; resolve explicitly');
      const { document: decision, ref: decisionRef } = matches[0], from = path.dirname(decisionRef.path);
      if (!text(decision.reviewerRef) || !text(decision.reason) || !['verified','false_positive','fixed','confirmed_issue','unresolved'].includes(decision.decision)) throw new Error('Named reviewer, reason and explicit decision required');
      if (!isDeepStrictEqual(decision.scope, item.scope)) throw new Error('Review scope does not match this target/state/role/viewport');
      if (!Array.isArray(decision.reportRefs) || !decision.reportRefs.some(ref => path.resolve(from, ref.path || '') === item.originalRef.path && ref.sha256 === item.originalRef.sha256)) throw new Error('Decision is not tied to this current original');
      for (const ref of decision.reportRefs) await referenced(ref, from);
      if (!Array.isArray(decision.evidenceRefs) || !decision.evidenceRefs.length) throw new Error('Actual review evidence is required');
      for (const ref of decision.evidenceRefs) await referenced(ref, from);
      if (item.kind === 'alert' && decision.decision === 'verified') throw new Error('An alert requires confirmed_issue, false_positive, fixed or unresolved');
      if (['fixed','false_positive'].includes(decision.decision)) {
        const raw = await referenced(decision.retestRef, from), doc = JSON.parse(raw.bytes.toString('utf8'));
        const { result: retest, calculated } = assessment(doc);
        if (!calculated) throw new Error('Retest needs measurements/observations for the existing reducer, not producer pass');
        const signals = retest.results || retest.findings || [];
        const same = signals.find(x => x.ruleId === item.ruleId && ['entrypointId','targetId','state','platform'].every(field => x[field] === item.scope[field]));
        const role = doc.roleRef || doc.role || same?.roleRef;
        const actions = doc.actions || doc.observations?.flatMap(x => x.actions || []) || [];
        const actionTypes = actions.map(x => typeof x === 'string' ? x : x?.type);
        const currentContext = ['environmentRef','dataScopeRef'].every(field => item.scope[field] === null || (doc[field] || doc.context?.[field] || same?.[field]) === item.scope[field]);
        const currentViewport = item.scope.viewport === null || isDeepStrictEqual(doc.viewport || retest.viewport, item.scope.viewport);
        const relevantGap = [...(retest.gaps || []), ...(retest.capabilityGaps || []), ...(retest.coverageNotes || [])].some(gap => {
          if (gap.status === 'not_applicable' || gap.status === 'passed') return false;
          if (gap.ruleId && gap.ruleId !== item.ruleId) return false;
          if (gap.categoryId && gap.categoryId !== item.categoryId) return false;
          return scopeFields.every(field => !gap[field] || gap[field] === item.scope[field]);
        });
        if (relevantGap) throw new Error('Retest retains a required capability or evidence gap for the same rule or scope');
        const sameContract = same && (item.type === null || same.type === item.type) && (item.method === null || same.method === item.method) && isDeepStrictEqual(same.sourceRef || same.source, item.sourceRef);
        if (!same || !sameContract || same.status !== 'passed' || !isDeepStrictEqual(same.expected, item.expected) || role !== item.scope.roleRef || !currentContext || !currentViewport || !actionTypes.some(x => ['click','input','key','scroll'].includes(x)) || !actionTypes.includes('wait')) throw new Error('Same rule, method, source, expectation, target, state, role, environment and viewport must pass with actual operation and wait on retest');
      }
      item.review = { status: decision.decision === 'confirmed_issue' ? 'requires_repair' : decision.decision === 'unresolved' ? 'pending' : 'completed',
        reviewerRef: decision.reviewerRef, decisionRef, decision: decision.decision, reason: decision.reason, evidenceRefs: decision.evidenceRefs,
        ...(decision.retestRef ? { retestRef: decision.retestRef } : {}) };
    } catch (error) { item.review = { status: 'invalid', reason: error.message }; }
  }
  const unknownReviews = reviewRecords.filter(x => !workItems.some(item => item.itemId === x.document.itemId)).map(x => ({ decisionRef: x.ref, reason: 'Decision names no current review item' }));
  const counts = { originals: originals.length, pages: pages.length, alerts: workItems.filter(x => x.kind === 'alert').length,
    needsReview: workItems.filter(x => x.kind === 'review').length, capabilityGaps: workItems.filter(x => x.kind === 'coverage_gap').length,
    blindSpots: workItems.filter(x => x.kind === 'blind_spot').length, passedSamples: workItems.filter(x => x.kind === 'passed_sample').length,
    total: workItems.length, completed: workItems.filter(x => x.review.status === 'completed').length,
    requiresRepair: workItems.filter(x => x.review.status === 'requires_repair').length,
    pending: workItems.filter(x => ['pending','invalid'].includes(x.review.status)).length + unknownReviews.length };
  const status = counts.requiresRepair ? 'requires_repair' : counts.pending || !pages.length ? 'needs_review' : 'review_complete';
  return { schemaVersion: 1, status, counts, originals, workItems, unknownReviews,
    sampling: { method: 'Deterministic representatives per platform/role/environment/viewport plus a passed page and boundary page; additional samples only expand scope',
      checks, pages: [...samples.values()].map(({ id, entrypointId, roleRef, state, platform, viewport, originalRef, passedRuleIds }) => ({ id, entrypointId, roleRef, state, platform, viewport, originalRef, passedRuleIds })),
      excludedPageIds: pages.filter(x => !samples.has(x.originalRef.path)).map(x => x.id), exhaustive: false },
    businessAcceptance: false, limits };
}

export function summarizeUIReview(result) {
  return { status: result.status, counts: result.counts, businessAcceptance: false, detailRef: result.detailRef || null,
    action: result.status === 'review_complete' ? 'Review scope is complete; project business acceptance remains separate.' : 'Codex inspect every alert/review/gap and the stated samples; fix confirmed issues and retest the same entrypoint.',
    nextItems: result.workItems.filter(x => x.review.status !== 'completed').slice(0, 3).map(({ itemId, kind, code }) => ({ itemId, kind, code })),
    limits: 'Originals and complete work items are preserved in --output; sampling is not exhaustive or business acceptance.' };
}
