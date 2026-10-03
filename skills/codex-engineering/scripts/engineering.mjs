import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

const dir = path.dirname(fileURLToPath(import.meta.url));
export function buildInstalledCommandArgs(args, binding, skillDir = dir) {
  const forwarded = [...args];
  const relevanceValidation = args[0] === 'context-relevance' && args[1] === 'run'
    && (args.includes('--purpose=validation') || args.some((value, index) => value === '--purpose' && args[index + 1] === 'validation'));
  if ((args[0] === 'judge' && ['run', 'review', 'project'].includes(args[1]) || relevanceValidation) && !args.some(value => value === '--key-config' || value.startsWith('--key-config='))) {
    forwarded.push('--key-config', path.resolve(skillDir, '../../review-product-plan/runtime.local.json'));
  }
  return [path.join(binding.packageRoot, 'src/cli.mjs'), ...forwarded, '--state-root', binding.stateRoot];
}

async function main() {
  try {
    const binding = JSON.parse(await fs.readFile(path.join(dir, '../runtime.json'), 'utf8'));
    const pkg = JSON.parse(await fs.readFile(path.join(binding.packageRoot, 'package.json'), 'utf8'));
    if (pkg.version !== binding.packageVersion) throw new Error('Installed skill and shared runtime versions differ; verify/reinstall the matching release.');
    const child = spawn(process.execPath, buildInstalledCommandArgs(process.argv.slice(2), binding), { stdio: 'inherit', shell: false, windowsHide: true });
    child.on('error', e => { process.stderr.write(`${e.message}\n`); process.exitCode = 2; });
    child.on('exit', code => { process.exitCode = code ?? 2; });
  } catch (e) { process.stderr.write(`${JSON.stringify({status:'blocked',error:e.message})}\n`); process.exitCode=2; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
