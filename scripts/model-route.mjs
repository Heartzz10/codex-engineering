import fs from 'node:fs/promises';
import { chooseCostPolicy, summarizeDeliveryCost, assessRetry } from '../src/cost-policy.mjs';

const args = process.argv.slice(2);
const option = name => { const index = args.indexOf(name); return index < 0 ? null : args[index + 1]; };
const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
try {
  let result;
  if (option('--cost-report')) result = summarizeDeliveryCost(await read(option('--cost-report')));
  else if (option('--retry')) {
    const input = await read(option('--retry'));
    result = assessRetry(input.attempts, input.nextAttempt);
  } else {
    if (!option('--task')) throw new Error('Usage: --task task.json [--models models.json] | --cost-report report.json | --retry retry.json');
    result = chooseCostPolicy(await read(option('--task')), option('--models') ? await read(option('--models')) : undefined);
  }
  const json = `${JSON.stringify(result, null, 2)}\n`;
  if (option('--output')) await fs.writeFile(option('--output'), json);
  process.stdout.write(json);
  if (result.action === 'stop-and-investigate' || result.supportStatus === 'unsupported') process.exitCode = 1;
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 2;
}
