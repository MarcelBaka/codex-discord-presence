'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { inflateRawSync } = require('node:zlib');
const { execFile, execFileSync } = require('node:child_process');
const { promisify } = require('node:util');
const { upstream, root, optional, write, config } = require('./common');
const { githubToken, get } = require('./network');
const version = require('./version.json').version;
const releaseName = 'codex-discord-presence.zip';
const limit = 32 * 1024 * 1024;
const run = promisify(execFile);
const crcTable = Array.from({ length: 256 }, (_, i) => {
  let value = i;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function extract(zip, directory) {
  let footer = -1;
  for (let offset = zip.length - 22; offset >= Math.max(0, zip.length - 65_557); offset--) {
    if (zip.readUInt32LE(offset) === 0x06054b50 && offset + 22 + zip.readUInt16LE(offset + 20) === zip.length) {
      footer = offset;
      break;
    }
  }
  if (footer < 0 || zip.readUInt16LE(footer + 4) || zip.readUInt16LE(footer + 6)) throw Error('Invalid ZIP footer');
  const entries = zip.readUInt16LE(footer + 10);
  let cursor = zip.readUInt32LE(footer + 16);
  const start = cursor;
  if (entries > 200 || entries !== zip.readUInt16LE(footer + 8) ||
    start + zip.readUInt32LE(footer + 12) !== footer) throw Error('Invalid ZIP directory');
  let expanded = 0;
  const used = new Set();
  for (let index = 0; index < entries; index++) {
    if (cursor + 46 > footer || zip.readUInt32LE(cursor) !== 0x02014b50) throw Error('Invalid ZIP entry');
    const flags = zip.readUInt16LE(cursor + 8);
    const method = zip.readUInt16LE(cursor + 10);
    const checksum = zip.readUInt32LE(cursor + 16);
    const compressedSize = zip.readUInt32LE(cursor + 20);
    const size = zip.readUInt32LE(cursor + 24);
    const nameLength = zip.readUInt16LE(cursor + 28);
    const extraLength = zip.readUInt16LE(cursor + 30);
    const commentLength = zip.readUInt16LE(cursor + 32);
    const mode = zip.readUInt32LE(cursor + 38) >>> 16;
    const local = zip.readUInt32LE(cursor + 42);
    const name = zip.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    cursor += 46 + nameLength + extraLength + commentLength;
    const parts = name.replace(/\/$/, '').split('/');
    if (cursor > footer || local + 30 > start || zip.readUInt32LE(local) !== 0x04034b50 ||
      (flags & 1) || ![0, 8].includes(method) || (mode & 0xf000) === 0xa000 ||
      parts.some(part => !/^[\w.-]+$/.test(part) || part === '.' || part === '..' ||
        /\.$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
      throw Error('Unsafe ZIP entry');
    }
    const nameStart = local + 30;
    const nameEnd = nameStart + zip.readUInt16LE(local + 26);
    const dataStart = nameEnd + zip.readUInt16LE(local + 28);
    if (zip.toString('utf8', nameStart, nameEnd) !== name || dataStart + compressedSize > start) {
      throw Error('Inconsistent ZIP entry');
    }
    const key = parts.join('/').toLowerCase();
    if (used.has(key)) throw Error('Duplicate ZIP entry');
    used.add(key);
    expanded += size;
    if (expanded > limit) throw Error('ZIP expands beyond size limit');
    const target = path.join(directory, ...parts);
    if (name.endsWith('/')) {
      fs.mkdirSync(target, { recursive: true, mode: 0o700 });
      continue;
    }
    const compressed = zip.subarray(dataStart, dataStart + compressedSize);
    const bytes = method === 0 ? compressed : inflateRawSync(compressed, { maxOutputLength: Math.max(1, size) });
    if (bytes.length !== size || crc32(bytes) !== checksum) throw Error('Invalid ZIP checksum');
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 });
  }
}

async function gh(endpoint, binary = false) {
  const args = ['api', endpoint];
  if (binary) args.push('--header', 'Accept: application/octet-stream');
  const { stdout } = await run('gh', args, {
    encoding: 'buffer', maxBuffer: limit, timeout: 12_000, windowsHide: true,
    env: { ...process.env, GH_PROMPT_DISABLED: '1' }
  });
  return stdout;
}

async function gitHub(endpoint, binary = false) {
  try { return await get('https://api.github.com/' + endpoint, { githubToken: githubToken(), limit }); }
  catch {
    try { return await gh(endpoint, binary); }
    catch { throw Error('GitHub download unavailable. Sign in with gh auth login for a private repository.'); }
  }
}

async function release(tag) {
  const endpoint = 'repos/' + upstream + '/releases/' + (tag ? 'tags/' + tag : 'latest');
  return JSON.parse(await gitHub(endpoint));
}

function compare(a, b) {
  const left = a.replace(/^v/, '').split('.').map(Number);
  const right = b.replace(/^v/, '').split('.').map(Number);
  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
}

async function update(target, latest, quiet = false) {
  if (target && target !== '--main' && !/^v?\d+\.\d+\.\d+$/.test(target)) {
    throw Error('Usage: update [--main|vX.Y.Z]');
  }
  let bytes;
  let expected;
  if (target === '--main') bytes = await gitHub('repos/' + upstream + '/zipball/main', true);
  else {
    const result = latest || await release(target && 'v' + target.replace(/^v/, ''));
    if (!/^v\d+\.\d+\.\d+$/.test(result.tag_name)) throw Error('Unexpected release version');
    expected = result.tag_name.slice(1);
    const asset = result.assets?.find(entry => entry.name === releaseName);
    if (!asset || !Number.isSafeInteger(asset.id)) throw Error('The release ZIP is unavailable');
    const endpoint = 'repos/' + upstream + '/releases/assets/' + asset.id;
    try {
      bytes = await get('https://api.github.com/' + endpoint, {
        limit, githubToken: githubToken(), accept: 'application/octet-stream'
      });
      if (bytes.readUInt32LE(0) !== 0x04034b50) bytes = await gh(endpoint, true);
    } catch { bytes = await gh(endpoint, true); }
  }
  if (quiet) {
    const status = optional(path.join(root, 'status.json'));
    if (!config().autoUpdate || status?.activeSessions > 0) return version;
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-presence-update-'));
  try {
    extract(bytes, directory);
    const top = fs.readdirSync(directory, { withFileTypes: true });
    const base = top.length === 1 && top[0].isDirectory() ? path.join(directory, top[0].name) : directory;
    const installed = JSON.parse(fs.readFileSync(path.join(base, 'app', 'version.json'), 'utf8')).version;
    if (!/^\d+\.\d+\.\d+$/.test(installed) || (expected && expected !== installed)) throw Error('Release version mismatch');
    execFileSync(process.execPath, [path.join(base, 'app', 'cli.js'), 'install'], {
      windowsHide: true, timeout: 8000, stdio: 'ignore'
    });
    return installed;
  } finally {
    if (path.dirname(fs.realpathSync(directory)) !== fs.realpathSync(os.tmpdir()) ||
      !path.basename(directory).startsWith('codex-presence-update-')) throw Error('Unexpected extraction directory');
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

async function autoUpdate() {
  const file = path.join(root, 'update-check.json');
  const previous = optional(file);
  if (previous && Date.now() - previous.checked < 86_400_000) return;
  write(file, { checked: Date.now() });
  const latest = await release();
  if (/^v\d+\.\d+\.\d+$/.test(latest.tag_name) && compare(latest.tag_name, version) > 0) {
    await update(undefined, latest, true);
  }
}

module.exports = { extract, update, autoUpdate, crc32 };
