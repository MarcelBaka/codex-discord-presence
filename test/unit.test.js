'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Rollout, usageSince } = require('../app/rollout');
const { resolve, live } = require('../app/processes');
const { selected } = require('../app/registry');
const { category, eventFrom } = require('../app/hook');
const { defaultAppId, parseConfig } = require('../app/common');
const { localPricing, validatePricing, iconRefreshInterval } = require('../app/network');
const { formatUsage } = require('../app/presence');
const { Discord, frame, decoder, discordPaths } = require('../app/ipc');
const { desktopExec } = require('../app/install');
const { extract, crc32 } = require('../app/update');

const timestamp = '2026-11-23T20:37:00.000Z';

function usage(input, cached, output, reasoning = 0) {
  return { input_tokens: input, cached_input_tokens: cached, output_tokens: output, reasoning_output_tokens: reasoning };
}

function line(type, payload, time = timestamp) {
  return JSON.stringify({ type, timestamp: time, payload }) + '\n';
}

function count(total, last, time) {
  return line('event_msg', { type: 'token_count', info: { total_token_usage: total, last_token_usage: last },
    rate_limits: { plan_type: 'plus' } }, time);
}

test('usage comes from request and cumulative pairs, applies the resume cutoff, and survives partial writes and rewrites', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crp-unit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'rollout-test.jsonl');
  const context = line('turn_context', { model: 'gpt-6.2-sol', effort: 'high', turn_id: 'turn' });
  const first = usage(21859, 14976, 79);
  const pair = count(usage(46721, 36864, 274, 56), usage(24862, 21888, 195, 56), '2026-11-23T21:37:00.000Z');
  const firstRecord = line('token_usage_record', { response_id: 'resp-1', turn_id: 'turn',
    thread_token_usage: first, usage: first });
  fs.writeFileSync(file, context + firstRecord + firstRecord + count(first, first) + pair.slice(0, -1));
  const rollout = new Rollout(file);
  assert.equal(rollout.scan(), true);
  assert.equal(rollout.records.length, 1);
  assert.equal(rollout.plan, 'Plus');
  assert.equal(rollout.effort, 'high');
  assert.equal(usageSince([rollout], 0, localPricing()).tokens, 6962);
  fs.appendFileSync(file, '\n');
  rollout.scan();
  const resumed = usageSince([rollout], Date.parse('2026-11-23T21:00:00Z'), localPricing());
  assert.equal(resumed.tokens, 3169);
  assert.equal(resumed.reasoning, 56);
  assert.ok(Math.abs(resumed.cost - (2974 * 2 + 21888 * 0.1 + 195 * 10) / 1e6) < 1e-12);
  fs.writeFileSync(file, context + count(first, first));
  rollout.scan();
  assert.equal(rollout.records.length, 1);
  fs.writeFileSync(file, context + count(first, first) + pair + pair);
  rollout.scan();
  assert.equal(rollout.records.length, 2);
  assert.equal(usageSince([rollout], 0, localPricing()).tokens, 10131);
});

test('elapsed time and selection use the active process identity and user input', () => {
  const rows = new Map([
    [8, { pid: 8, parent: 7, start: 1200 }],
    [7, { pid: 7, parent: 6, start: 1100, codex: true, shared: true }],
    [6, { pid: 6, parent: 2, start: 1000, codex: true }],
    [2, { pid: 2, parent: 1, start: 500 }]
  ]);
  const owner = resolve(rows, 8);
  assert.deepEqual(owner, { pid: 6, start: 1000, shared: false });
  assert.ok(live(owner, rows));
  rows.get(6).start = 9000;
  assert.ok(!live(owner, rows));
  const sessions = [{ id: 'new', lastInput: 12, opened: 12 }, { id: 'resume', lastInput: 0, opened: 15 }];
  assert.equal(selected(sessions, () => ({ promptAt: 7 })).id, 'new');
});

test('mixed usage shows a partial price without omitting unpriced tokens', () => {
  const priced = { at: 1, model: 'gpt-6.2-sol',
    usage: { input: 100000, cached: 0, output: 0, reasoning: 0, write: 0 } };
  const unpriced = { ...priced, model: 'codex-auto-review' };
  const pricing = localPricing();
  assert.equal(formatUsage(usageSince([{ records: [priced, unpriced] }], 0, pricing)),
    '200K tokens · ~$0.20 (partial)');
  assert.equal(formatUsage(usageSince([{ records: [unpriced] }], 0, pricing)), '100K tokens');
  assert.equal(formatUsage(usageSince([{ records: [priced] }], 0, pricing)), '100K tokens · ~$0.20');
  assert.equal(iconRefreshInterval(null), 60_000);
  assert.equal(iconRefreshInterval('https://cdn.discordapp.com/icon.png'), 86_400_000);
});

test('sanitize tool events and use only recognized settings and IPC locations', () => {
  const event = eventFrom({
    session_id: 's', turn_id: 't', hook_event_name: 'PreToolUse', tool_name: 'apply_patch',
    tool_input: 'secret-command', model: 'gpt-6.2-sol', cwd: '/some/path'
  }, 123);
  assert.deepEqual(event, { id: 's', turn: 't', at: 123, type: 'PreToolUse', category: 'edit' });
  assert.equal(category('mcp__some_connector__private_tool'), 'tool');
  assert.equal(defaultAppId, '1574523878280007710');
  assert.throws(() => parseConfig({ aliases: { myproject: 'https://example.com' } }));
  assert.throws(() => validatePricing({ asOf: '2026-11-23', models: { model: { input: -1, cached: 0, output: 1 } } }));
  assert.ok(discordPaths('linux', { XDG_RUNTIME_DIR: '/run/user/123' })
    .includes(path.join('/run/user/123', 'app/com.discordapp.Discord', 'discord-ipc-0')));
  assert.equal(discordPaths('win32', {})[0], '\\\\?\\pipe\\discord-ipc-0');
  assert.equal(desktopExec(['a b"$' + String.fromCharCode(96) + '\\%']),
    '"' + 'a b' + '\\\\"' + '\\\\$' + '\\\\' + String.fromCharCode(96) + '\\\\\\\\' + '%%' + '"');
});

test('IPC accepts fragmented frames and enforces a rolling update limit', async () => {
  const frames = [];
  const append = decoder((op, body) => frames.push([op, body.toString()]));
  const bytes = Buffer.concat([frame(0, { v: 1 }), frame(3, Buffer.from('hello'))]);
  for (const byte of bytes) append(Buffer.from([byte]));
  assert.deepEqual(frames, [[0, '{"v":1}'], [3, 'hello']]);
  const rpc = new Discord();
  rpc.id = defaultAppId;
  const writes = [];
  rpc.socket = { write(data) { writes.push(data); } };
  rpc.ready = true;
  for (let i = 0; i < 8; i++) {
    await rpc.send(defaultAppId, { details: String(i) });
    clearTimeout(rpc.pending?.timer);
    rpc.pending = null;
  }
  assert.equal(writes.length, 5);
});

function zip(name, bytes) {
  const filename = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50);
  local.writeUInt32LE(crc32(bytes), 14);
  local.writeUInt32LE(bytes.length, 18);
  local.writeUInt32LE(bytes.length, 22);
  local.writeUInt16LE(filename.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50);
  central.writeUInt32LE(crc32(bytes), 16);
  central.writeUInt32LE(bytes.length, 20);
  central.writeUInt32LE(bytes.length, 24);
  central.writeUInt16LE(filename.length, 28);
  const footer = Buffer.alloc(22);
  footer.writeUInt32LE(0x06054b50);
  footer.writeUInt16LE(1, 8);
  footer.writeUInt16LE(1, 10);
  footer.writeUInt32LE(central.length + filename.length, 12);
  footer.writeUInt32LE(local.length + filename.length + bytes.length, 16);
  return Buffer.concat([local, filename, bytes, central, filename, footer]);
}

test('built-in ZIP extraction checks entries and rejects traversal', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crp-zip-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.throws(() => extract(zip('../escape', Buffer.from('a')), dir), /Unsafe/);
  extract(zip('app/version.json', Buffer.from('b')), dir);
  assert.equal(fs.readFileSync(path.join(dir, 'app/version.json'), 'utf8'), 'b');
});
