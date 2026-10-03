import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { loadProfile } from '../src/profile.mjs';
import { resolveProjectBinding } from '../src/binding.mjs';
import { buildTaskContext, verifyTaskContext, verifyTaskContextExecution, classifyRequestResume } from '../src/task-context.mjs';
import { scopedPath, parseStrictJson, hashContent } from '../src/feature-store.mjs';
import { DEFAULT_STATE, assert, within } from '../src/paths.mjs';
import { validateJudgmentResponse } from '../src/judgment.mjs';

const readJson = async file => parseStrictJson(await fs.readFile(file, 'utf8'));
const help = { status: 'help', commands: ['context prepare --profile FILE --task FILE [--change CHG | --ids AC,...] --out FILE',
  'context resume --profile FILE --from CONTEXT --out FILE [--execution PROJECT_RUN --ledger LEDGER]'],
  task_fields: { description: '任务原文，必填', kind: 'discovery/implementation/debugging/verification', id: '可选任务标识', smallChange: 'true 走已有小改短路径', uiChange: 'true 选择适用UI规则' },
  notes: ['--project DIR 可替换 --profile FILE；--state-root 指定现有本地记录目录。', '--out 必须位于项目已有 evidenceDir，绝不覆盖原件。', '准备和接续检查均零供应商调用；业务验收仍沿现有入口执行。', '接续会重建当前本地材料；新鲜 completed 回执可复用，收费未知请求须先核账本。'] };

/** CLI adapter; raw argv is also accepted by the installed Skill forwarding entry. */
export async function runTaskContextCommand(args, dependencies = {}) {
  const { values: options, positionals } = parseArgs({ args, allowPositionals: true, options: Object.fromEntries([
    'profile', 'project', 'task', 'change', 'ids', 'out', 'from', 'state-root', 'execution', 'ledger'
  ].map(key => [key, { type: 'string' }]).concat([['help', { type: 'boolean' }]])) });
  if (options.help || positionals[0] === 'help') return help;
  const command = positionals[0];
  assert(['prepare', 'resume'].includes(command) && positionals.length === 1, 'context_command_requires_prepare_or_resume');
  assert(Boolean(options.profile) !== Boolean(options.project), 'context_requires_profile_or_project');
  assert(Boolean(options.change) !== Boolean(options.ids) || (!options.change && !options.ids), 'context_change_and_ids_conflict');
  assert(options.out, 'context_out_required');
  const stateRoot = path.resolve(options['state-root'] ?? DEFAULT_STATE);
  let profileFile = options.profile && path.resolve(options.profile);
  if (!profileFile) {
    const binding = await (dependencies.resolveProjectBinding ?? resolveProjectBinding)(stateRoot, path.resolve(options.project));
    assert(binding.status === 'bound', `context_project_binding_unavailable:${binding.reason ?? binding.status}`); profileFile = binding.profile;
  }
  const profile = await (dependencies.loadProfile ?? loadProfile)(profileFile, { allowMissingDocuments: true });
  const output = path.resolve(options.out);
  const outputRoot = await scopedPath(profile.root, profile.featureMapRef?.evidenceDir ?? 'evidence');
  assert(within(outputRoot, output) && output !== outputRoot, 'context_output_must_be_project_evidence');
  const destination = await scopedPath(profile.root, path.relative(profile.root, output), { createParent: true });
  const protectedPaths = [profileFile, options.task, options.from, options.execution, options.ledger].filter(Boolean).map(file => path.resolve(file));
  assert(!protectedPaths.includes(destination), 'context_output_conflicts_with_original');
  let previous = null, freshness = null;
  if (command === 'resume') {
    assert(options.from, 'context_resume_from_required');
    const source = await scopedPath(profile.root, path.relative(profile.root, path.resolve(options.from)));
    previous = await readJson(source);
    freshness = await verifyTaskContext(profile, previous, { stateRoot });
  }
  const task = options.task ? await readJson(path.resolve(options.task)) : previous?.task;
  assert(task, 'context_task_required');
  const selection = options.change ? { changeId: options.change } : options.ids ? { acIds: options.ids.split(',').map(id => id.trim()) }
    : { changeId: previous?.selection?.changeId ?? undefined, acIds: previous?.selection?.acIds ?? undefined };
  const context = await buildTaskContext(profile, { task, ...selection, stateRoot });
  if (command === 'resume') {
    const identityMatches = hashContent({ task: previous.task, selection: previous.selection }) === hashContent({ task: context.task, selection: context.selection });
    if (!identityMatches) freshness = { valid: false, reason_codes: [...freshness.reason_codes, 'task_or_selection_identity_changed'] };
    if (context.context_sha256 !== previous.context_sha256 && freshness.valid) freshness = { valid: false, reason_codes: ['current_context_identity_changed'] };
    let requests = null, executionBinding = null;
    if (options.execution || options.ledger) {
      assert(options.execution && options.ledger, 'context_resume_requires_execution_and_ledger');
      const execution = await readJson(path.resolve(options.execution));
      const ledger = await readJson(path.resolve(options.ledger));
      executionBinding = await verifyTaskContextExecution(profile, context, execution);
      requests = classifyRequestResume({ valid: freshness.valid && executionBinding.valid }, { prepared: execution.prepared, ledger,
        cacheScope: execution.plan_sha256, validateResponse: validateJudgmentResponse });
    }
    // The new packet always carries current local sources. A stale previous packet
    // cannot turn its old result into reused work or mark an acceptance complete.
    context.resume = { previous_ref: path.resolve(options.from), freshness, execution_binding: executionBinding, requests, local_action: 'continue_existing_todo_with_current_originals',
      request_action: requests?.charge_unknown.length ? 'reconcile_existing_ledger_do_not_resend' : 'use_existing_executor_for_not_started_only', provider_calls: 0 };
  }
  // The saved packet identity excludes transient resume guidance, so subsequent
  // verification still binds the same task, sources and existing worklist.
  const saved = context.resume ? { ...context, resume: undefined } : context;
  await fs.writeFile(destination, JSON.stringify(saved, null, 2) + '\n', { flag: 'wx' });
  if (context.resume) {
    const guidance = `${destination}.resume.json`;
    await fs.writeFile(guidance, JSON.stringify(context.resume, null, 2) + '\n', { flag: 'wx' });
    context.resume.guidance_ref = guidance;
  }
  return { status: context.status, project_id: profile.id, path: context.path, summary: context.summary, output_path: destination,
    context_sha256: context.context_sha256, provider_calls: 0, business_verified: false,
    counts: { must_read: context.must_read.length, optional_read: context.optional_read.length, gaps: context.gaps.length, todo: context.todo.length },
    ...(context.resume ? { resume: context.resume } : {}) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runTaskContextCommand(process.argv.slice(2)).then(result => {
    process.stdout.write(JSON.stringify(result) + '\n');
    if (['blocked', 'failed', 'stale'].includes(result.status)) process.exitCode = 2;
  }).catch(error => { console.error(error.message); process.exitCode = 2; });
}
