import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { scopedPath, readMap, hashContent, parseStrictJson } from './feature-store.mjs';
import { validateMap } from './feature.mjs';
import { readScopedRecords } from './records.mjs';
import { selectResources } from './catalog.mjs';
import { taskScope } from './task-scope.mjs';
import { loadEngineeringRules, assessEngineeringRules, currentCheck } from './engineering-rules.mjs';
import { assessCoverage } from './acceptance.mjs';
import { getDebugProtocol } from './pstack.mjs';
import { buildProjectJudgments, verifyProjectJudgmentSources } from './judgment-project.mjs';
import { prepareJudgments, validateJudgmentBundle, judgmentPolicy } from './judgment.mjs';
import { PACKAGE_ROOT, DEFAULT_STATE, assert } from './paths.mjs';
import { validateLedger, requestKey, hash, MODEL } from '../skills/review-product-plan/scripts/jev-client.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const projection = context => { const { created_at, context_sha256, ...rest } = context; return rest; };
const list = value => Array.isArray(value) ? value : [];
const expansionKinds = new Set(['new_change', 'new_failure', 'new_evidence', 'unknown_impact', 'shared_interface_change', 'permission_change', 'cost_change', 'recovery_change']);

/** A local, read-only projection of existing originals, checks and worklists. */
export async function buildTaskContext(profile, { task, changeId, acIds, stateRoot = DEFAULT_STATE } = {}) {
  assert(task && typeof task === 'object' && typeof task.description === 'string' && task.description.trim(), 'task_description_required');
  const scope = taskScope(task, profile);
  assert(scope.shortPath || ['discovery', 'implementation', 'debugging', 'verification', 'ui', 'interface', 'interaction'].includes(task.kind), 'task_kind_invalid');
  assert(!(changeId && acIds), 'selection_requires_change_or_acIds');
  if (acIds !== undefined) assert(Array.isArray(acIds) && acIds.length > 0 && new Set(acIds).size === acIds.length, 'acIds_invalid');
  const short = task.smallChange === true || scope.shortPath;
  const readOnlyExplanation = ['explanation', 'consultation', 'concept'].includes(scope.kind) || ['explanation', 'consultation', 'concept'].includes(scope.workType);
  const context = { schema_version: 1, project_id: profile.id, task: structuredClone(task), selection: { changeId: changeId ?? null, acIds: acIds ?? null },
    path: short ? 'short' : 'standard', provider_calls: 0, relevance_enabled: false, business_verified: false,
    must_read: [], optional_read: [], gaps: [], todo: [], historical_changes: [], manifest: [], records_manifest: [], judgment_plan: null,
    profile_binding: hashContent(JSON.parse(JSON.stringify(profile))) };
  const seen = new Map(), sources = new Map();
  async function original(ref, kind, collection = context.must_read, root = profile.root, namespace = 'project') {
    const reference = typeof ref === 'string' ? { path: ref.split('#')[0] } : ref;
    if (!reference?.path) { context.gaps.push({ code: 'source_ref_missing', kind }); return null; }
    try {
      const file = await scopedPath(root, reference.path);
      const sourceKey = `${namespace}:${file}`;
      const binary = kind === 'evidence_original' && !['.json', '.md', '.txt', '.csv', '.html', '.log', '.mjs', '.js'].includes(path.extname(reference.path).toLowerCase());
      const maximumBytes = ((reference.path === profile.featureMapRef?.path && namespace === 'project') || binary ? 16 : 1) * 1024 * 1024;
      if (!sources.has(sourceKey)) {
        const stat = await fs.stat(file);
        assert(stat.isFile() && stat.size <= maximumBytes, 'source_size_or_type_invalid');
        const bytes = await fs.readFile(file);
        assert(bytes.length <= maximumBytes, 'source_size_or_type_invalid');
        sources.set(sourceKey, { bytes, text: binary ? null : new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '') });
      }
      const data = sources.get(sourceKey), bytes = data.bytes;
      let value = data.text;
      if (binary) value = { format: 'binary_original_reference', type: reference.type ?? path.extname(reference.path).slice(1), bytes: bytes.length };
      const binding = { namespace, path: reference.path.replace(/\\/g, '/'), sha256: sha(bytes), bytes: bytes.length };
      if (reference.sha256 !== undefined) assert(reference.sha256 === binding.sha256, 'original_hash_mismatch');
      if (typeof reference.pointer === 'string') {
        assert(reference.pointer === '' || reference.pointer.startsWith('/'), 'pointer_invalid');
        data.json ??= parseStrictJson(value); value = data.json;
        for (const token of reference.pointer === '' ? [] : reference.pointer.slice(1).split('/')) {
          assert(!/~(?![01])/.test(token), 'pointer_invalid');
          const key = token.replace(/~1/g, '/').replace(/~0/g, '~');
          assert(value !== null && typeof value === 'object' && Object.hasOwn(value, key), 'pointer_missing');
          value = value[key];
        }
        binding.selector = { pointer: reference.pointer };
      } else if (reference.startLine !== undefined || reference.endLine !== undefined) {
        const lines = value.replace(/\r\n?/g, '\n').split('\n');
        assert(Number.isInteger(reference.startLine) && reference.startLine > 0 && Number.isInteger(reference.endLine) && reference.endLine >= reference.startLine && reference.endLine <= lines.length, 'line_range_invalid');
        value = lines.slice(reference.startLine - 1, reference.endLine).join('\n');
        binding.selector = { startLine: reference.startLine, endLine: reference.endLine };
      }
      const key = `${namespace}:${binding.path}`;
      if (seen.has(key)) assert(seen.get(key).sha256 === binding.sha256, 'source_changed_during_prepare');
      else { seen.set(key, binding); context.manifest.push({ namespace, path: binding.path, sha256: binding.sha256, bytes: binding.bytes }); }
      const item = { kind, source_ref: file, binding, value };
      collection.push(item); return item;
    } catch (error) { context.gaps.push({ code: 'source_unreadable', kind, path: reference.path, reason: error.code ?? error.message }); return null; }
  }
  for (const ref of profile.authoritativeDocuments ?? []) await original(ref, 'project_agreement');
  if (profile.featureMapDocument) await original(profile.featureMapDocument, 'documented_feature_map');
  for (const ref of [profile.engineeringRulesRef, profile.uiQualityRef].filter(Boolean)) await original(ref, 'check_configuration');
  if (!readOnlyExplanation) for (const check of profile.checks ?? []) context.todo.push({ kind: 'program_check', check_id: check.id, status: 'not_executed', authorization_ref: check.authorizationRef, inputs: check.inputs });
  if (task.smallChange === true && !readOnlyExplanation && profile.checks?.length) context.check_scope_note = '项目检查尚未声明完整适用范围；指纹输入与已选AC关联不足以排除其他检查，保留现有必需检查，按原入口核受影响范围。';
  try {
    const scoped = await readScopedRecords(stateRoot, { scope: `project:${profile.id}` });
    context.records_manifest = scoped.manifest;
    for (const record of scoped.records) context.must_read.push({ kind: record.kind, source_ref: path.resolve(stateRoot, record.binding.path), binding: { namespace: 'state', ...record.binding }, value: record });
  } catch (error) { context.gaps.push({ code: 'records_unreadable', reason: error.message }); }
  const expansionFacts = [];
  assert(task.verificationFacts === undefined || Array.isArray(task.verificationFacts), 'verification_facts_invalid');
  for (const fact of task.verificationFacts ?? []) {
    assert(fact && expansionKinds.has(fact.kind) && typeof fact.fact === 'string' && fact.fact.trim() && !/[\r\n]/.test(fact.fact)
      && (typeof fact.sourceRef === 'string' ? fact.sourceRef.trim() : typeof fact.sourceRef?.path === 'string' && fact.sourceRef.path.trim()), 'verification_fact_invalid');
    const source = await original(fact.sourceRef, 'verification_expansion_fact');
    if (source) expansionFacts.push({ kind: fact.kind, fact: fact.fact, source_ref: source.source_ref, binding: source.binding });
  }
  let map = null, selectedCriteria = [];
  if (profile.featureMapRef) {
    try { map = await readMap(profile); validateMap(map); }
    catch (error) { context.gaps.push({ code: 'feature_map_unreadable', reason: error.message }); }
  } else if (changeId || acIds) context.gaps.push({ code: 'feature_map_binding_missing' });
  if (map) {
    const mapRef = profile.featureMapRef.path;
    // Read the full original hash while keeping only selected entities in the packet.
    const mapOriginal = await original({ path: mapRef, pointer: '/contentHash' }, 'feature_map');
    if (mapOriginal?.value !== map.contentHash) context.gaps.push({ code: 'source_changed_during_prepare', path: mapRef });
    const change = changeId ? map.changes.find(row => row.id === changeId) : null;
    if (changeId) assert(change, `unknown_change_id:${changeId}`);
    if (acIds) for (const id of acIds) assert(map.acceptanceCriteria.some(row => row.id === id), `unknown_ac_id:${id}`);
    const featureIds = new Set(change?.featureIds ?? []);
    for (const ac of map.acceptanceCriteria) if (acIds?.includes(ac.id) || change?.acIds.includes(ac.id)) featureIds.add(ac.featureId);
    // Keep deterministic implementation dependency closure; optional sorting cannot shrink it.
    let previous = -1;
    while (previous !== featureIds.size) {
      previous = featureIds.size;
      for (const f of map.features) if (featureIds.has(f.id)) for (const id of f.dependencyIds ?? []) featureIds.add(id);
    }
    const criteria = map.acceptanceCriteria.filter(ac => featureIds.has(ac.featureId));
    selectedCriteria = criteria;
    const reqIds = new Set([...list(change?.requirementIds), ...criteria.flatMap(ac => ac.requirementIds)]);
    for (const f of map.features) if (featureIds.has(f.id)) for (const id of f.requirementIds) reqIds.add(id);
    for (const [collection, kind, predicate] of [
      ['requirements', 'requirement', row => reqIds.has(row.id)], ['features', 'feature', row => featureIds.has(row.id)],
      ['acceptanceCriteria', 'acceptance_contract', row => criteria.includes(row)], ['changes', 'current_change', row => row === change]
    ]) for (const [index, row] of map[collection].entries()) if (predicate(row)) {
      await original({ path: mapRef, pointer: `/${collection}/${index}` }, kind);
      for (const ref of list(row.decisionEvidenceRefs)) await original(ref, 'decision_original');
      for (const ref of [...list(row.implementationRefs), ...list(row.dependencyRefs)]) await original(ref, 'implementation_original');
      if (kind === 'acceptance_contract') for (const assertion of [...list(row.assertions), ...row.requiredTargets.flatMap(target => list(target.assertions))]) {
        if (assertion.semanticReview?.targetRef) await original(assertion.semanticReview.targetRef, 'acceptance_target_original');
      }
      if (kind === 'requirement') {
        for (const question of list(row.openQuestions)) context.gaps.push({ code: 'open_question', id: row.id, question });
        if (row.decision !== 'accepted') context.gaps.push({ code: 'requirement_not_accepted', id: row.id, decision: row.decision });
      }
    }
    for (const ac of criteria) {
      const evidence = map.evidence.filter(row => row.acId === ac.id);
      context.must_read.push(...evidence.map(row => ({ kind: 'historical_evidence', source_ref: mapRef, value: structuredClone(row) })));
      for (const row of evidence) for (const ref of list(row.rawEvidence)) await original(ref, 'evidence_original');
      if (!readOnlyExplanation) context.todo.push({ kind: 'acceptance', ac_id: ac.id, ac_revision: ac.revision, status: 'review_existing_or_execute',
        required_targets: structuredClone(ac.requiredTargets), evidence_ids: evidence.map(row => row.id), expected: ac.expected });
      if (!evidence.length) context.gaps.push({ code: 'acceptance_not_recorded', ac_id: ac.id });
      for (const row of evidence) if (row.result !== 'passed' || row.applicability !== 'current') context.gaps.push({ code: 'historical_acceptance_unresolved', ac_id: ac.id, evidence_id: row.id, result: row.result, applicability: row.applicability ?? 'unknown' });
    }
    context.historical_changes = map.changes.filter(row => row !== change && row.featureIds.some(id => featureIds.has(id))).map(row => ({ id: row.id, status: row.status, reason: row.reason, source_ref: row.sourceRef, map_ref: mapRef }));
    for (const row of context.historical_changes) if (!['closed', 'cancelled'].includes(row.status)) context.gaps.push({ code: 'historical_change_unverified', change_id: row.id, status: row.status });
    for (const carry of map.carryForward ?? []) if (featureIds.has(carry.featureId) || reqIds.has(carry.sourceId)) context.must_read.push({ kind: 'carry_forward', source_ref: mapRef, value: structuredClone(carry) });
    if (!short && (changeId || acIds)) context.judgment_plan = await buildProjectJudgments(profile, map, changeId ? { changeId } : { acIds });
  }
  if (!short) {
    for (const resource of await selectResources(task, profile)) await original(resource.path, 'selected_standard', context.must_read, PACKAGE_ROOT, 'package');
    if (task.kind === 'debugging') {
      const protocol = await getDebugProtocol({ outcome: 'repair', taskScale: 'bounded' });
      context.debug_protocol = protocol;
      for (const ref of protocol.sourceRefs ?? []) await original(path.relative(PACKAGE_ROOT, ref.localPath), 'debug_playbook', context.optional_read, PACKAGE_ROOT, 'package');
    }
  }
  // Project the existing executor/assessor results, never write another pass state.
  const verification = { required_checks: [], required_targets: [], reusable: [], pending: [], expansion_facts: expansionFacts,
    scope: 'Existing registered checks retained; fingerprint inputs do not establish applicability. Release and full UI/business gates are unchanged.',
    completion: { status: readOnlyExplanation ? 'read_only' : 'pending', conditions: [] } };
  context.verification = verification;
  if (!readOnlyExplanation) {
    let configuredProfile = profile, rules = null;
    try {
      if (profile.engineeringRulesRef) {
        const loaded = await loadEngineeringRules(profile);
        configuredProfile = { ...profile, engineeringRules: loaded.config, engineeringRuleInputs: loaded.checkInputs ?? {}, engineeringCatalogHash: loaded.catalogHash ?? null };
        rules = await assessEngineeringRules(profile, { stateRoot, ...(map ? { map } : {}) });
        verification.engineering_rules = { status: rules.status, config_ref: rules.configRef, counts: rules.counts };
      }
    } catch (error) {
      context.gaps.push({ code: 'verification_rules_unreadable', reason: error.message });
      verification.engineering_rules = { status: 'unknown', config_ref: profile.engineeringRulesRef };
    }
    for (const check of profile.checks ?? []) {
      const ruleLinked = list(configuredProfile.engineeringRules?.bindings).some(row => row.checkIds.includes(check.id));
      let assessed;
      try {
        assessed = rules?.checks?.find(row => row.checkId === check.id) ?? await currentCheck(configuredProfile, check.id, stateRoot);
        if (verification.engineering_rules?.status === 'unknown') assessed = { ...assessed, status: 'unknown', reason: 'rule_configuration_unverified' };
      } catch (error) { assessed = { status: 'unknown', checkId: check.id, reason: error.message }; }
      const item = { kind: 'program_check', check_id: check.id, status: assessed.status, entrypoint: ruleLinked ? 'rules run' : 'run',
        evidence_ref: assessed.evidence ?? null, reason: assessed.reason ?? null,
        next_action: assessed.status === 'passed' ? 'reuse_existing_receipt' : assessed.status === 'failed' ? 'inspect_evidence_change_hypothesis' : assessed.status === 'unknown' ? 'inspect_original_evidence' : 'execute_existing_entrypoint' };
      verification.required_checks.push(item);
      if (assessed.evidence) await original({ path: path.relative(stateRoot, assessed.evidence), pointer: '/fingerprint' }, 'program_check_receipt', context.optional_read, stateRoot, 'state');
      if (assessed.status === 'passed') verification.reusable.push({ ...item });
      else verification.pending.push({ ...item });
    }
    if (map && selectedCriteria.length) {
      const coverage = await assessCoverage(profile, map, selectedCriteria.map(ac => ac.id));
      verification.acceptance = { status: coverage.status, ui_quality: coverage.uiQuality, gaps: coverage.gaps };
      for (const ac of selectedCriteria) for (const target of ac.requiredTargets) {
        const assessed = coverage.conditions.find(row => row.acId === ac.id)?.targets.find(row => row.targetId === target.targetId);
        const item = { kind: 'acceptance', ac_id: ac.id, ac_revision: ac.revision, ...structuredClone(target), status: assessed?.status ?? 'not_run',
          evidence_ids: assessed?.evidenceIds ?? [], reasons: assessed?.reasons ?? [] };
        verification.required_targets.push(item);
        if (item.status === 'passed') {
          verification.reusable.push({ ...item, reuse_condition: 'review_current_external_state_with_existing_acceptance_gate' });
          verification.pending.push({ ...item, status: 'review_current_external_state', next_action: 'confirm_role_configuration_data_and_live_state_before_reuse' });
        } else verification.pending.push({ ...item, next_action: item.status === 'failed' ? 'inspect_evidence_change_hypothesis' : 'execute_existing_acceptance_entrypoint' });
      }
    }
    // Keep the original task worklist shape; a reused process result never closes AC work.
    context.todo = context.todo.filter(row => row.kind !== 'program_check' || !verification.reusable.some(item => item.kind === 'program_check' && item.check_id === row.check_id));
    for (const row of context.todo.filter(row => row.kind === 'program_check')) Object.assign(row, verification.required_checks.find(item => item.check_id === row.check_id));
    for (const row of context.todo.filter(row => row.kind === 'acceptance')) {
      const targets = verification.required_targets.filter(item => item.ac_id === row.ac_id);
      row.status = targets.length && targets.every(item => item.status === 'passed') ? 'review_current_external_state' : 'review_existing_or_execute';
      row.target_results = targets;
    }
    verification.completion.conditions = [
      { kind: 'program_checks', status: verification.required_checks.every(row => row.status === 'passed') ? 'satisfied' : 'pending' },
      { kind: 'business_acceptance', status: selectedCriteria.length ? 'pending' : scope.shortPath && !scope.ui ? 'not_required' : 'not_selected',
        limitation: 'Recorded target evidence cannot establish unchanged live role, configuration, data or external state; final decision stays with the existing acceptance gate.' },
      { kind: 'engineering_rules', status: !profile.engineeringRulesRef ? 'not_configured' : ['passed', 'not_applicable'].includes(verification.engineering_rules?.status) ? 'satisfied' : 'pending' },
      { kind: 'full_ui_quality', status: !profile.uiQuality ? 'not_configured' : ['passed', 'not_applicable'].includes(verification.acceptance?.ui_quality?.status) ? 'satisfied' : 'pending' }
    ];
  }
  for (const binding of context.manifest) {
    const root = binding.namespace === 'package' ? PACKAGE_ROOT : binding.namespace === 'state' ? stateRoot : profile.root;
    try {
      const file = await scopedPath(root, binding.path);
      if (sha(await fs.readFile(file)) !== binding.sha256) context.gaps.push({ code: 'source_changed_during_prepare', path: binding.path });
    } catch { context.gaps.push({ code: 'source_changed_during_prepare', path: binding.path }); }
  }
  if (!readOnlyExplanation) {
    verification.completion.conditions.push({ kind: 'current_originals', status: context.gaps.some(row => ['source_unreadable', 'source_ref_missing', 'source_changed_during_prepare', 'feature_map_unreadable', 'records_unreadable', 'verification_rules_unreadable'].includes(row.code)) ? 'pending' : 'satisfied' });
    if (verification.completion.conditions.every(row => ['satisfied', 'not_required', 'not_configured'].includes(row.status))) verification.completion.status = 'evidence_ready_for_existing_gate';
  }
  context.status = context.gaps.length ? 'local_ready_with_gaps' : 'local_ready';
  context.summary = `本地必读 ${context.must_read.length} 项，补充 ${context.optional_read.length} 项，缺口 ${context.gaps.length} 项，待办 ${context.todo.length} 项；Jev 0 次，${readOnlyExplanation ? '只读解释不安排工程执行，历史未验收状态保留' : '业务验收仍按原入口执行'}。`;
  context.context_sha256 = hashContent(projection(context)); context.created_at = new Date().toISOString();
  return context;
}

/** Rebuild against current originals, candidate membership and deterministic routing. */
export async function verifyTaskContext(profile, context, { stateRoot = DEFAULT_STATE } = {}) {
  const reasons = [];
  if (!context || context.project_id !== profile.id || context.schema_version !== 1) return { valid: false, reason_codes: ['context_invalid'] };
  if (list(context.gaps).some(row => ['source_unreadable', 'source_ref_missing', 'source_changed_during_prepare', 'feature_map_unreadable', 'records_unreadable', 'verification_rules_unreadable'].includes(row.code))) reasons.push('sources_incomplete');
  if (context.context_sha256 !== hashContent(projection(context))) reasons.push('context_tampered');
  try {
    const current = await buildTaskContext(profile, { task: context.task, changeId: context.selection?.changeId ?? undefined, acIds: context.selection?.acIds ?? undefined, stateRoot });
    if (current.context_sha256 !== context.context_sha256) reasons.push('task_sources_or_selection_changed');
  } catch (error) { reasons.push('sources_unreadable'); }
  return { valid: reasons.length === 0, reason_codes: reasons };
}

/** Bind existing project execution to the current local selection and originals. */
export async function verifyTaskContextExecution(profile, context, execution) {
  const reasons = [];
  const bundleProjection = bundle => { const { created_at, pricing, note, ...rest } = bundle; return rest; };
  const selection = context.selection?.changeId ? { changeId: context.selection.changeId } : context.selection?.acIds ? { acIds: context.selection.acIds } : null;
  if (!selection || !context.judgment_plan) return { valid: false, reason_codes: ['current_selection_has_no_judgment_plan'] };
  const current = context.judgment_plan;
  if (execution?.schema_version !== 1 || execution.project_id !== profile.id || !['daily', 'validation'].includes(execution.purpose)) reasons.push('execution_identity_invalid');
  try {
    if (hashContent(execution.plan) !== hashContent(current)) reasons.push('execution_plan_not_current_selection');
    const sources = await verifyProjectJudgmentSources(profile, current);
    if (!sources.valid) reasons.push(...sources.reason_codes);
  } catch { reasons.push('execution_plan_invalid'); }
  const prepared = list(execution?.prepared), ids = new Set();
  if (prepared.length !== current.candidates.length) reasons.push('prepared_candidate_membership_changed');
  for (const item of prepared) {
    const candidate = current.candidates.find(row => row.judgment_id === item?.judgment_id);
    if (!candidate || ids.has(item?.judgment_id)) { reasons.push('prepared_candidate_not_selected_or_duplicate'); continue; }
    ids.add(item.judgment_id);
    try {
      validateJudgmentBundle(item.bundle);
      assert(item.bundle.standard_sha256 === hash(judgmentPolicy), 'current_standard_required');
      // Reuse the existing preparer, including its source/quote, fixed criteria,
      // scope and request checks. Mere membership or a self-consistent hash does
      // not establish that the request represents this candidate's originals.
      const expected = await prepareJudgments({ context: { expected: candidate.context?.expected, preconditions: candidate.context?.preconditions, actions: candidate.context?.actions },
        material_scope: candidate.material_scope, evidence: candidate.evidence.map(row => ({ ...row, original_locator: `第${row.start_line}-${row.end_line}行` })),
        judgments: [{ id: candidate.judgment_id, kind: candidate.kind, target: candidate.target, evidence_ids: candidate.evidence.map(row => row.id) }],
        ...(execution.purpose === 'daily' ? { review_policy: { mode: 'selective', profile_id: 'ordinary_ui_copy_fidelity_v2' }, review_scope: candidate.review_scope } : {}) });
      if (hashContent(bundleProjection(expected)) !== hashContent(bundleProjection(item.bundle))) reasons.push('prepared_request_not_current_candidate');
    } catch { reasons.push('prepared_bundle_or_standard_invalid'); }
  }
  try {
    const material = { purpose: execution.purpose, selection, plan: execution.plan, prepared: prepared.map(item => ({ judgment_id: item.judgment_id,
      bundle: item.bundle ? bundleProjection(item.bundle) : null, route: item.route ?? null, error: item.error ?? null })) };
    if (execution.plan_sha256 !== hash(material)) reasons.push('execution_approval_fingerprint_mismatch');
  } catch { reasons.push('execution_approval_fingerprint_invalid'); }
  return { valid: reasons.length === 0, reason_codes: [...new Set(reasons)] };
}

/** Inspect the existing ledger/cache. Does not send, retry, remove locks or approve work. */
export function classifyRequestResume(freshness, { prepared = [], ledger, cacheScope, validateResponse } = {}) {
  validateLedger(ledger);
  const groups = { completed_reusable: [], not_started: [], charge_unknown: [], completed_unusable: [], provider_calls: 0, business_verified: false };
  for (const item of prepared) {
    const bundle = item.bundle ?? item;
    for (const request of bundle.requests ?? []) {
      const key = requestKey(request, bundle.standard_sha256, cacheScope);
      const row = { judgment_id: request.judgment_id ?? request.dimension_id ?? null, request_key: key };
      const entries = ledger.entries.filter(entry => entry.request_key === key);
      if (entries.some(entry => entry.status !== 'completed')) { groups.charge_unknown.push({ ...row, entry_ids: entries.map(entry => entry.id), action: 'reconcile_existing_ledger_do_not_resend' }); continue; }
      if (!entries.length) { groups.not_started.push(row); continue; }
      const hit = ledger.cache[key]; let valid = false;
      if ((freshness.valid === true || freshness.fresh === true) && bundle.model === MODEL && hit?.model === MODEL && hit.evidence_kind === 'provider_response' &&
        hit.standard_sha256 === bundle.standard_sha256 && hit.request_sha256 === hash(request.body) &&
        entries.some(entry => entry.id === hit.source_entry && entry.status === 'completed' && entry.evidence_kind === 'provider_response') && typeof validateResponse === 'function') {
        try { validateResponse(hit.raw_response, request); valid = true; } catch { /* Invalid completed responses are retained, never reclassified as unstarted. */ }
      }
      groups[valid ? 'completed_reusable' : 'completed_unusable'].push({ ...row, source_entry: hit?.source_entry ?? null });
    }
  }
  return groups;
}
