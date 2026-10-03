import { readFile, writeFile, open, rename, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

export const MODEL = 'jev-1.13.0';
export const PRICE_PER_MILLION = 0.042;
export const PRICING_CHECKED_ON = '2026-09-26';
export const MAX_INPUT_TOKENS = 65536;
export const RESERVED_REQUEST_USD = MAX_INPUT_TOKENS / 1e6 * PRICE_PER_MILLION;
export const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const text = value => typeof value === 'string' && value.trim().length > 0;
export const plain = value => value && typeof value === 'object' && !Array.isArray(value);
export const normalize = value => value.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
export const bytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8');
export const sameKeys = (a, b) => JSON.stringify(Object.keys(a).sort()) === JSON.stringify(Object.keys(b).sort());
export class ReviewValidationError extends Error {}
export const invariant = (ok, message) => { if (!ok) throw new ReviewValidationError(message); };
export const redact = (value, secret) => {
  if (typeof value === 'string') return secret ? value.split(secret).join('[REDACTED]') : value;
  if (Array.isArray(value)) return value.map(item => redact(item, secret));
  if (plain(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [redact(key, secret), redact(item, secret)]));
  return value;
};

export async function resolveApiKey({ env = process.env, configPath = new URL('../runtime.local.json', import.meta.url) } = {}) {
  if (text(env.TYPESAFE_API_KEY)) return env.TYPESAFE_API_KEY.trim();
  let configText;
  try { configText = await readFile(configPath, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return ''; throw new Error('无法读取本机 Jev 凭据引用配置'); }
  let config;
  try { config = JSON.parse(normalize(configText)); } catch { throw new Error('本机 Jev 凭据引用配置不是有效JSON'); }
  invariant(plain(config) && text(config.key_file) && path.isAbsolute(config.key_file), 'Jev key_file 必须为用户指定文件的绝对路径');
  let contents;
  try { contents = normalize(await readFile(config.key_file, 'utf8')); } catch { throw new Error('无法读取用户指定的 Jev 密钥文件'); }
  const lines = contents.split('\n'); const found = [];
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^\s*(?:jev|typesafe)(?:[\s_-]*(?:api[\s_-]*)?key|\s*密钥)?\s*[:：=]\s*(.*?)\s*$/i);
    if (match) {
      const candidate = (match[1] || lines[i + 1] || '').trim().replace(/^["']|["']$/g, '');
      invariant(candidate.length >= 10 && candidate.length <= 512 && !/\s|[:：]/.test(candidate), 'Jev 标记后的密钥格式无法识别');
      found.push(candidate);
    }
  }
  invariant(found.length === 1, found.length ? '发现多个 Jev 密钥标记，停止以避免误用' : '没有找到单独标为 Jev 的密钥；不会使用其他供应商的值');
  return found[0];
}

export function validateChoices(response, request) {
  invariant(plain(response) && response.model === MODEL, '响应 model 与固定版本不一致');
  invariant(plain(response.answers) && sameKeys(response.answers, request.body.questions), '响应缺少、增加或错配问题');
  invariant(plain(response.usage) && ['input_tokens', 'output_tokens'].every(k => Number.isSafeInteger(response.usage[k]) && response.usage[k] >= 0), '无效 usage');
  invariant(response.usage.input_tokens <= MAX_INPUT_TOKENS, '响应输入用量超过预留上限');
  return Object.entries(response.answers).map(([id, value]) => {
    const criteria = request.body.questions[id].criteria;
    invariant(plain(value) && value.type === 'choice' && Object.hasOwn(criteria, value.choice), `未知答案：${id}`);
    invariant(plain(value.probabilities) && sameKeys(value.probabilities, criteria), `概率标签不匹配：${id}`);
    const numbers = Object.values(value.probabilities);
    invariant(numbers.every(p => typeof p === 'number' && Number.isFinite(p) && p >= 0 && p <= 1), `无效概率：${id}`);
    invariant(Math.abs(numbers.reduce((a, b) => a + b, 0) - 1) <= 0.002, `概率之和不为1：${id}`);
    invariant(value.probabilities[value.choice] >= Math.max(...numbers) - 1e-8, `choice 不是最高概率项：${id}`);
    invariant(typeof value.confidence === 'number' && Number.isFinite(value.confidence) && value.confidence >= 0 && value.confidence <= 1, `无效 confidence：${id}`);
    return { criterion_id: id, provider_choice: value.choice, probabilities: value.probabilities, confidence: value.confidence, evidence_ids: request.evidence_ids, review_required: true };
  });
}

export function validateLedger(ledger) {
  invariant(plain(ledger) && ledger.schema_version === 1 && Array.isArray(ledger.entries) && plain(ledger.cache), '累计费用 ledger 无效');
  const ids = new Set();
  for (const entry of ledger.entries) {
    invariant(plain(entry) && text(entry.id) && !ids.has(entry.id) && text(entry.request_key), '累计费用条目无效或重复'); ids.add(entry.id);
    invariant(['reserved', 'completed', 'uncertain'].includes(entry.status), '累计费用条目状态无效');
    invariant(entry.reserved_cost_usd === RESERVED_REQUEST_USD && Number.isFinite(entry.estimated_cost_usd) && entry.estimated_cost_usd >= 0 && entry.estimated_cost_usd <= entry.reserved_cost_usd, '累计费用条目金额无效');
  }
  return ledger;
}
export const ledgerCost = ledger => validateLedger(ledger).entries.reduce((total, entry) => total + (entry.status === 'completed' ? entry.estimated_cost_usd : entry.reserved_cost_usd), 0);
export const requestKey = (request, standardSha, cacheScope) => hash({ model: MODEL, standard_sha256: standardSha, body: request.body,
  ...(cacheScope === undefined ? {} : { cache_scope: cacheScope }) });
const activeLedgers = new WeakSet();

// The deadline covers body parsing as well as fetch. A late promise has no access to results or cache.
async function send(body, { apiKey, fetchImpl, timeoutMs, signal }) {
  const controller = new AbortController(); let timer; let abort;
  const stop = new Promise((_, reject) => {
    abort = () => { controller.abort(); reject(Object.assign(new Error('调用已取消；回原审查'), { code: 'cancelled' })); };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) return abort();
    timer = setTimeout(() => { controller.abort(); reject(Object.assign(new Error('调用超时；迟到响应不采纳，回原审查'), { code: 'timeout' })); }, timeoutMs);
  });
  const operation = (async () => {
    const response = await fetchImpl(ENDPOINT, { method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal });
    if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}`), { code: 'http' });
    return redact(await response.json(), apiKey);
  })();
  try { return await Promise.race([operation, stop]); }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}

export async function executeFixedRequests(bundle, { apiKey, approvedSha, budgetUsd, fetchImpl = fetch, evidenceKind = 'provider_response', save = async () => {}, ledger = { schema_version: 1, entries: [], cache: {} }, saveLedger = async () => {}, signal, timeoutMs = 45000, maxRequests = 1000, enabled = true, useCache = true, cacheScope, validate } = {}) {
  invariant(plain(bundle) && bundle.model === MODEL && Array.isArray(bundle.requests) && text(bundle.standard_sha256), '固定模型、标准或请求无效');
  invariant(bundle.request_sha256 === hash(bundle.requests), '请求 hash / 指纹已改变，请重新 prepare');
  invariant(typeof validate === 'function', '缺少固定标准响应校验');
  const result = { status: 'running', provider: 'TypeSafe Jev', model_requested: MODEL, rubric_version: bundle.standard_version, request_sha256: bundle.request_sha256, started_at: new Date().toISOString(), attempts: 0, cache_hits: 0, local_results: bundle.local_results ?? [], results: [], usage: { input_tokens: 0, output_tokens: 0 }, budget_usd: budgetUsd, reserved_cost_usd: 0, estimated_cost_usd: 0, pricing_checked_on: PRICING_CHECKED_ON, billing_status: 'estimate_from_reported_usage_not_invoice', uncertain_charge: false, review_required: true, fallback: 'original_review' };
  if (!enabled) return { ...result, status: 'disabled', failure_code: 'disabled', finished_at: new Date().toISOString() };
  invariant(text(apiKey), '缺少 TYPESAFE_API_KEY；未发起调用，不要把密钥写进聊天或文件');
  invariant(text(approvedSha) && approvedSha === bundle.request_sha256, '缺少匹配的 approve / 授权指纹；先核对待发送内容与现有授权');
  invariant(cacheScope === undefined || text(cacheScope), '缓存范围无效');
  invariant(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 45000, 'timeoutMs 超出允许范围');
  invariant(Number.isSafeInteger(maxRequests) && maxRequests > 0, '请求累计上限无效');
  validateLedger(ledger); invariant(!activeLedgers.has(ledger), '累计费用 ledger 正在使用；禁止并发共用预算');
  const cached = request => {
    if (!useCache) return undefined;
    const key = requestKey(request, bundle.standard_sha256, cacheScope);
    const entry = ledger.cache[key];
    if (!entry || entry.model !== MODEL || entry.standard_sha256 !== bundle.standard_sha256 || entry.request_sha256 !== hash(request.body) || !ledger.entries.some(e => e.id === entry.source_entry && e.status === 'completed' && e.request_key === key)) return undefined;
    try { validate(entry.raw_response, request); return entry; } catch { return undefined; }
  };
  const count = bundle.requests.filter(request => !cached(request)).length;
  const reserved = count * RESERVED_REQUEST_USD;
  invariant(typeof budgetUsd === 'number' && Number.isFinite(budgetUsd) && budgetUsd >= ledgerCost(ledger) + reserved, `累计 budget / 预算不足：已计入 $${ledgerCost(ledger).toFixed(6)}，本次需预留 $${reserved.toFixed(6)}`);
  invariant(ledger.entries.length + count <= maxRequests, '累计请求数量超过授权上限');
  result.reserved_cost_usd = reserved; activeLedgers.add(ledger);
  const persist = async () => {
    try { await saveLedger(ledger); await save(result); return true; }
    catch { result.status = 'persistence_failed'; result.uncertain_charge = result.attempts > 0; result.failure_code = 'persistence'; result.error = '保存进度失败，已停止新调用；保留上一次有效记录和可能在途的费用，需恢复结果'; result.finished_at = new Date().toISOString(); return false; }
  };
  try {
    if (!await persist()) return result;
    for (const request of bundle.requests) {
      if (signal?.aborted) { result.status = 'cancelled'; result.failure_code = 'cancelled'; break; }
      const hit = cached(request);
      if (hit) { result.cache_hits++; result.results.push({ ...validate(structuredClone(hit.raw_response), request), elapsed_ms: 0, raw_response: structuredClone(hit.raw_response), origin: 'cache', source_entry: hit.source_entry, source_evidence_kind: hit.evidence_kind ?? 'unknown', charged_usage: { input_tokens: 0, output_tokens: 0 } }); if (!await persist()) return result; continue; }
      const key = requestKey(request, bundle.standard_sha256, cacheScope);
      const entry = { id: randomUUID(), request_key: key, status: 'reserved', evidence_kind: evidenceKind, reserved_cost_usd: RESERVED_REQUEST_USD, estimated_cost_usd: 0, started_at: new Date().toISOString() };
      ledger.entries.push(entry); result.attempts++; result.in_flight_dimension = request.dimension_id ?? request.judgment_id; result.uncertain_charge = true;
      const started = performance.now(); if (!await persist()) return result;
      let raw;
      try {
        raw = await send(request.body, { apiKey, fetchImpl, timeoutMs, signal });
        const validated = validate(raw, request);
        result.results.push({ ...validated, elapsed_ms: Math.round(performance.now() - started), raw_response: raw, origin: 'live' });
        result.usage.input_tokens += validated.usage.input_tokens; result.usage.output_tokens += validated.usage.output_tokens;
        result.estimated_cost_usd = result.usage.input_tokens / 1e6 * PRICE_PER_MILLION; result.uncertain_charge = false;
        entry.status = 'completed'; entry.estimated_cost_usd = validated.usage.input_tokens / 1e6 * PRICE_PER_MILLION; entry.finished_at = new Date().toISOString();
        if (useCache) ledger.cache[key] = { model: MODEL, standard_sha256: bundle.standard_sha256, request_sha256: hash(request.body), source_entry: entry.id, evidence_kind: evidenceKind, raw_response: structuredClone(raw) };
      } catch (error) {
        entry.status = 'uncertain'; entry.finished_at = new Date().toISOString(); result.status = error.code === 'cancelled' ? 'cancelled' : 'failed'; result.uncertain_charge = true; result.failure_code = error.code ?? (error instanceof ReviewValidationError ? 'validation' : 'transport');
        result.error = error instanceof ReviewValidationError || ['http', 'cancelled', 'timeout'].includes(error.code) ? redact(error.message, apiKey) : '请求或网络失败；已停止，未自动重试';
        if (raw !== undefined) result.failed_response = { dimension_id: result.in_flight_dimension, raw_response: raw, elapsed_ms: Math.round(performance.now() - started) };
        result.failed_dimension = result.in_flight_dimension; break;
      }
      delete result.in_flight_dimension; if (!await persist()) return result;
    }
    if (result.status === 'running') result.status = 'completed';
    result.cumulative_budget_used_usd = ledgerCost(ledger); result.cumulative_attempts = ledger.entries.length;
    result.finished_at = new Date().toISOString(); await persist(); return result;
  } finally { activeLedgers.delete(ledger); }
}

export async function atomicJson(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`; const handle = await open(temporary, 'wx');
  try { await handle.writeFile(JSON.stringify(value, null, 2) + '\n'); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, file);
}

// One lock spans ledger read, reservation, calls, and persistence. No stale lock is silently removed.
export async function withFileLedger(file, callback) {
  const target = path.resolve(file); let lock;
  try { lock = await open(`${target}.lock`, 'wx'); } catch (error) { if (error.code === 'EEXIST') throw new Error('累计费用 ledger 被占用；核对在途请求后恢复，不自动删除锁'); throw error; }
  try {
    let ledger;
    try { ledger = JSON.parse(normalize(await readFile(target, 'utf8'))); } catch (error) { if (error.code !== 'ENOENT') throw error; ledger = { schema_version: 1, entries: [], cache: {} }; }
    validateLedger(ledger); return await callback(ledger, value => atomicJson(target, value));
  } finally { await lock.close(); await unlink(`${target}.lock`); }
}
