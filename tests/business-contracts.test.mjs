import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../examples/verification-sample/server.mjs';
import {checkSampleApi} from '../examples/verification-sample/rule-check.mjs';

test('project rule check exercises bad and legal requests at the actual sample API',async()=>{
  const result=await checkSampleApi();
  assert.equal(result.status,'passed');
  assert.ok(result.cases.includes('invalid_requests_no_write'));
  assert.ok(result.cases.includes('legal_create_and_readback'));
  assert.ok(result.cases.includes('internal_failure_redacted_and_correlated'));
  assert.ok(result.cases.includes('idempotent_replay_conflict_and_parallel_no_loss'));
  assert.ok(result.cases.includes('idempotency_survives_restart'));
});

test('sample actual API never sends an internal exception or sensitive marker to its user', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'baseline-error-'));
  const events = [];
  const service = await startServer({ port: 0, dataDir, logger: event => events.push(event) });
  t.after(async () => { await service.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  await fs.writeFile(path.join(dataDir, 'notes.json'), 'FAKE_PASSWORD_DO_NOT_EXPOSE');
  const response = await fetch(`${service.url}/api/notes`);
  const body = await response.json();
  assert.equal(response.status, 500);
  assert.ok(!JSON.stringify(body).includes('FAKE_PASSWORD'));
  assert.ok(!/JSON|Unexpected|position|stack|SyntaxError/.test(body.error));
  assert.match(body.eventId, /^[a-f0-9-]{36}$/);
  assert.equal(events.length, 1);
  assert.equal(events[0].eventId, body.eventId);
  assert.ok(!JSON.stringify(events).includes('FAKE_PASSWORD'));
  await fs.writeFile(path.join(dataDir, 'notes.json'), '[]');
  const saved = await fetch(`${service.url}/api/notes`, { method: 'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ text: '正常输入' }) });
  assert.equal(saved.status, 201);
  assert.equal((await (await fetch(`${service.url}/api/notes`)).json()).notes[0].text, '正常输入');
});

test('real sample API rejects wrong content type and invalid fields before writing, while legal JSON persists', async t => {
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'rule-data-'));
  const service=await startServer({port:0,dataDir});
  t.after(async()=>{await service.close();await fs.rm(dataDir,{recursive:true,force:true});});
  const url=`${service.url}/api/notes`;
  const post=(body,contentType='application/json')=>fetch(url,{method:'POST',headers:{'content-type':contentType},body});
  assert.equal((await post('{"text":"wrong type"}','text/plain')).status,415);
  for(const body of ['{','{}','{"text":42}','{"text":"   "}',JSON.stringify({text:'界'.repeat(2001)})]){
    const response=await post(body);
    assert.equal(response.status,400,body.slice(0,40));
  }
  assert.deepEqual((await (await fetch(url)).json()).notes,[]);
  const saved=await post(JSON.stringify({text:'  合法笔记  '}));
  assert.equal(saved.status,201);
  const created=(await saved.json()).note;
  assert.equal(created.text,'合法笔记');
  assert.deepEqual((await (await fetch(url)).json()).notes,[created]);
});

test('public errors use project copy, keep unknown outcomes and never expose diagnostics', async () => {
  const { publicError } = await import('../src/business-contracts.mjs');
  const catalog = { TOO_LONG: { message: '标题最多50字，请缩短后保存。', action: 'edit', outcome: 'not_completed' } };
  assert.equal(publicError({ code: 'TOO_LONG', message: 'SQL secret' }, catalog, 'event-1').message, catalog.TOO_LONG.message);
  const unknown = publicError(new Error('secret'), catalog, 'event-2');
  assert.equal(unknown.outcome, 'unknown');
  assert.ok(!JSON.stringify(unknown).includes('secret'));
  assert.throws(() => publicError({ code: 'TOO_LONG' }, { TOO_LONG: { message: '可读', action: '', outcome: 'not_completed' } }, 'event'), /catalog/);
});

test('business log allowlist drops nested secrets, raw diagnostics and unknown fields', async () => {
  const { businessEvent } = await import('../src/business-contracts.mjs');
  const event = businessEvent({ event: 'note.failed', time: new Date().toISOString(), level: 'error', outcome: 'unknown', eventId: 'event-2', password: 'FAKE', body: { key: 'FAKE' }, message: 'FAKE', count: 1 }, ['count']);
  assert.deepEqual(Object.keys(event).sort(), ['count','event','eventId','level','outcome','time'].sort());
  assert.throws(() => businessEvent({ event: 'ok' }), /required/);
  assert.throws(() => businessEvent({ event: 'ok', time: 'yesterday', level: 'info', outcome: 'completed' }), /time/);
  assert.throws(() => businessEvent({ event: 'ok', time: new Date().toISOString(), level: 'info', outcome: 'completed', meta: { password: 'FAKE' } }, ['meta']), /scalar/);
  assert.throws(() => businessEvent({}, ['password']), /sensitive/);
});
