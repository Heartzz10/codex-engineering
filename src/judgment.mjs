import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { MODEL, PRICE_PER_MILLION, PRICING_CHECKED_ON, RESERVED_REQUEST_USD, hash, invariant, plain, text, normalize, bytes, sameKeys, validateChoices, executeFixedRequests } from '../skills/review-product-plan/scripts/jev-client.mjs';
import { reviewRoutingPolicy, profileRulesSha, routingSha, preflightReviewRouting, resolveReviewRouting } from './judgment-routing.mjs';

import { binaryQuestions, combineBinaryAnswers, legacyAnswerById } from './judgment-binary.mjs';

export const judgmentPolicy = JSON.parse(await readFile(new URL('../policies/judgments.json', import.meta.url), 'utf8'));
const historicalPolicy = JSON.parse(await readFile(new URL('../policies/judgments-1.0.0.json', import.meta.url), 'utf8'));
const historical101Policy = JSON.parse(await readFile(new URL('../policies/judgments-1.0.1.json', import.meta.url), 'utf8'));
export const judgmentPolicies = [judgmentPolicy, historical101Policy, historicalPolicy];
const policyForSha = sha => judgmentPolicies.find(policy => hash(policy) === sha);
export const evaluationPolicy = JSON.parse(await readFile(new URL('../policies/judgments-evaluation.json', import.meta.url), 'utf8'));
const scopeCheck = scope => invariant(judgmentPolicy.allowed_material_scopes.includes(scope), '材料范围仅允许已明确的 public/synthetic；private 须另行授权与接入，不自动扩大外发');
function safeSelectiveContext(value) {
  if (typeof value === 'string') return !/(?:[A-Za-z]:[\\/]|(?:^|\s)\/Users\/|(?:^|\s)\/home\/)/.test(value);
  if (Array.isArray(value)) return value.every(safeSelectiveContext);
  if (!plain(value)) return true;
  return Object.entries(value).every(([key, child]) => !/^(?:review_?policy|routing.*|state_?root|qualification.*|expected_?choice|reference_?answers?|answer_?key|dataset.*)$/i.test(key) && safeSelectiveContext(child));
}
const validateCandidates = candidates => {
  invariant(Array.isArray(candidates) && candidates.length <= judgmentPolicy.max_candidates, '候选方法数量无效');
  const seen = new Set();
  for (const c of candidates) { invariant(plain(c) && /^[a-z][a-z0-9_]{0,63}$/.test(c.id) && !['insufficient', 'no_match'].includes(c.id) && !seen.has(c.id) && text(c.description) && sameKeys(c, { id: true, description: true }), '候选ID/描述无效或重复'); seen.add(c.id); }
};
function question(judgment, policy = judgmentPolicy) {
  invariant(Object.hasOwn(policy.kinds, judgment.kind) && text(judgment.target), '未知判断用途或缺少具体 target');
  const candidates = judgment.candidates ?? [];
  if (judgment.kind === 'method_selection') validateCandidates(candidates);
  else invariant(candidates.length === 0, '只有 method_selection 接受候选方法');
  return { type: 'choice', instructions: `${policy.common_instructions}\n${policy.kinds[judgment.kind]}\n实际判断对象：${judgment.target}`, criteria: judgment.kind === 'method_selection' ? { ...Object.fromEntries(candidates.map(c => [c.id, `唯一适用候选：${c.description}`])), insufficient: policy.criteria.insufficient, no_match: policy.criteria.no_match } : policy.criteria };
}
function questionsFor(judgment, policy, bindings = {}, ids = []) {
  if (!policy.contract_version) return { questions: { [judgment.id]: question(judgment, policy) } };
  question(judgment, policy);
  if (judgment.kind === 'method_selection' && !(judgment.candidates ?? []).length) return { questions: {}, contracts: [] };
  return binaryQuestions(judgment, policy, ids.map(id => { const b = bindings?.[id]; invariant(b && text(b.source_sha256), '来源绑定缺失，请重新prepare'); return { id, source_label: b.source_label, locator: b.locator, source_sha256: b.source_sha256 }; }));
}
function stateJudgment(j) { return { kind: j.kind, target: j.target, candidates: j.candidates ?? [], ...(j.propositions === undefined ? {} : { propositions: j.propositions }) }; }
function checkSize(body) {
  invariant(bytes(body) <= 60000 && bytes(body.state) + Math.max(...Object.values(body.questions).map(bytes)) <= 24000, '请求大小超限；缩小相关材料，保留冲突双方，不静默截断');
}

export async function prepareJudgments(packet, { baseDir = process.cwd(), readSource = file => readFile(file, 'utf8'), routingPolicy = reviewRoutingPolicy } = {}) {
  invariant(plain(packet) && plain(packet.context), 'context 必须为对象'); scopeCheck(packet.material_scope);
  const reviewPolicy = packet.review_policy;
  if (reviewPolicy !== undefined) invariant(plain(reviewPolicy) && sameKeys(reviewPolicy, { mode: true, profile_id: true }) && reviewPolicy.mode === 'selective' && reviewPolicy.profile_id === 'ordinary_ui_copy_fidelity_v2' && routingPolicy.profiles?.[reviewPolicy.profile_id], '未知 review_policy mode/profile');
  if (reviewPolicy) invariant(safeSelectiveContext(packet.context), '本地路由、路径或参考答案不能进入外发 context');
  invariant(Array.isArray(packet.evidence) && Array.isArray(packet.judgments) && packet.judgments.length > 0 && packet.judgments.length <= judgmentPolicy.max_judgments, 'evidence/judgments 无效或数量超限');
  const evidence = new Map(); const sources = new Map(); const source_hashes = {}; const source_bindings = {};
  for (const item of packet.evidence) {
    invariant(plain(item) && text(item.id) && !evidence.has(item.id), 'evidence ID 无效或重复');
    invariant(text(item.source_file) && /\.(md|txt)$/i.test(item.source_file) && text(item.source_label) && text(item.original_locator), '证据须为已核 UTF-8 md/txt，且有来源定位');
    invariant(Number.isInteger(item.start_line) && item.start_line > 0 && Number.isInteger(item.end_line) && item.end_line >= item.start_line, '证据行范围无效');
    const fullPath = path.resolve(baseDir, item.source_file);
    if (!sources.has(fullPath)) sources.set(fullPath, normalize(await readSource(fullPath)));
    const source = sources.get(fullPath); const lines = source.split('\n');
    const quote = lines.slice(item.start_line - 1, item.end_line).join('\n');
    invariant(item.end_line <= lines.length && text(quote) &&
      (item.quote === undefined || (text(item.quote) && quote === normalize(item.quote))), `引文不匹配：${item.id}`);
    const kind = item.kind ?? 'document'; invariant(['document', 'user_decision', 'operation_record', 'test_record', 'issue_record'].includes(kind), '未知证据类型');
    const sourceSha = createHash('sha256').update(source).digest('hex');
    source_hashes[fullPath] = sourceSha;
    source_bindings[item.id] = { source_file: fullPath, start_line: item.start_line, end_line: item.end_line,
      source_sha256: sourceSha, source_label: item.source_label, locator: item.original_locator, kind, quote };
    evidence.set(item.id, { id: item.id, source_label: item.source_label, locator: item.original_locator, kind, quote });
  }
  const seen = new Set(); const requests = []; const local_results = [];
  for (const j of packet.judgments) {
    invariant(plain(j) && /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(j.id) && !seen.has(j.id), 'judgment ID 无效或重复'); seen.add(j.id);
    invariant(Array.isArray(j.evidence_ids) && new Set(j.evidence_ids).size === j.evidence_ids.length && j.evidence_ids.every(id => evidence.has(id)), '判断 evidence 引用无效');
    const q = questionsFor(j, judgmentPolicy, source_bindings, j.evidence_ids);
    if (!j.evidence_ids.length || (j.kind === 'method_selection' && !(j.candidates ?? []).length)) {
      local_results.push({ judgment_id: j.id, kind: j.kind, provider_choice: 'unknown', reason: !j.evidence_ids.length ? 'source_missing' : 'candidate_missing', origin: 'local_precheck', evidence_ids: j.evidence_ids, review_required: true, fallback: 'original_review',
        review_material: { context: packet.context, judgment: stateJudgment(j), evidence: j.evidence_ids.map(id => evidence.get(id)) } }); continue;
    }
    const body = { model: MODEL, state: { context: packet.context, judgment: stateJudgment(j), evidence: j.evidence_ids.map(id => evidence.get(id)), source_identity: q.contracts[0].sources }, questions: q.questions };
    checkSize(body); requests.push({ judgment_id: j.id, kind: j.kind, evidence_ids: j.evidence_ids, question_contracts: q.contracts, combination_version: q.contracts[0].combination_rule, body });
  }
  const bundle = { schema_version: 1, material_scope: packet.material_scope, model: MODEL, standard_version: judgmentPolicy.version, standard_sha256: hash(judgmentPolicy), source_hashes, source_bindings, created_at: new Date().toISOString(), requests, local_results, request_sha256: hash(requests), question_count: requests.reduce((n, r) => n + Object.keys(r.body.questions).length, 0), request_count: requests.length, candidate_count: packet.judgments.reduce((n, j) => n + (j.candidates?.length ?? 0), 0), max_requests: requests.length, reserved_cost_usd: requests.length * RESERVED_REQUEST_USD, pricing: { checked_on: PRICING_CHECKED_ON, input_usd_per_million: PRICE_PER_MILLION, source: 'https://docs.typesafe.ai/models' }, note: '外发只含 requests[*].body；不发本地路径/预期答案。所有结果只作建议，失败回原审查；不替代真实操作、批准、关闭或发布。' };
  if (reviewPolicy) {
    const profile = routingPolicy.profiles[reviewPolicy.profile_id];
    bundle.review_policy = reviewPolicy;
    if (packet.review_scope !== undefined) bundle.review_scope = packet.review_scope;
    bundle.routing_policy_version = routingPolicy.version;
    bundle.profile_rules_sha256 = profileRulesSha(reviewPolicy.profile_id, profile);
    bundle.qualification_sha256 = profile.qualification ? hash(profile.qualification) : null;
    bundle.routing_sha256 = routingSha(bundle, routingPolicy);
  }
  return bundle;
}

export function validateJudgmentBundle(bundle, routingPolicy = reviewRoutingPolicy) {
  const policy = policyForSha(bundle?.standard_sha256);
  invariant(plain(bundle) && bundle.schema_version === 1 && bundle.model === MODEL && policy && bundle.standard_version === policy.version, '标准或固定模型已改变，请重新prepare'); scopeCheck(bundle.material_scope);
  invariant(Array.isArray(bundle.requests) && Array.isArray(bundle.local_results) && bundle.requests.length + bundle.local_results.length > 0 && bundle.requests.length + bundle.local_results.length <= judgmentPolicy.max_judgments, '判断数量无效');
  invariant(bundle.request_sha256 === hash(bundle.requests), '请求指纹改变，请重新prepare');
  if (bundle.review_policy !== undefined) {
    const selected = bundle.review_policy;
    invariant(plain(selected) && sameKeys(selected, { mode: true, profile_id: true }) && selected.mode === 'selective' && selected.profile_id === 'ordinary_ui_copy_fidelity_v2' && routingPolicy.profiles?.[selected.profile_id] && bundle.routing_policy_version === routingPolicy.version && bundle.profile_rules_sha256 === profileRulesSha(selected.profile_id, routingPolicy.profiles[selected.profile_id]) && bundle.routing_sha256 === routingSha(bundle, routingPolicy), '路由标准或配置已改变，请重新prepare');
  }
  const seen = new Set();
  for (const r of [...bundle.requests, ...bundle.local_results]) { invariant(text(r.judgment_id) && !seen.has(r.judgment_id) && Object.hasOwn(judgmentPolicy.kinds, r.kind), '重复或未知判断'); seen.add(r.judgment_id); }
  for (const r of bundle.local_results) {
    invariant((policy.contract_version ? ['unknown'] : ['insufficient', 'no_match']).includes(r.provider_choice) && r.review_required === true, '本地结果不能当业务通过');
    if (r.review_material !== undefined) {
      const s = r.review_material;
      invariant(plain(s) && sameKeys(s, { context: true, judgment: true, evidence: true, ...(s.source_identity === undefined ? {} : { source_identity: true }) }) && plain(s.context) && plain(s.judgment) &&
        sameKeys(s.judgment, { kind: true, target: true, candidates: true, ...(s.judgment.propositions === undefined ? {} : { propositions: true }) }) && s.judgment.kind === r.kind && text(s.judgment.target) &&
        Array.isArray(s.judgment.candidates) && Array.isArray(s.evidence) && Array.isArray(r.evidence_ids) &&
        hash(s.evidence.map(e => e.id)) === hash(r.evidence_ids) && s.evidence.every(e => plain(e) && text(e.quote) && text(e.source_label) && text(e.locator)), '本地复核材料无效');
      question(s.judgment, policy);
    }
  }
  for (const r of bundle.requests) {
    const s = r.body?.state;
    invariant(r.body?.model === MODEL && plain(s) && sameKeys(s, { context: true, judgment: true, evidence: true, ...(policy.contract_version ? { source_identity: true } : {}) }) && plain(s.context) && plain(s.judgment) && s.judgment.kind === r.kind && sameKeys(s.judgment, { kind: true, target: true, candidates: true, ...(s.judgment.propositions === undefined ? {} : { propositions: true }) }), '请求材料结构无效');
    invariant(Array.isArray(s.evidence) && s.evidence.length > 0 && Array.isArray(r.evidence_ids) && new Set(r.evidence_ids).size === r.evidence_ids.length && hash(s.evidence.map(e => e.id)) === hash(r.evidence_ids), '请求证据引用无效');
    invariant(s.evidence.every(e => plain(e) && sameKeys(e, { id: true, source_label: true, locator: true, kind: true, quote: true }) && text(e.quote) && text(e.source_label) && text(e.locator)), '请求证据材料无效');
    const expected = questionsFor({ ...s.judgment, id: r.judgment_id }, policy, bundle.source_bindings, r.evidence_ids);
    invariant(plain(r.body.questions) && hash(r.body.questions) === hash(expected.questions), '题目/固定标准发生变化');
    if (policy.contract_version) invariant(hash(r.question_contracts) === hash(expected.contracts) && hash(s.source_identity) === hash(expected.contracts[0].sources) && r.combination_version === expected.contracts[0].combination_rule, '问题合同/来源/组合发生变化');
    checkSize(r.body);
  }
  if (policy.contract_version) invariant(bundle.question_count === bundle.requests.reduce((n,r)=>n + Object.keys(r.body.questions).length,0) && bundle.request_count === bundle.requests.length && bundle.candidate_count === [...bundle.requests,...bundle.local_results].reduce((n,r)=>n + (r.body?.state.judgment.candidates?.length ?? r.review_material?.judgment.candidates?.length ?? 0),0), '题目/请求/候选计数改变，请重新prepare');
  return bundle;
}
export function validateJudgmentResponse(response, request) {
  const answers = validateChoices(response, request);
  const combination = request.question_contracts ? combineBinaryAnswers(request, answers) : null;
  const combined = combination?.choice ?? legacyAnswerById(request, answers)?.provider_choice;
  return { judgment_id: request.judgment_id, kind: request.kind, model: response.model, answers: answers.map(a => ({ ...a, question_id: a.criterion_id, parent_id: request.judgment_id })), combined_choice: combined, combination, usage: response.usage, review_required: true, fallback: 'original_review' };
}
export async function verifyJudgmentSources(bundle, { readSource = file => readFile(file, 'utf8') } = {}) {
  const fail = '来源绑定缺失或不一致；未发起调用，请从原 packet 重新prepare';
  invariant(bundle.source_hashes && typeof bundle.source_hashes === 'object' && !Array.isArray(bundle.source_hashes), fail);
  invariant(bundle.source_bindings && typeof bundle.source_bindings === 'object' && !Array.isArray(bundle.source_bindings), fail);
  const used = new Map();
  const add = item => {
    invariant(item && text(item.id) && text(item.quote), fail);
    const original = used.get(item.id);
    invariant(!original || JSON.stringify(original) === JSON.stringify(item), fail);
    used.set(item.id, item);
  };
  for (const request of bundle.requests) for (const item of request.body.state.evidence) add(item);
  for (const local of bundle.local_results) {
    const rows = local.review_material?.evidence;
    invariant(Array.isArray(rows) || local.evidence_ids?.length === 0, fail);
    for (const item of rows ?? []) add(item);
  }
  const bindings = bundle.source_bindings;
  for (const [id, item] of used) {
    const binding = bindings[id];
    invariant(binding && binding.quote === item.quote && binding.source_label === item.source_label && binding.locator === item.locator && binding.kind === item.kind, fail);
  }
  const sources = new Map();
  for (const [id, binding] of Object.entries(bindings)) {
    invariant(text(id) && binding && typeof binding === 'object' && text(binding.source_file) && path.isAbsolute(binding.source_file) &&
      Number.isSafeInteger(binding.start_line) && binding.start_line > 0 && Number.isSafeInteger(binding.end_line) && binding.end_line >= binding.start_line &&
      /^[a-f0-9]{64}$/.test(binding.source_sha256) && text(binding.quote) && text(binding.source_label) && text(binding.locator), fail);
    invariant(bundle.source_hashes[binding.source_file] === binding.source_sha256, fail);
    if (!sources.has(binding.source_file)) {
      let source;
      try { source = normalize(await readSource(binding.source_file)); }
      catch { throw Object.assign(new Error('来源材料不可读；未发起调用，请回Codex核查并重新prepare'), { code: 'source_unreadable' }); }
      const actual = createHash('sha256').update(source).digest('hex');
      if (actual !== binding.source_sha256) throw Object.assign(new Error('来源材料已改变；未发起调用，请回Codex核查并重新prepare'), { code: 'source_changed' });
      sources.set(binding.source_file, source);
    }
    const lines = sources.get(binding.source_file).split('\n');
    invariant(binding.end_line <= lines.length && lines.slice(binding.start_line - 1, binding.end_line).join('\n') === binding.quote, fail);
  }
  invariant(Object.keys(bundle.source_hashes).length === sources.size && Object.keys(bundle.source_hashes).every(file => sources.has(file)), fail);
}

export async function executeJudgments(bundle, options = {}) {
  validateJudgmentBundle(bundle, options.routingPolicy ?? reviewRoutingPolicy);
  const currentControl = async () => { try { return options.readControl ? await options.readControl() : options.control; } catch { return { schema_version: 1, profiles: {} }; } };
  if (bundle.review_policy) {
    const preflight = await preflightReviewRouting(bundle, { policy: options.routingPolicy ?? reviewRoutingPolicy, qualification: options.qualification, control: await currentControl(), stateRoot: options.stateRoot, readSource: options.readSource });
    if (!preflight.eligible) return { status: 'review_fallback', attempts: 0, cache_hits: 0, request_sha256: bundle.request_sha256, standard_sha256: bundle.standard_sha256, review_required: true, fallback: 'original_review', ...resolveReviewRouting(bundle, null, { preflight, validateResponse: validateJudgmentResponse, policy: options.routingPolicy ?? reviewRoutingPolicy, cacheScope: options.cacheScope }) };
  }
  const evidenceKind = options.fetchImpl ? 'adapter_fixture' : 'provider_response';
  const stopped = new AbortController();
  const callerAbort = () => stopped.abort();
  if (options.signal?.aborted) stopped.abort();
  options.signal?.addEventListener('abort', callerAbort, { once: true });
  let sourceFailure = null;
  const verify = async () => { try { await verifyJudgmentSources(bundle, options); return true; }
    catch (error) { sourceFailure ??= error; return false; } };
  const sourceFallback = result => ({ ...result, provider_status: result.attempts > 0 && result.results?.length === result.attempts && !result.uncertain_charge ? 'completed' : result.status,
    status: 'review_fallback', failure_code: sourceFailure.code ?? 'source_unverified', source_valid: false,
    reason_codes: [sourceFailure.code ?? 'source_unverified'], review_required: true, fallback: 'original_review',
    results: (result.results ?? []).map(row => ({ ...row, source_valid: false, combined_choice: 'unknown',
      combination: row.combination ? { ...row.combination, choice: 'unknown', status: 'unknown', reason_codes: [sourceFailure.code ?? 'source_unverified'] } : null })) });
  let result;
  try {
    if (options.enabled !== false && !await verify()) {
      result = sourceFallback({ attempts: 0, cache_hits: 0, request_sha256: bundle.request_sha256, standard_sha256: bundle.standard_sha256, model_requested: bundle.model, local_results: bundle.local_results, results: [] });
      if (options.save) await options.save(result);
    } else {
      const checkedFetch = async (...args) => {
        if (!await verify()) throw sourceFailure;
        const receipt = await (options.fetchImpl ?? fetch)(...args);
        return { ok: receipt.ok, status: receipt.status, json: async () => {
          const raw = await receipt.json(); await verify();
          // Retain the completed receipt and its reported usage before stopping.
          // Abort in persist, after send/validate/ledger completion, to avoid turning
          // a known completed charge into an artificial uncertain charge.
          return raw;
        } };
      };
      const save = async value => {
        if (options.save) await options.save(sourceFailure ? sourceFallback(value) : value);
        if (options.enabled !== false && !await verify()) stopped.abort();
      };
      result = await executeFixedRequests(bundle, { ...options, signal: stopped.signal, fetchImpl: checkedFetch, save, evidenceKind, validate: validateJudgmentResponse });
      if (options.enabled !== false) await verify();
      if (sourceFailure) { result = sourceFallback(result); if (options.save) await options.save(result); }
      else result.source_valid = options.enabled === false ? null : true;
    }
  } finally { options.signal?.removeEventListener('abort', callerAbort); }
  const completed = { ...result, schema_version: 1, question_count: bundle.question_count, request_count: bundle.request_count, candidate_count: bundle.candidate_count, standard_version: bundle.standard_version, standard_sha256: bundle.standard_sha256, material_scope: bundle.material_scope, evidence_kind: evidenceKind === 'adapter_fixture' || result.results.some(row => row.origin === 'cache' && row.source_evidence_kind !== 'provider_response') ? 'adapter_fixture' : 'provider_response' };
  if (!bundle.review_policy) return completed;
  const after = await preflightReviewRouting(bundle, { policy: options.routingPolicy ?? reviewRoutingPolicy, qualification: options.qualification, control: await currentControl(), stateRoot: options.stateRoot, readSource: options.readSource });
  const routed = { ...completed, ...resolveReviewRouting(bundle, completed, { preflight: after, validateResponse: validateJudgmentResponse, policy: options.routingPolicy ?? reviewRoutingPolicy, ledger: options.ledger, cacheScope: options.cacheScope }) };
  try { if (options.save) await options.save(routed); }
  catch { return { ...routed, status: 'persistence_failed', review_routing: routed.review_routing.map(row => ({ ...row, action: 'codex_review', reason_codes: ['persistence_failed'] })) }; }
  return routed;
}

export function evaluateJudgments(dataset, runs, { costs = {} } = {}) {
  const policy = policyForSha(dataset?.standard_sha256);
  invariant(plain(dataset) && dataset.schema_version === 1 && Array.isArray(dataset.cases) && dataset.cases.length > 0 && Array.isArray(dataset.requests) && dataset.request_sha256 === hash(dataset.requests) && policy, '评估集或标准无效');
  const requestMap = new Map(dataset.requests.map(r => [r.judgment_id, r]));
  invariant(requestMap.size === dataset.requests.length, '评估材料包含重复判断');
  invariant(Array.isArray(runs), '评估 runs 必须为数组');
  const allIds = new Set();
  for (const c of dataset.cases) { invariant(plain(c) && text(c.id) && !allIds.has(c.id) && ['calibration', 'holdout'].includes(c.split) && Object.hasOwn(judgmentPolicy.kinds, c.kind) && text(c.expected_choice) && text(c.baseline_choice) && typeof c.critical === 'boolean', '评估样本无效或重复'); allIds.add(c.id); }
  const summaries = runs.map(run => {
    invariant(run.request_sha256 === dataset.request_sha256 && run.standard_sha256 === dataset.standard_sha256 && run.model_requested === MODEL, '运行与评估材料/标准/模型不匹配');
    const answers = new Map(); const question_rows = [];
    for (const row of [...(run.results ?? []), ...(run.local_results ?? [])]) {
      invariant(!answers.has(row.judgment_id), '运行包含重复判断结果');
      const request = requestMap.get(row.judgment_id); let choice; let confidence;
      if (request) {
        try { const validated = validateJudgmentResponse(row.raw_response, request); choice = run.source_valid === false ? 'unknown' : validated.combined_choice; confidence = Math.min(...validated.answers.map(a => a.confidence));
          for (const rawFact of validated.combination?.facts ?? []) { const fact = run.source_valid === false ? { ...rawFact, choice: 'unknown', reason: run.failure_code ?? 'source_unverified' } : rawFact; const expected = dataset.cases.find(c => c.id === request.judgment_id)?.expected_answers?.[fact.question_id]; question_rows.push({ ...fact, expected_choice: expected ?? null, correct: expected === undefined ? null : fact.choice === expected }); } }
        catch { choice = row.raw_response ? 'invalid_response' : 'missing_receipt'; for (const c of request.question_contracts ?? []) question_rows.push({ question_id: c.question_id, parent_id: c.parent_id, choice: 'unknown', reason: choice, expected_choice: dataset.cases.find(c => c.id === request.judgment_id)?.expected_answers?.[c.question_id] ?? null, correct: false }); }
      } else choice = row.origin === 'local_precheck' && ['unknown', 'insufficient', 'no_match'].includes(row.provider_choice) ? row.provider_choice : 'invalid_response';
      answers.set(row.judgment_id, { choice, origin: row.origin, confidence, reason: run.source_valid === false ? run.failure_code ?? 'source_unverified' : row.reason ?? null });
    }
    for (const request of dataset.requests) if (!answers.has(request.judgment_id)) for (const c of request.question_contracts ?? []) question_rows.push({ question_id: c.question_id, parent_id: c.parent_id, choice: 'unknown', reason: 'missing_receipt', correct: false });
    const rows = dataset.cases.map(c => {
      const a = answers.get(c.id); const choice = a?.choice ?? 'missing'; const correct = choice === c.expected_choice;
      return { case_id: c.id, split: c.split, kind: c.kind, expected_choice: c.expected_choice, baseline_choice: c.baseline_choice, actual_choice: choice, correct, critical_error: c.critical && !correct, abstained: ['unknown', 'insufficient', 'missing', 'missing_receipt', 'invalid_response'].includes(choice), origin: a?.origin ?? 'missing', confidence: a?.confidence, unknown_reason: a?.reason ?? (choice === 'missing' ? 'missing_receipt' : null) };
    });
    const aggregate = selected => ({ cases: selected.length, correct: selected.filter(r => r.correct).length, accuracy: selected.length ? selected.filter(r => r.correct).length / selected.length : 0, baseline_correct: selected.filter(r => r.baseline_choice === r.expected_choice).length, critical_errors: selected.filter(r => r.critical_error).length, false_yes: selected.filter(r => r.expected_choice === 'no' && r.actual_choice === 'yes').length, false_no: selected.filter(r => r.expected_choice === 'yes' && r.actual_choice === 'no').length, unsafe_supports: selected.filter(r => !r.correct && (['yes', 'supported'].includes(r.actual_choice) || (!policy.contract_version && r.kind === 'method_selection' && !['no_match', 'insufficient', 'missing', 'missing_receipt', 'invalid_response'].includes(r.actual_choice)))).length, false_duplicate_merges: selected.filter(r => r.kind === 'issue_duplicate' && !['yes', 'supported'].includes(r.expected_choice) && ['yes', 'supported'].includes(r.actual_choice)).length, missing_evidence_as_rejection: selected.filter(r => ['unknown', 'insufficient'].includes(r.expected_choice) && ['no', 'unsupported'].includes(r.actual_choice)).length, explicit_conflicts: selected.filter(r => ['no', 'unsupported'].includes(r.expected_choice)).length, explicit_conflicts_detected: selected.filter(r => ['no', 'unsupported'].includes(r.expected_choice) && ['no', 'unsupported'].includes(r.actual_choice)).length, abstentions: selected.filter(r => r.abstained).length, fallback_required: selected.filter(r => !r.correct || r.abstained).length, live_answers: selected.filter(r => r.origin === 'live').length, cache_answers: selected.filter(r => r.origin === 'cache').length });
    const holdout = aggregate(rows.filter(r => r.split === 'holdout')); const calibration = aggregate(rows.filter(r => r.split === 'calibration'));
    const adapterMatches = holdout.cases >= evaluationPolicy.minimum_holdout_cases && holdout.accuracy >= evaluationPolicy.required_holdout_accuracy && holdout.critical_errors <= evaluationPolicy.maximum_critical_errors && holdout.correct >= holdout.baseline_correct;
    const liveVerified = run.source_valid !== false && run.evidence_kind === 'provider_response' && run.status === 'completed' && holdout.live_answers === holdout.cases;
    return { evidence_kind: run.evidence_kind, status: run.status, adapter_matches_expected: adapterMatches, online_quality_passed: adapterMatches && liveVerified, holdout, calibration, question_count: question_rows.length, request_count: dataset.requests.length, candidate_count: dataset.requests.reduce((n,r) => n + (r.body.state.judgment.candidates?.length ?? 0),0), question_rows, unknown_reasons: Object.fromEntries([...new Set(question_rows.map(r => r.reason).filter(Boolean))].map(reason => [reason, question_rows.filter(r => r.reason === reason).length])), by_kind: Object.fromEntries(Object.keys(judgmentPolicy.kinds).map(kind => [kind, aggregate(rows.filter(r => r.split === 'holdout' && r.kind === kind))])), rows, usage: run.usage, estimated_request_cost_usd: run.estimated_cost_usd, uncertain_charge: run.uncertain_charge, attempts: run.attempts, cache_hits: run.cache_hits, elapsed_ms: Date.parse(run.finished_at) - Date.parse(run.started_at) };
  });
  const costKeys = ['baseline_total_usd', 'candidate_total_usd', 'material_preparation_usd', 'fallback_usd', 'human_review_usd', 'rework_usd'];
  const costKnown = costKeys.every(key => Number.isFinite(costs[key]) && costs[key] >= 0) && costs.baseline_total_usd > 0 && costs.original_judgment_replaced === true;
  const savedFraction = costKnown ? (costs.baseline_total_usd - costs.candidate_total_usd) / costs.baseline_total_usd : null;
  const result = { schema_version: 1, evaluation_policy_version: evaluationPolicy.version, standard_version: policy.version, model: MODEL, mode: evaluationPolicy.mode, baseline_kind: dataset.baseline_kind ?? 'unspecified', original_workflow_comparison_available: dataset.baseline_kind === 'measured_original_workflow', runs: summaries, online_quality_passed: summaries.length > 0 && summaries.every(r => r.online_quality_passed), total_cost_saving_fraction: savedFraction, cost_reduction_proven: costKnown && savedFraction >= evaluationPolicy.required_total_cost_saving_fraction && dataset.baseline_kind === 'measured_original_workflow' && summaries.length > 0 && summaries.every(r => r.online_quality_passed), costs, note: 'API成功和固定回执通过均不等于判断质量；缺答/弃权保留分母，缓存与实时分开。未有完整总成本及原调用替代记录，不宣称降本；仅小样本辅助试用，不关闭、批准或发布业务。' };
  const profileId = dataset.review_profile_id;
  if (profileId !== undefined) {
    const profile = reviewRoutingPolicy.profiles[profileId];
    const reasons = [];
    if (!profile || profileId !== 'ordinary_ui_copy_fidelity_v2' || profile.standard_sha256 !== dataset.standard_sha256 || dataset.requests.some(r => r.kind !== profile.kind) || dataset.cases.some(c => c.kind !== profile.kind)) reasons.push('profile_or_scope_mismatch');
    if (dataset.cases.filter(c => c.split === 'holdout').length < 12 || dataset.cases.some(c => !(policy.contract_version ? ['yes', 'no', 'unknown'] : ['supported', 'unsupported', 'insufficient', 'no_match']).includes(c.baseline_choice))) reasons.push('holdout_or_blind_baseline_missing');
    if (!summaries.length || summaries.some(r => !r.online_quality_passed || r.holdout.unsafe_supports !== 0 || r.holdout.live_answers !== r.holdout.cases)) reasons.push('online_quality_unverified');
    const work = costs.scoped_comparison;
    const parts = ['material_preparation_ms', 'api_wait_ms', 'fallback_ms', 'audit_ms', 'review_ms', 'rework_ms'];
    if (!plain(work) || work.original_workflow_measured !== true || work.business_checks_preserved !== true || work.ui_review_preserved !== true || !Number.isSafeInteger(work.actual_replaced_judgments) || work.actual_replaced_judgments <= 0 || !Number.isFinite(work.original_judgment_ms) || work.original_judgment_ms <= 0 || parts.some(k => !Number.isFinite(work[k]) || work[k] < 0) || !(work.original_judgment_ms > parts.reduce((sum, k) => sum + work[k], 0))) reasons.push('replacement_benefit_unverified');
    result.scoped_trial_eligible = reasons.length === 0;
    result.qualification = { status: reasons.length ? 'not_qualified' : 'quality_and_benefit_verified_pending_evidence_binding', reason_codes: reasons, profile_id: profileId, model: MODEL, standard_sha256: dataset.standard_sha256, profile_rules_sha256: profile ? profileRulesSha(profileId, profile) : null, dataset_sha256: hash(dataset), request_sha256: dataset.request_sha256, run_sha256: runs.map(hash), holdout_cases: summaries[0]?.holdout.cases ?? 0, holdout_correct: summaries[0]?.holdout.correct ?? 0, unsafe_supports: summaries[0]?.holdout.unsafe_supports ?? null, comparison_ref: work?.evidence_ref ?? null };
  }
  return result;
}
