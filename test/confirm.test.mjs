/**
 * Render-level tests for the delete-confirmation dialog, which replaced the
 * browser's native `window.confirm` so destructive actions match the page.
 *
 * Run with:  node test/confirm.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { extractFunction, flatten } from './helpers/component.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8');

const t = (key) => key;

/**
 * Render ConfirmDialog: it calls useState, so supply a tiny hook runtime and
 * evaluate the real component body (extracted from the bundle) with it.
 */
function renderConfirm(props) {
  const h = (type, config, ...children) => ({
    type,
    props: config || {},
    children: children.filter((c) => c !== undefined && c !== null),
  });
  const Modal = function Modal() {};
  const react = { Fragment: Symbol('Fragment') };
  const state = [];
  let cursor = 0;
  const useState = (initial) => {
    const index = cursor++;
    if (state[index] === undefined) state[index] = typeof initial === 'function' ? initial() : initial;
    return [state[index], (next) => { state[index] = next; }];
  };
  const body = extractFunction(source, 'ConfirmDialog');
  // eslint-disable-next-line no-new-func
  const factory = new Function('h', 'Modal', 'react', 'useState', `return (${body});`);
  return factory(h, Modal, react, useState)({ t, ...props });
}

test('the confirmation names the item, the action and a cancel path', () => {
  const tree = renderConfirm({
    title: 'removeSkillTitle',
    message: 'removeSkillConfirm',
    danger: true,
    onCancel() {},
    onConfirm() {},
  });
  assert.equal(tree.props.title, 'removeSkillTitle');
  const footer = tree.props.footer;
  const buttons = footer.children;
  assert.equal(buttons.length, 2, 'a cancel and a confirm action');
  // Cancel is the neutral button and calls onCancel.
  assert.ok(String(buttons[0].props.className).includes('smp-btn'));
  assert.ok(!String(buttons[0].props.className).includes('smp-btn-danger'));
  // Confirm is the dangerous action for a delete.
  assert.ok(String(buttons[1].props.className).includes('smp-btn-danger'));
  assert.equal(typeof buttons[1].props.onClick, 'function');
  // The body carries the translated question.
  const { text } = flatten(tree.children);
  assert.deepEqual(text, ['removeSkillConfirm']);
});

test('a non-destructive confirmation uses the primary (not danger) button', () => {
  const tree = renderConfirm({ title: 'x', message: 'y', danger: false, onCancel() {}, onConfirm() {} });
  const confirm = tree.props.footer.children[1];
  assert.ok(String(confirm.props.className).includes('smp-btn-primary'));
  assert.ok(!String(confirm.props.className).includes('smp-btn-danger'));
});

test('confirming invokes onConfirm, and the dialog is Escape-dismissible', () => {
  let confirmed = 0;
  let cancelled = 0;
  const tree = renderConfirm({
    title: 'x',
    message: 'y',
    danger: true,
    onCancel: () => { cancelled += 1; },
    onConfirm: () => { confirmed += 1; },
  });
  tree.props.footer.children[1].props.onClick();
  assert.equal(confirmed, 1, 'the primary action runs the mutation');
  // The Modal shell is handed onClose so Escape and overlay clicks cancel.
  assert.equal(typeof tree.props.onClose, 'function');
  tree.props.onClose();
  assert.equal(cancelled, 1);
});

test('the delete flows open the themed dialog instead of window.confirm', () => {
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/u, ''))
    .join('\n');
  assert.doesNotMatch(code, /window\.confirm/, 'the native confirm must be gone from executable code');
  assert.match(code, /kind: 'confirm'/, 'removals must open the themed confirmation');
  assert.match(code, /removeSkillTitle/, 'the skill delete dialog needs a title');
  assert.match(code, /removeCommandTitle/, 'the command delete dialog needs a title');
});

test('both languages define the confirmation strings', () => {
  for (const key of ['removeSkillTitle', 'removeCommandTitle', 'removeSkillConfirm', 'removeCommandConfirm']) {
    const occurrences = source.match(new RegExp(`^ {8}${key}:`, 'gmu')) ?? [];
    assert.equal(occurrences.length, 2, `${key} must exist in zh and en`);
  }
});
