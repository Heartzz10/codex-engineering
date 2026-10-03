import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { assessVisualSnapshot, collectVisualSnapshot } from '../src/visual-check.mjs';

const source = 'project-ui.md#declared-rule';
const rule = (type, extra = {}) => ({ id: type, type, categoryId: 'Q01', selector: '#save', source, ...extra });
const rect = { x: 24, y: 200, width: 110, height: 44 };
const measurements = () => ({ viewport: { width: 360, height: 900 }, document: { scrollWidth: 360 },
  elements: [
    { selector: '#save', found: true, rect: { ...rect }, visible: true, enabled: true, fontSize: 17,
      text: 'Save this complete note', hitTests: [true, true, true, true, true],
      state: { visible: true, enabled: true, expanded: false, selected: false, busy: false, checked: false },
      textMetrics: { clientWidth: 110, clientHeight: 44, scrollWidth: 110, scrollHeight: 44,
        overflowX: 'visible', overflowY: 'visible', lineClamp: 'none',
        rects: [{ x: 25, y: 210, width: 105, height: 20 }], clippingRects: [] } },
    { selector: '#container', found: true, rect: { x: 10, y: 190, width: 330, height: 120 }, visible: true },
    { selector: '#peer', found: true, rect: { x: 150, y: 200, width: 80, height: 44 }, visible: true },
    { selector: '#full', found: true, visible: true, text: 'Save this complete note', rect: { x: 20, y: 300, width: 280, height: 80 },
      textMetrics: { clientWidth: 280, clientHeight: 80, scrollWidth: 280, scrollHeight: 80,
        overflowX: 'visible', overflowY: 'visible', lineClamp: 'none',
        rects: [{ x: 21, y: 310, width: 200, height: 20 }], clippingRects: [] } }
  ],
  scrollChecks: [{ ruleId: 'scroll-reachability', selector: '#save', containerSelector: '#container', operation: 'scrollIntoView',
    containerContains: true, restored: true, overflowX: 'hidden', overflowY: 'auto',
    before: { targetRect: { x: 24, y: 600, width: 110, height: 44 }, containerRect: { x: 10, y: 190, width: 330, height: 120 }, scrollTop: 0, scrollLeft: 0 },
    after: { targetRect: { ...rect }, containerRect: { x: 10, y: 190, width: 330, height: 120 }, scrollTop: 400, scrollLeft: 0, visible: true,
      clippingRects: [{ x: 10, y: 190, width: 330, height: 120 }], hitTests: [true, true, true, true, true] } }],
  accessibility: { tool: 'axe-core', scope: 'document', results: { testEngine: { name: 'axe-core', version: '4.12.0' },
    testRunner: { name: 'axe' }, timestamp: '2026-09-27T00:00:00.000Z', url: 'http://localhost/sample',
    passes: [{ id: 'button-name', nodes: [{ target: ['#save'], any: [], all: [], none: [] }] }],
    violations: [], incomplete: [], inapplicable: [] } } });
const constraints = rules => ({ goal: 'Declared UI measurements', viewport: { width: 360, height: 900 },
  required: [{ selector: '#save', inViewport: true, interactive: true }], rules });
const assess = (actual, rules) => assessVisualSnapshot(actual, constraints(rules));

const cases = [
  { name: 'containment', config: rule('containment', { containerSelector: '#container' }),
    corrupt: s => { s.elements[1].rect.width = 20; }, remove: s => { delete s.elements[1].rect; }, code: 'outside_container' },
  { name: 'spacing', config: rule('spacing', { otherSelector: '#peer', axis: 'horizontal', min: 12, max: 24 }),
    corrupt: s => { s.elements[2].rect.x = 136; }, remove: s => { delete s.elements[2].rect; }, code: 'spacing_out_of_range' },
  { name: 'alignment', config: rule('alignment', { otherSelector: '#peer', edge: 'top', tolerance: 1 }),
    corrupt: s => { s.elements[2].rect.y = 220; }, remove: s => { delete s.elements[2].rect; }, code: 'alignment_mismatch' },
  { name: 'text-clipping', config: rule('text-clipping', { allowTruncation: false }),
    corrupt: s => { s.elements[0].textMetrics.scrollWidth = 300; s.elements[0].textMetrics.overflowX = 'hidden'; },
    remove: s => { delete s.elements[0].textMetrics; }, code: 'text_clipped' },
  { name: 'scroll-reachability', config: rule('scroll-reachability', { containerSelector: '#container', axis: 'vertical', interactive: true }),
    corrupt: s => { s.scrollChecks[0].after.targetRect.y = 500; }, remove: s => { delete s.scrollChecks; }, code: 'scroll_target_unreachable' },
  { name: 'state', config: rule('state', { expect: { visible: true, enabled: true, expanded: false } }),
    corrupt: s => { s.elements[0].state.expanded = true; }, remove: s => { delete s.elements[0].state; }, code: 'state_mismatch' },
  { name: 'hit-target', config: rule('hit-target', { minWidth: 44, minHeight: 44 }),
    corrupt: s => { s.elements[0].rect.height = 20; }, remove: s => { delete s.elements[0].hitTests; }, code: 'target_too_small' },
  { name: 'axe', config: rule('axe', { selector: undefined, ruleIds: ['button-name'], categoryId: 'Q05' }),
    corrupt: s => { s.accessibility.results.violations = [{ id: 'button-name', nodes: [{ target: ['#save'], any: [], all: [], none: [] }] }]; },
    remove: s => { delete s.accessibility; }, code: 'accessibility_violation' }
];

for (const entry of cases) {
  test(`${entry.name} rejects a known bad measurement`, () => {
    const actual = measurements(); entry.corrupt(actual);
    const result = assess(actual, [entry.config]);
    assert.equal(result.status, 'failed');
    assert.ok(result.findings.some(item => item.code === entry.code));
  });
  test(`${entry.name} accepts its legal counterexample within declared scope`, () => {
    const result = assess(measurements(), [entry.config]);
    assert.equal(result.status, 'passed');
    assert.equal(result.findings[0].status, 'passed');
    assert.equal(result.findings[0].ruleId, entry.config.id);
    assert.equal(result.findings[0].sourceRef, source);
    assert.equal(result.findings[0].method, 'measurement');
    assert.equal(result.businessAcceptance, 'not_verified');
  });
  test(`${entry.name} missing measurement cannot pass`, () => {
    const actual = measurements(); entry.remove(actual);
    const result = assess(actual, [entry.config]);
    assert.notEqual(result.status, 'passed');
    assert.equal(result.findings[0].status, 'gap');
  });
}

test('unknown runtime capability and absent rule source cannot silently pass', () => {
  for (const config of [rule('native-widget'), { ...rule('alignment', { otherSelector: '#peer', edge: 'top' }), source: undefined }]) {
    const result = assess(measurements(), [config]);
    assert.notEqual(result.status, 'passed');
    assert.equal(result.findings[0].status, 'gap');
  }
});

test('incomplete axe results retain raw review data and never become passed', () => {
  const actual = measurements();
  actual.accessibility.results.incomplete.push({ id: 'color-contrast', nodes: [{ target: ['#save'], any: [{ id: 'color-contrast', data: null }], all: [], none: [] }] });
  const result = assess(actual, [rule('axe', { selector: undefined, categoryId: 'Q05' })]);
  assert.equal(result.status, 'review');
  assert.deepEqual(result.findings[0].actual.incomplete, actual.accessibility.results.incomplete);
  assert.deepEqual(result.accessibility, actual.accessibility);
});

test('an empty, wrong-engine, missing-array or untested axe response cannot pass', () => {
  const invalid = [
    r => { r.passes = []; }, r => { r.testEngine.name = 'self-reported'; },
    r => { delete r.incomplete; }, r => { r.passes[0].id = 'another-rule'; }
  ];
  for (const mutate of invalid) {
    const actual = measurements(); mutate(actual.accessibility.results);
    assert.equal(assess(actual, [cases[7].config]).findings[0].status, 'gap');
  }
});

test('permitted truncation passes only when a visible full-text view is measured', () => {
  const actual = measurements(); cases[3].corrupt(actual);
  const config = rule('text-clipping', { allowTruncation: true, fullTextSelector: '#full' });
  assert.equal(assess(actual, [config]).status, 'passed');
  actual.elements[3].visible = false;
  assert.equal(assess(actual, [config]).findings[0].code, 'full_text_unavailable');
  actual.elements[3].visible = true; actual.elements[3].text = 'Save';
  assert.equal(assess(actual, [config]).findings[0].code, 'full_text_unavailable');
  delete actual.elements[3].textMetrics;
  assert.equal(assess(actual, [config]).findings[0].status, 'gap');
});

test('legitimately disabled and hidden states are not always product failures', () => {
  const actual = measurements(); actual.elements[0].state = { visible: false, enabled: false };
  const result = assessVisualSnapshot(actual, { ...constraints([rule('state', { expect: { visible: false, enabled: false } })]), required: [] });
  assert.equal(result.status, 'passed');
});

test('ancestor clipping and unsupported rule parameters remain observable', () => {
  const actual = measurements();
  actual.elements[0].textMetrics.clippingRects.push({ rect: { x: 24, y: 200, width: 30, height: 44 }, clipsX: true, clipsY: false });
  assert.equal(assess(actual, [cases[3].config]).findings[0].code, 'text_clipped');
  assert.equal(assess(measurements(), [rule('spacing', { otherSelector: '#peer', axis: 'diagonal', min: 1 })]).findings[0].status, 'gap');
});

// This isolates the CDP/browser boundary; real browser acceptance is separate.
function browserFixture({ axe, selectorError = false, restoreError = false } = {}) {
  const data = measurements();
  const styles = new Map();
  const elements = data.elements.map(item => {
    const node = { ...item, tagName: item.selector === '#save' ? 'BUTTON' : 'DIV', disabled: false, hidden: false, parentElement: null, children: [], scrollTop: 0, scrollLeft: 0,
      clientLeft: 0, clientTop: 0, clientWidth: item.rect.width, clientHeight: item.rect.height,
      scrollWidth: item.rect.width, scrollHeight: item.rect.height, textContent: item.text ?? '',
      getBoundingClientRect() { const measured = { ...this.rect }; return { ...measured, toJSON: () => measured }; },
      getClientRects() { return [this.getBoundingClientRect()]; },
      checkVisibility() { return true; },
      getAttribute(name) { return name === 'aria-expanded' ? 'false' : name === 'aria-disabled' ? 'false' : null; },
      contains(other) { for (let node = other; node; node = node.parentElement) if (node === this) return true; return false; },
      scrollIntoView() { this.rect.y = 200; this.parentElement.scrollTop = 400; },
      scrollTo(left, top) { if (!restoreError) { this.scrollLeft = typeof left === 'object' ? left.left : left; this.scrollTop = typeof left === 'object' ? left.top : top; } }
    };
    styles.set(node, { display: 'block', visibility: 'visible', opacity: '1', fontSize: '17px',
      overflowX: 'visible', overflowY: 'visible', webkitLineClamp: 'none', scrollBehavior: 'auto' });
    return node;
  });
  elements[0].parentElement = elements[1];
  styles.get(elements[1]).overflowY = 'auto';
  elements[1].scrollHeight = 600;
  const document = {
    documentElement: { scrollWidth: 360, scrollHeight: 900 }, body: { scrollWidth: 360, scrollHeight: 900 }, readyState: 'complete',
    querySelector(selector) { if (selectorError && selector === '#peer') throw new Error('Invalid selector'); return elements.find(item => item.selector === selector) ?? null; },
    querySelectorAll(selector) { return selector === '*' ? elements : []; },
    elementFromPoint(x, y) { return elements.find(item => x >= item.rect.x && x <= item.rect.x + item.rect.width && y >= item.rect.y && y <= item.rect.y + item.rect.height) ?? null; },
    createTreeWalker(el) { let next = true; return { nextNode() { if (!next || !el.textContent) return null; next = false; return { textContent: el.textContent, parentElement: el }; } }; },
    createRange() { let el; return { selectNodeContents(node) { el = node.parentElement; },
      getClientRects() { return [{ x: el.rect.x + 1, y: el.rect.y + 10, width: Math.min(el.rect.width - 2, 105), height: 20 }]; }, detach() {} }; }
  };
  const context = vm.createContext({ document, location: { href: 'http://localhost/isolated' }, innerWidth: 360, innerHeight: 900,
    devicePixelRatio: 1, scrollX: 0, scrollY: 0, scrollTo() {}, getComputedStyle: el => styles.get(el),
    NodeFilter: { SHOW_TEXT: 4 }, requestAnimationFrame: callback => callback(), setTimeout, clearTimeout, axe });
  context.window = context;
  const cdp = { async send(method, options) {
    assert.equal(method, 'Runtime.evaluate');
    try { return { result: { value: await vm.runInContext(options.expression, context) } }; }
    catch (error) { return { exceptionDetails: { text: error.message } }; }
  } };
  return { cdp, elements, document, styles };
}

test('CDP collector measures declared relation selectors and rendered text metrics', async () => {
  const { cdp } = browserFixture();
  const actual = await collectVisualSnapshot(cdp, constraints([cases[0].config, cases[1].config, cases[3].config]));
  assert.ok(actual.elements.some(item => item.selector === '#container'));
  assert.equal(actual.elements.find(item => item.selector === '#save').textMetrics.rects.length, 1);
  assert.equal(assess(actual, [cases[0].config, cases[1].config, cases[3].config]).status, 'passed');
});

test('CDP collector records an actual scroll and restores its container position', async () => {
  const { cdp, elements } = browserFixture(); elements[0].rect.y = 600;
  const actual = await collectVisualSnapshot(cdp, { ...constraints([cases[4].config]), required: [] });
  assert.equal(actual.scrollChecks?.[0]?.before?.targetRect?.y, 600);
  assert.equal(actual.scrollChecks?.[0]?.after?.targetRect?.y, 200);
  assert.equal(actual.scrollChecks?.[0]?.after?.scrollTop, 400);
  assert.equal(elements[1].scrollTop, 0);
  assert.equal(actual.scrollChecks[0].restored, true);
  assert.equal(assessVisualSnapshot(actual, { ...constraints([cases[4].config]), required: [] }).status, 'passed');
});

test('CDP axe integration uses tool rules and retains incomplete raw results', async () => {
  const raw = measurements().accessibility.results;
  raw.incomplete = [{ id: 'button-name', nodes: [{ target: ['#save'], any: [], all: [], none: [] }] }];
  const { cdp } = browserFixture({ axe: { async run(context, options) {
    assert.equal(context.readyState, 'complete');
    assert.deepEqual(Array.from(options.runOnly.values), ['button-name']);
    return raw;
  } } });
  const actual = await collectVisualSnapshot(cdp, constraints([cases[7].config]));
  assert.equal(actual.accessibilityChecks?.[0]?.results?.incomplete?.length, 1);
  assert.equal(assess(actual, [cases[7].config]).status, 'review');
});

test('CDP collector retains invalid selectors, failed restoration and absent tools as gaps', async () => {
  const selector = browserFixture({ selectorError: true });
  const invalid = await collectVisualSnapshot(selector.cdp, constraints([cases[1].config]));
  assert.equal(assess(invalid, [cases[1].config]).findings[0].status, 'gap');
  const scroll = browserFixture({ restoreError: true }); scroll.elements[0].rect.y = 600;
  const unrestored = await collectVisualSnapshot(scroll.cdp, { ...constraints([cases[4].config]), required: [] });
  assert.equal(unrestored.scrollChecks?.[0]?.restored, false);
  assert.notEqual(assess(unrestored, [cases[4].config]).status, 'passed');
  const noTool = await collectVisualSnapshot(browserFixture().cdp, constraints([cases[7].config]));
  assert.equal(assess(noTool, [cases[7].config]).findings[0].status, 'gap');
});

test('scrolling to geometry does not make a hidden target reachable', () => {
  const actual = measurements(); actual.scrollChecks[0].after.visible = false;
  assert.equal(assess(actual, [cases[4].config]).findings[0].code, 'scroll_target_unreachable');
});

test('nonempty text with no rendered ranges is missing evidence', () => {
  const noTextRanges = measurements(); noTextRanges.elements[0].textMetrics.rects = [];
  assert.equal(assess(noTextRanges, [cases[3].config]).findings[0].status, 'gap');
});

test('axe passes with no measured nodes is missing evidence', () => {
  const noNodes = measurements(); noNodes.accessibility.results.passes[0].nodes = [];
  assert.equal(assess(noNodes, [cases[7].config]).findings[0].status, 'gap');
});

test('missing element observations differ from a measured missing element', () => {
  const actual = measurements(); actual.elements = actual.elements.filter(item => item.selector !== '#save');
  assert.equal(assess(actual, [cases[5].config]).findings[0].status, 'gap');
  actual.elements.push({ selector: '#save', found: false });
  assert.equal(assess(actual, [cases[5].config]).findings[0].code, 'missing_element');
});

test('a scoped axe response cannot satisfy a whole-document declaration', () => {
  const actual = measurements(); actual.accessibility.scope = '#save';
  assert.equal(assess(actual, [cases[7].config]).findings[0].status, 'gap');
});

test('web measurements cannot claim native platform coverage', () => {
  const actual = measurements(); actual.platform = 'web';
  assert.equal(assess(actual, [{ ...cases[0].config, platform: 'windows-desktop' }]).findings[0].code, 'unsupported_runtime_platform');
});

test('a declared web platform rejects an observation platform mismatch', () => {
  const actual = measurements(); actual.platform = 'android';
  assert.equal(assess(actual, [{ ...cases[0].config, platform: 'web' }]).findings[0].code, 'runtime_platform_mismatch');
});

test('an empty new rules list retains only legacy scope', () => {
  assert.equal(assess(measurements(), []).coverage.mode, 'legacy');
});

test('partial hit conflicts retain review evidence instead of claiming complete obstruction', () => {
  const actual = measurements();
  actual.elements[0].hitTests = [true, true, true, false, false];
  actual.elements[0].hitTestDetails = { method: 'bounding-rect-five-point', points: [
    { x: 46, y: 235.2, hit: false, target: { tagName: 'H1', id: 'title', rect: { x: 24, y: 234, width: 300, height: 32 } } }
  ] };
  const result = assess(actual, [rule('hit-target')]);
  assert.equal(result.status, 'review');
  assert.equal(result.findings[0].status, 'review');
  assert.equal(result.findings[0].code, 'control_partially_obstructed');
  assert.deepEqual(result.findings[0].actual.hitTests, [true, true, true, false, false]);
  assert.deepEqual(result.findings[0].actual.hitTestDetails, actual.elements[0].hitTestDetails);
});

test('a complete hit obstruction still fails and unknown hit observations are gaps', () => {
  const actual = measurements(); actual.elements[0].hitTests = [false, false, false, false, false];
  assert.equal(assess(actual, [rule('hit-target')]).findings[0].code, 'control_obstructed');
  assert.equal(assess(actual, [rule('hit-target')]).status, 'failed');
  for (const hitTests of [undefined, [true, true, null, true, true], [true, true, true, true]]) {
    actual.elements[0].hitTests = hitTests;
    assert.equal(assess(actual, [rule('hit-target')]).findings[0].status, 'gap');
  }
});

test('a hidden target cannot be accepted through partially successful hit tests', () => {
  const actual = measurements(); actual.elements[0].visible = false;
  actual.elements[0].hitTests = [true, true, true, false, false];
  const result = assess(actual, [rule('hit-target')]);
  assert.equal(result.status, 'failed');
  assert.equal(result.findings[0].status, 'failed');
});

test('native nonvisibility overrides nonzero layout boxes', async () => {
  const fixture = browserFixture(); fixture.elements[0].checkVisibility = () => false;
  const config = { ...constraints([rule('state', { expect: { visible: false } })]), required: [] };
  const actual = await collectVisualSnapshot(fixture.cdp, config);
  assert.equal(actual.elements[0].rect.width, 110);
  assert.equal(actual.elements[0].visible, false);
  assert.equal(assessVisualSnapshot(actual, config).status, 'passed');
});

test('closed details content is hidden while the first summary and its children remain visible', async () => {
  for (const child of ['content', 'summary', 'summary-child', 'later-summary']) {
    const fixture = browserFixture();
    const [target, details, summary, descendant] = fixture.elements;
    details.tagName = 'DETAILS'; details.open = false;
    summary.tagName = 'SUMMARY'; summary.parentElement = details;
    details.children = [summary, target];
    let selector = '#save', expected = false;
    if (child === 'summary') { selector = '#peer'; expected = true; }
    if (child === 'summary-child') { selector = '#full'; descendant.parentElement = summary; expected = true; }
    if (child === 'later-summary') { target.tagName = 'SUMMARY'; }
    const config = { ...constraints([rule('state', { selector, expect: { visible: expected } })]), required: [] };
    const actual = await collectVisualSnapshot(fixture.cdp, config);
    assert.equal(actual.elements.find(item => item.selector === selector).visible, expected, child);
    assert.equal(assessVisualSnapshot(actual, config).status, 'passed', child);
  }
});

test('an open inner details cannot expose content hidden by a closed outer details', async () => {
  const fixture = browserFixture();
  const [target, inner, outer] = fixture.elements;
  inner.tagName = outer.tagName = 'DETAILS'; inner.open = true; outer.open = false;
  inner.parentElement = outer; inner.children = [target]; outer.children = [inner];
  const config = { ...constraints([rule('state', { expect: { visible: false } })]), required: [] };
  const actual = await collectVisualSnapshot(fixture.cdp, config);
  assert.equal(actual.elements[0].visible, false);
  assert.equal(assessVisualSnapshot(actual, config).status, 'passed');
});

test('unavailable or faulty native visibility remains unknown rather than passed', async () => {
  for (const native of [undefined, () => { throw new Error('unsupported visibility'); }, () => undefined]) {
    const fixture = browserFixture(); fixture.elements[0].checkVisibility = native;
    const config = { ...constraints([rule('state', { expect: { visible: true } })]), required: [] };
    const actual = await collectVisualSnapshot(fixture.cdp, config);
    assert.equal(actual.elements[0].found, true);
    assert.equal(actual.elements[0].visible, null);
    assert.equal(actual.elements[0].visibilityMeasurement.status, 'unknown');
    assert.equal(assessVisualSnapshot(actual, config).status, 'blocked');
  }
});

test('collector retains partial hit coordinates and hit objects without changing the five-point contract', async () => {
  const fixture = browserFixture();
  const [target, , heading] = fixture.elements; heading.tagName = 'H1'; heading.id = 'heading';
  fixture.document.elementFromPoint = (x, y) => y >= 234 ? heading : target;
  const actual = await collectVisualSnapshot(fixture.cdp, constraints([rule('hit-target')]));
  const item = actual.elements.find(item => item.selector === '#save');
  assert.deepEqual(Array.from(item.hitTests), [true, true, true, false, false]);
  assert.ok(item.hitTestDetails, 'hit coordinates and hit objects must be retained');
  assert.equal(item.hitTestDetails.points[3].x, 46);
  assert.equal(item.hitTestDetails.points[3].y, 235.2);
  assert.equal(item.hitTestDetails.points[3].target.tagName, 'H1');
  assert.equal(item.hitTestDetails.points[3].target.id, 'heading');
  assert.equal(item.hitTestDetails.targetRects.length, 1);
  assert.equal(assess(actual, [rule('hit-target')]).status, 'review');
});

test('collector still rejects an actual full overlay and missing hit capabilities remain gaps', async () => {
  const fixture = browserFixture(); const overlay = fixture.elements[2]; overlay.tagName = 'DIV'; overlay.id = 'overlay';
  fixture.document.elementFromPoint = () => overlay;
  const actual = await collectVisualSnapshot(fixture.cdp, constraints([rule('hit-target')]));
  assert.equal(assess(actual, [rule('hit-target')]).status, 'failed');
  assert.ok(actual.elements[0].hitTestDetails, 'an overlay must be identified in raw hit evidence');
  assert.equal(actual.elements[0].hitTestDetails.points[0].target.id, 'overlay');
  fixture.document.elementFromPoint = undefined;
  const missing = await collectVisualSnapshot(fixture.cdp, constraints([rule('hit-target')]));
  assert.equal(missing.elements[0].found, true);
  assert.equal(assess(missing, [rule('hit-target')]).findings[0].status, 'gap');
});

test('scroll reachability distinguishes partial hit conflicts from complete obstruction', () => {
  const actual = measurements(); const after = actual.scrollChecks[0].after;
  after.hitTests = [true, true, true, false, false];
  after.hitTestDetails = { points: [{ x: 46, y: 235.2, hit: false, target: { tagName: 'H1', id: 'heading' } }] };
  let result = assess(actual, [cases[4].config]);
  assert.equal(result.status, 'review');
  assert.equal(result.findings[0].code, 'scroll_target_partially_obstructed');
  assert.deepEqual(result.findings[0].actual.after.hitTestDetails, after.hitTestDetails);
  after.hitTests = [false, false, false, false, false];
  result = assess(actual, [cases[4].config]);
  assert.equal(result.status, 'failed');
  assert.equal(result.findings[0].code, 'scroll_target_unreachable');
});

test('closed details can be measured hidden even without native visibility, and opening reveals it', async () => {
  const fixture = browserFixture(); const [target, details, summary] = fixture.elements;
  details.tagName = 'DETAILS'; details.open = false;
  summary.tagName = 'SUMMARY'; summary.parentElement = details;
  details.children = [summary, target]; target.checkVisibility = undefined;
  const hiddenConfig = { ...constraints([rule('state', { expect: { visible: false } })]), required: [] };
  const hidden = await collectVisualSnapshot(fixture.cdp, hiddenConfig);
  assert.equal(hidden.elements[0].visible, false);
  assert.equal(hidden.elements[0].visibilityMeasurement.reason, 'closed_details');
  assert.equal(assessVisualSnapshot(hidden, hiddenConfig).status, 'passed');
  details.open = true; target.checkVisibility = () => true;
  const openConfig = { ...constraints([rule('state', { expect: { visible: true } })]), required: [] };
  const open = await collectVisualSnapshot(fixture.cdp, openConfig);
  assert.equal(open.elements[0].visible, true);
  assert.equal(assessVisualSnapshot(open, openConfig).status, 'passed');
});

test('a missing native visibility method prevents hit and scroll acceptance', async () => {
  const fixture = browserFixture(); fixture.elements[0].checkVisibility = undefined;
  const config = { ...constraints([rule('hit-target'), cases[4].config]), required: [] };
  const actual = await collectVisualSnapshot(fixture.cdp, config);
  const result = assessVisualSnapshot(actual, config);
  assert.equal(result.status, 'blocked');
  assert.deepEqual(result.findings.map(item => item.status), ['gap', 'gap']);
});
