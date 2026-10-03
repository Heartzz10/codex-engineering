import test from 'node:test';
import assert from 'node:assert/strict';
import { assessVisualSnapshot } from '../src/visual-check.mjs';

const constraints = { goal: 'Save and search a note without clipped or covered controls', viewport: { width: 360, height: 900 },
  required: [{ selector: '#save', inViewport: true, interactive: true }] };
const snapshot = () => ({ viewport: { width: 360, height: 900 }, document: { scrollWidth: 360 },
  elements: [{ selector: '#save', found: true, rect: { x: 24, y: 200, width: 110, height: 44 },
    visible: true, enabled: true, fontSize: 17, hitTests: [true, true, true, true, true] }] });
test('visible and reachable controls pass at the declared viewport', () => {
  assert.equal(assessVisualSnapshot(snapshot(), constraints).status, 'passed');
});
test('narrow screen horizontal overflow fails even if a screenshot exists', () => {
  const actual = snapshot(); actual.document.scrollWidth = 900;
  assert.equal(assessVisualSnapshot(actual, constraints).status, 'failed');
  assert.ok(assessVisualSnapshot(actual, constraints).issues.some(item => item.code === 'horizontal_overflow'));
});
test('a covered button fails despite being styled visible and enabled', () => {
  const actual = snapshot(); actual.elements[0].hitTests = [false, false, false, false, false];
  assert.ok(assessVisualSnapshot(actual, constraints).issues.some(item => item.code === 'control_obstructed'));
});
test('missing or clipped required controls cannot pass', () => {
  const actual = snapshot(); actual.elements[0].rect.x = 350;
  assert.ok(assessVisualSnapshot(actual, constraints).issues.some(item => item.code === 'outside_viewport'));
  actual.elements = [];
  assert.ok(assessVisualSnapshot(actual, constraints).issues.some(item => item.code === 'missing_element'));
});
test('a viewport mismatch or missing target does not become acceptance', () => {
  const actual = snapshot(); actual.viewport.width = 800;
  assert.ok(assessVisualSnapshot(actual, constraints).issues.some(item => item.code === 'viewport_mismatch'));
  assert.throws(() => assessVisualSnapshot(snapshot(), { required: constraints.required }), /goal.*viewport/);
});

test('legacy input reports only its measured scope and never business acceptance', () => {
  const result = assessVisualSnapshot(snapshot(), constraints);
  assert.equal(result.coverage.mode, 'legacy');
  assert.equal(result.businessAcceptance, 'not_verified');
});

test('a declared layout relation cannot be ignored by the legacy reducer', () => {
  const actual = snapshot();
  actual.elements.push({ selector: '#container', found: true, rect: { x: 0, y: 0, width: 20, height: 20 } });
  const result = assessVisualSnapshot(actual, { ...constraints, rules: [{ id: 'within', type: 'containment', categoryId: 'Q01',
    selector: '#save', containerSelector: '#container', source: 'project-layout.md#save' }] });
  assert.equal(result.status, 'failed');
  assert.equal(result.findings[0].code, 'outside_container');
});

test('legacy required controls preserve partial hit conflicts as review', () => {
  const actual = snapshot(); actual.elements[0].hitTests = [true, true, true, false, false];
  actual.elements[0].hitTestDetails = { points: [{ x: 46, y: 235.2, hit: false, target: { tagName: 'H1', id: 'heading' } }] };
  const result = assessVisualSnapshot(actual, constraints);
  assert.equal(result.status, 'review');
  assert.equal(result.issues[0].code, 'control_partially_obstructed');
  assert.equal(result.issues[0].status, 'review');
  assert.deepEqual(result.issues[0].detail.hitTestDetails, actual.elements[0].hitTestDetails);
});

test('legacy required controls cannot pass or allege measured obstruction when hit data is missing', () => {
  for (const hitTests of [undefined, [true, true, null, true, true], [true, true, true, true]]) {
    const actual = snapshot(); actual.elements[0].hitTests = hitTests;
    const result = assessVisualSnapshot(actual, constraints);
    assert.equal(result.status, 'blocked');
    assert.ok(result.issues.some(item => item.status === 'gap' && item.code === 'missing_hit_measurement'));
    assert.ok(!result.issues.some(item => item.code === 'control_obstructed'));
  }
});

test('unknown legacy visibility does not become confirmed invisibility or a pass', () => {
  const actual = snapshot(); actual.elements[0].visible = null;
  const result = assessVisualSnapshot(actual, constraints);
  assert.equal(result.status, 'blocked');
  assert.ok(result.issues.some(item => item.status === 'gap' && item.code === 'missing_visibility_measurement'));
  assert.ok(!result.issues.some(item => item.code === 'element_not_visible'));
});
