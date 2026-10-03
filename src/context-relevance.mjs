import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { binaryQuestions } from './judgment-binary.mjs';
import { prepareJudgments } from './judgment.mjs';
import { MODEL, RESERVED_REQUEST_USD, hash, invariant, plain, text, normalize, bytes, sameKeys, validateChoices, executeFixedRequests, validateLedger, ledgerCost, requestKey } from '../skills/review-product-plan/scripts/jev-client.mjs';

export const contextRelevancePolicy = JSON.parse(await readFile(new URL('../policies/context-relevance-v2.json', import.meta.url), 'utf8'));
const activeLedgers = new WeakSet();
const digest = value => createHash('sha256').update(value).digest('hex');
const allowed = scope => invariant(contextRelevancePolicy.allowed_material_scopes.includes(scope), '整个task和每个candidate仅允许明确public/synthetic；private不允许外发');
const idValid = id => /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(id);
const refFields = { id: true, material_scope: true, source_file: true, source_label: true, original_locator: true, start_line: true, end_line: true };
function validatePacket(packet) {
  invariant(plain(packet) && sameKeys(packet, { project_id: true, task: true, candidates: true, mandatory_materials: true, mandatory_checks: true, ...(packet.upstream_sources === undefined ? {} : { upstream_sources: true }) }), '相关性packet仅接受固定资料字段');
  invariant(text(packet.project_id) && plain(packet.task) && sameKeys(packet.task, refFields) && idValid(packet.task.id), 'task结构无效'); allowed(packet.task.material_scope);
  invariant(Array.isArray(packet.candidates) && packet.candidates.length > 0 && packet.candidates.length <= contextRelevancePolicy.max_candidates, '候选数量无效');
  const seen = new Set([packet.task.id]);
  for (const item of packet.candidates) {
    invariant(plain(item) && sameKeys(item, { ...refFields, optional: true }) && item.optional === true && idValid(item.id) && !seen.has(item.id), '只可排序可选材料；candidate ID无效或重复');
    seen.add(item.id); allowed(item.material_scope);
  }
  for (const list of [packet.mandatory_materials, packet.mandatory_checks]) invariant(Array.isArray(list) && list.every(text), '硬性原件/检查引用无效');
  invariant(packet.upstream_sources === undefined || (Array.isArray(packet.upstream_sources) && packet.upstream_sources.every(s => plain(s) && sameKeys(s, { source_file: true, sha256: true }) && text(s.source_file) && /^[a-f0-9]{64}$/.test(s.sha256))), '派生上游原件身份无效');
}
const sourceRef = item => Object.fromEntries(Object.entries(item).filter(([key]) => !['optional', 'material_scope'].includes(key)));
const questions = (task, candidate, bindings) => binaryQuestions({ id: candidate.id, kind: 'relevance', target: task.quote, propositions: contextRelevancePolicy.atomic_checks }, { ...contextRelevancePolicy, common_instructions: contextRelevancePolicy.instructions }, [task.id, candidate.id].map(id => { const b = bindings[id]; return { id, source_label: b.source_label, locator: b.locator, source_sha256: b.source_sha256 }; }), { standardSha: hash(contextRelevancePolicy), combinationRule: contextRelevancePolicy.combination_version });
const identity = bundle => hash({ schema_version: bundle.schema_version, project_id: bundle.project_id, source_base_dir: bundle.source_base_dir, packet: bundle.packet, task: bundle.task, candidates: bundle.candidates, source_hashes: bundle.source_hashes, source_bindings: bundle.source_bindings, mandatory_materials: bundle.mandatory_materials, mandatory_checks: bundle.mandatory_checks, request_sha256: bundle.request_sha256, standard_sha256: bundle.standard_sha256, model: bundle.model, variant: bundle.variant, language: bundle.language });

/** Reuse the existing judgment source extraction only; no judgment routing or qualification. */
export async function prepareContextRelevance(packet, { baseDir = process.cwd(), readSource = file => readFile(file, 'utf8') } = {}) {
  validatePacket(packet);
  const refs = [packet.task, ...packet.candidates].map(sourceRef);
  const cachedSources = new Map();
  const cachedRead = file => { if (!cachedSources.has(file)) cachedSources.set(file, Promise.resolve(readSource(file))); return cachedSources.get(file); };
  const bound = { source_hashes: {}, source_bindings: {} }, pool = new Map();
  for (const ref of refs) {
    const one = await prepareJudgments({ material_scope: 'synthetic', context: { purpose: '本地原文提取，不发送该中间请求' }, evidence: [ref], judgments: [{ id: 'source_binding', kind: 'requirement_fidelity', target: '本地原文提取', evidence_ids: [ref.id] }] }, { baseDir, readSource: cachedRead });
    Object.assign(bound.source_hashes, one.source_hashes); Object.assign(bound.source_bindings, one.source_bindings);
    pool.set(ref.id, one.requests[0].body.state.evidence[0]);
  }
  const task = { ...pool.get(packet.task.id), material_scope: packet.task.material_scope };
  const candidates = packet.candidates.map(x => ({ ...pool.get(x.id), optional: true, material_scope: x.material_scope }));
  const source_hashes = { ...bound.source_hashes };
  for (const s of packet.upstream_sources ?? []) {
    const file = path.resolve(baseDir, s.source_file), actual = digest(normalize(await readSource(file)));
    invariant(actual === s.sha256, '派生上游全文已改变；重新生成材料'); source_hashes[file] = actual;
  }
  const requests = candidates.map(candidate => { const q = questions(task, candidate, bound.source_bindings); return { judgment_id: candidate.id, candidate_id: candidate.id, evidence_ids: [task.id, candidate.id], question_contracts: q.contracts, combination_version: contextRelevancePolicy.combination_version, body: { model: MODEL, state: { task, candidate, source_identity: q.contracts[0].sources }, questions: q.questions } }; });
  for (const r of requests) invariant(bytes(r.body) <= contextRelevancePolicy.max_request_bytes, '相关性请求超限；返回本地全文，不静默截断');
  const bundle = { schema_version: 1, project_id: packet.project_id, source_base_dir: path.resolve(baseDir), packet: structuredClone(packet), task, candidates, mandatory_materials: [...packet.mandatory_materials], mandatory_checks: [...packet.mandatory_checks], model: MODEL, variant: 'independent_candidate_binary_v2', language: 'zh', standard_version: contextRelevancePolicy.version, standard_sha256: hash(contextRelevancePolicy), source_hashes, source_bindings: bound.source_bindings, requests, local_results: [], request_sha256: hash(requests), request_count: requests.length, candidate_count: candidates.length, question_count: requests.reduce((n,r) => n + Object.keys(r.body.questions).length,0), max_requests: requests.length, reserved_cost_usd: requests.length * RESERVED_REQUEST_USD, production_enabled: false };
  bundle.plan_sha256 = identity(bundle); return bundle;
}

export function validateContextRelevanceBundle(bundle) {
  invariant(plain(bundle) && bundle.schema_version === 1 && bundle.model === MODEL && bundle.variant === 'independent_candidate_binary_v2' && bundle.language === 'zh' && bundle.standard_sha256 === hash(contextRelevancePolicy) && bundle.standard_version === contextRelevancePolicy.version && bundle.production_enabled === false, '相关性标准/模型/范围已改变；重新prepare');
  validatePacket(bundle.packet);
  invariant(text(bundle.source_base_dir) && path.isAbsolute(bundle.source_base_dir), '缺来源基目录，请重新prepare');
  invariant(bundle.plan_sha256 === identity(bundle) && bundle.request_sha256 === hash(bundle.requests), '完整资料/候选集合/标准身份改变');
  invariant(Array.isArray(bundle.requests) && bundle.requests.length === bundle.candidates.length && hash(bundle.candidates.map(c => c.id)) === hash(bundle.packet.candidates.map(c => c.id)), 'candidate集合无效');
  for (const item of [bundle.task, ...bundle.candidates]) {
    const ref = item.id === bundle.packet.task.id ? bundle.packet.task : bundle.packet.candidates.find(c => c.id === item.id);
    const binding = bundle.source_bindings?.[item.id];
    invariant(ref && binding && item.material_scope === ref.material_scope && item.quote === binding.quote && item.source_label === binding.source_label && item.locator === binding.locator && item.kind === binding.kind, '材料范围/引用绑定改变');
  }
  const ids = new Set();
  for (const r of bundle.requests) {
    const candidate = bundle.candidates.find(c => c.id === r.candidate_id);
    invariant(candidate && !ids.has(r.candidate_id) && r.judgment_id === r.candidate_id && hash(r.body) === hash({ model: MODEL, state: { task: bundle.task, candidate, source_identity: questions(bundle.task, candidate, bundle.source_bindings).contracts[0].sources }, questions: questions(bundle.task, candidate, bundle.source_bindings).questions }) && hash(r.evidence_ids) === hash([bundle.task.id, candidate.id]) && hash(r.question_contracts) === hash(questions(bundle.task, candidate, bundle.source_bindings).contracts) && r.combination_version === contextRelevancePolicy.combination_version, '请求/二元问题合同/单候选关系已改变');
    ids.add(r.candidate_id); invariant(bytes(r.body) <= contextRelevancePolicy.max_request_bytes, '相关性请求超限');
  }
  invariant(bundle.question_count === bundle.requests.reduce((n,r)=>n + Object.keys(r.body.questions).length,0) && bundle.request_count === bundle.requests.length && bundle.candidate_count === bundle.candidates.length, '题目/请求/候选计数改变');
  return bundle;
}

export async function verifyContextRelevanceSources(bundle, options = {}) {
  const readSource = options.readSource ?? (file => readFile(file, 'utf8'));
  const current = await prepareContextRelevance(bundle.packet, { ...options, baseDir: options.baseDir ?? bundle.source_base_dir,
    readSource: async file => { try { return await readSource(file); } catch (error) { throw Object.assign(new Error('来源原件不可读；返回本地核查'), { code: 'source_unreadable', cause: error }); } } });
  if (current.plan_sha256 !== bundle.plan_sha256) throw Object.assign(new Error('来源全文或摘录已改变；返回本地原件并重新prepare'), { code: 'source_changed' });
  return true;
}

export function rankContextRelevance(candidates, results = []) {
  const map = new Map(); const conflicts = new Set();
  for (const row of results) { if (map.has(row.candidate_id)) conflicts.add(row.candidate_id); map.set(row.candidate_id, row); }
  const all = candidates.map(candidate => ({ ...candidate, relevance: conflicts.has(candidate.id) ? { choice: 'unknown', reason: 'answer_conflict' } : map.get(candidate.id) ?? { choice: 'unknown', reason: 'missing_or_failed' } }));
  const unknown = all.filter(c => !['directly_relevant','context_helpful','not_contributing'].includes(c.relevance.choice));
  const priority = { directly_relevant: 0, context_helpful: 1, not_contributing: 2 };
  const ranked = all.filter(c => !unknown.includes(c)).sort((a,b) => priority[a.relevance.choice] - priority[b.relevance.choice] || a.id.localeCompare(b.id,'en'));
  return { ranked, unknown, all };
}
export function validateContextRelevanceResponse(raw, request) {
  const answers = validateChoices(raw, request).map(a => ({ ...a, question_id: a.criterion_id, parent_id: request.candidate_id }));
  const byId = new Map(answers.map(a => [a.question_id,a]));
  const facts = request.question_contracts.map(c => { const a = byId.get(c.question_id); return { question_id: c.question_id, choice: a.confidence < .8 ? 'unknown' : a.provider_choice, reason: a.confidence < .8 ? 'model_uncertain' : a.provider_choice === 'unknown' ? 'model_unknown' : null }; });
  const direct = facts.find(f => f.question_id === request.candidate_id + '__direct'), background = facts.find(f => f.question_id === request.candidate_id + '__background');
  const choice = facts.some(f => f.choice === 'unknown') || !direct || !background ? 'unknown' : direct.choice === 'yes' ? 'directly_relevant' : background.choice === 'yes' ? 'context_helpful' : 'not_contributing';
  return { candidate_id: request.candidate_id, model: raw.model, answers, choice, facts, unknown_reasons: [...new Set(facts.map(f=>f.reason).filter(Boolean))], usage: raw.usage };
}
const response = validateContextRelevanceResponse;
const local = (bundle, reason) => ({ status: 'local_fallback', reason, attempts: 0, cache_hits: 0, question_count: bundle.question_count, request_count: bundle.request_count, candidate_count: bundle.candidate_count, unknown_reasons: { [reason]: bundle.candidates.length }, candidates: bundle.candidates, ...rankContextRelevance(bundle.candidates), mandatory_materials: bundle.mandatory_materials, mandatory_checks: bundle.mandatory_checks, production_enabled: false, ordering_accepted: false, plan_sha256: bundle.plan_sha256, review_required: true });

export async function executeContextRelevance(bundle, options = {}) {
  validateContextRelevanceBundle(bundle);
  const purpose = options.purpose ?? 'daily'; invariant(['daily', 'validation'].includes(purpose), '用途仅daily/validation');
  if (purpose === 'daily' || options.enabled === false) return local(bundle, purpose === 'daily' ? 'daily_unqualified' : 'disabled');
  if (options.approvedSha !== bundle.plan_sha256) return local(bundle, 'authorization_missing_or_mismatch');
  const sourceOptions = { baseDir: options.baseDir, readSource: options.readSource };
  try { await verifyContextRelevanceSources(bundle, sourceOptions); } catch (error) { return local(bundle, error.code ?? 'source_changed'); }
  invariant(Number.isFinite(options.budgetUsd) && options.budgetUsd >= bundle.reserved_cost_usd && Number.isSafeInteger(options.maxRequests) && options.maxRequests >= bundle.requests.length, '专项验证须提供完整预占预算与请求限额');
  const work = async (ledger, saveLedger) => {
    validateLedger(ledger);
    const keys = new Set(bundle.requests.map(request => requestKey(request, bundle.standard_sha256, bundle.plan_sha256)));
    if (ledger.entries.some(entry => keys.has(entry.request_key) && ['reserved', 'uncertain'].includes(entry.status))) return { ...local(bundle, 'same_request_charge_unresolved'), provider_status: 'recovery_required', uncertain_charge: true, cumulative_budget_used_usd: ledgerCost(ledger), cumulative_attempts: ledger.entries.length };
    invariant(!activeLedgers.has(ledger), '相关性累计ledger正在使用；禁止并发重复发送'); activeLedgers.add(ledger);
    try {
    // Keep historical cache facts in the durable ledger. The provider client sees only trusted provider cache in a real run.
    const visibleCache = options.fetchImpl ? ledger.cache : Object.fromEntries(Object.entries(ledger.cache).filter(([key, entry]) => entry?.evidence_kind === 'provider_response' && ledger.entries.some(source => source.id === entry.source_entry && source.status === 'completed' && source.request_key === key && source.evidence_kind === 'provider_response')));
    const clientLedger = { ...ledger, cache: { ...visibleCache } };
    const persistLedger = async current => { Object.assign(ledger.cache, current.cache); await (saveLedger ?? options.saveLedger ?? (async () => {}))(ledger); };
    const apiKey = options.apiKey ?? await options.readApiKey?.();
    const checkedFetch = async (...args) => {
      await verifyContextRelevanceSources(bundle, sourceOptions);
      const result = await (options.fetchImpl ?? fetch)(...args);
      return { ok: result.ok, status: result.status, json: async () => { const raw = await result.json(); await verifyContextRelevanceSources(bundle, sourceOptions); return raw; } };
    };
    const run = await executeFixedRequests(bundle, { ...options, apiKey, ledger: clientLedger, saveLedger: persistLedger, approvedSha: bundle.request_sha256, fetchImpl: checkedFetch, evidenceKind: options.fetchImpl ? 'adapter_fixture' : 'provider_response', cacheScope: bundle.plan_sha256, validate: response });
    let sourceValid = true; try { await verifyContextRelevanceSources(bundle, sourceOptions); } catch { sourceValid = false; }
    const accepted = run.status === 'completed' && sourceValid;
    const results = accepted ? run.results.map(row => ({ candidate_id: row.candidate_id, choice: row.choice, facts: row.facts, unknown_reasons: row.unknown_reasons, origin: row.origin })) : [];
    const result = { ...run, question_count: bundle.question_count, request_count: bundle.request_count, candidate_count: bundle.candidate_count, unknown_reasons: accepted ? Object.fromEntries([...new Set(results.flatMap(r=>r.unknown_reasons ?? []))].map(reason=>[reason,results.filter(r=>r.unknown_reasons?.includes(reason)).length])) : { [sourceValid ? `transport_${run.failure_code ?? run.status}` : 'source_changed']: bundle.candidates.length }, uncertain_charge: run.uncertain_charge || ledger.entries.some(entry => entry.status !== 'completed'), provider_status: run.status, status: accepted ? 'validation_completed' : 'local_fallback', evidence_kind: options.fetchImpl || run.results.some(row => row.origin === 'cache' && row.source_evidence_kind !== 'provider_response') ? 'adapter_fixture' : 'provider_response', candidates: bundle.candidates, ...rankContextRelevance(bundle.candidates, results), mandatory_materials: bundle.mandatory_materials, mandatory_checks: bundle.mandatory_checks, production_enabled: false, ordering_accepted: accepted, plan_sha256: bundle.plan_sha256, source_valid: sourceValid };
    if (options.save) { try { await options.save(result); } catch { return { ...result, status: 'recovery_required', ordering_accepted: false, failure_code: 'final_persistence' }; } } return result;
    } finally { activeLedgers.delete(ledger); }
  };
  return options.withLedger ? options.withLedger(work) : work(options.ledger ?? { schema_version: 1, entries: [], cache: {} });
}
