import fs from 'node:fs/promises';
import path from 'node:path';
import { assert, json, existingInside, VERSION } from './paths.mjs';
import { mapPaths, parseStrictJson } from './feature-store.mjs';
import { loadUIQualityConfig } from './ui-quality.mjs';

const idPattern = /^[a-z][a-z0-9-]{0,63}$/;
export async function loadProfile(file, { allowMissingDocuments = false } = {}) {
  const p = parseStrictJson(await fs.readFile(file, 'utf8'));
  assert([1, 2].includes(p.schemaVersion), 'Unsupported profile schemaVersion');
  assert(idPattern.test(p.id), 'Invalid project ID');
  assert(p.sharedVersion === VERSION || (p.schemaVersion === 1 && p.sharedVersion === '0.1.0'), 'Shared version mismatch');
  assert(typeof p.root === 'string' && path.isAbsolute(p.root), 'Absolute project root required');
  p.root = await fs.realpath(p.root);
  assert((await fs.stat(p.root)).isDirectory(), 'Project root must be a directory');
  assert(Array.isArray(p.authoritativeDocuments) && p.authoritativeDocuments.length > 0, 'Authoritative document references required');
  const documentPaths = [], missingAuthoritativeDocuments = [];
  for (const ref of p.authoritativeDocuments) {
    try { documentPaths.push(await existingInside(p.root, ref)); }
    catch (error) {
      if (!allowMissingDocuments || error.code !== 'ENOENT') throw error;
      missingAuthoritativeDocuments.push(ref);
    }
  }
  let missingFeatureMapDocument = null;
  if (p.featureMapDocument !== undefined) {
    assert(typeof p.featureMapDocument === 'string' && p.featureMapDocument.trim(), 'Invalid feature map document');
    try {
      p.featureMapDocumentPath = await existingInside(p.root, p.featureMapDocument);
      assert((await fs.stat(p.featureMapDocumentPath)).isFile(), 'Feature map document must be a file');
    } catch (error) {
      if (!allowMissingDocuments || error.code !== 'ENOENT') throw error;
      missingFeatureMapDocument = p.featureMapDocument;
    }
  }
  assert(typeof p.environmentRef === 'string' && p.environmentRef.trim(), 'Environment reference required');
  assert(p.environmentFiles === undefined || Array.isArray(p.environmentFiles), 'environmentFiles must be an array');
  assert(p.environmentKeys === undefined || (Array.isArray(p.environmentKeys) && p.environmentKeys.every(k => typeof k === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(k))), 'Invalid environmentKeys');
  for (const ref of p.environmentFiles || []) await existingInside(p.root, ref);
  assert(Array.isArray(p.checks), 'Checks must be an array');
  const ids = new Set();
  for (const c of p.checks) {
    assert(idPattern.test(c.id) && !ids.has(c.id), 'Invalid or duplicate check ID'); ids.add(c.id);
    assert(typeof c.executable === 'string' && path.isAbsolute(c.executable), 'Explicit executable path required');
    const executable = await fs.realpath(c.executable);
    assert((await fs.stat(executable)).isFile(), 'Executable is not a file');
    assert(!/\.(cmd|bat|ps1)$/i.test(executable), 'Use the actual runtime executable and an argument array');
    assert(Array.isArray(c.args) && c.args.every(x => typeof x === 'string' && !x.includes('\0')), 'Arguments must be a string array');
    assert(Number.isInteger(c.timeoutMs) && c.timeoutMs >= 100 && c.timeoutMs <= 300000, 'Timeout must be 100–300000 ms');
    assert(c.reviewed === true && typeof c.authorizationRef === 'string' && c.authorizationRef.trim(), 'Check review and authorization reference required');
    assert(c.effects && ['none', 'test-artifacts', 'business-data'].includes(c.effects.writes) && typeof c.effects.network === 'boolean' && typeof c.effects.paid === 'boolean', 'Explicit effects required');
    assert(Array.isArray(c.inputs) && c.inputs.length > 0, 'Fingerprint inputs required');
    await existingInside(p.root, c.cwd);
    for (const input of c.inputs) await existingInside(p.root, input);
  }
  const entrypointIds = new Set();
  for (const e of p.entrypoints || []) {
    assert(idPattern.test(e.id) && ['real', 'simulation'].includes(e.kind), 'Invalid entrypoint');
    assert(!entrypointIds.has(e.id), 'Duplicate entrypoint ID'); entrypointIds.add(e.id);
    if (e.url) assert(['http:', 'https:'].includes(new URL(e.url).protocol), 'HTTP(S) entrypoint required');
    else assert(p.schemaVersion === 2 && typeof e.controlRef === 'string' && e.controlRef.trim(), 'Entrypoint URL or controlRef required');
  }
  if (p.featureMapRef) await mapPaths(p);
  p.featureMapStatus = p.featureMapRef ? 'configured' : p.featureMapDocumentPath ? 'documented' : 'needs_feature_map';
  p.compatibility = p.sharedVersion === VERSION ? 'current' : 'legacy_checks_only';
  const quality = await loadUIQualityConfig(p);
  p.uiQualityStatus = quality.status;
  p.uiQuality = quality.config;
  p.uiQualityPath = quality.configPath || null;
  if (p.engineeringRulesRef !== undefined) {
    const { loadEngineeringRules } = await import('./engineering-rules.mjs');
    const baseline = await loadEngineeringRules(p);
    p.engineeringRules = baseline.config;
    p.engineeringRuleInputs = baseline.checkInputs;
    p.engineeringCatalogHash = baseline.catalogHash;
  }
  return { ...p, documentPaths, missingAuthoritativeDocuments, missingFeatureMapDocument, profilePath: path.resolve(file) };
}

export function checkAuthorization(profile, check) {
  const permissions = profile.permissions || {};
  assert(!check.effects.paid, 'Paid checks need an enforced provider budget adapter; unsupported by this local runner');
  assert(check.effects.writes !== 'business-data', 'Business-data writes require dedicated project acceptance; not a baseline check');
  assert(!check.effects.network || permissions.network === true, 'Network effect is not authorized in this profile');
  assert(check.effects.writes !== 'test-artifacts' || permissions.testArtifacts === true, 'Test-artifact writes not authorized');
}
