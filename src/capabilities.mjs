import fs from 'node:fs/promises';
import { existingInside } from './paths.mjs';

const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_BYTES = 128 * 1024;

const unavailable = reason => ({ status: 'unavailable', reason, source: null, scope: 'subagent', models: [] });

/** A local observation for recommendations, never an applied model setting. */
export async function loadModelCapabilities(stateRoot, now = new Date()) {
  let file;
  try {
    file = await existingInside(stateRoot, 'capabilities/models.json');
  } catch (error) {
    if (error.code === 'ENOENT') return unavailable('本地模型能力记录不存在。');
    return unavailable('模型能力记录路径不可用或越界。');
  }
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > MAX_BYTES) return unavailable('模型能力记录不是有效的小文件。');
    const data = JSON.parse(await fs.readFile(file, 'utf8'));
    const observed = Date.parse(data.observedAt);
    const expires = Date.parse(data.expiresAt);
    if (data.schemaVersion !== 1 || typeof data.source !== 'string' || !data.source.trim() || data.scope !== 'subagent' ||
        !Number.isFinite(observed) || !Number.isFinite(expires) || observed > now.getTime() ||
        expires <= observed || expires - observed > MAX_AGE_MS) return unavailable('模型能力记录格式或有效期无效。');
    if (expires <= now.getTime()) return unavailable('模型能力记录已过期。');
    if (!Array.isArray(data.models) || !data.models.length || data.models.some(model =>
      !model || typeof model.id !== 'string' || !model.id.trim() || !Array.isArray(model.efforts) || !model.efforts.length ||
      model.efforts.some(effort => typeof effort !== 'string' || !effort.trim()))) return unavailable('模型能力列表无效。');
    if (new Set(data.models.map(model => model.id)).size !== data.models.length) return unavailable('模型能力列表存在重复 ID。');
    return { status: 'available', reason: '', source: data.source, scope: data.scope,
      observedAt: data.observedAt, expiresAt: data.expiresAt,
      models: data.models.map(model => ({ id: model.id, efforts: [...model.efforts] })) };
  } catch {
    return unavailable('模型能力记录损坏或无法读取。');
  }
}
