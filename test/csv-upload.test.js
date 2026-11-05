'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { startTestDrive } = require('../test-helpers/start-drive');
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
    status: 'success', filename: 'abc_中文.CSV', path: 'results/实验 1/abc_中文.CSV', size: content.length, replaced: false
  });
  assert.deepEqual(await fs.readFile(path.join(f.storageRoot, result.body.path)), content);
  assert.deepEqual(await fs.readdir(f.tempRoot), []);
});

test('parallel CSV uploads replace one path with a complete file; old numbered copies are untouched', async (context) => {
  const f = await fixture(context);
  await fs.mkdir(path.join(f.storageRoot, 'results'));
  await fs.writeFile(path.join(f.storageRoot, 'results', 'abc_ab.csv'), 'original');
  await fs.writeFile(path.join(f.storageRoot, 'results', 'abc_ab_1.csv'), 'old numbered copy');
  const bodies = Array.from({ length: 6 }, (_, i) => `id\n${String(i).repeat(128)}`);
  const results = await Promise.all(bodies.map((content) => sendCsv(f.url, { content })));
  assert.ok(results.every(({ status, body }) => status === 200 && body.replaced && body.filename === 'abc_ab.csv'));
  assert.ok(bodies.includes(await fs.readFile(path.join(f.storageRoot, 'results/abc_ab.csv'), 'utf8')));
  assert.deepEqual((await fs.readdir(path.join(f.storageRoot, 'results'))).sort(), ['abc_ab.csv', 'abc_ab_1.csv']);
  assert.equal(await fs.readFile(path.join(f.storageRoot, 'results/abc_ab_1.csv'), 'utf8'), 'old numbered copy');
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

test('failed CSV uploads preserve the previous contents and clean temporary files', async (context) => {
  const f = await fixture(context, { maxUploadBytes: 8 });
  await fs.mkdir(path.join(f.storageRoot, 'results'));
  const destination = path.join(f.storageRoot, 'results/abc_ab.csv');
  await fs.writeFile(destination, 'original');
  const result = await sendCsv(f.url, { content: '123456789' });
  assert.equal(result.status, 413);
  assert.equal((await sendCsv(f.url, { content: 'new', token: 'invalid' })).status, 401);
  assert.equal((await sendCsv(f.url, { missing: true })).status, 400);
  assert.equal(await fs.readFile(destination, 'utf8'), 'original');
  assert.deepEqual(await fs.readdir(f.tempRoot), []);
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
  assert.equal(saved.status, 409);
  assert.ok((await fs.lstat(path.join(f.storageRoot, 'results/abc_ab.csv'))).isSymbolicLink());
  assert.deepEqual(await fs.readdir(outside), []);
  assert.deepEqual(await fs.readdir(f.tempRoot), []);
});

test('CSV upload never replaces a directory, even if its name ends in .csv', async (context) => {
  const f = await fixture(context);
  const dir = path.join(f.storageRoot, 'results/abc_ab.csv');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'keep'), 'original');
  assert.equal((await sendCsv(f.url)).status, 409);
  assert.equal(await fs.readFile(path.join(dir, 'keep'), 'utf8'), 'original');
  assert.deepEqual(await fs.readdir(f.tempRoot), []);
});

test('CSV replacement works across mounts without exposing a partial destination', async (context) => {
  const ram = await fs.stat('/dev/shm').catch(() => null);
  if (!ram || ram.dev === (await fs.stat(os.tmpdir())).dev) return context.skip('two filesystems required');
  const crossTemp = await fs.mkdtemp(path.join('/dev/shm', 'mydrive-csv-test-')).catch(() => null);
  if (!crossTemp) return context.skip('writable second filesystem required');
  context.after(() => fs.rm(crossTemp, { recursive: true, force: true }));
  const f = await fixture(context, { tempRoot: crossTemp });
  assert.equal((await sendCsv(f.url, { content: 'one' })).status, 201);
  assert.equal((await sendCsv(f.url, { content: 'two' })).status, 200);
  context.mock.method(fs, 'copyFile', async () => { throw new Error('simulated copy failure'); });
  context.mock.method(console, 'error', () => {});
  assert.equal((await sendCsv(f.url, { content: 'three' })).status, 500);
  assert.equal(await fs.readFile(path.join(f.storageRoot, 'results/abc_ab.csv'), 'utf8'), 'two');
  assert.deepEqual(await fs.readdir(path.join(f.storageRoot, 'results')), ['abc_ab.csv']);
  assert.deepEqual(await fs.readdir(crossTemp), []);
});

test('CSV upload accepts empty CSV files and keeps a max-length name on replacement', async (context) => {
  const f = await fixture(context);
  const filename = `${'x'.repeat(251)}.csv`;
  for (let i = 0; i < 2; i += 1) {
    const result = await sendCsv(f.url, { query: { filename }, content: '' });
    assert.equal(result.status, i === 0 ? 201 : 200);
    assert.equal(result.body.size, 0);
    assert.equal(Buffer.byteLength(result.body.filename), 255);
    assert.equal(result.body.filename, filename);
  }
});

test('mounted CSV endpoint leaves webpage and Kaggle authentication and uploads intact', { timeout: 20_000 }, async (context) => {
  const { root, url } = await startTestDrive(context, { KAGGLE_UPLOAD_TOKEN: KAGGLE_TOKEN, CSV_UPLOAD_TOKEN: TOKEN });
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
  const kaggleDuplicate = await fetch(`${url}/api/upload`, {
    method: 'POST', headers: { Authorization: `Bearer ${KAGGLE_TOKEN}` }, body: kaggle
  });
  assert.equal((await kaggleDuplicate.json()).filename, 'model_1.pth');

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
  const webDuplicate = await fetch(`${url}/api/upload?path=results`, {
    method: 'POST', headers: { Cookie: cookie, 'X-Requested-With': 'MyDrive' }, body: webFile
  });
  assert.equal((await webDuplicate.json()).files[0].path, 'results/网页文件_1.txt');
  const cookieOnly = await fetch(`${url}/api/upload/csv?path=results&filename=web.csv`, {
    method: 'POST', headers: { Cookie: cookie, 'X-Requested-With': 'MyDrive' }
  });
  assert.equal(cookieOnly.status, 401);
  await cookieOnly.json();
});
