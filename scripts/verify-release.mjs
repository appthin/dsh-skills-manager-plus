#!/usr/bin/env node
/**
 * Release verification for dsh-skills-manager-plus.
 *
 * Answers one question: is the version in `package.json` actually obtainable
 * everywhere a user can get it? A successful `npm publish` only proves the
 * registry accepted the upload — it does not prove the version is visible, that
 * a mirror has synced it, that the sources it claims to come from exist, or
 * that the plugin market still lists this repo.
 *
 * Checks, in order:
 *   1. npmjs        — version present, `latest` points at it, tarball shasum.
 *   2. gitHead      — the published package must name a commit that is pushed,
 *                     otherwise npm metadata points at a commit nobody has.
 *   3. npmmirror    — the China mirror carries the same version, byte-identical
 *                     (shasum match). `--sync` triggers the mirror sync first.
 *   4. GitHub       — tag `v<version>` and a published Release exist.
 *   5. dsh-market   — the catalog entry is still on the market's `main`.
 *
 * Usage:
 *   node scripts/verify-release.mjs
 *   node scripts/verify-release.mjs --sync
 *   node scripts/verify-release.mjs --proxy socks5h://127.0.0.1:1080
 *   VERIFY_PROXY=socks5h://127.0.0.1:1080 npm run verify:release
 *
 * Options:
 *   --sync              trigger the npmmirror sync, then wait for it.
 *   --proxy <url>       route registry traffic through a proxy. Accepts
 *                       `socks5h://host:port` (proxy resolves DNS, which is what
 *                       a hijacked local resolver needs), `socks5://host:port`,
 *                       or an `http://host:port` CONNECT proxy.
 *   --timeout <secs>    per-request timeout, default 60.
 *   --market <owner/repo>  market catalog to check, default awesome-dsh-plugin/awesome-dsh-plugin.
 *
 * Environment:
 *   GITHUB_TOKEN   required for the GitHub checks (a token with `repo` scope).
 *                  Without it steps 4 and 5 are reported as skipped.
 *   VERIFY_PROXY   same as `--proxy`. Use this with `npm run`, because npm
 *                  consumes a literal `--proxy` as its own config flag and never
 *                  forwards it to the script.
 *
 * Exit code 0 only when every executed check passes.
 *
 * @module dsh-skills-manager-plus/scripts/verify-release
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MARKET_DEFAULT = 'awesome-dsh-plugin/awesome-dsh-plugin';
const MIRROR = 'https://registry.npmmirror.com';
const NPMJS = 'https://registry.npmjs.org';

// ── arguments ───────────────────────────────────────────────────────────────

function parseArgs(argv) {
  // VERIFY_PROXY exists because `npm run … -- --proxy X` does NOT reach this
  // script: npm claims `--proxy` as its own config flag before the script sees
  // it. An environment variable cannot be swallowed that way.
  const options = { sync: false, proxy: process.env.VERIFY_PROXY ?? '', timeout: 60, market: MARKET_DEFAULT };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${flag} needs a value`);
      i += 1;
      return value;
    };
    if (flag === '--sync') options.sync = true;
    else if (flag === '--proxy') options.proxy = next();
    else if (flag === '--timeout') options.timeout = Number(next());
    else if (flag === '--market') options.market = next();
    else throw new Error(`unknown argument ${flag}`);
  }
  return options;
}

// ── HTTP through curl (Node's fetch cannot speak SOCKS) ─────────────────────

/** Map a proxy URL onto curl's matching flag so the proxy resolves DNS too. */
function proxyArgs(proxy) {
  if (proxy === '') return [];
  const match = /^(socks5h|socks5|socks4|http|https):\/\/(.+)$/.exec(proxy);
  if (match === null) throw new Error(`--proxy must be a URL, got ${JSON.stringify(proxy)}`);
  const [, scheme, host] = match;
  if (scheme === 'socks5h') return ['--socks5-hostname', host];
  if (scheme === 'socks5') return ['--socks5', host];
  if (scheme === 'socks4') return ['--socks4a', host];
  return ['--proxy', `${scheme}://${host}`];
}

/**
 * Run one request and return its body as text.
 * @returns `{ status, body }`; a transport failure throws with curl's own message.
 */
function request(url, { method = 'GET', proxy = '', timeout = 60, headers = [] } = {}) {
  const args = [
    '-sS', '--max-time', String(timeout), '-X', method,
    ...proxyArgs(proxy),
    ...headers.flatMap(([name, value]) => ['-H', `${name}: ${value}`]),
    '-w', '\n%{http_code}',
    url,
  ];
  const result = spawnSync('curl', args, { encoding: 'utf8', windowsHide: true });
  if (result.error !== undefined) throw new Error(`curl could not run: ${result.error.message}`);
  if (result.status !== 0) {
    // Surface curl's own diagnosis: a TLS trust failure here is the signature of
    // a hijacked resolver, and it must not be papered over.
    const detail = String(result.stderr ?? '').trim().split('\n').pop() ?? '';
    const hint = result.status === 60
      ? ' — TLS trust failure: a hijacked resolver is presenting a self-signed cert. Route through --proxy/VERIFY_PROXY; never disable certificate checks.'
      : '';
    throw new Error(`curl exit ${result.status}${detail === '' ? '' : `: ${detail}`}${hint}`);
  }
  const out = String(result.stdout ?? '');
  const split = out.lastIndexOf('\n');
  return { status: Number(out.slice(split + 1).trim()), body: out.slice(0, split) };
}

function getJson(url, options) {
  const response = request(url, options);
  if (response.status === 404) return undefined;
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`GET ${url} -> HTTP ${response.status}`);
  }
  return JSON.parse(response.body);
}

// ── checks ──────────────────────────────────────────────────────────────────

const results = [];
function record(name, status, detail) {
  results.push({ name, status, detail });
  const mark = status === 'pass' ? '\u2714' : status === 'fail' ? '\u2716' : '\u25CB';
  console.log(`${mark} ${name.padEnd(34)} ${detail}`);
}

/** Registry metadata for one package, or undefined when absent. */
function registryDoc(base, name, options) {
  return getJson(`${base}/${encodeURIComponent(name)}`, options);
}

function shasumOf(doc, version) {
  return doc?.versions?.[version]?.dist?.shasum;
}

/** Block synchronously — this script is a plain top-to-bottom run. */
function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const manifest = JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf8'));
  const { name, version } = manifest;

  const repoUrl = typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url ?? '';
  const repo = /github\.com[/:]([^/]+\/[^/.]+)(?:\.git)?/.exec(repoUrl)?.[1] ?? '';
  const tag = `v${version}`;
  const net = { proxy: options.proxy, timeout: options.timeout };
  const token = process.env.GITHUB_TOKEN ?? '';
  const headers = token === ''
    ? []
    : [['Authorization', `Bearer ${token}`], ['Accept', 'application/vnd.github+json']];

  console.log(`\n${name}@${version}${repo ? `  (${repo})` : ''}\n`);

  // 1 + 2 — npmjs
  let npmDoc;
  try {
    npmDoc = registryDoc(NPMJS, name, net);
  } catch (error) {
    record('npmjs reachable', 'fail', String(error.message));
  }
  if (npmDoc !== undefined) {
    const published = npmDoc.versions?.[version] !== undefined;
    record('npmjs has the version', published ? 'pass' : 'fail', published ? version : `missing (latest ${npmDoc['dist-tags']?.latest})`);
    const isLatest = npmDoc['dist-tags']?.latest === version;
    record('npmjs latest points at it', isLatest ? 'pass' : 'fail', `latest=${npmDoc['dist-tags']?.latest}`);

    // npm records the commit it published from; an unpushed commit leaves a
    // dangling reference that confuses the market's repo<->npm linkage.
    const gitHead = npmDoc.versions?.[version]?.gitHead;
    if (gitHead === undefined) {
      record('gitHead recorded', 'warn', 'absent (published outside a git checkout?)');
    } else if (token !== '' && repo !== '') {
      // Ask GitHub directly whether that commit is an ancestor of the default
      // branch. Local remote-tracking refs go stale when a push used an
      // explicit URL, so they are not a reliable source for this.
      try {
        const meta = getJson(`https://api.github.com/repos/${repo}`, { ...net, headers });
        const branch = meta?.default_branch ?? 'main';
        const compare = getJson(`https://api.github.com/repos/${repo}/compare/${gitHead}...${branch}`, { ...net, headers });
        const onBranch = compare?.status === 'identical' || compare?.status === 'ahead';
        record('gitHead is a pushed commit', onBranch ? 'pass' : 'fail', `${gitHead.slice(0, 12)} on ${branch}: ${compare?.status ?? 'unknown'}`);
      } catch (error) {
        record('gitHead is a pushed commit', 'fail', String(error.message));
      }
    } else {
      let localHead = '';
      try {
        localHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: join(HERE, '..'), encoding: 'utf8' }).trim();
      } catch { /* not a checkout — skip the comparison */ }
      const pushed = (() => {
        try {
          const out = execFileSync('git', ['branch', '-r', '--contains', gitHead], { cwd: join(HERE, '..'), encoding: 'utf8' });
          return out.trim() !== '';
        } catch { return false; }
      })();
      record('gitHead is a pushed commit', pushed ? 'pass' : 'fail', `${gitHead.slice(0, 12)}${localHead === gitHead ? ' = HEAD' : ''}`);
    }
  }

  // 3 — npmmirror
  if (options.sync) {
    try {
      const response = request(`${MIRROR}/-/package/${encodeURIComponent(name)}/syncs`, { ...net, method: 'PUT' });
      const body = JSON.parse(response.body);
      record('npmmirror sync triggered', response.status < 300 ? 'pass' : 'fail', `state=${body.state ?? response.status}`);
    } catch (error) {
      record('npmmirror sync triggered', 'fail', String(error.message));
    }
  }
  try {
    let mirrorDoc;
    // The mirror picks the version up asynchronously; poll briefly after --sync.
    const attempts = options.sync ? 12 : 1;
    for (let i = 0; i < attempts; i += 1) {
      mirrorDoc = registryDoc(MIRROR, name, net);
      if (mirrorDoc?.versions?.[version] !== undefined || i === attempts - 1) break;
      sleep(15000);
    }
    const present = mirrorDoc?.versions?.[version] !== undefined;
    record('npmmirror has the version', present ? 'pass' : 'fail', present ? version : `missing (latest ${mirrorDoc?.['dist-tags']?.latest})`);
    if (present && npmDoc !== undefined) {
      const same = shasumOf(mirrorDoc, version) === shasumOf(npmDoc, version);
      record('mirror bytes match npmjs', same ? 'pass' : 'fail', shasumOf(mirrorDoc, version) ?? 'no shasum');
    }
  } catch (error) {
    record('npmmirror reachable', 'fail', String(error.message));
  }

  // 4 + 5 — GitHub (tag/release, and the market listing)
  if (token === '' || repo === '') {
    record('GitHub tag + release', 'skip', token === '' ? 'set GITHUB_TOKEN to enable' : 'no GitHub repository field');
    record('market entry present', 'skip', 'set GITHUB_TOKEN to enable');
  } else {
    try {
      const release = getJson(`https://api.github.com/repos/${repo}/releases/tags/${tag}`, { ...net, headers });
      const published = release !== undefined && release.draft === false;
      record('GitHub release published', published ? 'pass' : 'fail', release === undefined ? `${tag} not found` : `draft=${release.draft}`);
    } catch (error) {
      record('GitHub release published', 'fail', String(error.message));
    }
    try {
      // The catalog names each entry after the PLUGIN's own owner/repo.
      const entry = `${repo.replace('/', '__')}.yml`;
      const listed = getJson(
        `https://api.github.com/repos/${options.market}/contents/data/plugins/${entry}?ref=main`,
        { ...net, headers },
      );
      record('market entry present', listed !== undefined ? 'pass' : 'fail', listed === undefined ? `${entry} absent on main` : entry);
    } catch (error) {
      record('market entry present', 'fail', String(error.message));
    }
  }

  const failed = results.filter((r) => r.status === 'fail');
  const skipped = results.filter((r) => r.status === 'skip').length;
  const run = results.length - skipped;
  console.log(`\n${run - failed.length}/${run} checks passed${skipped > 0 ? ` (${skipped} skipped)` : ''}`);
  if (failed.length > 0) {
    console.log('failed: ' + failed.map((r) => r.name).join(', '));
    process.exitCode = 1;
  }
}

main();
