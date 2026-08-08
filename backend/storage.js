'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const MAX_NAME_LENGTH = 255;

function normalizeVirtualPath(value = '') {
  if (typeof value !== 'string') throw createStorageError('路径格式不正确', 'INVALID_PATH');
  if (value.includes('\0') || value.includes('\\')) {
    throw createStorageError('路径包含不允许的字符', 'INVALID_PATH');
  }

  const stripped = value.replace(/^\/+|\/+$/g, '');
  if (!stripped) return '';
  const segments = stripped.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw createStorageError('路径不合法', 'INVALID_PATH');
  }
  return segments.join('/');
}

function resolveVirtualPath(root, virtualPath = '') {
  const normalizedRoot = path.resolve(root);
  const normalizedVirtualPath = normalizeVirtualPath(virtualPath);
  const resolved = path.resolve(normalizedRoot, ...normalizedVirtualPath.split('/').filter(Boolean));
  if (resolved !== normalizedRoot && !resolved.startsWith(`${normalizedRoot}${path.sep}`)) {
    throw createStorageError('路径超出存储范围', 'INVALID_PATH');
  }
  return resolved;
}

function validateItemName(name) {
  if (typeof name !== 'string') throw createStorageError('名称格式不正确', 'INVALID_NAME');
  const normalized = name.normalize('NFC').trim();
  if (
    !normalized ||
    normalized === '.' ||
    normalized === '..' ||
    normalized.length > MAX_NAME_LENGTH ||
    /[\u0000-\u001f\u007f/\\]/u.test(normalized)
  ) {
    throw createStorageError('名称为空或包含不允许的字符', 'INVALID_NAME');
  }
  return normalized;
}

function sanitizeUploadName(name) {
  const basename = path.basename(String(name).replace(/\\/g, '/'));
  const cleaned = basename.replace(/[\u0000-\u001f\u007f/\\]/gu, '_').normalize('NFC').trim();
  return validateItemName(cleaned || '未命名文件');
}

function joinVirtualPath(...parts) {
  return parts.filter(Boolean).join('/');
}

function createStorageError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function describeItem(root, parentPath, dirent) {
  const virtualPath = joinVirtualPath(parentPath, dirent.name);
  const absolutePath = resolveVirtualPath(root, virtualPath);
  const stats = await fs.lstat(absolutePath);
  if (stats.isSymbolicLink()) return null;

  const kind = stats.isDirectory() ? 'folder' : stats.isFile() ? 'file' : 'other';
  if (kind === 'other') return null;
  return {
    name: dirent.name,
    path: virtualPath,
    parentPath,
    kind,
    size: kind === 'file' ? stats.size : null,
    modifiedAt: stats.mtime.toISOString(),
    extension: kind === 'file' ? path.extname(dirent.name).slice(1).toLowerCase() : ''
  };
}

function sortItems(items) {
  return items.sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === 'folder' ? -1 : 1;
    return left.name.localeCompare(right.name, 'zh-CN', { numeric: true, sensitivity: 'base' });
  });
}

async function listDirectory(root, virtualPath = '') {
  const normalizedPath = normalizeVirtualPath(virtualPath);
  const absolutePath = resolveVirtualPath(root, normalizedPath);
  const stats = await fs.lstat(absolutePath).catch((error) => {
    if (error.code === 'ENOENT') throw createStorageError('文件夹不存在', 'NOT_FOUND');
    throw error;
  });
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw createStorageError('目标不是有效文件夹', 'NOT_DIRECTORY');
  }

  const dirents = await fs.readdir(absolutePath, { withFileTypes: true });
  const described = await Promise.all(dirents.map((dirent) => describeItem(root, normalizedPath, dirent)));
  return sortItems(described.filter(Boolean));
}

async function searchItems(root, query, limit = 200) {
  const needle = String(query || '').normalize('NFC').trim().toLocaleLowerCase('zh-CN');
  if (!needle) return [];

  const results = [];
  const queue = [''];
  while (queue.length > 0 && results.length < limit) {
    const currentPath = queue.shift();
    const items = await listDirectory(root, currentPath);
    for (const item of items) {
      if (item.name.toLocaleLowerCase('zh-CN').includes(needle)) results.push(item);
      if (item.kind === 'folder') queue.push(item.path);
      if (results.length >= limit) break;
    }
  }
  return sortItems(results);
}

async function chooseUniqueDestination(directory, originalName) {
  const parsed = path.parse(sanitizeUploadName(originalName));
  for (let index = 0; index < 10_000; index += 1) {
    const suffix = index === 0 ? '' : ` (${index})`;
    const candidate = `${parsed.name}${suffix}${parsed.ext}`;
    const absolutePath = path.join(directory, candidate);
    try {
      await fs.access(absolutePath);
    } catch (error) {
      if (error.code === 'ENOENT') return { name: candidate, absolutePath };
      throw error;
    }
  }
  throw createStorageError('无法为文件生成唯一名称', 'NAME_CONFLICT');
}

module.exports = {
  chooseUniqueDestination,
  createStorageError,
  joinVirtualPath,
  listDirectory,
  normalizeVirtualPath,
  resolveVirtualPath,
  sanitizeUploadName,
  searchItems,
  validateItemName
};
