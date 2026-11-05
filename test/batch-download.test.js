'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { startTestDrive } = require('../test-helpers/start-drive');

test('batch downloads return individual originals, including files inside selected folders', async (context) => {
  const { root, url } = await startTestDrive(context);
  const storage = path.join(root, 'uploads');
  const originals = new Map([
    ['原始 #1&.csv', Buffer.from('\ufeff轮次,损失\r\n1,0.5\r\n')],
    ['实验/同名.bin', Buffer.from([0, 255, 17, 4])],
    ['实验/子目录/同名.bin', Buffer.from([2, 0, 128, 19, 42])],
    ['实验/空文件', Buffer.alloc(0)]
  ]);
  for (const [name, bytes] of originals) {
    await fs.mkdir(path.dirname(path.join(storage, name)), { recursive: true });
    await fs.writeFile(path.join(storage, name), bytes);
  }
  await fs.mkdir(path.join(storage, '空目录'));
  const list = (paths, headers) => fetch(`${url}/api/items/downloads`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ paths })
  });
  const get = (name, headers) => fetch(`${url}/api/download?path=${encodeURIComponent(name)}`, { headers });
  assert.equal((await list(['实验'], { 'X-Requested-With': 'MyDrive' })).status, 401);
  assert.equal((await get('实验/同名.bin')).status, 401);

  const login = await fetch(`${url}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'MyDrive' },
    body: JSON.stringify({ username: 'noart', password: 'local-test-only' })
  });
  assert.equal(login.status, 200);
  const Cookie = login.headers.get('set-cookie').split(';')[0];
  const headers = { Cookie, 'X-Requested-With': 'MyDrive' };
  assert.equal((await list(['实验'], { Cookie })).status, 403);

  const selection = ['原始 #1&.csv', '实验', '实验', '实验/子目录/同名.bin', '空目录'];
  const prepared = await list(selection, headers);
  assert.equal(prepared.status, 200);
  const { files } = await prepared.json();
  assert.deepEqual(files.map((f) => f.path).sort(), [...originals.keys()].sort());
  for (const file of files) {
    assert.equal(file.name, path.posix.basename(file.path));
    const response = await get(file.path, { Cookie });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-disposition'), /^attachment;/);
    assert.ok(response.headers.get('content-disposition').includes(encodeURIComponent(file.name)), file.name);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), originals.get(file.path));
  }
  assert.deepEqual(await (await list(['空目录'], headers)).json(), { files: [] });
  for (const paths of [[], [''], ['../outside'], ['missing.csv']]) {
    assert.ok([400, 404].includes((await list(paths, headers)).status));
  }

  if (process.platform !== 'win32') {
    await fs.mkdir(path.join(root, 'outside'));
    await fs.writeFile(path.join(root, 'outside/private'), 'outside');
    await fs.symlink(path.join(root, 'outside'), path.join(storage, '实验/linked'));
    assert.deepEqual((await (await list(selection, headers)).json()).files, files);
    assert.equal((await list(['实验/linked/private'], headers)).status, 400);
    assert.equal((await get('实验/linked/private', { Cookie })).status, 400);
  }
  const archive = await fetch(`${url}/api/items/archive`, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ paths: selection })
  });
  assert.equal(archive.status, 404);
});
