import policy from '../policies/cost.json' with { type: 'json' };

const KINDS = new Set(['consultation', 'discovery', 'implementation', 'debugging', 'verification']);
const RISKS = new Set(['low', 'medium', 'high']);

function routeFor(task) {
  const issues = [];
  if (!KINDS.has(task.kind)) issues.push('out-of-category');
  if (task.risk !== undefined && !RISKS.has(task.risk)) issues.push('validation-failed');
  if (task.workType !== undefined && !policy.riskControls.workTypes.includes(task.workType)) issues.push('out-of-category');
  for (const field of policy.riskControls.required) {
    if (task[field] === undefined) issues.push('missing-risk-control');
    else if (field === 'errorConsequence' ? !RISKS.has(task[field]) : typeof task[field] !== 'boolean') issues.push('validation-failed');
  }
  if (task.signals !== undefined && (!Array.isArray(task.signals) || task.signals.some(signal => !policy.escalateWhen.includes(signal)))) issues.push('validation-failed');
  if (Array.isArray(task.signals)) issues.push(...task.signals.filter(signal => policy.escalateWhen.includes(signal)));
  const uniqueIssues = [...new Set(issues)];
  const riskRank = { low: 0, medium: 1, high: 2 };
  let risk = RISKS.has(task.risk) ? task.risk : 'medium';
  if (RISKS.has(task.errorConsequence) && riskRank[task.errorConsequence] > riskRank[risk]) risk = task.errorConsequence;
  // Incomplete safety metadata never earns delegation. Existing risk labels remain
  // compatible as a capability floor while investigation fills the missing facts.
  const hiddenOrIrreversible = task.automaticDetection === false || task.reversible === false;
  if (hiddenOrIrreversible && risk === 'low') risk = 'medium';
  if (task.errorConsequence === 'high' || uniqueIssues.includes('capability-related-failure')) risk = 'high';
  const action = uniqueIssues.length
    ? uniqueIssues.includes('capability-related-failure') ? 'escalate' : 'investigate'
    : risk === 'high' ? 'escalate' : 'continue';
  return {
    action, assessedRisk: risk, issues: uniqueIssues,
    nextStep: action === 'investigate'
      ? '补齐缺失字段，核对冲突原件或复现校验失败，再重评受影响范围。'
      : action === 'escalate'
        ? '保留足够能力并核必要检查；有显式用户设置时保留设置，向调用者报告能力要求。'
        : '按已知后果和验证能力执行，复用仍有效的检查证据。',
    decisionBasis: { errorConsequence: task.errorConsequence ?? null, automaticDetection: typeof task.automaticDetection === 'boolean' ? task.automaticDetection : null, reversible: typeof task.reversible === 'boolean' ? task.reversible : null },
  };
}

function supportedModels(availableModels) {
  if (!Array.isArray(availableModels)) return null;
  return availableModels.filter(model =>
    model && typeof model.id === 'string' && Array.isArray(model.efforts)
  );
}

function byId(models, id) {
  return models.find(model => model.id === id);
}

function byFamily(models, family) {
  const suffix = policy.modelFamilies[family];
  return models.find(model => model.id.toLowerCase().endsWith(`-${suffix}`));
}

function chooseModel(models, task, executor) {
  const current = task.currentModel && byId(models, task.currentModel);
  if (task.kind === 'consultation') return current ?? null;
  if (executor === 'subagent') return byFamily(models, 'light') ?? null;
  if (task.risk === 'high') {
    if (current && /-(astra|sol)$/i.test(current.id)) return current;
    return byFamily(models, 'strong') ?? byFamily(models, 'standard') ?? null;
  }
  if (task.risk === 'medium') {
    if (current && !/-luna$/i.test(current.id)) return current;
    return byFamily(models, 'standard') ?? byFamily(models, 'strong') ?? null;
  }
  return current ?? byFamily(models, 'standard') ?? byFamily(models, 'light') ?? null;
}

function chooseEffort(model, task, executor) {
  if (!model) return null;
  if (task.currentModel === model.id && task.currentEffort &&
      model.efforts.includes(task.currentEffort) && executor === 'main' &&
      task.kind === 'consultation') return task.currentEffort;
  const level = executor === 'subagent' && task.workType === 'browser'
    ? 'browser'
    : task.risk;
  return policy.effortPreference[level].find(effort => model.efforts.includes(effort)) ?? null;
}

function checksFor(task) {
  const checks = [];
  if (task.kind === 'implementation' && task.workType === 'code') checks.push('targeted-tests');
  if (task.kind === 'debugging') checks.push('reproduction-evidence');
  if (task.kind === 'verification' || task.workType === 'browser') checks.push('actual-entry-result');
  if (task.risk === 'high') checks.push('risk-review');
  return checks;
}

function contextFor(task, executor) {
  if (executor === 'program') return ['bounded-search-paths', 'query-and-result-limit'];
  if (executor === 'subagent' && task.workType === 'browser') {
    return ['entry-and-role', 'steps-and-expected-result', 'scope-boundary'];
  }
  if (executor === 'subagent') return ['bounded-files', 'question-and-stop-condition'];
  return task.kind === 'consultation'
    ? ['user-question', 'relevant-existing-context']
    : ['task-requirements', 'relevant-files-and-current-state'];
}

/** Advisory choice only. Native callers must apply settings and observe actual values. */
export function chooseCostPolicy(task = {}, availableModels) {
  if (!task || typeof task !== 'object' || Array.isArray(task)) task = {};
  const route = routeFor(task);
  const input = {
    ...task,
    kind: KINDS.has(task.kind) ? task.kind : 'implementation',
    risk: route.assessedRisk,
  };
  const models = supportedModels(availableModels);
  const deterministicSearch = input.deterministic === true && input.workType === 'search';
  let executor = deterministicSearch ? 'program' : 'main';
  if (!deterministicSearch && route.action === 'continue' && input.kind !== 'consultation' && input.risk === 'low' &&
      input.scopeClear === true && input.independent === true && models?.length &&
      byFamily(models, 'light')) executor = 'subagent';

  const result = {
    executor,
    recommendedModel: null,
    recommendedEffort: null,
    reason: '',
    contextScope: contextFor(input, executor),
    requiredChecks: checksFor(input),
    escalateWhen: [...policy.escalateWhen],
    enforcement: executor === 'program' ? 'programmatic' : executor === 'subagent' ? 'native-configurable' : 'advisory',
    effectiveModel: null,
    effectiveEffort: null,
    supportStatus: executor === 'program' ? 'not-applicable' : 'unavailable',
    unsupportedRequest: null,
    route,
    limitation: '建议不是主对话设置变更。子代理可由原生调用参数采用建议，实际模型与档位只从真实调用收据读取。',
  };

  if (executor === 'program') {
    result.reason = '可确定定位的搜索先由程序执行。';
    return result;
  }
  if (!models?.length) {
    result.executor = 'main';
    result.enforcement = 'advisory';
    result.contextScope = contextFor(input, 'main');
    result.reason = '缺少当前入口支持的模型清单，无法验证模型或档位。';
    return result;
  }

  let model;
  if (input.explicitModel) {
    model = byId(models, input.explicitModel);
    if (!model) {
      result.executor = 'main';
      result.enforcement = 'advisory';
      result.contextScope = contextFor(input, 'main');
      result.supportStatus = 'unsupported';
      result.unsupportedRequest = { model: input.explicitModel };
      result.reason = '用户指定模型不在当前入口的支持清单中，未替换为其他模型。';
      return result;
    }
  } else {
    model = chooseModel(models, input, executor);
  }

  if (!model) {
    result.executor = 'main';
    result.enforcement = 'advisory';
    result.contextScope = contextFor(input, 'main');
    result.reason = '支持清单中没有符合任务风险的候选模型，保留主代理处理。';
    return result;
  }

  result.recommendedModel = model.id;
  if (input.explicitEffort) {
    if (!model.efforts.includes(input.explicitEffort)) {
      result.executor = 'main';
      result.enforcement = 'advisory';
      result.contextScope = contextFor(input, 'main');
      result.supportStatus = 'unsupported';
      result.unsupportedRequest = { effort: input.explicitEffort };
      result.reason = '用户指定推理档位不受该模型支持，未替换为其他档位。';
      return result;
    }
    result.recommendedEffort = input.explicitEffort;
  } else {
    result.recommendedEffort = chooseEffort(model, input, executor);
  }
  result.supportStatus = result.recommendedEffort ? 'supported' : 'unavailable';
  if (!result.recommendedEffort && result.executor === 'subagent') {
    result.executor = 'main';
    result.enforcement = 'advisory';
    result.contextScope = contextFor(input, 'main');
  }
  result.reason = input.explicitModel || input.explicitEffort
    ? '优先保留用户指定且当前入口支持的设置；仅提供建议，生效值需原生调用者核对。'
    : executor === 'subagent'
      ? '范围清楚且可独立完成的低风险任务，可由受支持的轻量子代理执行。'
      : input.risk === 'high'
        ? '高风险任务由主代理处理并保留足够能力。'
        : '当前任务由主代理直接处理，避免无收益的委派。';
  return result;
}

const reference = value => typeof value === 'string' && value.trim().length > 0;
const references = value => Array.isArray(value) && value.every(reference) ? value : [];

/** Advisory retry decision. The existing runner must enforce it before spawn. */
export function assessRetry(attempts = [], nextAttempt = {}) {
  if (!Array.isArray(attempts) || !nextAttempt || !reference(nextAttempt.fingerprint)) {
    return { action: 'stop-and-investigate', reason: 'invalid-retry-input', newEvidenceRefs: [], enforced: false };
  }
  if (!attempts.length) return { action: 'run', reason: 'first-attempt', newEvidenceRefs: [], enforced: false };
  const latest = attempts[attempts.length - 1];
  if (!latest || !reference(latest.fingerprint) || !reference(latest.status)) {
    return { action: 'stop-and-investigate', reason: 'invalid-prior-receipt', newEvidenceRefs: [], enforced: false };
  }
  const priorRefs = new Set(attempts.flatMap(attempt => references(attempt.evidenceRefs)));
  const newEvidenceRefs = references(nextAttempt.evidenceRefs).filter(ref => !priorRefs.has(ref));
  const changed = latest.fingerprint !== nextAttempt.fingerprint;
  const requested = reference(nextAttempt.userRequestRef);
  if (changed || newEvidenceRefs.length || requested) {
    return { action: 'run', reason: changed ? 'changed-input-or-environment' : newEvidenceRefs.length ? 'new-evidence' : 'explicit-user-request', newEvidenceRefs, enforced: false };
  }
  const passed = ['check_passed', 'passed'].includes(latest.status);
  return { action: passed ? 'reuse' : 'stop-and-investigate', reason: passed ? 'unchanged-valid-result' : 'unchanged-failure-without-new-evidence', newEvidenceRefs: [], enforced: false };
}

function amountObservation(value) {
  return value && typeof value === 'object' && Number.isFinite(value.amount) && value.amount >= 0 &&
    /^[A-Z]{3}$/.test(value.currency) && reference(value.sourceRef) ? value : null;
}

function summarizeAmounts(items) {
  const knownByCurrency = {};
  const unknownRefs = [];
  items.forEach((item, index) => {
    const cost = amountObservation(item?.cost);
    if (!cost) unknownRefs.push(item?.sourceRef || item?.id || `item:${index + 1}`);
    else knownByCurrency[cost.currency] = (knownByCurrency[cost.currency] || 0) + cost.amount;
  });
  const complete = unknownRefs.length === 0;
  const currencies = Object.keys(knownByCurrency);
  return { knownByCurrency, complete, unknownRefs, amount: complete && currencies.length === 1 ? knownByCurrency[currencies[0]] : null, currency: complete && currencies.length === 1 ? currencies[0] : null };
}

function summarizeMinutes(items) {
  let knownSubtotal = null;
  const unknownRefs = [];
  items.forEach((item, index) => {
    const minutes = item?.minutes;
    if (!minutes || !Number.isFinite(minutes.value) || minutes.value < 0 || !reference(minutes.sourceRef)) unknownRefs.push(item?.sourceRef || item?.id || `item:${index + 1}`);
    else knownSubtotal = (knownSubtotal ?? 0) + minutes.value;
  });
  return { knownSubtotal, complete: unknownRefs.length === 0, unknownRefs };
}

/** Account only supplied observations; no price lookup or missing-value estimate. */
export function summarizeDeliveryCost(report = {}) {
  const limitations = [];
  const collections = {};
  for (const key of ['attempts', 'checks', 'humanWork']) {
    if (!Array.isArray(report?.[key])) {
      limitations.push(`${key}: collection missing; no zero-cost assumption`);
      collections[key] = [{ sourceRef: `${key}:unreported`, cost: null, minutes: null }];
    } else collections[key] = report[key];
  }
  const workRefCounts = new Map();
  for (const item of [...collections.checks, ...collections.humanWork]) {
    if (reference(item?.sourceRef)) {
      const key = item.sourceRef.trim();
      workRefCounts.set(key, (workRefCounts.get(key) || 0) + 1);
    }
  }
  const invalidWorkRefs = { checks: [], humanWork: [] };
  for (const collection of ['checks', 'humanWork']) {
    collections[collection] = collections[collection].map((item, index) => {
      if (!reference(item?.sourceRef) || workRefCounts.get(item.sourceRef.trim()) !== 1) {
        invalidWorkRefs[collection].push(item?.sourceRef || `${collection}:${index + 1}`);
        return { ...item, cost: null, minutes: null };
      }
      return item;
    });
  }
  if (invalidWorkRefs.checks.length || invalidWorkRefs.humanWork.length) limitations.push('Missing or duplicate check/human work identity; affected money and minutes are unknown, including identities repeated across both categories.');
  const attempts = Array.isArray(report?.attempts) ? report.attempts : [];
  const idCounts = new Map();
  const receiptCounts = new Map();
  for (const attempt of attempts) {
    if (reference(attempt?.id)) idCounts.set(attempt.id, (idCounts.get(attempt.id) || 0) + 1);
    const sourceRef = attempt?.invocationReceipt?.sourceRef;
    if (reference(sourceRef)) receiptCounts.set(sourceRef, (receiptCounts.get(sourceRef) || 0) + 1);
  }
  const invalidAttemptIds = [];
  const accountedAttempts = attempts.map((attempt, index) => {
    if (!reference(attempt?.id) || idCounts.get(attempt.id) !== 1 || receiptCounts.get(attempt?.invocationReceipt?.sourceRef) > 1) {
      invalidAttemptIds.push(attempt?.id || `attempt:${index + 1}`);
      return { ...attempt, cost: null, minutes: null };
    }
    return attempt;
  });
  if (invalidAttemptIds.length) limitations.push('Missing or duplicate attempt/call identity; affected amounts are unknown to prevent double counting.');
  if (Array.isArray(report?.attempts)) collections.attempts = accountedAttempts;
  const seenAttemptIds = new Set();
  const missingRetryLineage = [];
  let knownRetryCount = 0;
  attempts.forEach((attempt, index) => {
    if (attempt?.retryOf === null && reference(attempt.id) && idCounts.get(attempt.id) === 1) {
      // Explicit null identifies an independent first call.
    } else if (reference(attempt?.retryOf) && seenAttemptIds.has(attempt.retryOf) && idCounts.get(attempt.id) === 1) knownRetryCount++;
    else missingRetryLineage.push(attempt?.id || `attempt:${index + 1}`);
    if (reference(attempt?.id) && idCounts.get(attempt.id) === 1) seenAttemptIds.add(attempt.id);
  });
  if (missingRetryLineage.length) limitations.push('Retry lineage missing or invalid; subsequent independent calls are not inferred as retries.');
  const observedSettings = [];
  const missingInvocationReceipts = [];
  attempts.forEach((attempt, index) => {
    const receipt = attempt?.invocationReceipt;
    if (!receipt || !reference(receipt.sourceRef) || !reference(receipt.model) || !reference(receipt.effort) || invalidAttemptIds.includes(attempt?.id)) missingInvocationReceipts.push(attempt?.id || `attempt:${index + 1}`);
    else observedSettings.push({ attemptId: attempt?.id ?? null, model: receipt.model, effort: receipt.effort, sourceRef: receipt.sourceRef, provenance: 'supplied-invocation-receipt' });
  });
  if (missingInvocationReceipts.length) limitations.push('Actual model/effort unavailable for one or more attempts; recommendation is not substituted.');
  const costs = {
    model: summarizeAmounts(collections.attempts),
    checks: summarizeAmounts(collections.checks),
    human: summarizeAmounts(collections.humanWork),
    total: summarizeAmounts([...collections.attempts, ...collections.checks, ...collections.humanWork]),
  };
  if (!costs.total.complete) limitations.push('Incomplete costs: known subtotal is not the total qualified delivery cost.');
  if (Object.keys(costs.total.knownByCurrency).length > 1) limitations.push('Multiple currencies are not converted or added together.');
  const qualificationRefs = references(report?.qualification?.evidenceRefs);
  const qualified = report?.qualification?.status === 'qualified' && qualificationRefs.length > 0;
  return {
    attemptCount: Array.isArray(report?.attempts) ? attempts.length : null,
    retryCount: Array.isArray(report?.attempts) && !missingRetryLineage.length ? knownRetryCount : null,
    knownRetryCount, missingRetryLineage, invalidAttemptIds, invalidWorkRefs,
    failedAttemptCount: Array.isArray(report?.attempts) && attempts.every(attempt => ['failed', 'passed'].includes(attempt?.outcome)) ? attempts.filter(attempt => attempt.outcome === 'failed').length : null,
    costs, observedSettings, missingInvocationReceipts,
    time: { modelMinutes: summarizeMinutes(collections.attempts), checkMinutes: summarizeMinutes(collections.checks), humanMinutes: summarizeMinutes(collections.humanWork) },
    qualification: { status: qualified ? 'reported-qualified' : 'unverified', evidenceRefs: qualificationRefs, independentlyVerified: false },
    comparable: qualified && costs.total.complete && costs.total.currency !== null && missingInvocationReceipts.length === 0 && missingRetryLineage.length === 0,
    limitations: [...limitations, 'Qualification, calls and prices are reported from supplied source references; this accounting does not validate business acceptance or change native settings.'],
  };
}
