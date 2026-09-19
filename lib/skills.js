/**
 * dsh-skills-manager-plus — skill file model.
 *
 * The harness discovers file-backed skills through its skill-filesystem
 * provider, which scans a fixed set of roots (project `.dsh/skills` and
 * `.agents/skills`, then user `~/.dsh/skills` and `~/.agents/skills`, then
 * custom and bundled roots) and parses each `<name>/SKILL.md` or flat
 * `<name>.md` for YAML frontmatter. This module mirrors that contract on the
 * host side so the settings page can list, create, edit, toggle and delete
 * skill files directly — the provider's directory watcher picks the change up
 * and the live catalogs converge on their own.
 *
 * Enabling and disabling are frontmatter edits, the one lever every layer
 * honors: disabled means `disable-model-invocation: true` (hidden from the
 * model catalog and the `skill` tool) plus `user-invocable: false` (ignored by
 * the `/name` gesture); enabled means neither key. The rewrite is line-level
 * so every other frontmatter field a skill carries survives verbatim.
 *
 * @module dsh-skills-manager-plus/skills
 */

import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

/** Kebab-case skill name grammar, identical to the harness's own. */
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** The invocation keys this manager toggles, and nothing else. */
const DISABLE_MODEL_KEY = 'disable-model-invocation';
const USER_INVOCABLE_KEY = 'user-invocable';
/** Frontmatter keys whose values this manager treats as plain strings. */
const STRING_KEYS = new Set(['name', 'description', 'whenToUse']);

/** The two directory forms a skill may take, as discovered on disk. */
function skillLocatorOf(rootDir, entryName, entryType) {
  if (entryType === 'directory') {
    return { path: join(rootDir, entryName, 'SKILL.md'), directory: join(rootDir, entryName), form: 'directory' };
  }
  if (entryType === 'file' && entryName.endsWith('.md')) {
    return { path: join(rootDir, entryName), directory: rootDir, form: 'file', baseName: entryName.slice(0, -3) };
  }
  return undefined;
}

/**
 * Parse `---`-delimited YAML frontmatter into a flat scalar map plus the
 * verbatim body. Mirrors the provider's parser for the fields this manager
 * models; nested values are kept as raw text lines so a rewrite can put them
 * back untouched.
 * @param {string} raw - the whole file text.
 * @returns {{ data: Record<string, unknown>, raw: Record<string, string>, bodyStart: number, bodyEnd: number, end: number } | undefined}
 */
export function parseFrontmatter(raw) {
  const firstLineEnd = raw.indexOf('\n');
  if (firstLineEnd < 0) return undefined;
  if (raw.slice(0, firstLineEnd).replace(/\r$/, '') !== '---') return undefined;
  let lineStart = firstLineEnd + 1;
  while (lineStart <= raw.length) {
    const nextNewline = raw.indexOf('\n', lineStart);
    const lineEnd = nextNewline < 0 ? raw.length : nextNewline;
    const line = raw.slice(lineStart, lineEnd).replace(/\r$/, '');
    if (line === '---') {
      const yaml = raw.slice(firstLineEnd + 1, lineStart);
      return {
        data: parseScalarYaml(yaml),
        raw: rawYamlLines(yaml),
        bodyStart: nextNewline < 0 ? raw.length : nextNewline + 1,
        end: lineEnd,
      };
    }
    if (nextNewline < 0) return undefined;
    lineStart = nextNewline + 1;
  }
  return undefined;
}

/** Whether a line introduces a mapping key at indentation zero. */
function keyLine(line) {
  const match = /^([A-Za-z][\w-]*)(?::(?:\s|$))/u.exec(line);
  if (match === null) return undefined;
  return { key: match[1], value: line.slice(match[0].length) };
}

/**
 * Parse zero-indentation scalar `key: value` pairs. A value this manager does
 * not model (nested block, list, multiline) is kept as raw text in the raw map
 * so rewrites restore it byte-for-byte; scalar values are decoded.
 */
function parseScalarYaml(yaml) {
  const data = {};
  const lines = yaml.split(/\r?\n/);
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (line.trim() === '') {
      index += 1;
      continue;
    }
    const keyed = keyLine(line);
    if (keyed === undefined) {
      // Continuation of something nested this parser does not model; skip to
      // the next top-level key line (deeper-indented or non-key lines belong
      // to the current value).
      index += 1;
      continue;
    }
    // Collect the full raw value: this key's line plus every following line
    // that is deeper-indented or blank-but-inside (conservatively, until the
    // next top-level key or the end).
    let end = index + 1;
    while (end < lines.length) {
      const next = lines[end];
      if (next.trim() !== '' && keyLine(next) !== undefined && /^[ \t]/u.test(next) === false) break;
      end += 1;
    }
    const rawValue = lines.slice(index, end).join('\n');
    data[keyed.key] = decodeScalar(rawValue.slice(keyed.key.length + 1));
    index = end;
  }
  return data;
}

/** Keep each top-level key's verbatim YAML text (including any nesting). */
function rawYamlLines(yaml) {
  const raw = {};
  const lines = yaml.split(/\r?\n/);
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (line.trim() === '' || keyLine(line) === undefined) {
      index += 1;
      continue;
    }
    const keyed = keyLine(line);
    let end = index + 1;
    while (end < lines.length) {
      const next = lines[end];
      if (next.trim() !== '' && keyLine(next) !== undefined && /^[ \t]/u.test(next) === false) break;
      end += 1;
    }
    raw[keyed.key] = lines.slice(index, end).join('\n');
    index = end;
  }
  return raw;
}

/** Decode a YAML scalar the way the provider's boolean/string readers will. */
function decodeScalar(text) {
  const value = text.trim();
  if (value === '') return '';
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
    return value.slice(1, -1).replaceAll("''", "'");
  }
  if (value === 'true' || value === 'True') return true;
  if (value === 'false' || value === 'False') return false;
  return value;
}

/** Render a scalar as one YAML value a YAML parser reads back identically. */
export function encodeScalar(value) {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return JSON.stringify(String(value));
}

/**
 * Rewrite a skill file's frontmatter fields and/or body, preserving every
 * unmodeled key (including nested ones) verbatim.
 *
 * @param {string} sourceText - the file's current full text.
 * @param {Record<string, string | boolean | null>} fields - values to set; `null` removes the key.
 * @param {string | undefined} body - replacement body, or `undefined` to keep it.
 * @returns {string} the new full file text.
 */
export function rewriteSkillFile(sourceText, fields, body) {
  const parsed = parseFrontmatter(sourceText);
  if (parsed === undefined) {
    // No valid frontmatter: treat the whole text as body and build fresh.
    const lines = ['---'];
    for (const [key, value] of Object.entries(fields)) {
      if (value === null) continue;
      lines.push(`${key}: ${encodeScalar(value)}`);
    }
    lines.push('---', '');
    return `${lines.join('\n')}\n${body ?? sourceText}`;
  }

  const order = [];
  const merged = {};
  for (const [key, rawText] of Object.entries(parsed.raw)) {
    order.push(key);
    merged[key] = { raw: rawText };
  }
  for (const [key, value] of Object.entries(fields)) {
    if (Object.hasOwn(merged, key)) continue;
    if (value === null) continue;
    order.push(key);
    merged[key] = { raw: null };
  }
  const lines = [];
  for (const key of order) {
    if (Object.hasOwn(fields, key)) {
      const value = fields[key];
      if (value === null) continue;
      lines.push(`${key}: ${encodeScalar(value)}`);
      continue;
    }
    lines.push(merged[key].raw);
  }
  const keptBody = sourceText.slice(parsed.bodyStart);
  const nextBody = body === undefined ? keptBody : body;
  const text = `---\n${lines.join('\n')}\n---\n${nextBody}`;
  // A body that never had a trailing newline still ends the file cleanly.
  return nextBody === '' || nextBody.endsWith('\n') ? text : `${text}\n`;
}

/**
 * Read one skill file into the manager's row shape. The path must live under
 * one of the given roots, which is how the caller scopes what is editable.
 * @returns the parsed row, or `undefined` when the file cannot be read.
 */
export function readSkillFile(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
  const parsed = parseFrontmatter(text);
  const name = typeof parsed?.data.name === 'string' ? parsed.data.name : '';
  const description = typeof parsed?.data.description === 'string' ? parsed.data.description : '';
  const disableModel = parsed?.data[DISABLE_MODEL_KEY] === true;
  const userOff = parsed?.data[USER_INVOCABLE_KEY] === false;
  return {
    text,
    name,
    description,
    whenToUse: typeof parsed?.data.whenToUse === 'string' ? parsed.data.whenToUse : '',
    modelInvocable: !disableModel,
    userInvocable: !userOff,
    hasFrontmatter: parsed !== undefined,
  };
}

/**
 * List every skill under one root directory. Entries this manager cannot model
 * (missing frontmatter, invalid name) are still reported with `invalid` set so
 * the page can explain why the harness ignores them.
 * @param {string} rootDir - absolute skill root (e.g. `~/.dsh/skills`).
 * @param {string} source - the harness source label for this root.
 * @param {object} [options] - `{ skipSystem?: boolean }`.
 * @returns skill rows; an unreadable root is an empty list, not an error.
 */
export function listSkillsInRoot(rootDir, source, options = {}) {
  let entries;
  try {
    entries = readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const rows = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (options.skipSystem && entry.name === '.system') continue;
    const type = entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other';
    const locator = skillLocatorOf(rootDir, entry.name, type);
    if (locator === undefined) continue;
    const parsed = readSkillFile(locator.path);
    if (parsed === undefined) {
      rows.push({ source, root: rootDir, path: locator.path, directory: locator.directory, form: locator.form, invalid: 'unreadable' });
      continue;
    }
    const fileDefaultName = locator.form === 'file' ? locator.baseName : entry.name;
    const invalidReason =
      !parsed.hasFrontmatter || parsed.name === '' || parsed.description === ''
        ? 'frontmatter'
        : !SKILL_NAME.test(parsed.name)
          ? 'name'
          : null;
    rows.push({
      source,
      root: rootDir,
      path: locator.path,
      directory: locator.directory,
      form: locator.form,
      fileDefaultName,
      name: parsed.name !== '' ? parsed.name : fileDefaultName,
      description: parsed.description,
      whenToUse: parsed.whenToUse,
      modelInvocable: parsed.modelInvocable,
      userInvocable: parsed.userInvocable,
      enabled: parsed.modelInvocable || parsed.userInvocable,
      invalid: invalidReason,
    });
  }
  return rows;
}

/** Validate a skill name against the harness grammar (1–64 kebab-case). */
export function validateSkillName(name) {
  if (typeof name !== 'string' || name.trim() === '') return 'empty';
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64) return 'invalid';
  return null;
}

/**
 * Persist one skill: create or update its file, moving it when the name
 * changes. Directory-form skills keep their resource directory.
 * @param {object} input - `{ root, originalPath?, name, description, whenToUse?, modelInvocable?, userInvocable?, content }`.
 * @returns `{ path, created }`.
 */
export function saveSkillFile(input) {
  const invalid = validateSkillName(input.name);
  if (invalid !== null) return { error: invalid };
  if (typeof input.description !== 'string' || input.description.trim() === '') return { error: 'description' };

  const originalPath = typeof input.originalPath === 'string' && input.originalPath !== '' ? input.originalPath : null;
  let previous = null;
  let previousForm = 'directory';
  let previousRootDir = null;
  if (originalPath !== null) {
    previous = readSkillFile(originalPath);
    if (previous === undefined) return { error: 'missing' };
    previousForm = /(^|\\|\/)SKILL\.md$/u.test(originalPath) ? 'directory' : 'file';
    previousRootDir = previousForm === 'directory' ? dirname(dirname(originalPath)) : dirname(originalPath);
  }

  const rootDir = typeof input.root === 'string' && input.root !== '' ? input.root : previousRootDir;
  if (rootDir === null) return { error: 'root' };

  // The target follows the original's form; new skills take directory form so
  // they can grow resource files later.
  const form = originalPath !== null ? previousForm : 'directory';
  const targetPath =
    form === 'directory' ? join(rootDir, input.name, 'SKILL.md') : join(rootDir, `${input.name}.md`);

  const fields = {
    name: input.name,
    description: input.description,
    whenToUse: typeof input.whenToUse === 'string' && input.whenToUse.trim() !== '' ? input.whenToUse : null,
    [DISABLE_MODEL_KEY]: input.modelInvocable === false ? true : null,
    [USER_INVOCABLE_KEY]: input.userInvocable === false ? false : null,
  };

  const body = typeof input.content === 'string' ? input.content : previous !== null ? previous.text.slice(0) : '';

  mkdirSync(form === 'directory' ? dirname(targetPath) : rootDir, { recursive: true });
  // Reserve the name first so a same-name sibling under another root cannot
  // race us between the check and the write.
  if (targetPath !== originalPath && existsSync(targetPath)) return { error: 'taken' };

  const sourceText = previous !== null && originalPath === targetPath ? previous.text : existsSync(targetPath) ? readFileSync(targetPath, 'utf8') : '';
  const text = rewriteSkillFile(sourceText, fields, body === '' ? '\n' : body.endsWith('\n') ? body : `${body}\n`);
  writeFileSync(targetPath, text, 'utf8');

  if (originalPath !== null && originalPath !== targetPath) {
    if (previousForm === 'directory') rmSync(dirname(originalPath), { recursive: true, force: true });
    else rmSync(originalPath, { force: true });
  }
  return { path: targetPath, created: originalPath === null };
}

/**
 * Set both invocation keys so the skill is fully enabled or fully hidden from
 * every surface. Enabling removes the keys entirely, which restores the
 * harness defaults; disabling writes both, which no layer can override.
 * @returns `{ path }`, or `{ error }`.
 */
export function toggleSkillFile(path, enabled) {
  const previous = readSkillFile(path);
  if (previous === undefined) return { error: 'missing' };
  const fields = enabled ? { [DISABLE_MODEL_KEY]: null, [USER_INVOCABLE_KEY]: null } : { [DISABLE_MODEL_KEY]: true, [USER_INVOCABLE_KEY]: false };
  const text = rewriteSkillFile(previous.text, fields);
  writeFileSync(path, text, 'utf8');
  return { path };
}

/**
 * Delete one skill: its instruction file, and for directory-form skills the
 * whole resource directory the file anchors.
 * @returns `{ removed: true }`, or `{ error }`.
 */
export function removeSkillFile(path) {
  if (!existsSync(path)) return { error: 'missing' };
  if (/SKILL\.md$/u.test(path)) {
    const dir = dirname(path);
    // Only remove the directory when it is exactly this skill's own folder.
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  } else {
    rmSync(path, { force: true });
  }
  return { removed: true };
}

/** Probe whether a path (or its nearest existing ancestor) is writable. */
export function isWritable(targetPath) {
  let candidate = targetPath;
  while (!existsSync(candidate)) {
    const parent = dirname(candidate);
    if (parent === candidate) break;
    candidate = parent;
  }
  try {
    accessSync(candidate, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** The harness home, honouring the `DSH_HOME` override like the provider does. */
export function dshHome() {
  const override = process.env.DSH_HOME;
  return override && override.trim() !== '' ? override : join(homedir(), '.dsh');
}

/** The shared agents home, honouring `DSH_AGENTS_HOME`. */
export function agentsHome() {
  const override = process.env.DSH_AGENTS_HOME;
  return override && override.trim() !== '' ? override : join(homedir(), '.agents');
}

/**
 * Resolve the manager's roots: user-level (global tab) plus, for each project
 * root, the two project roots. Bundled/custom roots come from the same
 * environment the provider reads, and are listed read-only.
 * @param {string[]} projectRoots - absolute project directories.
 */
export function resolveRoots(projectRoots) {
  const home = dshHome();
  const agents = agentsHome();
  const userRoots = [
    { path: join(home, 'skills'), source: 'user-dsh', scope: 'user', skipSystem: true, readOnly: false },
    { path: join(agents, 'skills'), source: 'user-agents', scope: 'user', skipSystem: false, readOnly: false },
  ];
  const bundledDir = process.env.DSH_BUNDLED_SKILL_DIR;
  if (typeof bundledDir === 'string' && bundledDir.trim() !== '' && existsSync(bundledDir)) {
    userRoots.push({ path: bundledDir, source: 'bundled', scope: 'user', skipSystem: false, readOnly: true });
  }
  const projects = projectRoots.map((root) => ({
    root,
    dirs: [
      { path: join(root, '.dsh', 'skills'), source: 'project-dsh', scope: 'project', skipSystem: false, readOnly: false },
      { path: join(root, '.agents', 'skills'), source: 'project-agents', scope: 'project', skipSystem: false, readOnly: false },
    ],
  }));
  return { userRoots, projects, userSkillsDir: join(home, 'skills') };
}

export const KEYS = { DISABLE_MODEL_KEY, USER_INVOCABLE_KEY };
