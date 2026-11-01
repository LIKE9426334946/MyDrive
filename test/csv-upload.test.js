'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const express = require('express');
const { createCsvUploadRouter } = require('../backend/csv-upload');

const TOKEN = 'csv-test-token-not-a-production-secret';
const KAGGLE_TOKEN = 'kaggle-test-token-not-a-production-secret';

async function fixture(context, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mydrive-csv-test-'));
  const storageRoot = path.join(root, 'uploads');
  const tempRoot = path.join(root, 'tmp');
  await fs.mkdir(storageRoot);
  await fs.mkdir(tempRoot);
  const app = express();
  app.use('/api/upload/csv', createCsvUploadRouter({
    token: TOKEN, storageRoot, tempRoot, maxUploadBytes: 1024, ...options
  }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  context.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, storageRoot, tempRoot, url: `http://127.0.0.1:${server.address().port}` };
}

async function sendCsv(url, options = {}) {
  const params = new URLSearchParams({ path: 'results', filename: 'abc_ab.csv', ...options.query });
  const body = new FormData();
  if (!options.missing) {
    body.append('file', new Blob([options.content ?? 'epoch,loss\r\n1,0.25\r\n']), options.originalName ?? 'upload.csv');
  }
  if (options.extraFile) body.append('file', new Blob(['extra']), 'extra.csv');
  if (options.extraField) body.append('path', 'results');
  const headers = {};
  if (options.token !== null) headers.Authorization = `Bearer ${options.token ?? TOKEN}`;
  const response = await fetch(`${url}/api/upload/csv?${params}`, { method: 'POST', headers, body });
  return { status: response.status, body: await response.json() };
}

test('CSV upload requires its own token before accepting file data', async (context) => {
  const f = await fixture(context);
  for (const token of [null, 'wrong-token', KAGGLE_TOKEN]) {
    const result = await sendCsv(f.url, { token });
    assert.equal(result.status, 401);
    assert.deepEqual(result.body, { status: 'error', message: 'invalid token' });
  }
  assert.deepEqual(await fs.readdir(f.storageRoot), []);
  assert.deepEqual(await fs.readdir(f.tempRoot), []);
});

test('CSV upload is disabled when CSV_UPLOAD_TOKEN is not configured', async (context) => {
  const f = await fixture(context, { token: '' });
  const result = await sendCsv(f.url);
  assert.equal(result.status, 503);
  assert.equal(result.body.status, 'error');
  assert.deepEqual(await fs.readdir(f.tempRoot), []);
});

test('CSV upload creates nested folders and preserves Chinese names and exact bytes', async (context) => {
  const f = await fixture(context);
  const content = Buffer.from('\ufeff轮次,损失\r\n1,"0.25"\r\n');
  const result = await sendCsv(f.url, {
    query: { path: '/results/实验 1/', filename: 'abc_中文.CSV' }, content
  });
  assert.equal(result.status, 201);
  assert.deepEqual(result.body, {
    status: 'success', filename: 'abc_中文.CSV', path: 'results/实验 1/abc_中文.CSV', size: content.length
  });
  assert.deepEqual(await fs.readFile(path.join(f.storageRoot, result.body.path)), content);
  assert.deepEqual(await fs.readdir(f.tempRoot), []);
});

test('parallel CSV uploads never overwrite an existing file', async (context) => {
  const f = await fixture(context);
  await fs.mkdir(path.join(f.storageRoot, 'results'));
  await fs.writeFile(path.join(f.storageRoot, 'results', 'abc_ab.csv'), 'original');
  const results = await Promise.all(Array.from({ length: 6 }, (_, i) => sendCsv(f.url, { content: `id\n${i}` })));
  assert.equal(results.every((result) => result.status === 201), true);
  assert.deepEqual(results.map((result) => result.body.filename).sort(),
    Array.from({ length: 6 }, (_, i) => `abc_ab_${i + 1}.csv`));
  assert.equal(await fs.readFile(path.join(f.storageRoot, 'results', 'abc_ab.csv'), 'utf8'), 'original');
  for (const [i, result] of results.entries()) {
    assert.equal(await fs.readFile(path.join(f.storageRoot, result.body.path), 'utf8'), `id\n${i}`);
  }
  assert.deepEqual(await fs.readdir(f.tempRoot), []);
});

test('CSV destination rejects traversal, malformed names and excessive UTF-8 lengths', async (context) => {
  const f = await fixture(context);
  const queries = [
    { path: '' }, { path: '../outside' }, { path: 'results/../outside' },
    { path: 'results\\outside' }, { path: 'results//outside' }, { path: 'results/ ' },
    { path: '中'.repeat(86) }, { filename: '../ab.csv' }, { filename: 'a\\b.csv' },
    { filename: '' }, { filename: 'ab.csv.exe' }, { filename: 'bad\u0000.csv' },
    { filename: `${'中'.repeat(84)}.csv` }
  ];
  for (const query of queries) {
    const result = await sendCsv(f.url, { query });
    assert.equal(result.status, 400, JSON.stringify(query));
    assert.equal(result.body.status, 'error');
  }
  assert.deepEqual(await fs.readdir(f.storageRoot), []);
  assert.deepEqual(await fs.readdir(f.tempRoot), []);
});

test('CSV multipart validation rejects other extensions, missing files and extra fields', async (context) => {
  const f = await fixture(context);
  for (const options of [{ originalName: 'data.txt' }, { missing: true }, { extraFile: true }, { extraField: true }]) {
    const result = await sendCsv(f.url, options);
    assert.equal(result.status, 400, JSON.stringify(options));
    assert.equal(result.body.status, 'error');
    assert.deepEqual(await fs.readdir(f.tempRoot), []);
  }
  assert.deepEqual(await fs.readdir(f.storageRoot), []);
});

test('CSV upload enforces the file size limit and cleans temporary files', async (context) => {
  const f = await fixture(context, { maxUploadBytes: 8 });
  const result = await sendCsv(f.url, { content: '123456789' });
  assert.equal(result.status, 413);
  assert.deepEqual(await fs.readdir(f.tempRoot), []);
  assert.deepEqual(await fs.readdir(f.storageRoot), []);
});

test('CSV upload rejects symlink directories and does not follow a dangling filename', {
  skip: process.platform === 'win32' ? 'symlink creation may require Windows elevation' : false
}, async (context) => {
  const f = await fixture(context);
  const outside = path.join(f.root, 'outside');
  await fs.mkdir(outside);
  await fs.symlink(outside, path.join(f.storageRoot, 'linked'));
  const rejected = await sendCsv(f.url, { query: { path: 'linked/nested' } });
  assert.equal(rejected.status, 400);
  assert.deepEqual(await fs.readdir(outside), []);
  await fs.mkdir(path.join(f.storageRoot, 'results'));
  await fs.symlink(path.join(outside, 'untouched.csv'), path.join(f.storageRoot, 'results', 'abc_ab.csv'));
  const saved = await sendCsv(f.url);
  assert.equal(saved.status, 201);
  assert.equal(saved.body.filename, 'abc_ab_1.csv');
  assert.deepEqual(await fs.readdir(outside), []);
  assert.deepEqual(await fs.readdir(f.tempRoot), []);
});

test('CSV upload accepts empty CSV files and handles a max-length duplicate name', async (context) => {
  const f = await fixture(context);
  const filename = `${'x'.repeat(251)}.csv`;
  for (let i = 0; i < 2; i += 1) {
    const result = await sendCsv(f.url, { query: { filename }, content: '' });
    assert.equal(result.status, 201);
    assert.equal(result.body.size, 0);
    assert.equal(Buffer.byteLength(result.body.filename), 255);
    assert.equal(result.body.filename, i === 0 ? filename : `${'x'.repeat(249)}_1.csv`);
  }
});

test('mounted CSV endpoint leaves webpage and Kaggle authentication and uploads intact', { timeout: 20_000 }, async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mydrive-csv-server-'));
  const reservation = net.createServer().listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const child = spawn(process.execPath, ['backend/server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env, HOST: '127.0.0.1', PORT: String(port), APP_USERNAME: 'noart',
      APP_PASSWORD: 'local-test-only', SESSION_SECRET: 'test-session-secret-at-least-32-characters',
      KAGGLE_UPLOAD_TOKEN: KAGGLE_TOKEN, CSV_UPLOAD_TOKEN: TOKEN,
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
  const url = `http://127.0.0.1:${port}`;
  assert.equal((await sendCsv(url)).status, 201);
  assert.equal((await sendCsv(url, { token: KAGGLE_TOKEN })).status, 401);
  assert.equal((await fetch(`${url}/api/files`, { headers: { Authorization: `Bearer ${TOKEN}` } })).status, 401);

  const kaggle = new FormData();
  kaggle.append('path', 'kaggle');
  kaggle.append('file', new Blob(['weights']), 'model.pth');
  const kaggleReply = await fetch(`${url}/api/upload`, {
    method: 'POST', headers: { Authorization: `Bearer ${KAGGLE_TOKEN}` }, body: kaggle
  });
  assert.equal(kaggleReply.status, 201);
  assert.equal((await kaggleReply.json()).filename, 'model.pth');
  assert.equal(await fs.readFile(path.join(root, 'uploads/kaggle/model.pth'), 'utf8'), 'weights');

  kaggle.set('path', 'results');
  const wrongPath = await fetch(`${url}/api/upload`, {
    method: 'POST', headers: { Authorization: `Bearer ${KAGGLE_TOKEN}` }, body: kaggle
  });
  assert.equal(wrongPath.status, 400);
  await wrongPath.json();

  const login = await fetch(`${url}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'MyDrive' },
    body: JSON.stringify({ username: 'noart', password: 'local-test-only' })
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  await login.json();
  const webFile = new FormData();
  webFile.append('files', new Blob(['web notes']), '网页文件.txt');
  const webReply = await fetch(`${url}/api/upload?path=results`, {
    method: 'POST', headers: { Cookie: cookie, 'X-Requested-With': 'MyDrive' }, body: webFile
  });
  assert.equal(webReply.status, 201);
  assert.equal((await webReply.json()).files[0].path, 'results/网页文件.txt');
  assert.equal(await fs.readFile(path.join(root, 'uploads/results/网页文件.txt'), 'utf8'), 'web notes');
  const cookieOnly = await fetch(`${url}/api/upload/csv?path=results&filename=web.csv`, {
    method: 'POST', headers: { Cookie: cookie, 'X-Requested-With': 'MyDrive' }
  });
  assert.equal(cookieOnly.status, 401);
  await cookieOnly.json();
});
