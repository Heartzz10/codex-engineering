import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadProfile } from '../src/profile.mjs';
import { runCheck } from '../src/runner.mjs';

async function fixture(t, code = 'console.log("RESULT_OK")') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), '工程 check '));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'project'), stateRoot = path.join(dir, 'state');
  await fs.mkdir(root); await fs.writeFile(path.join(root, 'GUIDE.md'), 'Current project');
  await fs.writeFile(path.join(root, 'check.mjs'), code);
  const profile = { schemaVersion: 1, id: 'fixture', sharedVersion: '0.1.0', root, authoritativeDocuments: ['GUIDE.md'], environmentRef: 'node-current-test', permissions: { testArtifacts: false, network: false }, checks: [{ id: 'check', executable: process.execPath, args: ['check.mjs'], cwd: '.', reviewed: true, authorizationRef: 'isolated-test', effects: { writes: 'none', network: false, paid: false }, timeoutMs: 2000, inputs: ['check.mjs'] }] };
  const file = path.join(dir, 'profile.json');
  const save = async () => { await fs.writeFile(file, JSON.stringify(profile)); return loadProfile(file); };
  return { root, stateRoot, profile, file, save };
}

test('real command works with Chinese/spaces; receipt never implies business acceptance; rerun needs reason', async t => {
  const f = await fixture(t);
  const p = await f.save();
  const r = await runCheck(p, 'check', f);
  assert.equal(r.status, 'check_passed'); assert.equal(r.businessAcceptance, false);
  const receipt = JSON.parse(await fs.readFile(r.evidence));
  assert.match(await fs.readFile(receipt.stdoutFile, 'utf8'), /RESULT_OK/);
  assert.equal((await runCheck(p, 'check', f)).status, 'repeat_requires_reason');
  assert.equal((await runCheck(p, 'check', { ...f, repeatReason: 'new environment observation' })).status, 'check_passed');
});

test('identical failure requires verifiable new evidence; a reason alone cannot rerun', async t => {
  const f = await fixture(t, 'console.error("expected defect"); process.exit(7)'); const p = await f.save();
  assert.equal((await runCheck(p,'check',f)).status,'check_failed');
  assert.equal((await runCheck(p,'check',{...f,repeatReason:'try again'})).status,'repeat_requires_evidence');
  await fs.writeFile(path.join(f.root,'diagnosis.txt'),'A new environment observation');
  assert.equal((await runCheck(p,'check',{...f,newEvidence:['diagnosis.txt']})).status,'check_failed');
  assert.equal((await runCheck(p,'check',{...f,newEvidence:['diagnosis.txt']})).status,'repeat_requires_evidence');
  await fs.writeFile(path.join(f.root,'check.mjs'),'console.log("fixed")');
  assert.equal((await runCheck(p,'check',f)).status,'check_passed');
});

test('timeout is a failure with inspectable evidence', async t => {
  const f = await fixture(t, 'setInterval(()=>{},1000)'); f.profile.checks[0].timeoutMs=100;
  const r=await runCheck(await f.save(),'check',f);
  assert.equal(r.status,'timed_out'); assert.equal(r.businessAcceptance,false);
});

test('traversal, incompatible version and unknown effects fail before execution', async t => {
  const f=await fixture(t); f.profile.checks[0].cwd='..'; await assert.rejects(f.save(),/escapes/);
  f.profile.checks[0].cwd='.'; f.profile.sharedVersion='9.0.0'; await assert.rejects(f.save(),/version/);
  f.profile.sharedVersion='0.1.0'; delete f.profile.checks[0].effects; await assert.rejects(f.save(),/effects/);
});

test('paid, unapproved network and business-data writes cannot masquerade as baseline checks', async t => {
  const f=await fixture(t);
  for (const effect of [{paid:true},{network:true},{writes:'business-data'}]) {
    f.profile.checks[0].effects={writes:'none',network:false,paid:false,...effect};
    await assert.rejects(runCheck(await f.save(),'check',f),/budget|Network|Business-data/);
  }
});

test('argument array is literal, not a shell command', async t => {
  const f=await fixture(t, 'console.log(process.argv[2])');
  f.profile.checks[0].args.push('literal & echo BAD | syntax');
  const r=await runCheck(await f.save(),'check',f);
  assert.equal(r.status,'check_passed'); assert.match(r.summary,/literal & echo BAD \| syntax/);
});

test('evidence isolation rejects a junction outside state', async t => {
  const f=await fixture(t); await fs.mkdir(f.stateRoot);
  const outside=path.join(f.root,'external'); await fs.mkdir(outside);
  try { await fs.symlink(outside,path.join(f.stateRoot,'runs'),process.platform==='win32'?'junction':'dir'); }
  catch(e) { if(['EPERM','EACCES'].includes(e.code)){t.skip('OS disallows link creation');return;} throw e; }
  await assert.rejects(runCheck(await f.save(),'check',f),/link escapes/);
});
