#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { root, configFile, defaults, config, paused, parseConfig, optional, write, label,
  statusFile, codex, defaultAppId, log, locked } = require('./common');
const { request, connect, discordPaths } = require('./ipc');
const { hook, spawnDaemon } = require('./hook');
const { install, uninstall, setAutostart, hooksFile, launcher } = require('./install');
const { processes } = require('./processes');
const version = require('./version.json').version;

function print(data) { console.log(typeof data === 'string' ? data : JSON.stringify(data, null, 2)); }

async function change(fn) {
  locked(path.join(root, 'settings.lock'), () => { throw Error('Settings are being changed'); }, () => {
    const current = parseConfig(optional(configFile, defaults));
    fn(current);
    write(configFile, parseConfig(current));
  });
  await request('wake');
}

async function start() {
  if (config().enabled && !await request('wake')) await spawnDaemon();
}

async function doctor() {
  let accessible = false;
  for (const endpoint of discordPaths()) {
    const socket = await connect(endpoint, 100);
    if (!socket) continue;
    socket.destroy();
    accessible = true;
    break;
  }
  let localCli;
  try {
    localCli = execFileSync('codex', ['--version'], {
      encoding: 'utf8', windowsHide: true, timeout: 3500, stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
  } catch { localCli = 'Run codex --version from your own terminal'; }
  let processCounter;
  try { processCounter = [...(await processes()).values()].filter(row => row.codex).length; }
  catch { processCounter = 'Process query failed. Run doctor outside the Codex sandbox.'; }
  print({
    version, node: process.version, platform: process.platform, codex: localCli, codexHome: codex,
    hooks: fs.existsSync(hooksFile) ? 'User hook file exists. Review integration hooks in Codex /hooks.' :
      'No user hook file. Run install.',
    sessions: fs.existsSync(path.join(codex, 'sessions')), codexProcesses: processCounter,
    daemon: Boolean(await request('ping')), discordIpc: accessible ? 'available' : 'Start desktop Discord',
    applicationId: config().appId || defaultAppId,
    paused: paused(config()),
    visibility: 'Enable Activity Privacy in Discord. Add an application icon for the hover text.'
  });
}

async function stopDaemon() {
  if (!await request('stop')) return;
  for (let attempt = 0; attempt < 110; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 200));
    if (!await request('ping')) return;
  }
  throw Error('Daemon did not stop. Retry after its Discord clear operation completes.');
}

function onOff(value) {
  if (!['on', 'off'].includes(value)) throw Error('Expected on or off');
  return value === 'on';
}

async function main(args = process.argv.slice(2)) {
  const [command, arg, ...rest] = args;
  switch (command) {
    case 'hook': return hook();
    case '_serve': return require('./daemon').serve();
    case '_start': return start();
    case 'install': {
      if (args.length > 2 || (arg && arg !== '--autostart')) throw Error('Usage: install [--autostart]');
      install(arg ? true : undefined);
      if (arg) await start();
      print('Installed. Review the Codex Discord Presence entries in /hooks.');
      print('CLI: node "' + launcher() + '" status');
      return;
    }
    case 'uninstall':
      await stopDaemon();
      uninstall();
      print('Uninstalled. Existing Codex hook backups remain available.');
      return;
    case 'version': case '--version': print(version); return;
    case 'doctor': return doctor();
    case 'status': {
      if (!await request('ping')) {
        print({ daemon: 'stopped', enabled: config().enabled, paused: paused(config()), payload: null });
      } else print(optional(statusFile, { daemon: 'starting' }));
      return;
    }
    case 'logs': {
      const file = path.join(root, 'presence.log');
      print(fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trimEnd() : 'No local logs');
      return;
    }
    case 'enable': await change(settings => { settings.enabled = true; }); await start(); return;
    case 'disable':
      await change(settings => { settings.enabled = false; });
      await stopDaemon();
      return;
    case 'pause': {
      const expiry = { '30m': 30 * 60_000, '1h': 60 * 60_000 }[arg || '30m'];
      if (!expiry && arg !== 'forever') throw Error('Usage: pause [30m|1h|forever]');
      await change(settings => { settings.pauseUntil = expiry ? Date.now() + expiry : 'forever'; });
      return;
    }
    case 'resume': await change(settings => { settings.pauseUntil = null; }); await start(); return;
    case 'alias': {
      const name = label(arg);
      const value = label(rest.join(' '));
      if (!name || !value) throw Error('Usage: alias <project> <alias|default>');
      await change(settings => {
        if (value === 'default') delete settings.aliases[name];
        else settings.aliases = Object.fromEntries([...Object.entries(settings.aliases), [name, value]]);
      });
      return;
    }
    case 'hide': await change(settings => { settings.hide = arg ? onOff(arg) : true; }); return;
    case 'set-app-id':
      if (!arg) throw Error('Usage: set-app-id <ID|default>');
      await change(settings => { settings.appId = arg === 'default' ? null : arg; }); return;
    case 'autostart': {
      const enabled = onOff(arg);
      setAutostart(enabled);
      await change(settings => { settings.autostart = enabled; });
      if (enabled) await start();
      return;
    }
    case 'auto-update': await change(settings => { settings.autoUpdate = onOff(arg); }); return;
    case 'update': {
      if (!fs.existsSync(launcher())) throw Error('Install the integration before updating it');
      const result = await require('./update').update(arg);
      print('Installed ' + result + '. Future sessions will use the new version.');
      return;
    }
    case undefined: case '-h': case '--help':
      print('codex-presence install [--autostart] | uninstall | status | doctor | logs | version\n' +
        'enable | disable | pause [30m|1h|forever] | resume | alias <project> <alias|default> | hide [on|off]\n' +
        'set-app-id <ID|default> | autostart on|off | auto-update on|off | update [--main|vX.Y.Z]');
      return;
    default: throw Error('Unknown command: ' + command);
  }
}

if (require.main === module) main().catch(error => {
  if (!['hook', '_serve'].includes(process.argv[2])) console.error(error.message);
  else log('integration could not start');
  process.exitCode = 1;
});

module.exports = { main };
