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
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'smp-host-'));
process.env.DSH_HOME = join(dir, 'dsh');
process.env.DSH_AGENTS_HOME = join(dir, 'agents');
mkdirSync(join(dir, 'dsh', 'skills'), { recursive: true });
mkdirSync(join(dir, 'agents', 'skills'), { recursive: true });

const plugin = await import('../lib/index.js');
const API_PREFIX = '/skills-manager-plus';
const projectRoot = join(dir, 'proj-alpha');
mkdirSync(projectRoot, { recursive: true });

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

  function dispose() {
    for (const cleanup of cleanups) {
      try {
        cleanup();
      } catch {
        // already disposed
      }
    }
  }

  return { request, registeredCommands, dispose };
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