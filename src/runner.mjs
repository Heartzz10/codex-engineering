import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { assert, VERSION, existingInside, mkdirInside, writeJson, json, fingerprint } from './paths.mjs';
import { checkAuthorization } from './profile.mjs';

async function stopTree(child) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    await new Promise(resolve => {
      let finished = false;
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      const finish = () => { if (finished) return; finished = true; clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => { killer.kill(); finish(); }, 1500);
      killer.on('error', finish); killer.on('close', finish);
    });
    // The sandbox may deny taskkill even while allowing termination of our own child.
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  } else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
}

export async function fingerprintCheck(profile, check) {
  const executable = await fs.realpath(check.executable);
  const executableStat = await fs.stat(executable);
  return fingerprint(profile.root, [...check.inputs, ...(profile.environmentFiles || []), ...(profile.engineeringRuleInputs?.[check.id] || [])], { check, root: profile.root, environmentRef: profile.environmentRef, ...(profile.engineeringCatalogHash?{engineeringCatalogHash:profile.engineeringCatalogHash}:{}), environmentKeys: Object.fromEntries((profile.environmentKeys || []).map(k => [k, process.env[k] ?? null])), executableSize: executableStat.size, executableMtime: executableStat.mtimeMs, platform: process.platform, node: process.version });
}

export async function runCheck(profile, checkId, { stateRoot, repeatReason = '', newEvidence = [] } = {}) {
  const check = profile.checks.find(x => x.id === checkId);
  assert(check, 'Unknown check ID');
  checkAuthorization(profile, check);
  const executable = await fs.realpath(check.executable);
  const cwd = await existingInside(profile.root, check.cwd);
  const fp = await fingerprintCheck(profile, check);
  const projectRuns = await mkdirInside(stateRoot, `runs/${profile.id}`);
  const checkRuns = await mkdirInside(stateRoot, `runs/${profile.id}/${checkId}`);
  const lockFile = path.join(projectRuns, '.running.lock');
  const lock = await fs.open(lockFile, 'wx').catch(e => { if (e.code === 'EEXIST') throw new Error('Another check owns this project runner; inspect the recorded PID before clearing a stale lock'); throw e; });
  let terminationUnconfirmed = false;
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, checkId, startedAt: new Date().toISOString() }));
    const previous = [];
    for (const name of (await fs.readdir(checkRuns)).filter(x => /^\d{13}-[a-f0-9-]+$/.test(x)).sort().reverse().slice(0, 2)) {
      try {
        const r = await json(await existingInside(checkRuns, `${name}/receipt.json`));
        if (r.checkId === checkId) previous.push(r);
      } catch (e) { throw new Error(`Unreadable prior evidence (${name}): ${e.message}`); }
    }
    const latest = previous[0];
    assert(Array.isArray(newEvidence) && newEvidence.length <= 8, 'New evidence must be at most eight project-relative files');
    const evidenceFiles = [];
    for (const relative of newEvidence) {
      const file = await existingInside(profile.root, relative), stat = await fs.stat(file);
      assert(stat.isFile() && stat.size <= 2 * 1024 * 1024, 'New evidence must be a file of at most 2 MB');
      const sha256 = crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
      evidenceFiles.push({ path: relative, sha256 });
    }
    const seenEvidenceHashes = [...new Set(previous.flatMap(r => [...(r.seenEvidenceHashes || []), ...(r.newEvidence || []).map(e => e.sha256)]))];
    const freshEvidence = evidenceFiles.filter(e => !seenEvidenceHashes.includes(e.sha256));
    if (latest?.fingerprint === fp.digest && latest.status !== 'check_passed' && !freshEvidence.length) {
      return { status: 'repeat_requires_evidence', checkId, projectId: profile.id, priorResult: latest.status, priorReceipt: latest.runId, businessAcceptance: false, message: 'Same failed input: inspect the prior evidence and change the hypothesis. A reason alone is not new evidence; supply a new project-relative diagnostic artifact or change the affected input.' };
    }
    if (!repeatReason.trim() && latest?.fingerprint === fp.digest && latest.status === 'check_passed') {
      return { status: 'repeat_requires_reason', checkId, projectId: profile.id, priorResult: latest.status, priorReceipt: latest.runId, businessAcceptance: false, message: 'No relevant change detected. Reuse the existing check evidence where valid, or state new evidence/user-request/environment change for rerun.' };
    }
    const runId = `${Date.now()}-${crypto.randomUUID()}`;
    const runDir = await mkdirInside(stateRoot, `runs/${profile.id}/${checkId}/${runId}`);
    const startedAt = new Date().toISOString();
    const stdoutFile = path.join(runDir, 'stdout.log'), stderrFile = path.join(runDir, 'stderr.log');
    const out = await fs.open(stdoutFile, 'wx'), err = await fs.open(stderrFile, 'wx');
    let bytes = 0, outTail = '', errTail = '', timedOut = false, outputLimited = false, executionError = null;
    let writes = Promise.resolve();
    const result = await new Promise(resolve => {
      const child = spawn(executable, check.args, { cwd, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
      let stopping = null, settled = false, graceTimer;
      const finish = value => { if (settled) return; settled = true; clearTimeout(timer); clearTimeout(graceTimer); resolve(value); };
      const stop = () => {
        if (!stopping) {
          stopping = stopTree(child);
          graceTimer = setTimeout(() => {
            terminationUnconfirmed = true;
            child.stdout.destroy(); child.stderr.destroy(); child.unref();
            finish({ exitCode: null, signal: null });
          }, 4000);
        }
        return stopping;
      };
      const timer = setTimeout(() => { timedOut = true; void stop(); }, check.timeoutMs);
      const collect = (handle, chunk, isError) => {
        bytes += chunk.length;
        if (bytes > 32 * 1024 * 1024) { outputLimited = true; void stop(); return; }
        writes = writes.then(() => handle.write(chunk)).catch(e => { executionError = e.message; void stop(); });
        if (isError) errTail = (errTail + chunk.toString('utf8')).slice(-1200); else outTail = (outTail + chunk.toString('utf8')).slice(-1200);
      };
      child.stdout.on('data', chunk => collect(out, chunk, false));
      child.stderr.on('data', chunk => collect(err, chunk, true));
      child.on('error', e => { executionError = e.message; });
      child.on('close', async (exitCode, signal) => { if (stopping) await stopping; finish({ exitCode, signal }); });
    });
    await writes; await out.close(); await err.close();
    const receipt = {
      schemaVersion: 1, runId, projectId: profile.id, checkId, packageVersion: VERSION,
      status: terminationUnconfirmed ? 'termination_unconfirmed' : timedOut ? 'timed_out' : outputLimited ? 'output_limit' : executionError ? 'execution_error' : result.exitCode === 0 ? 'check_passed' : 'check_failed',
      startedAt, finishedAt: new Date().toISOString(), ...result, fingerprint: fp.digest,
      inputFiles: fp.files, environmentRef: profile.environmentRef, cwd, executable,
      authorizationRef: check.authorizationRef, effects: check.effects, repeatReason: repeatReason || null,
      newEvidence: evidenceFiles, seenEvidenceHashes: [...new Set([...seenEvidenceHashes, ...evidenceFiles.map(e => e.sha256)])],
      outputBytes: bytes, stdoutFile, stderrFile, executionError,
      stdoutSha256: crypto.createHash('sha256').update(await fs.readFile(stdoutFile)).digest('hex'),
      stderrSha256: crypto.createHash('sha256').update(await fs.readFile(stderrFile)).digest('hex'),
      businessAcceptance: false, limitation: 'Only declared files and environment keys are fingerprinted, not live application state. A process result does not prove role/UI/business acceptance.'
    };
    await writeJson(path.join(runDir, 'receipt.json'), receipt);
    return { status: receipt.status, projectId: profile.id, checkId, runId, exitCode: result.exitCode, outputBytes: bytes, summary: (errTail || outTail).trim().slice(-650), evidence: path.join(runDir, 'receipt.json'), businessAcceptance: false };
  } finally { await lock.close(); if (!terminationUnconfirmed) await fs.unlink(lockFile).catch(() => {}); }
}
