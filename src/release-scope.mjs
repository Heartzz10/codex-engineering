import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { assert, within } from './paths.mjs';
import { parseStrictJson } from './feature-store.mjs';
import { isPrivateOrRawReleasePath } from './release-candidate.mjs';

const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const same = (a, b) => path.relative(a, b) === '';
const relativeFile = name => typeof name === 'string' && name.length > 0 &&
  !name.includes('\\') && !path.posix.isAbsolute(name) &&
  name.split('/').every(part => part && part !== '.' && part !== '..');
const semver = value => /^([0-9]+)\.([0-9]+)\.([0-9]+)$/.exec(value)?.slice(1).map(Number);

function candidateReadme(version) {
  return `# Codex 工程公共包 ${version}\n\n` +
    '此目录是可核对的本地版本快照。实际安装版本以用户 Skill 的 runtime.json、package.json 和原生入口结果为准。\n\n' +
    '包含项目配置与绑定、登记检查、功能地图及变更约束、验收/维护协调、视觉测量、理解检查、模型与成本建议、六类Jev判断和四条已采用Pstack排错协议。' +
    '其余19类 Pstack 路由返回本地后续方式，不等于已采用对应上游执行流程。\n\n' +
    'UI 增量包括 Q01～Q18 项目适配契约、成熟 HTML 源码防错、Web 布局/语义/状态测量以及同一验收链的状态覆盖。' +
    '本地打包的 HTML 与 axe 检查工具无需另装依赖；仅声明实际核过的 Web 范围，原生和专用平台仍需对应构建、设备与操作证据。' +
    '源码扫描、工具包单测和页面测量不替代真实账号/权限中的业务读回。\n\n' +
    '快照检查入口：`node src/cli.mjs --help`。安装后由用户 Skill 的 ' +
    '`scripts/engineering.mjs` 经已核运行绑定调用；项目约定见 ' +
    '`skills/codex-engineering/SKILL.md` 与 `standards/`。项目 profile 的 sharedVersion 须与本包版本一致；' +
    '升级先做配置兼容预检，再切安装绑定。\n\n' +
    '包内隔离笔记代码只供源码回归；当前样例配置、地图、历史和运行证据留在开发仓库。' +
    '真实业务修复与验收证据留在业务项目，不能由包内测试替代。0→1完整验收按用户决定保留未完成；具体效果以交付记录为准。Jev仅作建议，外发范围和累计费用仍须具体授权。\n';
}

function bumpBytes(name, bytes, sourceVersion, candidateVersion) {
  if (!candidateVersion) return bytes;
  const json = edit => {
    const value = parseStrictJson(bytes.toString('utf8'));
    edit(value);
    return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  };
  switch (name) {
    case 'package.json': return json(value => {
      assert(value.version === sourceVersion, 'Source package version changed'); value.version = candidateVersion;
    });
    case 'package-lock.json': return json(value => {
      assert(value.lockfileVersion === 3 && value.version === sourceVersion &&
        value.packages?.['']?.version === sourceVersion, 'Source lock root version changed');
      value.version = candidateVersion;
      value.packages[''].version = candidateVersion;
    });
    case 'src/paths.mjs': {
      const source = bytes.toString('utf8');
      const literal = `export const VERSION = '${sourceVersion}';`;
      assert(source.includes(literal) && source.indexOf(literal) === source.lastIndexOf(literal),
        'Source runtime VERSION declaration changed');
      return Buffer.from(source.replace(literal, `export const VERSION = '${candidateVersion}';`));
    }
    case 'catalog/index.json': return json(value => {
      assert(value.version === sourceVersion && Array.isArray(value.resources) &&
        value.resources.every(item => item.version === sourceVersion), 'Source catalog version changed');
      value.version = candidateVersion;
      for (const item of value.resources) item.version = candidateVersion;
    });
    case 'schemas/catalog.schema.json': return json(value => {
      assert(value.properties?.version?.const === sourceVersion &&
        value.properties?.resources?.items?.properties?.version?.const === sourceVersion,
      'Source catalog schema version changed');
      value.properties.version.const = candidateVersion;
      value.properties.resources.items.properties.version.const = candidateVersion;
    });
    case 'schemas/receipt.schema.json': return json(value => {
      assert(value.properties?.packageVersion?.const === sourceVersion, 'Source receipt schema version changed');
      value.properties.packageVersion.const = candidateVersion;
    });
    case 'examples/project-profile.example.json': return json(value => {
      assert(value.sharedVersion === sourceVersion, 'Source profile example version changed');
      value.sharedVersion = candidateVersion;
    });
    case 'README.md': return Buffer.from(candidateReadme(candidateVersion));
    case 'CHANGELOG.md': return Buffer.from(`# ${candidateVersion} 本地候选\n\n` +
      '包含已验证范围内的公共工程入口、功能地图/验收工具、六类Jev判断、模型/成本/理解检查、视觉防错和四条Pstack排错协议。' +
      'UI 增量提供 Q01～Q18 分类与适用性、HTML 源码检查、Web 运行测量和同一验收链的覆盖；已核 Web 范围有界交付，原生/专用平台缺口保留。' +
      '本地升级、回退与实际效果以当轮原件为准；0→1完整验收保留未完成，业务项目发布按项目约定。\n\n' + bytes.toString('utf8'));
    default: return bytes;
  }
}

async function versionTransform(source, selection, targetVersion) {
  if (targetVersion === undefined) return { sourceVersion: null, candidateVersion: null };
  const sourcePackage = parseStrictJson((await regularInside(source, 'package.json')).toString('utf8'));
  const from = semver(sourcePackage.version), to = semver(targetVersion);
  assert(from && to && [...from, ...to].every(Number.isSafeInteger) &&
    to.some((part, index) => part !== from[index]) &&
    (to[0] > from[0] || (to[0] === from[0] &&
      (to[1] > from[1] || (to[1] === from[1] && to[2] > from[2])))),
  'Candidate version must be a newer three-part version');
  const needed = ['package.json', 'src/paths.mjs', 'catalog/index.json', 'schemas/catalog.schema.json',
    'schemas/receipt.schema.json', 'schemas/profile.schema.json', 'examples/project-profile.example.json',
    'README.md', 'CHANGELOG.md'];
  assert(needed.every(name => selection.names.includes(name)), 'Candidate version transform has a missing release file');
  const profileSchema = parseStrictJson((await regularInside(source, 'schemas/profile.schema.json')).toString('utf8'));
  assert(profileSchema.properties?.sharedVersion?.enum?.includes(targetVersion),
    'Profile schema does not support candidate version');
  if (selection.names.includes('package-lock.json')) {
    const lock = parseStrictJson((await regularInside(source, 'package-lock.json')).toString('utf8'));
    assert(lock.lockfileVersion === 3 && lock.version === sourcePackage.version &&
      lock.packages?.['']?.version === sourcePackage.version, 'Source lock root version changed');
  }
  return { sourceVersion: sourcePackage.version, candidateVersion: targetVersion };
}

async function regularInside(root, relative) {
  assert(relativeFile(relative) && !isPrivateOrRawReleasePath(relative), `Unsafe release path: ${relative}`);
  const file = path.join(root, ...relative.split('/'));
  assert(within(root, file), 'Release path escapes source');
  const real = await fs.realpath(file);
  assert(within(root, real) && same(real, file), `Release path is linked: ${relative}`);
  const stat = await fs.lstat(file);
  assert(stat.isFile() && !stat.isSymbolicLink(), `Release entry is not a regular file: ${relative}`);
  return fs.readFile(file);
}

async function collect(source, scope) {
  assert(scope.schemaVersion === 1 && Array.isArray(scope.files) && Array.isArray(scope.directories) &&
    scope.lockedSources === 'upstream/pstack/source-lock.json', 'Unsupported release scope');
  const names = new Set();
  const add = name => {
    assert(relativeFile(name) && !isPrivateOrRawReleasePath(name), `Unsafe release selection: ${name}`);
    names.add(name);
  };
  for (const file of scope.files) add(file);
  for (const rule of scope.directories) {
    assert(relativeFile(rule.path) && typeof rule.recursive === 'boolean' &&
      Array.isArray(rule.suffixes) && rule.suffixes.length > 0 &&
      rule.suffixes.every(suffix => /^\.[a-z0-9.]+$/i.test(suffix)), 'Invalid release directory rule');
    const root = path.join(source, ...rule.path.split('/'));
    assert(same(await fs.realpath(root), root), `Release directory is linked: ${rule.path}`);
    async function walk(directory, prefix) {
      for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        const name = `${prefix}/${entry.name}`;
        if (isPrivateOrRawReleasePath(name)) continue;
        const file = path.join(directory, entry.name);
        const stat = await fs.lstat(file);
        assert(!stat.isSymbolicLink(), `Release directory contains a link: ${name}`);
        if (stat.isDirectory()) {
          if (rule.recursive) await walk(file, name);
          else assert(rule.strict !== true, `Unexpected nested release path: ${name}`);
        } else {
          assert(stat.isFile(), `Unusual release entry: ${name}`);
          if (rule.suffixes.some(suffix => name.endsWith(suffix))) add(name);
          else assert(rule.strict !== true, `Unreviewed release file type: ${name}`);
        }
      }
    }
    await walk(root, rule.path);
  }
  const lock = parseStrictJson((await regularInside(source, scope.lockedSources)).toString('utf8'));
  assert(Array.isArray(lock.files), 'Invalid pinned upstream source lock');
  let pinned = 0;
  for (const item of lock.files) {
    if (item.verificationStatus !== 'verified') continue;
    assert(relativeFile(item.snapshotPath) && item.snapshotPath.startsWith('upstream/pstack/sources/') &&
      /^[a-f0-9]{64}$/.test(item.sha256), 'Invalid pinned upstream source');
    const bytes = await regularInside(source, item.snapshotPath);
    assert(sha256(bytes) === item.sha256, `Pinned upstream source changed: ${item.snapshotPath}`);
    add(item.snapshotPath); pinned++;
  }
  assert(pinned > 0 && names.has('upstream/pstack/sources/pstack/LICENSE'),
    'Pinned upstream sources or license missing');
  const ordered = [...names].sort();
  for (const name of ordered) await regularInside(source, name);
  return { names: ordered, pinned };
}

function sourceHead(source) {
  const safe = source.replaceAll('\\', '/');
  const run = args => execFileSync('git', ['-c', `safe.directory=${safe}`, ...args],
    { cwd: source, windowsHide: true }).toString('utf8').trim();
  return { commit: run(['rev-parse', 'HEAD']), dirty: Boolean(run(['status', '--porcelain', '--untracked-files=all'])) };
}

/** Read-only review of the exact current selection; hashes must be rechecked after P7 freezes. */
export async function inspectReleaseScope({ sourceRoot, scopeFile, candidateVersion }) {
  assert(path.isAbsolute(sourceRoot) && path.isAbsolute(scopeFile), 'Absolute source and scope paths required');
  const source = await fs.realpath(sourceRoot);
  assert(same(source, sourceRoot) &&
    path.relative(source, scopeFile).replaceAll(path.sep, '/') === 'release-scope.json',
  'Use the reviewed root release-scope.json');
  const scopeBytes = await regularInside(source, 'release-scope.json');
  const selection = await collect(source, parseStrictJson(scopeBytes.toString('utf8')));
  const versions = await versionTransform(source, selection, candidateVersion);
  const topLevels = {};
  const content = crypto.createHash('sha256');
  let transformations = 0;
  for (const name of selection.names) {
    const bytes = await regularInside(source, name);
    const output = bumpBytes(name, bytes, versions.sourceVersion, versions.candidateVersion);
    if (!output.equals(bytes)) transformations++;
    topLevels[name.split('/')[0]] = (topLevels[name.split('/')[0]] || 0) + 1;
    content.update(JSON.stringify([name, sha256(output)]));
  }
  const head = sourceHead(source);
  return { status: 'selection_reviewable', files: selection.names.length,
    pinnedUpstreamFiles: selection.pinned, groups: topLevels, transformations,
    sourceVersion: versions.sourceVersion, candidateVersion: versions.candidateVersion,
    scopeSha256: sha256(scopeBytes), selectionSha256: content.digest('hex'),
    sourceGitHead: head.commit, sourceWorkingTreeDirty: head.dirty };
}

/** Copy an explicitly reviewed file scope from a dirty development tree. No Git commit or installation. */
export async function prepareReleaseScope({ sourceRoot, destinationRoot, scopeFile, candidateVersion }) {
  assert(path.isAbsolute(sourceRoot) && path.isAbsolute(destinationRoot) && path.isAbsolute(scopeFile),
    'Absolute source, destination and scope paths required');
  const source = await fs.realpath(sourceRoot), destination = path.resolve(destinationRoot);
  assert(same(source, sourceRoot) && !within(source, destination) && !within(destination, source),
    'Release copy must be separate from development source');
  assert(same(await fs.realpath(path.dirname(destination)), path.dirname(destination)),
    'Candidate parent must be a real directory');
  const relativeScope = path.relative(source, scopeFile).replaceAll(path.sep, '/');
  assert(relativeScope === 'release-scope.json', 'Use the reviewed root release-scope.json');
  const scopeBytes = await regularInside(source, relativeScope);
  const scope = parseStrictJson(scopeBytes.toString('utf8'));
  const selection = await collect(source, scope);
  const versions = await versionTransform(source, selection, candidateVersion);
  const head = sourceHead(source);
  await fs.mkdir(destination); // Existing candidate is never overwritten.
  const incomplete = path.join(destination, '.release-incomplete');
  await fs.writeFile(incomplete, 'Copy incomplete; do not build or install.\n', { flag: 'wx' });
  const files = {};
  const transformations = {};
  for (const name of selection.names) {
    const bytes = await regularInside(source, name);
    const output = bumpBytes(name, bytes, versions.sourceVersion, versions.candidateVersion);
    const target = path.join(destination, ...name.split('/'));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, output, { flag: 'wx' });
    assert(sha256(await fs.readFile(target)) === sha256(output) &&
      sha256(await regularInside(source, name)) === sha256(bytes),
    `Release copy changed during capture: ${name}`);
    files[name] = sha256(output);
    if (!output.equals(bytes)) transformations[name] = { sourceSha256: sha256(bytes),
      candidateSha256: sha256(output), operation: 'candidate_version_or_status' };
  }
  assert(sourceHead(source).commit === head.commit, 'Development Git HEAD changed during release copy');
  const manifest = { schemaVersion: 1, status: 'snapshot_ready_for_review',
    sourceGitHead: head.commit, sourceWorkingTreeDirty: head.dirty, scopeSha256: sha256(scopeBytes),
    sourceVersion: versions.sourceVersion, candidateVersion: versions.candidateVersion,
    pinnedUpstreamFiles: selection.pinned, transformations, files };
  await fs.writeFile(path.join(destination, 'release-scope-manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  await fs.unlink(incomplete);
  return { status: manifest.status, destinationRoot: destination, files: selection.names.length,
    pinnedUpstreamFiles: selection.pinned, transformations: Object.keys(transformations).length,
    candidateVersion: versions.candidateVersion, sourceGitHead: head.commit,
    sourceWorkingTreeDirty: head.dirty, manifestPath: path.join(destination, 'release-scope-manifest.json') };
}

export async function verifyReleaseScope(destinationRoot) {
  const root = await fs.realpath(destinationRoot);
  assert(same(root, destinationRoot), 'Candidate directory is linked');
  const manifest = parseStrictJson((await regularInside(root, 'release-scope-manifest.json')).toString('utf8'));
  assert(manifest.schemaVersion === 1 && manifest.status === 'snapshot_ready_for_review' &&
    manifest.files && typeof manifest.files === 'object', 'Invalid release scope manifest');
  const names = Object.keys(manifest.files).sort();
  assert(names.length > 0 && manifest.files['release-scope.json'] === manifest.scopeSha256,
    'Release scope manifest is incomplete');
  for (const name of names) assert(sha256(await regularInside(root, name)) === manifest.files[name],
    `Candidate file changed: ${name}`);
  const found = [];
  async function walk(directory, prefix = '') {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (!prefix && entry.name === '.git') continue;
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path.join(directory, entry.name), name);
      else found.push(name);
    }
  }
  await walk(root);
  assert(JSON.stringify(found.sort()) === JSON.stringify([...names, 'release-scope-manifest.json'].sort()),
    'Candidate contains unreviewed or missing files');
  return { status: 'verified_for_review', files: names.length,
    pinnedUpstreamFiles: manifest.pinnedUpstreamFiles, candidateVersion: manifest.candidateVersion,
    transformations: Object.keys(manifest.transformations || {}).length,
    sourceGitHead: manifest.sourceGitHead };
}
