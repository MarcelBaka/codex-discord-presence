'use strict';

const https = require('node:https');
const { URL } = require('node:url');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { root, optional, write, log, upstream } = require('./common');
const run = promisify(execFile);

function get(url, { limit = 1024 * 1024, redirects = 4, githubToken, accept = '*/*' } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    if (target.protocol !== 'https:') return reject(Error('HTTPS is required'));
    const headers = { 'User-Agent': 'codex-discord-presence', Accept: accept };
    if (githubToken && target.hostname === 'api.github.com') headers.Authorization = 'Bearer ' + githubToken;
    const req = https.get(target, { headers }, response => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location && redirects) {
        response.resume();
        resolve(get(new URL(response.headers.location, target), { limit, redirects: redirects - 1, accept }));
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(Error('HTTP ' + response.statusCode));
        return;
      }
      const parts = [];
      let length = 0;
      response.on('data', part => {
        length += part.length;
        if (length > limit) response.destroy(Error('Download exceeded size limit'));
        else parts.push(part);
      });
      response.on('error', reject);
      response.on('end', () => resolve(Buffer.concat(parts)));
    });
    req.on('error', reject);
    req.setTimeout(4500, () => req.destroy(Error('Network timeout')));
  });
}

async function iconFor(id) {
  const name = path.join(root, 'icon-' + id + '.json');
  let saved;
  try {
    saved = optional(name);
    if (saved && Date.now() - saved.checked < iconRefreshInterval(saved.url)) return saved.url;
  } catch {}
  try {
    const app = JSON.parse(await get('https://discord.com/api/v10/applications/' + id + '/rpc'));
    const url = typeof app.icon === 'string' && /^(?:a_)?[a-f0-9]{32}$/i.test(app.icon)
      ? 'https://cdn.discordapp.com/app-icons/' + id + '/' + app.icon + '.png?size=256' : null;
    write(name, { checked: Date.now(), url });
    return url;
  } catch {
    log('public Discord icon lookup unavailable');
    return saved?.url || null;
  }
}

function iconRefreshInterval(url) {
  return url ? 86_400_000 : 60_000;
}

function validatePricing(value) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value.asOf) || !Number.isFinite(Date.parse(value.asOf))
    || !value.models || !Object.keys(value.models).length) throw Error('Invalid pricing file');
  for (const [id, rate] of Object.entries(value.models)) {
    if (!/^[a-z0-9][a-z0-9.-]*$/.test(id) || !rate ||
      ['input', 'cached', 'output'].some(key => !Object.hasOwn(rate, key)) ||
      Object.values(rate).some(number => typeof number !== 'number' || !Number.isFinite(number) ||
        number < 0 || number > 10_000)) throw Error('Invalid model rate');
  }
  return value;
}

function localPricing() {
  const bundled = validatePricing(require('./pricing.json'));
  try {
    const downloaded = validatePricing(optional(path.join(root, 'pricing-cache.json'))?.pricing);
    return downloaded.asOf >= bundled.asOf ? downloaded : bundled;
  } catch { return bundled; }
}

function githubToken() {
  // A repository access token is optional for private releases. It is never forwarded to redirects.
  return process.env.CODEX_PRESENCE_GITHUB_TOKEN;
}

async function refreshPricing() {
  const file = path.join(root, 'pricing-cache.json');
  let previous;
  try { previous = optional(file); } catch {}
  if (previous && Date.now() - previous.checked < 86_400_000) return;
  const url = githubToken()
    ? 'https://api.github.com/repos/' + upstream + '/contents/app/pricing.json'
    : 'https://raw.githubusercontent.com/' + upstream + '/main/app/pricing.json';
  let pricing = previous?.pricing || localPricing();
  try {
    const body = JSON.parse(await get(url, { githubToken: githubToken() }));
    const next = validatePricing(githubToken() ? JSON.parse(Buffer.from(body.content, 'base64')) : body);
    if (next.asOf >= pricing.asOf) pricing = next;
  } catch {
    try {
      const { stdout } = await run('gh', ['api', 'repos/' + upstream + '/contents/app/pricing.json', '--jq', '.content'], {
        windowsHide: true, timeout: 8000, maxBuffer: 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: '1' }
      });
      const next = validatePricing(JSON.parse(Buffer.from(stdout, 'base64')));
      if (next.asOf >= pricing.asOf) pricing = next;
    } catch { log('repository pricing refresh unavailable'); }
  }
  write(file, { checked: Date.now(), pricing });
}

module.exports = { get, iconFor, iconRefreshInterval, validatePricing, localPricing, refreshPricing, githubToken };
