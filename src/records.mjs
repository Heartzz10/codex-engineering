import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const MAX_SOURCE_BYTES = 128 * 1024;
const SOURCE_DIRS = ['preferences', 'decisions'];
const INDEX_VERSION = 1;

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function rootPath(stateRoot) {
  const absolute = path.resolve(stateRoot);
  await fs.mkdir(absolute, { recursive: true });
  return fs.realpath(absolute);
}

async function safeDirectory(root, name, create = false) {
  const target = path.join(root, name);
  if (create) await fs.mkdir(target, { recursive: true });
  let stat;
  try { stat = await fs.lstat(target); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (stat.isSymbolicLink()) throw new Error(`Symlink directory refused: ${name}`);
  if (!stat.isDirectory()) throw new Error(`Expected directory: ${name}`);
  if (!inside(root, await fs.realpath(target))) throw new Error(`Directory escapes state root: ${name}`);
  return target;
}

function validateRecord(value, relative) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid record: ${relative}`);
  for (const key of ['id', 'text', 'sourceRef', 'updatedAt']) {
    if (typeof value[key] !== 'string' || !value[key].trim()) throw new Error(`Invalid ${key}: ${relative}`);
  }
  if (!['preference', 'decision'].includes(value.kind)) throw new Error(`Invalid kind: ${relative}`);
  if (value.scope !== 'global' && !(typeof value.scope === 'string' && /^project:[^\s:]+$/.test(value.scope))) throw new Error(`Invalid scope: ${relative}`);
  if (!['active', 'superseded'].includes(value.status)) throw new Error(`Invalid status: ${relative}`);
  if (!Number.isFinite(Date.parse(value.updatedAt))) throw new Error(`Invalid updatedAt: ${relative}`);
  if (value.tags !== undefined && (!Array.isArray(value.tags) || value.tags.some(tag => typeof tag !== 'string'))) throw new Error(`Invalid tags: ${relative}`);
  return value;
}

async function scan(root) {
  const entries = [];
  const records = [];
  const ids = new Set();
  for (const directoryName of SOURCE_DIRS) {
    const directory = await safeDirectory(root, directoryName);
    if (!directory) continue;
    const names = (await fs.readdir(directory)).filter(name => name.endsWith('.json')).sort();
    for (const name of names) {
      const fullPath = path.join(directory, name);
      const relative = `${directoryName}/${name}`;
      const stat = await fs.lstat(fullPath);
      if (stat.isSymbolicLink()) throw new Error(`Symlink source refused: ${relative}`);
      if (!stat.isFile()) throw new Error(`Expected source file: ${relative}`);
      if (stat.size > MAX_SOURCE_BYTES) throw new Error(`Source too large: ${relative}`);
      if (!inside(root, await fs.realpath(fullPath))) throw new Error(`Source escapes state root: ${relative}`);
      const bytes = await fs.readFile(fullPath);
      if (bytes.byteLength > MAX_SOURCE_BYTES) throw new Error(`Source too large: ${relative}`);
      let record;
      try { record = JSON.parse(bytes.toString('utf8')); }
      catch { throw new Error(`Invalid JSON: ${relative}`); }
      validateRecord(record, relative);
      if (ids.has(record.id)) throw new Error(`Duplicate record ID: ${record.id}`);
      ids.add(record.id);
      entries.push({ path: relative, hash: createHash('sha256').update(bytes).digest('hex') });
      records.push({ ...record, binding: { path: relative, sha256: entries.at(-1).hash } });
    }
  }
  return { entries, records };
}

async function readIndex(root) {
  const directory = await safeDirectory(root, 'records');
  if (!directory) return null;
  const indexPath = path.join(directory, 'index.json');
  try {
    const stat = await fs.lstat(indexPath);
    if (stat.isSymbolicLink() || !stat.isFile()) return null;
    const index = JSON.parse(await fs.readFile(indexPath, 'utf8'));
    if (index.version !== INDEX_VERSION || !Array.isArray(index.entries)) return null;
    if (index.entries.some(entry => !entry || typeof entry.path !== 'string' || !/^(preferences|decisions)\/[^/\\]+\.json$/.test(entry.path) || !/^[a-f0-9]{64}$/.test(entry.hash))) return null;
    return index;
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
}

async function writeIndex(root, entries) {
  const directory = await safeDirectory(root, 'records', true);
  const destination = path.join(directory, 'index.json');
  try {
    const stat = await fs.lstat(destination);
    if (stat.isSymbolicLink()) throw new Error('Symlink index refused');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = path.join(directory, `.index-${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, JSON.stringify({ version: INDEX_VERSION, entries }, null, 2), { flag: 'wx' });
    await fs.rename(temporary, destination);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

export async function rebuildRecordsIndex(stateRoot) {
  const root = await rootPath(stateRoot);
  const { entries } = await scan(root);
  await writeIndex(root, entries);
  return { count: entries.length };
}

// The context reader keeps complete scoped originals; search's eight-item cap
// remains an output convenience, never a limit on mandatory local decisions.
export async function readScopedRecords(stateRoot, { scope = 'global' } = {}) {
  if (scope !== 'global' && !(typeof scope === 'string' && /^project:[^\s:]+$/.test(scope))) throw new Error('Invalid scope');
  const root = await rootPath(stateRoot);
  const { records } = await scan(root);
  const selected = records.filter(record => record.status === 'active' && (record.scope === 'global' || record.scope === scope));
  return { records: selected, manifest: selected.map(record => ({ id: record.id, ...record.binding })) };
}

function queryTerms(query) {
  const words = query.toLocaleLowerCase().trim().split(/\s+/u).filter(Boolean);
  // Chinese has no word separators. Shared two-character phrases provide
  // deterministic recall; these are matches, not a claim of semantic relevance.
  for (const run of query.toLocaleLowerCase().match(/[\p{Script=Han}]{2,}/gu) ?? []) {
    const chars = [...run];
    for (let i = 0; i + 1 < chars.length; i++) words.push(chars.slice(i, i + 2).join(''));
  }
  return [...new Set(words)];
}

export async function queryRecords(stateRoot, { scope = 'global', query = '', limit = 8, ids } = {}) {
  if (scope !== 'global' && !(typeof scope === 'string' && /^project:[^\s:]+$/.test(scope))) throw new Error('Invalid scope');
  if (typeof query !== 'string') throw new Error('Invalid query');
  if (ids !== undefined && (!Array.isArray(ids) || ids.some(id => typeof id !== 'string' || !id.trim()))) throw new Error('Invalid ids');
  if (!Number.isFinite(limit) || limit < 0) throw new Error('Invalid limit');
  const root = await rootPath(stateRoot);
  const { entries, records } = await scan(root);
  const index = await readIndex(root);
  if (!index || JSON.stringify(index.entries) !== JSON.stringify(entries)) await writeIndex(root, entries);
  const terms = queryTerms(query);
  return records
    .filter(record => record.status === 'active' && (record.scope === 'global' || record.scope === scope))
    .filter(record => ids === undefined || ids.includes(record.id))
    .map(record => {
      const body = record.text.toLocaleLowerCase();
      const tags = (record.tags || []).join(' ').toLocaleLowerCase();
      const score = terms.reduce((sum, term) => sum + (tags.includes(term) ? 3 : 0) + (body.includes(term) ? 1 : 0), 0);
      return { record, score };
    })
    .filter(item => !terms.length || item.score > 0)
    .sort((a, b) => b.score - a.score || Date.parse(b.record.updatedAt) - Date.parse(a.record.updatedAt) || a.record.id.localeCompare(b.record.id))
    .slice(0, Math.min(8, Math.floor(limit)))
    .map(({ record }) => ({ id: record.id, kind: record.kind, scope: record.scope, summary: record.text.slice(0, 500), sourceRef: record.sourceRef, tags: record.tags || [], updatedAt: record.updatedAt }));
}
