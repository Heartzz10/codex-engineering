import fs from 'node:fs/promises';
import path from 'node:path';
import { UI_QUALITY_CATALOG } from './ui-quality.mjs';
import { runCheck } from './runner.mjs';

// Optional project tool: an absent parser is a capability gap, never a successful scan.
const htmlTool = await import('../vendor/ui-tools/html-validate.mjs').catch(() => import('html-validate').catch(() => null));
const rules = {
  'html-duplicate-id': { toolRule: 'no-dup-id', categoryId: 'Q05' },
  'html-positive-tabindex': { toolRule: 'ui-positive-tabindex', categoryId: 'Q06' },
  'html-image-alt': { toolRule: 'wcag/h37', categoryId: 'Q03' },
  'html-input-label': { toolRule: 'input-missing-label', categoryId: 'Q08' },
  'html-button-type': { toolRule: 'no-implicit-button-type', categoryId: 'Q09' }
};
export const UI_SOURCE_RULE_IDS = Object.keys(rules);
const limits = 'Only declared literal HTML source rules are checked. Uses html-validate parsing; dynamic templates require their project transformer. No layout, meaningful copy, keyboard operation, accessibility compliance, runtime or business acceptance is established.';

function positiveTabindexRule() {
  return class extends htmlTool.Rule {
    setup() {
      this.on('dom:ready', ({ document }) => {
        for (const node of document.querySelectorAll('[tabindex]')) {
          const attribute = node.getAttribute('tabindex');
          if (/^[+]?[0-9]+$/.test(String(attribute.value).trim()) && Number(attribute.value) > 0)
            this.report({ node, location: attribute.valueLocation, message: 'Positive tabindex bypasses the project default natural focus order' });
        }
      });
    }
  };
}

export function assessUISource(input, options = {}) {
  const findings = [], gaps = [], requested = input?.rules || [];
  const result = { status: 'gaps', file: input?.file || null, findings, gaps, checkedRules: requested,
    tool: 'html-validate', toolVersion: htmlTool?.version ?? null, businessAcceptance: false, runtimeAcceptance: false, limits };
  if (!Array.isArray(requested) || !requested.length) { gaps.push({ code: 'missing_source_rules' }); return result; }
  for (const ruleId of requested) if (!rules[ruleId]) gaps.push({ code: 'unknown_source_rule', ruleId });
  if (input.language !== 'html') gaps.push({ code: 'unsupported_source_language', language: input.language });
  if (!htmlTool || options.toolAvailable === false) gaps.push({ code: 'missing_source_tool', tool: 'html-validate' });
  if (typeof input.content !== 'string') gaps.push({ code: 'missing_source_content' });
  if (typeof input.content === 'string' && /<!--\s*html-validate-(?:disable|enable)/i.test(input.content))
    gaps.push({ code: 'unreviewed_source_rule_suppression', detail: 'Use a bounded project exception; embedded directives cannot disable this public check' });
  // Do not interpret unresolved server/framework expansion as final HTML.
  if (typeof input.content === 'string' && /\{\{|<%|\{%|\{#/.test(input.content.replace(/<!--[^]*?-->|<(script|style)\b[^]*?<\/\1\s*>/gi, '')))
    gaps.push({ code: 'dynamic_template_requires_project_parser' });
  if (gaps.length) return result;
  try {
    const toolRules = Object.fromEntries(requested.map(id => [rules[id].toolRule, 'error']));
    const validator = new htmlTool.HtmlValidate({ extends: [], elements: ['html5'],
      plugins: [{ name: 'ui-quality-source', rules: { 'ui-positive-tabindex': positiveTabindexRule() } }], rules: toolRules });
    const report = validator.validateStringSync(input.content, input.file || 'inline.html');
    for (const entry of report.results) for (const message of entry.messages) {
      const ruleId = requested.find(id => rules[id].toolRule === message.ruleId);
      if (!ruleId || !message.line) gaps.push({ code: 'source_parser_or_rule_failure', toolRule: message.ruleId, detail: message.message });
      else findings.push({ ruleId, categoryId: rules[ruleId].categoryId, file: input.file || entry.filePath, line: message.line,
        column: message.column, selector: message.selector, actual: message.message, expected: 'Declared HTML rule is satisfied',
        sourceRef: UI_QUALITY_CATALOG.sourceRules.find(rule => rule.ruleId === ruleId)?.source || message.ruleUrl,
        certainty: 'determinate', nextAction: 'Fix the affected source and rerun the same registered check' });
    }
    result.status = findings.length ? 'failed' : gaps.length ? 'gaps' : 'passed';
  } catch (error) { gaps.push({ code: 'source_tool_error', detail: error.message }); }
  return result;
}

export async function checkUISourceFiles({ files, rules: requested = UI_SOURCE_RULE_IDS, root = process.cwd() } = {}) {
  if (!Array.isArray(files) || !files.length) throw new Error('Explicit HTML source files required');
  const results = [];
  for (const file of files) {
    try { results.push(assessUISource({ language: 'html', file, content: await fs.readFile(path.resolve(root, file), 'utf8'), rules: requested })); }
    catch (error) { results.push({ status: 'gaps', file, findings: [], gaps: [{ code: 'unreadable_source', detail: error.message }] }); }
  }
  return { status: results.some(result => result.status === 'failed') ? 'failed' : results.some(result => result.status !== 'passed') ? 'gaps' : 'passed',
    results, findings: results.flatMap(result => result.findings), gaps: results.flatMap(result => result.gaps), businessAcceptance: false, runtimeAcceptance: false, limits };
}

export function prepareUISourceChecks(config, profile) {
  const checks = [], gaps = [];
  if (!config) gaps.push({ code: 'not_configured' });
  for (const declaration of config?.sourceChecks || []) {
    const registered = profile?.checks?.find(check => check.id === declaration.checkId);
    if (!registered) gaps.push({ code: 'missing_registered_source_check', checkId: declaration.checkId, sourceRef: declaration.sourceRef });
    else checks.push({ ...declaration, registeredCheck: registered });
  }
  if (config && !(config.sourceChecks || []).length) gaps.push({ code: 'no_source_checks_registered' });
  return { status: gaps.length ? 'gaps' : 'ready', checks, gaps, businessAcceptance: false, runtimeAcceptance: false, limits };
}

// Sequential reuse of the existing authorization, fingerprint, timeout and evidence runner.
export async function runUISourceChecks(profile, config, options = {}) {
  const prepared = prepareUISourceChecks(config, profile), results = [], gaps = [...prepared.gaps];
  for (const check of prepared.checks) {
    try { results.push({ ...await runCheck(profile, check.checkId, options), categoryIds: check.categoryIds }); }
    catch (error) { gaps.push({ code: 'registered_source_check_error', checkId: check.checkId, detail: error.message }); }
  }
  return { status: results.some(result => result.status === 'check_failed') ? 'failed' : gaps.length || results.some(result => result.status !== 'check_passed') ? 'gaps' : 'passed',
    results, gaps, businessAcceptance: false, runtimeAcceptance: false, limits };
}
