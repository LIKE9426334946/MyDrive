'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const express = require('express');
const multer = require('multer');
const { constantTimeEqual } = require('./security');
const { createStorageError, normalizeVirtualPath, resolveVirtualPath, validateItemName } = require('./storage');

// Inspect every directory component: recursive mkdir alone would follow symlinks.
async function ensureCsvDirectory(storageRoot, virtualPath) {
  let directory = path.resolve(storageRoot);
  for (const segment of ['', ...virtualPath.split('/')]) {
    if (segment) directory = path.join(directory, segment);
    try {
      await fs.mkdir(directory, { mode: 0o700 });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    const stats = await fs.lstat(directory);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw createStorageError('目标路径不能包含符号链接或普通文件', 'INVALID_PATH');
    }
  }
  return directory;
}

// Atomically publish complete files. Do not truncate a readable destination in place.
async function publishCsv(stagedPath, destination) {
  for (;;) {
    try {
      await fs.link(stagedPath, destination);
      return false; // Newly created; no previous file was replaced.
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    const existing = await fs.lstat(destination).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!existing) continue;
    if (!existing.isFile()) {
      throw createStorageError('同名目标不是普通文件，不能替换', 'NAME_CONFLICT');
    }
    await fs.rename(stagedPath, destination);
    return true;
  }
}

async function saveCsv(temporaryPath, directory, filename) {
  const destination = path.join(directory, filename);
  try {
    return await publishCsv(temporaryPath, destination);
  } catch (error) {
    if (error.code !== 'EXDEV') throw error;
  }

  // TEMP_ROOT can be on another mount. Complete the copy on the destination
  // filesystem before publishing; an interrupted copy leaves the old CSV intact.
  const stage = await fs.mkdtemp(path.join(directory, '.mydrive-csv-'));
  try {
    const stagedPath = path.join(stage, 'upload');
    await fs.copyFile(temporaryPath, stagedPath);
    return await publishCsv(stagedPath, destination);
  } finally {
    await fs.rm(stage, { recursive: true, force: true });
  }
}

function createCsvUploadRouter({ token, storageRoot, tempRoot, maxUploadBytes }) {
  const router = express.Router();
  const upload = multer({
    dest: tempRoot,
    limits: { fileSize: maxUploadBytes, files: 1, fields: 0, parts: 2 },
    fileFilter(request, file, callback) {
      if (path.extname(file.originalname).toLowerCase() !== '.csv') {
        callback(createStorageError('只允许上传 CSV 文件', 'INVALID_CSV'));
      } else {
        callback(null, true);
      }
    }
  });

  router.post('/', (request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');
    if (!token) {
      response.status(503).json({ status: 'error', message: 'CSV_UPLOAD_TOKEN is not configured' });
      return;
    }
    const suppliedToken = /^Bearer\s+(\S+)$/i.exec(request.get('Authorization') || '')?.[1] || '';
    if (!constantTimeEqual(suppliedToken, token)) {
      response.status(401).json({ status: 'error', message: 'invalid token' });
      return;
    }
    try {
      const targetPath = normalizeVirtualPath(request.query.path);
      if (!targetPath) throw createStorageError('请指定网盘内的目标目录，例如 results', 'INVALID_PATH');
      targetPath.split('/').forEach((part) => {
        if (validateItemName(part) !== part || Buffer.byteLength(part, 'utf8') > 255) {
          throw createStorageError('目标目录名称不合法或过长', 'INVALID_PATH');
        }
      });
      resolveVirtualPath(storageRoot, targetPath);
      const filename = validateItemName(request.query.filename);
      if (path.extname(filename).toLowerCase() !== '.csv' || Buffer.byteLength(filename, 'utf8') > 255) {
        throw createStorageError('文件名必须以 .csv 结尾且不超过 255 个 UTF-8 字节', 'INVALID_CSV');
      }
      request.csvTarget = { path: targetPath, filename };
      next();
    } catch (error) {
      next(error);
    }
  }, upload.single('file'), async (request, response) => {
    if (!request.file) {
      response.status(400).json({ status: 'error', message: 'missing CSV file (field: file)' });
      return;
    }
    let stored;
    try {
      const target = request.csvTarget;
      const directory = await ensureCsvDirectory(storageRoot, target.path);
      const filename = target.filename;
      const replaced = await saveCsv(request.file.path, directory, filename);
      stored = {
        status: 'success',
        filename,
        path: `${target.path}/${filename}`,
        size: request.file.size,
        replaced
      };
    } finally {
      await fs.rm(request.file.path, { force: true });
    }
    response.status(stored.replaced ? 200 : 201).json(stored);
  });

  router.use((error, request, response, next) => {
    if (response.headersSent) return next(error);
    if (error instanceof multer.MulterError) {
      const message = error.code === 'LIMIT_FILE_SIZE'
        ? 'CSV 文件超过服务器上传大小限制'
        : '每次请求只能上传一个 file 字段，目录和文件名请放在 URL 查询参数中';
      response.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ status: 'error', message });
    } else if (['INVALID_PATH', 'INVALID_NAME', 'INVALID_CSV'].includes(error.code)) {
      response.status(400).json({ status: 'error', message: error.message });
    } else if (error.code === 'NAME_CONFLICT') {
      response.status(409).json({ status: 'error', message: error.message });
    } else {
      console.error('CSV upload failed:', error);
      response.status(500).json({ status: 'error', message: 'CSV 上传失败，请检查服务器存储空间和日志' });
    }
  });
  return router;
}

module.exports = { createCsvUploadRouter };
