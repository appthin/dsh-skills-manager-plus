/**
 * Client-half check: run `lib/client.js` the way the browser shell does —
 * through a `window.__ModuleLoader__` facade with a CommonJS `require` — and
 * assert it registers a `settings.section` page without throwing.
 *
 * Run with:  node test/client.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const bundlePath = join(here, '..', 'lib', 'client.js');

/** A minimal React stand-in enough for `createElement`/`Fragment` to run. */
const reactStub = {
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children: children.filter((c) => c !== undefined && c !== null) };
  },
  Fragment: Symbol('Fragment'),
  useState: () => { throw new Error('useState called outside a render'); },
  useEffect: () => { throw new Error('useEffect called outside a render'); },
  useCallback: () => { throw new Error('useCallback called outside a render'); },
  useRef: () => { throw new Error('useRef called outside a render'); },
  useMemo: () => { throw new Error('useMemo called outside a render'); },
};

function seededRequire(name) {
  if (name === 'react') return reactStub;
  throw new Error(`unexpected require("${name}"): not in the platform seed table`);
}

async function loadClientBundle() {
  const registrations = [];
  const effects = [];
  const styles = [];
  const listeners = new Map();

  const documentStub = {
    head: { appendChild: (node) => styles.push(node) },
    getElementById: () => null,
    createElement: (tag) => ({ tag, id: '', textContent: '', style: {} }),
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: (type) => listeners.delete(type),
    documentElement: { appendChild: () => {} },
    querySelectorAll: () => [],
  };
  globalThis.document = documentStub;
  if (globalThis.MutationObserver === undefined) {
    globalThis.MutationObserver = class {
      constructor() { this.cb = () => {}; }
      observe() {}
      disconnect() {}
    };
  }

  let captured = null;
  const windowStub = {
    __ModuleLoader__: {
      load(spec) {
        assert.equal(spec.id, 'dsh-skills-manager-plus', 'the bundle must register under the package id');
        assert.equal(typeof spec.factory, 'function');
        captured = spec.factory(seededRequire);
      },
    },
    confirm: () => true,
  };
  globalThis.window = windowStub;
  globalThis.localStorage = {
    getItem: () => null,
    setItem: () => {},
  };

  // The bundle references `window.__ModuleLoader__.load(...)`; run it.
  const source = readFileSync(bundlePath, 'utf8');
  // eslint-disable-next-line no-eval
  (0, eval)(source);

  const exports = captured;
  exports?.apply?.({
    get() { return undefined; },
    effect(factory) { const dispose = factory(); effects.push(dispose); return dispose; },
    slots: {
      inject(slot, factory) {
        assert.equal(slot, 'settings.section');
        registrations.push(factory());
      },
      register(spec, component) {
        assert.equal(spec.name, 'settings.section');
        assert.equal(typeof spec.label, 'function');
        assert.equal(typeof component, 'function');
        return spec;
      },
    },
  });

  // Clean up the globals we added, after letting the nav-row watch timer fire.
  await new Promise((resolve) => setTimeout(resolve, 150));
  delete globalThis.document;
  delete globalThis.window;
  delete globalThis.localStorage;
  delete globalThis.navigator;

  return { exports, registrations, effects, styles };
}

test('client bundle loads and registers a settings.section page', async () => {
  const { exports, registrations, effects, styles } = await loadClientBundle();
  assert.equal(exports.name, 'dsh-skills-manager-plus');
  assert.ok(Array.isArray(exports.inject) && exports.inject.includes('slots'));
  assert.equal(registrations.length, 1, 'one settings.section registration');
  const section = registrations[0];
  assert.equal(section.id, 'skills');
  assert.ok(typeof section.label === 'function');
  assert.equal(typeof section.order, 'number');
  // The page injects a stylesheet once; the styles tag captures it.
  assert.ok(styles.length >= 1, 'styles injected into head');
  // The preliminary effect (dictionary mirror, locale) is harmless to dispose.
  for (const dispose of effects) {
    if (typeof dispose === 'function') dispose();
  }
});