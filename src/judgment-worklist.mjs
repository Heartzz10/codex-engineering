import { isDeepStrictEqual } from 'node:util';
import { judgmentPolicy, judgmentPolicies, validateJudgmentBundle, validateJudgmentResponse } from './judgment.mjs';
import * as routing from './judgment-routing.mjs';
import { hash } from '../skills/review-product-plan/scripts/jev-client.mjs';

const clone = value => value === undefined ? null : structuredClone(value);
const unique = values => [...new Set(values)];
const localPath = value => /(?:[A-Za-z]:[\\/]|\\\\[^\\\s]+[\\]|(?:^|[\s="'(])\/(?!\/)[^\s]+)/.test(value);
const bulkyField = key => /^(?:raw_response|probabilities|ledger|usage|source_hashes)$/i.test(key);
const fallbackReasonCodes = new Set([
  'unknown_review_policy', 'unknown_profile', 'review_scope_unverified', 'routing_changed',
  'model_or_standard_changed', 'material_scope', 'mixed_or_ineligible_kind',
  'control_disabled', 'control_paused', 'control_invalid', 'qualification_missing_or_changed',
  'qualification_unverifiable', 'source_missing', 'material_scope_unverified',
  'source_changed', 'source_unreadable', 'preflight_unverified'
]);
const inactiveRunReasons = { review_fallback: 'review_fallback', blocked: 'blocked', disabled: 'disabled',
  cancelled: 'cancelled', failed: 'failed', persistence_failed: 'persistence_failed' };

function presentationMaterial(value, redactions) {
  if (typeof value === 'string') {
    if (!localPath(value)) return value;
    redactions.paths++;
    return '[含本地路径的原文见完整原件]';
  }
  if (Array.isArray(value)) return value.map(item => presentationMaterial(item, redactions));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).flatMap(([key, item]) => {
    if (bulkyField(key)) { redactions.fields++; return []; }
    return [[key, presentationMaterial(item, redactions)]];
  }));
  return value;
}

function currentRun(bundle, run) {
  return run?.status === 'completed'
    && run.request_sha256 === bundle.request_sha256
    && run.standard_sha256 === bundle.standard_sha256
    && run.model_requested === bundle.model
    && run.uncertain_charge !== true;
}

function providerChoice(request, run, compatible) {
  if (!compatible || !Array.isArray(run.results)) return { choice: null, reason: null };
  const rows = run.results.filter(row => row?.judgment_id === request.judgment_id);
  if (rows.length === 0) return { choice: null, reason: 'response_missing' };
  if (rows.length !== 1 || !rows[0].raw_response) return { choice: null, reason: 'response_invalid' };
  try { const result = validateJudgmentResponse(rows[0].raw_response, request); return { choice: result.combined_choice, facts: result.combination?.facts ?? [], reason: null }; }
  catch { return { choice: null, reason: 'response_invalid' }; }
}

function sourceOf(bundle, item) {
  const redactions = { paths: 0, fields: 0 };
  if (item.body) {
    const state = item.body.state ?? {};
    return {
      target: presentationMaterial(state.judgment?.target ?? null, redactions),
      context: presentationMaterial(clone(state.context), redactions),
      evidence: presentationMaterial(clone(state.evidence ?? []), redactions),
      candidates: presentationMaterial(clone(state.judgment?.candidates ?? []), redactions),
      full_material_ref: { artifact: 'prepared_bundle', request_sha256: bundle.request_sha256, judgment_id: item.judgment_id },
      material_embedded: true,
      material_redacted: redactions.paths + redactions.fields > 0,
      redaction_reasons: [...(redactions.paths ? ['local_path_in_original_material'] : []), ...(redactions.fields ? ['log_field_in_original_material'] : [])]
    };
  }
  const state = item.review_material;
  return {
    target: presentationMaterial(state?.judgment?.target ?? null, redactions),
    context: presentationMaterial(clone(state?.context), redactions),
    evidence: presentationMaterial(clone(state?.evidence ?? []), redactions),
    candidates: presentationMaterial(clone(state?.judgment?.candidates ?? []), redactions),
    full_material_ref: state
      ? { artifact: 'prepared_bundle', request_sha256: bundle.request_sha256, judgment_id: item.judgment_id }
      : { artifact: 'original_packet', judgment_id: item.judgment_id },
    material_embedded: Boolean(state),
    material_redacted: redactions.paths + redactions.fields > 0,
    redaction_reasons: [...(redactions.paths ? ['local_path_in_original_material'] : []), ...(redactions.fields ? ['log_field_in_original_material'] : [])]
  };
}

/** Build a small review queue from a prepared bundle and the matching run.
 * Reuse is accepted only when the routing module recognizes its own in-process
 * routing array. Persisted or caller-authored review_routing is never authority.
 */
export function buildJudgmentWorklist(bundle, run, options = {}) {
  // Keep the API reserved for presentation options; no caller-provided trust flag.
  void options;
  const requests = Array.isArray(bundle?.requests) ? bundle.requests : [];
  const local = Array.isArray(bundle?.local_results) ? bundle.local_results : [];
  let valid = false;
  try { validateJudgmentBundle(bundle); valid = true; } catch { /* Retain every item for review. */ }
  const policy = judgmentPolicies.find(candidate => hash(candidate) === bundle?.standard_sha256) ?? judgmentPolicy;
  const mode = bundle?.review_policy?.mode === 'selective' ? 'selective' : 'advisory';
  const compatible = currentRun(bundle, run);
  const trusted = valid && compatible && mode === 'selective'
    && run?.evidence_kind === 'provider_response'
    && typeof routing.trustedReviewRouting === 'function'
    && routing.trustedReviewRouting(bundle, run);
  const routeRows = trusted && Array.isArray(run.review_routing) ? run.review_routing : [];
  const routeById = new Map(routeRows.map(row => [row.judgment_id, row]));
  const tasks = [];
  const reusedIds = [];
  const all = [...requests, ...local];
  for (const item of all) {
    const isLocal = !item.body;
    const answer = isLocal ? { choice: item.provider_choice ?? null, reason: null } : providerChoice(item, run, compatible);
    const route = routeById.get(item.judgment_id);
    const reasons = [];
    if (!valid) reasons.push('bundle_invalid');
    if (mode === 'advisory') reasons.push('advisory_mode');
    else if (!trusted) reasons.push('routing_untrusted');
    if (!run) reasons.push('run_missing');
    else if (!compatible) reasons.push(inactiveRunReasons[run.status] ?? 'run_not_current');
    else if (run.evidence_kind !== 'provider_response') reasons.push('adapter_fixture');
    if (isLocal) reasons.push('local_result');
    if (answer.reason) reasons.push(answer.reason);
    if (trusted) reasons.push(...(Array.isArray(route?.reason_codes) ? route.reason_codes : ['routing_missing']));
    else if (run?.status === 'review_fallback' && Array.isArray(run.review_routing)) {
      const hints = run.review_routing.filter(row => row?.judgment_id === item.judgment_id && row.action === 'codex_review');
      if (hints.length === 1 && Array.isArray(hints[0].reason_codes)) reasons.push(...hints[0].reason_codes.filter(code => fallbackReasonCodes.has(code)));
    }
    const material = sourceOf(bundle, item);
    if (!material.material_embedded) reasons.push('local_material_not_embedded');
    reasons.push(...material.redaction_reasons);
    const reuse = trusted && !isLocal && route?.action === 'reuse_supported'
      && answer.choice === (policy.contract_version ? 'yes' : 'supported') && reasons.length === 0;
    if (reuse) { reusedIds.push(item.judgment_id); continue; }
    if (trusted && route?.action === 'codex_review' && reasons.length === 0) reasons.push('routing_codex_review');
    tasks.push({ judgment_id: item.judgment_id, kind: item.kind, ...material,
      provider_choice: answer.choice, question_results: answer.facts ?? [], combination_version: item.combination_version ?? null, reason_codes: unique(reasons) });
  }
  const kinds = unique(all.map(item => item.kind)).filter(kind => Object.hasOwn(policy.kinds, kind));
  return {
    schema_version: 1,
    mode,
    status: run?.status ?? 'not_run',
    provider_choice_role: 'advisory_only',
    counts: { total: all.length, codex_review: tasks.length, reused: reusedIds.length },
    reused_ids: reusedIds,
    standard: { version: policy.version, sha256: hash(policy), validated: valid && bundle.standard_sha256 === hash(policy),
      common_instructions: policy.common_instructions, kinds: Object.fromEntries(kinds.map(kind => [kind, policy.kinds[kind]])), criteria: clone(policy.criteria) },
    codex_tasks: tasks
  };
}

/** Pool repeated presentation material without changing routing or reuse decisions. */
export function compactJudgmentWorklist(worklist) {
  const context_pool = [];
  const evidence_pool = [];
  const pool = (value, values) => {
    const existing = values.findIndex(item => isDeepStrictEqual(item, value));
    if (existing !== -1) return existing;
    const index = values.length;
    values.push(structuredClone(value));
    return index;
  };
  const codex_tasks = worklist.codex_tasks.map(({ context, evidence: citations, ...task }) => ({
    ...task,
    context_ref: pool(context, context_pool),
    evidence_refs: citations.map(item => pool(item, evidence_pool))
  }));
  return {
    schema_version: worklist.schema_version,
    mode: worklist.mode,
    status: worklist.status,
    provider_choice_role: worklist.provider_choice_role,
    counts: clone(worklist.counts),
    reused_ids: clone(worklist.reused_ids),
    standard: clone(worklist.standard),
    context_pool,
    evidence_pool,
    codex_tasks
  };
}
