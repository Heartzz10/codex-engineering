import fs from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { existingInside, json } from './paths.mjs';

export const UI_QUALITY_CATALOG = JSON.parse(fs.readFileSync(new URL('../catalog/ui-quality-rules.json', import.meta.url), 'utf8'));
export const UI_QUALITY_RULE_VERSION = UI_QUALITY_CATALOG.ruleVersion;
const categoryIds = UI_QUALITY_CATALOG.categories.map(item => item.categoryId);
const methods = UI_QUALITY_CATALOG.methods;
const platforms = UI_QUALITY_CATALOG.platforms;
const text = value => typeof value === 'string' && !!value.trim();
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const unitFields = ['ruleId', 'categoryId', 'featureId', 'acId', 'entrypointId', 'targetId', 'state', 'platform'];
const key = item => JSON.stringify(unitFields.map(field => item?.[field]));
const limits = 'Covers declared requirements and observations only. Evidence references are associations; original artifacts, hashes, environment and business authenticity must be verified by project acceptance. Static checks do not prove runtime or business behavior; native capabilities require real platform evidence.';

// Facts come from the current project map, design and check registration, not guessed from installed packages.
export function deriveUIQualityConfig(facts = {}) {
  const sourceRef = facts.sourceRef || '';
  const hasUI = typeof facts.hasUI === 'boolean' ? facts.hasUI : null;
  const explicit = Array.isArray(facts.categories) ? facts.categories : [];
  return { schemaVersion: 1, ruleVersion: UI_QUALITY_RULE_VERSION, sourceRef, hasUI,
    platforms: [...(facts.platforms || [])], designRefs: [...(facts.designRefs || [])], componentRefs: [...(facts.componentRefs || [])],
    categories: categoryIds.map(categoryId => {
      const decision = explicit.find(item => item.categoryId === categoryId);
      if (decision) return structuredClone(decision);
      if (hasUI === false) return { categoryId, applicability: 'not_applicable', reason: 'Project facts explicitly declare no UI', sourceRef };
      const required = (facts.requirements || []).some(item => item.categoryId === categoryId);
      return { categoryId, applicability: required ? 'applicable' : 'unknown', reason: required ? 'Required by project acceptance' : 'Project facts do not establish applicability', sourceRef };
    }), adapters: structuredClone(facts.adapters || []), sourceChecks: structuredClone(facts.sourceChecks || []),
    requirements: structuredClone(facts.requirements || []), exceptions: structuredClone(facts.exceptions || []) };
}

export function validateUIQualityConfig(config) {
  const errors = [];
  const require = (ok, message) => { if (!ok) errors.push(message); };
  const only = (value, names, at) => { if (object(value)) for (const name of Object.keys(value)) require(names.includes(name), `${at}.${name}: unknown field`); };
  const strings = (value, at) => require(Array.isArray(value) && value.every(text), `${at}: string array required`);
  const array = value => Array.isArray(value) ? value : [];
  require(object(config), 'uiQuality: object required');
  if (!object(config)) return { valid: false, errors };
  only(config, ['schemaVersion','ruleVersion','sourceRef','hasUI','platforms','designRefs','componentRefs','categories','adapters','sourceChecks','requirements','exceptions'], 'uiQuality');
  require(config.schemaVersion === 1, 'schemaVersion: unsupported UI quality contract');
  require(config.ruleVersion === UI_QUALITY_RULE_VERSION, 'ruleVersion: unsupported UI quality rules');
  require(text(config.sourceRef), 'sourceRef: project facts provenance required');
  require(config.hasUI === null || typeof config.hasUI === 'boolean', 'hasUI: boolean or null required');
  for (const field of ['platforms','designRefs','componentRefs']) strings(config[field], field);
  require(array(config.platforms).every(platform => platforms.includes(platform)), 'platforms: unknown platform');
  require(new Set(array(config.platforms)).size === config.platforms?.length, 'platforms: duplicate platform');
  for (const field of ['categories','adapters','sourceChecks','requirements','exceptions']) require(Array.isArray(config[field]), `${field}: array required`);
  const categorySeen = new Set();
  for (const [index, item] of (Array.isArray(config.categories) ? config.categories : []).entries()) {
    const at = `categories[${index}]`; require(object(item), `${at}: object required`); if (!object(item)) continue;
    only(item, ['categoryId','applicability','reason','sourceRef'], at);
    require(categoryIds.includes(item.categoryId) && !categorySeen.has(item.categoryId), `${at}.categoryId: unknown or duplicate category`); categorySeen.add(item.categoryId);
    require(['applicable','not_applicable','unknown'].includes(item.applicability), `${at}.applicability: invalid conclusion`);
    require(text(item.reason) && text(item.sourceRef), `${at}.sourceRef/reason: provenance and rationale required`);
    if (config.hasUI === false) require(item.applicability === 'not_applicable', `${at}: no UI contradicts applicability`);
  }
  require(categoryIds.every(id => categorySeen.has(id)), 'categories: all Q01-Q18 applicability conclusions required');
  const adapterSeen = new Set();
  for (const [index, item] of (Array.isArray(config.adapters) ? config.adapters : []).entries()) {
    const at = `adapters[${index}]`; require(object(item), `${at}: object required`); if (!object(item)) continue;
    only(item, ['id','platform','capabilities','sourceRef','runtimeVersion','controlRef','acceptanceRouteRef'], at);
    require(text(item.id) && !adapterSeen.has(item.id), `${at}.id: unique adapter required`); adapterSeen.add(item.id);
    require(array(config.platforms).includes(item.platform), `${at}.platform: undeclared platform`);
    strings(item.capabilities, `${at}.capabilities`); require(array(item.capabilities).every(value => methods.includes(value)), `${at}.capabilities: unknown capability`);
    require(text(item.sourceRef), `${at}.sourceRef: adapter provenance required`);
    for (const field of ['runtimeVersion','controlRef','acceptanceRouteRef']) if (item[field] !== undefined) require(text(item[field]), `${at}.${field}: nonempty reference required`);
  }
  const sourceSeen = new Set();
  for (const [index, item] of (Array.isArray(config.sourceChecks) ? config.sourceChecks : []).entries()) {
    const at = `sourceChecks[${index}]`; require(object(item), `${at}: object required`); if (!object(item)) continue;
    only(item, ['checkId','categoryIds','sourceRef'], at);
    require(text(item.checkId) && !sourceSeen.has(item.checkId), `${at}.checkId: unique registered check required`); sourceSeen.add(item.checkId);
    require(Array.isArray(item.categoryIds) && item.categoryIds.length > 0 && item.categoryIds.every(id => categoryIds.includes(id)), `${at}.categoryIds: known categories required`);
    require(text(item.sourceRef), `${at}.sourceRef: check provenance required`);
  }
  const seen = new Set();
  for (const [index, item] of (Array.isArray(config.requirements) ? config.requirements : []).entries()) {
    const at = `requirements[${index}]`; require(object(item), `${at}: object required`); if (!object(item)) continue;
    only(item, [...unitFields,'method','sourceRef','expected','adapterId','actions','roleRef','environmentRef','dataScopeRef','sourceVersion','requirementVersion'], at);
    for (const field of [...unitFields,'sourceRef']) require(text(item[field]) && item[field] !== '*', `${at}.${field}: explicit reference required`);
    require(categoryIds.includes(item.categoryId), `${at}.categoryId: unknown category`);
    require(array(config.categories).some(category => category?.categoryId === item.categoryId && category.applicability === 'applicable'), `${at}.categoryId: requirement must be applicable`);
    require(array(config.platforms).includes(item.platform), `${at}.platform: undeclared platform`);
    require(methods.includes(item.method), `${at}.method: unknown method`);
    require(UI_QUALITY_CATALOG.categories.find(category => category.categoryId === item.categoryId)?.methods.includes(item.method), `${at}.method: method cannot verify this category`);
    require(Object.hasOwn(item, 'expected') && item.expected !== undefined, `${at}.expected: actual success condition required`);
    if (object(item.expected) && Object.hasOwn(item.expected, 'operator')) {
      only(item.expected, ['operator','value'], `${at}.expected`);
      require(['eq','gte','lte','includes','oneOf'].includes(item.expected.operator), `${at}.expected.operator: unknown comparison`);
      require(Object.hasOwn(item.expected, 'value'), `${at}.expected.value: required`);
      if (['gte','lte'].includes(item.expected.operator)) require(Number.isFinite(item.expected.value), `${at}.expected.value: numeric threshold required`);
      if (item.expected.operator === 'oneOf') require(Array.isArray(item.expected.value) && item.expected.value.length > 0, `${at}.expected.value: nonempty alternatives required`);
    }
    if (item.adapterId !== undefined) require(adapterSeen.has(item.adapterId), `${at}.adapterId: unknown adapter`);
    if (item.actions !== undefined) strings(item.actions, `${at}.actions`);
    for (const field of ['roleRef','environmentRef','dataScopeRef','sourceVersion','requirementVersion']) if (item[field] !== undefined) require(text(item[field]), `${at}.${field}: nonempty reference required`);
    const uniqueKey = `${key(item)}:${item.method}`; require(!seen.has(uniqueKey), `${at}: duplicate coverage unit`); seen.add(uniqueKey);
  }
  for (const [index, item] of (Array.isArray(config.exceptions) ? config.exceptions : []).entries()) {
    const at = `exceptions[${index}]`; require(object(item), `${at}: object required`); if (!object(item)) continue;
    only(item, ['ruleId','targetId','state','sourceRef','reason','invalidationCondition'], at);
    for (const field of ['ruleId','targetId','state','sourceRef','reason','invalidationCondition']) require(text(item[field]) && item[field] !== '*', `${at}.${field}: bounded exception required`);
    require(array(config.requirements).some(rule => rule?.ruleId === item.ruleId && rule.targetId === item.targetId && rule.state === item.state), `${at}: exception must name an existing requirement`);
  }
  if (config.hasUI === false) require(config.requirements?.length === 0 && config.adapters?.length === 0 && config.sourceChecks?.length === 0, 'No UI: executable UI rules contradict project facts');
  return { valid: errors.length === 0, errors };
}

export function prepareUIQuality(config) {
  if (config == null) return { status: 'not_configured', config: null, categories: [], requirements: [], sourceChecks: [], capabilityGaps: [{ code: 'not_configured' }], limits };
  const validation = validateUIQualityConfig(config);
  if (!validation.valid) throw new Error(`Invalid UI quality configuration: ${validation.errors.join('; ')}`);
  const categories = config.categories.map(item => ({ ...UI_QUALITY_CATALOG.categories.find(entry => entry.categoryId === item.categoryId), ...item }));
  const capabilityGaps = [];
  if (config.hasUI === null) capabilityGaps.push({ code: 'unknown_ui_presence', sourceRef: config.sourceRef });
  if (config.hasUI === true && config.platforms.length === 0) capabilityGaps.push({ code: 'missing_platform' });
  for (const category of categories) {
    if (category.applicability === 'unknown') capabilityGaps.push({ code: 'unknown_applicability', categoryId: category.categoryId, sourceRef: category.sourceRef });
    if (category.applicability === 'applicable' && !config.requirements.some(rule => rule.categoryId === category.categoryId))
      capabilityGaps.push({ code: 'category_without_requirement', categoryId: category.categoryId });
    if (category.applicability === 'applicable' && config.requirements.some(rule => rule.categoryId === category.categoryId) && config.requirements.filter(rule => rule.categoryId === category.categoryId).every(rule => rule.method === 'source'))
      capabilityGaps.push({ code: 'source_only_category', categoryId: category.categoryId });
  }
  for (const rule of config.requirements) {
    if (rule.method === 'source') {
      if (!config.sourceChecks.some(check => check.categoryIds.includes(rule.categoryId))) capabilityGaps.push({ code: 'missing_source_check', ...rule });
    } else if (!config.adapters.some(adapter => adapter.platform === rule.platform && (!rule.adapterId || rule.adapterId === adapter.id) && adapter.capabilities.includes(rule.method))) {
      capabilityGaps.push({ code: 'missing_adapter', ...rule });
    }
  }
  return { status: config.hasUI === false ? 'not_applicable' : capabilityGaps.length ? 'gaps' : 'ready', config, categories,
    requirements: config.requirements, sourceChecks: config.sourceChecks, capabilityGaps, limits };
}

function compare(actual, expected) {
  if (!object(expected) || !Object.hasOwn(expected, 'operator')) return isDeepStrictEqual(actual, expected);
  const value = expected.value;
  switch (expected.operator) {
    case 'eq': return isDeepStrictEqual(actual, value);
    case 'gte': return Number.isFinite(actual) && actual >= value;
    case 'lte': return Number.isFinite(actual) && actual <= value;
    case 'includes': return typeof actual === 'string' && typeof value === 'string' ? actual.includes(value) : Array.isArray(actual) && actual.some(item => isDeepStrictEqual(item, value));
    case 'oneOf': return value.some(item => isDeepStrictEqual(item, actual));
    default: return false;
  }
}

// All declared units must be present; assertions marked pass by their producer are deliberately ignored.
export function assessUIQualityCoverage(config, observations = [], context = {}) {
  const prepared = prepareUIQuality(config);
  const scoped = prepared.requirements.filter(rule => (!context.acIds || context.acIds.includes(rule.acId)) && (!context.targetIds || context.targetIds.includes(rule.targetId)));
  const gaps = prepared.capabilityGaps.filter(gap => !gap.ruleId || scoped.some(rule => key(rule) === key(gap) && rule.method === gap.method)), findings = [], results = [];
  const summary = { required: scoped.length, executed: 0, passed: 0, failed: 0, needsReview: 0, missingEvidence: 0, notExecuted: 0,
    notApplicable: prepared.categories.filter(item => item.applicability === 'not_applicable').length, gaps: 0 };
  if (!Array.isArray(observations)) throw new Error('UI observations must be an array');
  const knownEntrypoints = new Set(prepared.requirements.map(rule => rule.entrypointId));
  for (const entry of context.discoveredEntrypoints || []) {
    const id = typeof entry === 'string' ? entry : entry.id;
    if (!knownEntrypoints.has(id)) gaps.push({ code: 'unregistered_entrypoint', entrypointId: id });
  }
  // Adapter notes describe ranges outside the runtime rules; a zero rule-gap count cannot erase them.
  const coverageNotes = [...(context.coverageNotes || []), ...observations.flatMap(item => Array.isArray(item?.coverageNotes) ? item.coverageNotes : [])]
    .filter(note => object(note) && (!context.acIds || !note.acId || context.acIds.includes(note.acId)) && (!context.targetIds || !note.targetId || context.targetIds.includes(note.targetId)));
  for (const note of coverageNotes) {
    if (['capability_gap','gap','missing_evidence','not_executed'].includes(note.status)) gaps.push({ ...note, code: 'adapter_capability_gap' });
    else if (['review','needs_review'].includes(note.status)) {
      findings.push({ ...note, status: 'needs_review', certainty: 'needs_review', nextAction: 'Review the stated uncovered range and original evidence' });
      summary.needsReview++;
    } else if (note.status === 'failed') {
      findings.push({ ...note, status: 'failed', certainty: 'determinate', nextAction: 'Fix and repeat the affected actual entrypoint' });
      summary.failed++;
    }
  }
  for (const rule of scoped) {
    const matches = observations.filter(item => object(item) && key(item) === key(rule) && item.method === rule.method);
    let status = 'not_executed', reason = 'No observation for declared state and target';
    if (!matches.length) summary.notExecuted++;
    else {
      summary.executed++;
      const invalid = matches.find(item => !text(item.evidenceRef) || !Object.hasOwn(item, 'actual') || item.actual === undefined || !Object.hasOwn(item, 'expected') || !isDeepStrictEqual(item.expected, rule.expected));
      const stale = matches.some(item => ['sourceVersion','ruleVersion','environmentRef','requirementVersion','roleRef','dataScopeRef'].some(field => {
        const required = field === 'ruleVersion' ? config.ruleVersion : rule[field];
        return (required !== undefined && item[field] !== required) || (context[field] !== undefined && item[field] !== context[field]);
      }));
      const actionsMissing = matches.some(item => {
        if (!['interaction','business'].includes(rule.method)) return false;
        const actions = Array.isArray(item.actions) ? item.actions.map(action => typeof action === 'string' ? action : action?.type) : [];
        return !actions.some(action => ['input','click','key'].includes(action)) || !actions.includes('wait') || (rule.method === 'business' && !actions.includes('readback')) || (rule.actions || []).some(action => !actions.includes(action));
      });
      const reportedGap = matches.some(item => item.status !== undefined && !['passed','failed','review','needs_review'].includes(item.status));
      if (stale) { status = 'missing_evidence'; reason = 'Evidence does not match current source, rules, role, data or environment'; gaps.push({ code: 'stale_evidence', ...rule }); }
      else if (invalid || actionsMissing) { status = 'missing_evidence'; reason = actionsMissing ? 'Actual operation, wait or business readback missing' : 'Actual value, expected value or original evidence reference missing'; gaps.push({ code: actionsMissing ? 'missing_actual_actions' : 'missing_observation_material', ...rule }); }
      else if (reportedGap) { status = 'missing_evidence'; reason = 'Observation explicitly reports an unresolved capability or execution state'; gaps.push({ code: 'unresolved_observation_status', ...rule, observationStatuses: matches.map(item => item.status).filter(value => value !== undefined) }); }
      else if (matches.some(item => item.status === 'failed')) { status = 'failed'; reason = 'Observed failure remains unresolved even if another value matches'; }
      else if ((rule.method === 'review' && matches.some(item => !text(item.review?.reviewerRef) || !text(item.review?.decisionRef) || item.review?.decision !== 'accepted')) || matches.some(item => item.certainty === 'needs_review' || ['review','needs_review'].includes(item.status))) { status = 'needs_review'; reason = 'Contextual review remains unresolved'; }
      else if (matches.some(item => !compare(item.actual, rule.expected))) { status = 'failed'; reason = 'Observed value violates declared expectation'; }
      else { status = 'passed'; reason = 'Observed values satisfy the declared expectation'; }
      summary[status === 'missing_evidence' ? 'missingEvidence' : status === 'needs_review' ? 'needsReview' : status]++;
    }
    const result = { ...rule, status, reason, evidenceRefs: matches.map(item => item.evidenceRef).filter(text) };
    results.push(result);
    if (status === 'failed' || status === 'needs_review') findings.push({ ...result, actual: matches.map(item => item.actual), certainty: status === 'failed' ? 'determinate' : 'needs_review', nextAction: status === 'failed' ? 'Fix and repeat the affected actual entrypoint' : 'Review project context and original evidence' });
  }
  summary.gaps = gaps.length;
  const scope = { acIds: context.acIds || null, targetIds: context.targetIds || null, declaredRequirements: prepared.requirements.length,
    matchedRequirements: scoped.length, reason: !scoped.length && (context.acIds || context.targetIds) ? 'No declared UI requirements in requested scope; no new UI coverage claim' : 'Declared UI requirements in the requested scope' };
  const status = prepared.status === 'not_applicable' ? 'not_applicable' : prepared.status === 'not_configured' ? 'not_configured' : summary.failed ? 'failed' : gaps.length || summary.missingEvidence || summary.notExecuted || summary.needsReview ? 'incomplete' : !scoped.length && (context.acIds || context.targetIds) ? 'not_applicable' : 'passed';
  return { status, ruleVersion: config?.ruleVersion ?? null, summary, counts: summary, results, requirements: results, findings, gaps, categories: prepared.categories,
    scope, coverageNotes, exceptions: config?.exceptions || [], businessAcceptance: false, limits };
}

export async function loadUIQualityConfig(profile) {
  if (profile.uiQualityRef === undefined) return { status: 'not_configured', config: null };
  const configPath = await existingInside(profile.root, profile.uiQualityRef), config = await json(configPath);
  const validation = validateUIQualityConfig(config);
  if (!validation.valid) throw new Error(`Invalid UI quality configuration: ${validation.errors.join('; ')}`);
  return { status: config.hasUI === false ? 'not_applicable' : 'configured', config, configPath };
}
