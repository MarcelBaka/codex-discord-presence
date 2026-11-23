'use strict';

const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { windows, uid, gate, socketDir } = require('./common');

function connect(endpoint, timeout = 400) {
  return new Promise(resolve => {
    const socket = net.createConnection(endpoint);
    const failed = () => { socket.destroy(); resolve(null); };
    socket.on('error', failed);
    socket.setTimeout(timeout, failed);
    socket.once('connect', () => {
      socket.setTimeout(0);
      socket.removeListener('error', failed);
      socket.on('error', () => {});
      resolve(socket);
    });
  });
}

async function request(command, endpoint = gate) {
  const socket = await connect(endpoint, 250);
  if (!socket) return null;
  return new Promise(resolve => {
    let data = '';
    socket.setTimeout(500, () => socket.destroy());
    socket.on('data', chunk => { data += chunk; if (data.length > 1000) socket.destroy(); });
    socket.once('close', () => resolve(data.trim() || null));
    socket.end(command + '\n');
  });
}

async function singleton(handler) {
  if (!windows) {
    try { fs.mkdirSync(socketDir, { mode: 0o700 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    const dir = fs.lstatSync(socketDir);
    if (!dir.isDirectory() || dir.uid !== uid || (dir.mode & 0o077)) throw Error('Unsafe socket directory');
  }

  const socketServer = net.createServer({ allowHalfOpen: true }, socket => {
    let line = '';
    socket.on('error', () => {});
    socket.setTimeout(800, () => socket.destroy());
    socket.on('data', data => {
      line += data;
      if (line.length > 32) socket.destroy();
      else if (line.includes('\n')) {
        const cmd = line.trim();
        if (cmd === 'wake' || cmd === 'stop') handler(cmd);
        socket.end('ok\n');
      }
    });
  });
  function listen() {
    return new Promise((resolve, reject) => {
      socketServer.once('error', reject);
      socketServer.listen(gate, () => { socketServer.removeListener('error', reject); resolve(); });
    });
  }
  try { await listen(); return socketServer; }
  catch (error) { if (error.code !== 'EADDRINUSE') throw error; }
  if (windows || await request('ping')) return null;

  // Multiple crash recoveries contend for a second socket; only its live owner may unlink the stale endpoint.
  // The guard is a loopback TCP port owned by the kernel and released on crash.
  const port = 32000 + (parseInt(path.basename(socketDir).slice(-4), 16) % 20000);
  const guard = net.createServer(socket => socket.destroy());
  const acquired = await new Promise(resolve => {
    guard.on('error', () => resolve(false));
    guard.listen(port, '127.0.0.1', () => resolve(true));
  });
  if (!acquired) return null;
  try {
    const current = await connect(gate);
    if (current) { current.destroy(); return null; }
    try {
      if (!fs.lstatSync(gate).isSocket()) throw Error('Invalid socket endpoint');
      fs.unlinkSync(gate);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    try { await listen(); return socketServer; }
    catch (error) { if (error.code === 'EADDRINUSE') return null; throw error; }
  } finally {
    guard.close();
  }
}

function discordPaths(platform = process.platform, env = process.env) {
  if (env.CODEX_PRESENCE_DISCORD_IPC) return [env.CODEX_PRESENCE_DISCORD_IPC];
  if (platform === 'win32') return Array.from({ length: 10 }, (_, i) => '\\\\?\\pipe\\discord-ipc-' + i);
  const dirs = [env.XDG_RUNTIME_DIR, env.TMPDIR, env.TMP, env.TEMP, os.tmpdir(), '/tmp'].filter(Boolean);
  const subdirs = ['', 'app/com.discordapp.Discord', 'app/com.discordapp.DiscordCanary',
    'app/com.discordapp.DiscordPTB', 'snap.discord', 'snap.discord-canary'];
  return [...new Set(dirs.flatMap(dir => subdirs.flatMap(sub =>
    Array.from({ length: 10 }, (_, i) => path.join(dir, sub, 'discord-ipc-' + i)))))];
}

function frame(op, value) {
  const body = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(8);
  header.writeUInt32LE(op, 0);
  header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
}

function decoder(onFrame) {
  let buffered = Buffer.alloc(0);
  return chunk => {
    buffered = Buffer.concat([buffered, chunk]);
    while (buffered.length >= 8) {
      const length = buffered.readUInt32LE(4);
      if (length > 1024 * 1024) throw Error('oversized IPC packet');
      if (buffered.length < 8 + length) return;
      const op = buffered.readUInt32LE(0);
      const body = buffered.subarray(8, 8 + length);
      buffered = buffered.subarray(8 + length);
      onFrame(op, body);
    }
  };
}

class Discord {
  constructor(onEvent = () => {}) {
    this.onEvent = onEvent;
    this.sent = [];
    this.next = 0;
    this.backoff = 1000;
  }

  async open(id) {
    for (const endpoint of discordPaths()) {
      const socket = await connect(endpoint, 120);
      if (!socket) continue;
      this.socket = socket;
      this.ready = false;
      this.last = undefined;
      const timeout = setTimeout(() => { if (!this.ready) socket.destroy(); }, 2500);
      const onData = decoder((op, bytes) => {
        if (op === 2) return socket.destroy();
        if (op === 3) return socket.write(frame(4, bytes));
        if (op !== 1) return;
        const msg = JSON.parse(bytes);
        if (msg.evt === 'READY') {
          clearTimeout(timeout);
          this.ready = true;
          this.backoff = 1000;
          this.onEvent('discord connected');
        } else if (msg.nonce && this.pending?.nonce === msg.nonce) {
          clearTimeout(this.pending.timer);
          if (msg.evt === 'ERROR') {
            this.onEvent('discord rejected activity');
            this.next = Date.now() + 20_000;
            socket.destroy();
          } else {
            this.last = this.pending.value;
            this.onEvent('discord acknowledged activity');
          }
          this.pending = null;
        }
      });
      socket.on('data', chunk => { try { onData(chunk); } catch { socket.destroy(); } });
      socket.once('close', () => {
        clearTimeout(timeout);
        if (this.socket !== socket) return;
        clearTimeout(this.pending?.timer);
        this.pending = null;
        this.socket = null;
        this.ready = false;
        this.next = Math.max(this.next, Date.now() + this.backoff);
        this.backoff = Math.min(this.backoff * 2, 30_000);
        this.onEvent('discord disconnected');
      });
      socket.write(frame(0, { v: 1, client_id: id }));
      return;
    }
    this.next = Date.now() + this.backoff;
    this.backoff = Math.min(this.backoff * 2, 30_000);
  }

  async send(id, activity) {
    if (id !== this.id) {
      this.close();
      this.id = id;
      this.next = 0;
      this.backoff = 1000;
    }
    const now = Date.now();
    if (!this.socket && now >= this.next) await this.open(id);
    if (!this.ready || this.pending) return false;
    const value = JSON.stringify(activity);
    if (value === this.last) return true;
    this.sent = this.sent.filter(when => now - when < 20_000);
    if (this.sent.length >= 5) return false;
    const nonce = randomUUID();
    this.sent.push(now);
    const timer = setTimeout(() => this.socket?.destroy(), 3000);
    this.pending = { nonce, value, timer };
    this.socket.write(frame(1, { cmd: 'SET_ACTIVITY', args: { pid: process.pid, activity }, nonce }));
    return false;
  }

  close() {
    clearTimeout(this.pending?.timer);
    this.pending = null;
    this.socket?.destroy();
    this.socket = null;
    this.ready = false;
  }
}

module.exports = { connect, request, singleton, discordPaths, frame, decoder, Discord };
