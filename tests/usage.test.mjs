import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { summarizeUsage } from '../src/usage.mjs';

async function withLogs(callback) {
  const directory = await mkdtemp(join(tmpdir(), 'codex-usage-'));
  const add = async (name, rows) => {
    const file = join(directory, name);
    await writeFile(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
    return file;
  };
  try { await callback(add); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

const meta = (id, parentId) => ({
  type: 'session_meta',
  payload: { id, ...(parentId && { source: { subagent: { thread_spawn: { parent_thread_id: parentId } } } }) },
});
const count = (time, usage) => ({
  timestamp: time,
  type: 'event_msg',
  payload: { type: 'token_count', info: { total_token_usage: usage } },
});
const usage = (input, cached, output, reasoning) => ({
  input_tokens: input,
  cached_input_tokens: cached,
  output_tokens: output,
  reasoning_output_tokens: reasoning,
  total_tokens: input + output,
});
const native = (time, threadId, cumulative) => ({
  timestamp: time,
  type: 'token_usage_record',
  payload: {
    thread_id: threadId, session_id: 'different-root',
    usage: usage(900, 800, 80, 40), turn_token_usage: usage(700, 600, 70, 30),
    thread_token_usage: cumulative,
  },
});

test('takes a single final cumulative snapshot; cache and reasoning stay subsets', async () => {
  await withLogs(async (add) => {
    const root = await add('root.jsonl', [
      meta('root'),
      count('2026-01-01T00:00:00Z', usage(10, 2, 4, 1)),
      count('2026-01-01T00:00:01Z', usage(40, 15, 12, 5)),
    ]);
    const result = await summarizeUsage({ files: [root], runId: 'root' });
    assert.equal(result.status, 'observed');
    assert.deepEqual(result.totals, {
      inputTokens: 40, cachedInputTokens: 15, outputTokens: 12,
      reasoningOutputTokens: 5, totalTokens: 52,
    });
    assert.equal(result.sessions.length, 1);
  });
});

test('counts only a connected child chain and excludes an independent root', async () => {
  await withLogs(async (add) => {
    const root = await add('root.jsonl', [meta('root'), count('2026-01-01T00:00:00Z', usage(10, 2, 3, 1))]);
    const child = await add('child.jsonl', [meta('child', 'root'), count('2026-01-01T00:00:01Z', usage(5, 1, 2, 1))]);
    const grandchild = await add('grandchild.jsonl', [meta('grandchild', 'child'), count('2026-01-01T00:00:02Z', usage(7, 0, 4, 2))]);
    const other = await add('other.jsonl', [meta('other'), count('2026-01-01T00:00:03Z', usage(100, 50, 30, 10))]);
    const result = await summarizeUsage({ files: [root, child, grandchild, other], runId: 'root' });
    assert.equal(result.status, 'observed');
    assert.deepEqual(result.totals, {
      inputTokens: 22, cachedInputTokens: 3, outputTokens: 9,
      reasoningOutputTokens: 4, totalTokens: 31,
    });
    assert.deepEqual(result.sessions.map((item) => item.sessionId), ['root', 'child', 'grandchild']);
    assert.ok(result.limitations.some((item) => item.includes('excluded')));
  });
});

test('deduplicates fragments of one session and selects one later snapshot intact', async () => {
  await withLogs(async (add) => {
    const a = await add('a.jsonl', [meta('root'), count('2026-01-01T00:00:00Z', usage(80, 60, 10, 5))]);
    const b = await add('b.jsonl', [meta('root'), count('2026-01-01T00:00:02Z', usage(90, 4, 11, 2))]);
    const result = await summarizeUsage({ files: [a, b, a], runId: 'root' });
    assert.equal(result.status, 'observed');
    assert.equal(result.sessions.length, 1);
    assert.equal(result.sessions[0].fileCount, 2);
    assert.deepEqual(result.totals, {
      inputTokens: 90, cachedInputTokens: 4, outputTokens: 11,
      reasoningOutputTokens: 2, totalTokens: 101,
    });
  });
});

test('reports partial when a connected child has no cumulative snapshot', async () => {
  await withLogs(async (add) => {
    const root = await add('root.jsonl', [meta('root'), count('2026-01-01T00:00:00Z', usage(10, 0, 2, 0))]);
    const child = await add('child.jsonl', [meta('child', 'root')]);
    const result = await summarizeUsage({ files: [root, child], runId: 'root' });
    assert.equal(result.status, 'partial');
    assert.equal(result.totals.totalTokens, 12);
    assert.equal(result.sessions[1].usage, null);
    assert.ok(result.limitations.some((item) => item.includes('missing')));
  });
});

test('reports unavailable with null totals when target has no observable usage', async () => {
  await withLogs(async (add) => {
    const other = await add('other.jsonl', [meta('other'), count('2026-01-01T00:00:00Z', usage(5, 0, 1, 0))]);
    const result = await summarizeUsage({ files: [other], runId: 'root' });
    assert.equal(result.status, 'unavailable');
    assert.deepEqual(result.totals, {
      inputTokens: null, cachedInputTokens: null, outputTokens: null,
      reasoningOutputTokens: null, totalTokens: null,
    });
  });
});

test('does not infer a child from file order or a conflicting parent claim', async () => {
  await withLogs(async (add) => {
    const root = await add('root.jsonl', [meta('root'), count('2026-01-01T00:00:00Z', usage(3, 0, 1, 0))]);
    const unknown = await add('unknown.jsonl', [meta('unknown'), count('2026-01-01T00:00:01Z', usage(90, 0, 10, 0))]);
    const conflicting = await add('conflicting.jsonl', [
      meta('conflicting', 'root'), meta('conflicting', 'other'),
      count('2026-01-01T00:00:02Z', usage(90, 0, 10, 0)),
    ]);
    const result = await summarizeUsage({ files: [root, unknown, conflicting], runId: 'root' });
    assert.equal(result.status, 'observed');
    assert.deepEqual(result.sessions.map((item) => item.sessionId), ['root']);
    assert.equal(result.totals.totalTokens, 4);
  });
});

test('keeps unknown counters null instead of assuming zero', async () => {
  await withLogs(async (add) => {
    const root = await add('root.jsonl', [meta('root'), count('2026-01-01T00:00:00Z', {
      input_tokens: 4, output_tokens: 1, total_tokens: 5,
    })]);
    const result = await summarizeUsage({ files: [root], runId: 'root' });
    assert.equal(result.status, 'partial');
    assert.equal(result.totals.cachedInputTokens, null);
    assert.equal(result.totals.reasoningOutputTokens, null);
    assert.equal(result.totals.totalTokens, 5);
  });
});

test('marks a linked child as partial evidence when the root file is absent', async () => {
  await withLogs(async (add) => {
    const child = await add('child.jsonl', [
      meta('child', 'root'), count('2026-01-01T00:00:00Z', usage(6, 1, 2, 0)),
    ]);
    const result = await summarizeUsage({ files: [child], runId: 'root' });
    assert.equal(result.status, 'partial');
    assert.deepEqual(result.sessions.map((item) => item.sessionId), ['child']);
    assert.equal(result.totals.totalTokens, 8);
    assert.ok(result.limitations.some((item) => item.includes('root session metadata missing')));
  });
});

test('native-only records use metadata identity and thread cumulative, even before metadata', async () => {
  await withLogs(async (add) => {
    const root = await add('native.jsonl', [
      native('2026-01-01T00:00:00Z', 'root', usage(12, 9, 4, 2)), meta('root'),
      native('2026-01-01T00:00:01Z', 'root', usage(24, 18, 7, 3)),
    ]);
    const result = await summarizeUsage({ files: [root], runId: 'root' });
    assert.equal(result.status, 'observed');
    assert.deepEqual(result.totals, {
      inputTokens: 24, cachedInputTokens: 18, outputTokens: 7,
      reasoningOutputTokens: 3, totalTokens: 31,
    });
    assert.equal(result.sessions[0].sessionId, 'root');
  });
});

test('interleaved old and native snapshots choose the newest complete snapshot intact', async () => {
  await withLogs(async (add) => {
    const newerNative = await add('native-newest.jsonl', [meta('root'),
      count('2026-01-01T00:00:00Z', usage(80, 60, 10, 5)),
      native('2026-01-01T00:00:02Z', 'root', usage(90, 4, 11, 2)),
      count('2026-01-01T00:00:01Z', usage(85, 70, 10, 5)),
    ]);
    const result = await summarizeUsage({ files: [newerNative], runId: 'root' });
    assert.deepEqual(result.totals, { inputTokens: 90, cachedInputTokens: 4, outputTokens: 11, reasoningOutputTokens: 2, totalTokens: 101 });
    const newerOld = await add('old-newest.jsonl', [meta('root'),
      native('2026-01-01T00:00:03Z', 'root', usage(91, 80, 12, 6)),
      count('2026-01-01T00:00:04Z', usage(95, 5, 13, 1)),
    ]);
    const combined = await summarizeUsage({ files: [newerOld, newerNative], runId: 'root' });
    assert.deepEqual(combined.totals, { inputTokens: 95, cachedInputTokens: 5, outputTokens: 13, reasoningOutputTokens: 1, totalTokens: 108 });
  });
});

test('native records with a wrong or missing thread ID cannot replace valid usage', async () => {
  await withLogs(async (add) => {
    const root = await add('wrong-thread.jsonl', [meta('root'),
      count('2026-01-01T00:00:00Z', usage(10, 2, 3, 1)),
      native('2026-01-01T00:00:01Z', 'other', usage(100, 80, 30, 20)),
      native('2026-01-01T00:00:02Z', undefined, usage(200, 180, 40, 25)),
    ]);
    const result = await summarizeUsage({ files: [root], runId: 'root' });
    assert.equal(result.totals.totalTokens, 13);
    const onlyWrong = await add('only-wrong.jsonl', [meta('root'), native('2026-01-01T00:00:01Z', 'other', usage(100, 80, 30, 20))]);
    const missing = await summarizeUsage({ files: [onlyWrong], runId: 'root' });
    assert.equal(missing.status, 'unavailable');
    assert.equal(missing.totals.totalTokens, null);
  });
});

test('native records never fall back to response or turn usage without thread cumulative', async () => {
  await withLogs(async (add) => {
    const root = await add('no-thread-total.jsonl', [meta('root'), native('2026-01-01T00:00:00Z', 'root', undefined)]);
    const result = await summarizeUsage({ files: [root], runId: 'root' });
    assert.equal(result.status, 'unavailable');
    assert.equal(result.totals.totalTokens, null);
  });
});

test('native partial snapshots preserve nulls and cannot overwrite a complete old snapshot', async () => {
  await withLogs(async (add) => {
    const incomplete = { input_tokens: 40, output_tokens: 8, total_tokens: 48, cached_input_tokens: -1 };
    const partial = await add('partial.jsonl', [meta('root'), native('2026-01-01T00:00:02Z', 'root', incomplete)]);
    const result = await summarizeUsage({ files: [partial], runId: 'root' });
    assert.equal(result.status, 'partial');
    assert.deepEqual(result.totals, { inputTokens: 40, cachedInputTokens: null, outputTokens: 8, reasoningOutputTokens: null, totalTokens: 48 });
    const complete = await add('complete.jsonl', [meta('root'), count('2026-01-01T00:00:01Z', usage(30, 10, 6, 2))]);
    const combined = await summarizeUsage({ files: [complete, partial], runId: 'root' });
    assert.deepEqual(combined.totals, { inputTokens: 30, cachedInputTokens: 10, outputTokens: 6, reasoningOutputTokens: 2, totalTokens: 36 });
  });
});

test('native linked children count once while unrelated and conflicting metadata stay excluded', async () => {
  await withLogs(async (add) => {
    const root = await add('root.jsonl', [meta('root'), native('2026-01-01T00:00:00Z', 'root', usage(10, 2, 3, 1))]);
    const child = await add('child.jsonl', [meta('child', 'root'), native('2026-01-01T00:00:01Z', 'child', usage(5, 1, 2, 1))]);
    const other = await add('other.jsonl', [meta('other'), native('2026-01-01T00:00:02Z', 'other', usage(100, 80, 30, 20))]);
    const conflict = await add('conflict.jsonl', [meta('root'), native('2026-01-01T00:00:03Z', 'root', usage(999, 800, 90, 40)), meta('conflicting')]);
    const result = await summarizeUsage({ files: [root, child, other, conflict, child], runId: 'root' });
    assert.equal(result.status, 'partial');
    assert.equal(result.totals.totalTokens, 20);
    assert.deepEqual(result.sessions.map(s => s.sessionId), ['root', 'child']);
    assert.ok(result.limitations.some(s => s.includes('conflicting session IDs')));
  });
});

test('usage CLI reads the newer native thread cumulative instead of an older event total', async () => {
  await withLogs(async (add) => {
    const root = await add('cli.jsonl', [meta('root'), count('2026-01-01T00:00:00Z', usage(10, 2, 3, 1)), native('2026-01-01T00:00:01Z', 'root', usage(20, 8, 5, 2))]);
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../src/cli.mjs', import.meta.url)), 'usage', '--run', 'root', '--file', root], { encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    const body = JSON.parse(result.stdout);
    assert.equal(body.status, 'observed');
    assert.equal(body.totals.totalTokens, 25);
  });
});
