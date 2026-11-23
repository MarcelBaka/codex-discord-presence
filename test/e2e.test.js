'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { fork, execFile } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { promisify } = require('node:util');
const { frame, decoder } = require('../app/ipc');

const exec = promisify(execFile);
const win = process.platform === 'win32';
const cli = path.resolve(__dirname, '../app/cli.js');
const fakeCodex = path.resolve(__dirname, '../fixtures/codex.js');

const sleep = delay => new Promise(resolve => setTimeout(resolve, delay));

async function wait(check, message, timeout = 18_000) {
  const end = Date.now() + timeout;
  do {
    const value = await check();
    if (value) return value;
    await sleep(150);
  } while (Date.now() < end);
  assert.fail(message);
}

test('installed hooks start one daemon, reconnect IPC, track active projects, and keep tool data private', { timeout: 120_000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'crp-e2e-'));
  const home = path.join(directory, '.codex');
  const data = path.join(directory, 'local presence');
  const logs = path.join(data, 'presence.log');
  const statusFile = path.join(data, 'status.json');
  const endpoint = win ? '\\\\.\\pipe\\crp-mock-' + randomUUID() : path.join(directory, 'discord.sock');
  const env = { ...process.env, CODEX_HOME: home, CODEX_PRESENCE_HOME: data, CODEX_PRESENCE_DISCORD_IPC: endpoint };
  const cmd = (...args) => exec(process.execPath, [cli, ...args], { env, windowsHide: true, timeout: 30_000 });
  const procs = [];
  const sockets = new Set();
  const transcript = [];

  let server;
  async function closeDiscord() {
    for (const socket of sockets) socket.destroy();
    if (server?.listening) await new Promise(resolve => server.close(resolve));
  }

  t.after(async () => {
    try { await cmd('disable'); } catch {}
    for (const child of procs) child.kill();
    await closeDiscord();
    if (path.dirname(fs.realpathSync(directory)) === fs.realpathSync(os.tmpdir())) {
      fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
    }
  });

  const mock = async () => {
    server = net.createServer(socket => {
      sockets.add(socket);
      socket.on('error', () => {});
      socket.on('close', () => sockets.delete(socket));
      socket.on('data', decoder((op, bytes) => {
        const message = JSON.parse(bytes);
        transcript.push({ op, message });
        if (op === 0) {
          socket.write(frame(1, { evt: 'READY' }));
          socket.write(frame(3, { ping: 1 }));
        }
        if (message.cmd === 'SET_ACTIVITY') {
          socket.write(frame(1, { nonce: message.nonce, cmd: message.cmd, evt: null }));
        }
      }));
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(endpoint, resolve); });
  };

  function status() {
    try { return JSON.parse(fs.readFileSync(statusFile)); } catch { return {}; }
  }
  function log() {
    return fs.existsSync(logs) ? fs.readFileSync(logs, 'utf8') : '';
  }

  fs.mkdirSync(path.join(home, 'sessions'), { recursive: true });
  const original = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'existing-private-hook' }] }] } };
  const hooksFile = path.join(home, 'hooks.json');
  fs.writeFileSync(hooksFile, JSON.stringify(original));
  fs.writeFileSync(path.join(home, 'config.toml'), '# preserve literal config\n');
  await cmd('install');
  const installed = JSON.parse(fs.readFileSync(hooksFile));
  await cmd('install');
  assert.deepEqual(JSON.parse(fs.readFileSync(hooksFile)), installed);
  assert.deepEqual(installed.hooks.Stop[0], original.hooks.Stop[0]);
  assert.equal(fs.readFileSync(path.join(home, 'config.toml'), 'utf8'), '# preserve literal config\n');
  assert.equal(fs.readdirSync(home).filter(name => name.endsWith('.bak')).length, 1);

  function project(name) {
    const cwd = path.join(directory, name);
    fs.mkdirSync(cwd);
    const child = fork(fakeCodex, [], { execArgv: [], env, silent: true });
    procs.push(child);
    const file = path.join(home, 'sessions', 'rollout-test-' + name + '.jsonl');
    const row = (type, payload, timestamp = new Date().toISOString()) =>
      fs.appendFileSync(file, JSON.stringify({ type, timestamp, payload }) + '\n');
    row('session_meta', { id: name, cwd });
    return {
      child, row,
      async hook(type, extra = {}) {
        const handler = installed.hooks[type].at(-1).hooks[0];
        const id = randomUUID();
        const message = { id, command: win ? handler.commandWindows : handler.command, payload: {
          session_id: name, hook_event_name: type, transcript_path: file, cwd, model: 'gpt-6.2-sol',
          ...extra
        } };
        const result = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            child.off('message', receive);
            reject(Error('Hook command did not finish: ' + type));
          }, 8000);
          const receive = reply => {
            if (reply.id !== id) return;
            clearTimeout(timer);
            child.off('message', receive);
            resolve(reply);
          };
          child.on('message', receive);
          child.send(message);
        });
        assert.equal(result.code, 0, result.stderr || result.error);
        assert.equal(result.stdout, '');
      }
    };
  }

  const first = project('ProjectAlpha');
  const second = project('ProjectBeta');
  await Promise.all([first.hook('SessionStart', { source: 'startup' }), second.hook('SessionStart', { source: 'resume' })]);
  await wait(() => status().activeSessions === 2, 'hooks did not start the daemon: ' + log());
  assert.equal((log().match(/daemon started/g) || []).length, 1);
  assert.equal(status().payload.details, 'Project: ProjectAlpha');
  const elapsed = status().payload.timestamps.start;
  await first.hook('UserPromptSubmit', { turn_id: 'turn-1', prompt: 'PRIVATE_PROMPT_MARKER' });
  await first.hook('PreToolUse', { turn_id: 'turn-1', tool_name: 'apply_patch',
    tool_input: { path: 'PRIVATE_TOOL_INPUT_MARKER' } });
  await wait(() => status().payload?.state.startsWith('Editing files'), 'tool category not received');
  await first.hook('Stop', { turn_id: 'turn-1' });
  await first.hook('PreToolUse', { turn_id: 'turn-1', tool_name: 'Bash',
    tool_input: { command: 'PRIVATE_TOOL_INPUT_MARKER' } });
  await wait(() => status().payload?.state.startsWith('Waiting for input'), 'late tool revived completed turn');
  const counters = { input_tokens: 200, cached_input_tokens: 100, output_tokens: 20, reasoning_output_tokens: 5 };
  first.row('turn_context', { turn_id: 'turn-1', model: 'gpt-6.2-sol', effort: 'high' });
  first.row('event_msg', { type: 'token_count', info: { total_token_usage: counters, last_token_usage: counters },
    rate_limits: { plan_type: 'plus' } });
  await wait(() => status().sessionUsage?.tokens === 120, 'actual counters absent');
  await mock();
  const payload = () => transcript.filter(row => row.message.cmd === 'SET_ACTIVITY').at(-1)?.message.args.activity;
  await wait(() => payload()?.details === 'Project: ProjectAlpha', 'Discord did not connect after startup');
  assert.equal(payload().type, 3);
  assert.equal(payload().timestamps.start, elapsed);
  assert.ok(transcript.some(row => row.op === 4));
  await closeDiscord();
  await mock();
  await wait(() => transcript.filter(row => row.op === 0).length >= 2, 'Discord did not reconnect');
  await cmd('pause', 'forever');
  await wait(() => payload() === null, 'pausing did not clear presence', 25_000);
  await cmd('resume');
  await wait(() => status().payload?.details === 'Project: ProjectAlpha', 'resume did not restore presence');
  await second.hook('UserPromptSubmit', { turn_id: 'turn-2', prompt: 'PRIVATE_PROMPT_MARKER' });
  await wait(() => status().payload?.details === 'Project: ProjectBeta', 'latest user input did not select the project');
  second.child.kill();
  await wait(() => status().activeSessions === 1 && status().payload?.details === 'Project: ProjectAlpha',
    'dead process stayed registered');
  first.child.kill();
  await wait(() => status().daemon === 'stopped', 'last process exit did not shut down the daemon', 28_000);
  const surfaces = JSON.stringify(transcript) + log() + JSON.stringify(status());
  assert.ok(!surfaces.includes('PRIVATE_PROMPT_MARKER'));
  assert.ok(!surfaces.includes('PRIVATE_TOOL_INPUT_MARKER'));
  assert.ok(!JSON.stringify(transcript).includes(directory));
  await cmd('uninstall');
  assert.deepEqual(JSON.parse(fs.readFileSync(hooksFile)), original);
});
