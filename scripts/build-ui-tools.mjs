// Produce an audited local distribution, without node_modules or filesystem configuration loaders.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { build, version as esbuildVersion } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'vendor/ui-tools');
const digest = data => crypto.createHash('sha256').update(data).digest('hex');
const relative = file => path.relative(output, file).replaceAll(path.sep, '/');
const pinned = { 'html-validate': '10.9.0', 'axe-core': '4.13.0', esbuild: '0.25.12' };
if (esbuildVersion !== pinned.esbuild) throw new Error(`Unverified bundler version: ${esbuildVersion}`);
for (const [name, expected] of Object.entries(pinned)) {
  const packageFile = path.join(root, 'node_modules', name, 'package.json');
  const actual = JSON.parse(await fs.readFile(packageFile, 'utf8')).version;
  if (actual !== expected) throw new Error(`Unverified ${name} version: ${actual}`);
}
await fs.mkdir(path.join(output, 'licenses'), { recursive: true });
const bundle = await build({ absWorkingDir: root,
  stdin: { contents: "export { HtmlValidate, Rule, version } from 'html-validate/browser';", resolveDir: root, sourcefile: 'ui-parser-entry.mjs', loader: 'js' },
  bundle: true, platform: 'browser', format: 'esm', target: 'es2022', tsconfigRaw: {}, outfile: path.join(output, 'html-validate.mjs'),
  write: true, metafile: true, legalComments: 'inline', sourcemap: false, logLevel: 'silent' });
if (Object.values(bundle.metafile.outputs).some(file => file.imports.some(item => item.external)))
  throw new Error('UI parser bundle contains external runtime imports');
await fs.copyFile(path.join(root, 'node_modules/axe-core/axe.min.js'), path.join(output, 'axe.min.js'));

// Every package contributing source gets its license and exact version recorded.
const packageRoots = new Set([path.join(root, 'node_modules/html-validate'), path.join(root, 'node_modules/axe-core')]);
for (const input of Object.keys(bundle.metafile.inputs)) {
  if (!input.includes('node_modules')) continue;
  let current = path.dirname(path.resolve(root, input));
  while (current !== path.dirname(current) && current.startsWith(root + path.sep)) {
    try {
      const metadata = JSON.parse(await fs.readFile(path.join(current, 'package.json'), 'utf8'));
      if (metadata.name && metadata.version) { packageRoots.add(current); break; }
    } catch {}
    current = path.dirname(current);
  }
}
const packages = [];
for (const packageRoot of [...packageRoots].sort()) {
  const packageBytes = await fs.readFile(path.join(packageRoot, 'package.json'));
  const metadata = JSON.parse(packageBytes), licenseFiles = [];
  const names = (await fs.readdir(packageRoot)).filter(name => /^(license|licence|copying)(?:[._-]|$)/i.test(name)).sort();
  if (!names.length) throw new Error(`Cannot distribute ${metadata.name}: source license file missing`);
  for (const name of names) {
    const source = path.join(packageRoot, name);
    if (!(await fs.stat(source)).isFile()) continue;
    const destination = path.join(output, 'licenses', `${metadata.name.replaceAll('/', '__').replaceAll('@', '')}--${name}`);
    await fs.copyFile(source, destination); licenseFiles.push(relative(destination));
  }
  if (!licenseFiles.length) throw new Error(`Cannot distribute ${metadata.name}: readable license missing`);
  packages.push({ name: metadata.name, version: metadata.version, license: metadata.license, repository: metadata.repository,
    packageManifestSha256: digest(packageBytes), licenseFiles });
}
const tracked = ['html-validate.mjs', 'axe.min.js', ...packages.flatMap(item => item.licenseFiles)].sort();
const files = [];
for (const file of tracked) { const bytes = await fs.readFile(path.join(output, file)); files.push({ path: file, bytes: bytes.length, sha256: digest(bytes) }); }
const manifest = { schemaVersion: 1, sourceLockSha256: digest(await fs.readFile(path.join(root, 'package-lock.json'))),
  build: { tool: 'esbuild', version: esbuildVersion, format: 'esm', target: 'es2022', platform: 'browser', externalImports: false },
  tools: {
    'html-validate': { version: pinned['html-validate'], source: 'https://html-validate.org/', entry: 'html-validate/browser', output: 'html-validate.mjs', license: 'MIT' },
    'axe-core': { version: pinned['axe-core'], source: 'https://github.com/dequelabs/axe-core', output: 'axe.min.js', license: 'MPL-2.0', sourceSha256: digest(await fs.readFile(path.join(root, 'node_modules/axe-core/axe.min.js'))) }
  }, packages, files,
  limits: 'Bundled parser and browser accessibility engine only. No native adapter or business acceptance. Runtime rules are explicitly selected by project configuration.' };
await fs.writeFile(path.join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ status: 'built', output, packages: packages.length, files: files.length, versions: pinned })}\n`);
