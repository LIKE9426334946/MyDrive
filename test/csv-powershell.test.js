'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const express = require('express');
const { createCsvUploadRouter } = require('../backend/csv-upload');

const powershell = process.env.MYDRIVE_POWERSHELL || (process.platform === 'win32' ? 'powershell.exe' : 'pwsh');
const probe = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'], { timeout: 10_000 });
if (process.env.MYDRIVE_POWERSHELL && probe.status !== 0) {
  throw new Error(`MYDRIVE_POWERSHELL is configured but cannot run: ${probe.error?.message || probe.stderr}`);
}
const runtimeOptions = {
  skip: probe.status !== 0 ? 'PowerShell is not installed; set MYDRIVE_POWERSHELL to run script integration tests' : false,
  timeout: 30_000
};
const TOKEN = 'powershell-integration-token-not-a-production-secret';

async function fixture(context, { maxUploadBytes = 1024, redirect = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mydrive-ps-csv-'));
  const local = path.join(root, 'runs');
  const storage = path.join(root, 'uploads');
  const temp = path.join(root, 'tmp');
  await Promise.all([local, storage, temp].map((directory) => fs.mkdir(directory)));
  const app = express();
  let redirectedRequests = 0;
  if (redirect) {
    app.post('/api/upload/csv', (request, response) => response.redirect(307, '/unexpected'));
    app.post('/unexpected', (request, response) => { redirectedRequests += 1; response.json({ status: 'success' }); });
  } else {
    app.use('/api/upload/csv', createCsvUploadRouter({ token: TOKEN, storageRoot: storage, tempRoot: temp, maxUploadBytes }));
  }
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  context.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, local, storage, url: `http://127.0.0.1:${server.address().port}`, redirectedRequests: () => redirectedRequests };
}

function runScript(f, { token = TOKEN, preview = false, target = 'results' } = {}) {
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
    path.join(__dirname, '..', 'upload-csv.ps1'), '-LocalDirectory', f.local,
    '-ServerDirectory', target, '-ServerUrl', f.url, '-TimeoutSeconds', '10'];
  if (preview) args.push('-Preview');
  return new Promise((resolve) => {
    execFile(powershell, args, {
      env: { ...process.env, MYDRIVE_CSV_TOKEN: token }, timeout: 20_000, encoding: 'utf8'
    }, (error, stdout, stderr) => resolve({ code: error?.code || 0, stdout, stderr }));
  });
}

test('PowerShell recursively previews/uploads CSVs, flattens paths and preserves originals', runtimeOptions, async (context) => {
  const f = await fixture(context);
  const files = {
    'abc/ab.csv': 'a,b\r\n1,2\r\n',
    'abc/deep/metrics.CSV': 'epoch,loss\n1,0.4',
    'metrics.csv': 'new-root-data',
    '实验 空间/成绩.csv': '\ufeff学号,分数\r\n一,95',
    'abc_ab.csv': 'flattened-collision',
    '.hidden/trace.csv': 'hidden,data',
    'notes.txt': 'this is not CSV'
  };
  for (const [relative, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(f.local, relative)), { recursive: true });
    await fs.writeFile(path.join(f.local, relative), content);
  }
  if (process.platform !== 'win32') {
    await fs.writeFile(path.join(f.root, 'outside.csv'), 'must-not-upload');
    await fs.symlink(path.join(f.root, 'outside.csv'), path.join(f.local, 'linked.csv'));
    await fs.symlink(f.root, path.join(f.local, 'junction'));
  }
  const target = 'results/批次';
  const preview = await runScript(f, { preview: true, token: '', target });
  assert.equal(preview.code, 0, preview.stdout + preview.stderr);
  assert.match(preview.stdout, /Found 6 CSV file/);
  assert.match(preview.stdout, /abc_ab\.csv/);
  assert.match(preview.stdout, /Preview only/);
  assert.deepEqual(await fs.readdir(f.storage), []);

  await fs.mkdir(path.join(f.storage, target), { recursive: true });
  await fs.writeFile(path.join(f.storage, target, 'metrics.csv'), 'keep-original');
  const uploaded = await runScript(f, { target });
  assert.equal(uploaded.code, 0, uploaded.stdout + uploaded.stderr);
  assert.match(uploaded.stdout, /Success: 6; Failed: 0; Not attempted: 0/);
  const savedNames = await fs.readdir(path.join(f.storage, target));
  assert.deepEqual(savedNames.sort(), [
    '.hidden_trace.csv', 'abc_ab.csv', 'abc_ab_1.csv', 'abc_deep_metrics.CSV',
    'metrics.csv', 'metrics_1.csv', '实验 空间_成绩.csv'
  ].sort());
  const savedContents = await Promise.all(savedNames.map((name) => fs.readFile(path.join(f.storage, target, name), 'utf8')));
  assert.deepEqual(savedContents.sort(), [...Object.entries(files).filter(([name]) => /\.csv$/i.test(name)).map(([, value]) => value), 'keep-original'].sort());
  assert.equal(await fs.readFile(path.join(f.storage, target, 'metrics.csv'), 'utf8'), 'keep-original');
  for (const [relative, content] of Object.entries(files)) {
    assert.equal(await fs.readFile(path.join(f.local, relative), 'utf8'), content);
  }
});

test('PowerShell stops on invalid token without uploading remaining files', runtimeOptions, async (context) => {
  const f = await fixture(context);
  await fs.writeFile(path.join(f.local, 'a.csv'), 'first');
  await fs.writeFile(path.join(f.local, 'b.csv'), 'second');
  const result = await runScript(f, { token: 'incorrect' });
  assert.equal(result.code, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /HTTP 401/);
  assert.match(result.stdout, /Success: 0; Failed: 1; Not attempted: 1/);
  assert.deepEqual(await fs.readdir(f.storage), []);
});

test('PowerShell continues after a file failure and reports a failing exit code', runtimeOptions, async (context) => {
  const f = await fixture(context, { maxUploadBytes: 8 });
  await fs.writeFile(path.join(f.local, 'a.csv'), 'this-file-is-too-large');
  await fs.writeFile(path.join(f.local, 'b.csv'), 'small');
  const result = await runScript(f);
  assert.equal(result.code, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /Success: 1; Failed: 1; Not attempted: 0/);
  assert.equal(await fs.readFile(path.join(f.storage, 'results/b.csv'), 'utf8'), 'small');
  assert.deepEqual(await fs.readdir(path.join(f.storage, 'results')), ['b.csv']);
});

test('PowerShell never follows an upload redirect', runtimeOptions, async (context) => {
  const f = await fixture(context, { redirect: true });
  await fs.writeFile(path.join(f.local, 'a.csv'), 'csv');
  const result = await runScript(f);
  assert.equal(result.code, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /HTTP 307/);
  assert.equal(f.redirectedRequests(), 0);
});
