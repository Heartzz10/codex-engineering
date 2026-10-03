import { checkUISourceFiles, UI_SOURCE_RULE_IDS } from '../src/ui-source-check.mjs';

const files = process.argv.slice(2);
if (!files.length) {
  process.stderr.write('Usage: node scripts/ui-source-check.mjs <HTML file> [HTML file...]\n');
  process.exitCode = 2;
} else {
  const result = await checkUISourceFiles({ files, rules: UI_SOURCE_RULE_IDS });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.status === 'passed' ? 0 : result.status === 'failed' ? 1 : 2;
}
