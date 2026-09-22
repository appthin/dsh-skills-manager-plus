/**
 * Render-level tests for the install-result popup.
 *
 * `InstallResultDialog` is closure-internal to the bundle, so these tests pull
 * its real source out of `lib/client.js` and run it against a stub React. That
 * way the assertions are about the component that actually ships, not a copy.
 *
 * Run with:  node test/install-result.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { extractFunction, flatten, renderComponent } from './helpers/component.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8');

/** A pass-through translator that makes the rendered text self-describing. */
const t = (key) => key;

function render(props) {
  return renderComponent(source, 'InstallResultDialog', props, t);
}

test('a fully successful install reports success and lists every skill', () => {
  const tree = render({
    result: {
      installed: [{ name: 'alpha' }, { name: 'beta' }],
      skipped: [],
      root: '/home/u/.dsh/skills',
    },
    failure: null,
    onClose() {},
  });
  const { text, classes } = flatten(tree);
  const joined = text.join('');
  assert.ok(joined.includes('installResultTitle'), 'the popup has its own title');
  assert.ok(joined.includes('installResultOkTitle'), 'a clean install says so');
  assert.ok(classes.some((c) => c.includes('smp-result-ok')), 'success uses the success tone');
  assert.ok(joined.includes('alpha') && joined.includes('beta'), 'every installed name is shown');
  assert.ok(joined.includes('installResultInstalledCount'), 'the count line is present');
  assert.ok(joined.includes('/home/u/.dsh/skills'), 'the install target is shown');
  assert.ok(joined.includes('installResultOkHint'));
  // Nothing skipped means no skip section at all.
  assert.ok(!joined.includes('installResultSkippedCount'));
});

test('a partial install reports both the installed and the skipped names', () => {
  const tree = render({
    result: {
      installed: [{ name: 'fresh' }],
      skipped: [{ name: 'dup', reason: 'taken' }, { name: 'bad', reason: 'invalid' }],
      root: '/home/u/.dsh/skills',
    },
    failure: null,
    onClose() {},
  });
  const { text, classes } = flatten(tree);
  const joined = text.join('');
  assert.ok(joined.includes('installResultPartialTitle'), 'partial installs are distinguished');
  assert.ok(classes.some((c) => c.includes('smp-result-warn')), 'partial uses the warn tone');
  assert.ok(joined.includes('fresh'), 'the installed skill is listed');
  assert.ok(joined.includes('dup') && joined.includes('bad'), 'skipped names are listed too');
  assert.ok(joined.includes('taken') && joined.includes('invalidShort'), 'each skip carries its reason');
  assert.ok(joined.includes('installResultSkippedCount'));
});

test('an archive with no usable skills says so and explains what to check', () => {
  const tree = render({
    result: { installed: [], skipped: [{ name: 'README', reason: 'invalid' }], root: '/x' },
    failure: null,
    onClose() {},
  });
  const { text, classes } = flatten(tree);
  const joined = text.join('');
  assert.ok(joined.includes('installResultNoneTitle'));
  assert.ok(classes.some((c) => c.includes('smp-result-warn')));
  assert.ok(joined.includes('installResultNoneHint'), 'the user is told what a usable archive looks like');
  // No install target is claimed when nothing was installed.
  assert.ok(!joined.includes('installResultTarget'));
});

test('a failed upload shows the error text instead of a result summary', () => {
  const tree = render({ result: null, failure: '不支持的压缩包类型（支持 zip、tar、tar.gz）', onClose() {} });
  const { text, classes } = flatten(tree);
  const joined = text.join('');
  assert.ok(joined.includes('installResultFailedTitle'));
  assert.ok(classes.some((c) => c.includes('smp-result-bad')), 'failure uses the error tone');
  assert.ok(classes.some((c) => c.includes('smp-note-error')), 'the message is shown in the error style');
  assert.ok(joined.includes('不支持的压缩包类型'), 'the host error text is surfaced verbatim');
  assert.ok(!joined.includes('installResultOkHint'));
});

test('the popup always offers a close action and Escape-to-close wiring', () => {
  const tree = render({ result: { installed: [{ name: 'x' }], skipped: [], root: '/r' }, failure: null, onClose() {} });
  // The footer is handed to the Modal shell as a prop, not as body content.
  const footer = tree.props.footer;
  assert.ok(footer, 'the popup must be dismissible via its footer button');
  assert.ok(String(footer.props.className).includes('smp-btn-primary'), 'the close action is the primary button');
  assert.equal(typeof footer.props.onClick, 'function');
  assert.equal(typeof tree.props.onClose, 'function', 'the shell needs onClose for Escape/overlay dismissal');
  assert.equal(tree.props.title, 'installResultTitle');
});

test('the component tolerates a missing/odd payload without throwing', () => {
  for (const result of [null, {}, { installed: 'nope', skipped: 42 }]) {
    assert.doesNotThrow(() => render({ result, failure: null, onClose() {} }));
  }
});

test('the extractor itself is sound, so the tests above are meaningful', () => {
  // Guard against the helper silently matching the wrong text: the real
  // component must contain the state machine it is asserting on.
  const body = extractFunction(source, 'InstallResultDialog');
  assert.match(body, /installResultOkTitle/);
  assert.match(body, /smp-result-/);
  assert.ok(body.startsWith('function InstallResultDialog('));
});
