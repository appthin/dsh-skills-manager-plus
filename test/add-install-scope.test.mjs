/**
 * Render-level tests for the default scope of the Add-skill and Install-from-
 * archive dialogs. Opening them from the project tab (with a project already
 * selected on the page) must preset that project instead of resetting to the
 * global scope / the first project.
 *
 * Run with:  node test/add-install-scope.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { extractFunction } from './helpers/component.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8');

const projects = [
  { root: 'E:/p/alpha', label: 'alpha' },
  { root: 'E:/p/beta', label: 'beta' },
];
const t = (key) => key;
const noop = () => {};
const react = { Fragment: Symbol('Fragment') };
// Mirror the bundle's element factory and hook runtime. React flattens nested
// child arrays (e.g. `h(sel, opt, projects.map(opt))`), so flatten here too.
const h = (type, config = {}, ...children) => {
  const flat = [];
  for (const child of children) {
    if (Array.isArray(child)) flat.push(...child);
    else flat.push(child);
  }
  return { type, props: config || {}, children: flat.filter((c) => c !== undefined && c !== null) };
};
const Modal = function Modal() {};
const Icon = function Icon() {};
const ICON_PATH = { folder: 'folder', check: 'check', close: 'close', warn: 'warn' };
const projectLabels = (items) => items.map((item) => item.root);

/** Render an extracted dialog with a real-enough hook runtime. */
function renderDialog(name, props, extra = {}) {
  const state = [];
  let cursor = 0;
  const useState = (initial) => {
    const i = cursor++;
    if (state[i] === undefined) state[i] = typeof initial === 'function' ? initial() : initial;
    return [state[i], (next) => { state[i] = typeof next === 'function' ? next(state[i]) : next; }];
  };
  const useRef = () => ({ current: null });
  const useEffect = noop;
  const scopeVars = Object.assign({ h, Modal, Icon, ICON_PATH, react, useState, useRef, useEffect, projectLabels }, extra);
  const body = extractFunction(source, name);
  // eslint-disable-next-line no-new-func
  const factory = new Function(...Object.keys(scopeVars), `return (${body});`);
  return factory(...Object.values(scopeVars))({ t, ...props });
}

/** Pull the scope `<select>` (the first body child) out of a dialog tree. */
function scopeSelect(tree) {
  const body = tree.children;
  assert.ok(body.length > 0, 'the dialog has body children');
  const first = body[0];
  // With a scope field the first child is the `.smp-field` div holding the select.
  assert.ok(first, 'a scope select must be rendered');
  return first.children[1];
}

test('InstallDialog opened from the project tab defaults to the selected project', () => {
  const tree = renderDialog('InstallDialog', {
    projects,
    defaultProject: 'E:/p/beta',
    onClose: noop,
    onDone: noop,
    onFailed: noop,
  });
  const select = scopeSelect(tree);
  assert.equal(select.props.value, 'project:E:/p/beta', 'the selected project is preset');
  const values = select.children.map((opt) => opt.props.value);
  assert.ok(values.includes('project:E:/p/beta'), 'the preset project is a real option');
  assert.ok(values.includes('project:E:/p/alpha'), 'other projects remain selectable');
  assert.ok(values.includes('user'), 'the global scope stays available');
});

test('InstallDialog opened from the global tab keeps the user scope', () => {
  const tree = renderDialog('InstallDialog', {
    projects,
    defaultProject: '',
    onClose: noop,
    onDone: noop,
    onFailed: noop,
  });
  assert.equal(scopeSelect(tree).props.value, 'user');
});

test('InstallDialog without any known project renders no scope field', () => {
  const tree = renderDialog('InstallDialog', {
    projects: [],
    defaultProject: '',
    onClose: noop,
    onDone: noop,
    onFailed: noop,
  });
  const first = tree.children[0];
  // Without a scope field the first body child is the file picker, not a scope select.
  assert.ok(first && first.type !== 'select', 'no scope select when there are no projects');
});

test('AddSkillDialog from the project tab presets the selected project for a new skill', () => {
  const tree = renderDialog('SkillDialog', {
    projects,
    defaultProject: 'E:/p/alpha',
    skill: null,
    onClose: noop,
    onDone: noop,
  });
  const select = scopeSelect(tree);
  assert.equal(select.props.value, 'project:E:/p/alpha', 'a new skill lands in the selected project');
  assert.ok(select.children.some((opt) => opt.props.value === 'project:E:/p/alpha'));
});

test('AddSkillDialog from the global tab defaults a new skill to the user scope', () => {
  const tree = renderDialog('SkillDialog', {
    projects,
    defaultProject: '',
    skill: null,
    onClose: noop,
    onDone: noop,
  });
  assert.equal(scopeSelect(tree).props.value, 'user');
});