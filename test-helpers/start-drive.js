'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

async function startTestDrive(context, tokenEnv = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mydrive-http-test-'));
  const reservation = net.createServer().listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const child = spawn(process.execPath, ['backend/server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env, HOST: '127.0.0.1', PORT: String(port), APP_USERNAME: 'noart',
      APP_PASSWORD: 'local-test-only', SESSION_SECRET: 'test-session-secret-at-least-32-characters',
      KAGGLE_UPLOAD_TOKEN: '', CSV_UPLOAD_TOKEN: '', ...tokenEnv,
      STORAGE_ROOT: path.join(root, 'uploads'), TEMP_ROOT: path.join(root, 'tmp'),
      MAX_UPLOAD_BYTES: '1024', REQUEST_TIMEOUT_MS: '300000', COOKIE_SECURE: 'false'
    }, stdio: ['ignore', 'pipe', 'pipe']
  });
  const exited = once(child, 'exit');
  context.after(async () => {
    child.kill('SIGTERM');
    await exited;
    await fs.rm(root, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    let log = '';
    const timer = setTimeout(() => reject(new Error(`Server startup timed out: ${log}`)), 5000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Server exited (${code}): ${log}`)); });
    child.stderr.on('data', (data) => { log += data; });
    child.stdout.on('data', (data) => {
      log += data;
      if (log.includes('MyDrive listening')) { clearTimeout(timer); resolve(); }
    });
  });
  return { root, url: `http://127.0.0.1:${port}` };
}

module.exports = { startTestDrive };
