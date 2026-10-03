import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

async function controls() {
  const module = await import('../src/understanding.mjs').catch(() => null);
  assert.ok(module?.evaluateUnderstanding, 'missing explicit user-decision understanding check');
  return module;
}

const cases = [
  ['goal-preservation', { optimizationTarget: 'few-components' }, { optimizationTarget: 'fewer-errors-and-rework' }, 'goal-redirected'],
  ['required-regression', { deletedRequiredChecks: ['save-regression'] }, { deletedRequiredChecks: [] }, 'necessary-regression-removed'],
  ['complete-maintenance', { maintenanceCoverage: 'sample', claimsCompleteMaintenance: true }, { maintenanceCoverage: 'all-applicable', claimsCompleteMaintenance: true }, 'incomplete-maintenance-claim'],
  ['authorized-small-change', { alreadyAuthorized: true, smallReversibleChange: true, newDecisionRequired: false, asksForReapproval: true }, { alreadyAuthorized: true, smallReversibleChange: true, newDecisionRequired: false, asksForReapproval: false }, 'redundant-confirmation'],
  ['public-project-boundary', { publicLayerContainsBusinessRules: true }, { publicLayerContainsBusinessRules: false }, 'public-business-mixing'],
  ['delivery-stages', { claims: { implemented: true, verified: true, published: true }, stageEvidence: [{ stage: 'implemented', sourceRef: 'diff:1' }] }, { claims: { implemented: true, verified: false, published: false }, stageEvidence: [{ stage: 'implemented', sourceRef: 'diff:1' }] }, 'unsupported-delivery-stage'],
  ['undecided-product-choice', { choices: [{ id: 'external-sharing', critical: true, state: 'selected', approvalBasis: 'silence' }] }, { choices: [{ id: 'external-sharing', critical: true, state: 'pending' }] }, 'unknown-choice-inferred'],
];

const binding = { key: 'user-intent', id: 'DEC-1', sourceRef: 'user:approved-scope', status: 'active', kind: 'decision' };
const review = { reviewer: 'main-agent', status: 'confirmed', sourceRef: 'review:manual-1', decisionIds: ['DEC-1'] };

test('explicit violations fail and each compliant interpretation can pass after semantic review', async () => {
  const { evaluateUnderstanding } = await controls();
  for (const [caseId, bad, good, code] of cases) {
    const reject = evaluateUnderstanding({ caseId, decisions: [binding], proposal: bad, semanticReview: review });
    assert.equal(reject.status, 'rejected', caseId);
    assert.ok(reject.issues.some(issue => issue.code === code), caseId);
    const accept = evaluateUnderstanding({ caseId, decisions: [binding], proposal: good, semanticReview: review });
    assert.equal(accept.status, 'accepted', caseId);
  }
});

test('missing structured facts or unknown scenarios require review and do not infer a product choice', async () => {
  const { evaluateUnderstanding } = await controls();
  for (const input of [
    { caseId: 'goal-preservation', decisions: [binding], proposal: {} },
    { caseId: 'new-business-choice', decisions: [binding], proposal: { optimizationTarget: 'fewer-errors-and-rework' } },
    { caseId: 'goal-preservation', decisions: [], proposal: { optimizationTarget: 'fewer-errors-and-rework' } },
  ]) assert.equal(evaluateUnderstanding(input).status, 'requires-review');
  const semanticPending = evaluateUnderstanding({ caseId: 'goal-preservation', decisions: [binding], proposal: { optimizationTarget: 'fewer-errors-and-rework' } });
  assert.equal(semanticPending.status, 'semantic-review-required');
  assert.equal(semanticPending.semanticVerified, false);
});
test('local copy reuse cannot satisfy the required overall understanding review', async () => {
  const { evaluateUnderstanding } = await controls();
  const result = evaluateUnderstanding({ caseId: 'goal-preservation', decisions: [binding], proposal: { optimizationTarget: 'fewer-errors-and-rework' }, review_routing: [{ judgment_id: 'COPY-1', action: 'reuse_supported' }] });
  assert.equal(result.status, 'semantic-review-required');
  assert.equal(result.semanticVerified, false);
});

test('an unbound review cannot turn structure checks into proof of natural-language understanding', async () => {
  const { evaluateUnderstanding } = await controls();
  const result = evaluateUnderstanding({ caseId: 'goal-preservation', decisions: [binding], proposal: { optimizationTarget: 'fewer-errors-and-rework' }, semanticReview: { ...review, decisionIds: ['other'] } });
  assert.equal(result.status, 'semantic-review-required');
  assert.equal(result.semanticVerified, false);
});

test('a bound semantic rejection overrides compliant structured declarations', async () => {
  const { evaluateUnderstanding } = await controls();
  const result = evaluateUnderstanding({ caseId: 'goal-preservation', decisions: [binding], proposal: { optimizationTarget: 'fewer-errors-and-rework' }, semanticReview: { ...review, status: 'rejected' } });
  assert.equal(result.status, 'rejected');
  assert.ok(result.issues.some(issue => issue.code === 'semantic-conflict'));
});

test('check reads authoritative active decisions through the existing record index and CLI fails violations', async () => {
  const { checkUnderstanding } = await controls();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'understanding-'));
  try {
    await fs.mkdir(path.join(root, 'decisions'));
    await fs.writeFile(path.join(root, 'decisions', 'approved.json'), JSON.stringify({ id: 'DEC-1', kind: 'decision', scope: 'project:sample', text: '用户要减少错误与返工。', sourceRef: 'user:approved-scope', status: 'active', updatedAt: '2026-09-01T00:00:00Z' }));
    const input = { caseId: 'goal-preservation', scope: 'project:sample', decisionBindings: { 'user-intent': 'DEC-1' }, proposal: { optimizationTarget: 'few-components' }, semanticReview: review };
    const result = await checkUnderstanding({ ...input, stateRoot: root });
    assert.equal(result.status, 'rejected');
    assert.equal(result.decisions[0].sourceRef, 'user:approved-scope');
    await fs.access(path.join(root, 'records', 'index.json'));
    const file = path.join(root, 'input.json');
    await fs.writeFile(file, JSON.stringify(input));
    const cli = spawnSync(process.execPath, ['scripts/understanding-check.mjs', '--input', file, '--state-root', root], { cwd: path.resolve(import.meta.dirname, '..'), encoding: 'utf8' });
    assert.equal(cli.status, 1, cli.stderr);
    assert.equal(JSON.parse(cli.stdout).status, 'rejected');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
