import { parseArgs } from 'node:util';
import { buildReleaseCandidate } from '../src/release-candidate.mjs';

const { values } = parseArgs({ options: {
  source: { type: 'string' }, archive: { type: 'string' }, release: { type: 'string' },
} });
try {
  process.stdout.write(`${JSON.stringify(await buildReleaseCandidate({ sourceRoot: values.source,
    archivePath: values.archive, releaseFile: values.release }))}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ status: 'blocked', error: error.message })}\n`);
  process.exitCode = 2;
}
