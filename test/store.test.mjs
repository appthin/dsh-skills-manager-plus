/**
 * Pure-logic tests for the skill and command stores (lib/skills.js and
 * lib/commands.js). No harness involved: everything here is file I/O over temp
 * directories with `DSH_HOME` / `DSH_AGENTS_HOME` pointed at them.
 *
 * Run with:  node test/store.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  parseFrontmatter,
  rewriteSkillFile,
  readSkillFile,
  listSkillsInRoot,
  saveSkillFile,
  toggleSkillFile,
  removeSkillFile,
  validateSkillName,
  isWritable,
  dshHome,
  agentsHome,
  resolveRoots,
  KEYS,
} from '../lib/skills.js';
import {
  commandsDir,
  listCommandFiles,
  saveCommandFile,
  removeCommandFile,
  validateCommandName,
  commandDefinitionOf,
} from '../lib/commands.js';

/** Create a throwaway home under the OS tmp dir. */
function tempHome() {
  const dir = mkdtempSync(join(tmpdir(), 'smp-store-'));
  process.env.DSH_HOME = join(dir, 'dsh');
  process.env.DSH_AGENTS_HOME = join(dir, 'agents');
  return dir;
}

// ── frontmatter parsing & rewriting ──────────────────────────────────────────

test('parseFrontmatter reads scalar keys; nested/list values survive as raw', () => {
  const raw = '---\nname: code-review\ndescription: "Say hi"\nenable: true\ncount: 3\nargs:\n  - a\n  - b\n---\nBODY HERE\n';
  const parsed = parseFrontmatter(raw);
  assert.ok(parsed);
  assert.equal(parsed.data.name, 'code-review');
  assert.equal(parsed.data.description, 'Say hi');
  assert.equal(parsed.data.enable, true);
  // An unmodeled (nested list) value is kept as raw continuation text, not dropped.
  assert.ok(parsed.data.args.includes('- a'));
  assert.equal(raw.slice(parsed.bodyStart), 'BODY HERE\n');
  assert.ok(parsed.raw.args.includes('- a'));
});

test('parseFrontmatter returns undefined for text without the opener', () => {
  assert.equal(parseFrontmatter('no frontmatter\n---\nname: x\n---\nbody'), undefined);
  assert.equal(parseFrontmatter('ordinary text with no delimiter'), undefined);
});

test('rewriteSkillFile preserves unmodeled keys byte-for-byte and swaps body', () => {
  const raw = '---\nname: old\ndescription: keep me\nunmodeled:\n  nested: true\n---\nOLD BODY\n';
  const next = rewriteSkillFile(raw, { name: 'neu', description: 'new desc', whenToUse: 'use it' }, 'NEW BODY');
  assert.ok(next.startsWith('---\n'));
  assert.ok(next.includes('unmodeled:\n  nested: true'), 'nested unmodeled key survives');
  assert.ok(next.includes('name: "neu"'));
  assert.ok(next.includes('whenToUse: "use it"'));
  assert.ok(next.includes('NEW BODY'));
  assert.ok(!next.includes('OLD BODY'));
});

test('rewriteSkillFile removed a key when passed null', () => {
  const raw = '---\nname: x\ndescription: y\nwhenToUse: gone\n---\nbody\n';
  const next = rewriteSkillFile(raw, { whenToUse: null });
  assert.ok(!next.includes('whenToUse'));
  // Untouched keys are preserved verbatim (raw `key: value`, not re-encoded).
  assert.ok(next.includes('name: x'));
  assert.ok(next.includes('description: y'));
});

test('rewriteSkillFile builds fresh frontmatter when none exists', () => {
  const next = rewriteSkillFile('just some text', { name: 'a', description: 'b' }, 'new body');
  assert.ok(next.startsWith('---\nname: "a"\ndescription: "b"\n---\n'));
  assert.ok(next.endsWith('new body'));
});

// ── skill name validation ────────────────────────────────────────────────────

test('validateSkillName enforces kebab-case and length', () => {
  assert.equal(validateSkillName('code-review'), null);
  assert.equal(validateSkillName(''), 'empty');
  assert.equal(validateSkillName('  '), 'empty');
  assert.equal(validateSkillName('Upper'), 'invalid');
  assert.equal(validateSkillName('under_score'), 'invalid');
  assert.equal(validateSkillName('a'.repeat(65)), 'invalid');
  assert.equal(validateSkillName('a-b-c'), null);
});

// ── skill file CRUD ─────────────────────────────────────────────────────────

test('saveSkillFile creates a directory-form skill and reads back', () => {
  tempHome();
  const root = join(dshHome(), 'skills');
  const result = saveSkillFile({ root, name: 'my-skill', description: 'Does things', content: '# Steps\n1. do' });
  assert.equal(result.error, undefined);
  const path = join(root, 'my-skill', 'SKILL.md');
  assert.equal(result.path, path);
  assert.equal(result.created, true);
  assert.ok(existsSync(path));

  const parsed = readSkillFile(path);
  assert.equal(parsed.name, 'my-skill');
  assert.equal(parsed.description, 'Does things');
  assert.equal(parsed.modelInvocable, true);
  assert.equal(parsed.userInvocable, true);

  const rows = listSkillsInRoot(root, 'user-dsh', { skipSystem: true });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'my-skill');
  assert.equal(rows[0].invalid, null);
});

test('saveSkillFile refuses a duplicate name and invalid input', () => {
  tempHome();
  const root = join(dshHome(), 'skills');
  const first = saveSkillFile({ root, name: 'dup', description: 'x', content: '' });
  assert.equal(first.error, undefined);
  const dup = saveSkillFile({ root, name: 'dup', description: 'y', content: '' });
  assert.equal(dup.error, 'taken');
  assert.equal(saveSkillFile({ root, name: 'BAD', description: 'y', content: '' }).error, 'invalid');
  assert.equal(saveSkillFile({ root, name: 'ok', description: '  ', content: '' }).error, 'description');
});

test('toggleSkillFile flips both invocation keys and back', () => {
  tempHome();
  const root = join(dshHome(), 'skills');
  const { path } = saveSkillFile({ root, name: 'togglable', description: 'd', content: '' });
  const off = toggleSkillFile(path, false);
  assert.equal(off.error, undefined);
  const disabled = readSkillFile(path);
  assert.equal(disabled.modelInvocable, false);
  assert.equal(disabled.userInvocable, false);
  const on = toggleSkillFile(path, true);
  assert.equal(on.error, undefined);
  const reenabled = readSkillFile(path);
  assert.equal(reenabled.modelInvocable, true);
  assert.equal(reenabled.userInvocable, true);
  assert.ok(!readFileSync(path, 'utf8').includes(KEYS.DISABLE_MODEL_KEY), 'disable-model-invocation removed on enable');
});

test('removeSkillFile deletes the whole directory form', () => {
  tempHome();
  const root = join(dshHome(), 'skills');
  const { path } = saveSkillFile({ root, name: 'bye', description: 'd', content: '' });
  assert.ok(existsSync(join(root, 'bye')));
  assert.equal(removeSkillFile(path).removed, true);
  assert.ok(!existsSync(join(root, 'bye')));
  assert.equal(removeSkillFile(path).error, 'missing');
});

test('listSkillsInRoot reports invalid frontmatter as invalid, not an error', () => {
  tempHome();
  const root = join(dshHome(), 'skills');
  mkdirSync(join(root, 'orphan'), { recursive: true });
  // Directory whose SKILL.md lacks valid name/description frontmatter.
  writeFileSync(join(root, 'orphan', 'SKILL.md'), 'no frontmatter\n');
  const rows = listSkillsInRoot(root, 'user-dsh');
  const orphan = rows.find((r) => r.name === 'orphan');
  assert.ok(orphan, 'broken-frontmatter skill is still listed, not dropped');
  assert.equal(orphan.invalid, 'frontmatter');
});

// ── command CRUD ─────────────────────────────────────────────────────────────

test('commandsDir follows DSH_HOME', () => {
  tempHome();
  assert.ok(commandsDir().endsWith('commands'));
});

test('saveCommandFile writes name/description/argument-hint frontmatter + body', () => {
  tempHome();
  const result = saveCommandFile({ name: 'deploy-check', description: 'Run the deploy checks', argumentHint: '<env>', content: 'Run all deploy checks for the given environment.' });
  assert.equal(result.error, undefined);
  assert.equal(result.created, true);
  const path = join(commandsDir(), 'deploy-check.md');
  assert.equal(result.path, path);
  const text = readFileSync(path, 'utf8');
  assert.ok(text.includes('argument-hint: "<env>"'));
  assert.ok(text.includes('Run all deploy checks'));

  const rows = listCommandFiles();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'deploy-check');
  assert.equal(rows[0].argumentHint, '<env>');
  assert.equal(rows[0].invalid, null);
});

test('listCommandFiles honors the disabled set and validation', () => {
  tempHome();
  saveCommandFile({ name: 'one', description: 'd1', content: 'x' });
  saveCommandFile({ name: 'two', description: 'd2', content: 'y' });
  const disabled = new Set(['two']);
  const rows = listCommandFiles(disabled);
  assert.equal(rows.length, 2);
  const two = rows.find((r) => r.name === 'two');
  assert.equal(two.enabled, false);
  assert.equal(rows.find((r) => r.name === 'one').enabled, true);
});

test('validateCommandName follows the registry grammar', () => {
  assert.equal(validateCommandName('deploy_check'), null);
  assert.equal(validateCommandName('Deploy'), 'invalid');
  assert.equal(validateCommandName('1abc'), 'invalid');
  assert.equal(validateCommandName(''), 'empty');
});

test('saveCommandFile rename rewrites the file and refuses collisions', () => {
  tempHome();
  const first = saveCommandFile({ name: 'aaa', description: 'd', content: 'x' });
  saveCommandFile({ name: 'bbb', description: 'd', content: 'y' });
  const renamed = saveCommandFile({ originalName: 'aaa', name: 'ccc', description: 'd2', content: 'z' });
  assert.equal(renamed.error, undefined);
  assert.ok(!existsSync(join(commandsDir(), 'aaa.md')));
  assert.ok(existsSync(join(commandsDir(), 'ccc.md')));
  const collide = saveCommandFile({ name: 'bbb', description: 'oops', content: '' });
  assert.equal(collide.error, 'taken');
});

test('removeCommandFile deletes by name', () => {
  tempHome();
  saveCommandFile({ name: 'temp', description: 'd', content: '' });
  assert.equal(removeCommandFile('temp').removed, true);
  assert.equal(removeCommandFile('temp').error, 'missing');
});

test('commandDefinitionOf builds a handler that follows up with the prompt', () => {
  const row = { name: 'check', description: 'd', argumentHint: '<x>', content: 'Please check.\n' };
  const def = commandDefinitionOf(row);
  assert.equal(def.name, 'check');
  assert.deepEqual(def.input, { hint: '<x>' });
  assert.equal(def.recordInput, false);

  const followups = [];
  const invocation = { agent: { followup: (msg) => followups.push(msg) }, rawInput: 'with extra' };
  const result = def.handler(invocation);
  assert.equal(result.kind, 'success');
  assert.equal(followups.length, 1);
  assert.equal(followups[0].role, 'user');
  assert.equal(followups[0].content[0].text, 'Please check.\n\nwith extra');

  const bare = def.handler({ agent: { followup: (msg) => followups.push(msg) }, rawInput: '' });
  assert.equal(bare.kind, 'success');
  assert.ok(followups[1].content[0].text.endsWith('Please check.'));
});

// ── roots & writability ─────────────────────────────────────────────────────

test('resolveRoots honors DSH_HOME / DSH_AGENTS_HOME and project roots', () => {
  tempHome();
  const roots = resolveRoots(['C:/proj/alpha']);
  const sources = roots.userRoots.map((r) => r.source);
  assert.ok(sources.includes('user-dsh'));
  assert.ok(sources.includes('user-agents'));
  assert.equal(roots.userRoots.find((r) => r.source === 'user-dsh').path, join(dshHome(), 'skills'));
  assert.equal(roots.userRoots.find((r) => r.source === 'user-agents').path, join(agentsHome(), 'skills'));
  const project = roots.projects.find((p) => p.root === 'C:/proj/alpha');
  assert.ok(project.dirs.some((d) => d.source === 'project-dsh'));
  assert.ok(project.dirs.some((d) => d.source === 'project-agents'));
});

test('isWritable probes the nearest existing ancestor', () => {
  tempHome();
  assert.equal(isWritable(join(dshHome(), 'skills')), true); // DSH_HOME was created writable
});