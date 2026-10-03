import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { prepareJudgments } from '../src/judgment.mjs';
import { reviewRoutingPolicy } from '../src/judgment-routing.mjs';

async function fixture(selective = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ce-judge-worklist-'));
  const quote = '列表正在加载时显示正在加载。';
  await fs.writeFile(path.join(root, 'source.md'), quote);
  const packet = { material_scope: 'synthetic', context: { purpose: '列表状态' },
    evidence: [{ id: 'E1', source_file: 'source.md', source_label: '需求', original_locator: '第1行', start_line: 1, end_line: 1 }],
    judgments: [{ id: 'COPY1', kind: 'requirement_fidelity', target: quote, evidence_ids: ['E1'] }] };
  if (selective) {
    packet.review_policy = { mode: 'selective', profile_id: 'ordinary_ui_copy_fidelity_v2' };
    packet.review_scope = { category: 'ordinary_status_copy', impact: 'low', decision_ref: 'DEC-test', reviewer_ref: 'review-test',
      checked_exclusions: reviewRoutingPolicy.profiles.ordinary_ui_copy_fidelity_v2.excluded_effects, present_effects: [] };
  }
  const prepared = await prepareJudgments(packet, { baseDir: root });
  const input = path.join(root, 'packet.json'); await fs.writeFile(input, JSON.stringify(packet));
  return { root, input, prepared, out: path.join(root, 'result.json') };
}

test('public judge review prints a usable review queue while full receipts stay in the output file', async () => {
  const f = await fixture();
  const child = spawnSync(process.execPath, ['src/cli.mjs', 'judge', 'review', '--input', f.input, '--out', f.out,
    '--approved-sha', f.prepared.request_sha256, '--budget-usd', '0.05', '--max-requests', '1',
    '--ledger', path.join(f.root, 'ledger.json'), '--enabled', 'false', '--state-root', f.root],
    { encoding: 'utf8', windowsHide: true });
  assert.equal(child.status, 0, child.stderr);
  const printed = JSON.parse(child.stdout); const full = JSON.parse(await fs.readFile(f.out));
  assert.equal(printed.worklist.counts.codex_review, 1);
  assert.equal(printed.worklist.codex_tasks[0].target, '列表正在加载时显示正在加载。');
  assert.equal(printed.prepared_bundle, undefined);
  assert.equal(printed.results, undefined);
  assert.ok(full.prepared_bundle);
  assert.equal(printed.output, f.out);
});

test('public judge review uses the selected local control without credentials or a ledger when paused', async () => {
  const f = await fixture(true);
  await fs.mkdir(path.join(f.root, 'judgments'));
  await fs.writeFile(path.join(f.root, 'judgments/review-routing.json'), JSON.stringify({ schema_version: 1,
    profiles: { ordinary_ui_copy_fidelity_v2: { mode: 'paused' } } }));
  const child = spawnSync(process.execPath, ['src/cli.mjs', 'judge', 'review', '--input', f.input, '--out', f.out,
    '--state-root', f.root], { encoding: 'utf8', windowsHide: true });
  assert.equal(child.status, 0, child.stderr);
  const full = JSON.parse(await fs.readFile(f.out));
  assert.equal(full.attempts, 0);
  assert.ok(full.review_routing.every(row => row.reason_codes.includes('control_paused')));
  assert.equal(JSON.parse(child.stdout).worklist.counts.codex_review, 1);
});
