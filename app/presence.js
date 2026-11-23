'use strict';

const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { label } = require('./common');

function projectName(cwd) {
  if (!cwd) return null;
  try {
    const args = ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir', '--show-toplevel'];
    const [common, top] = execFileSync('git', args, {
      encoding: 'utf8', timeout: 800, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore']
    }).trimEnd().split(/\r?\n/);
    const gitDir = path.basename(common) === '.git' ? path.dirname(common) : top;
    return label(path.basename(gitDir));
  } catch {
    return label(path.basename(cwd));
  }
}

const phases = {
  edit: 'Editing files', read: 'Reading files', run: 'Running a command', web: 'Browsing',
  tool: 'Using a tool', waiting: 'Waiting for input', approval: 'Waiting for approval', working: 'Working'
};

function compact(value) {
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

function formatUsage(usage) {
  if (!usage.hasData) return 'Tokens: no data';
  const tokens = compact(usage.tokens) + ' tokens';
  if (!usage.hasPricedData) return tokens;
  const estimate = usage.cost > 0 && usage.cost < 0.01 ? '<$0.01' : '~$' + usage.cost.toFixed(2);
  return tokens + ' · ' + estimate + (usage.allPriced ? '' : ' (partial)');
}

function activity(session, settings, usage, clock, icon) {
  const name = settings.hide ? null :
    Object.hasOwn(settings.aliases, session.project) ? label(settings.aliases[session.project]) : session.project;
  const text = [session.model, session.effort, settings.showPlan && session.plan].filter(Boolean).join(' · ');
  const asset = icon ? { large_image: icon, ...(text ? { large_text: text.slice(0, 128) } : {}) } : undefined;
  const details = name ? 'Project: ' + name : 'Working in Codex';
  return {
    type: 3, details,
    state: phases[session.phase] + ' · ' + (clock ? 'Today: ' : '') + formatUsage(usage),
    timestamps: { start: Math.floor(session.start / 1000) },
    ...(asset ? { assets: asset } : {})
  };
}

module.exports = { projectName, activity, formatUsage };
