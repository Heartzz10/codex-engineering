import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseCostPolicy } from '../src/cost-policy.mjs';
import * as costControls from '../src/cost-policy.mjs';

const models = [
  { id: 'gpt-6-luna', efforts: ['low', 'medium'] },
  { id: 'gpt-6-sol', efforts: ['low', 'medium', 'high'] },
  { id: 'gpt-6-astra', efforts: ['medium', 'high'] },
];

test('a consultation remains with the main agent without starting model selection', () => {
  const result = chooseCostPolicy({ kind: 'consultation', scopeClear: true, risk: 'low', currentModel: 'gpt-6-sol', currentEffort: 'medium' }, models);
  assert.equal(result.executor, 'main');
  assert.equal(result.recommendedModel, 'gpt-6-sol');
  assert.equal(result.recommendedEffort, 'medium');
  assert.equal(result.enforcement, 'advisory');
});

test('a clear small code edit stays with the main agent', () => {
  const result = chooseCostPolicy({ kind: 'implementation', scopeClear: true, risk: 'low', deterministic: false, independent: false, workType: 'code', currentModel: 'gpt-6-sol' }, models);
  assert.equal(result.executor, 'main');
  assert.equal(result.recommendedModel, 'gpt-6-sol');
  assert.ok(result.requiredChecks.includes('targeted-tests'));
});

test('deterministic search uses a program before an agent', () => {
  const result = chooseCostPolicy({ kind: 'discovery', scopeClear: true, risk: 'low', deterministic: true, independent: true, workType: 'search' }, models);
  assert.equal(result.executor, 'program');
  assert.equal(result.recommendedModel, null);
  assert.equal(result.recommendedEffort, null);
  assert.equal(result.enforcement, 'programmatic');
});

test('an independent low-risk browser task can use supported Luna', () => {
  const result = chooseCostPolicy({ kind: 'verification', scopeClear: true, risk: 'low', independent: true, workType: 'browser', errorConsequence: 'low', automaticDetection: true, reversible: true }, models);
  assert.equal(result.executor, 'subagent');
  assert.equal(result.recommendedModel, 'gpt-6-luna');
  assert.equal(result.recommendedEffort, 'medium');
  assert.ok(result.requiredChecks.includes('actual-entry-result'));
});

test('high-risk work remains with the main agent and does not downgrade to Luna', () => {
  const result = chooseCostPolicy({ kind: 'implementation', scopeClear: true, risk: 'high', independent: true, workType: 'code', currentModel: 'gpt-6-luna' }, models);
  assert.equal(result.executor, 'main');
  assert.equal(result.recommendedModel, 'gpt-6-astra');
  assert.equal(result.recommendedEffort, 'high');
  assert.ok(result.requiredChecks.includes('risk-review'));
});

test('an unsupported explicit model is reported without silent fallback', () => {
  const result = chooseCostPolicy({ kind: 'implementation', scopeClear: true, risk: 'low', explicitModel: 'gpt-unknown', workType: 'code' }, models);
  assert.equal(result.recommendedModel, null);
  assert.equal(result.supportStatus, 'unsupported');
  assert.deepEqual(result.unsupportedRequest, { model: 'gpt-unknown' });
});

test('explicit supported model and effort take priority over the automatic suggestion', () => {
  const result = chooseCostPolicy({ kind: 'implementation', scopeClear: true, risk: 'high', explicitModel: 'gpt-6-sol', explicitEffort: 'low', currentModel: 'gpt-6-astra', workType: 'code' }, models);
  assert.equal(result.executor, 'main');
  assert.equal(result.recommendedModel, 'gpt-6-sol');
  assert.equal(result.recommendedEffort, 'low');
  assert.equal(result.supportStatus, 'supported');
});

test('an unsupported explicit effort is reported without silently changing it', () => {
  const result = chooseCostPolicy({ kind: 'implementation', scopeClear: true, risk: 'low', explicitModel: 'gpt-6-luna', explicitEffort: 'high' }, models);
  assert.equal(result.recommendedModel, 'gpt-6-luna');
  assert.equal(result.recommendedEffort, null);
  assert.equal(result.supportStatus, 'unsupported');
  assert.deepEqual(result.unsupportedRequest, { effort: 'high' });
});

test('without a support list the policy cannot claim a model or effective settings', () => {
  const result = chooseCostPolicy({ kind: 'implementation', scopeClear: true, risk: 'low', independent: true, workType: 'code', explicitModel: 'gpt-6-luna' });
  assert.equal(result.executor, 'main');
  assert.equal(result.recommendedModel, null);
  assert.equal(result.supportStatus, 'unavailable');
  assert.equal(result.effectiveModel, null);
  assert.equal(result.effectiveEffort, null);
});

test('recommendations never claim the effective root model or effort changed', () => {
  const result = chooseCostPolicy({ kind: 'debugging', scopeClear: false, risk: 'medium', workType: 'analysis', currentModel: 'gpt-6-sol', currentEffort: 'low' }, models);
  assert.equal(result.executor, 'main');
  assert.equal(result.effectiveModel, null);
  assert.equal(result.effectiveEffort, null);
  assert.ok(result.escalateWhen.includes('new-critical-unknown'));
});

test('a hidden irreversible error escalates even when a caller labels the task low risk', () => {
  const result = chooseCostPolicy({ kind: 'implementation', risk: 'low', scopeClear: true, independent: true,
    workType: 'code', errorConsequence: 'high', automaticDetection: false, reversible: false }, models);
  assert.equal(result.executor, 'main');
  assert.equal(result.recommendedModel, 'gpt-6-astra');
  assert.equal(result.route.action, 'escalate');
});

test('missing risk controls and invalid categories require investigation without guessing safety', () => {
  for (const task of [{ kind: 'implementation' }, { kind: 'magic', risk: 'low' },
    { kind: 'implementation', risk: 'low', errorConsequence: 'low', automaticDetection: 'yes', reversible: true }]) {
    const result = chooseCostPolicy(task, models);
    assert.equal(result.executor, 'main');
    assert.equal(result.route.action, 'investigate');
    assert.ok(result.route.issues.length > 0);
  }
});

test('evidence conflict and failed validation cannot be delegated despite safe task metadata', () => {
  for (const signal of ['conflicting-evidence', 'validation-failed', 'capability-related-failure', 'out-of-category']) {
    const result = chooseCostPolicy({ kind: 'debugging', risk: 'low', scopeClear: true, independent: true,
      errorConsequence: 'low', automaticDetection: true, reversible: true, signals: [signal] }, models);
    assert.equal(result.executor, 'main');
    assert.ok(['investigate', 'escalate'].includes(result.route.action));
    assert.ok(result.route.issues.includes(signal));
  }
});

test('retry control stops an unchanged failure and admits a changed input or new evidence', () => {
  assert.equal(typeof costControls.assessRetry, 'function', 'missing evidence-based retry control');
  const attempts = [{ fingerprint: 'same-input', status: 'check_failed', evidenceRefs: ['receipt:1'] }];
  assert.equal(costControls.assessRetry(attempts, { fingerprint: 'same-input', repeatReason: 'try again' }).action, 'stop-and-investigate');
  assert.equal(costControls.assessRetry(attempts, { fingerprint: 'changed-input' }).action, 'run');
  assert.equal(costControls.assessRetry(attempts, { fingerprint: 'same-input', evidenceRefs: ['receipt:1', 'log:new'] }).action, 'run');
  assert.equal(costControls.assessRetry([{ ...attempts[0], status: 'check_passed' }], { fingerprint: 'same-input' }).action, 'reuse');
});

test('delivery cost includes failed attempts, checks and human work without inventing missing prices', () => {
  assert.equal(typeof costControls.summarizeDeliveryCost, 'function', 'missing qualified delivery cost accounting');
  const result = costControls.summarizeDeliveryCost({
    attempts: [
      { id: 'try-1', retryOf: null, invocationReceipt: { sourceRef: 'call:1', model: 'gpt-6-luna', effort: 'low' }, outcome: 'failed', cost: { amount: 1, currency: 'CNY', sourceRef: 'bill:1' } },
      { id: 'try-2', retryOf: 'try-1', invocationReceipt: { sourceRef: 'call:2', model: 'gpt-6-sol', effort: 'medium' }, outcome: 'passed', cost: { amount: 3, currency: 'CNY', sourceRef: 'bill:2' } },
    ],
    checks: [{ sourceRef: 'check:1', cost: { amount: 0, currency: 'CNY', sourceRef: 'bill:3' }, minutes: { value: 2, sourceRef: 'timer:1' } }],
    humanWork: [{ sourceRef: 'work:1', minutes: { value: 5, sourceRef: 'timer:2' }, cost: null }],
    qualification: { status: 'qualified', evidenceRefs: ['acceptance:1'] },
  });
  assert.equal(result.attemptCount, 2);
  assert.equal(result.retryCount, 1);
  assert.equal(result.costs.model.knownByCurrency.CNY, 4);
  assert.equal(result.costs.total.knownByCurrency.CNY, 4);
  assert.equal(result.costs.total.complete, false);
  assert.equal(result.costs.total.amount, null);
  assert.equal(result.time.humanMinutes.knownSubtotal, 5);
  assert.equal(result.observedSettings[0].model, 'gpt-6-luna');
  assert.equal(result.qualification.status, 'reported-qualified');
});

test('explicit user settings are preserved when error consequences recommend more capability', () => {
  const result = chooseCostPolicy({ kind: 'implementation', errorConsequence: 'high', automaticDetection: false,
    reversible: false, explicitModel: 'gpt-6-sol', explicitEffort: 'low' }, models);
  assert.equal(result.route.action, 'escalate');
  assert.equal(result.recommendedModel, 'gpt-6-sol');
  assert.equal(result.recommendedEffort, 'low');
  assert.equal(result.effectiveModel, null);
});

test('missing prices, missing cost collections, unsupported price observations and mixed currencies are not comparable', () => {
  const empty = costControls.summarizeDeliveryCost({});
  assert.equal(empty.costs.total.complete, false);
  assert.equal(empty.costs.total.amount, null);
  assert.equal(empty.attemptCount, null);
  const mixed = costControls.summarizeDeliveryCost({ attempts: [
    { id: 'a', cost: { amount: 1, currency: 'CNY', sourceRef: 'bill:a' } },
    { id: 'b', cost: { amount: 2, currency: 'USD', sourceRef: 'bill:b' } },
    { id: 'c', cost: { amount: 99, currency: 'CNY' } },
  ], checks: [], humanWork: [], qualification: { status: 'qualified', evidenceRefs: ['acceptance:1'] } });
  assert.deepEqual(mixed.costs.total.knownByCurrency, { CNY: 1, USD: 2 });
  assert.equal(mixed.costs.total.amount, null);
  assert.equal(mixed.comparable, false);
  assert.equal(mixed.observedSettings.length, 0);
});

test('independent calls do not become inferred retries and duplicated attempts cannot count as known costs', () => {
  const unknown = costControls.summarizeDeliveryCost({ attempts: [{ id: 'a' }, { id: 'b' }], checks: [], humanWork: [] });
  assert.equal(unknown.retryCount, null);
  assert.equal(unknown.knownRetryCount, 0);
  const duplicate = costControls.summarizeDeliveryCost({ attempts: [
    { id: 'same', retryOf: null, invocationReceipt: { sourceRef: 'call:1', model: 'gpt-6-sol', effort: 'low' }, cost: { amount: 1, currency: 'CNY', sourceRef: 'bill:1' } },
    { id: 'same', retryOf: 'same', invocationReceipt: { sourceRef: 'call:1', model: 'gpt-6-sol', effort: 'low' }, cost: { amount: 1, currency: 'CNY', sourceRef: 'bill:1' } },
  ], checks: [], humanWork: [], qualification: { status: 'qualified', evidenceRefs: ['acceptance:1'] } });
  assert.equal(duplicate.costs.model.complete, false);
  assert.equal(duplicate.costs.total.amount, null);
  assert.equal(duplicate.comparable, false);
});

test('duplicate or missing check and human identities cannot create known money or time totals', () => {
  const check = { sourceRef: 'check:1', cost: { amount: 2, currency: 'CNY', sourceRef: 'bill:check1' }, minutes: { value: 3, sourceRef: 'timer:check1' } };
  const human = { sourceRef: 'work:1', cost: { amount: 5, currency: 'CNY', sourceRef: 'bill:work1' }, minutes: { value: 4, sourceRef: 'timer:work1' } };
  const duplicate = costControls.summarizeDeliveryCost({ attempts: [], checks: [check, check], humanWork: [human, human], qualification: { status: 'qualified', evidenceRefs: ['acceptance:1'] } });
  assert.equal(duplicate.costs.checks.amount, null);
  assert.equal(duplicate.costs.human.amount, null);
  assert.equal(duplicate.time.checkMinutes.knownSubtotal, null);
  assert.equal(duplicate.time.humanMinutes.knownSubtotal, null);
  assert.equal(duplicate.comparable, false);
  const missing = costControls.summarizeDeliveryCost({ attempts: [], checks: [{ ...check, sourceRef: undefined }], humanWork: [{ ...human, sourceRef: undefined }], qualification: { status: 'qualified', evidenceRefs: ['acceptance:1'] } });
  assert.equal(missing.costs.total.amount, null);
  assert.equal(missing.time.checkMinutes.complete, false);
  assert.equal(missing.time.humanMinutes.complete, false);
  assert.equal(missing.comparable, false);
});
