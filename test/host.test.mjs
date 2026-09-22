/**
 * End-to-end tests for the host half (lib/index.js): the real `apply()` is
 * driven through a minimal fake Cordis context, so every HTTP route, the state
 * file and the skill/command writes are exercised as they run in the harness.
 *
 * Run with:  node test/host.test.mjs
 *
 * `DSH_HOME` / `DSH_AGENTS_HOME` are pointed at throwaway temp dirs, so the
 * tests never touch the real profile or skill roots.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gzipSync, deflateRawSync } from 'node:zlib';

const dir = mkdtempSync(join(tmpdir(), 'smp-host-'));
process.env.DSH_HOME = join(dir, 'dsh');
process.env.DSH_AGENTS_HOME = join(dir, 'agents');
mkdirSync(join(dir, 'dsh', 'skills'), { recursive: true });
mkdirSync(join(dir, 'agents', 'skills'), { recursive: true });

const plugin = await import('../lib/index.js');
const API_PREFIX = '/skills-manager-plus';
const projectRoot = join(dir, 'proj-alpha');
mkdirSync(projectRoot, { recursive: true });

/**
 * Build a zip whose entries are stored (method 0) by default, or deflated
 * (`method: 8`) when an entry asks for it — the shape `zip -r` / Windows
 * Compressed Folder writes for ordinary files, which is what re-checked real
 * bundles (e.g. skillhub.cn) use. A `<dir>/` name is recorded as a directory
 * marker, exactly as `zip -r` writes them.
 */
function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const raw = Buffer.from(entry.body, 'utf8');
    const method = entry.method === 8 ? 8 : 0;
    const body = method === 8 ? deflateRawSync(raw) : raw;
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8); // stored or deflated
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    locals.push(local, body);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centrals.push(central);
    offset += local.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

/** Build a ustar tar of regular files. */
function makeTar(entries) {
  const blocks = [];
  for (const entry of entries) {
    const body = Buffer.from(entry.body, 'utf8');
    const header = Buffer.alloc(512);
    header.write(entry.name, 0, 'utf8');
    header.write('0000644\0', 100, 'utf8');
    header.write('0000000\0', 108, 'utf8');
    header.write('0000000\0', 116, 'utf8');
    header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124, 'utf8');
    header.write('00000000000\0', 136, 'utf8');
    header.write('        ', 148, 'utf8');
    header.write('0', 156, 'utf8');
    header.write('ustar', 257, 'utf8');
    header.write('00', 263, 'utf8');
    blocks.push(header, body);
    const pad = (512 - (body.length % 512)) % 512;
    if (pad > 0) blocks.push(Buffer.alloc(pad));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

/** Boot the host half against a stub context, returning a request driver. */
function boot() {
  const routes = [];
  const cleanups = [];
  const registeredCommands = [];
  const log = [];

  const ctx = {
    get(name) {
      if (name === 'workspaceRegistry') {
        return { list: () => [{ path: projectRoot }] };
      }
      return undefined;
    },
    effect(factory, label) {
      const dispose = factory();
      cleanups.push(dispose);
      log.push(label);
      return dispose;
    },
    webServer: {
      register(route) {
        routes.push(route);
        return () => {
          const index = routes.indexOf(route);
          if (index >= 0) routes.splice(index, 1);
        };
      },
    },
    commands: {
      register(def) {
        registeredCommands.push(def);
        return () => {
          const index = registeredCommands.indexOf(def);
          if (index >= 0) registeredCommands.splice(index, 1);
        };
      },
    },
    logger: { warn: (...args) => log.push(['warn', ...args]) },
  };

  plugin.apply(ctx);
  const route = routes.find((entry) => entry.path === API_PREFIX);
  assert.ok(route, 'the management route must be registered');
  const { handler } = route;

  /** Issue one request through the real handler. */
  async function request(method, path, body, remoteAddress = '127.0.0.1') {
    const req = {
      method,
      url: `${API_PREFIX}${path}`,
      socket: { remoteAddress },
      async *[Symbol.asyncIterator]() {
        if (body !== undefined) yield Buffer.from(JSON.stringify(body), 'utf8');
      },
    };
    let status = 0;
    let payload = null;
    const res = {
      writeHead(code, headers) {
        status = code;
      },
      end(text) {
        payload = text === undefined ? '' : text;
      },
    };
    await handler(req, res);
    return { status, payload: payload === null ? null : JSON.parse(payload) };
  }

  /**
   * POST raw bytes (an archive route must not JSON-encode its body), typically
   * with query parameters for scope/project/fileName.
   */
  async function requestRaw(method, path, buffer) {
    const req = {
      method,
      url: `${API_PREFIX}${path}`,
      socket: { remoteAddress: '127.0.0.1' },
      async *[Symbol.asyncIterator]() {
        if (buffer !== undefined) yield buffer;
      },
    };
    let status = 0;
    let payload = null;
    const res = {
      writeHead(code) {
        status = code;
      },
      end(text) {
        payload = text === undefined ? '' : text;
      },
    };
    await handler(req, res);
    return { status, payload: payload === null ? null : JSON.parse(payload) };
  }

  function dispose() {
    for (const cleanup of cleanups) {
      try {
        cleanup();
      } catch {
        // already disposed
      }
    }
  }

  return { request, requestRaw, registeredCommands, dispose };
}

test('loopback guard refuses remote requests with 403', async () => {
  const { request, dispose } = boot();
  const res = await request('GET', '/state', undefined, '8.8.8.8');
  assert.equal(res.status, 403);
  assert.ok(/loopback|本机/u.test(res.payload.error));
  dispose();
});

test('GET /state reports writable roots, agentsRoots and empty lists', async () => {
  const { request, dispose } = boot();
  const res = await request('GET', '/state');
  assert.equal(res.status, 200);
  assert.ok(res.payload.statePath.endsWith('skills-manager-plus.json'));
  assert.deepEqual(res.payload.agentsRoots, { user: true, project: true });
  assert.ok(Array.isArray(res.payload.globalSkills));
  assert.ok(Array.isArray(res.payload.commands));
  assert.equal(res.payload.writable.userSkills, true);
  dispose();
});

test('skills/save then skills/state lists the created skill; toggle hides it', async () => {
  const { request, dispose } = boot();
  const created = await request('POST', '/skills/save', {
    scope: 'user',
    name: 'alpha',
    description: 'Alpha skill',
    whenToUse: 'when needed',
    modelInvocable: true,
    userInvocable: true,
    content: '# Alpha\nDo the thing.',
  });
  assert.equal(created.status, 200);
  assert.equal(created.payload.ok, true);
  assert.equal(created.payload.action, 'created');

  const path = created.payload.path;
  assert.ok(existsSync(path));
  assert.ok(readFileSync(path, 'utf8').includes('Do the thing.'));

  const state = await request('GET', '/state');
  const alpha = state.payload.globalSkills.find((s) => s.name === 'alpha');
  assert.ok(alpha, 'created skill is listed');
  assert.equal(alpha.enabled, true);

  const toggled = await request('POST', '/skills/toggle', { path, enabled: false });
  assert.equal(toggled.status, 200);
  assert.equal(toggled.payload.action, 'disabled');
  assert.ok(readFileSync(path, 'utf8').includes('disable-model-invocation: true'));
  dispose();
});

test('skills/read returns only the body, stripped of frontmatter', async () => {
  const { request, dispose } = boot();
  const created = await request('POST', '/skills/save', {
    scope: 'user',
    name: 'bravo',
    description: 'Bravo skill',
    content: 'Line one\nLine two',
  });
  const read = await request('POST', '/skills/read', { path: created.payload.path });
  assert.equal(read.status, 200);
  // The body keeps its natural trailing newline; only the frontmatter is stripped.
  assert.ok(read.payload.content.startsWith('Line one'));
  assert.ok(read.payload.content.includes('Line two'));
  assert.ok(!read.payload.content.includes('Bravo skill'));
  dispose();
});

test('skills/save outside the managed roots is refused', async () => {
  const { request, dispose } = boot();
  const res = await request('POST', '/skills/save', {
    scope: 'user',
    originalPath: join(dir, 'elsewhere', 'SKILL.md'),
    name: 'escape',
    description: 'd',
  });
  assert.equal(res.status, 400);
  assert.ok(/roots|目录/u.test(res.payload.error));
  dispose();
});

test('skills/remove deletes the skill file', async () => {
  const { request, dispose } = boot();
  const created = await request('POST', '/skills/save', {
    scope: 'user',
    name: 'charlie',
    description: 'Charlie',
    content: 'x',
  });
  const removed = await request('POST', '/skills/remove', { path: created.payload.path });
  assert.equal(removed.status, 200);
  assert.equal(removed.payload.action, 'removed');
  assert.ok(!existsSync(created.payload.path));
  dispose();
});

test('skills/remove deletes a project-scope skill through the registered workspace', async () => {
  const { request, dispose } = boot();
  const created = await request('POST', '/skills/save', {
    scope: 'project',
    project: projectRoot,
    name: 'delta',
    description: 'Delta project skill',
    content: 'd',
  });
  assert.equal(created.status, 200);
  const removed = await request('POST', '/skills/remove', { path: created.payload.path });
  assert.equal(removed.status, 200);
  assert.equal(removed.payload.action, 'removed');
  assert.ok(!existsSync(created.payload.path));
  assert.ok(!existsSync(dirname(created.payload.path)), 'the skill directory is gone too');
  dispose();
});

test('commands/save then commands/toggle and commands/remove', async () => {
  const { request, registeredCommands, dispose } = boot();
  const created = await request('POST', '/commands/save', {
    name: 'continue',
    description: 'Continue the work',
    argumentHint: '<context>',
    content: 'Pick up where we left off.',
  });
  assert.equal(created.status, 200);
  assert.equal(created.payload.ok, true);
  assert.equal(created.payload.action, 'created');

  // The saved command is registered on the commands registry.
  assert.ok(registeredCommands.some((d) => d.name === 'continue'), 'command registered on the harness registry');

  const state = await request('GET', '/state');
  const row = state.payload.commands.find((c) => c.name === 'continue');
  assert.ok(row);
  assert.equal(row.enabled, true);
  assert.equal(row.argumentHint, '<context>');

  const disabled = await request('POST', '/commands/toggle', { name: 'continue', enabled: false });
  assert.equal(disabled.payload.action, 'disabled');
  assert.ok(!registeredCommands.some((d) => d.name === 'continue'), 'disabled command is unregistered');

  const reenabled = await request('POST', '/commands/toggle', { name: 'continue', enabled: true });
  assert.equal(reenabled.payload.action, 'enabled');
  assert.ok(registeredCommands.some((d) => d.name === 'continue'), 'reenabled command is registered again');

  const removed = await request('POST', '/commands/remove', { name: 'continue' });
  assert.equal(removed.payload.action, 'removed');
  assert.ok(!registeredCommands.some((d) => d.name === 'continue'));
  dispose();
});

test('commands/save with an invalid name is rejected', async () => {
  const { request, dispose } = boot();
  const res = await request('POST', '/commands/save', { name: 'UPPER name', description: 'd', content: '' });
  assert.equal(res.status, 400);
  dispose();
});

test('roots/agents turns off user .agents skills and restores only managed ones', async () => {
  const { request, dispose } = boot();
  // Seed a skill under ~/.agents/skills and one under ~/.dsh/skills.
  const agentsRoot = join(process.env.DSH_AGENTS_HOME, 'skills');
  mkdirSync(join(agentsRoot, 'agt'), { recursive: true });
  writeFileSync(
    join(agentsRoot, 'agt', 'SKILL.md'),
    '---\nname: agt\ndescription: agents skill\n---\nbody\n',
  );

  const off = await request('POST', '/roots/agents', { scope: 'user', enabled: false });
  assert.equal(off.status, 200);
  const text = readFileSync(join(agentsRoot, 'agt', 'SKILL.md'), 'utf8');
  assert.ok(text.includes('disable-model-invocation: true'), 'agents skill disabled on switch-off');

  const stateOff = await request('GET', '/state');
  assert.equal(stateOff.payload.agentsRoots.user, false);

  const on = await request('POST', '/roots/agents', { scope: 'user', enabled: true });
  assert.equal(on.status, 200);
  const restored = readFileSync(join(agentsRoot, 'agt', 'SKILL.md'), 'utf8');
  assert.ok(!restored.includes('disable-model-invocation'), 'managed agents skill restored on switch-on');
  const stateOn = await request('GET', '/state');
  assert.equal(stateOn.payload.agentsRoots.user, true);
  dispose();
});

test('unknown route is a 404', async () => {
  const { request, dispose } = boot();
  const res = await request('GET', '/nope');
  assert.equal(res.status, 404);
  dispose();
});

test('skills/install/archive installs from a real zip body and reports state', async () => {
  const { requestRaw, dispose } = boot();
  const zip = makeZip([
    { name: 'repo-main/', body: '' },
    { name: 'repo-main/LICENSE', body: 'mit' },
    { name: 'repo-main/zipped/SKILL.md', body: '---\nname: zipped\ndescription: from a zip\n---\nbody\n' },
  ]);
  const res = await requestRaw('POST', '/skills/install/archive?scope=user&fileName=bundle.zip', zip);
  assert.equal(res.status, 200);
  assert.equal(res.payload.ok, true);
  assert.deepEqual(res.payload.installed.map((s) => s.name), ['zipped']);
  // Neither the `repo-main/` wrapper nor its LICENSE is a skill; the wrapper is
  // peeled and the non-.md file is simply not a candidate, so nothing is
  // reported as skipped.
  assert.deepEqual(res.payload.skipped, []);
  // The response carries refreshed state with the new skill in it.
  assert.ok(res.payload.state.globalSkills.some((s) => s.name === 'zipped'));
  assert.ok(existsSync(join(process.env.DSH_HOME, 'skills', 'zipped', 'SKILL.md')));
  dispose();
});

test('skills/install/archive installs a tar.gz body', async () => {
  const { requestRaw, dispose } = boot();
  const tar = makeTar([{ name: 'tarball/SKILL.md', body: '---\nname: tarball\ndescription: from a tar\n---\nbody\n' }]);
  const gz = gzipSync(tar);
  const res = await requestRaw('POST', '/skills/install/archive?fileName=x.tar.gz', gz);
  assert.equal(res.status, 200);
  assert.deepEqual(res.payload.installed.map((s) => s.name), ['tarball']);
  assert.ok(existsSync(join(process.env.DSH_HOME, 'skills', 'tarball', 'SKILL.md')));
  dispose();
});

test('skills/install/archive installs a root-SKILL.md bundle (skillhub shape)', async () => {
  // Regression: a skillhub.cn zip carries SKILL.md at its root beside resource
  // folders. The lone `references/` folder used to be peeled as a wrapper while
  // the root SKILL.md was ignored, so the route reported nothing installable.
  const { requestRaw, dispose } = boot();
  const zip = makeZip([
    { name: 'references/', body: '' },
    { name: 'references/writing-guide.md', body: 'guide' },
    { name: 'SKILL.md', body: '---\nname: hub-skill\ndescription: from skillhub\n---\nbody\n' },
    { name: '_meta.json', body: '{"slug":"hub-skill"}' },
  ]);
  const res = await requestRaw('POST', '/skills/install/archive?fileName=lsp.zip', zip);
  assert.equal(res.status, 200);
  assert.deepEqual(res.payload.installed.map((s) => s.name), ['hub-skill']);
  assert.deepEqual(res.payload.skipped, []);
  const skillDir = join(process.env.DSH_HOME, 'skills', 'hub-skill');
  assert.ok(existsSync(join(skillDir, 'SKILL.md')));
  // Resources land inside the skill, and the bundle is listed as a usable skill.
  assert.ok(existsSync(join(skillDir, 'references', 'writing-guide.md')));
  assert.ok(existsSync(join(skillDir, '_meta.json')));
  const row = res.payload.state.globalSkills.find((s) => s.name === 'hub-skill');
  assert.ok(row, 'the installed skill must appear in the refreshed state');
  assert.equal(row.invalid, null, 'the installed skill must parse cleanly');
  assert.equal(row.enabled, true);
  dispose();
});

test('skills/install/archive installs a deflate (method 8) root-SKILL.md bundle', async () => {
  // The lsp-novel-writer bundle from skillhub.cn is a deflate zip with SKILL.md
  // at its root — the exact shape that historically read as "no installable
  // skills" because its entries were compressed (method 8) and the lone
  // references/ folder used to be stripped as a wrapper.
  const { requestRaw, dispose } = boot();
  const zip = makeZip([
    { name: 'references/writing-guide.md', body: 'guide', method: 8 },
    { name: 'SKILL.md', body: '---\nname: novel-writer\ndescription: 小说写作助手\n---\nbody\n', method: 8 },
    { name: '_meta.json', body: '{"slug":"novel-writer"}', method: 8 },
  ]);
  const res = await requestRaw('POST', '/skills/install/archive?fileName=novel-writer-1.0.0.zip', zip);
  assert.equal(res.status, 200);
  assert.deepEqual(res.payload.installed.map((s) => s.name), ['novel-writer']);
  assert.deepEqual(res.payload.skipped, []);
  const skillDir = join(process.env.DSH_HOME, 'skills', 'novel-writer');
  assert.ok(existsSync(join(skillDir, 'SKILL.md')));
  assert.ok(existsSync(join(skillDir, 'references', 'writing-guide.md')));
  assert.ok(existsSync(join(skillDir, '_meta.json')));
  const row = res.payload.state.globalSkills.find((s) => s.name === 'novel-writer');
  assert.ok(row, 'the deflated-installed skill must be listed');
  assert.equal(row.invalid, null, 'its SKILL.md must parse cleanly after deflate');
  dispose();
});

test('skills/install/archive rejects an unsupported body with a translated error', async () => {
  const { requestRaw, dispose } = boot();
  const res = await requestRaw('POST', '/skills/install/archive?fileName=x.rar', Buffer.from('definitely not an archive'));
  assert.equal(res.status, 400);
  assert.ok(/zip|tar/u.test(res.payload.error), `expected a format hint, got: ${res.payload.error}`);
  dispose();
});

test('skills/install/archive refuses a project outside the registered roots', async () => {
  const { requestRaw, dispose } = boot();
  const zip = makeZip([{ name: 'a/SKILL.md', body: '---\nname: a\ndescription: d\n---\nx\n' }]);
  const res = await requestRaw(
    'POST',
    `/skills/install/archive?scope=project&project=${encodeURIComponent(join(dir, 'not-registered'))}&fileName=x.zip`,
    zip,
  );
  assert.equal(res.status, 400);
  assert.ok(/roots|目录/u.test(res.payload.error));
  dispose();
});