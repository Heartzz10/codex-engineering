import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { scopedPath, mapHash, readMap, parseStrictJson } from './feature-store.mjs';
import { validateMap } from './feature.mjs';
import { reviewRoutingPolicy } from './judgment-routing.mjs';

const profilePolicy = reviewRoutingPolicy.profiles.ordinary_ui_copy_fidelity_v2;
const normalize = value => value.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
const digest = value => createHash('sha256').update(value).digest('hex');
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const unique = list => [...new Set(list)];
const programOperators = new Set(['equals', 'equalsPath', 'includes']);
const assert = (condition, reason) => { if (!condition) throw Error(reason); };

function extract(source, selector, extension) {
  assert(selector && typeof selector === 'object', 'selector_missing');
  if (Object.hasOwn(selector, 'pointer')) {
    assert(extension === '.json' && typeof selector.pointer === 'string' && (selector.pointer === '' || selector.pointer.startsWith('/')), 'pointer_invalid');
    let value = parseStrictJson(source);
    for (const token of selector.pointer === '' ? [] : selector.pointer.slice(1).split('/')) {
      assert(!/~(?![01])/.test(token), 'pointer_invalid');
      const key = token.replace(/~1/g, '/').replace(/~0/g, '~');
      assert(value !== null && typeof value === 'object' && Object.hasOwn(value, key), 'pointer_missing');
      value = value[key];
    }
    assert(nonempty(value), 'target_empty_or_nonstring');
    return value;
  }
  assert(['.md', '.txt'].includes(extension), 'line_source_type_invalid');
  const { startLine, endLine } = selector;
  assert(Number.isInteger(startLine) && startLine > 0 && Number.isInteger(endLine) && endLine >= startLine, 'line_range_invalid');
  const lines = source.split('\n');
  if (lines.at(-1) === '') lines.pop();
  assert(endLine <= lines.length, 'line_range_out_of_bounds');
  const value = lines.slice(startLine - 1, endLine).join('\n');
  assert(nonempty(value), 'source_empty');
  return value;
}

function selectorOf(ref) {
  assert(ref && typeof ref === 'object' && nonempty(ref.path), 'source_ref_missing');
  const lines = Number.isInteger(ref.startLine) && Number.isInteger(ref.endLine);
  const pointer = typeof ref.pointer === 'string';
  assert(lines !== pointer, 'source_selector_invalid');
  return lines ? { startLine: ref.startLine, endLine: ref.endLine } : { pointer: ref.pointer };
}

function sourceReader(profile, readFile = file => fs.readFile(file)) {
  const cache = new Map();
  const root = profile.root;
  async function full(ref, allowed) {
    assert(ref && nonempty(ref.path), 'source_ref_missing');
    const extension = path.extname(ref.path).toLowerCase();
    assert(allowed.includes(extension), 'source_type_invalid');
    const file = await scopedPath(root, ref.path);
    const realRoot = await fs.realpath(root);
    const realFile = await fs.realpath(file);
    const realRelative = path.relative(realRoot, realFile);
    assert(realRelative && realRelative !== '..' && !realRelative.startsWith(`..${path.sep}`) && !path.isAbsolute(realRelative), 'source_path_escape');
    const relative = path.relative(realRoot, file).replace(/\\/g, '/');
    if (!cache.has(realFile)) {
      const promise = Promise.resolve(readFile(realFile)).then(raw => {
        assert(typeof raw === 'string' || Buffer.isBuffer(raw), 'source_not_utf8');
        const value = normalize(Buffer.isBuffer(raw) ? new TextDecoder('utf-8', { fatal: true }).decode(raw) : raw);
        assert(Buffer.byteLength(value, 'utf8') <= 1024 * 1024, 'source_too_large');
        return { value, sha256: digest(value) };
      });
      cache.set(realFile, promise);
    }
    return { ...(await cache.get(realFile)), file, relative, extension };
  }
  async function bind(ref, allowed) {
    const data = await full(ref, allowed);
    const selector = selectorOf(ref);
    const value = extract(data.value, selector, data.extension);
    return { path: data.relative, sha256: data.sha256, selector, value };
  }
  return { bind };
}

const reasonForSource = (error, prefix) => error?.message === 'source_too_large' ? `${prefix}_too_large` : `${prefix}_unreadable`;
const publicTask = (base, reasons) => ({ ...base, reason_codes: unique(reasons) });

/** Create a bounded review plan. It does not execute program assertions or approve semantics. */
export async function buildProjectJudgments(profile, map, { changeId, acIds, readFile } = {}) {
  assert(profile?.featureMapRef?.schemaVersion === 1 && nonempty(profile.featureMapRef.path), 'feature_map_binding_missing');
  assert(map?.projectId === profile.id, 'wrong_project');
  validateMap(map);
  assert(map.contentHash === mapHash(map), 'map_hash_changed');
  assert((changeId === undefined) !== (acIds === undefined), 'selection_requires_changeId_or_acIds');
  let selected;
  if (changeId !== undefined) {
    assert(nonempty(changeId), 'changeId_required');
    const change = map.changes.find(item => item.id === changeId);
    assert(change, `unknown_change_id:${changeId}`);
    const featureIds = new Set(change.featureIds);
    selected = map.acceptanceCriteria.filter(ac => change.acIds.includes(ac.id) || featureIds.has(ac.featureId));
  } else {
    assert(Array.isArray(acIds) && acIds.length > 0, 'acIds_required');
    assert(new Set(acIds).size === acIds.length, 'duplicate_acIds');
    for (const id of acIds) assert(map.acceptanceCriteria.some(ac => ac.id === id), `unknown_ac_id:${id}`);
    selected = acIds.map(id => map.acceptanceCriteria.find(ac => ac.id === id));
  }
  const semanticCount = selected.reduce((sum, ac) => sum + ac.requiredTargets.reduce((n, target) => {
    const rows = target.assertions ?? ac.assertions ?? [];
    return n + (rows.length ? rows.filter(a => !programOperators.has(a.operator)).length : 1);
  }, 0), 0);
  assert(semanticCount <= 48, 'semantic_task_limit_exceeded');
  const source = sourceReader(profile, readFile);
  const assertionTuples = new Set();
  const plan = { schema_version: 1, project_id: map.projectId,
    map_binding: { path: profile.featureMapRef.path, content_hash: map.contentHash, revision: map.revision },
    program_tasks: [], codex_tasks: [], candidates: [], counts: {} };
  for (const ac of selected) {
    const feature = map.features.find(item => item.id === ac.featureId);
    const requirements = ac.requirementIds.map(id => map.requirements.find(item => item.id === id));
    for (const target of ac.requiredTargets) {
      const assertions = target.assertions ?? ac.assertions ?? [];
      const rows = assertions.length ? assertions : [{ id: null, operator: 'manual' }];
      for (let index = 0; index < rows.length; index++) {
        const assertion = rows[index];
        const tuple = JSON.stringify([ac.id, ac.revision, target.targetId, assertion.id === null || assertion.id === undefined ? ['index', index] : ['id', assertion.id]]);
        assert(!assertionTuples.has(tuple), 'duplicate_assertion_id');
        assertionTuples.add(tuple);
        const judgmentId = `${ac.id.slice(0, 16)}-${digest(tuple).slice(0, 40)}`;
        const base = { judgment_id: judgmentId,
          ac_id: ac.id, ac_revision: ac.revision, target_id: target.targetId, assertion_id: assertion.id ?? null,
          kind: assertion.operator === 'manual' ? 'requirement_fidelity' : 'program_assertion',
          target: assertion.semanticReview?.targetRef ?? { operator: assertion.operator ?? null, path: assertion.path ?? null },
          target_source_label: nonempty(assertion.semanticReview?.targetRef?.sourceLabel) ? assertion.semanticReview.targetRef.sourceLabel : target.targetId,
          acceptance_effects: structuredClone(ac.effects),
          context: { expected: Object.hasOwn(assertion, 'expected') ? assertion.expected : ac.expected, preconditions: ac.preconditions, actions: target.actions ?? ac.actions,
            requirement_refs: requirements.map(req => ({ id: req.id, decision_ref: req.decisionRef ?? null, decision_evidence_refs: req.decisionEvidenceRefs ?? [] })) },
          evidence: [], source_bindings: [] };
        if (programOperators.has(assertion.operator)) {
          plan.program_tasks.push(publicTask(base, ['program_assertion_reference_only']));
          continue;
        }
        const reasons = [];
        if (assertion.operator !== 'manual') reasons.push('unsupported_operator');
        const meta = assertion.semanticReview;
        if (!meta) reasons.push('semantic_review_missing');
        if (feature.lifecycle !== 'active') reasons.push('feature_not_active');
        if (meta) {
          if (meta.kind !== 'requirement_fidelity') reasons.push('kind_not_eligible');
          if (!profilePolicy.allowed_material_scopes.includes(meta.materialScope)) reasons.push('material_scope');
          if (!profilePolicy.allowed_copy_categories.includes(meta.category)) reasons.push('category_not_eligible');
          if (!nonempty(meta.reviewerRef)) reasons.push('reviewer_ref_missing');
          if (!Array.isArray(meta.checkedExclusions) || new Set(meta.checkedExclusions).size !== profilePolicy.excluded_effects.length || !profilePolicy.excluded_effects.every(x => meta.checkedExclusions.includes(x))) reasons.push('exclusions_unchecked');
          if (!Array.isArray(meta.presentEffects) || meta.presentEffects.length) reasons.push('excluded_effect_present');
        }
        for (const req of requirements) {
          if (req.decision !== 'accepted') reasons.push('requirement_not_accepted');
          if (!nonempty(req.decisionRef)) reasons.push('decision_ref_missing');
          if (req.openQuestions?.length) reasons.push('open_questions');
          if (!Array.isArray(req.decisionEvidenceRefs) || !req.decisionEvidenceRefs.length) reasons.push('decision_evidence_missing');
          if (meta?.materialScope === 'private') continue;
          for (const [refIndex, ref] of (req.decisionEvidenceRefs ?? []).entries()) {
            try {
              const binding = await source.bind(ref, ['.md', '.txt']);
              base.source_bindings.push(binding);
              base.evidence.push({ id: `${req.id}:${refIndex + 1}`, source_file: path.resolve(profile.root, binding.path), source_label: nonempty(ref.sourceLabel) ? ref.sourceLabel : req.id,
                original_locator: `${binding.path}:${binding.selector.startLine}-${binding.selector.endLine}`,
                start_line: binding.selector.startLine, end_line: binding.selector.endLine, quote: binding.value, kind: 'user_decision' });
            } catch (error) { reasons.push(reasonForSource(error, 'decision_evidence')); }
          }
        }
        if (meta && meta.materialScope !== 'private') {
          try {
            const binding = await source.bind(meta.targetRef, ['.md', '.txt', '.json']);
            base.source_bindings.push(binding);
            base.target = binding.value;
          } catch (error) { reasons.push(reasonForSource(error, 'target')); }
        }
        if (reasons.length) {
          plan.codex_tasks.push(publicTask(base, reasons));
          continue;
        }
        const scope = { category: meta.category, impact: 'low', decision_ref: requirements.map(req => req.decisionRef).join('; '), reviewer_ref: meta.reviewerRef,
          checked_exclusions: meta.checkedExclusions, present_effects: meta.presentEffects };
        plan.candidates.push({ ...publicTask(base, []), material_scope: meta.materialScope, review_scope: scope });
      }
    }
  }
  plan.counts = { program: plan.program_tasks.length, codex: plan.codex_tasks.length, candidates: plan.candidates.length, total: plan.program_tasks.length + plan.codex_tasks.length + plan.candidates.length };
  return plan;
}

/** Verify all bound originals before and after preparing or running a judgment. */
export async function verifyProjectJudgmentSources(profile, plan) {
  const reasons = [];
  if (!plan || !Array.isArray(plan.candidates) || !Array.isArray(plan.codex_tasks)) reasons.push('plan_invalid');
  try {
    const map = await readMap(profile);
    validateMap(map);
    if (plan?.project_id !== profile.id || plan?.map_binding?.path !== profile.featureMapRef.path || plan.map_binding.content_hash !== map.contentHash || plan.map_binding.revision !== map.revision) reasons.push('map_binding_changed');
  } catch { reasons.push('map_unreadable_or_changed'); }
  const source = sourceReader(profile);
  for (const task of [...(Array.isArray(plan?.candidates) ? plan.candidates : []), ...(Array.isArray(plan?.codex_tasks) ? plan.codex_tasks : [])]) {
    if (!Array.isArray(task?.source_bindings) || (Array.isArray(plan?.candidates) && plan.candidates.includes(task) && task.source_bindings.length < 2)) { reasons.push('source_binding_missing'); continue; }
    for (const binding of task.source_bindings) {
      try {
        const current = await source.bind({ path: binding.path, ...binding.selector }, ['.md', '.txt', '.json']);
        if (current.sha256 !== binding.sha256 || current.value !== binding.value || JSON.stringify(current.selector) !== JSON.stringify(binding.selector)) reasons.push('source_changed');
      } catch { reasons.push('source_unreadable'); }
    }
  }
  return { valid: reasons.length === 0, reason_codes: unique(reasons) };
}
