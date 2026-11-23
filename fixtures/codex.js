'use strict';

const { spawn } = require('node:child_process');

process.on('message', ({ command, payload, id }) => {
  const child = spawn(command, {
    shell: true, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], cwd: payload.cwd
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => { stderr += data; });
  child.on('error', error => { process.send({ id, error: error.message }); });
  child.stdin.on('error', () => {});
  child.stdin.end(JSON.stringify(payload));
  child.on('exit', code => {
    child.stdout.destroy();
    child.stderr.destroy();
    process.send({ id, code, stdout, stderr });
  });
});
