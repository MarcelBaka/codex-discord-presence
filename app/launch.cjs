'use strict';

const fs = require('node:fs');
const path = require('node:path');

if (process.argv[3]?.startsWith('context=')) {
  try {
    const context = JSON.parse(Buffer.from(process.argv.splice(3, 1)[0].slice(8), 'base64url').toString());
    for (const variable of ['CODEX_HOME', 'CODEX_PRESENCE_HOME', 'CODEX_PRESENCE_DISCORD_IPC']) {
      if (typeof context[variable] === 'string') process.env[variable] = context[variable];
    }
  } catch {}
}

try {
  const { directory } = JSON.parse(fs.readFileSync(path.join(__dirname, 'current.json'), 'utf8'));
  if (!/^[\w.-]+$/.test(directory) || directory === '..' || directory === '.') throw Error('Invalid version pointer');
  require(path.join(__dirname, 'versions', directory, 'cli.js')).main().catch(error => {
    if (process.argv[2] !== 'hook' && process.argv[2] !== '_serve') console.error(error.message);
    process.exitCode = 1;
  });
} catch (error) {
  if (process.argv[2] !== 'hook' && process.argv[2] !== '_serve') console.error(error.message);
  process.exitCode = 1;
}
