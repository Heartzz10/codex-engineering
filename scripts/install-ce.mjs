import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';

const packageRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const inside = (root, target) => {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
};
async function stat(file) {
  try { return await fs.lstat(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function checkParents(directory) {
  const parsed = path.parse(directory);
  let current = parsed.root;
  for (const part of directory.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const entry = await stat(current);
    if (!entry) break;
    if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error(`安装目录包含链接或非目录：${current}`);
  }
}
async function verifiedPackage() {
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(packageRoot, 'PUBLIC-MANIFEST.json'), 'utf8'));
    if (manifest.schemaVersion !== 1 || !manifest.files || typeof manifest.files !== 'object') throw new Error('清单格式错误');
    const skillFiles = new Map();
    let pkg;
    for (const [relative, expected] of Object.entries(manifest.files)) {
      if (!relative || relative.includes('\\') || relative.includes(':') || relative.includes('\0') ||
        relative.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('清单路径错误');
      const file = path.join(packageRoot, relative);
      const entry = await fs.lstat(file);
      if (!entry.isFile() || entry.isSymbolicLink() || !inside(packageRoot, await fs.realpath(file))) throw new Error(`文件类型错误：${relative}`);
      const bytes = await fs.readFile(file);
      if (bytes.length !== expected.bytes || hash(bytes) !== expected.sha256) throw new Error(`文件不完整或已改变：${relative}`);
      if (relative === 'package.json') pkg = JSON.parse(bytes.toString('utf8'));
      if (relative.startsWith('skills/codex-engineering/')) {
        if (relative.endsWith('/runtime.json') || relative.endsWith('/runtime.local.json')) throw new Error('清单包含私有绑定');
        skillFiles.set(relative.slice('skills/codex-engineering/'.length), bytes);
      }
    }
    if (pkg?.name !== 'codex-engineering' || pkg.version !== manifest.coreVersion ||
      !manifest.files['src/cli.mjs'] || !skillFiles.has('SKILL.md') || !skillFiles.has('scripts/engineering.mjs')) throw new Error('缺少匹配的 CE 运行入口');
    return { pkg, skillFiles };
  } catch (error) { throw new Error(`清单校验失败：${error.message}。请重新获取完整 CE 文件。`); }
}

let staging;
let stagingParent;
try {
  const { values } = parseArgs({ options: { home: { type: 'string' }, help: { type: 'boolean' } } });
  if (values.help) {
    console.log('安装 CE：node scripts/install-ce.mjs\n需要 Node.js 22+。新安装使用 ~/.agents/skills；已有 CE 时保留原安装并停止。\n--home DIR 可指定独立用户目录进行验证。');
  } else {
    if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('请先安装 Node.js 22 或更新版本。');
    const home = path.resolve(values.home || os.homedir());
    const codexHome = values.home ? path.join(home, '.codex') : path.resolve(process.env.CODEX_HOME || path.join(home, '.codex'));
    const skillParent = path.join(home, '.agents/skills');
    const skillDir = path.join(skillParent, 'codex-engineering');
    const stateRoot = path.join(codexHome, 'ce-state');
    const candidates = new Set([skillDir, path.join(home, '.codex/skills/codex-engineering'), path.join(codexHome, 'skills/codex-engineering')]);
    for (const candidate of candidates) {
      if (await stat(candidate)) throw new Error(`已有 CE：${candidate}。已保留原文件；请将 START-HERE.md 交给 Codex 核对后升级。`);
    }
    for (const directory of [skillParent, stateRoot]) {
      if (inside(packageRoot, directory) || inside(directory, packageRoot)) throw new Error('Skill 与私有记录目录不能和 CE 包目录重叠。');
      await checkParents(directory);
    }
    const { pkg, skillFiles } = await verifiedPackage();
    await fs.mkdir(skillParent, { recursive: true });
    stagingParent = path.resolve(skillParent);
    staging = await fs.mkdtemp(path.join(stagingParent, '.ce-install-'));
    for (const [relative, bytes] of skillFiles) {
      const target = path.join(staging, relative);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, bytes, { flag: 'wx', mode: 0o600 });
    }
    await fs.writeFile(path.join(staging, 'runtime.json'), JSON.stringify({ packageRoot, stateRoot, packageVersion: pkg.version }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    const help = spawnSync(process.execPath, [path.join(staging, 'scripts/engineering.mjs'), '--help'], {
      encoding: 'utf8', windowsHide: true, timeout: 30000,
    });
    if (help.status !== 0 || !help.stdout.includes(pkg.version)) throw new Error(`CE 入口核验失败：${help.stderr || help.error?.message || '版本不匹配'}`);
    // An exclusive directory claim and no-overwrite copies preserve a concurrent installation.
    await fs.mkdir(skillDir);
    await fs.cp(staging, skillDir, { recursive: true, force: false, errorOnExist: true });
    await fs.mkdir(stateRoot, { recursive: true });
    console.log(JSON.stringify({ status: 'installed', version: pkg.version, skillDir, packageRoot, stateRoot,
      next: '在 Codex 开启新对话并选择 $codex-engineering；需要时重启客户端。CE 包目录请继续保留。' }, null, 2));
  }
} catch (error) {
  console.error(`CE 安装未完成：${error.message}`);
  process.exitCode = 2;
} finally {
  if (staging && stagingParent && path.dirname(path.resolve(staging)) === stagingParent && path.basename(staging).startsWith('.ce-install-')) {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}
