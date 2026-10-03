import { readFile, writeFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadProfile } from '../src/profile.mjs';
import { readMap } from '../src/feature-store.mjs';
import { buildProjectJudgments, verifyProjectJudgmentSources } from '../src/judgment-project.mjs';
import { prepareJudgments, executeJudgments, validateJudgmentResponse } from '../src/judgment.mjs';
import { preflightReviewRouting, resolveReviewRouting } from '../src/judgment-routing.mjs';
import { buildJudgmentWorklist } from '../src/judgment-worklist.mjs';
import { resolveApiKey, withFileLedger, ledgerCost, validateLedger, requestKey, RESERVED_REQUEST_USD, atomicJson, hash, invariant, text, normalize } from '../skills/review-product-plan/scripts/jev-client.mjs';

const selective = { mode: 'selective', profile_id: 'ordinary_ui_copy_fidelity_v2' };
const unique = values => [...new Set(values)];
const codeTask = (task, reasons = []) => {
  const evidence = Array.isArray(task.evidence) ? task.evidence : [];
  const materialEmbedded = text(task.target) && task.context && typeof task.context === 'object' &&
    evidence.length > 0 && evidence.every(row => text(row.quote) && text(row.source_label) && text(row.original_locator));
  return { judgment_id: task.judgment_id, ac_id: task.ac_id, ac_revision: task.ac_revision, target_id: task.target_id,
    assertion_id: task.assertion_id, kind: task.kind, target: task.target, context: task.context, evidence,
    provider_choice: null, reason_codes: unique([...(task.reason_codes ?? []), ...reasons,
      ...(materialEmbedded ? [] : ['local_material_not_embedded'])]),
    full_material_ref: { artifact: 'project_plan', judgment_id: task.judgment_id },
    material_embedded: Boolean(materialEmbedded), material_redacted: false, redaction_reasons: [] };
};
const projection = bundle => { const { created_at, pricing, note, ...rest } = bundle; return rest; };
const checkedNumber = (value, integer = false) => {
  const number = Number(value);
  return value !== undefined && value !== '' && Number.isFinite(number) && number >= 0 && (!integer || Number.isSafeInteger(number)) ? number : null;
};
const readControl = async stateRoot => {
  try { return JSON.parse(normalize(await readFile(path.resolve(stateRoot, 'judgments/review-routing.json'), 'utf8'))); }
  catch { return { schema_version: 1, profiles: {} }; }
};
function makeWorklist(plan, items, runs, status, purpose, forcedReasons = []) {
  const worklists = items.map((item, index) => buildJudgmentWorklist(item.bundle, runs[index] ?? null));
  const reviewed = worklists.flatMap((list, index) => list.codex_tasks.map(row => {
    const original = items[index].task;
    return { ...codeTask(original, [...row.reason_codes, ...forcedReasons]), provider_choice: forcedReasons.length ? null : row.provider_choice,
      full_material_ref: { artifact: 'project_plan', judgment_id: original.judgment_id } };
  }));
  if (forcedReasons.length) for (const [index, list] of worklists.entries()) {
    if (list.reused_ids.includes(items[index].task.judgment_id)) reviewed.push(codeTask(items[index].task, forcedReasons));
  }
  const reused = forcedReasons.length ? [] : worklists.flatMap(list => list.reused_ids);
  const local = plan.codex_tasks.map(task => codeTask(task, forcedReasons));
  const ineligible = (plan.candidates ?? []).filter(task => !items.some(item => item.task.judgment_id === task.judgment_id))
    .map(task => codeTask(task, [...forcedReasons, purpose === 'daily' ? 'review_fallback' : 'preparation_failed']));
  const tasks = [...local, ...ineligible, ...reviewed];
  const standard = worklists[0]?.standard ?? buildJudgmentWorklist(items[0]?.bundle ?? {}, null).standard;
  return { schema_version: 1, mode: purpose === 'daily' ? 'selective' : 'advisory', status, provider_choice_role: 'advisory_only',
    counts: { total: plan.codex_tasks.length + plan.candidates.length, codex_review: tasks.length, reused: reused.length },
    reused_ids: reused, standard, codex_tasks: tasks };
}
function cached(ledger, bundle, request, useCache, cacheScope) {
  if (!useCache) return false;
  const key = requestKey(request, bundle.standard_sha256, cacheScope); const hit = ledger.cache[key];
  if (!hit || hit.model !== bundle.model || hit.standard_sha256 !== bundle.standard_sha256 || hit.request_sha256 !== hash(request.body) ||
    !ledger.entries.some(entry => entry.id === hit.source_entry && entry.status === 'completed' && entry.request_key === key)) return false;
  try { validateJudgmentResponse(hit.raw_response, request); return true; } catch { return false; }
}

/** Plan and execute bounded project judgments without granting semantic approval. */
export async function runProjectJudgmentCommand(command, options, dependencies = {}) {
  invariant(['plan', 'project'].includes(command), '未知 project 判断命令');
  invariant(options && typeof options === 'object', '缺少 project 参数');
  invariant(Boolean(options.profile) !== Boolean(options.project), '须且只能选择 --profile 或 --project');
  invariant(Boolean(options.change) !== Boolean(options.ids), '须且只能选择 --change 或 --ids');
  invariant(text(options.out), '缺少 --out');
  const purpose = options.purpose ?? 'daily'; invariant(['daily', 'validation'].includes(purpose), 'purpose 仅允许 daily/validation');
  invariant(options.cache === undefined || ['on', 'off'].includes(options.cache), 'cache 只允许 on/off');
  invariant(options.enabled === undefined || ['true', 'false'].includes(options.enabled), 'enabled 只允许 true/false');
  const stateRoot = path.resolve(options['state-root'] ?? '.');
  const profilePath = options.profile ? path.resolve(options.profile) : await (dependencies.resolveProjectProfile ?? (async () => {
    const { resolveProjectBinding } = await import('../src/binding.mjs');
    const binding = await resolveProjectBinding(stateRoot, path.resolve(options.project));
    invariant(binding.status === 'bound', `项目绑定不可用：${binding.reason ?? binding.status}`);
    return binding.profile;
  }))();
  const outputPath = path.resolve(options.out);
  const protectedPaths = [profilePath, options.ledger, options['key-config']].filter(Boolean).map(value => path.resolve(value));
  invariant(!protectedPaths.includes(outputPath), '输入、输出、ledger 路径冲突，禁止覆盖原件');
  const profile = await (dependencies.loadProfile ?? loadProfile)(profilePath);
  const map = await (dependencies.readMap ?? readMap)(profile);
  const selection = options.change ? { changeId: options.change } : { acIds: options.ids.split(',').map(id => id.trim()) };
  const plan = await (dependencies.buildProjectJudgments ?? buildProjectJudgments)(profile, map, selection);
  const sourceFiles = [...plan.candidates, ...plan.codex_tasks].flatMap(task => [
    ...(task.evidence ?? []).map(row => row.source_file), ...(task.source_bindings ?? []).map(row => path.resolve(profile.root, row.path))
  ]);
  const mapPath = path.resolve(profile.root, plan.map_binding.path);
  const inputs = [...sourceFiles, mapPath, profilePath].map(file => path.resolve(file));
  invariant(!inputs.includes(outputPath), '输入、输出路径冲突，禁止覆盖原件');
  if (options.ledger) {
    const ledgerPath = path.resolve(options.ledger);
    invariant(!inputs.includes(ledgerPath), 'ledger 与项目原件路径冲突，禁止覆盖原件');
    const canonicalLedger = await realpath(ledgerPath).catch(() => null);
    if (canonicalLedger) {
      const canonicalInputs = await Promise.all(inputs.map(file => realpath(file).catch(() => null)));
      invariant(!canonicalInputs.includes(canonicalLedger), 'ledger 与项目原件路径冲突，禁止覆盖原件');
    }
  }
  let sourceCheck = await (dependencies.verifyProjectJudgmentSources ?? verifyProjectJudgmentSources)(profile, plan);
  const items = []; const fallback = [];
  for (const task of plan.candidates) {
    try {
      const packet = { context: { expected: task.context?.expected, preconditions: task.context?.preconditions,
        actions: task.context?.actions }, material_scope: task.material_scope,
      evidence: task.evidence.map(row => ({ ...row, original_locator: `第${row.start_line}-${row.end_line}行` })),
        judgments: [{ id: task.judgment_id, kind: task.kind, target: task.target, evidence_ids: task.evidence.map(row => row.id) }],
        ...(purpose === 'daily' ? { review_policy: selective, review_scope: task.review_scope } : {}) };
      const bundle = await prepareJudgments(packet, { readSource: file => readFile(file, 'utf8') });
      let route = null;
      if (purpose === 'daily') {
        const preflight = await preflightReviewRouting(bundle, { control: await readControl(stateRoot), stateRoot });
        route = { ...preflight, ...resolveReviewRouting(bundle, null, { preflight }) };
      }
      if (purpose === 'daily' && !route.eligible) fallback.push({ task, bundle, route });
      else items.push({ task, bundle, route });
    } catch (error) { fallback.push({ task, error: error.message }); }
  }
  // Route decisions and the exact fixed requests are part of the approval fingerprint.
  const approvalMaterial = { purpose, selection, plan, prepared: [...items, ...fallback].map(item => ({ judgment_id: item.task.judgment_id,
    bundle: item.bundle ? projection(item.bundle) : null, route: item.route ?? null, error: item.error ?? null })) };
  const planSha = hash(approvalMaterial);
  const allItems = [...items, ...fallback.filter(item => item.bundle)];
  const runs = allItems.map(item => item.route && !item.route.eligible ? {
    status: 'review_fallback', attempts: 0, cache_hits: 0, request_sha256: item.bundle.request_sha256,
    standard_sha256: item.bundle.standard_sha256, review_required: true, fallback: 'original_review',
    review_routing: item.route.review_routing
  } : null);
  const activeIndices = allItems.flatMap((item, index) => items.includes(item) ? [index] : []);
  const initialStatus = command === 'plan' ? 'planned' : items.length ? 'blocked' : 'review_fallback';
  const plannedRequests = items.reduce((sum, item) => sum + item.bundle.requests.length, 0);
  const result = { schema_version: 1, status: initialStatus, purpose, project_id: plan.project_id,
    question_count: items.reduce((n,item)=>n + item.bundle.question_count,0), request_count: plannedRequests, candidate_count: plan.candidates.length, max_requests: plannedRequests, reserved_cost_usd: plannedRequests * RESERVED_REQUEST_USD,
    enabled: false, production_enabled: false, cost_reduction_proven: false,
    plan_sha256: planSha, plan, program_tasks: plan.program_tasks, prepared: allItems.map(item => ({ judgment_id: item.task.judgment_id, bundle: item.bundle, route: item.route })),
    runs, attempts: 0, cache_hits: 0, estimated_cost_usd: null, uncertain_charge: null,
    cumulative_budget_used_usd: null, cumulative_attempts: null, worklist: null, review_required: true, fallback: 'original_review' };
  const refresh = (status, forcedReasons = []) => {
    result.status = status;
    result.attempts = result.runs.reduce((n, run) => n + (run?.attempts ?? 0), 0);
    result.cache_hits = result.runs.reduce((n, run) => n + (run?.cache_hits ?? 0), 0);
    const costs = result.runs.map(run => run?.estimated_cost_usd).filter(Number.isFinite);
    result.estimated_cost_usd = result.uncertain_charge === true ? null : costs.length ? costs.reduce((a, b) => a + b, 0) : null;
    result.worklist = makeWorklist(plan, allItems, result.runs, status, purpose, forcedReasons);
    // Candidates without a prepared bundle are already represented by makeWorklist.
    result.worklist.counts.codex_review = result.worklist.codex_tasks.length;
    return result;
  };
  if (!sourceCheck.valid) refresh(command === 'plan' ? 'planned' : 'review_fallback', sourceCheck.reason_codes);
  else refresh(initialStatus);
  await writeFile(outputPath, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  if (command === 'plan' || !sourceCheck.valid || items.length === 0) return { ...result, output_path: outputPath };
  if (options.enabled === 'false') {
    result.failure_code = 'disabled'; refresh('disabled'); await atomicJson(outputPath, result); return { ...result, output_path: outputPath };
  }
  const approved = text(options['approved-sha']) && options['approved-sha'] === planSha;
  const budget = checkedNumber(options['budget-usd']); const maxRequests = checkedNumber(options['max-requests'], true);
  const timeout = options['timeout-ms'] === undefined ? 45000 : checkedNumber(options['timeout-ms'], true);
  if (!approved || !text(options.ledger) || budget === null || maxRequests === null || maxRequests < 1 || timeout === null || timeout < 1 || timeout > 45000) {
    result.failure_code = 'authorization_missing_or_mismatch';
    refresh('blocked'); await atomicJson(outputPath, result); return { ...result, output_path: outputPath };
  }
  let apiKey;
  try { apiKey = await (dependencies.resolveApiKey ?? resolveApiKey)(options['key-config'] ? { configPath: path.resolve(options['key-config']) } : {}); }
  catch { /* Keep credentials out of the output. */ }
  if (!text(apiKey)) {
    result.failure_code = 'missing_key'; refresh('blocked'); await atomicJson(outputPath, result); return { ...result, output_path: outputPath };
  }
  const controller = new AbortController(); const interrupt = () => controller.abort(); process.once('SIGINT', interrupt);
  try {
    await (dependencies.withFileLedger ?? withFileLedger)(options.ledger, async (ledger, saveLedger) => {
      validateLedger(ledger);
      result.cumulative_budget_used_usd = ledgerCost(ledger); result.cumulative_attempts = ledger.entries.length;
      result.uncertain_charge = ledger.entries.some(entry => entry.status !== 'completed');
      const pending = items.reduce((sum, item) => sum + item.bundle.requests.filter(request => !cached(ledger, item.bundle, request, options.cache !== 'off', planSha)).length, 0);
      if (ledgerCost(ledger) + pending * RESERVED_REQUEST_USD > budget || ledger.entries.length + pending > maxRequests) {
        result.failure_code = ledgerCost(ledger) + pending * RESERVED_REQUEST_USD > budget ? 'budget_exceeded' : 'request_limit_exceeded';
        refresh('blocked'); await atomicJson(outputPath, result); return;
      }
      sourceCheck = await (dependencies.verifyProjectJudgmentSources ?? verifyProjectJudgmentSources)(profile, plan);
      if (!sourceCheck.valid) { result.failure_code = 'source_changed'; refresh('review_fallback', sourceCheck.reason_codes); await atomicJson(outputPath, result); return; }
      result.enabled = true; refresh('running'); await atomicJson(outputPath, result);
      for (const index of activeIndices) {
        const item = allItems[index];
    const save = async run => {
      result.runs[index] = run;
      result.cumulative_budget_used_usd = ledgerCost(ledger); result.cumulative_attempts = ledger.entries.length;
      result.uncertain_charge = ledger.entries.some(entry => entry.status !== 'completed');
      refresh('running'); await atomicJson(outputPath, result);
    };
        const run = await executeJudgments(item.bundle, { apiKey, approvedSha: item.bundle.request_sha256, budgetUsd: budget,
          maxRequests, ledger, saveLedger, signal: controller.signal, timeoutMs: timeout, useCache: options.cache !== 'off', cacheScope: planSha,
          stateRoot, readControl: () => readControl(stateRoot), ...(dependencies.fetchImpl ? { fetchImpl: dependencies.fetchImpl } : {}), save });
        result.runs[index] = run;
        result.cumulative_budget_used_usd = ledgerCost(ledger); result.cumulative_attempts = ledger.entries.length;
        result.uncertain_charge = ledger.entries.some(entry => entry.status !== 'completed');
        refresh('running'); await atomicJson(outputPath, result);
        sourceCheck = await (dependencies.verifyProjectJudgmentSources ?? verifyProjectJudgmentSources)(profile, plan);
        if (!sourceCheck.valid) { result.failure_code = 'source_changed'; refresh('review_fallback', sourceCheck.reason_codes); await atomicJson(outputPath, result); return; }
        if (run.status !== 'completed') {
          result.failure_code = run.failure_code ?? 'provider_failed';
          refresh(run.status === 'review_fallback' ? 'review_fallback' : run.status === 'persistence_failed' ? 'recovery_required' : 'blocked');
          await atomicJson(outputPath, result); return;
        }
      }
      result.cumulative_budget_used_usd = ledgerCost(ledger); result.cumulative_attempts = ledger.entries.length;
      result.uncertain_charge = ledger.entries.some(entry => entry.status !== 'completed');
      refresh('completed'); await atomicJson(outputPath, result);
    });
  } catch (error) {
    let progress;
    try { progress = JSON.parse(normalize(await readFile(outputPath, 'utf8'))); } catch { /* Keep unknown progress in recovery file. */ }
    if ((progress?.attempts ?? 0) > 0 || progress?.status === 'running') {
      const recoveryPath = `${outputPath}.recovery-${randomUUID()}.json`;
      const recovery = { ...progress, status: 'recovery_required', failure_code: 'execution_or_persistence',
        error: '执行或保存异常；核对原输出与累计账本后恢复', recovery_path: recoveryPath, progress_path: outputPath,
        worklist: makeWorklist(plan, allItems, progress?.runs ?? runs, 'recovery_required', purpose, ['recovery_required']) };
      await writeFile(recoveryPath, JSON.stringify(recovery, null, 2) + '\n', { flag: 'wx' });
      return { ...recovery, output_path: outputPath };
    }
    result.failure_code = 'preflight'; result.error = error.message; refresh('blocked'); await atomicJson(outputPath, result);
  } finally { process.removeListener('SIGINT', interrupt); }
  return { ...result, output_path: outputPath };
}
