'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  chooseUniqueDestination,
  listDirectory,
  normalizeVirtualPath,
  resolveVirtualPath,
  sanitizeUploadName,
  searchItems,
  validateItemName
} = require('../backend/storage');

test('virtual paths stay inside the storage root', () => {
  const root = path.join(os.tmpdir(), 'mydrive-root');
  assert.equal(resolveVirtualPath(root, '课程/数学'), path.join(root, '课程', '数学'));
  assert.throws(() => normalizeVirtualPath('../etc'), { code: 'INVALID_PATH' });
  assert.throws(() => normalizeVirtualPath('课程/../etc'), { code: 'INVALID_PATH' });
  assert.throws(() => normalizeVirtualPath('课程\\资料'), { code: 'INVALID_PATH' });
});

test('item names reject path separators and control characters', () => {
  assert.equal(validateItemName(' 学习资料 '), '学习资料');
  assert.throws(() => validateItemName('../secret'), { code: 'INVALID_NAME' });
  assert.throws(() => validateItemName('bad\nname'), { code: 'INVALID_NAME' });
  assert.equal(sanitizeUploadName('../../photo.jpg'), 'photo.jpg');
});

test('directories are listed folder-first and searched recursively', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mydrive-test-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, '课程'));
  await fs.writeFile(path.join(root, '课程', '概率论.txt'), 'notes');
  await fs.writeFile(path.join(root, 'readme.md'), 'hello');

  const items = await listDirectory(root);
  assert.deepEqual(items.map((item) => item.name), ['课程', 'readme.md']);
  const results = await searchItems(root, '概率');
  assert.equal(results.length, 1);
  assert.equal(results[0].path, '课程/概率论.txt');
});

test('unique upload destinations add a numeric suffix', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mydrive-name-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'photo.jpg'), 'first');
  const destination = await chooseUniqueDestination(root, 'photo.jpg');
  assert.equal(destination.name, 'photo (1).jpg');
});
