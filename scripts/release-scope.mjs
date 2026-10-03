import { parseArgs } from 'node:util';
import { inspectReleaseScope, prepareReleaseScope, verifyReleaseScope } from '../src/release-scope.mjs';

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  source: { type: 'string' }, destination: { type: 'string' }, scope: { type: 'string' },
  version: { type: 'string' },
} });
try {
  let result;
  switch (positionals[0]) {
    case 'plan': result = await inspectReleaseScope({ sourceRoot: values.source, scopeFile: values.scope,
      candidateVersion: values.version }); break;
    case 'prepare': result = await prepareReleaseScope({ sourceRoot: values.source,
      destinationRoot: values.destination, scopeFile: values.scope, candidateVersion: values.version }); break;
    case 'verify': result = await verifyReleaseScope(values.destination); break;
    default: throw new Error('Use plan --source DIR --scope DIR/release-scope.json [--version X.Y.Z], prepare --source DIR --destination NEW_DIR --scope DIR/release-scope.json [--version X.Y.Z], or verify --destination DIR');
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ status: 'blocked', error: error.message })}\n`);
  process.exitCode = 2;
}
