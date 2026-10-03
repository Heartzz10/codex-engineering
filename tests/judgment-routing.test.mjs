import { fixtureResponse } from './helpers/judgment-response.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { hash } from '../skills/review-product-plan/scripts/jev-client.mjs';
import { prepareJudgments, executeJudgments, validateJudgmentResponse } from '../src/judgment.mjs';
import { runJudgmentCommand } from '../scripts/engineering-judge.mjs';

let routing = {};
try { routing = await import('../src/judgment-routing.mjs'); } catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }
const source = '服务端确认并读回后才显示已保存；结果未知时保留输入并说明未确认。';
const ordinaryScope = () => ({ category: 'ordinary_status_copy', impact: 'low', decision_ref: 'REQ-0001', reviewer_ref: 'codex-task:scope-check',
  checked_exclusions: ['deletion_or_overwrite', 'permission_request', 'payment_or_privacy', 'safety_or_legal', 'new_business_rule', 'cross_material_interpretation'], present_effects: [] });
async function fixture(selective = false) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ui-copy-routing-'));
  const file = path.join(dir, 'source.md'); await writeFile(file, source);
  const packet = { material_scope: 'synthetic', context: { purpose: '状态文案保真' }, evidence: [{ id: 'E1', source_file: 'source.md', source_label: '合成决定', original_locator: '第1行', start_line: 1, end_line: 1, quote: source }], judgments: [{ id: 'COPY-1', kind: 'requirement_fidelity', target: '候选文案“已保存”保留服务端确认及读回条件。', evidence_ids: ['E1'] }] };
  if (selective) packet.review_policy = { mode: 'selective', profile_id: 'ordinary_ui_copy_fidelity_v2' };
  const bundle = await prepareJudgments(packet, { baseDir: dir });
  await writeFile(path.join(dir, 'preview.json'), JSON.stringify(bundle));
  return { dir, file, packet, bundle };
}
function response(request, choice = 'supported') { return fixtureResponse(request, choice, 100); }
function runOf(bundle, choice = 'supported', override = {}) {
  const request = bundle.requests[0]; const raw = response(request, choice);
  return { status: 'completed', evidence_kind: 'provider_response', request_sha256: bundle.request_sha256, standard_sha256: bundle.standard_sha256, model_requested: bundle.model, results: [{ judgment_id: request.judgment_id, answers: [{ provider_choice: 'supported' }], raw_response: raw, origin: 'live' }], local_results: [], ...override };
}

test('default_is_advisory_and_does_not_rewrite_raw_result', async () => {
  const { bundle } = await fixture();
  assert.equal(bundle.review_policy?.mode ?? 'advisory', 'advisory');
  const raw = response(bundle.requests[0]);
  assert.equal(validateJudgmentResponse(raw, bundle.requests[0]).review_required, true);
  assert.equal(typeof routing.resolveReviewRouting, 'function');
  const route = routing.resolveReviewRouting(bundle, runOf(bundle), { preflight: { eligible: true }, validateResponse: validateJudgmentResponse });
  assert.equal(route.review_routing[0].action, 'codex_review');
});

test('selective_preflight_stops_before_credentials_or_network', async () => {
  const { dir, bundle } = await fixture(true);
  assert.equal(typeof routing.preflightReviewRouting, 'function');
  const preflight = await routing.preflightReviewRouting(bundle, { control: { schema_version: 1, profiles: {} } });
  assert.equal(preflight.eligible, false);
  const result = await runJudgmentCommand(['run', '--input', path.join(dir, 'preview.json'), '--out', path.join(dir, 'result.json'), '--ledger', path.join(dir, 'ledger.json'), '--approved-sha', bundle.request_sha256, '--budget-usd', '0.01', '--max-requests', '1', '--state-root', dir]);
  assert.equal(result.status, 'review_fallback'); assert.equal(result.attempts, 0);
});

test('selective review defaults to Codex when ordinary low-impact scope is not evidenced', async () => {
  const { dir, packet, bundle } = await fixture(true);
  assert.deepEqual((await routing.preflightReviewRouting(bundle)).reason_codes, ['review_scope_unverified']);
  for (const badScope of [
    { ...ordinaryScope(), category: 'delete_confirmation_copy' },
    { ...ordinaryScope(), impact: 'high' },
    { ...ordinaryScope(), present_effects: ['permission_request'] },
    { ...ordinaryScope(), checked_exclusions: [] },
    { ...ordinaryScope(), decision_ref: '' }
  ]) {
    const scoped = await prepareJudgments({ ...packet, review_scope: badScope }, { baseDir: dir });
    assert.deepEqual((await routing.preflightReviewRouting(scoped)).reason_codes, ['review_scope_unverified']);
  }
  const valid = await prepareJudgments({ ...packet, review_scope: ordinaryScope() }, { baseDir: dir });
  assert.deepEqual((await routing.preflightReviewRouting(valid)).reason_codes, ['control_disabled']);
  assert.deepEqual(valid.requests[0].body, bundle.requests[0].body);
});

test('routing_metadata_never_enters_provider_body', async () => {
  const a = await fixture(); const b = await fixture(true);
  assert.deepEqual(a.bundle.requests[0].body, b.bundle.requests[0].body);
  assert.equal(a.bundle.request_sha256, b.bundle.request_sha256);
  assert.equal(JSON.stringify(b.bundle.requests[0].body).includes('review_policy'), false);
  assert.equal(JSON.stringify(b.bundle.requests[0].body).includes('stateRoot'), false);
  assert.equal(typeof b.bundle.routing_sha256, 'string');
  const bad = structuredClone(b.packet);
  bad.context.reference_answers = { 'COPY-1': 'supported' };
  await assert.rejects(prepareJudgments(bad, { baseDir: b.dir }), /本地路由|参考答案/);
  const unknown = structuredClone(b.packet); unknown.review_policy.profile_id = 'all_semantic_judgments';
  await assert.rejects(prepareJudgments(unknown, { baseDir: b.dir }), /review_policy/);
});

test('raw supported and malformed receipts cannot bypass unverified qualification', async () => {
  const { bundle } = await fixture(true);
  const preflight = { eligible: true, profile_id: 'ordinary_ui_copy_fidelity_v2', qualification_sha256: 'verified' };
  const resolve = run => routing.resolveReviewRouting(bundle, run, { preflight, validateResponse: validateJudgmentResponse, policy: { profiles: { ordinary_ui_copy_fidelity_v2: { audit_percent: 0 } } } }).review_routing[0];
  assert.equal(resolve(runOf(bundle)).action, 'codex_review');
  assert.deepEqual(resolve(runOf(bundle)).reason_codes, ['preflight_unverified']);
  for (const choice of ['unsupported', 'insufficient', 'no_match']) assert.equal(resolve(runOf(bundle, choice)).action, 'codex_review');
  assert.equal(resolve(runOf(bundle, 'unsupported', { results: [{ ...runOf(bundle, 'unsupported').results[0], answers: [{ provider_choice: 'supported', confidence: 1 }] }] })).action, 'codex_review');
  assert.equal(resolve(runOf(bundle, 'supported', { evidence_kind: 'adapter_fixture' })).action, 'codex_review');
  assert.equal(resolve(runOf(bundle, 'supported', { status: 'persistence_failed' })).action, 'codex_review');
  assert.equal(resolve(runOf(bundle, 'supported', { results: [] })).action, 'codex_review');
  const cached = runOf(bundle); cached.results[0].origin = 'cache'; cached.results[0].source_entry = 'other-request';
  const wrongLedger = { entries: [{ id: 'other-request', status: 'completed', request_key: 'wrong' }] };
  assert.equal(routing.resolveReviewRouting(bundle, cached, { preflight, validateResponse: validateJudgmentResponse, policy: { profiles: { ordinary_ui_copy_fidelity_v2: { audit_percent: 0 } } }, ledger: wrongLedger }).review_routing[0].action, 'codex_review');
});

test('stable_audit_and_required_reviews_are_preserved', async () => {
  const { bundle } = await fixture(true);
  assert.equal(typeof routing.auditSelected, 'function');
  assert.equal(routing.auditSelected(bundle.requests[0].body, 10), routing.auditSelected(bundle.requests[0].body, 10));
  const preflight = { eligible: true, profile_id: 'ordinary_ui_copy_fidelity_v2', qualification_sha256: 'verified' };
  const route = routing.resolveReviewRouting(bundle, runOf(bundle), { preflight, validateResponse: validateJudgmentResponse, policy: { profiles: { ordinary_ui_copy_fidelity_v2: { audit_percent: 100 } } } });
  assert.equal(route.review_routing[0].action, 'codex_review');
  assert.equal(validateJudgmentResponse(response(bundle.requests[0]), bundle.requests[0]).review_required, true);
});

test('a forged eligible preflight cannot produce a reusable result', async () => {
  const { dir, packet } = await fixture(true);
  const bundle = await prepareJudgments({ ...packet, review_scope: ordinaryScope() }, { baseDir: dir });
  const route = routing.resolveReviewRouting(bundle, runOf(bundle), {
    preflight: { eligible: true, profile_id: 'ordinary_ui_copy_fidelity_v2', qualification_sha256: 'forged' },
    validateResponse: validateJudgmentResponse,
    policy: { profiles: { ordinary_ui_copy_fidelity_v2: { audit_percent: 0 } } }
  });
  assert.equal(route.review_routing[0].action, 'codex_review');
  assert.deepEqual(route.review_routing[0].reason_codes, ['preflight_unverified']);
});

test('self-authored quality and work receipts cannot qualify selective bypass', async () => {
  assert.equal(typeof routing.verifyQualificationEvidence, 'function');
  const root = await mkdtemp(path.join(os.tmpdir(), 'ui-copy-qualification-'));
  await writeFile(path.join(root, 'source.md'), source);
  const packet = { material_scope: 'synthetic', context: { purpose: '合成文案' }, evidence: [{ id: 'E1', source_file: 'source.md', source_label: '合成决定', original_locator: '第1行', start_line: 1, end_line: 1, quote: source }], judgments: Array.from({ length: 12 }, (_, i) => ({ id: `COPY-${i + 1}`, kind: 'requirement_fidelity', target: `候选文案${i + 1}保留条件。`, evidence_ids: ['E1'] })) };
  const advisory = await prepareJudgments(packet, { baseDir: root });
  const choices = packet.judgments.map((_, i) => i % 2 ? 'no' : 'yes');
  const dataset = { schema_version: 1, material_scope: 'synthetic', review_profile_id: 'ordinary_ui_copy_fidelity_v2', baseline_kind: 'codex_receipt_blind', request_sha256: advisory.request_sha256, standard_sha256: advisory.standard_sha256, requests: advisory.requests, cases: packet.judgments.map((j, i) => ({ id: j.id, split: 'holdout', kind: j.kind, expected_choice: choices[i], baseline_choice: 'pending', critical: choices[i] === 'no' })) };
  let index = 0;
  const run = await executeJudgments(advisory, { apiKey: 'fixture-only', approvedSha: advisory.request_sha256, budgetUsd: 0.05, maxRequests: 12, fetchImpl: async () => { const request = advisory.requests[index]; const choice = choices[index++]; return { ok: true, json: async () => response(request, choice) }; } });
  run.evidence_kind = 'provider_response';
  const profileId = 'ordinary_ui_copy_fidelity_v2'; const profile = routing.reviewRoutingPolicy.profiles[profileId];
  const ledger = { entries: dataset.requests.map(r => ({ status: 'completed', evidence_kind: 'provider_response', request_key: hash({ model: profile.model, standard_sha256: profile.standard_sha256, body: r.body }) })) };
  const comparison = { original_workflow_measured: true, actual_replaced_judgments: 5, business_checks_preserved: true, ui_review_preserved: true, original_judgment_ms: 1000, material_preparation_ms: 100, api_wait_ms: 100, fallback_ms: 50, audit_ms: 50, review_ms: 50, rework_ms: 0, net_time_saved_ms: 650 };
  const records = { dataset, run, ledger, comparison };
  const qualification = { status: 'qualified', profile_id: profileId, model: profile.model, standard_sha256: profile.standard_sha256, profile_rules_sha256: routing.profileRulesSha(profileId, profile), evidence: {} };
  const write = async () => { for (const [name, value] of Object.entries(records)) { const raw = JSON.stringify(value); await writeFile(path.join(root, `${name}.json`), raw); qualification.evidence[name] = { path: `${name}.json`, sha256: createHash('sha256').update(raw).digest('hex') }; } };
  await write();
  assert.equal(await routing.verifyQualificationEvidence(qualification, profileId, profile, root), false);
  dataset.cases.forEach(c => { c.baseline_choice = c.expected_choice; });
  comparison.net_time_saved_ms = 900;
  await write();
  assert.equal(await routing.verifyQualificationEvidence(qualification, profileId, profile, root), false);
  comparison.net_time_saved_ms = 650;
  await write();
  assert.equal(await routing.verifyQualificationEvidence(qualification, profileId, profile, root), false, 'self-reported totals alone are not qualification');
  records.baseline = { schema_version: 1, kind: 'codex_blind_baseline_receipt', request_sha256: dataset.request_sha256,
    recorded_at: new Date(Date.parse(run.started_at) - 1000).toISOString(), codex_turn_ref: 'codex://threads/test-baseline',
    usage: { input_tokens: 1500, output_tokens: 300 },
    choices: dataset.cases.map(c => ({ judgment_id: c.id, choice: c.baseline_choice })) };
  records.workflow = { schema_version: 1, kind: 'paired_workflow_receipt', request_sha256: dataset.request_sha256,
    trials: dataset.cases.slice(0, 5).map(c => ({ judgment_id: c.id, original_ms: 200, material_preparation_ms: 20,
      api_wait_ms: 20, fallback_ms: 10, audit_ms: 10, review_ms: 10, rework_ms: 0,
      original_trace_ref: 'codex://threads/test-baseline', candidate_trace_ref: `run.json#${c.id}`, route_action: 'reuse_supported' })) };
  await write();
  assert.equal(await routing.verifyQualificationEvidence(qualification, profileId, profile, root), false, 'locally authored trace labels are not native Codex receipts');
  records.workflow.trials[0].original_ms = 1;
  await write();
  assert.equal(await routing.verifyQualificationEvidence(qualification, profileId, profile, root), false, 'totals must derive from trial receipts');
  records.workflow.trials[0].original_ms = 200;
  records.baseline.choices[0].choice = 'no';
  await write();
  assert.equal(await routing.verifyQualificationEvidence(qualification, profileId, profile, root), false, 'baseline receipt must match frozen choices');
  records.baseline.choices[0].choice = dataset.cases[0].baseline_choice;
  await write();
  const uniqueCases = dataset.cases;
  dataset.cases = Array.from({ length: 12 }, () => ({ ...uniqueCases[0] }));
  await write();
  assert.equal(await routing.verifyQualificationEvidence(qualification, profileId, profile, root), false);
  dataset.cases = uniqueCases;
  await write();
  const policy = structuredClone(routing.reviewRoutingPolicy);
  policy.profiles[profileId].qualification = qualification;
  policy.profiles[profileId].approved_source_roots = [root];
  const selectivePacket = { ...packet, review_policy: { mode: 'selective', profile_id: profileId }, review_scope: ordinaryScope() };
  const bundle = await prepareJudgments(selectivePacket, { baseDir: root, routingPolicy: policy });
  const control = { schema_version: 1, profiles: { [profileId]: { mode: 'trial', qualification_sha256: hash(qualification), reason_ref: 'test-only' } } };
  const check = options => routing.preflightReviewRouting(bundle, { policy, stateRoot: root, control, ...options });
  assert.deepEqual((await check()).reason_codes, ['qualification_unverifiable']);
  assert.deepEqual((await check({ control: { ...control, profiles: { [profileId]: { ...control.profiles[profileId], mode: 'paused' } } } })).reason_codes, ['control_paused']);
  assert.deepEqual((await routing.preflightReviewRouting({ ...bundle, model: 'wrong-model' }, { policy, stateRoot: root, control })).reason_codes, ['model_or_standard_changed']);
  const single = await prepareJudgments({ ...selectivePacket, judgments: packet.judgments.slice(0, 1) }, { baseDir: root, routingPolicy: policy });
  const result = await executeJudgments(single, { routingPolicy: policy, stateRoot: root, control, apiKey: 'fixture-only',
    approvedSha: single.request_sha256, budgetUsd: 0.01, maxRequests: 1,
    fetchImpl: async () => { throw Error('provider must not be called'); } });
  assert.equal(result.status, 'review_fallback');
  assert.equal(result.attempts, 0);
  assert.deepEqual(result.review_routing[0].reason_codes, ['qualification_unverifiable']);
});
