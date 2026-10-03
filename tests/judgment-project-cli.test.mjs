import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { applyFeatureDraft } from '../src/feature.mjs';
import { VERSION } from '../src/paths.mjs';
import { reviewRoutingPolicy } from '../src/judgment-routing.mjs';
import { buildInstalledCommandArgs } from '../skills/codex-engineering/scripts/engineering.mjs';

test('installed project judgment uses the same credential reference only when execution is requested', () => {
  const binding = { packageRoot: 'C:/package', stateRoot: 'C:/state' };
  const args = buildInstalledCommandArgs(['judge', 'project', '--purpose', 'validation'], binding, 'C:/skills/codex-engineering/scripts');
  assert(args.includes('--key-config'));
  assert(!buildInstalledCommandArgs(['judge', 'plan'], binding).includes('--key-config'));
});

test('native project plan and daily execution read a real feature map and print compact Codex tasks without a provider', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ce-project-cli-'));
  await fs.mkdir(path.join(root, 'docs'));
  await fs.writeFile(path.join(root, 'docs/requirements.md'), '正在读取列表时显示“正在读取列表”。\n');
  await fs.writeFile(path.join(root, 'copy.json'), JSON.stringify({ loading: '正在读取列表' }));
  const profile = { schemaVersion: 2, id: 'judge-project', sharedVersion: VERSION, root,
    authoritativeDocuments: ['docs/requirements.md'], environmentRef: 'synthetic-local', checks: [],
    featureMapRef: { schemaVersion: 1, path: 'docs/map.json', historyDir: 'docs/history', evidenceDir: 'evidence' } };
  const draft = JSON.parse(await fs.readFile('templates/feature-map.example.json', 'utf8'));
  draft.requirements[0].decisionEvidenceRefs = [{ path: 'docs/requirements.md', startLine: 1, endLine: 1 }];
  draft.acceptanceCriteria[0].assertions = [{ id: 'loading-copy', operator: 'manual', semanticReview: {
    kind: 'requirement_fidelity', materialScope: 'synthetic', category: 'ordinary_status_copy',
    targetRef: { path: 'copy.json', pointer: '/loading' }, reviewerRef: 'test:scope',
    checkedExclusions: reviewRoutingPolicy.profiles.ordinary_ui_copy_fidelity_v2.excluded_effects,
    presentEffects: [] } }];
  await applyFeatureDraft(profile, 'init', draft, { expectedRevision: 0, expectedHash: null, requestId: 'init' });
  const file = path.join(root, 'profile.json'); await fs.writeFile(file, JSON.stringify(profile));
  for (const command of ['plan', 'project']) {
    const out = path.join(root, `${command}.json`);
    const child = spawnSync(process.execPath, ['src/cli.mjs', 'judge', command, '--profile', file,
      '--change', 'CHG-0001', '--purpose', 'daily', '--out', out, '--state-root', path.join(root, 'state')],
      { encoding: 'utf8', windowsHide: true });
    assert.equal(child.status, 0, child.stderr || child.stdout);
    const result = JSON.parse(child.stdout), full = JSON.parse(await fs.readFile(out));
    assert.equal(result.attempts, 0); assert.equal(result.purpose, 'daily');
    assert.equal(result.worklist.codex_tasks.length, 1);
    assert(Array.isArray(result.worklist.evidence_pool));
    assert.equal(full.worklist.codex_tasks[0].target, '正在读取列表');
    assert.equal(full.production_enabled, false);
    assert.equal(result.plan, undefined); assert.equal(result.runs, undefined);
  }
});
