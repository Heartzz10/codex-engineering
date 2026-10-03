import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_STATE = path.resolve(PACKAGE_ROOT, '../../local-state/engineering');
export const VERSION = '0.5.14';
export function assert(condition, message) { if (!condition) throw new Error(message); }
export function within(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}
export async function existingInside(root, relative) {
  assert(typeof relative === 'string' && relative.length > 0 && !path.isAbsolute(relative), 'Expected relative path');
  const realRoot = await fs.realpath(root);
  const target = path.resolve(realRoot, relative);
  assert(within(realRoot, target), 'Path escapes declared root');
  const real = await fs.realpath(target);
  assert(within(realRoot, real), 'Link escapes declared root');
  return real;
}
export async function mkdirInside(root, relative) {
  await fs.mkdir(root, { recursive: true });
  const realRoot = await fs.realpath(root);
  assert(!path.isAbsolute(relative), 'Expected relative output directory');
  const target = path.resolve(realRoot, relative);
  assert(within(realRoot, target), 'Output escapes state root');
  let current = realRoot;
  for (const part of path.relative(realRoot, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { await fs.mkdir(current); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    assert(within(realRoot, await fs.realpath(current)), 'Output link escapes state root');
  }
  return target;
}
export async function json(file) {
  const stat = await fs.stat(file);
  assert(stat.size <= 2 * 1024 * 1024, 'Configuration exceeds 2 MB');
  return JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
}
export async function writeJson(file, value) {
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  try { await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' }); await fs.rename(temp, file); }
  finally { await fs.unlink(temp).catch(() => {}); }
}
export async function fingerprint(root, inputs, extra) {
  const hash = crypto.createHash('sha256').update(JSON.stringify(extra));
  let count = 0, bytes = 0;
  const seen = new Set();
  async function walk(target) {
    const real = await fs.realpath(target);
    assert(within(root, real), 'Fingerprint input escapes project');
    if (seen.has(real)) return;
    seen.add(real);
    const stat = await fs.stat(real);
    if (stat.isDirectory()) {
      for (const name of (await fs.readdir(real)).sort()) {
        if (!['node_modules', '.git', '.venv', '__pycache__', '.pytest_cache'].includes(name)) await walk(path.join(real, name));
      }
    } else if (stat.isFile()) {
      count++; bytes += stat.size;
      assert(count <= 10000 && bytes <= 100 * 1024 * 1024, 'Fingerprint scope too large; narrow declared inputs');
      const digest = crypto.createHash('sha256').update(await fs.readFile(real)).digest('hex');
      hash.update(JSON.stringify([path.relative(root, real), stat.size, digest]));
    }
  }
  for (const input of [...inputs].sort()) await walk(await existingInside(root, input));
  return { digest: hash.digest('hex'), files: count, bytes };
}
