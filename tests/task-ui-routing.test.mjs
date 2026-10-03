import test from 'node:test';
import assert from 'node:assert/strict';
import { selectResources } from '../src/catalog.mjs';
import { startupReadiness } from '../src/startup-readiness.mjs';

const profile = {authoritativeDocuments:['GUIDE.md'],checks:[{}],entrypoints:[{id:'local'}],featureMapStatus:'configured',
  acceptanceRoutes:[{driverRef:'driver.mjs'}],controls:{sourceReview:{inputs:['app.mjs']}},uiQualityStatus:'not_configured'};
test('both existing UI flags consistently prepare UI resources and report the applicable gap', async () => {
  for (const flag of ['ui','uiChange']) {
    const task = {kind:'implementation',[flag]:true};
    assert(startupReadiness(profile,task).gaps.some(g=>g.id==='ui_quality'),flag);
    assert((await selectResources(task)).some(r=>r.id==='standard.ui'),flag);
  }
});
test('interaction debugging and new UI discovery reuse design and UI references', async () => {
  const debug = await selectResources({kind:'debugging',ui:true});
  assert(debug.some(r=>r.id==='standard.ui'));
  assert(debug.some(r=>r.id==='standard.ui-design'));
  const design = await selectResources({kind:'discovery',uiChange:true});
  assert(design.some(r=>r.id==='standard.requirements'));
  assert(design.some(r=>r.id==='standard.ui-design'));
});
test('documentation and concept explanation retain the short path despite UI keywords', async () => {
  for (const task of [{kind:'documentation',ui:true},{kind:'discovery',workType:'explanation',uiChange:true}]) {
    assert(!(await selectResources(task)).some(r=>r.id==='standard.ui'||r.id==='standard.ui-design'));
    assert(!startupReadiness(profile,task).gaps.some(g=>g.id==='ui_quality'));
  }
});
test('existing UI kind aliases select existing references without widening the catalog schema', async () => {
  for (const kind of ['ui','interface','interaction']) {
    assert((await selectResources({kind})).some(r=>r.id==='standard.ui'));
  }
  const {readFile} = await import('node:fs/promises');
  const catalog=JSON.parse(await readFile('catalog/index.json','utf8'));
  const schema=JSON.parse(await readFile('schemas/catalog.schema.json','utf8'));
  const allowed=schema.properties.resources.items.properties.taskKinds.items.enum;
  assert(catalog.resources.every(r=>r.taskKinds.every(k=>allowed.includes(k))));
});
