import path from 'node:path';
import { parseArgs } from 'node:util';
import { applySkillSnapshot, revertSkillSnapshot } from '../src/skill-snapshot.mjs';

try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    manifest: { type: 'string' }, 'skill-root': { type: 'string' }, backup: { type: 'string' }, record: { type: 'string' }
  } });
  const absolute = (value, label) => { if (!value) throw new Error(`Missing --${label}`); return path.resolve(value); };
  let result;
  if (positionals[0] === 'apply') result = await applySkillSnapshot({ manifestPath: absolute(values.manifest, 'manifest'),
    skillRoot: absolute(values['skill-root'], 'skill-root'), backupDir: absolute(values.backup, 'backup') });
  else if (positionals[0] === 'revert') result = await revertSkillSnapshot(absolute(values.record, 'record'));
  else throw new Error('Use apply --manifest FILE --skill-root DIR --backup DIR, or revert --record FILE');
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(JSON.stringify({ status: 'blocked', error: error.message }));
  process.exitCode = 2;
}
