/**
 * dsh-skills-manager-plus — saved-prompt command store.
 *
 * A saved command is one markdown file under `<DSH_HOME>/commands/<name>.md`
 * carrying `name`, `description` and optional `argument-hint` frontmatter,
 * with the prompt body as the file body. The host half (see ./index.js)
 * registers each enabled file on the harness `commands` registry, so it
 * appears in every composer's `/` menu like a built-in command; the handler
 * submits the prompt body (plus whatever the user typed after the name) as a
 * user message through `agent.followup`, which queues the next model turn.
 *
 * Files are watched, so editing, adding or deleting one from this page — or
 * by hand — re-registers within a moment without restarting dsh.
 *
 * @module dsh-skills-manager-plus/commands
 */

import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  watch,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { parseFrontmatter, rewriteSkillFile, dshHome } from './skills.js';

/** Slash-command name grammar, identical to the harness registry's own. */
const COMMAND_NAME = /^[a-z][a-z0-9_-]*$/;

/** Where saved-command files live. */
export function commandsDir() {
  return join(dshHome(), 'commands');
}

/**
 * Read every saved command (enabled and disabled alike). Files that fail
 * validation are reported with `invalid` so the page can explain them.
 * @param {Set<string>} disabled - command names currently disabled.
 * @returns command rows sorted by name.
 */
export function listCommandFiles(disabled = new Set()) {
  const dir = commandsDir();
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const rows = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const path = join(dir, entry.name);
    const parsed = readCommandFile(path);
    const fallbackName = entry.name.slice(0, -3);
    const name = typeof parsed?.data.name === 'string' && parsed.data.name !== '' ? parsed.data.name : fallbackName;
    const invalidReason =
      parsed === undefined || !COMMAND_NAME.test(name)
        ? 'name'
        : typeof parsed.data.description !== 'string' || parsed.data.description.trim() === ''
          ? 'description'
          : null;
    rows.push({
      path,
      name,
      fileName: entry.name,
      description: typeof parsed?.data.description === 'string' ? parsed.data.description : '',
      argumentHint: typeof parsed?.data['argument-hint'] === 'string' ? parsed.data['argument-hint'] : '',
      content: parsed?.body ?? '',
      enabled: !disabled.has(name),
      invalid: invalidReason,
    });
  }
  return rows;
}

/** Read one command file into `{ data, body, text }`, or `undefined`. */
function readCommandFile(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
  const parsed = parseFrontmatter(text);
  if (parsed === undefined) return { data: {}, body: text, text };
  return { data: parsed.data, body: text.slice(parsed.bodyStart), text };
}

/** Validate a saved-command name against the registry's grammar. */
export function validateCommandName(name) {
  if (typeof name !== 'string' || name.trim() === '') return 'empty';
  if (!COMMAND_NAME.test(name) || name.length > 64) return 'invalid';
  return null;
}

/**
 * Create or update one saved command. Renaming rewrites the file name; the
 * body is stored verbatim (one trailing newline normalized in).
 * @param {object} input - `{ originalName?, name, description, argumentHint?, content }`.
 * @returns `{ path, name, created }`, or `{ error }`.
 */
export function saveCommandFile(input) {
  const invalid = validateCommandName(input.name);
  if (invalid !== null) return { error: invalid };
  if (typeof input.description !== 'string' || input.description.trim() === '') return { error: 'description' };

  const originalName = typeof input.originalName === 'string' && input.originalName !== '' ? input.originalName : null;
  const dir = commandsDir();
  mkdirSync(dir, { recursive: true });

  // Rename through a temp name so `a → b` while `b → a` cannot collide.
  const targetPath = join(dir, `${input.name}.md`);
  const originalPath = originalName !== null ? join(dir, `${originalName}.md`) : null;
  if (originalPath !== null && originalPath !== targetPath) {
    if (!existsSync(originalPath)) return { error: 'missing' };
    if (existsSync(targetPath)) return { error: 'taken' };
  } else if (originalPath === null && existsSync(targetPath)) {
    return { error: 'taken' };
  }

  const fields = {
    name: input.name,
    description: input.description,
    'argument-hint': typeof input.argumentHint === 'string' && input.argumentHint.trim() !== '' ? input.argumentHint : null,
  };
  let body = typeof input.content === 'string' ? input.content : '';
  if (body !== '' && !body.endsWith('\n')) body += '\n';

  const sourceText =
    originalPath !== null && existsSync(originalPath)
      ? readFileSync(originalPath, 'utf8')
      : existsSync(targetPath)
        ? readFileSync(targetPath, 'utf8')
        : '';
  const text = rewriteSkillFile(sourceText, fields, body === '' ? '\n' : body);

  if (originalPath !== null && originalPath !== targetPath) {
    const tempPath = join(dir, `.${input.name}.${Date.now()}.tmp.md`);
    writeFileSync(tempPath, text, 'utf8');
    rmSync(originalPath, { force: true });
    try {
      // Atomic-ish swap: rename cannot overwrite on all platforms, so write
      // then clean instead of rename-over-existing.
      writeFileSync(targetPath, text, 'utf8');
      rmSync(tempPath, { force: true });
    } catch (error) {
      rmSync(tempPath, { force: true });
      throw error;
    }
  } else {
    writeFileSync(targetPath, text, 'utf8');
  }
  return { path: targetPath, name: input.name, created: originalPath === null };
}

/** Delete one saved command file by name. */
export function removeCommandFile(name) {
  const path = join(commandsDir(), `${name}.md`);
  if (!existsSync(path)) return { error: 'missing' };
  rmSync(path, { force: true });
  return { removed: true };
}

/**
 * Build the registry definition for one command row. The handler submits the
 * rendered prompt as a durable user message — the same channel `/goal` uses —
 * so the model turn, permissions and logging behave exactly as if the user had
 * typed the text.
 * @param {object} row - one row from {@link listCommandFiles}.
 * @returns a `ctx.commands.register()` definition.
 */
export function commandDefinitionOf(row) {
  return {
    definitionId: `dsh-skills-manager-plus:${row.name}`,
    name: row.name,
    description: row.description,
    input: row.argumentHint !== '' ? { hint: row.argumentHint } : undefined,
    recordInput: false,
    handler: (invocation) => {
      const extra = invocation.rawInput.trim();
      const text = extra === '' ? row.content.replace(/\s+$/u, '') : `${row.content.replace(/\s+$/u, '')}\n\n${extra}`;
      invocation.agent.followup({
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
      });
      // The prompt itself is the followup message; the command card adds nothing.
      return { kind: 'success' };
    },
  };
}

/**
 * Keep the registry in step with the commands directory. Watch events resync
 * after a short debounce; the host half also calls `resync()` after its own
 * writes so an API answer already reflects them.
 * @param {object} ctx - host context with `commands`.
 * @param {() => Set<string>} disabledNames - current disabled-name lookup.
 * @returns `{ dispose, resync }`.
 */
export function watchCommandFiles(ctx, disabledNames) {
  let disposers = [];
  let timer = null;
  let closed = false;

  function unregisterAll() {
    for (const dispose of disposers.splice(0)) {
      try {
        dispose();
      } catch {
        // a disposed fiber is already gone
      }
    }
  }

  function resync() {
    unregisterAll();
    const rows = listCommandFiles(disabledNames());
    for (const row of rows) {
      if (row.enabled && row.invalid === null) {
        try {
          disposers.push(ctx.commands.register(commandDefinitionOf(row)));
        } catch (error) {
          ctx.logger?.warn?.(`[dsh-skills-manager-plus] command /${row.name} not registered: ${String(error?.message ?? error)}`);
        }
      }
    }
  }

  function schedule() {
    if (closed) return;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      resync();
    }, 200);
  }

  resync();
  mkdirSync(commandsDir(), { recursive: true });
  let watcher;
  try {
    watcher = watch(commandsDir(), { recursive: false, persistent: false }, schedule);
  } catch {
    // Without a watcher the page's own writes still resync through the API.
    watcher = null;
  }
  return {
    resync,
    dispose() {
      closed = true;
      if (timer !== null) clearTimeout(timer);
      watcher?.close();
      unregisterAll();
    },
  };
}
