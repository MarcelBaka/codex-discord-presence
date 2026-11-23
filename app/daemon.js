'use strict';

const { config, paused, write, statusFile, defaultAppId, log } = require('./common');
const { singleton, Discord } = require('./ipc');
const { processes } = require('./processes');
const { Registry, selected } = require('./registry');
const { Rollout, usageSince, findRecent } = require('./rollout');
const { activity } = require('./presence');
const { iconFor, iconRefreshInterval, localPricing, refreshPricing } = require('./network');

async function serve() {
  let stopping = false;
  let tickPending = false;
  let timer;
  const server = await singleton(cmd => {
    if (cmd === 'stop') stopping = true;
    if (!tickPending) schedule(0);
  });
  if (!server) return;
  log('daemon started');
  const registry = new Registry();
  const discord = new Discord(log);
  const rollouts = new Map();
  let rows;
  let nextProcesses = 0;
  let nextSearch = 0;
  let lastSession = Date.now();
  let settings = config();
  let pricing = localPricing();
  let nextPricing = 0;
  let nextUpdates = 0;
  let iconId;
  let icon;
  let nextIcon = 0;
  let statusValue;
  let currentTick;
  let settling = 0;
  const startup = Date.now();
  let recent = [];
  const beginStop = () => { stopping = true; schedule(0); };
  process.on('SIGTERM', beginStop);
  process.on('SIGINT', beginStop);

  function schedule(delay) {
    if (tickPending) return;
    clearTimeout(timer);
    timer = setTimeout(run, delay);
  }

  function getRollout(file) {
    if (!file) return undefined;
    let value = rollouts.get(file);
    if (!value) {
      value = new Rollout(file);
      rollouts.set(file, value);
    }
    if (value.lastTick !== currentTick) {
      value.scan();
      value.lastTick = currentTick;
    }
    return value;
  }

  async function run() {
    tickPending = true;
    let again = true;
    try {
      const now = Date.now();
      settings = config(settings);
      if (now >= nextProcesses) {
        nextProcesses = now + 3000;
        try { rows = await processes(); }
        catch { log('process polling unavailable'); }
      }
      registry.consume();
      currentTick = Symbol();
      const active = registry.active(rows);
      const needsFiles = active.length > 0 || settings.autostart;
      const midnight = new Date(now);
      midnight.setHours(0, 0, 0, 0);
      if (needsFiles && now >= nextSearch) {
        recent = findRecent(midnight.getTime());
        nextSearch = now + 20_000;
        const keep = new Set([...recent, ...active.map(session => session.transcript)]);
        for (const file of rollouts.keys()) {
          if (!keep.has(file) && !active.some(session => file.endsWith(session.id + '.jsonl'))) rollouts.delete(file);
        }
      }
      const session = selected(active, item => {
        const file = item.transcript || recent.find(candidate => candidate.endsWith(item.id + '.jsonl'));
        return getRollout(file);
      });
      if (session) lastSession = now;
      if (settings.enabled && now >= nextPricing) {
        nextPricing = now + 86_400_000;
        refreshPricing().then(() => { pricing = localPricing(); }).catch(() => log('pricing cache unavailable'));
      }
      if (settings.autoUpdate && active.length === 0 && now >= Math.max(nextUpdates, startup + 10_000)) {
        nextUpdates = now + 86_400_000;
        require('./update').autoUpdate().catch(() => log('automatic release update unavailable'));
      }

      const id = settings.appId || defaultAppId;
      if (session && (id !== iconId || now >= nextIcon)) {
        if (id !== iconId) icon = undefined;
        iconId = id;
        nextIcon = now + iconRefreshInterval(icon);
        iconFor(id).then(result => {
          if (iconId === id) {
            icon = result;
            nextIcon = Date.now() + iconRefreshInterval(icon);
          }
        }).catch(() => {});
      }
      const usage = usageSince(session?.rollout ? [session.rollout] : [], session?.start, pricing);
      const history = usageSince(session?.rollout ? [session.rollout] : [], 0, pricing);
      const useToday = settings.showToday && Math.floor(now / 15_000) % 2 === 1;
      const dailyRollouts = session
        ? [session.rollout, ...recent.map(getRollout)].filter(Boolean) : [];
      const daily = usageSince([...new Set(dailyRollouts)], midnight.getTime(), pricing);
      const payload = paused(settings, now) || stopping || !session ? null :
        activity(session, settings, useToday ? daily : usage, useToday, icon);
      let acknowledged = false;
      const exiting = stopping || (!settings.autostart && now - lastSession > (startup === lastSession ? 12_000 : 3500));
      if (session || discord.socket || paused(settings) || !exiting) {
        acknowledged = await discord.send(id, payload);
      }
      const snapshot = {
        daemon: 'running', discord: discord.ready ? 'ready' : 'waiting for desktop IPC', acknowledged,
        applicationId: id, activeSessions: active.length, payload,
        model: session?.model || null, reasoningEffort: session?.effort || null,
        plan: settings.showPlan ? session?.plan || null : null,
        usageSource: session?.rollout?.records.length
          ? 'local rollout JSONL, request records and cumulative token_count deltas' : null,
        sessionUsage: usage, conversationUsage: history, todayUsage: daily, pricingAsOf: pricing.asOf
      };
      const serialized = JSON.stringify(snapshot);
      if (serialized !== statusValue) {
        write(statusFile, snapshot);
        statusValue = serialized;
      }
      if (exiting) {
        if (!settling) settling = now;
        if (acknowledged || !discord.socket || now - settling >= 21_000) again = false;
      } else settling = 0;
    } catch { log('daemon tick failed'); }
    finally {
      tickPending = false;
      if (again) schedule(settling ? 200 : 1000);
      else {
        discord.close();
        server.close();
        write(statusFile, { daemon: 'stopped', payload: null });
        log('daemon stopped');
      }
    }
  }

  schedule(0);
}

module.exports = { serve };
