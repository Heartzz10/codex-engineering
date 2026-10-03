import { readFile, mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { prepareContextRelevance, executeContextRelevance } from '../src/context-relevance.mjs';
import { resolveApiKey, withFileLedger, atomicJson, normalize, invariant, text } from '../skills/review-product-plan/scripts/jev-client.mjs';

export async function runContextRelevanceCommand(args, dependencies = {}) {
  const { positionals, values: options } = parseArgs({ args, allowPositionals: true, options: Object.fromEntries(['input', 'out', 'purpose', 'approved-sha', 'ledger', 'budget-usd', 'max-requests', 'key-config', 'state-root', 'cache', 'timeout-ms', 'enabled'].map(key => [key, { type: 'string' }])) });
  const command = positionals[0];
  invariant(['prepare', 'run'].includes(command) && positionals.length === 1, '用法：context-relevance prepare|run --input FILE --out FILE；run默认daily，validation须匹配plan指纹和累计限额');
  invariant(text(options.input) && text(options.out), '缺少input/out');
  const input = path.resolve(options.input), output = path.resolve(options.out);
  const readJson = async file => JSON.parse(normalize(await readFile(file, 'utf8')));
  const data = await readJson(input);
  await mkdir(path.dirname(output), { recursive: true });
  const protectedPaths = [input, options.ledger, options['key-config'], ...Object.keys(data.source_hashes ?? {})].filter(text).map(file => path.resolve(file).toLowerCase());
  invariant(!protectedPaths.includes(output.toLowerCase()), 'out不得覆盖input、ledger、key-config或来源原件；使用新文件名');
  const reservation = await open(output, 'wx');
  try { await reservation.writeFile('{"status":"preparing","production_enabled":false}\n'); await reservation.sync(); } finally { await reservation.close(); }
  if (command === 'prepare') {
    const bundle = await prepareContextRelevance(data, { baseDir: path.dirname(input), ...dependencies });
    await atomicJson(output, bundle);
    return { status: 'prepared', output_path: output, plan_sha256: bundle.plan_sha256, question_count: bundle.question_count, request_count: bundle.request_count, candidate_count: bundle.candidate_count, max_requests: bundle.max_requests, reserved_cost_usd: bundle.reserved_cost_usd, production_enabled: false };
  }
  invariant(options.enabled === undefined || ['on', 'off'].includes(options.enabled), 'enabled仅on/off');
  invariant(options.cache === undefined || ['on', 'off'].includes(options.cache), 'cache仅on/off');
  const result = await executeContextRelevance(data, {
    purpose: options.purpose ?? 'daily', enabled: options.enabled !== 'off', approvedSha: options['approved-sha'], budgetUsd: Number(options['budget-usd']), maxRequests: Number(options['max-requests']), timeoutMs: options['timeout-ms'] === undefined ? 45000 : Number(options['timeout-ms']), useCache: options.cache !== 'off',
    readApiKey: () => (dependencies.resolveApiKey ?? resolveApiKey)({ ...(options['key-config'] ? { configPath: path.resolve(options['key-config']) } : {}) }),
    withLedger: callback => { invariant(text(options.ledger), 'validation须指定专用累计ledger'); return (dependencies.withFileLedger ?? withFileLedger)(path.resolve(options.ledger), callback); },
    save: value => atomicJson(output, value), ...dependencies
  });
  await atomicJson(output, result);
  return { status: result.status, output_path: output, attempts: result.attempts, cache_hits: result.cache_hits, reason: result.reason, ordering_accepted: result.ordering_accepted, production_enabled: false, estimated_cost_usd: result.estimated_cost_usd, uncertain_charge: result.uncertain_charge, question_count: result.question_count, request_count: result.request_count, candidate_count: result.candidate_count, known_candidates: result.ranked.length, unknown_candidates: result.unknown.length };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try { console.log(JSON.stringify(await runContextRelevanceCommand(process.argv.slice(2)))); }
  catch (error) { console.error(error.message); process.exitCode = 2; }
}
