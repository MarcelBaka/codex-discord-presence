'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const { request } = require('./ipc');
const { processesSync, resolve, winShell } = require('./processes');
const { windows, root, spool, textId, write, log, config } = require('./common');

const events = [
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse',
  'PermissionRequest', 'Stop', 'Interrupt', 'SessionEnd'
];

function category(value) {
  if (/^(edit|write|apply_patch)$/i.test(value)) return 'edit';
  if (/^(read|read_file|glob|grep|list_files)$/i.test(value)) return 'read';
  if (/^(bash|exec_command|shell|shell_command|command_execution)$/i.test(value)) return 'run';
  if (/^(web(?:search|fetch|__run|_search)?|search_web)$/i.test(value)) return 'web';
  return 'tool';
}

function eventFrom(input, now) {
  if (!input || !events.includes(input.hook_event_name) || !textId(input.session_id)) return null;
  const type = input.hook_event_name;
  const event = { id: input.session_id, type, at: now, turn: textId(input.turn_id) };
  if (type === 'PreToolUse' || type === 'PostToolUse') {
    event.category = category(typeof input.tool_name === 'string' ? input.tool_name : '');
    return event;
  }
  event.model = textId(input.model);
  if (type === 'SessionEnd') {
    try { event.owner = resolve(processesSync(), process.pid); }
    catch { log('process lookup unavailable during hook'); }
  }
  if (['SessionStart', 'UserPromptSubmit'].includes(type)) {
    if (typeof input.cwd === 'string' && path.isAbsolute(input.cwd)) event.cwd = input.cwd;
    if (typeof input.transcript_path === 'string' && path.isAbsolute(input.transcript_path)) {
      event.transcript = input.transcript_path;
    }
    event.resume = input.source === 'resume' || input.source === 'fork';
    event.owner = null;
    if (type === 'SessionStart' || !fs.existsSync(path.join(root, 'owners', event.id + '.json'))) {
      try { event.owner = resolve(processesSync(), process.pid); }
      catch { log('process lookup unavailable during hook'); }
    }
  }
  return event;
}

function launcherArgs() {
  const launcher = path.join(root, 'launch.cjs');
  return [fs.existsSync(launcher) ? launcher : path.join(__dirname, 'cli.js'), '_serve'];
}

function spawnDaemon() {
  const args = launcherArgs();
  if (windows && args[0].endsWith('launch.cjs')) {
    const context = Object.fromEntries(['CODEX_HOME', 'CODEX_PRESENCE_HOME', 'CODEX_PRESENCE_DISCORD_IPC']
      .filter(key => process.env[key]).map(key => [key, process.env[key]]));
    args.push('context=' + Buffer.from(JSON.stringify(context)).toString('base64url'));
    const command = [process.execPath, ...args].map(arg => '"' + arg + '"').join(' ');
    const body = [
      '$startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ShowWindow=0; CreateFlags=134217728}',
      "$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ProcessStartupInformation=$startup; CommandLine='" +
        command.replace(/'/g, "''") + "'}",
      'if ($r.ReturnValue -ne 0) { exit 1 }'].join('; ');
    return new Promise(resolve => {
      execFile(winShell, ['-NoProfile', '-NonInteractive', '-EncodedCommand',
        Buffer.from(body, 'utf16le').toString('base64')], { windowsHide: true, timeout: 2200 }, error => {
        if (error) detached(args);
        resolve();
      });
    });
  }
  detached(args);
}

function detached(args) {
  const child = spawn(process.execPath, args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => log('daemon launch failed'));
  child.unref();
}

async function hook() {
  const at = Date.now();
  try {
    const data = [];
    let bytes = 0;
    for await (const part of process.stdin) {
      bytes += part.length;
      if (bytes > 16 * 1024 * 1024) return;
      data.push(part);
    }
    const event = eventFrom(JSON.parse(Buffer.concat(data).toString('utf8').replace(/^\uFEFF/, '')), at);
    if (!event) return;
    write(path.join(spool, String(at) + '-' + randomUUID() + '.json'), event);
    const response = await request('wake');
    if (!response && ['SessionStart', 'UserPromptSubmit'].includes(event.type) && config().enabled) {
      await spawnDaemon();
    }
  } catch { log('hook input or local write failed'); }
}

module.exports = { events, category, eventFrom, hook, spawnDaemon };
