import fs from 'node:fs/promises';
import path from 'node:path';
import { VERSION, within } from './paths.mjs';

const MAX_PROFILES = 100;
const MAX_BYTES = 128 * 1024;
const idPattern = /^[a-z][a-z0-9-]{0,63}$/;

function unavailable(reason) { return { status: 'unavailable', reason }; }

/** Locate a registered profile only; never load its documents or run a check. */
export async function resolveProjectBinding(stateRoot, projectPath) {
  let state, current;
  try {
    state = await fs.realpath(stateRoot);
    current = await fs.realpath(projectPath);
    if (!(await fs.stat(current)).isDirectory()) return unavailable('当前项目路径不是目录。');
  } catch { return unavailable('状态目录或当前项目路径不可用。'); }

  const directory = path.join(state, 'profiles');
  let names;
  try {
    try { await fs.lstat(directory); }
    catch (error) { if (error.code === 'ENOENT') return { status: 'unbound' }; throw error; }
    const realDirectory = await fs.realpath(directory);
    if (!within(state, realDirectory) || !(await fs.stat(realDirectory)).isDirectory()) return unavailable('配置目录越界或不是目录。');
    names = (await fs.readdir(directory)).filter(name => name.endsWith('.json')).sort();
  } catch { return unavailable('配置目录不可用。'); }
  if (names.length > MAX_PROFILES) return unavailable('项目配置超过100个。');

  const profiles = [];
  for (const name of names) {
    const file = path.join(directory, name);
    try {
      const realFile = await fs.realpath(file);
      if (!within(state, realFile)) return unavailable('项目配置路径越界。');
      const stat = await fs.stat(realFile);
      if (!stat.isFile() || stat.size > MAX_BYTES) return unavailable('项目配置文件无效或过大。');
      const bytes = await fs.readFile(realFile);
      if (bytes.length > MAX_BYTES) return unavailable('项目配置文件过大。');
      const data = JSON.parse(bytes.toString('utf8'));
      if (!data || !idPattern.test(data.id) || data.sharedVersion !== VERSION ||
          typeof data.root !== 'string' || !path.isAbsolute(data.root)) return unavailable('项目配置字段无效。');
      const root = await fs.realpath(data.root);
      if (!(await fs.stat(root)).isDirectory()) return unavailable('项目配置根目录无效。');
      profiles.push({ profile: realFile, projectId: data.id, root });
    } catch { return unavailable('项目配置损坏或引用路径不可用。'); }
  }

  const matches = profiles.filter(item => within(item.root, current));
  if (!matches.length) return { status: 'unbound' };
  matches.sort((a, b) => b.root.length - a.root.length);
  if (matches.length > 1 && matches[0].root === matches[1].root) return { status: 'ambiguous', reason: '多个项目配置指向同一根目录。' };
  return { status: 'bound', profile: matches[0].profile, projectId: matches[0].projectId };
}
