'use strict';

const path = require('node:path');
const { execFile, execFileSync } = require('node:child_process');
const { promisify } = require('node:util');
const { windows } = require('./common');
const run = promisify(execFile);
const winShell = process.env.SystemRoot
  ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  : 'powershell.exe';
const opts = { timeout: 4500, maxBuffer: 4 * 1024 * 1024, windowsHide: true, encoding: 'utf8' };
const winRows = String.raw`[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false);
Get-CimInstance Win32_Process | ForEach-Object {
  $cmd = $_.CommandLine
  $name = $_.Name
  $isCodex = $name -match '^codex(?:-x86_64-pc-windows-msvc|-aarch64-pc-windows-msvc)?\.exe$'
  $isNode = $name -match '^node\.exe$' -and $cmd -match '[\\/](@openai[\\/]codex[\\/]bin[\\/]codex\.(m?js)|codex\.(m?js))(?=["\s]|$)'
  [pscustomobject]@{pid=$_.ProcessId; parent=$_.ParentProcessId; start=([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds(); codex=($isCodex -or $isNode); shared=($cmd -match '\bapp-server\b') }
} | ConvertTo-Json -Compress`;
const command = windows ? [winShell, ['-NoProfile', '-NonInteractive', '-Command', winRows]]
  : ['ps', ['-axo', 'pid=,ppid=,lstart=,comm=,args=']];

function parse(output) {
  if (windows) return new Map([].concat(JSON.parse(output)).map(row => [row.pid, row]));
  const rows = new Map();
  for (const line of output.split('\n')) {
    const fields = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\d+:\d+:\d+\s+\d+)\s+(\S+)\s*(.*)$/);
    if (!fields) continue;
    const [, pid, parent, start, comm, args] = fields;
    const binary = path.basename(comm);
    const codex = /^codex(?:-(?:x86_64|aarch64)-(?:apple-darwin|unknown-linux-(?:gnu|musl)))?$/.test(binary)
      || /^(?:[^\s]+\/)?node(?:js)?\s+.*(?:\/|^)(?:@openai\/codex\/bin\/)?codex\.m?js(?:\s|$)/.test(args);
    rows.set(Number(pid), {
      pid: Number(pid), parent: Number(parent), start: Date.parse(start), codex,
      shared: /\bapp-server\b/.test(args), zombie: /^\[.*\]\s+<defunct>$/.test(args)
    });
  }
  return rows;
}

function live(owner, rows) {
  const current = rows.get(owner.pid);
  return current && current.start === owner.start && !current.zombie;
}

function resolve(rows, from) {
  let owner = null;
  let childStart = Infinity;
  for (let steps = 0; from && steps < 24; steps++) {
    const row = rows.get(from);
    if (!row || !Number.isFinite(row.start) || row.start > childStart) break;
    if (row.codex) owner = { pid: row.pid, start: row.start, shared: Boolean(row.shared) };
    else if (owner) break;
    from = row.parent;
    childStart = row.start;
  }
  return owner;
}

function processesSync() {
  return parse(execFileSync(...command, { ...opts, env: { ...process.env, LC_ALL: 'C' } }));
}

async function processes() {
  const { stdout } = await run(...command, { ...opts, env: { ...process.env, LC_ALL: 'C' } });
  return parse(stdout);
}

module.exports = { winShell, processes, processesSync, resolve, live, parse };
