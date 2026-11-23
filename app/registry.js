'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { root, spool, textId, optional, write, log } = require('./common');
const { live } = require('./processes');
const { projectName } = require('./presence');
const { transcriptPath } = require('./rollout');

const file = path.join(root, 'registry.json');
const ownerFile = id => path.join(root, 'owners', id + '.json');

function knownOwner(value) {
  return value && Number.isSafeInteger(value.pid) && value.pid > 0 &&
    Number.isSafeInteger(value.start) && value.start > 0;
}

function same(a, b) {
  return a.pid === b.pid && a.start === b.start;
}

class Registry {
  constructor() {
    try {
      this.sessions = new Map(optional(file, []).filter(session => textId(session.id) && knownOwner(session.owner))
        .map(session => [session.id, session]));
    } catch { this.sessions = new Map(); }
  }

  apply(event) {
    if (!textId(event?.id) || !Number.isSafeInteger(event.at)) return;
    let session = this.sessions.get(event.id);
    const startEvent = event.type === 'SessionStart';
    const prompt = event.type === 'UserPromptSubmit';
    if (startEvent || prompt) {
      const different = knownOwner(event.owner) && (!session || !same(event.owner, session.owner));
      if (different || (startEvent && session?.ended && event.at > session.ended)) {
        const owner = different ? event.owner : session.owner;
        const start = owner.shared ? event.at : owner.start;
        session = {
          id: event.id, owner, start, opened: event.at, resume: Boolean(event.resume),
          lastInput: startEvent && !event.resume ? event.at : 0, phase: 'waiting', phaseAt: event.at
        };
        this.sessions.set(event.id, session);
        write(ownerFile(event.id), owner);
      }
      if (!session || event.at < session.opened || session.ended) return;
      if (typeof event.cwd === 'string' && path.isAbsolute(event.cwd) && session.cwd !== event.cwd) {
        session.cwd = event.cwd;
        session.project = projectName(event.cwd);
      }
      session.transcript = transcriptPath(event.transcript) || session.transcript;
      session.model = textId(event.model) || session.model;
      if (prompt && event.at >= session.lastInput) {
        session.lastInput = event.at;
        session.turn = event.turn;
        session.phase = 'working';
        session.phaseAt = event.at;
        session.stopped = false;
      }
      return;
    }
    if (!session || session.ended || event.at < session.opened) return;
    if (event.type === 'SessionEnd') {
      if (knownOwner(event.owner) && !same(event.owner, session.owner)) return;
      session.ended = event.at;
      fs.rmSync(ownerFile(session.id), { force: true });
      return;
    }
    if (!event.turn || event.turn !== session.turn || event.at < session.phaseAt) return;
    if (event.type === 'Stop' || event.type === 'Interrupt') {
      session.stopped = true;
      session.phase = 'waiting';
    } else if (!session.stopped && event.type === 'PermissionRequest') session.phase = 'approval';
    else if (!session.stopped && event.type === 'PreToolUse') {
      if (!['edit', 'read', 'run', 'web', 'tool'].includes(event.category)) return;
      session.phase = event.category;
    } else if (!session.stopped && event.type === 'PostToolUse') session.phase = 'working';
    else return;
    session.phaseAt = event.at;
  }

  consume() {
    let names;
    try { names = fs.readdirSync(spool).filter(name => /^\d+-[\da-f-]+\.json$/.test(name)).sort(); }
    catch { return; }
    if (!names.length) return;
    const consumed = [];
    for (const name of names) {
      const eventFile = path.join(spool, name);
      try {
        const event = optional(eventFile);
        if (event && Date.now() - event.at < 86_400_000) this.apply(event);
      } catch { log('invalid local hook event'); }
      consumed.push(eventFile);
    }
    this.save();
    for (const event of consumed) fs.rmSync(event, { force: true });
  }

  save() { write(file, [...this.sessions.values()]); }

  active(rows) {
    const active = [];
    let changed = false;
    for (const session of this.sessions.values()) {
      if (!session.ended && (!rows || live(session.owner, rows))) active.push(session);
      else {
        this.sessions.delete(session.id);
        fs.rmSync(ownerFile(session.id), { force: true });
        changed = true;
      }
    }
    if (changed) this.save();
    return active;
  }
}

function selected(sessions, getRollout) {
  return sessions.map(item => {
    const rollout = getRollout(item);
    // A resumed conversation's historical activity never outranks a live user's prompt.
    const prompt = rollout?.promptAt >= item.opened ? rollout.promptAt : 0;
    const useRollout = rollout?.phase && rollout.phaseAt >= item.opened &&
      (rollout.phaseAt > item.phaseAt || (rollout.phase === 'waiting' && rollout.turn === item.turn));
    return {
      ...item, rollout, lastInput: Math.max(item.lastInput, prompt),
      phase: useRollout ? rollout.phase : item.phase,
      model: rollout?.model || item.model, effort: rollout?.effort, plan: rollout?.plan
    };
  }).sort((a, b) => b.lastInput - a.lastInput || b.opened - a.opened)[0];
}

module.exports = { Registry, selected };
