/**
 * Tests for the archive readers (lib/archives.js) that back the "install from
 * archive" button. Fixtures are built in-test — a stored (uncompressed) zip and
 * a ustar tar — so the parsers are exercised on real container bytes rather
 * than on stubs.
 *
 * Run with:  node test/archives.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync, gzipSync } from 'node:zlib';

import { ArchiveError, extractArchive } from '../lib/archives.js';

// ── fixture builders ─────────────────────────────────────────────────────────

/**
 * Build a zip with every entry stored (method 0, no compression). The reader
 * does not verify CRCs, so the field is left zeroed.
 * @param {{name: string, body: string}[]} entries
 */
function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const body = Buffer.from(entry.body, 'utf8');

    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0); // local header signature
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // method 0 = stored
    local.writeUInt32LE(0, 14); // crc (unchecked)
    local.writeUInt32LE(body.length, 18); // compressed size
    local.writeUInt32LE(body.length, 22); // uncompressed size
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra length
    name.copy(local, 30);
    locals.push(local, body);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0); // central signature
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8); // flags
    central.writeUInt16LE(0, 10); // method 0
    central.writeUInt32LE(0, 16); // crc
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(body.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt32LE(offset, 42); // local header offset
    name.copy(central, 46);
    centrals.push(central);

    offset += local.length + body.length;
  }

  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8); // entries on this disk
  eocd.writeUInt16LE(entries.length, 10); // total entries
  eocd.writeUInt32LE(cd.length, 12); // central directory size
  eocd.writeUInt32LE(offset, 16); // central directory offset
  return Buffer.concat([...locals, cd, eocd]);
}

/** Build a ustar tar containing the given regular files. */
function makeTar(entries) {
  const blocks = [];
  for (const entry of entries) {
    const body = Buffer.from(entry.body, 'utf8');
    const header = Buffer.alloc(512);
    header.write(entry.name, 0, 'utf8'); // name
    header.write('0000644\0', 100, 'utf8'); // mode
    header.write('0000000\0', 108, 'utf8'); // uid
    header.write('0000000\0', 116, 'utf8'); // gid
    header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124, 'utf8'); // size
    header.write('00000000000\0', 136, 'utf8'); // mtime
    header.write('        ', 148, 'utf8'); // checksum field (unverified)
    header.write('0', 156, 'utf8'); // type: regular file
    header.write('ustar', 257, 'utf8'); // magic
    header.write('00', 263, 'utf8'); // version
    blocks.push(header, body);

    const pad = (512 - (body.length % 512)) % 512;
    if (pad > 0) blocks.push(Buffer.alloc(pad));
  }
  blocks.push(Buffer.alloc(1024)); // two zero blocks terminate the archive
  return Buffer.concat(blocks);
}

// ── zip ──────────────────────────────────────────────────────────────────────

test('extractArchive reads a stored zip into normalized entries', () => {
  const zip = makeZip([
    { name: 'skill/SKILL.md', body: '---\nname: skill\ndescription: d\n---\nbody\n' },
    { name: 'skill/notes.md', body: 'notes' },
  ]);
  const entries = extractArchive(zip, 'bundle.zip');
  assert.deepEqual(entries.map((e) => e.name), ['skill/SKILL.md', 'skill/notes.md']);
  assert.equal(entries[0].data.toString('utf8'), '---\nname: skill\ndescription: d\n---\nbody\n');
});

test('extractArchive detects a zip by signature even with no file name', () => {
  const zip = makeZip([{ name: 'a.md', body: 'x' }]);
  assert.deepEqual(extractArchive(zip, '').map((e) => e.name), ['a.md']);
});

// ── tar / tar.gz ─────────────────────────────────────────────────────────────

test('extractArchive reads a plain tar', () => {
  const tar = makeTar([{ name: 'skill/SKILL.md', body: 'body' }]);
  const entries = extractArchive(tar, 'bundle.tar');
  assert.deepEqual(entries.map((e) => e.name), ['skill/SKILL.md']);
  assert.equal(entries[0].data.toString('utf8'), 'body');
});

test('extractArchive gunzips a .tar.gz and a .tgz', () => {
  const gz = gzipSync(makeTar([{ name: 'skill/SKILL.md', body: 'gz body' }]));
  for (const name of ['bundle.tar.gz', 'bundle.tgz']) {
    const entries = extractArchive(gz, name);
    assert.deepEqual(entries.map((e) => e.name), ['skill/SKILL.md'], `via ${name}`);
    assert.equal(entries[0].data.toString('utf8'), 'gz body');
  }
});

test('extractArchive detects gzip by signature even with no file name', () => {
  const gz = gzipSync(makeTar([{ name: 'a/SKILL.md', body: 'x' }]));
  assert.deepEqual(extractArchive(gz, '').map((e) => e.name), ['a/SKILL.md']);
});

// ── safety & errors ──────────────────────────────────────────────────────────

test('extractArchive refuses traversal and absolute entries', () => {
  const zip = makeZip([
    { name: '../evil.md', body: 'x' },
    { name: '/etc/passwd', body: 'x' },
    { name: 'ok.md', body: 'x' },
  ]);
  // An unsafe name aborts the archive rather than installing a partial set.
  assert.throws(() => extractArchive(zip, 'evil.zip'), (error) => {
    assert.ok(error instanceof ArchiveError);
    assert.equal(error.code, 'badPath');
    return true;
  });
});

test('extractArchive drops directory markers instead of emitting empty files', () => {
  // Regression: `zip -r`/Finder/Explorer record every folder as a `<dir>/`
  // entry. `normalizeEntryName` strips the trailing slash, so those entries
  // used to survive as empty files and then collide with mkdir (EEXIST).
  const zip = makeZip([
    { name: 'skills/', body: '' },
    { name: 'skills/my-skill/', body: '' },
    { name: 'skills/my-skill/scripts/', body: '' },
    { name: 'skills/my-skill/SKILL.md', body: 'body' },
    { name: 'skills/my-skill/scripts/run.md', body: 'run' },
  ]);
  assert.deepEqual(
    extractArchive(zip, 'x.zip').map((e) => e.name),
    ['skills/my-skill/SKILL.md', 'skills/my-skill/scripts/run.md'],
  );
});

test('extractArchive rejects an empty buffer and an unknown format', () => {
  assert.throws(() => extractArchive(Buffer.alloc(0), 'x.zip'), (error) => error.code === 'empty');
  assert.throws(() => extractArchive(Buffer.from('not an archive at all'), 'x.rar'), (error) => error.code === 'unsupported');
});

test('extractArchive refuses a corrupt zip', () => {
  const zip = makeZip([{ name: 'a.md', body: 'x' }]);
  const broken = Buffer.from(zip);
  broken.writeUInt32LE(0xdeadbeef, broken.length - 22); // kill the EOCD signature
  assert.throws(() => extractArchive(broken, 'x.zip'), (error) => {
    assert.ok(error instanceof ArchiveError);
    return true;
  });
});

test('extractArchive round-trips a tar.gz through gzipSync', () => {
  const tar = makeTar([
    { name: 'one/SKILL.md', body: 'one' },
    { name: 'two/SKILL.md', body: 'two' },
  ]);
  const entries = extractArchive(gzipSync(tar), 'both.tar.gz');
  assert.deepEqual(entries.map((e) => e.name), ['one/SKILL.md', 'two/SKILL.md']);
});
