'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash, randomUUID } = require('node:crypto');

const windows = process.platform === 'win32';
const codex = path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
const root = path.resolve(process.env.CODEX_PRESENCE_HOME || (windows && process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA, 'Codex Discord Presence')
  : path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'codex-discord-presence')));
const uid = process.getuid?.();
const digest = createHash('sha256').update(windows ? root.toLowerCase() : root).digest('hex').slice(0, 24);
const socketDir = path.join(os.tmpdir(), 'codex-presence-' + uid + '-' + digest);
const gate = windows ? '\\\\.\\pipe\\codex-presence-' + digest : path.join(socketDir, 'ipc');
const spool = path.join(root, 'events');
const configFile = path.join(root, 'config.json');
const statusFile = path.join(root, 'status.json');
const defaultAppId = '1574523878280007710';
const upstream = 'MarcelBaka/codex-discord-presence';

const defaults = Object.freeze({
  enabled: true, appId: null, pauseUntil: null, hide: false, aliases: {},
  autostart: false, autoUpdate: false, showPlan: true, showToday: true
});

function mkdir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function read(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

function optional(file, fallback = null) {
  try { return read(file); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return fallback; }
}

function write(file, value, raw = false) {
  mkdir(path.dirname(file));
  const temporary = file + '.' + randomUUID() + '.tmp';
  try {
    fs.writeFileSync(temporary, raw ? value : JSON.stringify(value, null, 2) + '\n', {
      mode: 0o600, flag: 'wx'
    });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function locked(file, fallback, action) {
  mkdir(path.dirname(file));
  let fd;
  try { fd = fs.openSync(file, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') return fallback(); throw error; }
  try { return action(); }
  finally {
    fs.closeSync(fd);
    fs.unlinkSync(file);
  }
}

function textId(value) {
  return typeof value === 'string' && /^[\w.:-]{1,128}$/.test(value) ? value : null;
}

function label(value) {
  return typeof value === 'string' && !/[/\\:\u0000-\u001f\u007f]/u.test(value) && value.trim()
    ? Array.from(value.trim()).slice(0, 80).join('') : null;
}

function parseConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Invalid configuration object');
  const result = { ...defaults, ...value };
  for (const key of ['enabled', 'hide', 'autostart', 'autoUpdate', 'showPlan', 'showToday']) {
    if (typeof result[key] !== 'boolean') throw Error('Invalid boolean setting: ' + key);
  }
  if (result.appId !== null && (typeof result.appId !== 'string' || !/^\d{17,20}$/.test(result.appId))) {
    throw Error('Application ID must be a 17–20 digit string or null');
  }
  if (result.pauseUntil !== null && result.pauseUntil !== 'forever' &&
    !(Number.isSafeInteger(result.pauseUntil) && result.pauseUntil > 0)) throw Error('Invalid pause end');
  if (!result.aliases || typeof result.aliases !== 'object' || Array.isArray(result.aliases)) throw Error('Invalid aliases');
  for (const [name, alias] of Object.entries(result.aliases)) {
    if (!label(name) || !label(alias)) throw Error('Invalid project alias');
  }
  return result;
}

function config(previous = { ...defaults, enabled: false, hide: true }) {
  try { return parseConfig(optional(configFile, defaults)); }
  catch { return previous; }
}

function paused(settings, now = Date.now()) {
  return !settings.enabled || settings.pauseUntil === 'forever' || settings.pauseUntil > now;
}

function log(event) {
  const file = path.join(root, 'presence.log');
  try {
    mkdir(root);
    if (fs.existsSync(file) && fs.statSync(file).size >= 128 * 1024) {
      try { fs.renameSync(file, file + '.1'); } catch { return; }
    }
    fs.appendFileSync(file, new Date().toISOString() + ' ' + event + '\n', { mode: 0o600 });
  } catch { /* Logging must never affect Codex. */ }
}

module.exports = {
  windows, codex, root, uid, socketDir, gate, spool, configFile, statusFile, defaultAppId, upstream,
  defaults, mkdir, read, optional, write, locked, textId, label, parseConfig, config, paused, log
};
