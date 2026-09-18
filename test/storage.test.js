'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  chooseUniqueDestination,
  decodeMultipartFilename,
  listDirectory,
  moveItem,
  normalizeVirtualPath,
  prepareBatchItems,
  renameItem,
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

test('multipart filenames recover UTF-8 text misread as Latin-1', () => {
  const expected = '机器学习模型.mp4';
  const mojibake = Buffer.from(expected, 'utf8').toString('latin1');
  assert.equal(decodeMultipartFilename(mojibake), expected);
  assert.equal(sanitizeUploadName(mojibake), expected);

  assert.equal(sanitizeUploadName('中文文件.txt'), '中文文件.txt');
  assert.equal(sanitizeUploadName('café.txt'), 'café.txt');
  assert.equal(sanitizeUploadName('实验🧪.txt'), '实验🧪.txt');
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
  assert.equal(destination.name, 'photo_1.jpg');
});

test('files can be renamed and moved without overwriting existing items', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mydrive-move-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, '来源'));
  await fs.mkdir(path.join(root, '目标'));
  await fs.writeFile(path.join(root, '来源', '笔记.txt'), 'notes');

  const renamed = await renameItem(root, '来源/笔记.txt', '复习笔记.txt');
  assert.equal(renamed.path, '来源/复习笔记.txt');
  assert.equal(await fs.readFile(path.join(root, '来源', '复习笔记.txt'), 'utf8'), 'notes');

  const moved = await moveItem(root, renamed.path, '目标');
  assert.equal(moved.path, '目标/复习笔记.txt');
  assert.equal(await fs.readFile(path.join(root, '目标', '复习笔记.txt'), 'utf8'), 'notes');

  await fs.writeFile(path.join(root, '来源', '复习笔记.txt'), 'conflict');
  await assert.rejects(() => moveItem(root, moved.path, '来源'), { code: 'ALREADY_EXISTS' });
});

test('folders cannot be moved into themselves or their descendants', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mydrive-cycle-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, '课程', '章节'), { recursive: true });

  await assert.rejects(() => moveItem(root, '课程', '课程'), { code: 'INVALID_DESTINATION' });
  await assert.rejects(() => moveItem(root, '课程', '课程/章节'), { code: 'INVALID_DESTINATION' });
  await assert.rejects(() => renameItem(root, '', '根目录'), { code: 'ROOT_OPERATION_FORBIDDEN' });
});

test('batch selections are validated, deduplicated, and collapse nested paths', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mydrive-batch-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, '课程', '章节'), { recursive: true });
  await fs.writeFile(path.join(root, '课程', '章节', '笔记.txt'), 'notes');
  await fs.writeFile(path.join(root, '作业.txt'), 'homework');

  const items = await prepareBatchItems(root, [
    '课程/章节/笔记.txt',
    '课程',
    '课程',
    '作业.txt'
  ]);
  assert.deepEqual(items.map((item) => item.normalizedPath), ['课程', '作业.txt']);
  await assert.rejects(() => prepareBatchItems(root, []), { code: 'INVALID_SELECTION' });
  await assert.rejects(() => prepareBatchItems(root, ['']), { code: 'ROOT_OPERATION_FORBIDDEN' });
  await assert.rejects(() => prepareBatchItems(root, ['不存在.txt']), { code: 'NOT_FOUND' });
});
