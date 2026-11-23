'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash, randomUUID } = require('node:crypto');
const { windows, codex, root, mkdir, optional, read, write, configFile, defaults, locked } = require('./common');
const { events } = require('./hook');
const version = require('./version.json').version;
const lockFile = path.join(root, 'install.lock');
const hooksFile = path.join(codex, 'hooks.json');
const pointerFile = path.join(root, 'current.json');
const tag = 'Codex Discord Presence';
const latch = () => { throw Error('Another installation or removal is in progress'); };

function shellQuote(arg) { return "'" + arg.replace(/'/g, "'\\''") + "'"; }
function psQuote(arg) { return "'" + arg.replace(/'/g, "''") + "'"; }
function xml(arg) { return arg.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function desktopExec(args) {
  return args.map(arg => {
    const quoted = '"' + arg.replace(/["\\$`]/g, '\\$&').replace(/%/g, '%%') + '"';
    return quoted.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
  }).join(' ');
}

function launcher() { return path.join(root, 'launch.cjs'); }

function hookCommands() {
  const prefix = ['CODEX_HOME=' + shellQuote(codex), 'CODEX_PRESENCE_HOME=' + shellQuote(root)];
  const command = [...prefix, shellQuote(process.execPath), shellQuote(launcher()), 'hook'].join(' ');
  const script = [$env('CODEX_HOME', codex), $env('CODEX_PRESENCE_HOME', root),
    '& ' + psQuote(process.execPath) + ' ' + psQuote(launcher()) + ' hook'].join('; ');
  const commandWindows = 'powershell.exe -NoProfile -NonInteractive -EncodedCommand ' +
    Buffer.from(script, 'utf16le').toString('base64');
  return { command, commandWindows };
}

function $env(key, value) { return '$env:' + key + '=' + psQuote(value); }

function readHooks() {
  const data = optional(hooksFile, { hooks: {} });
  if (!data || Array.isArray(data) || typeof data !== 'object' ||
    (data.hooks && (Array.isArray(data.hooks) || typeof data.hooks !== 'object'))) {
    throw Error('Codex hooks.json has an unsupported structure');
  }
  return { ...data, hooks: { ...data.hooks } };
}

function belongs(handler) {
  return typeof handler?.statusMessage === 'string' && handler.statusMessage === tag &&
    (handler.command === hookCommands().command || typeof handler.command === 'string' &&
      handler.command.includes(shellQuote(launcher())));
}

function modifyHooks(add) {
  if (!add && !fs.existsSync(hooksFile)) return;
  const data = readHooks();
  const before = JSON.stringify(data);
  for (const event of events) {
    if (data.hooks[event] !== undefined && !Array.isArray(data.hooks[event])) throw Error('Invalid Codex hook group');
    const groups = (data.hooks[event] || []).flatMap(group => {
      if (!Array.isArray(group?.hooks) || !group.hooks.some(belongs)) return [group];
      const remaining = group.hooks.filter(handler => !belongs(handler));
      return remaining.length ? [{ ...group, hooks: remaining }] : [];
    });
    if (add) {
      const options = {
        type: 'command', ...hookCommands(), statusMessage: tag,
        timeout: event === 'SessionEnd' || event === 'Interrupt' ? 3 : 12,
        async: event === 'PreToolUse' || event === 'PostToolUse'
      };
      groups.push({
        ...(event === 'SessionStart' ? { matcher: 'startup|resume|clear|fork' } : {}),
        hooks: [options]
      });
    }
    if (groups.length) data.hooks[event] = groups;
    else delete data.hooks[event];
  }
  if (JSON.stringify(data) === before) return;
  if (fs.existsSync(hooksFile)) {
    const backup = hooksFile + '.presence-' + Date.now() + '-' + randomUUID() + '.bak';
    fs.copyFileSync(hooksFile, backup, fs.constants.COPYFILE_EXCL);
  }
  write(hooksFile, data);
}

function startupEntry() {
  const args = [process.execPath, launcher(), '_start'];
  if (windows) {
    const folder = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
      'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
    const quote = arg => '"' + arg.replace(/"/g, '""') + '"';
    const command = args.map(arg => '"' + arg + '"').join(' ');
    return [path.join(folder, 'Codex Discord Presence.vbs'),
      'Set sh = CreateObject("WScript.Shell")\r\n' +
      'sh.Environment("PROCESS")("CODEX_HOME") = ' + quote(codex) + '\r\n' +
      'sh.Environment("PROCESS")("CODEX_PRESENCE_HOME") = ' + quote(root) + '\r\n' +
      'sh.Run ' + quote(command) + ', 0, False\r\n'];
  }
  if (process.platform === 'darwin') {
    return [path.join(os.homedir(), 'Library', 'LaunchAgents', 'io.github.codex-discord-presence.plist'),
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
      '<plist version="1.0"><dict><key>Label</key><string>io.github.codex-discord-presence</string>' +
      '<key>RunAtLoad</key><true/><key>EnvironmentVariables</key><dict><key>CODEX_HOME</key><string>' +
      xml(codex) + '</string><key>CODEX_PRESENCE_HOME</key><string>' + xml(root) + '</string></dict>' +
      '<key>ProgramArguments</key><array>' + args.map(arg => '<string>' + xml(arg) + '</string>').join('') +
      '</array></dict></plist>\n'];
  }
  const dir = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'autostart');
  return [path.join(dir, 'codex-discord-presence.desktop'),
    '[Desktop Entry]\nType=Application\nName=Codex Discord Presence\nExec=' +
    desktopExec(['env', 'CODEX_HOME=' + codex, 'CODEX_PRESENCE_HOME=' + root, ...args]) +
    '\nTerminal=false\n'];
}

function setAutostart(enabled) {
  const [file, content] = startupEntry();
  const bytes = windows ? Buffer.from('\uFEFF' + content, 'utf16le') : Buffer.from(content);
  if (fs.existsSync(file) && !fs.readFileSync(file).equals(bytes)) {
    if (enabled) throw Error('The login entry is already used by a different installation');
    return;
  }
  if (enabled) write(file, bytes, true);
  else fs.rmSync(file, { force: true });
}

function install(autostart) {
  return locked(lockFile, latch, () => {
    readHooks();
    const settings = { ...optional(configFile, defaults) };
    if (autostart !== undefined) settings.autostart = autostart;
    const existing = optional(pointerFile);
    const source = fs.readdirSync(__dirname).filter(name => /\.(?:js|cjs|json)$/.test(name)).sort();
    const hash = createHash('sha256');
    for (const name of source) hash.update(name).update(fs.readFileSync(path.join(__dirname, name)));
    const directory = version + '-' + hash.digest('hex').slice(0, 12);
    const destination = path.join(root, 'versions', directory);
    mkdir(destination);
    for (const name of source) {
      const from = path.join(__dirname, name);
      const to = path.join(destination, name);
      if (from !== to) write(to, fs.readFileSync(from), true);
    }
    write(launcher(), fs.readFileSync(path.join(__dirname, 'launch.cjs')), true);
    if (!existing || existing.directory !== directory) write(pointerFile, { directory, version });
    modifyHooks(true);
    write(configFile, settings);
    if (autostart !== undefined) setAutostart(autostart);
    return directory;
  });
}

function uninstall() {
  return locked(lockFile, latch, () => {
    modifyHooks(false);
    setAutostart(false);
    fs.rmSync(pointerFile, { force: true });
    fs.rmSync(launcher(), { force: true });
    const versions = path.join(root, 'versions');
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (entry.isFile() && ['config.json', 'registry.json', 'status.json', 'presence.log', 'presence.log.1',
        'pricing-cache.json', 'update-check.json'].includes(entry.name)) fs.unlinkSync(path.join(root, entry.name));
      if (entry.isFile() && /^icon-\d{17,20}\.json$/.test(entry.name)) fs.unlinkSync(path.join(root, entry.name));
      if (entry.isDirectory() && ['events', 'owners'].includes(entry.name)) {
        const safe = path.join(root, entry.name);
        if (path.dirname(fs.realpathSync(safe)) !== fs.realpathSync(root)) throw Error('Unexpected data directory');
        fs.rmSync(safe, { recursive: true, force: true });
      }
    }
    if (fs.existsSync(versions)) {
      if (path.dirname(fs.realpathSync(versions)) !== fs.realpathSync(root)) throw Error('Unexpected versions directory');
      fs.rmSync(versions, { recursive: true, force: true });
    }
  });
}

module.exports = { install, uninstall, desktopExec, hookCommands, startupEntry, setAutostart, hooksFile, launcher };
