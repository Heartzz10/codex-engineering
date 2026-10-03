import fs from 'node:fs/promises';
import { evaluateUnderstanding, checkUnderstanding } from '../src/understanding.mjs';

const args = process.argv.slice(2);
const option = name => { const index = args.indexOf(name); return index < 0 ? null : args[index + 1]; };
try {
  if (!option('--input')) throw new Error('Usage: --input proposal.json [--state-root records-root] [--output result.json]');
  const input = JSON.parse(await fs.readFile(option('--input'), 'utf8'));
  const result = option('--state-root')
    ? await checkUnderstanding({ ...input, stateRoot: option('--state-root') })
    : evaluateUnderstanding(input);
  const json = `${JSON.stringify(result, null, 2)}\n`;
  if (option('--output')) await fs.writeFile(option('--output'), json);
  process.stdout.write(json);
  process.exitCode = result.status === 'accepted' ? 0 : result.status === 'rejected' ? 1 : 2;
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 2;
}
