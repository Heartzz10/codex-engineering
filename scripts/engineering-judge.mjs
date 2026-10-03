import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { prepareJudgments, executeJudgments, evaluateJudgments, validateJudgmentBundle, verifyJudgmentSources } from '../src/judgment.mjs';
import { preflightReviewRouting, resolveReviewRouting } from '../src/judgment-routing.mjs';
import { buildJudgmentWorklist, compactJudgmentWorklist } from '../src/judgment-worklist.mjs';
import { resolveApiKey, withFileLedger, ledgerCost, atomicJson, ReviewValidationError, invariant, text, normalize } from '../skills/review-product-plan/scripts/jev-client.mjs';


export function summarizeJudgmentCommand(result) {
  if (result.help) return result;
  if (['daily', 'validation'].includes(result.purpose)) return {
    output: result.output_path, status: result.status, purpose: result.purpose,
    project_id: result.project_id, plan_sha256: result.plan_sha256,
    attempts: result.attempts, cache_hits: result.cache_hits,
    estimated_cost_usd: result.estimated_cost_usd, cumulative_budget_used_usd: result.cumulative_budget_used_usd,
    uncertain_charge: result.uncertain_charge, production_enabled: result.production_enabled,
    reserved_cost_usd: result.reserved_cost_usd, max_requests: result.max_requests, question_count: result.question_count ?? result.prepared_bundle?.question_count, request_count: result.request_count ?? result.max_requests, candidate_count: result.candidate_count ?? result.prepared_bundle?.candidate_count,
    failure_code: result.failure_code, error: result.error, recovery_path: result.recovery_path,
    program_tasks: result.program_tasks, worklist: result.worklist ? compactJudgmentWorklist(result.worklist) : undefined
  };
  return { output: result.output_path, status: result.status, requests: result.max_requests,
    request_sha256: result.request_sha256, reserved_cost_usd: result.reserved_cost_usd,
    attempts: result.attempts, cache_hits: result.cache_hits,
    estimated_cost_usd: result.estimated_cost_usd, cumulative_budget_used_usd: result.cumulative_budget_used_usd,
    cumulative_attempts: result.cumulative_attempts, provider_status: result.provider_status,
    uncertain_charge: result.uncertain_charge, online_quality_passed: result.online_quality_passed,
    cost_reduction_proven: result.cost_reduction_proven, failure_code: result.failure_code,
    error: result.error, review_required: result.review_required, fallback: result.fallback,
    review_routing: result.review_routing, progress_path: result.progress_path,
    recovery_path: result.recovery_path, worklist: result.worklist };
}

export async function runJudgmentCommand(args, dependencies = {}) {
  args = [...args]; const command = args.shift();
  if (!command || command === '--help') {
    return { help: [
      'Node22+',
      'plan (--profile FILE|--project DIR) (--change CHG-ID|--ids AC-ID[,AC-ID]) --out plan.json [--purpose daily|validation]',
      'project (--profile FILE|--project DIR) (--change CHG-ID|--ids AC-ID[,AC-ID]) --out result.json [--purpose daily|validation]',
      'project 默认为daily：无有效资格直接回Codex且零调用。validation是显式质量试验；须用plan生成的plan_sha256作为approved-sha，并提供累计budget-usd/max-requests/ledger。',
      'review --input packet.json|preview.json --out result.json --approved-sha <SHA> --budget-usd <累计上限> --max-requests <累计请求上限> --ledger ledger.json',
      'prepare --input packet.json --out preview.json',
      'run --input preview.json --out result.json --approved-sha <SHA> --budget-usd <累计上限> --max-requests <累计请求上限> --ledger ledger.json',
      'evaluate --input result.json --dataset dataset.json --out evaluation.json [--costs costs.json]',
      '执行可带 --state-root <CE本地状态根> --key-config <凭据引用JSON> --cache off --enabled false。plan/prepare/evaluate不联网；已有review/run保留独立材料试验用途，不自动成为日常免复核。无自动重试。'
    ].join('\n') };
  }
  invariant(['prepare', 'run', 'review', 'evaluate', 'plan', 'project'].includes(command), '未知 judge 命令');
  const executionOptions = ['input', 'out', 'approved-sha', 'budget-usd', 'max-requests', 'ledger', 'key-config', 'timeout-ms', 'cache', 'enabled', 'state-root'];
  const projectOptions = [...executionOptions.filter(key => key !== 'input'), 'profile', 'project', 'change', 'ids', 'purpose'];
  const allowed = { prepare: ['input', 'out'], run: executionOptions, review: executionOptions, evaluate: ['input', 'out', 'dataset', 'costs'], plan: projectOptions, project: projectOptions }[command];
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i].replace(/^--/, ''); invariant(args[i].startsWith('--') && allowed.includes(key) && !Object.hasOwn(options, key) && text(args[i + 1]), '无效、重复或缺值参数'); options[key] = args[i + 1];
  }
  if (['plan', 'project'].includes(command)) {
    const { runProjectJudgmentCommand } = await import('./engineering-judge-project.mjs');
    return runProjectJudgmentCommand(command, options, dependencies);
  }
  invariant(text(options.input) && text(options.out), '缺少 --input / --out');
  const inputPath = path.resolve(options.input); const outputPath = path.resolve(options.out);
  invariant(inputPath !== outputPath && (!options.ledger || path.resolve(options.ledger) !== outputPath) && (!options.ledger || path.resolve(options.ledger) !== inputPath), '输入、输出、ledger不得互相覆盖');
  const input = JSON.parse(normalize(await readFile(inputPath, 'utf8')));
  let result;
  if (command === 'prepare') {
    result = await prepareJudgments(input, { baseDir: path.dirname(inputPath) });
    await writeFile(outputPath, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
    return { ...result, output_path: outputPath };
  }
  if (command === 'evaluate') {
    invariant(text(options.dataset), '缺少 --dataset');
    const dataset = JSON.parse(normalize(await readFile(path.resolve(options.dataset), 'utf8')));
    const costs = options.costs ? JSON.parse(normalize(await readFile(path.resolve(options.costs), 'utf8'))) : {};
    result = evaluateJudgments(dataset, Array.isArray(input) ? input : [input], { costs });
    await writeFile(outputPath, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
    return { ...result, output_path: outputPath };
  }
  const bundle = command === 'review' && !Array.isArray(input.requests)
    ? await prepareJudgments(input, { baseDir: path.dirname(inputPath) }) : input;
  validateJudgmentBundle(bundle);
  await verifyJudgmentSources(bundle);
  const noCall = (status, extra = {}) => {
    const value = { status, attempts: 0, cache_hits: 0, request_sha256: bundle.request_sha256,
      standard_sha256: bundle.standard_sha256, local_results: bundle.local_results,
      review_required: true, fallback: 'original_review', ...extra };
    value.worklist = buildJudgmentWorklist(bundle, value);
    if (command === 'review') value.prepared_bundle = bundle;
    return value;
  };
  if ((options.cache !== undefined && !['on', 'off'].includes(options.cache)) ||
      (options.enabled !== undefined && !['true', 'false'].includes(options.enabled))) {
    result = noCall('blocked', { failure_code: 'invalid_parameter', error: 'cache只接受on/off，enabled只接受true/false；未发起调用', cumulative_budget_used_usd: null, cumulative_attempts: null, uncertain_charge: null });
    await writeFile(outputPath, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
    return { ...result, output_path: outputPath };
  }
  if (bundle.requests.length === 0) {
    result = noCall('review_fallback', { failure_code: 'local_precheck' });
    await writeFile(outputPath, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
    return { ...result, output_path: outputPath };
  }
  let control; let readControl;
  if (bundle.review_policy) {
    const controlFile = path.resolve(options['state-root'] ?? '.', 'judgments/review-routing.json');
    readControl = async () => { try { return JSON.parse(normalize(await readFile(controlFile, 'utf8'))); } catch { return { schema_version: 1, profiles: {} }; } };
    control = await readControl();
    const preflight = await preflightReviewRouting(bundle, { control, stateRoot: options['state-root'] });
    if (!preflight.eligible) {
      result = noCall('review_fallback', resolveReviewRouting(bundle, null, { preflight }));
      await writeFile(outputPath, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
      return { ...result, output_path: outputPath };
    }
  }
  const enabled = options.enabled !== 'false';
  if (!enabled) {
    result = noCall('disabled', { failure_code: 'disabled' });
    await writeFile(outputPath, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
    return { ...result, output_path: outputPath };
  }
  if (!(text(options.ledger) && text(options['max-requests']) && text(options['budget-usd']) && text(options['approved-sha']))) {
    result = noCall('blocked', { failure_code: 'authorization_missing', error: `${command}须明确 --ledger、--max-requests、--budget-usd和授权指纹`, cumulative_budget_used_usd: null, cumulative_attempts: null, uncertain_charge: null });
    await writeFile(outputPath, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
    return { ...result, output_path: outputPath };
  }
  await writeFile(outputPath, JSON.stringify({ status: 'not_started', attempts: 0 }), { flag: 'wx' });
  let apiKey; let keyError;
  try { apiKey = await (dependencies.resolveApiKey ?? resolveApiKey)(options['key-config'] ? { configPath: path.resolve(options['key-config']) } : {}); }
  catch (error) { keyError = error; }
  if (keyError || !text(apiKey)) {
    result = noCall('blocked', { failure_code: 'missing_key', error: keyError?.message ?? '缺少Jev密钥引用；未发起调用',
      cumulative_budget_used_usd: null, cumulative_attempts: null, uncertain_charge: null });
    await atomicJson(outputPath, result);
    return { ...result, output_path: outputPath };
  }
  const controller = new AbortController(); const onInterrupt = () => controller.abort(); process.once('SIGINT', onInterrupt);
  let ledgerExposure = null;
  try {
    result = await (dependencies.withFileLedger ?? withFileLedger)(options.ledger, (ledger, saveLedger) => {
      ledgerExposure = { cumulative_budget_used_usd: ledgerCost(ledger), cumulative_attempts: ledger.entries.length,
        uncertain_charge: ledger.entries.some(entry => entry.status !== 'completed') };
      return executeJudgments(bundle, { apiKey, approvedSha: options['approved-sha'], budgetUsd: Number(options['budget-usd']), maxRequests: Number(options['max-requests']), ledger, saveLedger, signal: controller.signal, timeoutMs: options['timeout-ms'] === undefined ? 45000 : Number(options['timeout-ms']), useCache: options.cache !== 'off', enabled, control, readControl, stateRoot: options['state-root'], ...(dependencies.fetchImpl ? { fetchImpl: dependencies.fetchImpl } : {}), save: value => atomicJson(outputPath, value) });
    });
    if (result.status === 'completed') {
      try { await verifyJudgmentSources(bundle); }
      catch (error) {
        const reason = ['source_changed', 'source_unreadable'].includes(error.code) ? error.code : 'source_unverified';
        result = { ...result, provider_status: result.status, status: 'review_fallback', failure_code: reason,
          reason_codes: [reason], error: '调用后来源已变化或不可核验；保留原始回执与费用，所有题目回Codex重新核查',
          review_required: true, fallback: 'original_review',
          ...(Array.isArray(result.review_routing) ? { review_routing: result.review_routing.map(row => ({ ...row, action: 'codex_review', reason_codes: [reason] })) } : {}) };
      }
    }
    result.worklist = buildJudgmentWorklist(bundle, result);
    if (command === 'review') result.prepared_bundle = bundle;
    // Persist the engineering metadata added by the wrapper as well as transport progress.
    if (result.status !== 'persistence_failed') await atomicJson(outputPath, result);
    else await writeFile(`${outputPath}.recovery-${randomUUID()}.json`, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  } catch (error) {
    let progress;
    try { progress = JSON.parse(normalize(await readFile(outputPath, 'utf8'))); } catch { /* Keep unknown progress in recovery path. */ }
    const message = error instanceof ReviewValidationError ? error.message
      : error.message === '累计费用 ledger 被占用；核对在途请求后恢复，不自动删除锁' ? error.message
        : '执行检查或保存失败；核对输出和累计费用账本后恢复';
    if (progress?.status === 'not_started' && progress.attempts === 0) {
      result = noCall('blocked', { failure_code: 'preflight', error: message, ...ledgerExposure,
        cumulative_budget_used_usd: ledgerExposure?.cumulative_budget_used_usd ?? null,
        cumulative_attempts: ledgerExposure?.cumulative_attempts ?? null,
        uncertain_charge: ledgerExposure?.uncertain_charge ?? null });
      await atomicJson(outputPath, result);
    } else {
      const recoveryPath = `${outputPath}.recovery-${randomUUID()}.json`;
      result = { status: 'recovery_required', provider_status: progress?.status ?? null,
        request_sha256: bundle.request_sha256, standard_sha256: bundle.standard_sha256,
        attempts: Number.isSafeInteger(progress?.attempts) ? progress.attempts : null,
        uncertain_charge: typeof progress?.uncertain_charge === 'boolean' ? progress.uncertain_charge : null,
        cumulative_budget_used_usd: Number.isFinite(progress?.cumulative_budget_used_usd) ? progress.cumulative_budget_used_usd : null,
        failure_code: 'execution_or_persistence', error: message, review_required: true, fallback: 'original_review',
        progress_path: outputPath, recovery_path: recoveryPath };
      result.worklist = buildJudgmentWorklist(bundle, result);
      if (command === 'review') result.prepared_bundle = bundle;
      await writeFile(recoveryPath, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
    }
  } finally { process.removeListener('SIGINT', onInterrupt); }
  return { ...result, output_path: outputPath };
}
export async function main(args) {
  const result = await runJudgmentCommand(args);
  if (result.help) console.log(result.help);
  else console.log(JSON.stringify(args[0] === 'evaluate' ? result : summarizeJudgmentCommand(result)));
  if (result.status && !['completed', 'disabled', 'review_fallback', 'planned'].includes(result.status)) process.exitCode = 1;
  return result;
}
export const engineeringJudgeMain = main;
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
