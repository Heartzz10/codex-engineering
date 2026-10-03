import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { routeTask, getDebugProtocol, auditDebugEvidence } from '../src/pstack.mjs';

const categories = ['investigation','bug-fix','perf-issue','hillclimb','runtime-forensics','trace-forensics','feature','refactoring','prototype','visual-parity','authoring-a-skill','eval','babysit','shipping','autonomous-run','orchestrate','autopilot-full','autopilot-stack','session-pickup','pause-safely','multi-phase-plan','worktree-cleanup','opening-a-pr'];
test('all 23 fixed categories preserve four adopted routes and nineteen explicit fallbacks', async () => {
  for (const category of categories) {
    const result = await routeTask({ category });
    assert.equal(result.categoryId, category);
    assert.equal(result.status, ['investigation','bug-fix','runtime-forensics','trace-forensics'].includes(category) ? 'routed' : 'not_adopted');
    if (result.status === 'not_adopted') {
      assert.ok(result.fallback);
      assert.equal(result.protocol, null);
      assert.equal(result.nextAction?.status, 'local_fallback');
      assert.ok(result.nextAction?.capability);
      assert.ok(result.nextAction?.operation);
      assert.ok(result.nextAction?.prerequisite);
      assert.ok(result.nextAction?.limit);
    }
  }
});
test('ambiguous and contradictory intentions cannot silently become repairs or new captures', async () => {
  assert.equal((await routeTask({ text:'看一下这个问题' })).status, 'needs_intent');
  assert.equal((await routeTask({ category:'missing' })).status, 'unknown_category');
  assert.equal((await routeTask({ outcome:'diagnosis', evidenceMode:'captured' })).categoryId, 'trace-forensics');
  assert.equal((await routeTask({ outcome:'diagnosis', evidenceMode:'live' })).categoryId, 'runtime-forensics');
  assert.equal((await routeTask({ category:'bug-fix', outcome:'explanation' })).status, 'intent_conflict');
  assert.equal((await routeTask({ category:'runtime-forensics', evidenceMode:'captured' })).status, 'intent_conflict');
  assert.equal((await routeTask({ category:'bug-fix', outcome:'diagnosis' })).status, 'intent_conflict');
  assert.equal((await routeTask({ category:'investigation', outcome:'deploy' })).status, 'invalid_intent');
});
test('cross-cutting and unmatched work take a bounded meta route without creating a twenty-fourth adopted playbook', async () => {
  const broad = await routeTask({taskScale:'cross-cutting',category:'bug-fix'});
  assert.equal(broad.status,'not_adopted');
  assert.equal(broad.metaRoute,'figure-it-out');
  assert.equal(broad.pendingCategory,'bug-fix');
  assert.equal(broad.protocol,null);
  assert.equal(broad.nextAction.status,'local_fallback');
  assert.equal((await routeTask({taskScale:'unmatched'})).metaRoute,'figure-it-out');
  const standing = await routeTask({taskScale:'standing-program'});
  assert.equal(standing.categoryId,'orchestrate');
  assert.equal(standing.status,'not_adopted');
  assert.equal((await routeTask({taskScale:'standing-program',category:'bug-fix'})).status,'intent_conflict');
  assert.equal((await routeTask({taskScale:'unmatched',category:'feature'})).status,'intent_conflict');
  assert.equal((await routeTask({taskScale:'huge'})).status,'invalid_intent');
});
test('protocol loads selected source and precise dependencies without claiming execution', async () => {
  const result = await getDebugProtocol({ category:'bug-fix' });
  assert.equal(result.status, 'protocol_ready');
  assert.equal(result.executed, false);
  assert.ok(result.steps.some(s => s.id === 'same-surface-replay'));
  assert.ok(result.steps.some(s => s.id === 'refuted-hypothesis'));
  assert.ok(result.dependencies.some(x => x.id === 'why'));
  assert.ok(result.sourceRefs.every(x => x.blobSha && path.isAbsolute(x.localPath)));
  assert.equal((await getDebugProtocol({ category:'feature' })).status, 'not_adopted');
});
async function fixture(fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pstack-'));
  const profile = {id:'proof-project',root,featureMapRef:{evidenceDir:'evidence'}};
  await fs.mkdir(path.join(root,'evidence'));
  const evidence = async (id, kind, extra={}) => {
    const raw = Buffer.from(`actual raw observation for ${id}\n`);
    await fs.writeFile(path.join(root,'evidence',id+'.txt'),raw);
    return {id,kind,path:`${id}.txt`,sha256:crypto.createHash('sha256').update(raw).digest('hex'),projectId:profile.id,surface:'cli',environment:'local',role:'owner',...extra};
  };
  try {await fn({profile,evidence,root});} finally {await fs.rm(root,{recursive:true,force:true});}
}
test('bug evidence requires same-surface failure to success plus mechanism and hypothesis review', () => fixture(async ({profile,evidence}) => {
  const artifacts = await Promise.all([evidence('before','reproduction',{result:'failed'}),evidence('mechanism','mechanism'),evidence('after','replay',{result:'passed'})]);
  const input = {category:'bug-fix',projectId:profile.id,links:{featureIds:['FEAT-001'],acIds:['AC-001'],changeId:'CHG-001'},artifacts,hypotheses:[{id:'H1',status:'supported',evidenceIds:['mechanism']}],regression:{mode:'alternative',reason:'No cheap isolated test; CLI reproduction retained',evidenceIds:['before','after']}};
  assert.equal((await auditDebugEvidence(profile,input)).status,'evidence_ready_for_review');
  artifacts[2].surface='api';
  assert.ok((await auditDebugEvidence(profile,input)).gaps.includes('same_surface_failed_then_passed_required'));
  artifacts[2].surface='cli'; artifacts[2].sha256='0'.repeat(64);
  await assert.rejects(auditDebugEvidence(profile,input), /artifact_hash_mismatch/);
}));
test('unpaired trace is bounded hypothesis; no symbols cannot be promoted to attributed diagnosis', () => fixture(async ({profile,evidence}) => {
  const artifacts = await Promise.all([evidence('trace','capture'),evidence('query','queryable-data'),evidence('findings','reduced-finding')]);
  const input = {category:'trace-forensics',projectId:profile.id,artifacts};
  let result = await auditDebugEvidence(profile,input);
  assert.equal(result.confidenceCeiling,'bounded_hypothesis');
  assert.ok(result.gaps.includes('symbols_or_explicit_symbol_gap_required'));
  input.symbolGap='Capture has native unresolved addresses; no symbol bundle is available.';
  result=await auditDebugEvidence(profile,input);
  assert.equal(result.status,'evidence_ready_for_review');
  assert.equal(result.attribution,'unresolved_symbols');
  assert.equal(result.behaviorVerified,false);
}));

test('trace comparison needs two matching captures and a comparison artifact', () => fixture(async ({profile,evidence}) => {
  const artifacts = await Promise.all([
    evidence('before','capture'), evidence('after','capture'), evidence('query','queryable-data'),
    evidence('finding','reduced-finding'), evidence('symbols','symbol-map'), evidence('comparison','paired-comparison'),
  ]);
  const input = {category:'trace-forensics',projectId:profile.id,artifacts,
    pairedCapture:{beforeId:'before',afterId:'after',comparisonEvidenceIds:['comparison']}};
  assert.equal((await auditDebugEvidence(profile,input)).confidenceCeiling,'paired_comparison_available_for_review');
  artifacts[1].surface='different-ui';
  assert.equal((await auditDebugEvidence(profile,input)).confidenceCeiling,'bounded_hypothesis');
  artifacts[1].surface='cli'; input.pairedCapture.comparisonEvidenceIds=['query'];
  assert.equal((await auditDebugEvidence(profile,input)).confidenceCeiling,'bounded_hypothesis');
  input.pairedCapture.comparisonEvidenceIds=['comparison']; input.pairedCapture.afterId='query';
  assert.equal((await auditDebugEvidence(profile,input)).confidenceCeiling,'bounded_hypothesis');
}));
test('evidence rejects wrong project, traversal, duplicate IDs and refuted edits without rollback', () => fixture(async ({profile,evidence}) => {
  const a=await evidence('proof','reproduction');
  await assert.rejects(auditDebugEvidence(profile,{category:'bug-fix',projectId:'wrong',artifacts:[a]}),/wrong_project/);
  await assert.rejects(auditDebugEvidence(profile,{category:'bug-fix',projectId:profile.id,artifacts:[{...a,path:'../outside.txt'}]}),/escapes/);
  await assert.rejects(auditDebugEvidence(profile,{category:'bug-fix',projectId:profile.id,artifacts:[a,a]}),/duplicate_artifact/);
  const result=await auditDebugEvidence(profile,{category:'bug-fix',projectId:profile.id,artifacts:[a],hypotheses:[{id:'H1',status:'refuted',editRefs:['src/a.mjs']}]});
  assert.ok(result.gaps.includes('refuted_edits_require_scoped_revert:H1'));
}));

test('project evidence without a separate feature map stays confined to the project root', () => fixture(async ({profile,evidence}) => {
  delete profile.featureMapRef;
  const code = await evidence('code','code-anchor');
  const input = {category:'investigation',projectId:profile.id,artifacts:[{...code,path:`evidence/${code.path}`}]};
  const result = await auditDebugEvidence(profile,input);
  assert.equal(result.status,'evidence_ready_for_review');
  assert.equal(result.behaviorVerified,false);
  input.artifacts[0].path='../outside.txt';
  await assert.rejects(auditDebugEvidence(profile,input),/escapes/);
  input.artifacts[0].path=`evidence/${code.path}`;
  input.artifacts[0].sha256='0'.repeat(64);
  await assert.rejects(auditDebugEvidence(profile,input),/artifact_hash_mismatch/);
}));

test('a why investigation cannot omit source categories or turn declarations into verified behavior', () => fixture(async ({profile,evidence}) => {
  const anchor = await evidence('anchor','code-anchor');
  const input = {category:'investigation',projectId:profile.id,motivationQuestion:'Why is this launch guard here?',artifacts:[anchor]};
  const missing = await auditDebugEvidence(profile,input);
  assert.equal(missing.status,'blocked_evidence');
  assert.equal(missing.gaps.filter(x=>x.startsWith('source_coverage_required:')).length,7);
  input.sourceCoverage = ['source-control','issues','documents','chat','observability','errors','analytics']
    .map(category=>({category,status:category==='source-control'?'searched':'unavailable',detail:`Fixture availability check: ${category}`,evidenceIds:category==='source-control'?['anchor']:undefined}));
  const declared = await auditDebugEvidence(profile,input);
  assert.equal(declared.status,'evidence_ready_for_review');
  assert.equal(declared.behaviorVerified,false);
}));
