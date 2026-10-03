import { createReadStream } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';

const fields = {
  inputTokens: 'input_tokens',
  cachedInputTokens: 'cached_input_tokens',
  outputTokens: 'output_tokens',
  reasoningOutputTokens: 'reasoning_output_tokens',
  totalTokens: 'total_tokens',
};

const emptyTotals = () => Object.fromEntries(Object.keys(fields).map((key) => [key, null]));
const validCount = (value) => Number.isSafeInteger(value) && value >= 0;

function parentFromMetadata(payload) {
  let source = payload.source;
  if (typeof source === 'string') {
    try { source = JSON.parse(source); }
    catch { source = null; }
  }
  const possible = [
    payload.parent_thread_id,
    source?.parent_thread_id,
    source?.subagent?.parent_thread_id,
    source?.subagent?.thread_spawn?.parent_thread_id,
  ];
  return [...new Set(possible.filter((value) => typeof value === 'string' && value.length > 0))];
}

function snapshotFromRow(row, sequence) {
  let raw;
  if (row?.type === 'token_usage_record') raw = row.payload?.thread_token_usage;
  else if (row?.type === 'event_msg' && row.payload?.type === 'token_count') raw = row.payload.info?.total_token_usage;
  else return null;
  if (!raw || typeof raw !== 'object') return null;
  const usage = emptyTotals();
  for (const [key, sourceKey] of Object.entries(fields)) {
    if (validCount(raw[sourceKey])) usage[key] = raw[sourceKey];
  }
  const completeness = Object.values(usage).filter((value) => value !== null).length;
  if (!completeness) return null;
  const parsedTime = typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : NaN;
  return { usage, completeness, time: Number.isFinite(parsedTime) ? parsedTime : null, sequence };
}

function isBetter(candidate, current) {
  if (!current) return true;
  if (candidate.completeness !== current.completeness) {
    return candidate.completeness > current.completeness;
  }
  if (candidate.time !== null && current.time !== null && candidate.time !== current.time) {
    return candidate.time > current.time;
  }
  return candidate.sequence > current.sequence;
}

async function readFragment(path, nextSequence) {
  const ids = new Set();
  const parents = new Set();
  let snapshot = null;
  const nativeSnapshots = new Map();
  let malformedLines = 0;
  const lines = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of lines) {
    let row;
    try { row = JSON.parse(line); }
    catch { malformedLines++; continue; }
    if (row?.type === 'session_meta' && row.payload && typeof row.payload === 'object') {
      const id = row.payload.id ?? row.payload.session_id;
      if (typeof id === 'string' && id.length) ids.add(id);
      for (const parent of parentFromMetadata(row.payload)) parents.add(parent);
    }
    const candidate = snapshotFromRow(row, nextSequence());
    if (!candidate) continue;
    if (row.type === 'token_usage_record') {
      // session_id may identify the root. Only thread_id can match this file's
      // metadata; defer matching so metadata after a receipt also works.
      const threadId = row.payload.thread_id;
      if (typeof threadId === 'string' && threadId.length && isBetter(candidate, nativeSnapshots.get(threadId))) {
        nativeSnapshots.set(threadId, candidate);
      }
    } else if (isBetter(candidate, snapshot)) snapshot = candidate;
  }
  if (ids.size === 1) {
    const nativeSnapshot = nativeSnapshots.get([...ids][0]);
    if (nativeSnapshot && isBetter(nativeSnapshot, snapshot)) snapshot = nativeSnapshot;
  }
  return { ids, parents, snapshot, malformedLines };
}

/**
 * Summarize explicitly supplied Codex rollout JSONL files for one root session.
 * Missing counters remain null. Cached input and reasoning output are subsets.
 * No conversation content, tool output, prices, or inferred parent links are read.
 */
export async function summarizeUsage({ files, runId }) {
  if (!Array.isArray(files) || typeof runId !== 'string' || !runId.length) {
    throw new TypeError('summarizeUsage requires files[] and a nonempty runId');
  }

  const sessionsById = new Map();
  const problems = { unreadable: 0, malformed: 0, unidentifiable: 0, conflictingIds: 0, excluded: 0 };
  let sequence = 0;
  const uniqueFiles = [...new Set(files.map((path) => resolve(path)))];

  for (const path of uniqueFiles) {
    let fragment;
    try { fragment = await readFragment(path, () => ++sequence); }
    catch { problems.unreadable++; continue; }
    problems.malformed += fragment.malformedLines;
    if (fragment.ids.size === 0) { problems.unidentifiable++; continue; }
    if (fragment.ids.size > 1) { problems.conflictingIds++; continue; }
    const [id] = fragment.ids;
    let session = sessionsById.get(id);
    if (!session) {
      session = { sessionId: id, parents: new Set(), snapshot: null, fileCount: 0 };
      sessionsById.set(id, session);
    }
    session.fileCount++;
    for (const parent of fragment.parents) session.parents.add(parent);
    if (fragment.snapshot && isBetter(fragment.snapshot, session.snapshot)) session.snapshot = fragment.snapshot;
  }

  // A child is included only when its explicit parent chain reaches runId.
  const included = new Set([runId]);
  const ordered = sessionsById.has(runId) ? [sessionsById.get(runId)] : [];
  // Starting from the supplied run ID also allows a linked child to be observed
  // when the root's own file is unavailable.
  const queue = [runId];
  for (let i = 0; i < queue.length; i++) {
    for (const child of sessionsById.values()) {
      if (included.has(child.sessionId) || child.parents.size !== 1) continue;
      if (!child.parents.has(queue[i])) continue;
      included.add(child.sessionId);
      ordered.push(child);
      queue.push(child.sessionId);
    }
  }

  problems.excluded = sessionsById.size - ordered.length;
  const sessions = ordered.map((session) => ({
    sessionId: session.sessionId,
    parentSessionId: session.sessionId === runId ? null : [...session.parents][0],
    usage: session.snapshot?.usage ?? null,
    fileCount: session.fileCount,
  }));
  const observed = sessions.filter((session) => session.usage !== null);
  const totals = emptyTotals();
  for (const key of Object.keys(fields)) {
    if (observed.length && observed.every((session) => session.usage[key] !== null)) {
      totals[key] = observed.reduce((sum, session) => sum + session.usage[key], 0);
    }
  }

  const limitations = [];
  if (!sessionsById.has(runId)) limitations.push('root session metadata missing');
  if (sessions.some((session) => session.usage === null)) limitations.push('cumulative usage missing for one or more linked sessions');
  if (observed.some((session) => Object.values(session.usage).some((value) => value === null))) limitations.push('one or more usage counters missing');
  if (problems.excluded) limitations.push(`${problems.excluded} unrelated or unlinked session(s) excluded`);
  if (problems.unidentifiable) limitations.push(`${problems.unidentifiable} file(s) without session metadata excluded`);
  if (problems.conflictingIds) limitations.push(`${problems.conflictingIds} file(s) with conflicting session IDs excluded`);
  if (problems.unreadable) limitations.push(`${problems.unreadable} unreadable file(s) excluded`);
  if (problems.malformed) limitations.push(`${problems.malformed} malformed JSON line(s) ignored`);
  const complete = sessionsById.has(runId) && sessions.length > 0 &&
    sessions.every((session) => session.usage && Object.values(session.usage).every((value) => value !== null)) &&
    !problems.unreadable && !problems.malformed && !problems.conflictingIds;
  const status = observed.length === 0 ? 'unavailable' : complete ? 'observed' : 'partial';
  return { status, runId, totals, sessions, limitations };
}
