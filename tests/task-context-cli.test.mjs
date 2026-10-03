import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { buildInstalledCommandArgs } from '../skills/codex-engineering/scripts/engineering.mjs';

test('the common CLI advertises automatic local context preparation and safe resume', () => {
  const child = spawnSync(process.execPath, ['src/cli.mjs', '--help'], { encoding:'utf8', windowsHide:true });
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  assert.match(result.commands.context, /prepare/);
  assert.match(result.commands.context, /resume/);
});

test('installed context entry remains local while relevance validation uses the existing credential reference', () => {
  const binding = {packageRoot:'C:/package',stateRoot:'C:/state'};
  const args = buildInstalledCommandArgs(['context','prepare','--task','task.json'], binding);
  assert(!args.includes('--key-config'));
  assert(args.includes('--state-root'));
  assert(!buildInstalledCommandArgs(['context-relevance','prepare'], binding).includes('--key-config'));
  assert(!buildInstalledCommandArgs(['context-relevance','run','--purpose','daily'], binding).includes('--key-config'));
  assert(buildInstalledCommandArgs(['context-relevance','run','--purpose','validation'],binding,'C:/skills/codex-engineering/scripts').includes('--key-config'));
});
