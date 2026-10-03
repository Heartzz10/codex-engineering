import { parseArgs } from 'node:util';
import { stageStableRelease, verifyStableRelease, switchStableRuntime, revertStableRuntime } from '../src/stable-release.mjs';

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  release: { type: 'string' }, destination: { type: 'string' }, source: { type: 'string' },
  manifest: { type: 'string' }, runtime: { type: 'string' }, record: { type: 'string' },
} });
try {
  let result;
  switch (positionals[0]) {
    case 'stage': result = await stageStableRelease({ releaseFile: values.release, packageRoot: values.destination, sourceRoot: values.source }); break;
    case 'verify': result = await verifyStableRelease(values.manifest); break;
    case 'switch': result = await switchStableRuntime({ manifestPath: values.manifest, runtimePath: values.runtime, recordPath: values.record }); break;
    case 'revert': result = await revertStableRuntime(values.record); break;
    default: throw new Error('Use stage --release FILE --destination DIR --source DIR, verify --manifest FILE, switch --manifest FILE --runtime FILE --record FILE, or revert --record FILE');
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ status: 'blocked', error: error.message })}\n`);
  process.exitCode = 2;
}
