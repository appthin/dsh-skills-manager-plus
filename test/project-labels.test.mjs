/**
 * Guards for the project scope menus.
 *
 * The bug these cover: `fieldScopeProject` used a full-width `<项目>` in zh
 * while the code did `.replace('<project>', …)`, so the substitution silently
 * did nothing and every project rendered as the identical literal string —
 * looking exactly like a list of duplicate entries.
 *
 * Run with:  node test/project-labels.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { extractFunction } from './helpers/component.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8');

/** Load the bundle's real `projectLabels` with its `shortRoot` helper. */
function loadProjectLabels() {
  const shortRoot = extractFunction(source, 'shortRoot');
  const projectLabels = extractFunction(source, 'projectLabels');
  // eslint-disable-next-line no-new-func
  return new Function(`${shortRoot}\n${projectLabels}\nreturn projectLabels;`)();
}

const labelsOf = (roots) => loadProjectLabels()(roots.map((root) => ({ root })));

// ── the label buckets are actually substituted ──────────────────────────────

test('fieldScopeProject declares a {project} placeholder in both languages', () => {
  for (const lang of ['zh', 'en']) {
    const match = new RegExp(`^ {8}fieldScopeProject: '([^']*)'`, 'mu').exec(
      source.slice(source.indexOf(`\n      ${lang}: {`)),
    );
    assert.ok(match, `${lang}.fieldScopeProject must exist`);
    assert.match(match[1], /\{project\}/, `${lang} must use the {project} placeholder the code interpolates`);
  }
});

test('the scope menus interpolate the label instead of a literal .replace()', () => {
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/u, ''))
    .join('\n');
  // A narrow `.replace('<...>')` against a translated string is the exact
  // brittleness that produced the duplicate-looking menu.
  assert.doesNotMatch(code, /\.replace\(\s*'</, 'do not string-patch translated angle placeholders');
  const uses = code.match(/t\('fieldScopeProject',\s*\{ project:/g) ?? [];
  assert.equal(uses.length, 2, 'both scope menus (add skill, install) must pass the project param');
});

// ── every parameterised string matches its call site ────────────────────────

test('every t(key, {params}) call matches the placeholders in both dictionaries', () => {
  function dict(label) {
    const at = source.indexOf(`\n      ${label}: {`);
    const open = source.indexOf('{', at);
    let depth = 0;
    let end = open;
    for (let i = open; i < source.length; i += 1) {
      if (source[i] === '{') depth += 1;
      else if (source[i] === '}') {
        depth -= 1;
        if (depth === 0) { end = i; break; }
      }
    }
    const map = {};
    for (const m of source.slice(open + 1, end).matchAll(/^ {8}([A-Za-z][\w]*):\s*'([^']*)'/gmu)) map[m[1]] = m[2];
    return map;
  }
  const zh = dict('zh');
  const en = dict('en');

  const problems = [];
  for (const m of source.matchAll(/\bt\('([A-Za-z][\w]*)',\s*\{([^}]*)\}/g)) {
    const key = m[1];
    const params = [...m[2].matchAll(/([A-Za-z_]\w*)\s*:/g)].map((x) => x[1]);
    for (const [lang, table] of [['zh', zh], ['en', en]]) {
      const text = table[key];
      assert.ok(text !== undefined, `${lang}.${key} must exist`);
      for (const needed of [...text.matchAll(/\{(\w+)\}/g)].map((x) => x[1])) {
        if (!params.includes(needed)) {
          problems.push(`${lang}.${key} needs {${needed}} but the call passes ${JSON.stringify(params)}`);
        }
      }
    }
  }
  assert.deepEqual(problems, [], 'a missing param leaves a literal {placeholder} on screen');
});

// ── labels stay distinguishable ─────────────────────────────────────────────

test('distinct projects get distinct labels', () => {
  const labels = labelsOf([
    String.raw`E:\dev\petdo\petdo-design`,
    String.raw`E:\dev\WindowsServiceHub`,
    String.raw`E:\dev\deepseek_harness\dsh-skills-manager-plus`,
  ]);
  assert.deepEqual(labels, ['petdo-design', 'WindowsServiceHub', 'dsh-skills-manager-plus']);
});

test('projects sharing a folder name are qualified with their parent', () => {
  const labels = labelsOf([
    String.raw`E:\dev\deepseek_harness\dsh-skills-manager-plus`,
    String.raw`E:\work\clones\dsh-skills-manager-plus`,
  ]);
  assert.equal(new Set(labels).size, 2, 'identical basenames must not render identically');
  assert.deepEqual(labels, ['deepseek_harness/dsh-skills-manager-plus', 'clones/dsh-skills-manager-plus']);
});

test('a repeated parent name falls back to the full path', () => {
  const labels = labelsOf([
    String.raw`E:\a\deepseek_harness\dsh-skills-manager-plus`,
    String.raw`E:\b\deepseek_harness\dsh-skills-manager-plus`,
  ]);
  assert.equal(new Set(labels).size, 2);
  assert.ok(labels.every((label) => label.includes('\\') || label.includes('/')), 'needs the full path to disambiguate');
});

test('a shared folder name under different parents is disambiguated', () => {
  const labels = labelsOf([String.raw`E:\dev\app-one\shared`, String.raw`E:\dev\app-two\shared`]);
  assert.deepEqual(labels, ['app-one/shared', 'app-two/shared']);
});

test('labels are never empty, even for odd roots', () => {
  const labels = labelsOf(['/', 'C:', 'E:\\solo\\', '']);
  assert.equal(labels.length, 4);
  for (const label of labels) assert.equal(typeof label, 'string');
  // The two non-empty odd roots must stay distinguishable.
  assert.equal(new Set(labels.slice(0, 3)).size, 3);
});
