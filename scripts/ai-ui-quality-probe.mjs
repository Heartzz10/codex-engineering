import { createHash } from 'node:crypto';
import { readFile, stat, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { collectVisualSnapshot } from '../src/visual-check.mjs';

// A passive hook for AI-Platform's existing Playwright/Edge QA. Importing this
// file does not launch a browser, start a fixture, read business data, or run QA.
export async function hashUiSources(files = []) {
  return Promise.all(files.map(async file => {
    const absolute = path.resolve(file);
    const [bytes, info] = await Promise.all([readFile(absolute), stat(absolute)]);
    return { path: absolute, bytes: bytes.length, mtimeUtc: info.mtime.toISOString(),
      sha256: createHash('sha256').update(bytes).digest('hex') };
  }));
}

function axeNode(node, includeNodeHtml) {
  const { target, failureSummary, impact, any, all, none, html } = node;
  const checks = values => values.map(({ id, impact, message, data, relatedNodes }) => ({ id, impact, message, data,
    relatedNodes: relatedNodes.map(({ target, html }) => ({ target, ...(includeNodeHtml ? { html } : {}) })) }));
  return { target, failureSummary, impact, any: checks(any), all: checks(all), none: checks(none),
    ...(includeNodeHtml ? { html } : {}) };
}

export async function collectAiUiQuality(page, options = {}) {
  const { id, role, state, readySelector, required, axeSource, axeVersion, axeOptions,
    sourceFiles = [], evidenceDir, includeNodeHtml = false, businessObservation,
    actions = [], coverageUnit } = options;
  if (!id || !role || !state) throw new TypeError('id, role and state are required');
  if (!Array.isArray(required) || (!required.length && !options.rules?.length)) throw new TypeError('required selectors or explicit rules are required');
  let approvedAxeSource = axeSource, approvedAxeVersion = axeVersion, axeSourceReadError;
  if (axeSource === undefined) {
    try {
      approvedAxeSource = await readFile(new URL('../vendor/ui-tools/axe.min.js', import.meta.url), 'utf8');
      const manifest = JSON.parse(await readFile(new URL('../vendor/ui-tools/manifest.json', import.meta.url), 'utf8'));
      approvedAxeVersion ??= manifest.tools['axe-core'].version;
    } catch (error) { axeSourceReadError = 'Approved local vendor axe source unavailable: ' + String(error.message || error); }
  }
  if (readySelector) await page.locator(readySelector).waitFor({ state: 'visible', timeout: options.timeoutMs ?? 15000 });
  // Fonts and two rendering frames supplement the caller's business-ready wait;
  // they never replace an actual result assertion or promise network completion.
  const readiness = await page.evaluate(async () => {
    const fonts = !document.fonts ? 'unsupported' : await Promise.race([
      document.fonts.ready.then(() => document.fonts.status),
      new Promise(resolve => setTimeout(() => resolve('timeout'), 2000))
    ]);
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return { fonts };
  });
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  const rules = structuredClone(options.rules || []);
  // One native axe scan is retained and shared by the project's rule reduction.
  // The collector owns injection and execution; this adapter does not run axe.
  if (!rules.some(rule => rule.type === 'axe')) rules.push({ id: id + '-axe', type: 'axe', categoryId: 'Q05',
    sourceRef: options.accessibilitySourceRef || 'https://www.w3.org/WAI/tutorials/forms/labels/' });
  if (rules.filter(rule => rule.type === 'axe').length !== 1) throw new TypeError('Use one axe rule per captured state to share one native scan');
  const cdp = await page.context().newCDPSession(page);
  let layout;
  try { layout = await collectVisualSnapshot(cdp, { goal: id, viewport, required, rules }, { axeSource: approvedAxeSource, axeOptions }); }
  finally { await cdp.detach(); }
  const structure = await page.evaluate(() => {
    const shown = element => {
      if (!element.getClientRects().length) return false;
      for (let item = element; item; item = item.parentElement) {
        const style = getComputedStyle(item);
        if (item.hidden || style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity) === 0) return false;
      }
      return true;
    };
    const identify = element => element ? { tag: element.tagName.toLowerCase(), id: element.id || null,
      name: element.getAttribute('name'), role: element.getAttribute('role'),
      label: element.getAttribute('aria-label'), labelledBy: element.getAttribute('aria-labelledby'),
      controls: element.getAttribute('aria-controls'), labels: element.labels ? [...element.labels].map(label => label.textContent.trim()) : null,
      text: /^(INPUT|TEXTAREA|SELECT)$/.test(element.tagName) ? null : element.textContent.trim().slice(0, 120) } : null;
    const all = [...document.querySelectorAll('button,a[href],input,textarea,select,summary,[tabindex],[role]')];
    const controls = all.filter(shown).map(element => ({ ...identify(element),
      disabled: element.disabled === true || element.getAttribute('aria-disabled') === 'true',
      tabIndex: element.tabIndex, expanded: element.getAttribute('aria-expanded'),
      selected: element.getAttribute('aria-selected'), checked: element.getAttribute('aria-checked'),
      hasAssociatedLabel: element.labels ? element.labels.length > 0 : null,
      describedBy: element.getAttribute('aria-describedby') }));
    const forms = [...document.forms].filter(shown).map(form => ({ id: form.dataset.guardId || form.id || null,
      dirty: form.dataset.dirty ?? null, saving: form.dataset.saving ?? null,
      busy: form.getAttribute('aria-busy'), controls: [...form.elements].filter(shown).map(element => ({
        ...identify(element), required: element.required === true,
        invalid: element.validity ? !element.validity.valid : null,
        ariaInvalid: element.getAttribute('aria-invalid'), hasAssociatedLabel: element.labels ? element.labels.length > 0 : null })) }));
    const stateMarkers = [...document.querySelectorAll('[data-knowledge-reader-state],[data-form-error],[role="alert"],[role="status"],dialog[open]')]
      .filter(shown).map(element => ({ ...identify(element), readerState: element.dataset.knowledgeReaderState || null,
        open: element.tagName === 'DIALOG' ? element.open : null, busy: element.getAttribute('aria-busy') }));
    return { language: document.documentElement.lang, direction: getComputedStyle(document.documentElement).direction,
      devicePixelRatio, reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
      focus: identify(document.activeElement), controls, forms, stateMarkers,
      runningAnimations: document.getAnimations().filter(animation => animation.playState === 'running').map(animation => ({
        id: animation.id, playState: animation.playState,
        iterations: animation.effect?.getTiming().iterations === Infinity ? 'Infinity' : animation.effect?.getTiming().iterations ?? null })) };
  });
  const scan = layout.accessibilityChecks?.find(check => check.ruleId === rules.find(rule => rule.type === 'axe').id);
  const raw = scan?.results;
  let accessibility;
  if (axeSourceReadError || !raw || scan.error) accessibility = { status: 'capability_gap', reason: axeSourceReadError || scan?.error || 'Collector returned no native axe result; semantic inventory is not an axe audit.' };
  else if (approvedAxeVersion && raw.testEngine?.version !== approvedAxeVersion)
    accessibility = { status: 'capability_gap', reason: `axe-core version drift: expected ${approvedAxeVersion}, received ${raw.testEngine?.version}` };
  else accessibility = { version: raw.testEngine?.version, url: raw.url, timestamp: raw.timestamp,
    status: raw.violations.length ? 'failed' : raw.incomplete.length ? 'needs_review' : 'passed',
    violations: raw.violations.map(item => ({ ...item, nodes: item.nodes.map(node => axeNode(node, includeNodeHtml)) })),
    incomplete: raw.incomplete.map(item => ({ ...item, nodes: item.nodes.map(node => axeNode(node, includeNodeHtml)) })),
    passes: raw.passes.map(item => ({ id: item.id, tags: item.tags })),
    inapplicable: raw.inapplicable.map(item => ({ id: item.id, tags: item.tags })) };
  const result = { schemaVersion: 1, kind: 'ai-platform-ui-observation', generatedAt: new Date().toISOString(),
    id, role, state, url: page.url(), viewport, readiness, rules, actions: structuredClone(actions), layout, structure, accessibility,
    sources: await hashUiSources(sourceFiles),
    ...(businessObservation ? { businessObservation } : {}),
    limits: ['Passive state capture does not perform keyboard, submit, navigation, recovery or permission operations.',
      'Caller must supply real operations and business assertions at each applicable state; a final page capture does not cover prior hidden or transient states.',
      'Edge narrow viewport emulation is not a physical mobile-device acceptance.',
      'Accessibility passes and heuristic inventories do not establish complete UI coverage or visual style acceptance.'] };
  if (evidenceDir) {
    await mkdir(evidenceDir, { recursive: true });
    const safeId = id.replace(/[^a-zA-Z0-9_.-]/g, '-');
    result.artifactPath = path.resolve(evidenceDir, safeId + '.ui-quality.json');
    await writeFile(result.artifactPath, JSON.stringify(result, null, 2) + '\n', 'utf8');
  }
  if (coverageUnit) {
    result.coverageObservation = { ...structuredClone(coverageUnit), actions: structuredClone(actions),
      evidenceRef: result.artifactPath || options.evidenceRef || '' };
    if (evidenceDir) await writeFile(result.artifactPath, JSON.stringify(result, null, 2) + '\n', 'utf8');
  }
  return result;
}
