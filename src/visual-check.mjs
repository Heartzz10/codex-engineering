import assert from 'node:assert/strict';
import { assessHitReachability, assessUiRuntimeSnapshot, collectUiRuntimeSnapshot } from './ui-runtime-check.mjs';

function validate(constraints) {
  assert(typeof constraints?.goal === 'string' && constraints.goal &&
    Number.isInteger(constraints.viewport?.width) && constraints.viewport.width > 0 &&
    Number.isInteger(constraints.viewport?.height) && constraints.viewport.height > 0,
  'visual goal and viewport are required');
  assert(Array.isArray(constraints.required) && (constraints.required.length > 0 || (Array.isArray(constraints.rules) && constraints.rules.length > 0)) &&
    constraints.required.every(item => typeof item.selector === 'string' && item.selector), 'required selectors are required');
}

// Pure reduction: the browser supplies geometry and hit tests, never a self-reported pass.
export function assessVisualSnapshot(snapshot, constraints) {
  validate(constraints);
  const issues = [], add = (code, selector, detail, status) => issues.push({ code, selector, detail, ...(status ? { status } : {}) });
  const tolerance = constraints.tolerance ?? 1;
  const viewport = snapshot?.viewport;
  if (viewport?.width !== constraints.viewport.width || viewport?.height !== constraints.viewport.height)
    add('viewport_mismatch', null, { expected: constraints.viewport, actual: viewport });
  if (!Number.isFinite(snapshot?.document?.scrollWidth)) add('missing_layout_measurement', null);
  else if (snapshot.document.scrollWidth > constraints.viewport.width + tolerance)
    add('horizontal_overflow', null, { scrollWidth: snapshot.document.scrollWidth, width: constraints.viewport.width });
  for (const rule of constraints.required) {
    const item = snapshot?.elements?.find(element => element.selector === rule.selector);
    if (!item?.found) { add('missing_element', rule.selector); continue; }
    const r = item.rect;
    if (typeof item.visible !== 'boolean') add('missing_visibility_measurement', rule.selector, item.visibilityMeasurement, 'gap');
    else if (!item.visible || !r || ![r.x, r.y, r.width, r.height].every(Number.isFinite) || r.width <= 0 || r.height <= 0)
      add('element_not_visible', rule.selector);
    else if (rule.inViewport && (r.x < -tolerance || r.y < -tolerance || r.x + r.width > constraints.viewport.width + tolerance || r.y + r.height > constraints.viewport.height + tolerance))
      add('outside_viewport', rule.selector, r);
    if (!Number.isFinite(item.fontSize) || item.fontSize < (rule.minFontSize ?? 14)) add('text_too_small', rule.selector, item.fontSize);
    if (rule.interactive) {
      if (!item.enabled) add('control_disabled', rule.selector);
      const reachability = assessHitReachability(item);
      if (reachability.status !== 'passed') add(reachability.code, rule.selector, reachability.actual, reachability.status);
    }
  }
  const runtime = assessUiRuntimeSnapshot(snapshot, constraints);
  for (const item of runtime.findings.filter(item => item.status !== 'passed'))
    issues.push({ code: item.code, selector: item.selector, ruleId: item.ruleId, status: item.status, detail: item.actual });
  const status = issues.some(item => !item.status || item.status === 'failed') ? 'failed'
    : issues.some(item => item.status === 'gap') ? 'blocked' : issues.some(item => item.status === 'review') ? 'review' : runtime.status;
  return { ...runtime, status, goal: constraints.goal, viewport: constraints.viewport, issues,
    limits: 'Checks measured layout, readable font size and five-point input reachability; screenshots require human review for visual style. Business behavior is verified separately.' };
}

export async function collectVisualSnapshot(cdp, constraints, options = {}) {
  validate(constraints);
  return collectUiRuntimeSnapshot(cdp, constraints, options);
}
