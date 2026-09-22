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
import { basename, dirname, join, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
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
    // Hidden/dot-prefixed entries (`.system`, the internal `.deleting` staging
    // folder, editor droppings) are never skills — skip them so they cannot
    // surface as bogus rows. `skipSystem` is kept for backward compatibility.
    if (entry.name.startsWith('.')) continue;
    if (options.skipSystem && entry.name === '.system') continue;
    const type = entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other';
    const locator = skillLocatorOf(rootDir, entry.name, type);
    if (locator === undefined) continue;
    const parsed = readSkillFile(locator.path);
    if (parsed === undefined) {
      // A folder with no readable SKILL.md still gets a concrete name so the
      // page can render it (and explain) instead of choking on `undefined`.
      const defaultName = locator.form === 'file' ? locator.baseName : entry.name;
      rows.push({ source, root: rootDir, path: locator.path, directory: locator.directory, form: locator.form, fileDefaultName: defaultName, name: defaultName, invalid: 'unreadable' });
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
 * whole resource directory the file anchors. On Windows a resource file held
 * open by another process (an image preview, an indexer, an editor) makes the
 * whole directory undeletable; that case is reported as `{ error: 'occupied' }`
 * instead of throwing a bare EPERM.
 * @returns `{ removed: true }`, `{ error: 'missing' }`, or `{ error: 'occupied' }`.
 */
export function removeSkillFile(path) {
  if (!existsSync(path)) return { error: 'missing' };
  try {
    if (/SKILL\.md$/u.test(path)) {
      const dir = dirname(path);
      // Only remove the directory when it is exactly this skill's own folder.
      if (existsSync(dir)) removeSkillDirectory(dir);
    } else {
      rmSync(path, { force: true });
    }
  } catch (error) {
    if (error?.code === 'ENOENT') return { removed: true }; // already gone mid-walk
    if (isBusyError(error)) return { error: 'occupied' };
    throw error;
  }
  return { removed: true };
}

/**
 * Delete one skill directory on Windows. A plain `rmSync(dir, { recursive,
 * force })` silently does nothing on some filesystems (a directory carrying
 * certain attributes, or an upstream process holding a handle) — it returns
 * success while leaving the tree intact; PowerShell's `Remove-Item` clears
 * those and works. Renaming a directory first rebuilds its directory entry so
 * the deletion actually takes effect, so the removal (and its staging folder)
 * is done by rename + recursive remove. The skill is first moved into the
 * hidden `.dsh/.deleting/` staging folder so it disappears from the scanned
 * `skills` tree at once, then both the staged copy and the (now empty) staging
 * folder are purged in the same way — no `.deleting` litter is left behind.
 */
function removeSkillDirectory(dir) {
  const parent = dirname(dir);
  const staging = join(parent, '.deleting');
  const trash = join(staging, basename(dir));
  // Clear any leftover staging from an earlier interrupted removal first, so
  // this deletion starts from a clean slate and the (now empty) staging folder
  // never lingers after the skill is gone.
  if (existsSync(staging)) {
    if (existsSync(trash)) purge(trash);
    purge(staging);
  }
  mkdirSync(staging, { recursive: true });
  // The rename is the part that has to succeed: once the skill folder moves out
  // of the scanned `skills` tree it is gone from the page.
  renameSync(dir, trash);
  purge(trash);
  purge(staging);
}

/**
 * Remove a path in a way that survives Windows filesystems where a plain
 * `rmSync` silently no-ops or deletes only part of the tree: rename to a
 * sibling temp name first, then remove recursively, retrying briefly (a rename
 * can leave the previous directory entry pending a delete that needs a moment
 * to release). If node still leaves a remnant, fall back to PowerShell's
 * `Remove-Item`, which deletes at the OS level. Best-effort — on a non-Windows
 * host, or if every attempt is resisted, any reluctant remnant stays hidden
 * (dot-prefixed) and is pruned on the next removal.
 */
function purge(path) {
  if (!existsSync(path)) return;
  const tmp = `${path}.__purge__`;
  try {
    if (existsSync(tmp)) rmDeep(tmp);
    renameSync(path, tmp);
  } catch {
    return; // busy: leave the (hidden) path for a later attempt
  }
  rmDeep(tmp);
}

/** Remove a tree `rmSync`-style; a silent no-op also counts as failure, so
 * verify by re-checking the path, retry briefly, then try the OS cli. */
function rmDeep(path) {
  const attempts = 3;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {
      // fell through to retry / fallback below
    }
    if (!existsSync(path)) return;
    if (attempt < attempts - 1) sleepSync(60);
  }
  if (process.platform === 'win32') rimrafViaPowerShell(path);
}

/** Block briefly so a just-renamed directory's delete handle can release. */
function sleepSync(ms) {
  const s = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(s, 0, 0, ms);
}

/** Delete a directory tree with PowerShell, the most reliable Win32 path. */
function rimrafViaPowerShell(path) {
  try {
    execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', `Remove-Item -LiteralPath "${path}" -Recurse -Force`],
      { windowsHide: true, stdio: 'ignore' },
    );
  } catch {
    // give up: the remnant stays hidden and is retried on a later removal
  }
}

/** The errors a locked/occupied file produces on Windows. */
function isBusyError(error) {
  const code = typeof error?.code === 'string' ? error.code : '';
  return code === 'EPERM' || code === 'EBUSY' || code === 'ENOTEMPTY' || code === 'EACCES';
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

/**
 * Install one or more skills from an already-extracted archive into a skill
 * root. Each `SKILL.md` inside a directory becomes a directory-form skill (its
 * whole folder, including resource files, is copied), and every top-level
 * `<name>.md` becomes a flat file-form skill. The skill name comes from the
 * file's `name` frontmatter; a name that is invalid or already present on disk
 * is skipped and reported rather than overwritten. Archive paths are assumed
 * to already be normalized (see `lib/archives.js`); a residual `..`/absolute
 * path is silently refused so nothing is ever written outside `rootDir`.
 *
 * A single wrapping folder is peeled first (see `unwrapSingleRoot`) so the
 * shapes real downloads come in — a GitHub "Download ZIP" (`repo-main/<skill>
 * /SKILL.md`) or a collection (`repo-main/skills/<skill>/SKILL.md`) — install
 * their skills rather than failing on the wrapper.
 *
 * @param {string} rootDir - absolute skill root to install into.
 * @param {{ name: string, data: Buffer }[]} entries - archive entries.
 * @returns {{ installed: {name: string, path: string}[], skipped: {name: string, reason: string}[] }}
 */
export function installSkillArchive(rootDir, entries) {
  const result = { installed: [], skipped: [] };

  // Normalize once, then peel any wrapper folder.
  const files = [];
  for (const entry of entries) {
    if (typeof entry?.name !== 'string' || typeof entry.data === 'undefined') continue;
    const safeRel = safeArchiveRel(entry.name);
    if (safeRel === null || safeRel.endsWith('/')) continue;
    files.push({ name: safeRel, data: entry.data });
  }

  const byDir = new Map(); // dir -> Map<rel, Buffer> for the files under it
  const topLevel = []; // files at the archive root, classified after the scan
  let rootSkill = null; // the root `SKILL.md` body, when the archive root is a skill

  for (const file of unwrapSingleRoot(files)) {
    const slash = file.name.indexOf('/');
    if (slash === -1) {
      // A root `SKILL.md` means the whole archive is one skill (the
      // skillhub.cn bundle shape), so its root files are that skill's
      // resources; whether the other `.md` files are flat skills can only be
      // decided once the scan is done.
      if (file.name === 'SKILL.md') rootSkill = file.data;
      else topLevel.push(file);
      continue;
    }
    const dir = file.name.slice(0, slash);
    const rest = file.name.slice(slash + 1);
    // Create the slot the first time any file under the folder is seen, so a
    // tar that lists resources before SKILL.md still works.
    if (!byDir.has(dir)) byDir.set(dir, new Map());
    byDir.get(dir).set(rest, file.data);
  }

  /**
   * Write one skill directory. `contents` maps a path relative to the skill
   * folder to its bytes.
   * @returns true when the skill was written, false when it was skipped.
   */
  function writeSkill(name, contents) {
    const target = join(rootDir, name);
    if (existsSync(target)) {
      result.skipped.push({ name, reason: 'taken' });
      return false;
    }
    mkdirSync(target, { recursive: true });
    for (const [rel, data] of contents) {
      const safeRel = safeArchiveRel(rel);
      if (safeRel === null) continue;
      const filePath = join(target, safeRel);
      if ((filePath + sep).startsWith(target + sep)) {
        mkdirSync(dirname(filePath), { recursive: true });
        writeFileSync(filePath, data);
      }
    }
    result.installed.push({ name, path: join(target, 'SKILL.md') });
    return true;
  }

  // The archive root is itself one skill: `SKILL.md` plus every sibling folder
  // and loose file become the contents of the installed skill directory.
  if (rootSkill !== null) {
    const name = validSkillNameFromText(rootSkill);
    if (name === null) {
      result.skipped.push({ name: 'SKILL.md', reason: 'invalid' });
    } else {
      const contents = new Map([['SKILL.md', rootSkill]]);
      // Every other root file belongs to this skill — a `README.md`, a
      // `LICENSE`, a `_meta.json` — so none of them is a flat-skill candidate.
      for (const file of topLevel) contents.set(file.name, file.data);
      for (const [dir, sub] of byDir) {
        for (const [rel, data] of sub) contents.set(dir + '/' + rel, data);
      }
      writeSkill(name, contents);
    }
  } else {
    for (const [dir, contents] of byDir) {
      const skill = contents.get('SKILL.md');
      // A folder without a `SKILL.md` is a resource-only folder, not a broken
      // skill, so it is ignored instead of surfacing as a skipped skill.
      if (skill === undefined) continue;
      const name = validSkillNameFromText(skill);
      if (name === null) {
        result.skipped.push({ name: dir, reason: 'invalid' });
        continue;
      }
      writeSkill(name, contents);
    }
  }

  // Without a root `SKILL.md`, root-level `<name>.md` files are flat-file
  // skills in their own right.
  const flatFiles = rootSkill !== null ? [] : topLevel.filter((file) => file.name.endsWith('.md'));

  for (const file of flatFiles) {
    // A root-level `.md` is only a flat-skill candidate when it carries YAML
    // frontmatter; a `README.md`/`LICENSE.md` is an archive extra, not a broken
    // skill, so it is ignored instead of surfacing as a skipped skill.
    if (parseFrontmatter(stripBom(file.data.toString('utf8'))) === undefined) continue;
    const name = validSkillNameFromText(file.data);
    if (name === null) {
      result.skipped.push({ name: file.name.slice(0, -3), reason: 'invalid' });
      continue;
    }
    const target = join(rootDir, `${name}.md`);
    if (existsSync(target)) {
      result.skipped.push({ name, reason: 'taken' });
      continue;
    }
    // A flat-only archive never creates the root through the directory-form
    // path above, so make sure it exists before writing the first file.
    mkdirSync(rootDir, { recursive: true });
    writeFileSync(target, file.data);
    result.installed.push({ name, path: target });
  }

  return result;
}

/**
 * Peel wrapping directories from an archive's file list.
 *
 * Zips are almost never rooted where the skills are: GitHub's "Download ZIP"
 * and tarballs wrap everything in `repo-main/`, and skill collections add
 * another level (`repo-main/skills/`). Grouping by the first path segment
 * would then see one unusable folder and skip the whole archive, so a lone
 * top-level folder that does not itself hold a `SKILL.md` is stripped and the
 * check repeats, walking down through nested wrappers.
 *
 * Only top-level *directories* are considered: a repo zip usually carries
 * `LICENSE`/`README.md` beside the folder, and those files must not block the
 * descent. The `SKILL.md` guard is what keeps a real bundle intact — in
 * `<skill>/SKILL.md` + `<skill>/notes.md` the folder *is* the skill, so
 * stripping it would flatten the skill away. Only wrappers are removed.
 *
 * @param {{ name: string, data: Buffer }[]} files - normalized entries.
 * @returns {{ name: string, data: Buffer }[]} the entries to classify.
 */
function unwrapSingleRoot(files) {
  let current = files;
  // Bounded so a pathological archive cannot spin; real wrappers are 1–2 deep.
  for (let depth = 0; depth < 8; depth += 1) {
    // A `SKILL.md` at the root means the archive root IS the skill, so its
    // subdirectories are its resource folders (`references/`, `assets/`) and
    // must never be peeled off as if they were wrappers.
    if (current.some((file) => file.name === 'SKILL.md')) return current;

    const tops = new Set();
    for (const file of current) {
      const slash = file.name.indexOf('/');
      // A top-level file (LICENSE, README.md) is not a wrapper and does not
      // block the descent; it is just left where it is.
      if (slash === -1) continue;
      tops.add(file.name.slice(0, slash));
      // Several top-level folders mean a genuine multi-skill archive.
      if (tops.size > 1) return current;
    }
    if (tops.size !== 1) return current;
    const top = [...tops][0];
    // The folder is itself a skill: never strip it.
    if (current.some((file) => file.name === `${top}/SKILL.md`)) return current;

    const stripped = [];
    let changed = false;
    for (const file of current) {
      if (!file.name.startsWith(`${top}/`)) {
        stripped.push(file); // a stray top-level file is carried along
        continue;
      }
      changed = true;
      const name = file.name.slice(top.length + 1);
      if (name !== '') stripped.push({ name, data: file.data });
    }
    if (!changed) return current;
    current = stripped;
  }
  return current;
}

/**
 * Extract a skill's `name` from a SKILL/.md body, returning it only when it
 * satisfies the harness grammar and a description is present. `null` means the
 * entry is not a loadable skill.
 */
function validSkillNameFromText(buffer) {
  const parsed = parseFrontmatter(stripBom(buffer.toString('utf8')));
  if (parsed === undefined || parsed.data.name === undefined || parsed.data.description === undefined) return null;
  const name = typeof parsed.data.name === 'string' ? parsed.data.name : '';
  const description = typeof parsed.data.description === 'string' ? parsed.data.description : '';
  if (name === '' || description === '' ) return null;
  return validateSkillName(name) === null ? name : null;
}

/**
 * Strip a UTF-8 byte-order mark, which some downloaded files carry and which
 * otherwise breaks frontmatter detection.
 */
function stripBom(text) {
  return text.startsWith('\uFEFF') ? text.slice(1) : text;
}

/**
 * Confine a relative path for writing. Returns a `..`-free, non-absolute
 * relative path, or `null` when the entry could escape the target dir.
 */
function safeArchiveRel(raw) {
  if (typeof raw !== 'string' || raw.includes('\0')) return null;
  const segments = raw.split('/');
  const out = [];
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..' || /^[A-Za-z]:/u.test(segment)) return null;
    out.push(segment);
  }
  if (out.length === 0) return null;
  if (out[0].startsWith('/') || out[0].startsWith('\\')) return null;
  return out.join('/');
}

export const KEYS = { DISABLE_MODEL_KEY, USER_INVOCABLE_KEY };
