import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, access, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { prepareJudgments } from '../src/judgment.mjs';
import { hash, withFileLedger, RESERVED_REQUEST_USD } from '../skills/review-product-plan/scripts/jev-client.mjs';
import { runJudgmentCommand, summarizeJudgmentCommand } from '../scripts/engineering-judge.mjs';
import { buildInstalledCommandArgs } from '../skills/codex-engineering/scripts/engineering.mjs';

const source = '只有服务端确认并读回后才显示已保存。';
const packet = (selective = false) => ({
  material_scope: 'synthetic', context: { purpose: '合成状态文案核查' },
  evidence: [{ id: 'E1', source_file: 'source.md', source_label: '已确认决定', original_locator: '第1行', start_line: 1, end_line: 1, quote: source }],
  judgments: [{ id: 'COPY-1', kind: 'requirement_fidelity', target: '候选文案：已保存。', evidence_ids: ['E1'] }],
  ...(selective ? { review_policy: { mode: 'selective', profile_id: 'ordinary_ui_copy_fidelity_v2' } } : {})
});
const response = request => ({ model: 'jev-1.13.0', answers: Object.fromEntries(Object.entries(request.body.questions).map(([id, q]) => [id, { type: 'choice', choice: 'no', probabilities: Object.fromEntries(Object.keys(q.criteria).map(k => [k, k === 'no' ? 1 : 0])), confidence: 1 }])), usage: { input_tokens: 1000, output_tokens: 0 } });
async function fixture(selective = false) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'judge-entry-'));
  await writeFile(path.join(dir, 'source.md'), source);
  const packetPath = path.join(dir, 'packet.json'); await writeFile(packetPath, JSON.stringify(packet(selective)));
  const bundle = await prepareJudgments(packet(selective), { baseDir: dir });
  const bundlePath = path.join(dir, 'bundle.json'); await writeFile(bundlePath, JSON.stringify(bundle));
  return { dir, packetPath, bundlePath, bundle };
}
const authorized = (f, input, out, ledger) => ['--input', input, '--out', out, '--ledger', ledger, '--approved-sha', f.bundle.request_sha256, '--budget-usd', '0.05', '--max-requests', '2', '--cache', 'off'];
const adapter = calls => ({ resolveApiKey: async () => 'fixture-key', fetchImpl: async (_url, init) => { calls.push(JSON.parse(init.body)); const request = { body: JSON.parse(init.body) }; return { ok: true, json: async () => response(request) }; } });

test('review accepts a natural packet and performs prepare, one call, and complete Codex worklist', async () => {
  const f = await fixture(); const calls = []; const out = path.join(f.dir, 'review.json');
  const result = await runJudgmentCommand(['review', ...authorized(f, f.packetPath, out, path.join(f.dir, 'ledger.json'))], adapter(calls));
  assert.equal(result.status, 'completed'); assert.equal(calls.length, 1);
  assert.equal(result.request_sha256, f.bundle.request_sha256);
  assert.equal(result.worklist.counts.codex_review, 1);
  assert.equal(result.worklist.codex_tasks[0].judgment_id, 'COPY-1');
  assert.match(JSON.stringify(result.worklist.codex_tasks[0]), /服务端确认/);
  assert.ok(result.results[0].raw_response);
  const saved = JSON.parse(await readFile(out, 'utf8')); assert.ok(saved.results[0].raw_response);
  const summary = summarizeJudgmentCommand(result); assert.ok(summary.worklist.codex_tasks.length);
  assert.equal(JSON.stringify(summary).includes('raw_response'), false);
});

test('packet review and prepared bundle review send the same request', async () => {
  const f = await fixture(); const calls = [];
  const withoutQuote = packet(); delete withoutQuote.evidence[0].quote;
  await writeFile(f.packetPath, JSON.stringify(withoutQuote));
  const a = await runJudgmentCommand(['review', ...authorized(f, f.packetPath, path.join(f.dir, 'packet-result.json'), path.join(f.dir, 'ledger-a.json'))], adapter(calls));
  const b = await runJudgmentCommand(['review', ...authorized(f, f.bundlePath, path.join(f.dir, 'bundle-result.json'), path.join(f.dir, 'ledger-b.json'))], adapter(calls));
  assert.equal(a.request_sha256, b.request_sha256); assert.equal(calls.length, 2); assert.deepEqual(calls[0], calls[1]);
});

test('existing run command remains compatible and includes a review worklist', async () => {
  const f = await fixture(); const calls = [];
  const result = await runJudgmentCommand(['run', ...authorized(f, f.bundlePath, path.join(f.dir, 'run-result.json'), path.join(f.dir, 'run-ledger.json'))], adapter(calls));
  assert.equal(result.status, 'completed'); assert.equal(calls.length, 1);
  assert.equal(result.worklist.counts.total, 1); assert.equal(result.worklist.counts.codex_review, 1);
});

test('changed or unreadable source rejects a prepared bundle before key, ledger, or network', async () => {
  const f = await fixture(); await writeFile(path.join(f.dir, 'source.md'), '已修改的原文');
  let keyReads = 0, calls = 0;
  const out = path.join(f.dir, 'result.json'); const ledger = path.join(f.dir, 'ledger.json');
  await assert.rejects(runJudgmentCommand(['review', ...authorized(f, f.bundlePath, out, ledger)], { resolveApiKey: async () => { keyReads++; return 'fixture'; }, fetchImpl: async () => { calls++; } }), /来源|材料|重新prepare/);
  assert.equal(keyReads, 0); assert.equal(calls, 0); await assert.rejects(access(ledger)); await assert.rejects(access(out));
  await unlink(path.join(f.dir, 'source.md'));
  await assert.rejects(runJudgmentCommand(['run', ...authorized(f, f.bundlePath, out, ledger)], { resolveApiKey: async () => { keyReads++; return 'fixture'; }, fetchImpl: async () => { calls++; } }), /不可读/);
  assert.equal(keyReads, 0); assert.equal(calls, 0); await assert.rejects(access(ledger));
});

test('every prepared source remains bound to its evidence even if a hash entry is removed', async () => {
  const f = await fixture();
  const second = '必须保留用户输入。'; await writeFile(path.join(f.dir, 'second.md'), second);
  const p = packet(); p.evidence.push({ id: 'E2', source_file: 'second.md', source_label: '第二份决定', original_locator: '第1行', start_line: 1, end_line: 1, quote: second });
  p.judgments[0].evidence_ids.push('E2');
  const b = await prepareJudgments(p, { baseDir: f.dir });
  assert.deepEqual(Object.keys(b.source_bindings).sort(), ['E1', 'E2']);
  assert.equal(b.request_sha256, hash(b.requests));
  const input = path.join(f.dir, 'two-source-bundle.json'); const out = path.join(f.dir, 'two-source-result.json');
  delete b.source_hashes[path.join(f.dir, 'second.md')]; await writeFile(input, JSON.stringify(b));
  await writeFile(path.join(f.dir, 'second.md'), '更改了第二份决定。');
  let keyReads = 0, calls = 0;
  await assert.rejects(runJudgmentCommand(['review', '--input', input, '--out', out], { resolveApiKey: async () => { keyReads++; return 'fixture'; }, fetchImpl: async () => { calls++; } }), /来源|绑定|重新prepare/);
  assert.equal(keyReads, 0); assert.equal(calls, 0); await assert.rejects(access(out));
});

test('wrong bindings, conflicting repeated evidence, and old unbound bundles fail before credentials', async () => {
  const f = await fixture(); const calls = [];
  const saveAndReject = async (bundle, name) => {
    const input = path.join(f.dir, `${name}.json`); await writeFile(input, JSON.stringify(bundle));
    await assert.rejects(runJudgmentCommand(['run', '--input', input, '--out', path.join(f.dir, `${name}-out.json`)], adapter(calls)), /来源|绑定|重新prepare/);
  };
  const wrong = structuredClone(f.bundle); wrong.source_bindings.E1.start_line = 2; await saveAndReject(wrong, 'wrong-line');
  const old = structuredClone(f.bundle); delete old.source_bindings; await saveAndReject(old, 'old-bundle');
  const repeatedPacket = packet(); repeatedPacket.judgments.push({ id: 'COPY-2', kind: 'requirement_fidelity', target: '另一句文案。', evidence_ids: ['E1'] });
  const repeated = await prepareJudgments(repeatedPacket, { baseDir: f.dir });
  repeated.requests[1].body.state.evidence[0].quote = '伪造的引文'; repeated.request_sha256 = hash(repeated.requests);
  await saveAndReject(repeated, 'conflicting-repeat'); assert.equal(calls.length, 0);
});

test('source changing while the provider responds preserves charged receipt but returns all work to Codex', async () => {
  const f = await fixture(); const out = path.join(f.dir, 'changed-after-call.json'); const ledgerPath = path.join(f.dir, 'changed-after-call-ledger.json');
  let calls = 0;
  const result = await runJudgmentCommand(['review', ...authorized(f, f.packetPath, out, ledgerPath)], {
    resolveApiKey: async () => 'fixture-key',
    fetchImpl: async (_url, init) => {
      calls++; await writeFile(path.join(f.dir, 'source.md'), '调用等待期间原文改变。');
      return { ok: true, json: async () => response({ body: JSON.parse(init.body) }) };
    }
  });
  assert.equal(calls, 1); assert.equal(result.status, 'review_fallback'); assert.equal(result.provider_status, 'completed');
  assert.equal(result.failure_code, 'source_changed'); assert.equal(result.attempts, 1);
  assert.ok(result.results[0].raw_response); assert.equal(result.worklist.counts.codex_review, 1);
  assert.equal(result.worklist.codex_tasks[0].provider_choice, null);
  const ledger = JSON.parse(await readFile(ledgerPath, 'utf8')); assert.equal(ledger.entries[0].status, 'completed');
  const saved = JSON.parse(await readFile(out, 'utf8')); assert.ok(saved.results[0].raw_response);
});

test('selective without qualification returns Codex worklist without key or ledger', async () => {
  const f = await fixture(true); let keyReads = 0, calls = 0; const out = path.join(f.dir, 'fallback.json');
  const result = await runJudgmentCommand(['review', '--input', f.packetPath, '--out', out, '--state-root', f.dir], { resolveApiKey: async () => { keyReads++; return 'fixture'; }, fetchImpl: async () => { calls++; } });
  assert.equal(result.status, 'review_fallback'); assert.equal(result.attempts, 0); assert.equal(result.worklist.counts.codex_review, 1);
  assert.equal(keyReads, 0); assert.equal(calls, 0); await assert.rejects(access(path.join(f.dir, 'ledger.json')));
  assert.ok(result.prepared_bundle);
  const summary = summarizeJudgmentCommand(result);
  assert.equal(summary.review_required, true); assert.equal(summary.fallback, 'original_review');
  assert.ok(Array.isArray(summary.review_routing)); assert.equal(summary.review_routing.every(row => row.action === 'codex_review'), true);
});

test('local precheck only returns complete Codex task without credential, approval, or ledger', async () => {
  const f = await fixture(); const local = packet(); local.evidence = []; local.judgments[0].evidence_ids = [];
  await writeFile(f.packetPath, JSON.stringify(local)); let keyReads = 0, calls = 0;
  const result = await runJudgmentCommand(['review', '--input', f.packetPath, '--out', path.join(f.dir, 'local.json')], {
    resolveApiKey: async () => { keyReads++; return 'fixture'; }, fetchImpl: async () => { calls++; }
  });
  assert.equal(result.status, 'review_fallback'); assert.equal(result.worklist.counts.codex_review, 1);
  assert.equal(result.worklist.codex_tasks[0].target, local.judgments[0].target);
  assert.equal(keyReads, 0); assert.equal(calls, 0); await assert.rejects(access(path.join(f.dir, 'ledger.json')));
});

test('missing credential leaves a blocked receipt and a usable review list without a ledger', async () => {
  const f = await fixture(); const out = path.join(f.dir, 'blocked.json'); const ledger = path.join(f.dir, 'ledger.json'); let calls = 0;
  const result = await runJudgmentCommand(['review', ...authorized(f, f.packetPath, out, ledger)], {
    resolveApiKey: async () => '', fetchImpl: async () => { calls++; }
  });
  assert.equal(result.status, 'blocked'); assert.equal(result.worklist.counts.codex_review, 1);
  assert.equal(calls, 0); await assert.rejects(access(ledger));
  assert.equal(JSON.parse(await readFile(out, 'utf8')).status, 'blocked');
});

test('insufficient cumulative budget saves a blocked worklist and known ledger exposure', async () => {
  const f = await fixture(); const out = path.join(f.dir, 'budget-blocked.json'); const ledger = path.join(f.dir, 'ledger.json');
  await writeFile(ledger, JSON.stringify({ schema_version: 1, entries: [{ id: 'previous-reservation', request_key: 'earlier-request', status: 'uncertain', reserved_cost_usd: RESERVED_REQUEST_USD, estimated_cost_usd: 0 }], cache: {} }));
  const args = authorized(f, f.packetPath, out, ledger); args[args.indexOf('--budget-usd') + 1] = String(RESERVED_REQUEST_USD);
  const calls = []; const result = await runJudgmentCommand(['review', ...args], adapter(calls));
  assert.equal(result.status, 'blocked'); assert.equal(result.attempts, 0); assert.equal(calls.length, 0);
  assert.equal(result.worklist.counts.codex_review, 1); assert.equal(result.cumulative_budget_used_usd, RESERVED_REQUEST_USD);
  assert.equal(result.uncertain_charge, true);
  const saved = JSON.parse(await readFile(out, 'utf8'));
  assert.equal(saved.status, 'blocked'); assert.equal(saved.worklist.codex_tasks[0].judgment_id, 'COPY-1');
  assert.equal(saved.cumulative_budget_used_usd, RESERVED_REQUEST_USD);
  assert.equal(JSON.parse(await readFile(ledger, 'utf8')).entries.length, 1);
});

test('missing authorization and occupied ledger save blocked worklists without claiming known fees', async () => {
  const f = await fixture(); const calls = [];
  const missingOut = path.join(f.dir, 'missing-approval.json');
  const missing = await runJudgmentCommand(['run', '--input', f.bundlePath, '--out', missingOut], adapter(calls));
  assert.equal(missing.status, 'blocked'); assert.equal(missing.worklist.counts.codex_review, 1);
  assert.equal(missing.cumulative_budget_used_usd, null); assert.equal(missing.uncertain_charge, null);
  const ledger = path.join(f.dir, 'locked-ledger.json'); await writeFile(`${ledger}.lock`, 'occupied');
  const lockedOut = path.join(f.dir, 'locked.json');
  const locked = await runJudgmentCommand(['review', ...authorized(f, f.packetPath, lockedOut, ledger)], adapter(calls));
  assert.equal(locked.status, 'blocked'); assert.equal(locked.worklist.counts.codex_review, 1);
  assert.equal(locked.cumulative_budget_used_usd, null); assert.equal(locked.uncertain_charge, null);
  assert.equal(calls.length, 0); assert.equal(JSON.parse(await readFile(lockedOut, 'utf8')).status, 'blocked');
  const badOut = path.join(f.dir, 'bad-parameter.json');
  const bad = await runJudgmentCommand(['review', '--input', f.packetPath, '--out', badOut, '--cache', 'unknown'], adapter(calls));
  assert.equal(bad.status, 'blocked'); assert.equal(bad.worklist.counts.codex_review, 1);
  assert.equal(JSON.parse(await readFile(badOut, 'utf8')).failure_code, 'invalid_parameter');
});

test('an exception after a provider call keeps progress and writes recovery information', async () => {
  const f = await fixture(); const out = path.join(f.dir, 'after-call.json'); const ledger = path.join(f.dir, 'after-call-ledger.json'); const calls = [];
  const result = await runJudgmentCommand(['review', ...authorized(f, f.packetPath, out, ledger)], {
    ...adapter(calls), withFileLedger: async (file, callback) => { await withFileLedger(file, callback); throw new Error('simulated cleanup failure'); }
  });
  assert.equal(calls.length, 1); assert.equal(result.status, 'recovery_required'); assert.equal(result.attempts, 1);
  assert.ok(result.recovery_path); assert.equal(result.worklist.counts.codex_review, 1);
  assert.equal(summarizeJudgmentCommand(result).recovery_path, result.recovery_path);
  const saved = JSON.parse(await readFile(out, 'utf8')); assert.equal(saved.status, 'completed'); assert.ok(saved.results[0].raw_response);
  const recovery = JSON.parse(await readFile(result.recovery_path, 'utf8')); assert.equal(recovery.status, 'recovery_required');
  assert.equal(JSON.parse(await readFile(ledger, 'utf8')).entries[0].status, 'completed');
});

test('an exception after an uncertain charge keeps the failed progress and reservation', async () => {
  const f = await fixture(); const out = path.join(f.dir, 'uncertain-after-call.json'); const ledger = path.join(f.dir, 'uncertain-ledger.json'); let calls = 0;
  const result = await runJudgmentCommand(['run', ...authorized(f, f.bundlePath, out, ledger)], {
    resolveApiKey: async () => 'fixture-key', fetchImpl: async () => { calls++; throw new Error('simulated network break'); },
    withFileLedger: async (file, callback) => { await withFileLedger(file, callback); throw new Error('simulated cleanup failure'); }
  });
  assert.equal(calls, 1); assert.equal(result.status, 'recovery_required'); assert.equal(result.attempts, 1);
  assert.equal(result.uncertain_charge, true); assert.ok(result.recovery_path);
  const saved = JSON.parse(await readFile(out, 'utf8')); assert.equal(saved.status, 'failed'); assert.equal(saved.uncertain_charge, true);
  assert.equal(JSON.parse(await readFile(ledger, 'utf8')).entries[0].status, 'uncertain');
});

test('review and run preserve input/output files and reject collisions', async () => {
  const f = await fixture(); const original = await readFile(f.packetPath, 'utf8');
  await assert.rejects(runJudgmentCommand(['review', '--input', f.packetPath, '--out', f.packetPath]), /覆盖/);
  const out = path.join(f.dir, 'existing.json'); await writeFile(out, 'keep');
  await assert.rejects(runJudgmentCommand(['review', ...authorized(f, f.packetPath, out, path.join(f.dir, 'ledger.json'))], adapter([])), /EEXIST/);
  assert.equal(await readFile(out, 'utf8'), 'keep'); assert.equal(await readFile(f.packetPath, 'utf8'), original);
});

test('installed wrapper injects sibling review credential reference only for judge run/review', () => {
  const binding = { packageRoot: 'C:/installed/package', stateRoot: 'C:/local/state' }; const skillDir = 'C:/installed/skills/codex-engineering/scripts';
  const expected = path.resolve(skillDir, '../../review-product-plan/runtime.local.json');
  assert.equal(buildInstalledCommandArgs(['judge', 'run', '--input', 'x'], binding, skillDir).includes(expected), true);
  assert.equal(buildInstalledCommandArgs(['judge', 'review', '--input', 'x'], binding, skillDir).includes(expected), true);
  assert.equal(buildInstalledCommandArgs(['judge', 'prepare', '--input', 'x'], binding, skillDir).includes(expected), false);
  assert.equal(buildInstalledCommandArgs(['doctor', '--project', 'x'], binding, skillDir).includes(expected), false);
  const explicit = buildInstalledCommandArgs(['judge', 'review', '--key-config', 'C:/chosen.json'], binding, skillDir);
  assert.equal(explicit.filter(x => x === '--key-config').length, 1); assert.equal(explicit.includes(expected), false);
});
