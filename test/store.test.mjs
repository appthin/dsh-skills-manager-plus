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
import { chdir, cwd } from 'node:process';

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
  installSkillArchive,
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

test('removeSkillFile reports an undeletable skill directory as occupied, not a raw EPERM', { skip: process.platform !== 'win32' }, () => {
  // On Windows a directory can be the current working directory of a process,
  // which makes the OS refuse to delete it (EPERM) — the same class of failure
  // a resource file held open by another program causes. Make the skill folder
  // undeletable, delete, then leave and clean up.
  tempHome();
  const root = join(dshHome(), 'skills');
  const { path } = saveSkillFile({ root, name: 'locked', description: 'd', content: '' });
  const skillDir = join(root, 'locked');
  const previous = cwd();
  chdir(skillDir);
  try {
    const result = removeSkillFile(path);
    assert.deepEqual(result, { error: 'occupied' });
  } finally {
    chdir(previous);
    // Moving out means the plain delete now succeeds; leave a clean temp home.
    removeSkillFile(path);
  }
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

test('listSkillsInRoot skips hidden dot-directories and names unreadable entries', () => {
  tempHome();
  const root = join(dshHome(), 'skills');
  // A hidden/staging folder (`.deleting`, `.system`) is never a skill.
  mkdirSync(join(root, '.deleting'), { recursive: true });
  // A folder with no readable SKILL.md must still surface with a concrete name,
  // so the page renders it instead of choking on `undefined`.
  mkdirSync(join(root, 'ghost'), { recursive: true });

  const rows = listSkillsInRoot(root, 'user-dsh');
  assert.ok(!rows.some((r) => r.name === '.deleting'), 'hidden folders are not listed as skills');
  const ghost = rows.find((r) => r.name === 'ghost');
  assert.ok(ghost, 'an unreadable skill dir is reported');
  assert.equal(ghost.invalid, 'unreadable');
  assert.equal(typeof ghost.name, 'string', 'the unreadable row carries a usable name');
  assert.ok(ghost.name.length > 0, '…that name is non-empty');
  assert.ok(!rows.some((r) => r.name === undefined), 'no row exposes an undefined name');
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

// ── installing skills from an archive ───────────────────────────────────────

/** A loadable skill body with the frontmatter the harness requires. */
function skillBody(name, description = 'a description') {
  return Buffer.from(`---\nname: ${name}\ndescription: ${description}\n---\nbody for ${name}\n`, 'utf8');
}

test('installSkillArchive peels a wrapper folder to reach the skill inside', () => {
  const root = join(tempHome(), 'skills-target');
  const result = installSkillArchive(root, [
    { name: 'bundle/alpha/SKILL.md', data: skillBody('alpha') },
    { name: 'bundle/alpha/notes.md', data: Buffer.from('extra', 'utf8') },
    { name: 'bundle/README.md', data: Buffer.from('not a skill', 'utf8') },
  ]);
  // `bundle` is a wrapper (it holds no SKILL.md of its own), so it is stripped
  // and `alpha` installs. The wrapper's README carries no frontmatter, so it is
  // not a skill candidate and is ignored instead of reported as skipped.
  assert.deepEqual(result.installed.map((s) => s.name), ['alpha']);
  assert.deepEqual(result.skipped, []);
  assert.ok(existsSync(join(root, 'alpha', 'SKILL.md')));
  assert.ok(existsSync(join(root, 'alpha', 'notes.md')), 'resource files come along');
  assert.ok(!existsSync(join(root, 'bundle')), 'the wrapper folder itself is not installed');
});

test('installSkillArchive unwraps a GitHub "Download ZIP" layout', () => {
  // Regression: every entry nested under `repo-main/` used to be reported as
  // one unusable folder, so nothing installed from a GitHub zip or tarball.
  const root = join(tempHome(), 'skills-github');
  const result = installSkillArchive(root, [
    { name: 'repo-main/README.md', data: Buffer.from('# repo', 'utf8') },
    { name: 'repo-main/my-skill/SKILL.md', data: skillBody('my-skill') },
    { name: 'repo-main/my-skill/scripts/run.md', data: Buffer.from('run', 'utf8') },
  ]);
  assert.deepEqual(result.installed.map((s) => s.name), ['my-skill']);
  assert.ok(existsSync(join(root, 'my-skill', 'SKILL.md')));
  assert.ok(existsSync(join(root, 'my-skill', 'scripts', 'run.md')), 'nested resources survive unwrapping');
});

test('installSkillArchive unwraps nested wrappers and installs every skill found', () => {
  const root = join(tempHome(), 'skills-nested');
  const result = installSkillArchive(root, [
    { name: 'repo-main/skills/one/SKILL.md', data: skillBody('one') },
    { name: 'repo-main/skills/two/SKILL.md', data: skillBody('two') },
    { name: 'repo-main/LICENSE', data: Buffer.from('mit', 'utf8') },
  ]);
  assert.deepEqual(result.installed.map((s) => s.name).sort(), ['one', 'two']);
  assert.ok(existsSync(join(root, 'one', 'SKILL.md')));
  assert.ok(existsSync(join(root, 'two', 'SKILL.md')));
});

test('installSkillArchive installs an archive whose SKILL.md sits at the root', () => {
  // The skillhub.cn bundle shape: SKILL.md at the archive root with its
  // resources in sibling folders. Regression: the lone `references/` folder was
  // peeled as a wrapper and the root SKILL.md was ignored, so nothing installed.
  const root = join(tempHome(), 'skills-root');
  const result = installSkillArchive(root, [
    { name: 'SKILL.md', data: skillBody('novel-writer') },
    { name: 'references/writing-guide.md', data: Buffer.from('guide', 'utf8') },
    { name: '_meta.json', data: Buffer.from('{"slug":"x"}', 'utf8') },
  ]);
  assert.deepEqual(result.installed.map((s) => s.name), ['novel-writer']);
  assert.deepEqual(result.skipped, []);
  assert.ok(existsSync(join(root, 'novel-writer', 'SKILL.md')));
  // The sibling folder is the skill's resource directory, not a wrapper.
  assert.ok(existsSync(join(root, 'novel-writer', 'references', 'writing-guide.md')));
  assert.ok(existsSync(join(root, 'novel-writer', '_meta.json')));
});

test('a root SKILL.md is not mistaken for a wrapper, even with several folders', () => {
  const root = join(tempHome(), 'skills-root-multi');
  const result = installSkillArchive(root, [
    { name: 'SKILL.md', data: skillBody('multi') },
    { name: 'references/a.md', data: Buffer.from('a', 'utf8') },
    { name: 'assets/logo.svg', data: Buffer.from('<svg/>', 'utf8') },
  ]);
  assert.deepEqual(result.installed.map((s) => s.name), ['multi']);
  assert.ok(existsSync(join(root, 'multi', 'references', 'a.md')));
  assert.ok(existsSync(join(root, 'multi', 'assets', 'logo.svg')));
});

test('a root SKILL.md keeps every root file as part of the skill', () => {
  // Consistency: with a root SKILL.md the whole archive is one skill, so a
  // README/LICENSE/helper.md belongs to it. Previously a non-skill README was
  // excluded and falsely reported as a skipped skill, while LICENSE was copied.
  const root = join(tempHome(), 'skills-root-files');
  const result = installSkillArchive(root, [
    { name: 'SKILL.md', data: skillBody('hub') },
    { name: 'README.md', data: Buffer.from('# no frontmatter', 'utf8') },
    { name: 'LICENSE', data: Buffer.from('mit', 'utf8') },
    { name: 'references/a.md', data: Buffer.from('a', 'utf8') },
  ]);
  assert.deepEqual(result.installed.map((s) => s.name), ['hub']);
  assert.deepEqual(result.skipped, [], 'nothing is reported as a skipped skill');
  for (const rel of ['SKILL.md', 'README.md', 'LICENSE', 'references/a.md']) {
    assert.ok(existsSync(join(root, 'hub', ...rel.split('/'))), `${rel} must be kept inside the skill`);
  }
});

test('a root SKILL.md with invalid frontmatter is reported, not silently dropped', () => {
  const root = join(tempHome(), 'skills-root-bad');
  const result = installSkillArchive(root, [
    { name: 'SKILL.md', data: Buffer.from('---\nname: Bad Name\ndescription: d\n---\nx\n', 'utf8') },
    { name: 'references/a.md', data: Buffer.from('a', 'utf8') },
  ]);
  assert.deepEqual(result.installed, []);
  assert.deepEqual(result.skipped, [{ name: 'SKILL.md', reason: 'invalid' }]);
});

test('installSkillArchive never strips a folder that is itself the skill', () => {
  // The wrapper guard: `<skill>/SKILL.md` means `<skill>` is the skill, so
  // peeling it would delete the skill instead of installing it.
  const root = join(tempHome(), 'skills-keep');
  const result = installSkillArchive(root, [
    { name: 'solo/SKILL.md', data: skillBody('solo') },
    { name: 'solo/README.md', data: Buffer.from('# inside the skill', 'utf8') },
    { name: 'solo/reference/api.md', data: Buffer.from('api', 'utf8') },
  ]);
  assert.deepEqual(result.installed.map((s) => s.name), ['solo']);
  assert.ok(existsSync(join(root, 'solo', 'SKILL.md')));
  assert.ok(existsSync(join(root, 'solo', 'README.md')), 'files inside the skill are kept');
  assert.ok(existsSync(join(root, 'solo', 'reference', 'api.md')));
  assert.deepEqual(result.skipped, []);
});

test('installSkillArchive installs a wrapper holding both a skill and a flat skill', () => {
  const root = join(tempHome(), 'skills-mixed');
  const result = installSkillArchive(root, [
    { name: 'repo-main/dir-one/SKILL.md', data: skillBody('dir-one') },
    { name: 'repo-main/flat-one.md', data: skillBody('flat-one') },
  ]);
  assert.deepEqual(result.installed.map((s) => s.name).sort(), ['dir-one', 'flat-one']);
  assert.ok(existsSync(join(root, 'dir-one', 'SKILL.md')));
  assert.ok(existsSync(join(root, 'flat-one.md')));
});

test('installSkillArchive installs a top-level directory-form skill with resources', () => {
  const root = join(tempHome(), 'skills-dir');
  const result = installSkillArchive(root, [
    { name: 'alpha/SKILL.md', data: skillBody('alpha') },
    { name: 'alpha/notes.md', data: Buffer.from('extra', 'utf8') },
    { name: 'alpha/scripts/run.md', data: Buffer.from('nested', 'utf8') },
  ]);
  assert.deepEqual(result.installed.map((s) => s.name), ['alpha']);
  assert.ok(existsSync(join(root, 'alpha', 'SKILL.md')));
  assert.ok(existsSync(join(root, 'alpha', 'notes.md')), 'resource files come along');
  assert.ok(existsSync(join(root, 'alpha', 'scripts', 'run.md')), 'nested resources come along');
  assert.ok(!existsSync(join(root, 'README.md')));
});

test('installSkillArchive installs a flat <name>.md skill into a missing root', () => {
  // Regression: a flat-only archive must create the root itself. Only the
  // directory-form path used to mkdir, so this threw ENOENT.
  const root = join(tempHome(), 'skills-flat');
  assert.equal(existsSync(root), false);
  const result = installSkillArchive(root, [{ name: 'flat-one.md', data: skillBody('flat-one') }]);
  assert.deepEqual(result.installed.map((s) => s.name), ['flat-one']);
  assert.ok(existsSync(join(root, 'flat-one.md')));
});

test('installSkillArchive skips taken names and invalid frontmatter', () => {
  const root = join(tempHome(), 'skills-skip');
  installSkillArchive(root, [{ name: 'dup/SKILL.md', data: skillBody('dup') }]);
  const again = installSkillArchive(root, [
    { name: 'dup/SKILL.md', data: skillBody('dup') },
    { name: 'bad/SKILL.md', data: Buffer.from('---\nname: Bad Name\ndescription: d\n---\nx\n', 'utf8') },
    { name: 'nodesc/SKILL.md', data: Buffer.from('---\nname: nodesc\n---\nx\n', 'utf8') },
    { name: 'plain.md', data: Buffer.from('no frontmatter here\n', 'utf8') },
  ]);
  assert.deepEqual(again.installed, []);
  // `plain.md` carries no frontmatter, so it is not a skill candidate and is
  // ignored rather than reported; genuine frontmatter failures still surface.
  assert.deepEqual(
    again.skipped.map((s) => [s.name, s.reason]),
    [['dup', 'taken'], ['bad', 'invalid'], ['nodesc', 'invalid']],
  );
  // The existing skill was not overwritten.
  assert.ok(readFileSync(join(root, 'dup', 'SKILL.md'), 'utf8').includes('body for dup'));
});

test('installSkillArchive refuses entries that would escape the target root', () => {
  const root = join(tempHome(), 'skills-escape');
  const outside = join(root, '..', 'escaped.md');
  const result = installSkillArchive(root, [
    { name: '../escaped.md', data: skillBody('escaped') },
    { name: 'ok/SKILL.md', data: skillBody('ok') },
  ]);
  assert.deepEqual(result.installed.map((s) => s.name), ['ok']);
  assert.ok(!existsSync(outside), 'a `..` entry never lands outside the root');
});
