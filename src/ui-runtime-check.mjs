import assert from 'node:assert/strict';

// Reduces observed browser data; neither a screenshot nor a producer's `pass` is evidence.
const TYPES = new Set(['containment', 'spacing', 'alignment', 'text-clipping', 'scroll-reachability', 'state', 'hit-target', 'axe']);
const STATES = new Set(['visible', 'enabled', 'expanded', 'selected', 'busy', 'checked']);
const finite = Number.isFinite;
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const validRect = rect => rect && ['x', 'y', 'width', 'height'].every(key => finite(rect[key])) && rect.width > 0 && rect.height > 0;
const within = (target, container, tolerance, axis = 'both') =>
  (axis === 'vertical' || (target.x >= container.x - tolerance && target.x + target.width <= container.x + container.width + tolerance)) &&
  (axis === 'horizontal' || (target.y >= container.y - tolerance && target.y + target.height <= container.y + container.height + tolerance));
const validHits = hits => Array.isArray(hits) && hits.length === 5 && hits.every(hit => typeof hit === 'boolean');
const sourceRef = rule => typeof (rule?.sourceRef ?? rule?.source) === 'object'
  ? (rule.sourceRef ?? rule.source)?.ref : (rule?.sourceRef ?? rule?.source);
const normalizedText = text => text.replace(/\s+/g, ' ').trim();

// Also used by the legacy required-controls reducer, so it cannot override a
// partial conflict with a claim that the whole control is obstructed.
export function assessHitReachability(item) {
  const actual = { rect: item?.rect, visible: item?.visible, hitTests: item?.hitTests,
    hitTestDetails: item?.hitTestDetails, visibilityMeasurement: item?.visibilityMeasurement };
  if (typeof item?.visible !== 'boolean') return { status: 'gap', code: 'missing_visibility_measurement', actual };
  if (!validHits(item?.hitTests)) return { status: 'gap', code: 'missing_hit_measurement', actual };
  const hitCount = item.hitTests.filter(Boolean).length;
  actual.hitCount = hitCount; actual.testedPoints = item.hitTests.length;
  if (!item.visible || hitCount === 0) return { status: 'failed', code: 'control_obstructed', actual };
  if (hitCount < item.hitTests.length) return { status: 'review', code: 'control_partially_obstructed', actual };
  return { status: 'passed', code: 'target_reachable', actual };
}

function textMeasurement(item, tolerance) {
  const metrics = item?.textMetrics;
  if (typeof item?.text !== 'string' || !metrics ||
      !['clientWidth', 'clientHeight', 'scrollWidth', 'scrollHeight'].every(key => finite(metrics[key]) && metrics[key] >= 0) ||
      !nonempty(metrics.overflowX) || !nonempty(metrics.overflowY) || typeof metrics.lineClamp !== 'string' ||
      !Array.isArray(metrics.rects) || (item.text.trim().length > 0 && metrics.rects.length === 0) || metrics.rects.some(rect => !validRect(rect)) ||
      !Array.isArray(metrics.clippingRects) || metrics.clippingRects.some(clip =>
        !validRect(clip.rect) || typeof clip.clipsX !== 'boolean' || typeof clip.clipsY !== 'boolean')) return null;
  const clips = value => ['hidden', 'clip'].includes(value);
  const clamped = metrics.lineClamp !== 'none' && Number(metrics.lineClamp) > 0;
  const clipped = (metrics.scrollWidth > metrics.clientWidth + tolerance && clips(metrics.overflowX)) ||
    (metrics.scrollHeight > metrics.clientHeight + tolerance && (clips(metrics.overflowY) || clamped)) ||
    metrics.clippingRects.some(clip => metrics.rects.some(rect =>
      !within(rect, clip.rect, tolerance, clip.clipsX && clip.clipsY ? 'both' : clip.clipsX ? 'horizontal' : 'vertical') && (clip.clipsX || clip.clipsY)));
  return { clipped, metrics };
}

function invalidRule(rule) {
  if (!rule || !nonempty(rule.id) || !/^Q(0[1-9]|1[0-8])$/.test(rule.categoryId) || !nonempty(sourceRef(rule))) return 'invalid_rule_contract';
  if (rule.platform !== undefined && rule.platform !== 'web') return 'unsupported_runtime_platform';
  if (!TYPES.has(rule.type)) return 'unsupported_runtime_rule';
  if (rule.type !== 'axe' && !nonempty(rule.selector)) return 'invalid_rule_selector';
  if (rule.selector !== undefined && !nonempty(rule.selector)) return 'invalid_rule_selector';
  if (rule.tolerance !== undefined && (!finite(rule.tolerance) || rule.tolerance < 0)) return 'invalid_rule_tolerance';
  switch (rule.type) {
    case 'containment': if (!nonempty(rule.containerSelector)) return 'invalid_rule_parameters'; break;
    case 'spacing':
      if (!nonempty(rule.otherSelector) || !['horizontal', 'vertical'].includes(rule.axis) ||
          (!finite(rule.min) && !finite(rule.max)) || (rule.min !== undefined && !finite(rule.min)) ||
          (rule.max !== undefined && !finite(rule.max)) || (finite(rule.min) && finite(rule.max) && rule.min > rule.max)) return 'invalid_rule_parameters';
      break;
    case 'alignment': if (!nonempty(rule.otherSelector) || !['left', 'right', 'top', 'bottom', 'center-x', 'center-y'].includes(rule.edge)) return 'invalid_rule_parameters'; break;
    case 'text-clipping': if (typeof rule.allowTruncation !== 'boolean' || (rule.allowTruncation && !nonempty(rule.fullTextSelector))) return 'invalid_rule_parameters'; break;
    case 'scroll-reachability':
      if (!nonempty(rule.containerSelector) || !['both', 'horizontal', 'vertical'].includes(rule.axis ?? 'both') ||
          (rule.interactive !== undefined && typeof rule.interactive !== 'boolean')) return 'invalid_rule_parameters';
      break;
    case 'state':
      if (!rule.expect || typeof rule.expect !== 'object' || !Object.keys(rule.expect).length ||
          Object.entries(rule.expect).some(([key, value]) => !STATES.has(key) || typeof value !== 'boolean')) return 'invalid_rule_parameters';
      break;
    case 'hit-target':
      if (['minWidth', 'minHeight'].some(key => rule[key] !== undefined && (!finite(rule[key]) || rule[key] <= 0)) ||
          (rule.inViewport !== undefined && typeof rule.inViewport !== 'boolean')) return 'invalid_rule_parameters';
      break;
    case 'axe': if (rule.ruleIds !== undefined && (!Array.isArray(rule.ruleIds) || !rule.ruleIds.length || rule.ruleIds.some(id => !nonempty(id)))) return 'invalid_rule_parameters'; break;
  }
  return null;
}

function assessRule(snapshot, rule) {
  const base = { ruleId: rule?.id ?? null, type: rule?.type ?? null, categoryId: rule?.categoryId ?? null,
    selector: rule?.selector ?? null, source: rule?.source ?? rule?.sourceRef, sourceRef: sourceRef(rule), method: 'measurement' };
  for (const key of ['featureId', 'acId', 'entrypointId', 'targetId', 'state', 'platform', 'evidenceRef', 'sourceVersion', 'ruleVersion', 'environmentRef', 'requirementVersion'])
    if (rule?.[key] !== undefined) base[key] = rule[key];
  const finding = (status, code, actual, expected) => ({ ...base, status, code, actual, expected });
  const invalid = invalidRule(rule);
  if (invalid) return finding('gap', invalid);
  if (snapshot?.platform !== undefined && snapshot.platform !== (rule.platform ?? 'web'))
    return finding('gap', 'runtime_platform_mismatch', snapshot.platform, rule.platform ?? 'web');
  const tolerance = rule.tolerance ?? 1;
  const element = selector => snapshot?.elements?.find(item => item.selector === selector);
  const item = element(rule.selector);
  if (rule.type !== 'axe') {
    if (item?.error) return finding('gap', 'measurement_error', item.error);
    if (!item || typeof item.found !== 'boolean') return finding('gap', 'missing_element_measurement');
    if (!item.found) return finding('failed', 'missing_element', { found: false }, { found: true });
  }
  const needsRect = ['containment', 'spacing', 'alignment', 'hit-target'].includes(rule.type);
  if (needsRect && !validRect(item?.rect)) return finding('gap', 'missing_geometry_measurement');
  const r = item?.rect;
  switch (rule.type) {
    case 'containment': {
      const container = element(rule.containerSelector);
      if (!validRect(container?.rect)) return finding('gap', 'missing_geometry_measurement', { containerSelector: rule.containerSelector });
      const fits = within(r, container.rect, tolerance);
      return finding(fits ? 'passed' : 'failed', fits ? 'contained' : 'outside_container',
        { targetRect: r, containerRect: container.rect }, { relationship: 'inside', tolerance });
    }
    case 'spacing': {
      const other = element(rule.otherSelector);
      if (!validRect(other?.rect)) return finding('gap', 'missing_geometry_measurement', { otherSelector: rule.otherSelector });
      const gap = rule.axis === 'horizontal' ? other.rect.x - r.x - r.width : other.rect.y - r.y - r.height;
      const fits = (!finite(rule.min) || gap >= rule.min - tolerance) && (!finite(rule.max) || gap <= rule.max + tolerance);
      return finding(fits ? 'passed' : 'failed', fits ? 'spacing_matches' : 'spacing_out_of_range', gap, { min: rule.min, max: rule.max, axis: rule.axis, tolerance });
    }
    case 'alignment': {
      const other = element(rule.otherSelector);
      if (!validRect(other?.rect)) return finding('gap', 'missing_geometry_measurement', { otherSelector: rule.otherSelector });
      const edges = rect => ({ left: rect.x, right: rect.x + rect.width, top: rect.y, bottom: rect.y + rect.height,
        'center-x': rect.x + rect.width / 2, 'center-y': rect.y + rect.height / 2 });
      const distance = Math.abs(edges(r)[rule.edge] - edges(other.rect)[rule.edge]);
      const fits = distance <= tolerance;
      return finding(fits ? 'passed' : 'failed', fits ? 'alignment_matches' : 'alignment_mismatch', distance, { edge: rule.edge, tolerance });
    }
    case 'text-clipping': {
      const measured = textMeasurement(item, tolerance);
      if (!measured) return finding('gap', 'missing_text_measurement');
      if (!measured.clipped) return finding('passed', 'text_unclipped', measured.metrics, { allowTruncation: rule.allowTruncation });
      if (!rule.allowTruncation) return finding('failed', 'text_clipped', measured.metrics, { allowTruncation: false });
      const full = element(rule.fullTextSelector);
      const fullMeasured = textMeasurement(full, tolerance);
      if (full?.found && !fullMeasured) return finding('gap', 'missing_full_text_measurement');
      const available = full?.found && full.visible === true && !fullMeasured?.clipped &&
        typeof full.text === 'string' && normalizedText(full.text) === normalizedText(item.text);
      return finding(available ? 'passed' : 'failed', available ? 'full_text_available' : 'full_text_unavailable',
        { textMetrics: measured.metrics, fullTextSelector: rule.fullTextSelector, fullText: full?.text, fullTextVisible: full?.visible },
        { allowTruncation: true, fullText: item.text, fullTextVisible: true });
    }
    case 'scroll-reachability': {
      const check = snapshot?.scrollChecks?.find(entry => entry.ruleId === rule.id);
      if (!check || check.error || check.selector !== rule.selector || check.containerSelector !== rule.containerSelector ||
          check.operation !== 'scrollIntoView' || check.containerContains !== true || check.restored !== true ||
          !validRect(check.before?.targetRect) || !validRect(check.before?.containerRect) || !validRect(check.after?.targetRect) || !validRect(check.after?.containerRect) ||
          !['scrollTop', 'scrollLeft'].every(key => finite(check.before[key]) && finite(check.after[key])) ||
          typeof check.after.visible !== 'boolean' || !nonempty(check.overflowX) || !nonempty(check.overflowY) || !Array.isArray(check.after.clippingRects) || check.after.clippingRects.some(clip => !validRect(clip)))
        return finding('gap', 'missing_scroll_measurement', check);
      if (rule.interactive && !validHits(check.after.hitTests)) return finding('gap', 'missing_hit_measurement');
      const fits = check.after.visible && within(check.after.targetRect, check.after.containerRect, tolerance, rule.axis ?? 'both') &&
        check.after.clippingRects.every(clip => within(check.after.targetRect, clip, tolerance, rule.axis ?? 'both'));
      const reachability = rule.interactive ? assessHitReachability({ ...check.after, rect: check.after.targetRect }) : { status: 'passed' };
      const status = fits ? reachability.status : 'failed';
      return finding(status, status === 'passed' ? 'scroll_target_reachable' : status === 'review' ? 'scroll_target_partially_obstructed' : 'scroll_target_unreachable', check,
        { reachableAfterScroll: true, axis: rule.axis ?? 'both', interactive: rule.interactive ?? false });
    }
    case 'state': {
      if (!item.state || Object.keys(rule.expect).some(key => typeof item.state[key] !== 'boolean')) return finding('gap', 'missing_state_measurement');
      const matches = Object.entries(rule.expect).every(([key, value]) => item.state[key] === value);
      return finding(matches ? 'passed' : 'failed', matches ? 'state_matches' : 'state_mismatch', item.state, rule.expect);
    }
    case 'hit-target': {
      const reachability = assessHitReachability(item);
      if (reachability.status === 'gap') return finding(reachability.status, reachability.code, reachability.actual);
      if ((finite(rule.minWidth) && r.width < rule.minWidth - tolerance) || (finite(rule.minHeight) && r.height < rule.minHeight - tolerance))
        return finding('failed', 'target_too_small', { width: r.width, height: r.height }, { minWidth: rule.minWidth, minHeight: rule.minHeight, tolerance });
      if (rule.inViewport && (!finite(snapshot?.viewport?.width) || !finite(snapshot?.viewport?.height))) return finding('gap', 'missing_viewport_measurement');
      const outsideViewport = rule.inViewport && !within(r, { x: 0, y: 0, ...snapshot.viewport }, tolerance);
      return finding(outsideViewport ? 'failed' : reachability.status, outsideViewport ? 'control_obstructed' : reachability.code,
        reachability.actual, { reachable: true, inViewport: rule.inViewport ?? false });
    }
    case 'axe': {
      const audit = snapshot?.accessibilityChecks?.find(entry => entry.ruleId === rule.id) ?? snapshot?.accessibility;
      const result = audit?.results, scope = rule.selector ?? 'document';
      const arrays = ['violations', 'passes', 'incomplete', 'inapplicable'];
      if (!audit || audit.error || audit.tool !== 'axe-core' || audit.scope !== scope || result?.testEngine?.name !== 'axe-core' ||
          !nonempty(result?.testEngine?.version) || arrays.some(key => !Array.isArray(result?.[key]) ||
            result[key].some(entry => !nonempty(entry.id) || !Array.isArray(entry.nodes)))) return finding('gap', 'missing_accessibility_measurement', audit);
      const relevant = key => result[key].filter(entry => !rule.ruleIds || rule.ruleIds.includes(entry.id));
      const records = arrays.flatMap(relevant);
      if (!records.length || rule.ruleIds?.some(id => !records.some(entry => entry.id === id))) return finding('gap', 'untested_accessibility_rule', result);
      if (relevant('violations').length) return finding('failed', 'accessibility_violation', result, { violations: [] });
      if (relevant('incomplete').length) return finding('review', 'accessibility_incomplete', result, { incomplete: [] });
      if (!relevant('passes').length) return finding('review', 'accessibility_not_applicable', result, { applicableMeasuredRules: true });
      if (relevant('passes').some(entry => entry.nodes.length === 0 || entry.nodes.some(node => !Array.isArray(node.target) || !node.target.length ||
        ['any', 'all', 'none'].some(key => !Array.isArray(node[key]))))) return finding('gap', 'missing_accessibility_node_measurement', result);
      return finding('passed', 'accessibility_measured', result, { violations: [], incomplete: [] });
    }
  }
}

export function assessUiRuntimeSnapshot(snapshot, constraints) {
  const rules = constraints?.rules;
  const findings = rules === undefined ? [] : !Array.isArray(rules) ? [{ status: 'gap', code: 'invalid_rules_contract', method: 'measurement' }]
    : rules.map(rule => {
      if (rule?.id && rules.filter(entry => entry?.id === rule.id).length > 1)
        return { ruleId: rule.id, categoryId: rule.categoryId, status: 'gap', code: 'duplicate_rule_id', method: 'measurement' };
      return assessRule(snapshot, rule);
    });
  return { status: findings.some(item => item.status === 'failed') ? 'failed' : findings.some(item => item.status === 'gap') ? 'blocked'
    : findings.some(item => item.status === 'review') ? 'review' : 'passed', findings,
    coverage: { mode: rules === undefined || (Array.isArray(rules) && rules.length === 0) ? 'legacy' : 'declared-rules', ruleIds: findings.map(item => item.ruleId).filter(Boolean),
      categoryIds: [...new Set(findings.map(item => item.categoryId).filter(Boolean))], measuredStateOnly: true },
    businessAcceptance: 'not_verified', accessibility: snapshot?.accessibility, accessibilityChecks: snapshot?.accessibilityChecks };
}

// Serialized into the existing CDP Runtime.evaluate path. This measures the current
// top document; it does not activate hidden states or enter frames / closed shadow roots.
async function measureUiInBrowser(config) {
  const rules = Array.isArray(config.rules) ? config.rules.filter(Boolean) : [];
  const selectors = [...new Set([...(config.required ?? []).map(item => item.selector),
    ...rules.flatMap(rule => [rule.selector, rule.containerSelector, rule.otherSelector, rule.fullTextSelector])]
    .filter(selector => typeof selector === 'string' && selector.length))];
  const box = el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
  const clientBox = el => { const r = box(el); return { x: r.x + el.clientLeft, y: r.y + el.clientTop, width: el.clientWidth, height: el.clientHeight }; };
  const describe = el => el ? { tagName: el.tagName ?? null, id: el.id ?? '', role: el.getAttribute('role'),
    className: typeof el.className === 'string' ? el.className : el.getAttribute('class'),
    text: (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 120), rect: box(el) } : null;
  const visibility = el => {
    const measured = (value, method, reason, extra = {}) => ({ visible: value,
      measurement: { status: typeof value === 'boolean' ? 'measured' : 'unknown', method, reason, ...extra } });
    // A closed details can leave nonzero layout boxes for hidden descendants.
    // Only its first direct summary (and that summary's descendants) is exposed.
    for (let ancestor = el.parentElement; ancestor; ancestor = ancestor.parentElement) {
      if (ancestor.tagName === 'DETAILS' && !ancestor.open) {
        const summary = [...ancestor.children].find(child => child.tagName === 'SUMMARY');
        if (!summary || (summary !== el && !summary.contains(el)))
          return measured(false, 'details-state', 'closed_details', { ancestor: describe(ancestor) });
      }
    }
    for (let ancestor = el; ancestor; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor);
      if (style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity) === 0 || ancestor.hidden)
        return measured(false, 'computed-style', 'hidden_style', { ancestor: describe(ancestor) });
    }
    const r = box(el);
    if (!(r.width > 0 && r.height > 0)) return measured(false, 'bounding-rect', 'empty_rect');
    if (typeof el.checkVisibility !== 'function') return measured(null, 'checkVisibility', 'unsupported_native_visibility');
    try {
      const value = el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true, contentVisibilityAuto: true });
      return measured(typeof value === 'boolean' ? value : null, 'checkVisibility',
        typeof value !== 'boolean' ? 'invalid_native_visibility' : value ? 'native_visible' : 'native_hidden');
    } catch (error) { return measured(null, 'checkVisibility', 'native_visibility_error', { error: String(error.message ?? error) }); }
  };
  const hits = el => {
    const r = box(el);
    const details = { method: 'bounding-rect-five-point', targetRect: r, targetRects: null, points: [] };
    if (typeof el.getClientRects === 'function') details.targetRects = [...el.getClientRects()].map(rect =>
      ({ x: rect.x, y: rect.y, width: rect.width, height: rect.height }));
    try {
      if (typeof document.elementFromPoint !== 'function') throw new Error('elementFromPoint is unavailable');
      details.points = [[.5, .5], [.2, .2], [.8, .2], [.2, .8], [.8, .8]].map(([fractionX, fractionY]) => {
        const x = r.x + r.width * fractionX, y = r.y + r.height * fractionY;
        const target = document.elementFromPoint(x, y);
        const relationship = !target ? 'none' : target === el ? 'self' : el.contains(target) ? 'descendant' : 'other';
        return { x, y, hit: relationship === 'self' || relationship === 'descendant', relationship, target: describe(target) };
      });
      return { hitTests: details.points.map(point => point.hit), hitTestDetails: details };
    } catch (error) {
      details.error = String(error.message ?? error);
      return { hitTests: null, hitTestDetails: details };
    }
  };
  const clippingRects = (el, includeScroll = false) => {
    const rects = [];
    for (let ancestor = el; ancestor; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor), values = includeScroll ? ['hidden', 'clip', 'auto', 'scroll'] : ['hidden', 'clip'];
      const clipsX = values.includes(style.overflowX), clipsY = values.includes(style.overflowY);
      if (clipsX || clipsY) rects.push({ rect: clientBox(ancestor), clipsX, clipsY });
    }
    return rects;
  };
  const boolAttribute = (el, name, fallback = null) => {
    const value = el.getAttribute(name); return value === 'true' ? true : value === 'false' ? false : fallback;
  };
  const textMetrics = el => {
    const style = getComputedStyle(el), rects = [];
    // Native text fields and canvas need a platform-specific rendered-text measurement.
    if (['INPUT', 'TEXTAREA', 'SELECT', 'CANVAS'].includes(el.tagName)) return null;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.textContent.trim()) continue;
      const range = document.createRange(); range.selectNodeContents(node);
      for (const r of range.getClientRects()) if (r.width > 0 && r.height > 0) rects.push({ x: r.x, y: r.y, width: r.width, height: r.height });
      range.detach();
    }
    return { clientWidth: el.clientWidth, clientHeight: el.clientHeight, scrollWidth: el.scrollWidth, scrollHeight: el.scrollHeight,
      overflowX: style.overflowX, overflowY: style.overflowY, lineClamp: style.webkitLineClamp || 'none', rects, clippingRects: clippingRects(el) };
  };
  const elements = selectors.map(selector => {
    try {
      const el = document.querySelector(selector);
      if (!el) return { selector, found: false };
      const visibilityResult = visibility(el), isVisible = visibilityResult.visible;
      const enabled = !el.disabled && !(el.matches?.(':disabled') ?? false) && el.getAttribute('aria-disabled') !== 'true';
      return { selector, found: true, text: el.textContent, rect: box(el), visible: isVisible, enabled,
        visibilityMeasurement: visibilityResult.measurement,
        fontSize: parseFloat(getComputedStyle(el).fontSize), ...hits(el), textMetrics: textMetrics(el),
        state: { visible: isVisible, enabled, expanded: boolAttribute(el, 'aria-expanded'), busy: boolAttribute(el, 'aria-busy', false),
          selected: boolAttribute(el, 'aria-selected', typeof el.selected === 'boolean' ? el.selected : null),
          checked: boolAttribute(el, 'aria-checked', typeof el.checked === 'boolean' ? el.checked : null) } };
    } catch (error) { return { selector, found: false, error: String(error.message ?? error) }; }
  });
  const nextFrame = () => new Promise(resolve => requestAnimationFrame(resolve));
  const scrollChecks = [];
  for (const rule of rules.filter(rule => rule.type === 'scroll-reachability')) {
    const check = { ruleId: rule.id, selector: rule.selector, containerSelector: rule.containerSelector, operation: 'scrollIntoView' };
    let saved = [], originalWindow, restorationFailed = false;
    try {
      const el = document.querySelector(rule.selector), container = document.querySelector(rule.containerSelector);
      if (!el || !container) throw new Error('Scroll target or container was not found');
      check.containerContains = container.contains(el);
      if (!check.containerContains) throw new Error('Scroll target is outside its declared container');
      const style = getComputedStyle(container); check.overflowX = style.overflowX; check.overflowY = style.overflowY;
      for (let ancestor = el.parentElement; ancestor; ancestor = ancestor.parentElement)
        saved.push({ el: ancestor, top: ancestor.scrollTop, left: ancestor.scrollLeft });
      originalWindow = { top: scrollY, left: scrollX };
      check.before = { targetRect: box(el), containerRect: clientBox(container), scrollTop: container.scrollTop, scrollLeft: container.scrollLeft };
      el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
      await nextFrame(); await nextFrame();
      const afterVisibility = visibility(el);
      check.after = { targetRect: box(el), containerRect: clientBox(container), scrollTop: container.scrollTop, scrollLeft: container.scrollLeft,
        visible: afterVisibility.visible, visibilityMeasurement: afterVisibility.measurement, ...hits(el),
        clippingRects: [...clippingRects(el.parentElement, true).map(clip => clip.rect), { x: 0, y: 0, width: innerWidth, height: innerHeight }] };
    } catch (error) { check.error = String(error.message ?? error); }
    finally {
      try {
        for (const savedPosition of saved.toReversed()) {
          if (typeof savedPosition.el.scrollTo === 'function') savedPosition.el.scrollTo({ top: savedPosition.top, left: savedPosition.left, behavior: 'instant' });
          else { savedPosition.el.scrollTop = savedPosition.top; savedPosition.el.scrollLeft = savedPosition.left; }
        }
        if (originalWindow) window.scrollTo({ ...originalWindow, behavior: 'instant' });
        if (saved.length) { await nextFrame(); await nextFrame(); }
        restorationFailed = saved.some(position => Math.abs(position.el.scrollTop - position.top) > 1 || Math.abs(position.el.scrollLeft - position.left) > 1) ||
          (originalWindow && (Math.abs(scrollY - originalWindow.top) > 1 || Math.abs(scrollX - originalWindow.left) > 1));
      } catch (error) { restorationFailed = true; check.restorationError = String(error.message ?? error); }
      check.restored = !restorationFailed && !!originalWindow;
    }
    scrollChecks.push(check);
  }
  const accessibilityChecks = [];
  for (const rule of rules.filter(rule => rule.type === 'axe')) {
    const audit = { ruleId: rule.id, tool: 'axe-core', scope: rule.selector ?? 'document' };
    try {
      if (config.axeInjectionError) throw new Error(config.axeInjectionError);
      if (!globalThis.axe || typeof globalThis.axe.run !== 'function') throw new Error('axe-core was not loaded');
      const context = rule.selector ? document.querySelector(rule.selector) : document;
      if (!context) throw new Error('Accessibility scope was not found');
      // Required raw arrays cannot be suppressed via resultTypes; the reducer needs
      // incomplete and inapplicable results to distinguish review from a real pass.
      const options = { ...config.axeOptions, resultTypes: ['violations', 'passes', 'incomplete', 'inapplicable'] };
      if (rule.ruleIds) options.runOnly = { type: 'rule', values: rule.ruleIds };
      audit.results = await globalThis.axe.run(context, options);
    } catch (error) { audit.error = String(error.message ?? error); }
    accessibilityChecks.push(audit);
  }
  return { measurementVersion: 'ui-runtime/1', platform: 'web', url: location.href,
    viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
    document: { scrollWidth: Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth ?? 0), scrollHeight: document.documentElement.scrollHeight },
    elements, scrollChecks, accessibilityChecks,
    capabilities: { geometry: true, textRanges: true, hitTests: true, scrollOperation: true, topDocumentOnly: true },
    surfaces: { iframeCount: document.querySelectorAll('iframe').length, shadowHostCount: [...document.querySelectorAll('*')].filter(el => el.shadowRoot).length } };
}

export async function collectUiRuntimeSnapshot(cdp, constraints, options = {}) {
  let axeInjectionError;
  if (constraints.rules?.some?.(rule => rule?.type === 'axe') && options.axeSource !== undefined) {
    assert(nonempty(options.axeSource), 'axeSource must be the installed axe-core browser source');
    const injection = await cdp.send('Runtime.evaluate', { expression: options.axeSource, returnByValue: true });
    if (injection.exceptionDetails) axeInjectionError = injection.exceptionDetails.text ?? 'axe-core injection failed';
  }
  const config = { required: constraints.required, rules: constraints.rules, axeOptions: options.axeOptions, axeInjectionError };
  const result = await cdp.send('Runtime.evaluate', { awaitPromise: true, returnByValue: true,
    expression: `(${measureUiInBrowser.toString()})(${JSON.stringify(config)})` });
  assert(!result.exceptionDetails, `Visual measurement failed in browser: ${result.exceptionDetails?.text ?? ''}`);
  assert(result.result?.value && Array.isArray(result.result.value.elements), 'Visual measurement returned no browser data');
  return result.result.value;
}
