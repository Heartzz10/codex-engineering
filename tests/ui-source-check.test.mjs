import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const module = await import('../src/ui-source-check.mjs').catch(() => ({}));
const { assessUISource, prepareUISourceChecks } = module;
const scan = (content, rules) => assessUISource({ language: 'html', content, file: 'index.html', rules });
test('source functions exist before source checks can be used', () => {
  for (const name of ['assessUISource', 'prepareUISourceChecks', 'runUISourceChecks']) assert.equal(typeof module[name], 'function', name);
});
test('duplicate literal HTML IDs fail, unique IDs and prose mentioning IDs pass', () => {
  assert.equal(scan('<label id="x"></label><input id="x">', ['html-duplicate-id']).status, 'failed');
  assert.equal(scan('<label id="x"></label><input id="y"><!-- <div id="x"> -->', ['html-duplicate-id']).status, 'passed');
  assert.equal(scan('<script>const example = \'<div id="x">\';</script><div id="x">', ['html-duplicate-id']).status, 'passed');
});
test('positive tabindex fails while natural and programmatic focus values remain legal', () => {
  assert.equal(scan('<button tabindex="2">Save</button>', ['html-positive-tabindex']).status, 'failed');
  assert.equal(scan('<button tabindex="0">Save</button><div tabindex="-1"></div>', ['html-positive-tabindex']).status, 'passed');
});
test('missing image alt fails while decorative empty alt and named image are legal', () => {
  assert.equal(scan('<img src="a.png">', ['html-image-alt']).status, 'failed');
  assert.equal(scan('<img src="a.png" alt=""><img src="b.png" alt="Saved note">', ['html-image-alt']).status, 'passed');
});
test('unlabelled HTML inputs fail and native label association passes', () => {
  assert.equal(scan('<input id="name">', ['html-input-label']).status, 'failed');
  assert.equal(scan('<label for="name">Name</label><input id="name">', ['html-input-label']).status, 'passed');
});
test('implicit button type fails and explicit submit or ordinary button stays legal', () => {
  assert.equal(scan('<button>Save</button>', ['html-button-type']).status, 'failed');
  assert.equal(scan('<button type="submit">Save</button><button type="button">Cancel</button>', ['html-button-type']).status, 'passed');
});
test('tool unavailable is a gap even when text appears valid', () => {
  assert.equal(assessUISource({ language: 'html', content: '<img alt="">', file: 'index.html', rules: ['html-image-alt'] }, { toolAvailable: false }).status, 'gaps');
});
test('quoted angle brackets and comments are parsed without false duplicate or missing-alt reports', () => {
  assert.equal(scan('<div title="x > y" id="a"></div><img alt="a > b" src="b.png">', ['html-image-alt', 'html-duplicate-id']).status, 'passed');
});
test('dynamic templates, JSX and missing source tool are explicit gaps', () => {
  assert.equal(scan('<img {{attributes}}>', ['html-image-alt']).status, 'gaps');
  assert.equal(assessUISource({ language: 'jsx', content: '<img />', file: 'app.jsx', rules: ['html-image-alt'] }).status, 'gaps');
  assert.equal(scan('<div></div>', ['not-implemented']).status, 'gaps');
});
test('embedded disable directives cannot silently bypass the selected source rules', () => {
  assert.notEqual(scan('<!-- html-validate-disable wcag/h37 --><img>', ['html-image-alt']).status, 'passed');
});
test('registered source checks retain runner authorization and actual process result', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ui-source-run-'));
  try {
    await fs.writeFile(path.join(root, 'input.html'), '<img alt="">');
    const check = { id: 'html-source', executable: process.execPath, args: ['-e', 'process.exit(0)'], cwd: '.', timeoutMs: 2000,
      inputs: ['input.html'], effects: { writes: 'none', network: false, paid: false }, authorizationRef: 'docs/approved' };
    const profile = { root, id: 'ui-fixture', environmentRef: 'test', checks: [check] };
    const config = { sourceChecks: [{ checkId: 'html-source', categoryIds: ['Q05'], sourceRef: 'package.json' }] };
    const result = await module.runUISourceChecks(profile, config, { stateRoot: path.join(root, 'state') });
    assert.equal(result.status, 'passed'); assert.equal(result.results[0].status, 'check_passed'); assert.ok(result.results[0].evidence);
    check.effects.paid = true;
    assert.equal((await module.runUISourceChecks(profile, config, { stateRoot: path.join(root, 'state') })).status, 'gaps');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
test('existing project checks are referenced rather than ecosystem commands manufactured', () => {
  const config = { sourceChecks: [{ checkId: 'existing-lint', categoryIds: ['Q05'], sourceRef: 'package.json' }] };
  const ready = prepareUISourceChecks(config, { checks: [{ id: 'existing-lint', executable: process.execPath, args: ['--version'] }] });
  assert.equal(ready.status, 'ready'); assert.equal(ready.checks[0].checkId, 'existing-lint');
  assert.equal(ready.businessAcceptance, false);
  assert.equal(prepareUISourceChecks(config, { checks: [] }).status, 'gaps');
});
test('source check result states its limited scope and cannot claim business or runtime acceptance', () => {
  const result = scan('<img alt="">', ['html-image-alt']);
  assert.equal(result.businessAcceptance, false); assert.equal(result.runtimeAcceptance, false); assert.ok(result.limits);
});
test('distributable parser bundle agrees with locked node parser on bad and legitimate HTML', async () => {
  const bundled = await import('../vendor/ui-tools/html-validate.mjs').catch(() => null);
  assert.ok(bundled, 'build-ui-tools must produce a standalone parser bundle');
  const upstream = await import('html-validate').catch(() => null);
  const config = { extends: [], rules: { 'no-dup-id': 'error', 'wcag/h37': 'error', 'input-missing-label': 'error', 'no-implicit-button-type': 'error' } };
  const examples = [['<img>', false], ['<img alt="">', true], ['<div id="a"></div><div id="a"></div>', false], ['<div id="a"></div><div id="b"></div>', true],
    ['<input id="name">', false], ['<label for="name">Name</label><input id="name">', true], ['<button>Save</button>', false], ['<button type="submit">Save</button>', true]];
  for (const [content, valid] of examples) {
    const actual = new bundled.HtmlValidate(config).validateStringSync(content);
    assert.equal(actual.valid, valid, content);
    if (upstream) {
      const expected = new upstream.HtmlValidate(config).validateStringSync(content);
      assert.equal(actual.valid, expected.valid, content);
      assert.deepEqual(actual.results.flatMap(item => item.messages.map(message => message.ruleId)), expected.results.flatMap(item => item.messages.map(message => message.ruleId)), content);
    }
  }
  const manifest = JSON.parse(await fs.readFile(new URL('../vendor/ui-tools/manifest.json', import.meta.url), 'utf8'));
  assert.equal(manifest.tools['html-validate'].version, '10.9.0'); assert.equal(manifest.tools['axe-core'].version, '4.13.0');
  assert.ok(manifest.files.every(file => /^[a-f0-9]{64}$/.test(file.sha256)));
});
