import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateJudgments } from '../../../src/judgment.mjs';
import { hash } from '../../../skills/review-product-plan/scripts/jev-client.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const defaults = {
  dataset: path.join(here, 'evidence/dataset-with-codex-baseline-20260928.json'),
  codexBaseline: path.join(here, 'evidence/codex-baseline-20260928.json'),
  jevRuns: [path.join(here, 'evidence/provider-evaluation-live-network-20260928.json')],
  effect: path.resolve(here, '../../../docs/evidence/ce-unified-20260928/jev-real-comparison.json')
};
const choiceSet = new Set(['supported', 'unsupported', 'insufficient', 'no_match']);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const validCount = value => Number.isSafeInteger(value) && value >= 0;
const ids = rows => rows.map(row => row.id ?? row.judgment_id);
const sameIds = (left, right) => left.length === right.length &&
  left.every(id => right.includes(id)) && new Set(left).size === left.length && new Set(right).size === right.length;
const median = values => {
  if (!values.length) return null;
  const ordered = [...values].sort((a, b) => a - b);
  const half = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[half] : (ordered[half - 1] + ordered[half]) / 2;
};
const percentile = (values, fraction) => values.length ? [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1] : null;

// Inspect only native session metadata, turn settings, and cumulative usage receipts.
// The journal may contain private conversation data; none of it enters the result.
export async function extractNativeWindow({ file, sessionId, startResponseId, endResponseId, scope,
  dedicatedSessionDeclaration = null }) {
  const dedicated = scope === 'dedicated_session';
  if (!file || !sessionId || !endResponseId ||
      (dedicated ? startResponseId !== null : !startResponseId || startResponseId === endResponseId ||
        !['task', 'workflow'].includes(scope)))
    throw new Error('Native window needs a journal, session, valid receipt IDs and scope');
  if (dedicated && (dedicatedSessionDeclaration?.sole_task !== true ||
      typeof dedicatedSessionDeclaration.task_ref !== 'string' || !dedicatedSessionDeclaration.task_ref.trim() ||
      !Number.isFinite(Date.parse(dedicatedSessionDeclaration.frozen_at))))
    throw new Error('A dedicated session declaration with sole task, task reference and frozen time is required');
  const bytes = await readFile(file);
  let metadataId = null, metadataTime = null, subagentSource = false;
  let model = null, effort = null, startModel = null, startEffort = null;
  let modelConsistent = true, start = null, end = null, lastReceiptId = null, malformed = 0;
  let journalLastTime = null;
  const fields = ['input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_output_tokens', 'total_tokens'];
  const validUsage = value => value && fields.every(key => validCount(value[key])) &&
    value.input_tokens + value.output_tokens === value.total_tokens &&
    value.cached_input_tokens <= value.input_tokens && value.reasoning_output_tokens <= value.output_tokens;
  for (const line of bytes.toString('utf8').split(/\r?\n/)) {
    if (!line) continue;
    const timestamp = line.match(/"timestamp"\s*:\s*"([^"]+)"/);
    const rowTime = timestamp ? Date.parse(timestamp[1]) : NaN;
    if (Number.isFinite(rowTime) && (journalLastTime === null || rowTime > journalLastTime)) journalLastTime = rowTime;
    if (!/"type"\s*:\s*"(?:session_meta|turn_context|token_usage_record)"/.test(line)) continue;
    let row;
    try { row = JSON.parse(line); } catch { malformed++; continue; }
    if (row.type === 'session_meta') {
      const id = row.payload?.id ?? row.payload?.session_id;
      if (metadataId && metadataId !== id) throw new Error('Journal has conflicting session IDs');
      metadataId = id;
      metadataTime = Date.parse(row.timestamp);
      let source = row.payload?.source;
      if (typeof source === 'string') { try { source = JSON.parse(source); } catch { source = null; } }
      subagentSource = !!source?.subagent && typeof row.payload?.parent_thread_id === 'string';
    } else if (row.type === 'turn_context') {
      const nextModel = typeof row.payload?.model === 'string' ? row.payload.model : null;
      const nextEffort = typeof row.payload?.effort === 'string' ? row.payload.effort : null;
      if (dedicated) {
        if (model !== null && (nextModel !== model || nextEffort !== effort)) modelConsistent = false;
      } else if (start && !end && (nextModel !== startModel || nextEffort !== startEffort)) modelConsistent = false;
      model = nextModel; effort = nextEffort;
    } else if (row.type === 'token_usage_record' && row.payload?.thread_id === sessionId) {
      const id = row.payload.response_id;
      lastReceiptId = id;
      if (id !== startResponseId && id !== endResponseId) continue;
      const usage = row.payload.thread_token_usage;
      const time = Date.parse(row.timestamp);
      if (!validUsage(usage) || !Number.isFinite(time)) throw new Error(`Invalid native receipt: ${id}`);
      if (id === startResponseId) {
        if (start) throw new Error('Duplicate start native receipt');
        if (end) throw new Error('Native receipt boundaries are reversed');
        start = { usage, time, responseId: id }; startModel = model; startEffort = effort;
      } else {
        if (end) throw new Error('Duplicate end native receipt');
        end = { usage, time, responseId: id };
      }
    }
  }
  if (malformed) throw new Error('Malformed native journal lines');
  if (metadataId !== sessionId) throw new Error('Native journal session does not match');
  if (!end || (!dedicated && !start)) throw new Error('Missing native receipt boundary');
  if (dedicated) {
    if (!subagentSource || !Number.isFinite(metadataTime) ||
        metadataTime < Date.parse(dedicatedSessionDeclaration.frozen_at))
      throw new Error('Dedicated agent session predates the frozen task or lacks subagent metadata');
    if (lastReceiptId !== endResponseId) throw new Error('End ID must name the final native receipt');
    if (!Number.isFinite(journalLastTime) || journalLastTime < end.time || end.time < metadataTime)
      throw new Error('Invalid dedicated session journal time');
  } else if (end.time <= start.time) throw new Error('Native receipt boundaries are not ordered');
  const codexTokens = Object.fromEntries([
    ['input', 'input_tokens'], ['cachedInput', 'cached_input_tokens'],
    ['output', 'output_tokens'], ['reasoningOutput', 'reasoning_output_tokens'], ['total', 'total_tokens']
  ].map(([name, key]) => [name, end.usage[key] - (dedicated ? 0 : start.usage[key])]));
  if (Object.values(codexTokens).some(value => value < 0) ||
      codexTokens.input + codexTokens.output !== codexTokens.total ||
      codexTokens.cachedInput > codexTokens.input || codexTokens.reasoningOutput > codexTokens.output)
    throw new Error('Native cumulative counters cannot form a valid delta');
  return { status: dedicated ? 'dedicated_agent_session_scope_unverified' : 'native_counter_window_scope_unverified', scope,
    journalSha256: sha(bytes), sessionId,
    receiptIds: { start: start?.responseId ?? null, end: end.responseId },
    receiptTimestamps: { start: start ? new Date(start.time).toISOString() : null,
      end: new Date(end.time).toISOString() },
    receiptWindowMs: dedicated ? null : end.time - start.time,
    journalSessionTimestamps: dedicated ? { start: new Date(metadataTime).toISOString(),
      end: new Date(journalLastTime).toISOString() } : null,
    journalSessionElapsedMs: dedicated ? journalLastTime - metadataTime : null,
    dedicatedTaskRef: dedicated ? dedicatedSessionDeclaration.task_ref : null,
    dedicatedFrozenAt: dedicated ? dedicatedSessionDeclaration.frozen_at : null,
    codexTokens,
    model: modelConsistent ? (dedicated ? model : startModel) : null,
    effort: modelConsistent ? (dedicated ? effort : startEffort) : null,
    modelConsistent,
    note: dedicated ? 'Full native cumulative usage for a declared dedicated agent session; journal first/last timestamps are an observed interval, not independently proven whole-workflow time.' :
      'Native counter and receipt interval only; task boundaries and whole-workflow scope require separate evidence.' };
}

function checkDataset(dataset, baseline) {
  if (dataset.schema_version !== 1 || !Array.isArray(dataset.requests) || !Array.isArray(dataset.cases) ||
      dataset.request_sha256 !== hash(dataset.requests) || !sameIds(ids(dataset.cases), ids(dataset.requests)))
    throw new Error('Dataset requests, cases or request hash differ');
  if (!baseline?.choices || !sameIds(Object.keys(baseline.choices), ids(dataset.cases)))
    throw new Error('Codex baseline does not cover the same cases');
  for (const item of dataset.cases) {
    if (!choiceSet.has(item.expected_choice) || !choiceSet.has(item.baseline_choice) ||
        baseline.choices[item.id] !== item.baseline_choice || !['calibration', 'holdout'].includes(item.split))
      throw new Error(`Invalid or mismatched answer key: ${item.id}`);
  }
}

function providerRun(dataset, run, sourceSha256) {
  if (run.request_sha256 !== dataset.request_sha256 || run.standard_sha256 !== dataset.standard_sha256 ||
      !sameIds(ids(run.results ?? []), ids(dataset.requests)))
    throw new Error('Jev run is not the same complete request set');
  const usage = run.usage;
  if (!validCount(usage?.input_tokens) || !validCount(usage?.output_tokens) ||
      ['input_tokens', 'output_tokens'].some(key => run.results.reduce((sum, row) => {
        if (!validCount(row.raw_response?.usage?.[key])) throw new Error(`Missing original Jev usage: ${row.judgment_id}`);
        return sum + row.raw_response.usage[key];
      }, 0) !== usage[key])) throw new Error('Jev token totals differ from original responses');
  const evaluation = evaluateJudgments(dataset, [run]);
  const scored = evaluation.runs[0];
  const started = Date.parse(run.started_at), finished = Date.parse(run.finished_at);
  const elapsedMs = Number.isFinite(started) && Number.isFinite(finished) && finished >= started ? finished - started : null;
  const perRequestMs = run.results.map(row => row.elapsed_ms).filter(value => Number.isFinite(value) && value >= 0);
  const realProvider = run.status === 'completed' && run.evidence_kind === 'provider_response' &&
    run.attempts === dataset.requests.length && run.cache_hits === 0 && run.results.every(row => row.origin === 'live');
  return {
    sourceSha256, status: run.status, evidenceKind: run.evidence_kind ?? null, realProvider,
    requestSha256: run.request_sha256, attempts: run.attempts, cacheHits: run.cache_hits,
    usage: { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens,
      totalTokens: usage.input_tokens + usage.output_tokens, owner: 'Jev API; not Codex' },
    apiElapsedMs: elapsedMs, perRequestElapsedMs: { median: median(perRequestMs), p95: percentile(perRequestMs, 0.95) },
    estimatedApiUsd: Number.isFinite(run.estimated_cost_usd) ? run.estimated_cost_usd : null,
    quality: { calibration: scored.calibration, holdout: scored.holdout,
      onlineQualityPassed: scored.online_quality_passed },
    rows: scored.rows.map(row => ({ id: row.case_id, split: row.split, expected: row.expected_choice,
      choice: row.actual_choice, correct: row.correct, abstained: row.abstained,
      criticalMiss: row.critical_error, unsafeSupport: !row.correct && row.actual_choice === 'supported',
      origin: row.origin }))
  };
}

function codexBaseline(dataset, baseline) {
  const groups = Object.fromEntries(['calibration', 'holdout'].map(split => {
    const rows = dataset.cases.filter(item => item.split === split);
    return [split, { cases: rows.length, correct: rows.filter(item => baseline.choices[item.id] === item.expected_choice).length }];
  }));
  return { kind: dataset.baseline_kind ?? 'unspecified', basis: baseline.basis ?? null,
    blindingLimit: baseline.blindingLimit ?? null, ...groups,
    codexTokens: validCount(baseline.usage?.codexTokens) ? baseline.usage.codexTokens : null,
    wallTimeSeconds: Number.isFinite(baseline.usage?.wallTimeSeconds) ? baseline.usage.wallTimeSeconds : null };
}

function workflowComparison(dataset, workflow) {
  const reasons = [];
  if (!workflow) reasons.push('No paired end-to-end workflow evidence');
  else if (workflow.schema_version !== 1 || workflow.request_sha256 !== dataset.request_sha256 ||
           workflow.scope !== 'paired_isolated_same_cases') reasons.push('Workflow scope or request hash differs');
  const usage = branch => {
    const item = workflow?.[branch];
    const tokens = item?.codex_usage;
    if (!item?.source_ref || !validCount(item.total_wall_ms) || !tokens ||
        !['input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_output_tokens', 'total_tokens'].every(key => validCount(tokens[key])) ||
        tokens.input_tokens + tokens.output_tokens !== tokens.total_tokens || tokens.cached_input_tokens > tokens.input_tokens)
      return null;
    return { sourceRef: item.source_ref, wallMs: item.total_wall_ms,
      codexTokens: { input: tokens.input_tokens, cachedInput: tokens.cached_input_tokens,
        output: tokens.output_tokens, reasoningOutput: tokens.reasoning_output_tokens, total: tokens.total_tokens } };
  };
  const noJev = usage('no_jev'), withJev = usage('with_jev');
  if (workflow && (!noJev || !withJev)) reasons.push('Both paths need original Codex usage and whole-workflow time');
  if (reasons.length) return { status: 'not_comparable', reasons,
    codexTokenDelta: null, wholeWorkflowTimeDeltaMs: null };
  return { status: 'paired_summary_requires_receipt_review', reasons: [], noJev, withJev,
    codexTokenDelta: noJev.codexTokens.total - withJev.codexTokens.total,
    wholeWorkflowTimeDeltaMs: noJev.wallMs - withJev.wallMs,
    note: 'Positive deltas in supplied summaries mean fewer Codex tokens or less total time in the Jev path. Original native receipts, task equality, and stage boundaries must be reviewed before claiming a saving.' };
}

function nativeWindowComparison(dataset, windows) {
  if (!windows.length) return { status: 'not_available', codexTokenDelta: null,
    receiptWindowDeltaMs: null, journalSessionDeltaMs: null };
  const mainWindows = windows.filter(item => ['no_jev', 'with_jev'].includes(item.arm));
  const failed = windows.filter(item => ['with_jev_failed_setup', 'with_jev_failed_attempt'].includes(item.arm));
  const noJev = mainWindows.find(item => item.arm === 'no_jev');
  const withJev = mainWindows.find(item => item.arm === 'with_jev');
  const reasons = [];
  if (mainWindows.length !== 2 || !noJev || !withJev) reasons.push('Both distinct arms need native receipt windows');
  if (windows.some(item => item.requestSha256 !== dataset.request_sha256)) reasons.push('Native window request hash differs');
  if (noJev && withJev && (noJev.scope !== withJev.scope || noJev.sessionId === withJev.sessionId))
    reasons.push('Native windows need the same scope in separate sessions');
  if (noJev?.scope === 'dedicated_session' && withJev?.scope === 'dedicated_session' &&
      (!noJev.dedicatedTaskRef || noJev.dedicatedTaskRef !== withJev.dedicatedTaskRef ||
       noJev.dedicatedFrozenAt !== withJev.dedicatedFrozenAt ||
       !validCount(noJev.journalSessionElapsedMs) || !validCount(withJev.journalSessionElapsedMs)))
    reasons.push('Dedicated arms need the same frozen task and complete journal intervals');
  if (mainWindows.some(item => !item.modelConsistent || !item.model || !item.effort) ||
      (noJev && withJev && (noJev.model !== withJev.model || noJev.effort !== withJev.effort)))
    reasons.push('Codex model or reasoning effort differs or is unknown');
  const extraReady = failed.every(item => item.scope === 'dedicated_session' &&
    item.dedicatedTaskRef === noJev?.dedicatedTaskRef &&
    item.dedicatedFrozenAt === noJev?.dedicatedFrozenAt &&
    item.sessionId !== noJev?.sessionId && item.sessionId !== withJev?.sessionId &&
    validCount(item.codexTokens?.total) && validCount(item.journalSessionElapsedMs) &&
    validCount(item.failedSetup?.providerAttemptsDeclared) &&
    ['unknown', 'uncertain', 'zero', 'charged'].includes(item.failedSetup?.chargeStatus) &&
    typeof item.failedSetup?.evidenceRef === 'string' && !!item.failedSetup.evidenceRef.trim());
  const additionalAttemptInvestment = { attempts: failed.length,
    status: extraReady ? 'native_usage_observed_failure_reason_declared' : 'incomplete',
    codexTokensTotal: extraReady ? failed.reduce((sum, item) => sum + item.codexTokens.total, 0) : null,
    journalSessionElapsedMsTotal: extraReady ? failed.reduce((sum, item) => sum + item.journalSessionElapsedMs, 0) : null,
    providerAttemptsDeclared: extraReady ? failed.reduce((sum, item) => sum + item.failedSetup.providerAttemptsDeclared, 0) : null,
    providerAttemptsVerified: false,
    uncertainChargeAttemptsDeclared: extraReady ? failed.filter(item => item.failedSetup.chargeStatus === 'uncertain').length : null,
    failedAttempts: failed };
  if (reasons.length) return { status: 'not_comparable', reasons,
    codexTokenDelta: null, receiptWindowDeltaMs: null, journalSessionDeltaMs: null,
    additionalAttemptInvestment, windows };
  return { status: 'native_counters_paired_scope_review_required', scope: noJev.scope,
    model: noJev.model, effort: noJev.effort, windows: mainWindows,
    codexTokenDelta: noJev.codexTokens.total - withJev.codexTokens.total,
    receiptWindowDeltaMs: noJev.scope === 'dedicated_session' ? null : noJev.receiptWindowMs - withJev.receiptWindowMs,
    journalSessionDeltaMs: noJev.scope === 'dedicated_session' ?
      noJev.journalSessionElapsedMs - withJev.journalSessionElapsedMs : null,
    additionalAttemptInvestment,
    codexTokenDeltaIncludingAdditionalAttempts: extraReady ?
      noJev.codexTokens.total - withJev.codexTokens.total - additionalAttemptInvestment.codexTokensTotal : null,
    journalSessionDeltaMsIncludingAdditionalAttempts: extraReady && noJev.scope === 'dedicated_session' ?
      noJev.journalSessionElapsedMs - withJev.journalSessionElapsedMs - additionalAttemptInvestment.journalSessionElapsedMsTotal : null,
    note: 'Native Codex usage and observed timing differences still need task-scope review. Journal session time is not independently proven whole-workflow time; check stage boundaries, related subagents, and fallback work.' };
}

export function compareJevCodex({ dataset, jevRuns, codex, effect = null, workflow = null, nativeWindows = [], sources = {} }) {
  checkDataset(dataset, codex);
  if (!Array.isArray(jevRuns) || !jevRuns.length) throw new Error('At least one original Jev run is required');
  if (effect && effect.requestSha256 !== dataset.request_sha256) throw new Error('Effect evidence is from another request set');
  const runs = jevRuns.map((run, index) => providerRun(dataset, run, sources.jevRuns?.[index] ?? null));
  const baseline = codexBaseline(dataset, codex);
  const comparison = workflowComparison(dataset, workflow);
  const holdout = dataset.cases.filter(item => item.split === 'holdout');
  return {
    schemaVersion: 1, comparisonKind: 'same_requests_offline_evidence_audit', networkCallsByThisScript: 0,
    sources, requestSha256: dataset.request_sha256, cases: { total: dataset.cases.length, holdout: holdout.length },
    noJev: { codexBaseline: baseline },
    withJev: { runs, actualReplacedJudgments: Number.isSafeInteger(effect?.workComparison?.actualReplacedJudgments)
      ? effect.workComparison.actualReplacedJudgments : null },
    pairedAccuracy: runs.map(run => ({ jevHoldoutCorrect: run.quality.holdout.correct,
      codexHoldoutCorrect: baseline.holdout.correct, holdoutCases: holdout.length,
      jevCriticalMisses: run.quality.holdout.critical_errors,
      jevUnsafeSupports: run.quality.holdout.unsafe_supports,
      jevAbstentions: run.quality.holdout.abstentions })),
    workflow: comparison, nativeReceiptWindows: nativeWindowComparison(dataset, nativeWindows),
    conclusion: {
      qualityQualified: runs.every(run => run.realProvider && run.quality.onlineQualityPassed),
      codexTokenSavingsProven: false,
      wholeWorkflowSpeedupProven: false,
      actualReplacementObserved: Number.isSafeInteger(effect?.workComparison?.actualReplacedJudgments)
        ? effect.workComparison.actualReplacedJudgments > 0 : null,
      limits: ['The current Codex baseline is one pass in the same conversation, not an independent blind trial.',
        'Jev API tokens are provider usage, not Codex token savings.',
        'API elapsed time excludes material preparation, Codex audit/fallback, and rework.',
        'The frozen answer key includes cases whose source sufficiency still needs separate review; this script never changes labels after seeing answers.']
    }
  };
}

const readJson = async file => {
  const raw = await readFile(file);
  return { value: JSON.parse(raw.toString('utf8').replace(/^\uFEFF/, '')), sha256: sha(raw) };
};
function options(args) {
  const parsed = { ...defaults, jevRuns: [], nativeWindows: [] };
  let datasetOverridden = false, effectOverridden = false;
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index], value = args[index + 1];
    if (!['--dataset', '--jev-run', '--codex-baseline', '--effect', '--workflow', '--native-window', '--out'].includes(key) || !value)
      throw new Error('Usage: node compare-jev-codex.mjs [--dataset FILE] [--jev-run FILE] [--codex-baseline FILE] [--effect FILE] [--workflow FILE] [--native-window FILE] [--out NEW_FILE]');
    if (key === '--jev-run') parsed.jevRuns.push(path.resolve(value));
    else if (key === '--native-window') parsed.nativeWindows.push(path.resolve(value));
    else parsed[{ '--dataset': 'dataset', '--codex-baseline': 'codexBaseline', '--effect': 'effect',
      '--workflow': 'workflow', '--out': 'out' }[key]] = path.resolve(value);
    if (key === '--dataset') datasetOverridden = true;
    if (key === '--effect') effectOverridden = true;
  }
  if (!parsed.jevRuns.length) parsed.jevRuns = defaults.jevRuns;
  if (datasetOverridden && !effectOverridden) parsed.effect = null;
  return parsed;
}
export async function main(args = process.argv.slice(2)) {
  const files = options(args);
  const [dataset, codex, effect, workflow, ...jevRuns] = await Promise.all([
    readJson(files.dataset), readJson(files.codexBaseline), files.effect ? readJson(files.effect) : null,
    files.workflow ? readJson(files.workflow) : null, ...files.jevRuns.map(readJson)
  ]);
  const nativeWindows = [];
  for (const configFile of files.nativeWindows) {
    const config = await readJson(configFile);
    const value = config.value;
    if (value.schema_version !== 1 || !['no_jev', 'with_jev', 'with_jev_failed_setup', 'with_jev_failed_attempt'].includes(value.arm) ||
        value.request_sha256 !== dataset.value.request_sha256)
      throw new Error('Native window configuration does not match the request set');
    const failure = value.failed_attempt ?? value.failed_setup;
    if (['with_jev_failed_setup', 'with_jev_failed_attempt'].includes(value.arm) &&
        (value.scope !== 'dedicated_session' || typeof failure?.code !== 'string' || !failure.code ||
         !validCount(failure.provider_attempts) ||
         (value.arm === 'with_jev_failed_setup' && failure.provider_attempts !== 0) ||
         !['unknown', 'uncertain', 'zero', 'charged'].includes(failure.charge_status ?? 'unknown') ||
         typeof failure.evidence_ref !== 'string' || !failure.evidence_ref))
      throw new Error('Failed attempt needs a dedicated agent, attempt count, charge status and separate evidence reference');
    const observation = await extractNativeWindow({ file: path.resolve(path.dirname(configFile), value.journal),
      sessionId: value.session_id, startResponseId: value.start_response_id,
      endResponseId: value.end_response_id, scope: value.scope,
      dedicatedSessionDeclaration: value.dedicated_session_declaration });
    nativeWindows.push({ arm: value.arm, requestSha256: value.request_sha256,
      configSha256: config.sha256, ...observation,
      ...(['with_jev_failed_setup', 'with_jev_failed_attempt'].includes(value.arm) ? { failedSetup: {
        code: failure.code, providerAttemptsDeclared: failure.provider_attempts,
        chargeStatus: failure.charge_status ?? 'unknown', evidenceRef: failure.evidence_ref } } : {}) });
  }
  const report = compareJevCodex({ dataset: dataset.value, codex: codex.value,
    effect: effect?.value, workflow: workflow?.value, nativeWindows,
    jevRuns: jevRuns.map(item => item.value),
    sources: { evaluator: sha(await readFile(fileURLToPath(import.meta.url))),
      dataset: dataset.sha256, codexBaseline: codex.sha256, effect: effect?.sha256 ?? null,
      workflow: workflow?.sha256 ?? null, nativeWindowConfigs: nativeWindows.map(item => item.configSha256),
      jevRuns: jevRuns.map(item => item.sha256) } });
  if (files.out) await writeFile(files.out, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  console.log(JSON.stringify({ requestSha256: report.requestSha256, pairedAccuracy: report.pairedAccuracy,
    jevApi: report.withJev.runs.map(run => ({ realProvider: run.realProvider, usage: run.usage,
      apiElapsedMs: run.apiElapsedMs })), codexTokens: report.noJev.codexBaseline.codexTokens,
    workflow: report.workflow.status, nativeReceiptWindows: report.nativeReceiptWindows.status,
    conclusion: report.conclusion }));
  return report;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
