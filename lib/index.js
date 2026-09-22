/**
 * dsh-skills-manager-plus — host half.
 *
 * Serves a loopback HTTP API over the harness web server for the browser
 * settings page ("技能与命令"), and registers the user's saved prompts as
 * slash commands on the `commands` registry.
 *
 * What the page manages, and where it lives:
 * - Skills are files under the same roots the harness's skill-filesystem
 *   provider scans (user `~/.dsh/skills` + `~/.agents/skills`; each
 *   workspace's `.dsh/skills` + `.agents/skills`; bundled dir read-only).
 *   Enable/disable is a frontmatter rewrite (`disable-model-invocation` +
 *   `user-invocable`), which the provider's directory watcher picks up and
 *   every live catalog honors — no restart, any layer.
 * - Commands are `<DSH_HOME>/commands/<name>.md` files, watched and
 *   re-registered live (see ./commands.js).
 * - The ".agents skill directories" import switches bulk-apply the same
 *   frontmatter disable to every skill under those roots. The state file
 *   remembers exactly which files this manager disabled, so switching back
 *   restores them and never touches a skill the user disabled by hand.
 *
 * Safety rules:
 * - Only loopback requests are answered.
 * - Skill and command writes are confined to paths under the manager's own
 *   roots; a submitted path outside them is refused.
 * - The state file is rewritten atomically and validated on load.
 *
 * @module dsh-skills-manager-plus
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import {
  agentsHome,
  dshHome,
  installSkillArchive,
  isWritable,
  listSkillsInRoot,
  readSkillFile,
  removeSkillFile,
  resolveRoots,
  saveSkillFile,
  toggleSkillFile,
} from './skills.js';
import { ArchiveError, extractArchive } from './archives.js';
import {
  commandsDir,
  listCommandFiles,
  removeCommandFile,
  saveCommandFile,
  watchCommandFiles,
} from './commands.js';

/** Route prefix for this plugin's API. */
const API_PREFIX = '/skills-manager-plus';
/** How long a listing may be reused, in ms. */
const CACHE_TTL_MS = 300;
/** State file version this code reads and writes. */
const STATE_VERSION = 1;

// ── response language ───────────────────────────────────────────────────────

const MSGS = {
  zh: {
    loopbackOnly: '仅允许本机访问',
    unknownRoute: '未知接口 {route}',
    bodyTooLarge: '请求体过大',
    badJson: '请求体不是合法 JSON：{detail}',
    nameInvalid: '名称只能包含小写字母、数字、下划线和连字符（技能为 kebab-case），长度 1–64',
    descriptionRequired: '描述不能为空',
    editTargetMissing: '未找到要编辑的条目',
    nameTaken: '名称 {name} 已存在',
    skillMissing: '未找到技能文件 {path}',
    commandMissing: '未找到命令 /{name}',
    readOutsideRoots: '路径不在可管理的技能目录内',
    skillOccupied: '技能文件正被其他程序占用（如图片预览/索引服务），未能删除。请关闭打开它的程序后重试。',
    invalidSkill: '该技能文件缺少有效 frontmatter（name/description），请先修复再操作',
    agentsUserRootOff: '已停用用户级 .agents 技能目录（~{path} 下 {n} 个技能）',
    agentsUserRootOn: '已启用用户级 .agents 技能目录（恢复 {n} 个技能）',
    agentsProjectRootOff: '已停用项目级 .agents 技能目录（共 {n} 个技能）',
    agentsProjectRootOn: '已启用项目级 .agents 技能目录（恢复 {n} 个技能）',
    stateRewritten: '状态文件已重置（原文件无法解析：{detail}）',
    archiveUnsupported: '不支持的压缩包类型（支持 zip、tar、tar.gz）',
    archiveCorrupt: '压缩包已损坏或不是有效的 zip/tar 归档',
    archiveEmpty: '上传的文件为空',
    archiveBadPath: '压缩包中包含非法路径',
    archiveInstalled: '已从压缩包安装 {n} 个技能',
    archiveInstalledNone: '未从压缩包安装任何技能',
  },
  en: {
    loopbackOnly: 'Only local (loopback) requests are allowed',
    unknownRoute: 'Unknown endpoint {route}',
    bodyTooLarge: 'Request body too large',
    badJson: 'Request body is not valid JSON: {detail}',
    nameInvalid: 'Names may only contain lowercase letters, digits, underscore and hyphen (kebab-case for skills), 1–64 characters',
    descriptionRequired: 'Description must not be empty',
    editTargetMissing: 'The entry to edit was not found',
    nameTaken: 'The name {name} is already taken',
    skillMissing: 'Skill file not found: {path}',
    commandMissing: 'Command /{name} not found',
    readOutsideRoots: 'The path is outside the managed skill roots',
    skillOccupied: 'A skill file is locked by another program (e.g. an image preview or indexer) and could not be deleted. Close whatever has it open, then retry.',
    invalidSkill: 'This skill file lacks valid frontmatter (name/description); fix it before managing it here',
    agentsUserRootOff: 'Disabled the user .agents skill directory ({n} skills under ~{path})',
    agentsUserRootOn: 'Enabled the user .agents skill directory (restored {n} skills)',
    agentsProjectRootOff: 'Disabled project .agents skill directories ({n} skills total)',
    agentsProjectRootOn: 'Enabled project .agents skill directories (restored {n} skills)',
    stateRewritten: 'State file was reset (it did not parse: {detail})',
    archiveUnsupported: 'Unsupported archive type (supported: zip, tar, tar.gz)',
    archiveCorrupt: 'The archive is corrupt or not a valid zip/tar',
    archiveEmpty: 'The uploaded file is empty',
    archiveBadPath: 'The archive contains an unsafe path',
    archiveInstalled: 'Installed {n} skill(s) from the archive',
    archiveInstalledNone: 'No skills were installed from the archive',
  },
};

function tr(lang, key, params) {
  const table = lang === 'en' ? MSGS.en : MSGS.zh;
  let text = table[key] !== undefined ? table[key] : key;
  if (params !== undefined) {
    text = text.replace(/\{(\w+)\}/gu, (match, name) =>
      params[name] !== undefined ? String(params[name]) : match,
    );
  }
  return text;
}

function requestLang(url) {
  return url.searchParams.get('lang') === 'en' ? 'en' : 'zh';
}

// ── state file ──────────────────────────────────────────────────────────────

/**
 * The manager's own durable state: the import switches, the disabled-command
 * set, and exactly which skill files the bulk switches disabled (so a switch
 * back restores those and only those).
 */
function defaultState() {
  return {
    version: STATE_VERSION,
    agentsRoots: { user: true, project: true },
    disabledCommands: [],
    disabledByManager: [],
  };
}

/** Absolute path of the state file. */
function statePath() {
  return join(dshHome(), 'skills-manager-plus.json');
}

/** Load and validate the state file; an unreadable one is replaced by defaults. */
function readState(lang) {
  const fallback = defaultState();
  const path = statePath();
  if (!existsSync(path)) return { state: fallback, notice: null };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    const agentsRoots = {
      user: parsed.agentsRoots?.user !== false,
      project: parsed.agentsRoots?.project !== false,
    };
    const arr = (value) => (Array.isArray(value) ? value.filter((item) => typeof item === 'string') : []);
    return {
      state: {
        version: STATE_VERSION,
        agentsRoots,
        disabledCommands: arr(parsed.disabledCommands),
        disabledByManager: arr(parsed.disabledByManager),
      },
      notice: null,
    };
  } catch (error) {
    return { state: fallback, notice: tr(lang, 'stateRewritten', { detail: String(error?.message ?? error) }) };
  }
}

/** Atomically replace the state file. */
function writeState(state) {
  const path = statePath();
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  renameSync(temp, path);
}

// ── project roots ───────────────────────────────────────────────────────────

/**
 * The workspace directories the page offers as skill scopes. The workspace
 * registry owns the durable list; each workspace path is the project root the
 * provider would find from that workspace's sessions.
 */
function projectRootsOf(ctx) {
  const registry = ctx.get('workspaceRegistry');
  if (registry === undefined || typeof registry.list !== 'function') return [];
  try {
    const seen = new Set();
    const roots = [];
    for (const workspace of registry.list()) {
      const path = typeof workspace?.path === 'string' ? workspace.path : '';
      if (path === '') continue;
      // The registry can list the same workspace more than once (and Windows
      // paths are case-insensitive); a repeat would otherwise show up as a
      // duplicate project entry in the scope menus.
      const key = resolve(path).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      roots.push(path);
    }
    return roots;
  } catch {
    return [];
  }
}

// ── write serialization ─────────────────────────────────────────────────────

let writeQueue = Promise.resolve();
function queuedWrite(task) {
  const run = writeQueue.then(task, task);
  writeQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

// ── inventory ───────────────────────────────────────────────────────────────

/**
 * Build the full page state: import switches, user-level skills, per-project
 * skills, and saved commands.
 */
function buildState(ctx, state, lang) {
  const projectRoots = projectRootsOf(ctx);
  const roots = resolveRoots(projectRoots);

  const globalSkills = [];
  const rootPaths = [];
  for (const root of roots.userRoots) {
    rootPaths.push(root.path);
    for (const row of listSkillsInRoot(root.path, root.source, { skipSystem: root.skipSystem })) {
      globalSkills.push({ ...row, readOnly: root.readOnly, agentsRoot: root.source === 'user-agents' });
    }
  }

  const projects = roots.projects.map((project) => ({
    root: project.root,
    skills: project.dirs.flatMap((dir) => {
      rootPaths.push(dir.path);
      return listSkillsInRoot(dir.path, dir.source).map((row) => ({
        ...row,
        agentsRoot: dir.source === 'project-agents',
      }));
    }),
  }));

  const disabledCommands = new Set(state.disabledCommands);
  const commands = listCommandFiles(disabledCommands);

  const disabledSet = new Set(state.disabledByManager.map((path) => path.toLowerCase()));
  const markManaged = (skill) => ({ ...skill, managedDisabled: disabledSet.has(skill.path.toLowerCase()) });

  return {
    statePath: statePath(),
    commandsDir: commandsDir(),
    writable: {
      userSkills: isWritable(roots.userSkillsDir),
      agentsSkills: isWritable(join(agentsHome(), 'skills')),
      commands: isWritable(commandsDir()),
    },
    agentsRoots: state.agentsRoots,
    globalSkills: globalSkills.map(markManaged),
    projects: projects.map((project) => ({
      root: project.root,
      skills: project.skills.map(markManaged),
    })),
    commands,
    rootPaths,
  };
}

/**
 * Confine a submitted skill path to the roots the page actually manages. This
 * is the write boundary: anything outside these directories is refused.
 */
function skillPathWithinRoots(path, rootPaths) {
  const absolute = resolve(path);
  for (const root of rootPaths) {
    const resolvedRoot = resolve(root);
    if (absolute === resolvedRoot || absolute.startsWith(resolvedRoot + sep)) return absolute;
  }
  return null;
}

// ── the .agents import switches ─────────────────────────────────────────────

/**
 * Apply the `.agents` import switch. Turning it off disables every skill under
 * the affected root(s) through the frontmatter keys and records each rewritten
 * file; turning it on restores exactly those recorded files. A skill disabled
 * by hand (not recorded) is left alone in both directions.
 */
async function applyAgentsRootSwitch(ctx, input, lang, mutateState) {
  const scope = input.scope === 'project' ? 'project' : input.scope === 'user' ? 'user' : 'user';
  const enabled = input.enabled === true;
  const projectRoots = projectRootsOf(ctx);
  const roots = resolveRoots(projectRoots);

  return queuedWrite(async () => {
    const { state } = readState(lang);
    const managed = new Set(state.disabledByManager.map((path) => path.toLowerCase()));
    let changed = 0;

    const targetRoots = [];
    if (scope === 'user') targetRoots.push(join(agentsHome(), 'skills'));
    else for (const project of roots.projects) targetRoots.push(join(project.root, '.agents', 'skills'));

    for (const rootDir of targetRoots) {
      for (const row of listSkillsInRoot(rootDir, 'user-agents')) {
        if (row.invalid === 'unreadable') continue;
        const key = row.path.toLowerCase();
        if (enabled) {
          if (!managed.has(key)) continue;
          const result = toggleSkillFile(row.path, true);
          if (result.error === undefined) {
            managed.delete(key);
            changed += 1;
          }
        } else if (row.enabled && !row.invalid) {
          const result = toggleSkillFile(row.path, false);
          if (result.error === undefined) {
            managed.add(key);
            changed += 1;
          }
        }
      }
    }

    const nextState = {
      ...state,
      agentsRoots: { ...state.agentsRoots, [scope]: enabled },
      disabledByManager: [...managed],
    };
    writeState(nextState);
    mutateState(nextState);
    const key = scope === 'user' ? (enabled ? 'agentsUserRootOn' : 'agentsUserRootOff') : enabled ? 'agentsProjectRootOn' : 'agentsProjectRootOff';
    const params = { n: changed, ...(scope === 'user' ? { path: join(agentsHome(), 'skills') } : {}) };
    return { message: tr(lang, key, params), changed };
  });
}

// ── HTTP plumbing ───────────────────────────────────────────────────────────

async function readJsonBody(req, lang, limitBytes = 512 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limitBytes) throw new Error(tr(lang, 'bodyTooLarge'));
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') return {};
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(tr(lang, 'badJson', { detail: String(error?.message ?? error) }));
  }
}

/** Read an uploaded archive body as raw bytes (an archive is not JSON). */
async function readRawBody(req, lang, limitBytes = 64 * 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limitBytes) throw new Error(tr(lang, 'bodyTooLarge'));
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** Map an archive-extraction error to a translated, human message. */
function archiveErrorText(lang, error) {
  const code = error instanceof ArchiveError ? error.code : 'unsupported';
  const key = code === 'empty' ? 'archiveEmpty' : code === 'badPath' ? 'archiveBadPath' : code === 'unsupported' ? 'archiveUnsupported' : 'archiveCorrupt';
  return tr(lang, key);
}

function isLoopback(req) {
  const address = req.socket?.remoteAddress ?? '';
  return (
    address === '127.0.0.1' ||
    address === '::1' ||
    address === '::ffff:127.0.0.1' ||
    address.startsWith('127.')
  );
}

function sendJson(res, status, value) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(value));
}

/** Map a store error code to its translated message. */
function storeError(lang, code, params) {
  if (code === 'empty' || code === 'invalid') return tr(lang, 'nameInvalid');
  if (code === 'description') return tr(lang, 'descriptionRequired');
  if (code === 'missing') return tr(lang, 'editTargetMissing');
  if (code === 'taken') return tr(lang, 'nameTaken', params);
  return tr(lang, 'editTargetMissing');
}

export const name = 'dsh-skills-manager-plus';
export const inject = ['webServer', 'commands'];

/**
 * Register the management API and the saved-command registrations.
 * @param ctx - host context carrying `webServer` and `commands`.
 */
export function apply(ctx) {
  /** Last listing snapshot plus the loaded state it was built from. */
  let cache = null;
  /** Live state mirror, kept in step with the state file. */
  let currentState = null;
  let currentLang = 'zh';
  let notice = null;

  const loadState = (lang) => {
    const loaded = readState(lang);
    currentState = loaded.state;
    if (loaded.notice !== null) notice = loaded.notice;
    return loaded;
  };
  const mutateState = (next) => {
    currentState = next;
    cache = null;
    commandWatch.resync();
  };

  /** Re-read the state file, then rebuild and cache the page state. */
  const refresh = (lang = currentLang) => {
    currentLang = lang;
    loadState(lang);
    cache = null;
    return buildState(ctx, currentState, lang);
  };

  const listState = (lang) => {
    currentLang = lang;
    const now = Date.now();
    if (cache !== null && now - cache.at < CACHE_TTL_MS) return cache.value;
    if (currentState === null) loadState(lang);
    const value = { ...buildState(ctx, currentState, lang), notice };
    cache = { at: now, value };
    return value;
  };

  // Saved commands: registered for the process lifetime, resynced whenever the
  // directory or the disabled set changes. The commandWatch binding must exist
  // before mutateState runs, so it is created first and its effect registered
  // right after.
  let commandWatch;
  {
    const created = watchCommandFiles(ctx, () => new Set(currentState?.disabledCommands ?? []));
    commandWatch = created;
    ctx.effect(() => created.dispose, 'dsh-skills-manager-plus: command registrations');
  }

  const rootPathsOf = () => listState(currentLang).rootPaths;

  const saveSkill = (input, lang) =>
    queuedWrite(async () => {
      if (input.originalPath !== undefined && input.originalPath !== null && input.originalPath !== '') {
        const confined = skillPathWithinRoots(input.originalPath, rootPathsOf());
        if (confined === null) throw new Error(tr(lang, 'readOutsideRoots'));
        input = { ...input, originalPath: confined };
      }
      // A scope selects the target root server-side, so the browser never
      // constructs skill paths itself: user → ~/.dsh/skills, project → the
      // chosen workspace's .dsh/skills (project roots outrank .agents).
      if (input.scope === 'user' || input.scope === 'project') {
        if (input.scope === 'user') {
          input = { ...input, root: join(dshHome(), 'skills') };
        } else {
          const projectRoots = projectRootsOf(ctx);
          const project = typeof input.project === 'string' ? resolve(input.project) : '';
          if (!projectRoots.some((root) => resolve(root) === project)) {
            throw new Error(tr(lang, 'readOutsideRoots'));
          }
          input = { ...input, root: join(project, '.dsh', 'skills') };
        }
      }
      const result = saveSkillFile(input);
      if (result.error !== undefined) throw new Error(storeError(lang, result.error, { name: input.name ?? '' }));
      cache = null;
      return { action: input.originalPath ? 'updated' : 'created', path: result.path };
    });

  const toggleSkill = (input, lang) =>
    queuedWrite(async () => {
      const confined = skillPathWithinRoots(String(input.path ?? ''), rootPathsOf());
      if (confined === null) throw new Error(tr(lang, 'readOutsideRoots'));
      const result = toggleSkillFile(confined, input.enabled === true);
      if (result.error !== undefined) throw new Error(tr(lang, 'skillMissing', { path: confined }));
      cache = null;
      return { action: input.enabled === true ? 'enabled' : 'disabled', path: confined };
    });

  const removeSkill = (input, lang) =>
    queuedWrite(async () => {
      const confined = skillPathWithinRoots(String(input.path ?? ''), rootPathsOf());
      if (confined === null) throw new Error(tr(lang, 'readOutsideRoots'));
      const result = removeSkillFile(confined);
      if (result.error === 'occupied') throw new Error(tr(lang, 'skillOccupied', { path: confined }));
      if (result.error !== undefined) throw new Error(tr(lang, 'skillMissing', { path: confined }));
      // A deleted skill can no longer be restored by the import switch.
      const { state } = readState(lang);
      const key = confined.toLowerCase();
      if (state.disabledByManager.some((path) => path.toLowerCase() === key)) {
        const next = { ...state, disabledByManager: state.disabledByManager.filter((path) => path.toLowerCase() !== key) };
        writeState(next);
        currentState = next;
      }
      cache = null;
      return { action: 'removed', path: confined };
    });

  const installSkillArchiveHost = (input, lang) =>
    queuedWrite(async () => {
      const scope = input.scope === 'project' ? 'project' : 'user';
      let root;
      if (scope === 'user') {
        root = join(dshHome(), 'skills');
      } else {
        const projectRoots = projectRootsOf(ctx);
        const project = typeof input.project === 'string' ? resolve(input.project) : '';
        if (!projectRoots.some((item) => resolve(item) === project)) {
          throw new Error(tr(lang, 'readOutsideRoots'));
        }
        root = join(project, '.dsh', 'skills');
      }
      let entries;
      try {
        entries = extractArchive(input.data, typeof input.fileName === 'string' ? input.fileName : '');
      } catch (error) {
        throw new Error(archiveErrorText(lang, error));
      }
      const result = installSkillArchive(root, entries);
      cache = null;
      return { ...result, root, scope };
    });

  const readSkillBody = (input, lang) => {
    const confined = skillPathWithinRoots(String(input.path ?? ''), rootPathsOf());
    if (confined === null) throw new Error(tr(lang, 'readOutsideRoots'));
    const parsed = readSkillFile(confined);
    if (parsed === undefined) throw new Error(tr(lang, 'skillMissing', { path: confined }));
    const lines = parsed.text.split(/\r?\n/);
    let bodyText = parsed.text;
    if (lines[0] === '---') {
      const close = lines.indexOf('---', 1);
      if (close > 0) bodyText = lines.slice(close + 1).join('\n');
    }
    return { path: confined, content: bodyText.replace(/^\r?\n/, '') };
  };

  const saveCommand = (input, lang) =>
    queuedWrite(async () => {
      const result = saveCommandFile(input);
      if (result.error !== undefined) throw new Error(storeError(lang, result.error, { name: input.name ?? '' }));
      cache = null;
      commandWatch.resync();
      return { action: input.originalName ? 'updated' : 'created', name: result.name, path: result.path };
    });

  const setCommandDisabled = (input, lang, disabled) =>
    queuedWrite(async () => {
      const name = typeof input.name === 'string' ? input.name : '';
      const dir = commandsDir();
      if (!existsSync(join(dir, `${name}.md`))) throw new Error(tr(lang, 'commandMissing', { name }));
      const { state } = readState(lang);
      const set = new Set(state.disabledCommands);
      if (disabled) set.add(name);
      else set.delete(name);
      const next = { ...state, disabledCommands: [...set] };
      writeState(next);
      currentState = next;
      cache = null;
      commandWatch.resync();
      return { action: disabled ? 'disabled' : 'enabled', name };
    });

  const removeCommand = (input, lang) =>
    queuedWrite(async () => {
      const name = typeof input.name === 'string' ? input.name : '';
      const result = removeCommandFile(name);
      if (result.error !== undefined) throw new Error(tr(lang, 'commandMissing', { name }));
      const { state } = readState(lang);
      const next = { ...state, disabledCommands: state.disabledCommands.filter((item) => item !== name) };
      writeState(next);
      currentState = next;
      cache = null;
      commandWatch.resync();
      return { action: 'removed', name };
    });

  const handler = async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const lang = requestLang(url);
    if (!isLoopback(req)) {
      sendJson(res, 403, { error: tr(lang, 'loopbackOnly') });
      return;
    }
    const route = url.pathname.slice(API_PREFIX.length);

    try {
      if (route === '/state' && req.method === 'GET') {
        sendJson(res, 200, listState(lang));
        return;
      }
      if (route === '/refresh' && req.method === 'POST') {
        notice = null;
        sendJson(res, 200, { ok: true, state: refresh(lang) });
        return;
      }
      if (route === '/skills/read' && req.method === 'POST') {
        sendJson(res, 200, { ok: true, ...readSkillBody(await readJsonBody(req, lang), lang) });
        return;
      }
      if (route === '/skills/save' && req.method === 'POST') {
        const result = await saveSkill(await readJsonBody(req, lang), lang);
        sendJson(res, 200, { ok: true, ...result, state: listState(lang) });
        return;
      }
      if (route === '/skills/toggle' && req.method === 'POST') {
        const result = await toggleSkill(await readJsonBody(req, lang), lang);
        sendJson(res, 200, { ok: true, ...result, state: listState(lang) });
        return;
      }
      if (route === '/skills/remove' && req.method === 'POST') {
        const result = await removeSkill(await readJsonBody(req, lang), lang);
        sendJson(res, 200, { ok: true, ...result, state: listState(lang) });
        return;
      }
      if (route === '/skills/install/archive' && req.method === 'POST') {
        const scope = url.searchParams.get('scope') === 'project' ? 'project' : 'user';
        const data = await readRawBody(req, lang);
        const result = await installSkillArchiveHost(
          {
            scope,
            project: url.searchParams.get('project') ?? '',
            fileName: url.searchParams.get('fileName') ?? '',
            data,
          },
          lang,
        );
        sendJson(res, 200, { ok: true, ...result, state: listState(lang) });
        return;
      }
      if (route === '/commands/save' && req.method === 'POST') {
        const result = await saveCommand(await readJsonBody(req, lang), lang);
        sendJson(res, 200, { ok: true, ...result, state: listState(lang) });
        return;
      }
      if (route === '/commands/toggle' && req.method === 'POST') {
        const input = await readJsonBody(req, lang);
        const result = await setCommandDisabled(input, lang, input.enabled === false);
        sendJson(res, 200, { ok: true, ...result, state: listState(lang) });
        return;
      }
      if (route === '/commands/remove' && req.method === 'POST') {
        const result = await removeCommand(await readJsonBody(req, lang), lang);
        sendJson(res, 200, { ok: true, ...result, state: listState(lang) });
        return;
      }
      if (route === '/roots/agents' && req.method === 'POST') {
        const result = await applyAgentsRootSwitch(ctx, await readJsonBody(req, lang), lang, mutateState);
        sendJson(res, 200, { ok: true, ...result, state: listState(lang) });
        return;
      }
      sendJson(res, 404, { error: tr(lang, 'unknownRoute', { route }) });
    } catch (error) {
      sendJson(res, 400, { error: String(error?.message ?? error) });
    }
  };

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: API_PREFIX,
        handler,
      }),
    'dsh-skills-manager-plus: management API',
  );
}

export default { name, inject, apply };
