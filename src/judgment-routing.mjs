import { combineBinaryAnswers, legacyAnswerById } from './judgment-binary.mjs';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hash, plain, text, normalize, validateChoices, requestKey } from '../skills/review-product-plan/scripts/jev-client.mjs';

export const reviewRoutingPolicy = JSON.parse(await readFile(new URL('../policies/judgments-routing.json', import.meta.url), 'utf8'));
const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const shaText = value => createHash('sha256').update(value).digest('hex');
const exactKeys = (value, keys) => plain(value) && Object.keys(value).sort().join('|') === [...keys].sort().join('|');

export function profileRulesSha(profileId, profile) {
  return hash({ profile_id: profileId, kind: profile.kind, allowed_material_scopes: profile.allowed_material_scopes, model: profile.model, standard_sha256: profile.standard_sha256, contract_version: profile.contract_version, combination_version: profile.combination_version, audit_algorithm: profile.audit_algorithm, audit_percent: profile.audit_percent, allowed_copy_categories: profile.allowed_copy_categories, excluded_effects: profile.excluded_effects });
}

export function routingSha(bundle, policy = reviewRoutingPolicy) {
  const id = bundle.review_policy?.profile_id;
  const profile = policy.profiles?.[id];
  if (!profile) return null;
  return hash({ review_policy: bundle.review_policy, review_scope: bundle.review_scope ?? null, request_sha256: bundle.request_sha256, source_hashes: bundle.source_hashes, routing_policy_version: policy.version, profile_rules_sha256: profileRulesSha(id, profile), qualification_sha256: profile.qualification ? hash(profile.qualification) : null });
}

export function auditSelected(body, percent) {
  return Number.parseInt(hash(body).slice(0, 8), 16) % 100 < percent;
}

const fallback = (bundle, reasonCodes) => ({ eligible: false, reason_codes: reasonCodes, profile_id: bundle.review_policy?.profile_id ?? null, qualification_sha256: null });
const verifiedPreflights = new WeakMap();
const verifiedRoutingResults = new WeakMap();
const bundleIdentity = bundle => hash(bundle);
const runIdentity = run => hash({ status: run.status, model: run.model_requested,
  request: run.request_sha256, standard: run.standard_sha256, evidence_kind: run.evidence_kind,
  uncertain_charge: run.uncertain_charge, results: run.results, local_results: run.local_results });

// A serialized result is evidence to inspect, not authority to skip Codex.
// Only a fresh, unchanged decision from this process can authorize the worklist.
export function trustedReviewRouting(bundle, run) {
  try {
    const routes = run?.review_routing;
    const proof = verifiedRoutingResults.get(routes);
    return !!proof && proof.bundle === bundleIdentity(bundle) && proof.run === runIdentity(run) && proof.routes === hash(routes);
  } catch { return false; }
}
const within = (file, root) => { const relative = path.relative(root, file); return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };
// This checks an attributed declaration. It cannot establish semantic risk;
// the reviewer remains responsible for recognizing excluded UI copy.
function reviewScopeVerified(scope, profile) {
  return exactKeys(scope, ['category', 'impact', 'decision_ref', 'reviewer_ref', 'checked_exclusions', 'present_effects'])
    && profile.allowed_copy_categories?.includes(scope.category) && scope.impact === 'low'
    && text(scope.decision_ref) && text(scope.reviewer_ref)
    && Array.isArray(scope.checked_exclusions) && Array.isArray(profile.excluded_effects)
    && scope.checked_exclusions.length === profile.excluded_effects.length
    && new Set(scope.checked_exclusions).size === scope.checked_exclusions.length
    && scope.checked_exclusions.every(effect => profile.excluded_effects.includes(effect))
    && Array.isArray(scope.present_effects) && scope.present_effects.length === 0;
}
export async function verifyQualificationEvidence(qualification, profileId, profile, stateRoot) {
  if (!plain(qualification) || qualification.status !== 'qualified' || qualification.profile_id !== profileId || qualification.model !== profile.model || qualification.standard_sha256 !== profile.standard_sha256 || qualification.profile_rules_sha256 !== profileRulesSha(profileId, profile)) return false;
  const refs = qualification.evidence;
  if (!text(stateRoot) || !plain(refs) || !['dataset', 'run', 'ledger', 'comparison'].every(key => plain(refs[key]) && text(refs[key].path) && /^[a-f0-9]{64}$/.test(refs[key].sha256))) return false;
  try {
    const records = {};
    for (const key of ['dataset', 'run', 'ledger', 'comparison']) {
      const file = path.resolve(stateRoot, refs[key].path);
      if (!within(file, path.resolve(stateRoot))) return false;
      const raw = normalize(await readFile(file, 'utf8'));
      if (shaText(raw) !== refs[key].sha256) return false;
      records[key] = JSON.parse(raw);
    }
    const { dataset, run, ledger, comparison } = records;
    if (!profile.allowed_material_scopes.includes(dataset.material_scope) || dataset.review_profile_id !== profileId || dataset.request_sha256 !== hash(dataset.requests) || run.request_sha256 !== dataset.request_sha256 || run.standard_sha256 !== profile.standard_sha256 || run.model_requested !== profile.model || run.status !== 'completed' || run.evidence_kind !== 'provider_response') return false;
    if (!Array.isArray(dataset.cases) || !Array.isArray(dataset.requests) || !Array.isArray(run.results) || !Array.isArray(ledger.entries) || dataset.cases.filter(c => c.split === 'holdout').length < 12) return false;
    const requests = new Map(dataset.requests.map(r => [r.judgment_id, r])); const results = new Map(run.results.map(r => [r.judgment_id, r]));
    if (requests.size !== dataset.requests.length || results.size !== run.results.length) return false;
    const caseIds = new Set();
    for (const c of dataset.cases) {
      if (!plain(c) || !text(c.id) || caseIds.has(c.id) || !['calibration', 'holdout'].includes(c.split) || !requests.has(c.id) || requests.get(c.id).kind !== c.kind) return false;
      caseIds.add(c.id);
    }
    let correct = 0; let baselineCorrect = 0; let unsafeSupports = 0;
    for (const c of dataset.cases.filter(c => c.split === 'holdout')) {
      if (c.kind !== profile.kind || !(profile.contract_version ? ['yes', 'no', 'unknown'] : ['supported', 'unsupported', 'insufficient', 'no_match']).includes(c.expected_choice) || !(profile.contract_version ? ['yes', 'no', 'unknown'] : ['supported', 'unsupported', 'insufficient', 'no_match']).includes(c.baseline_choice)) return false;
      const request = requests.get(c.id); const row = results.get(c.id);
      if (!request || !row || row.origin !== 'live' || !row.raw_response || !ledger.entries.some(e => e.status === 'completed' && e.evidence_kind === 'provider_response' && e.request_key === hash({ model: profile.model, standard_sha256: profile.standard_sha256, body: request.body }))) return false;
      const answers = validateChoices(row.raw_response, request); const answer = { provider_choice: request.question_contracts ? combineBinaryAnswers(request, answers).choice : legacyAnswerById(request, answers)?.provider_choice };
      if (answer.provider_choice === c.expected_choice) correct++;
      else if (['yes', 'supported'].includes(answer.provider_choice)) unsafeSupports++;
      if (c.baseline_choice === c.expected_choice) baselineCorrect++;
    }
    const count = dataset.cases.filter(c => c.split === 'holdout').length;
    if (correct !== count || unsafeSupports !== 0 || correct < baselineCorrect) return false;
    const workParts = ['material_preparation_ms', 'api_wait_ms', 'fallback_ms', 'audit_ms', 'review_ms', 'rework_ms'];
    if (comparison.original_workflow_measured !== true || !Number.isSafeInteger(comparison.actual_replaced_judgments) || comparison.actual_replaced_judgments <= 0 || comparison.business_checks_preserved !== true || comparison.ui_review_preserved !== true || !(comparison.original_judgment_ms > 0) || workParts.some(key => !Number.isFinite(comparison[key]) || comparison[key] < 0)) return false;
    const savedMs = comparison.original_judgment_ms - workParts.reduce((sum, key) => sum + comparison[key], 0);
    if (!(savedMs > 0) || comparison.net_time_saved_ms !== savedMs) return false;
    // These JSON records establish consistency, not the provenance of Codex
    // choices, token usage, or measured replacement. No native receipt verifier
    // is installed, so a locally authored qualification cannot enable bypass.
    return false;
  } catch { return false; }
}

export async function preflightReviewRouting(bundle, { policy = reviewRoutingPolicy, qualification, control, stateRoot, readSource = file => readFile(file, 'utf8') } = {}) {
  if (!bundle.review_policy) return fallback(bundle, ['advisory_mode']);
  const selected = bundle.review_policy;
  if (!exactKeys(selected, ['mode', 'profile_id']) || selected.mode !== 'selective' || selected.profile_id !== 'ordinary_ui_copy_fidelity_v2') return fallback(bundle, ['unknown_review_policy']);
  const profile = policy.profiles?.[selected.profile_id];
  if (!profile || policy.schema_version !== 1 || policy.default_mode !== 'advisory') return fallback(bundle, ['unknown_profile']);
  if (!reviewScopeVerified(bundle.review_scope, profile)) return fallback(bundle, ['review_scope_unverified']);
  if (bundle.routing_policy_version !== policy.version || bundle.profile_rules_sha256 !== profileRulesSha(selected.profile_id, profile) || bundle.routing_sha256 !== routingSha(bundle, policy)) return fallback(bundle, ['routing_changed']);
  if (bundle.model !== profile.model || bundle.standard_sha256 !== profile.standard_sha256) return fallback(bundle, ['model_or_standard_changed']);
  if (!profile.allowed_material_scopes.includes(bundle.material_scope)) return fallback(bundle, ['material_scope']);
  if (!Array.isArray(bundle.requests) || bundle.requests.length === 0 || !Array.isArray(bundle.local_results) || bundle.local_results.length || bundle.requests.some(r => r.kind !== profile.kind)) return fallback(bundle, ['mixed_or_ineligible_kind']);
  if (!plain(control) || control.schema_version !== 1 || !plain(control.profiles)) return fallback(bundle, ['control_disabled']);
  const state = control.profiles[selected.profile_id];
  if (!plain(state) || state.mode === 'disabled' || !state.mode) return fallback(bundle, ['control_disabled']);
  if (state.mode === 'paused') return fallback(bundle, ['control_paused']);
  if (state.mode !== 'trial') return fallback(bundle, ['control_invalid']);
  const proof = qualification ?? profile.qualification;
  const qualificationSha = proof ? hash(proof) : null;
  if (!proof || !qualificationSha || bundle.qualification_sha256 !== qualificationSha || state.qualification_sha256 !== qualificationSha) return fallback(bundle, ['qualification_missing_or_changed']);
  if (!await verifyQualificationEvidence(proof, selected.profile_id, profile, stateRoot)) return fallback(bundle, ['qualification_unverifiable']);
  if (!plain(bundle.source_hashes) || !Object.keys(bundle.source_hashes).length) return fallback(bundle, ['source_missing']);
  for (const [file, expected] of Object.entries(bundle.source_hashes)) {
    const allowed = profile.approved_source_roots?.some(root => within(path.resolve(file), path.resolve(packageRoot, root))) || (text(stateRoot) && within(path.resolve(file), path.resolve(stateRoot, 'judgments/public-materials')));
    if (!allowed) return fallback(bundle, ['material_scope_unverified']);
    try { if (shaText(normalize(await readSource(file))) !== expected) return fallback(bundle, ['source_changed']); }
    catch { return fallback(bundle, ['source_unreadable']); }
  }
  const verified = { eligible: true, reason_codes: [], profile_id: selected.profile_id, qualification_sha256: qualificationSha };
  verifiedPreflights.set(verified, bundle.routing_sha256);
  return verified;
}

export function validCachedReviewReceipt(request, row, ledger, standardSha, cacheScope) {
  const key = requestKey(request, standardSha, cacheScope);
  const entry = ledger?.entries?.find(e => e.id === row?.source_entry && e.status === 'completed' && e.evidence_kind === 'provider_response' && e.request_key === key);
  const cached = ledger?.cache?.[key];
  return !!row?.source_entry && !!entry && row.source_evidence_kind === 'provider_response' &&
    cached?.evidence_kind === 'provider_response' && cached?.source_entry === row.source_entry &&
    cached?.request_sha256 === hash(request.body) && hash(cached.raw_response) === hash(row.raw_response);
}

export function resolveReviewRouting(bundle, run, { preflight, validateResponse, policy = reviewRoutingPolicy, ledger, cacheScope } = {}) {
  const id = bundle.review_policy?.profile_id;
  const profile = policy.profiles?.[id];
  const baseReasons = !bundle.review_policy ? ['advisory_mode'] : !preflight?.eligible ? preflight?.reason_codes ?? ['preflight_missing']
    : verifiedPreflights.get(preflight) !== bundle.routing_sha256 ? ['preflight_unverified'] : [];
  const currentRun = run?.status === 'completed' && run.evidence_kind === 'provider_response' && run.request_sha256 === bundle.request_sha256 && run.standard_sha256 === bundle.standard_sha256 && run.model_requested === bundle.model && run.uncertain_charge !== true;
  const review_routing = [...(bundle.requests ?? []), ...(bundle.local_results ?? [])].map(request => {
    const reason_codes = [...baseReasons];
    if (!reason_codes.length && !currentRun) reason_codes.push('run_not_current');
    if (!reason_codes.length && request.provider_choice) reason_codes.push('local_result');
    const row = (run?.results ?? []).find(r => r.judgment_id === request.judgment_id);
    if (!reason_codes.length && (!row?.raw_response || !['live', 'cache'].includes(row.origin))) reason_codes.push('raw_response_missing');
    if (!reason_codes.length && row.origin === 'cache') {
      if (!validCachedReviewReceipt(request, row, ledger, bundle.standard_sha256, cacheScope)) reason_codes.push('cache_provenance_missing');
    }
    if (!reason_codes.length) {
      try {
        const answer = validateResponse(row.raw_response, request);
        if (answer.combined_choice !== 'yes') reason_codes.push(`provider_${answer.combined_choice}`);
      } catch { reason_codes.push('raw_response_invalid'); }
    }
    if (!reason_codes.length && profile && auditSelected(request.body, profile.audit_percent)) reason_codes.push('audit_selected');
    return { judgment_id: request.judgment_id, action: reason_codes.length ? 'codex_review' : 'reuse_supported', reason_codes, profile_id: id ?? null, qualification_sha256: preflight?.qualification_sha256 ?? null };
  });
  if (!baseReasons.length && currentRun) verifiedRoutingResults.set(review_routing,
    { bundle: bundleIdentity(bundle), run: runIdentity(run), routes: hash(review_routing) });
  return { review_routing };
}
