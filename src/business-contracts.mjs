// Data shaping only: the project still owns error copy, authorization, sinks and retention.
import { assert } from './paths.mjs';
const text = value => typeof value === 'string' && !!value.trim();
const outcomes = ['completed', 'not_completed', 'unknown'];
const sensitive = /password|passwd|secret|token|authorization|cookie|credential|api.?key|request.?body|response.?body|prompt|message|stack/i;

export function publicError(error, catalog = {}, eventId) {
  assert(text(eventId), 'Error eventId required');
  const entry = Object.hasOwn(catalog, error?.code) ? catalog[error.code] : null;
  if (entry) {
    assert(text(entry.message) && text(entry.action) && outcomes.includes(entry.outcome), 'Invalid project error catalog entry');
    return { code: error.code, message: entry.message, action: entry.action, outcome: entry.outcome, eventId };
  }
  return { code: 'UNEXPECTED', message: '暂时无法完成操作，请稍后重试。', action: 'retry_after_check', outcome: 'unknown', eventId };
}

export function businessEvent(input, allowedFields = []) {
  assert(Array.isArray(allowedFields) && allowedFields.every(field => text(field) && !sensitive.test(field)), 'Log allowlist contains sensitive field');
  assert(input && text(input.event) && text(input.time) && text(input.level) && text(input.outcome), 'Business event required fields missing');
  assert(/^\d{4}-\d{2}-\d{2}T/.test(input.time) && Number.isFinite(Date.parse(input.time)), 'Invalid log time');
  assert(['debug','info','warn','error'].includes(input.level) && outcomes.includes(input.outcome), 'Invalid log level/outcome');
  const result = Object.create(null);
  for (const field of [...new Set(['event','time','level','outcome','eventId', ...allowedFields])]) {
    if (!Object.hasOwn(input, field)) continue;
    const value = input[field];
    assert(value === null || ['string','boolean'].includes(typeof value) || (typeof value === 'number' && Number.isFinite(value)), 'Log allowlist values must be scalar');
    result[field] = value;
  }
  return result;
}
