'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { textId, codex } = require('./common');

const keys = ['input', 'cached', 'output', 'reasoning', 'write'];
const fields = ['input_tokens', 'cached_input_tokens', 'output_tokens',
  'reasoning_output_tokens', 'cache_write_input_tokens'];
const zero = Object.fromEntries(keys.map(key => [key, 0]));

function counters(value) {
  if (!value || value.input_tokens === undefined || value.output_tokens === undefined) return null;
  const usage = Object.fromEntries(keys.map((key, i) => [key, value[fields[i]] ?? 0]));
  if (Object.values(usage).some(number => !Number.isSafeInteger(number) || number < 0)
    || usage.cached + usage.write > usage.input || usage.reasoning > usage.output) return null;
  return usage;
}

function subtract(current, previous) {
  return Object.fromEntries(keys.map(key => [key, current[key] - previous[key]]));
}

function planName(value) {
  return ({ free: 'Free', go: 'Go', plus: 'Plus', pro: 'Pro', prolite: 'Pro',
    pro_lite: 'Pro', team: 'Team', business: 'Business', enterprise: 'Enterprise', edu: 'Edu',
    education: 'Edu' })[String(value).toLowerCase()] || null;
}

class Rollout {
  constructor(file) {
    this.file = file;
    this.reset();
  }

  reset() {
    this.offset = 0;
    this.partial = Buffer.alloc(0);
    this.skipping = false;
    this.anchor = Buffer.alloc(0);
    this.total = null;
    this.records = [];
    this.responses = new Set();
    this.models = new Map();
    this.model = null;
    this.effort = null;
    this.plan = null;
    this.turn = null;
    this.phase = null;
    this.phaseAt = 0;
    this.promptAt = 0;
    this.cwd = null;
    this.id = null;
  }

  consume(row) {
    const data = row?.payload;
    const time = Date.parse(row?.timestamp);
    if (!data || !Number.isFinite(time)) return;
    const turn = textId(data.turn_id);
    if (row.type === 'session_meta') {
      this.id = textId(data.id || data.session_id);
      if (typeof data.cwd === 'string' && path.isAbsolute(data.cwd)) this.cwd = data.cwd;
      return;
    }
    if (row.type === 'turn_context') {
      this.model = textId(data.model) || this.model;
      this.effort = textId(data.effort || data.reasoning_effort);
      if (turn && this.model) this.models.set(turn, this.model);
      if (typeof data.cwd === 'string' && path.isAbsolute(data.cwd)) this.cwd = data.cwd;
      return;
    }
    if (row.type === 'token_usage_record') {
      const id = textId(data.response_id);
      if (!id || this.responses.has(id)) return;
      const usage = counters(data.usage);
      if (!usage) return;
      this.responses.add(id);
      this.add(counters(data.thread_token_usage), usage, time, this.models.get(turn) || this.model);
      return;
    }
    if (row.type !== 'event_msg') return;
    if (data.type === 'token_count') {
      this.plan = planName(data.rate_limits?.plan_type) || this.plan;
      if (data.info) {
        this.add(counters(data.info.total_token_usage), counters(data.info.last_token_usage), time,
          this.models.get(turn || this.turn) || this.model);
      }
    }
    if (data.type === 'user_message' || (data.type === 'item_completed' && data.item?.type === 'UserMessage')) {
      if (time >= this.promptAt) this.promptAt = time;
      if (time >= this.phaseAt) {
        this.turn = turn || this.turn;
        this.phase = 'working';
        this.phaseAt = time;
      }
    }
    if (['task_started', 'turn_started', 'task_complete', 'turn_complete', 'turn_aborted'].includes(data.type)) {
      const start = /started$/.test(data.type);
      if (time >= this.phaseAt && (start || !turn || !this.turn || turn === this.turn)) {
        this.turn = turn || this.turn;
        this.phase = start ? 'working' : 'waiting';
        this.phaseAt = time;
      }
    }
  }

  add(total, last, at, model) {
    if (!total && !last) return;
    let change = last;
    if (total) {
      if (this.total) {
        change = subtract(total, this.total);
        if (Object.values(change).some(number => number < 0)) return;
      } else if (!change) {
        // A snapshot with no predecessor and no last request establishes the baseline only.
        this.total = total;
        return;
      } else if (keys.some(key => change[key] > total[key])) {
        return;
      }
      this.total = total;
    }
    if (!change || !keys.some(key => change[key] > 0)) return;
    this.records.push({ at, model, usage: change });
  }

  scan() {
    let fd;
    try {
      fd = fs.openSync(this.file, 'r');
      const stat = fs.fstatSync(fd);
      if (!stat.isFile()) return false;
      const identity = stat.dev + ':' + stat.ino + ':' + stat.birthtimeMs;
      if (identity !== this.identity || stat.size < this.offset) this.reset();
      this.identity = identity;
      if (this.anchor.length) {
        const check = Buffer.alloc(this.anchor.length);
        fs.readSync(fd, check, 0, check.length, this.offset - check.length);
        if (!check.equals(this.anchor)) this.reset();
      }
      const chunk = Buffer.alloc(128 * 1024);
      let count;
      while (this.offset < stat.size && (count = fs.readSync(fd, chunk, 0,
        Math.min(chunk.length, stat.size - this.offset), this.offset))) {
        this.lines(chunk.subarray(0, count));
        this.offset += count;
      }
      this.anchor = Buffer.alloc(Math.min(192, this.offset));
      fs.readSync(fd, this.anchor, 0, this.anchor.length, this.offset - this.anchor.length);
      return true;
    } catch (error) {
      if (error.code === 'ENOENT') this.reset();
      return false;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }

  lines(chunk) {
    let start = 0;
    while (start < chunk.length) {
      const lf = chunk.indexOf(10, start);
      const end = lf === -1 ? chunk.length : lf;
      const part = chunk.subarray(start, end);
      if (!this.skipping) {
        if (part.length + this.partial.length > 16 * 1024 * 1024) {
          this.partial = Buffer.alloc(0);
          this.skipping = true;
        } else if (lf === -1) {
          this.partial = Buffer.concat([this.partial, part]);
        } else {
          const line = this.partial.length ? Buffer.concat([this.partial, part]) : part;
          this.partial = Buffer.alloc(0);
          try { this.consume(JSON.parse(line.toString('utf8').replace(/^\uFEFF/, ''))); }
          catch { /* Ignore malformed complete lines. */ }
        }
      }
      if (lf === -1) break;
      this.skipping = false;
      start = lf + 1;
    }
  }
}

const rollouts = path.join(codex, 'sessions');
const archive = path.join(codex, 'archived_sessions');

function transcriptPath(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || !/^rollout-.*\.jsonl$/.test(path.basename(file))) {
    return null;
  }
  const absolute = path.resolve(file);
  if (![rollouts, archive].some(dir => {
    const relative = path.relative(dir, absolute);
    return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
  })) return null;
  try {
    if (fs.realpathSync(absolute) !== fs.realpathSync(path.dirname(absolute)) + path.sep + path.basename(absolute)) {
      return null;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') return null;
  }
  return absolute;
}

function findRecent(since) {
  const files = [];
  function visit(dir, depth) {
    if (depth > 4) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(file, depth + 1);
      else if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name)) {
        try { if (fs.statSync(file).mtimeMs >= since) files.push(file); } catch {}
      }
    }
  }
  visit(rollouts, 0);
  visit(archive, 0);
  return files;
}

function usageSince(rolloutList, since, pricing) {
  const usage = { ...zero, tokens: 0, cost: 0, hasData: false, hasPricedData: false, allPriced: true };
  const seen = new Set();
  for (const rollout of rolloutList) {
    if (rollout.id && seen.has(rollout.id)) continue;
    if (rollout.id) seen.add(rollout.id);
    for (const record of rollout.records) {
      if (record.at < since) continue;
      usage.hasData = true;
      const sample = record.usage;
      for (const key of keys) usage[key] += sample[key];
      const rate = Object.hasOwn(pricing.models, record.model) ? pricing.models[record.model] : undefined;
      if (rate && (!sample.write || rate.write30m !== undefined)) {
        usage.hasPricedData = true;
        usage.cost += ((sample.input - sample.cached - sample.write) * rate.input +
          sample.cached * rate.cached + sample.output * rate.output +
          sample.write * (rate.write30m || 0)) / 1e6;
      } else usage.allPriced = false;
    }
  }
  usage.tokens = usage.input - usage.cached + usage.output;
  return usage;
}

module.exports = { Rollout, counters, usageSince, transcriptPath, findRecent, planName };
