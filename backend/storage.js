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

function decodeMultipartFilename(name) {
  const value = String(name);
  if (!value || [...value].some((character) => character.codePointAt(0) > 0xff)) return value;

  const originalBytes = Buffer.from(value, 'latin1');
  const decoded = originalBytes.toString('utf8');
  if (decoded.includes('\ufffd') || !Buffer.from(decoded, 'utf8').equals(originalBytes)) return value;
  return decoded;
}

function sanitizeUploadName(name) {
  const decodedName = decodeMultipartFilename(name);
  const basename = path.basename(decodedName.replace(/\\/g, '/'));
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
    const suffix = index === 0 ? '' : `_${index}`;
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

function parentVirtualPath(virtualPath) {
  const normalized = normalizeVirtualPath(virtualPath);
  const separator = normalized.lastIndexOf('/');
  return separator < 0 ? '' : normalized.slice(0, separator);
}

async function requireMovableItem(root, virtualPath) {
  const normalizedPath = normalizeVirtualPath(virtualPath);
  if (!normalizedPath) throw createStorageError('不能操作网盘根目录', 'ROOT_OPERATION_FORBIDDEN');
  const absolutePath = resolveVirtualPath(root, normalizedPath);
  const stats = await fs.lstat(absolutePath).catch((error) => {
    if (error.code === 'ENOENT') throw createStorageError('文件或文件夹不存在', 'NOT_FOUND');
    throw error;
  });
  if (stats.isSymbolicLink() || (!stats.isFile() && !stats.isDirectory())) {
    throw createStorageError('目标不是有效文件或文件夹', 'INVALID_ITEM');
  }
  return { normalizedPath, absolutePath, stats };
}

async function requireDestinationDirectory(root, virtualPath) {
  const normalizedPath = normalizeVirtualPath(virtualPath);
  const absolutePath = resolveVirtualPath(root, normalizedPath);
  const stats = await fs.lstat(absolutePath).catch((error) => {
    if (error.code === 'ENOENT') throw createStorageError('目标文件夹不存在', 'NOT_FOUND');
    throw error;
  });
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw createStorageError('目标不是有效文件夹', 'NOT_DIRECTORY');
  }
  return { normalizedPath, absolutePath };
}

async function assertDestinationAvailable(absolutePath) {
  try {
    await fs.lstat(absolutePath);
    throw createStorageError('目标位置已存在同名文件或文件夹', 'ALREADY_EXISTS');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

async function renameItem(root, virtualPath, newName) {
  const source = await requireMovableItem(root, virtualPath);
  const name = validateItemName(newName);
  const parentPath = parentVirtualPath(source.normalizedPath);
  const destinationPath = joinVirtualPath(parentPath, name);
  if (destinationPath === source.normalizedPath) {
    return { previousPath: source.normalizedPath, path: source.normalizedPath, name, changed: false };
  }

  const destinationAbsolutePath = resolveVirtualPath(root, destinationPath);
  await assertDestinationAvailable(destinationAbsolutePath);
  await fs.rename(source.absolutePath, destinationAbsolutePath);
  return {
    previousPath: source.normalizedPath,
    path: destinationPath,
    name,
    kind: source.stats.isDirectory() ? 'folder' : 'file',
    changed: true
  };
}

async function moveItem(root, virtualPath, destinationDirectoryPath) {
  const source = await requireMovableItem(root, virtualPath);
  const destinationDirectory = await requireDestinationDirectory(root, destinationDirectoryPath);
  const currentParentPath = parentVirtualPath(source.normalizedPath);
  if (destinationDirectory.normalizedPath === currentParentPath) {
    throw createStorageError('文件已经位于这个文件夹中', 'SAME_DESTINATION');
  }
  if (
    source.stats.isDirectory() &&
    (destinationDirectory.absolutePath === source.absolutePath ||
      destinationDirectory.absolutePath.startsWith(`${source.absolutePath}${path.sep}`))
  ) {
    throw createStorageError('不能把文件夹移动到自己或自己的子文件夹中', 'INVALID_DESTINATION');
  }

  const name = path.posix.basename(source.normalizedPath);
  const destinationPath = joinVirtualPath(destinationDirectory.normalizedPath, name);
  const destinationAbsolutePath = resolveVirtualPath(root, destinationPath);
  await assertDestinationAvailable(destinationAbsolutePath);
  await fs.rename(source.absolutePath, destinationAbsolutePath);
  return {
    previousPath: source.normalizedPath,
    path: destinationPath,
    name,
    kind: source.stats.isDirectory() ? 'folder' : 'file'
  };
}

module.exports = {
  chooseUniqueDestination,
  createStorageError,
  decodeMultipartFilename,
  joinVirtualPath,
  listDirectory,
  moveItem,
  normalizeVirtualPath,
  parentVirtualPath,
  renameItem,
  resolveVirtualPath,
  sanitizeUploadName,
  searchItems,
  validateItemName
};
