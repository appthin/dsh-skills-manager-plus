/**
 * dsh-skills-manager-plus — archive extraction.
 *
 * Reads a zip, tar or tar.gz archive into a flat list of safe, normalized
 * entries so the host half can install downloaded skills from a bundle
 * (e.g. a zip from skillhub.cn or a GitHub "Download ZIP" / tarball).
 *
 * Node's `node:zlib` only exposes single-stream decompression (gzip/raw
 * deflate), not a zip/tar *container* reader, so this module owns the
 * container parsing and leans on zlib for the per-entry payloads:
 * - zip: parse the local headers / central directory and inflate each entry
 *   with `inflateRawSync` (store + deflate are supported; encrypted or exotic
 *   methods are refused rather than guessed at).
 * - tar / tar.gz: walk the 512-byte headers (`gunzipSync`-ing first for a
 *   `.tar.gz` / `.tgz`), assembling names from the ustar prefix.
 *
 * Every returned entry name is normalized with forward slashes and confined to
 * a relative path that stays under the archive root: absolute paths, drive
 * letters, `.`/`..` segments and null bytes are rejected outright. This is the
 * boundary that makes writing to disk safe.
 *
 * @module dsh-skills-manager-plus/archives
 */

import { gunzipSync, inflateRawSync } from 'node:zlib';

const SIG_EOCD = 0x06054b50; // PK\x05\x06
const SIG_LOCATOR = 0x07064b50; // PK\x06\x07
const SIG_ZIP64 = 0x06064b50; // PK\x06\x06
const SIG_CENTRAL = 0x02014b50; // PK\x01\x02
const SIG_LOCAL = 0x04034b50; // PK\x03\x04

const CENTRAL_FIXED = 46;
const LOCAL_FIXED = 30;

/**
 * A single decompressed file inside an archive.
 * @typedef {{ name: string, data: Buffer }} ArchiveEntry
 */

/** Refuse a decompressed path if it could escape the archive root. */
function normalizeEntryName(raw) {
  // Reject binary filenames / UTF-16 encodings rather than mangle them.
  if (raw.includes('\0')) return null;
  const segments = raw.split('/');
  const out = [];
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') return null;
    out.push(segment);
  }
  if (out.length === 0) return null;
  const first = out[0];
  // Absolute POSIX paths and Windows drive/UNC roots escape the archive.
  if (
    first.startsWith('\\') ||
    first.startsWith('/') ||
    /^[A-Za-z]:[/\\]/u.test(first) ||
    first.startsWith('\\\\')
  ) {
    return null;
  }
  return out.join('/');
}

/** Thrown by `extractArchive`, carrying a stable machine-readable code. */
export class ArchiveError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * Locate the End Of Central Directory record, transparently handling the
 * zip64 EOCD when the archive needs it (many entries or large offsets).
 * @returns {{ count: number, cdOffset: number, cdSize: number }}
 */
function zipEocd(buf) {
  const eocdAt = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocdAt < 0) throw new ArchiveError('notZip', 'not a zip archive');

  let entries = buf.readUInt16LE(eocdAt + 10);
  let cdSize = buf.readUInt32LE(eocdAt + 12);
  let cdOffset = buf.readUInt32LE(eocdAt + 16);

  const needsZip64 = entries === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff;
  if (needsZip64) {
    const locatorAt = eocdAt - 20;
    if (locatorAt >= 0 && buf.readUInt32LE(locatorAt) === SIG_LOCATOR) {
      const z64At = Number(buf.readBigUInt64LE(locatorAt + 8));
      if (z64At >= 0 && z64At + 56 <= buf.length && buf.readUInt32LE(z64At) === SIG_ZIP64) {
        entries = Number(buf.readBigUInt64LE(z64At + 40));
        cdSize = Number(buf.readBigUInt64LE(z64At + 48));
        cdOffset = Number(buf.readBigUInt64LE(z64At + 56));
      }
    }
  }
  return { count: entries, cdOffset, cdSize };
}

/** Read the zip64 extended-information extra for one central-directory record. */
function readZip64Extra(extra, needs) {
  const result = {};
  let o = 0;
  while (o + 4 <= extra.length) {
    const tag = extra.readUInt16LE(o);
    const size = extra.readUInt16LE(o + 2);
    const body = extra.subarray(o + 4, o + 4 + size);
    if (tag === 0x0001) {
      let p = 0;
      const big = () => {
        const value = Number(body.readBigUInt64LE(p));
        p += 8;
        return value;
      };
      for (const key of needs.order) {
        if (needs[key]) result[key] = big();
      }
      break;
    }
    o += 4 + size;
  }
  return result;
}

/**
 * Read one central-directory record into `{ name, flags, method, compSize,
 * uncompSize, compressed, localOffset }`, applying the local header's extra
 * length so the entry data is located exactly.
 */
function readCentralEntry(buf, offset) {
  if (offset + CENTRAL_FIXED > buf.length || buf.readUInt32LE(offset) !== SIG_CENTRAL) {
    throw new ArchiveError('corruptZip', 'corrupt zip central directory');
  }
  const flags = buf.readUInt16LE(offset + 8);
  const method = buf.readUInt16LE(offset + 10);
  let crc = buf.readUInt32LE(offset + 16);
  let compSize = buf.readUInt32LE(offset + 20);
  let uncompSize = buf.readUInt32LE(offset + 24);
  const nameLen = buf.readUInt16LE(offset + 28);
  const extraLen = buf.readUInt16LE(offset + 30);
  const commentLen = buf.readUInt16LE(offset + 32);
  let localOffset = buf.readUInt32LE(offset + 42);

  // The trailing slash is the only thing marking a directory, and
  // `normalizeEntryName` strips it — so record it before normalizing.
  const rawName = buf
    .subarray(offset + CENTRAL_FIXED, offset + CENTRAL_FIXED + nameLen)
    .toString('utf8');
  const isDir = rawName.endsWith('/');
  const name = normalizeEntryName(rawName);
  const extra = buf.subarray(offset + CENTRAL_FIXED + nameLen, offset + CENTRAL_FIXED + nameLen + extraLen);

  const needs = { order: ['uncompSize', 'compSize', 'localOffset'], uncompSize: uncompSize === 0xffffffff, compSize: compSize === 0xffffffff, localOffset: localOffset === 0xffffffff };
  if (needs.uncompSize || needs.compSize || needs.localOffset) {
    const z64 = readZip64Extra(extra, needs);
    if (z64.uncompSize !== undefined) uncompSize = z64.uncompSize;
    if (z64.compSize !== undefined) compSize = z64.compSize;
    if (z64.localOffset !== undefined) localOffset = z64.localOffset;
  }

  if (name === null) throw new ArchiveError('badPath', 'archive contains an unsafe path');

  // Read the local header to get the data start offset (its extra length is
  // authoritative for where compressed data begins).
  if (localOffset + LOCAL_FIXED > buf.length || buf.readUInt32LE(localOffset) !== SIG_LOCAL) {
    throw new ArchiveError('corruptZip', 'corrupt zip local header');
  }
  const localExtraLen = buf.readUInt16LE(localOffset + 28);
  const dataStart = localOffset + LOCAL_FIXED + buf.readUInt16LE(localOffset + 26) + localExtraLen;
  if (dataStart + compSize > buf.length) throw new ArchiveError('corruptZip', 'zip entry data out of bounds');

  return { name, isDir, flags, method, crc, compSize, uncompSize, dataStart };
}

/** Inflate one zip entry's compressed bytes by its compression method. */
function inflateZipEntry(entry, raw) {
  if (entry.isDir) return ''; // directory marker, no payload
  if (entry.flags & 0x1) throw new ArchiveError('unsupported', `encrypted entries are not supported: ${entry.name}`);
  if (entry.method === 0) return raw.subarray(entry.dataStart, entry.dataStart + entry.compSize);
  if (entry.method === 8) return inflateRawSync(raw.subarray(entry.dataStart, entry.dataStart + entry.compSize));
  throw new ArchiveError('unsupported', `unsupported zip compression method ${entry.method}: ${entry.name}`);
}

/** Decompress a zip buffer into normalized entries. */
function extractZip(buf) {
  const eocd = zipEocd(buf);
  const entries = [];
  let offset = eocd.cdOffset;
  for (let i = 0; i < eocd.count; i += 1) {
    const entry = readCentralEntry(buf, offset);
    const data = inflateZipEntry(entry, buf);
    if (data !== '') entries.push({ name: entry.name, data });
    offset +=
      CENTRAL_FIXED +
      buf.readUInt16LE(offset + 28) +
      buf.readUInt16LE(offset + 30) +
      buf.readUInt16LE(offset + 32);
  }
  return entries;
}

/**
 * Walk a tar byte stream into normalized entries. Handles ustar (and GNU)
 * prefixes and honors every record's declared `size` even for non-file types
 * (links, PAX headers, sparse placeholders), so the walk stays aligned.
 */
function extractTar(buf) {
  const entries = [];
  let offset = 0;
  while (offset + 512 <= buf.length) {
    const block = buf.subarray(offset, offset + 512);
    const nameField = block.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
    if (nameField === '') break; // two zero blocks end the archive
    const sizeField = block.subarray(124, 136).toString('utf8').trim();
    const type = block.slice(156, 157).toString('utf8');
    const prefix = block.subarray(345, 500).toString('utf8').replace(/\0.*$/s, '');

    const size = parseInt(sizeField.length === 0 ? '0' : sizeField, 8);
    if (Number.isNaN(size) || size < 0) throw new ArchiveError('corruptTar', 'corrupt tar header');
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > buf.length) throw new ArchiveError('corruptTar', 'tar entry data out of bounds');

    const fullName = prefix !== '' ? `${prefix}/${nameField}` : nameField;
    const name = normalizeEntryName(fullName);
    if (name !== null && name !== '' && (type === '0' || type === '7' || type === '' || type === '\0')) {
      entries.push({ name, data: buf.subarray(dataStart, dataEnd) });
    }
    offset = (dataEnd + 511) & ~511;
  }
  return entries;
}

/**
 * Extract an archive from raw bytes into normalized entries.
 * @param {Buffer} buffer - the whole uploaded archive.
 * @param {string} fileName - original file name, used to pick the format.
 * @returns {ArchiveEntry[]}
 */
export function extractArchive(buffer, fileName) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8) throw new ArchiveError('empty', 'the uploaded file is empty or too small');
  const name = typeof fileName === 'string' ? fileName.toLowerCase() : '';
  const zipBySig =
    buffer.length >= 4 && (buffer.readUInt32LE(0) === SIG_LOCAL || buffer.readUInt32LE(0) === SIG_EOCD);
  const gzipBySig = buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;

  if (zipBySig || name.endsWith('.zip')) return extractZip(buffer);
  if (gzipBySig || name.endsWith('.tar.gz') || name.endsWith('.tgz')) return extractTar(gunzipSync(buffer));
  if (name.endsWith('.tar')) return extractTar(buffer);
  throw new ArchiveError('unsupported', 'unsupported archive type (expected zip, tar or tar.gz)');
}