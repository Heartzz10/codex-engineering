import { parseArgs } from 'node:util';
import { preflightStableUpgrade, applyStableUpgrade, revertStableUpgrade } from '../src/release-upgrade.mjs';

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  current: { type: 'string' }, candidate: { type: 'string' }, runtime: { type: 'string' },
  profile: { type: 'string', multiple: true }, record: { type: 'string' },
} });
try {
  const options = { currentManifestPath: values.current, candidateManifestPath: values.candidate,
    runtimePath: values.runtime, profilePaths: values.profile || [], recordPath: values.record };
  let result;
  switch (positionals[0]) {
    case 'preflight': {
      const plan = await preflightStableUpgrade(options);
      result = { status: plan.status, currentVersion: plan.currentVersion,
        candidateVersion: plan.candidateVersion, installedProfiles: plan.profiles.length,
        mapsPreserved: plan.mapsPreserved, currentRoot: plan.currentRoot, candidateRoot: plan.candidateRoot };
      break;
    }
    case 'apply': result = await applyStableUpgrade(options); break;
    case 'revert': result = await revertStableUpgrade(values.record); break;
    default: throw new Error('Use preflight/apply --current MANIFEST --candidate MANIFEST --runtime FILE --profile FILE [--profile FILE...] [--record FILE for apply], or revert --record FILE');
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ status: 'blocked', error: error.message })}\n`);
  process.exitCode = 2;
}
