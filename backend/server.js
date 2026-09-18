'use strict';

const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const express = require('express');
const multer = require('multer');

const {
  SESSION_TTL_MS,
  constantTimeEqual,
  createSessionToken,
  parseCookies,
  verifySessionToken
} = require('./security');
const {
  chooseUniqueDestination,
  joinVirtualPath,
  listDirectory,
  moveItem,
  normalizeVirtualPath,
  parentVirtualPath,
  prepareBatchItems,
  renameItem,
  resolveVirtualPath,
  searchItems,
  validateItemName
} = require('./storage');

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number.parseInt(process.env.PORT || '3025', 10);
const APP_USERNAME = process.env.APP_USERNAME || 'noart';
const APP_PASSWORD = process.env.APP_PASSWORD;
const SESSION_SECRET = process.env.SESSION_SECRET;
const KAGGLE_UPLOAD_TOKEN = process.env.KAGGLE_UPLOAD_TOKEN || '';
const COOKIE_SECURE = process.env.COOKIE_SECURE === 'true';
const STORAGE_ROOT = path.resolve(process.env.STORAGE_ROOT || path.join(__dirname, '..', 'data', 'uploads'));
const TEMP_ROOT = path.resolve(process.env.TEMP_ROOT || path.join(__dirname, '..', 'data', 'tmp'));
const MAX_UPLOAD_BYTES = Number.parseInt(process.env.MAX_UPLOAD_BYTES || String(100 * 1024 ** 3), 10);
const MAX_UPLOAD_FILES = Number.parseInt(process.env.MAX_UPLOAD_FILES || '20', 10);
const REQUEST_TIMEOUT_MS = Number.parseInt(process.env.REQUEST_TIMEOUT_MS || String(24 * 60 * 60 * 1000), 10);
const SESSION_COOKIE = 'mydrive_session';
const ARCHIVE_TOKEN_TTL_MS = 5 * 60 * 1000;

if (!APP_PASSWORD) throw new Error('APP_PASSWORD 环境变量未设置');
if (!SESSION_SECRET || SESSION_SECRET.length < 32) {
  throw new Error('SESSION_SECRET 环境变量必须至少包含 32 个字符');
}
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65_535) throw new Error('PORT 配置不正确');
if (!Number.isSafeInteger(MAX_UPLOAD_BYTES) || MAX_UPLOAD_BYTES <= 0) {
  throw new Error('MAX_UPLOAD_BYTES 配置不正确');
}
if (!Number.isSafeInteger(REQUEST_TIMEOUT_MS) || REQUEST_TIMEOUT_MS < 300_000) {
  throw new Error('REQUEST_TIMEOUT_MS 配置不正确');
}

const app = express();
const publicRoot = path.join(__dirname, '..', 'public');
const loginAttempts = new Map();
const archiveDownloads = new Map();

app.disable('x-powered-by');
app.set('trust proxy', 'loopback');
app.use((request, response, next) => {
  response.set({
    'Content-Security-Policy': "default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'",
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()'
  });
  response.setHeader('X-Request-Id', crypto.randomUUID());
  next();
});
app.use(express.json({ limit: '256kb' }));
app.use(express.static(publicRoot, {
  etag: true,
  maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0,
  index: 'index.html'
}));

function getSession(request) {
  const token = parseCookies(request.headers.cookie)[SESSION_COOKIE];
  const session = verifySessionToken(token, SESSION_SECRET);
  if (!session || session.username !== APP_USERNAME) return null;
  return session;
}

function requireAuthentication(request, response, next) {
  const session = getSession(request);
  if (!session) {
    response.status(401).json({ error: '登录已失效，请重新登录', code: 'UNAUTHORIZED' });
    return;
  }
  request.session = session;
  next();
}

function requireSameOriginWrite(request, response, next) {
  if (request.get('X-Requested-With') !== 'MyDrive') {
    response.status(403).json({ error: '请求来源验证失败', code: 'FORBIDDEN' });
    return;
  }
  next();
}

function sessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'strict',
    secure: COOKIE_SECURE,
    maxAge: SESSION_TTL_MS,
    path: '/'
  };
}

function getAttemptState(ip) {
  const now = Date.now();
  const existing = loginAttempts.get(ip);
  if (!existing || existing.resetAt <= now) {
    const fresh = { count: 0, resetAt: now + 15 * 60 * 1000, blockedUntil: 0 };
    loginAttempts.set(ip, fresh);
    return fresh;
  }
  return existing;
}

function recordFailedLogin(ip) {
  const state = getAttemptState(ip);
  state.count += 1;
  if (state.count >= 5) state.blockedUntil = Date.now() + 15 * 60 * 1000;
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, state] of loginAttempts) {
    if (state.resetAt <= now && state.blockedUntil <= now) loginAttempts.delete(ip);
  }
}, 15 * 60 * 1000).unref();

setInterval(() => {
  const now = Date.now();
  for (const [token, download] of archiveDownloads) {
    if (download.expiresAt <= now) archiveDownloads.delete(token);
  }
}, 60 * 1000).unref();

app.get('/api/health', (request, response) => {
  response.json({ status: 'ok' });
});

app.get('/api/session', (request, response) => {
  const session = getSession(request);
  response.setHeader('Cache-Control', 'no-store');
  response.json(session
    ? { authenticated: true, username: session.username, expiresAt: session.expiresAt }
    : { authenticated: false });
});

app.post('/api/login', requireSameOriginWrite, (request, response) => {
  const attempt = getAttemptState(request.ip);
  if (attempt.blockedUntil > Date.now()) {
    response.setHeader('Retry-After', Math.ceil((attempt.blockedUntil - Date.now()) / 1000));
    response.status(429).json({ error: '登录失败次数过多，请 15 分钟后再试', code: 'TOO_MANY_ATTEMPTS' });
    return;
  }

  const username = typeof request.body?.username === 'string' ? request.body.username : '';
  const password = typeof request.body?.password === 'string' ? request.body.password : '';
  if (!constantTimeEqual(username, APP_USERNAME) || !constantTimeEqual(password, APP_PASSWORD)) {
    recordFailedLogin(request.ip);
    response.status(401).json({ error: '用户名或密码不正确', code: 'INVALID_CREDENTIALS' });
    return;
  }

  loginAttempts.delete(request.ip);
  const token = createSessionToken(APP_USERNAME, SESSION_SECRET);
  response.cookie(SESSION_COOKIE, token, sessionCookieOptions());
  response.setHeader('Cache-Control', 'no-store');
  response.json({ authenticated: true, username: APP_USERNAME, expiresInDays: 30 });
});

app.post('/api/logout', requireSameOriginWrite, (request, response) => {
  response.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    sameSite: 'strict',
    secure: COOKIE_SECURE,
    path: '/'
  });
  response.status(204).end();
});

function authenticateUpload(request, response, next) {
  const authorization = request.get('Authorization') || '';
  if (authorization) {
    const token = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
    if (!KAGGLE_UPLOAD_TOKEN || !constantTimeEqual(token, KAGGLE_UPLOAD_TOKEN)) {
      response.status(401).json({ status: 'error', message: 'invalid token' });
      return;
    }
    request.uploadAuthMode = 'token';
    next();
    return;
  }

  const session = getSession(request);
  if (!session) {
    response.status(401).json({ error: '登录已失效，请重新登录', code: 'UNAUTHORIZED' });
    return;
  }
  if (request.get('X-Requested-With') !== 'MyDrive') {
    response.status(403).json({ error: '请求来源验证失败', code: 'FORBIDDEN' });
    return;
  }
  request.session = session;
  request.uploadAuthMode = 'session';
  next();
}

function uploadErrorResponse(request, response, status, message, code) {
  if (request.uploadAuthMode === 'token') {
    response.status(status).json({ status: 'error', message });
  } else {
    response.status(status).json({ error: message, code });
  }
}

const upload = multer({
  dest: TEMP_ROOT,
  limits: {
    fileSize: MAX_UPLOAD_BYTES,
    files: MAX_UPLOAD_FILES,
    fields: 10,
    parts: MAX_UPLOAD_FILES + 10
  }
});

app.post('/api/upload', authenticateUpload, upload.fields([
  { name: 'files', maxCount: MAX_UPLOAD_FILES },
  { name: 'file', maxCount: 1 }
]), async (request, response) => {
  const uploadedFiles = [
    ...(request.files?.files || []),
    ...(request.files?.file || [])
  ];
  const tokenUpload = request.uploadAuthMode === 'token';
  const requestedFormPath = typeof request.body?.path === 'string' ? request.body.path.trim() : '';
  if (tokenUpload && requestedFormPath && requestedFormPath !== 'kaggle') {
    await Promise.all(uploadedFiles.map((file) => fs.rm(file.path, { force: true })));
    uploadErrorResponse(request, response, 400, 'path must be kaggle', 'INVALID_PATH');
    return;
  }

  const targetPath = tokenUpload ? 'kaggle' : normalizeVirtualPath(request.query.path || '');
  const targetDirectory = resolveVirtualPath(STORAGE_ROOT, targetPath);
  if (tokenUpload) await fs.mkdir(targetDirectory, { recursive: true, mode: 0o700 });
  const targetStats = await fs.lstat(targetDirectory).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!targetStats?.isDirectory() || targetStats.isSymbolicLink()) {
    await Promise.all(uploadedFiles.map((file) => fs.rm(file.path, { force: true })));
    uploadErrorResponse(request, response, 404, '上传目标文件夹不存在', 'NOT_FOUND');
    return;
  }
  if (!uploadedFiles.length) {
    uploadErrorResponse(request, response, 400, '请选择需要上传的文件', 'NO_FILES');
    return;
  }

  const stored = [];
  try {
    for (const file of uploadedFiles) {
      let destination;
      while (true) {
        destination = await chooseUniqueDestination(targetDirectory, file.originalname);
        try {
          await fs.link(file.path, destination.absolutePath);
          break;
        } catch (error) {
          if (error.code !== 'EEXIST') throw error;
        }
      }
      await fs.rm(file.path, { force: true });
      stored.push({
        name: destination.name,
        path: joinVirtualPath(targetPath, destination.name),
        size: file.size,
        kind: 'file'
      });
    }
  } finally {
    await Promise.all(uploadedFiles.map((file) => fs.rm(file.path, { force: true }).catch(() => {})));
  }

  if (tokenUpload) {
    response.status(201).json({ status: 'success', filename: stored[0].name });
  } else {
    response.status(201).json({ files: stored });
  }
});

app.use('/api', requireAuthentication);

app.get('/api/files', async (request, response) => {
  const currentPath = normalizeVirtualPath(request.query.path || '');
  const items = await listDirectory(STORAGE_ROOT, currentPath);
  response.setHeader('Cache-Control', 'no-store');
  response.json({ currentPath, items });
});

app.get('/api/search', async (request, response) => {
  const query = typeof request.query.q === 'string' ? request.query.q.trim() : '';
  if (!query || query.length > 100) {
    response.status(400).json({ error: '请输入 1 至 100 个字符的搜索内容', code: 'INVALID_QUERY' });
    return;
  }
  const items = await searchItems(STORAGE_ROOT, query, 200);
  response.setHeader('Cache-Control', 'no-store');
  response.json({ query, items, limited: items.length === 200 });
});

app.post('/api/folders', requireSameOriginWrite, async (request, response) => {
  const parentPath = normalizeVirtualPath(request.body?.path || '');
  const name = validateItemName(request.body?.name);
  const parentAbsolutePath = resolveVirtualPath(STORAGE_ROOT, parentPath);
  const parentStats = await fs.lstat(parentAbsolutePath).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!parentStats?.isDirectory() || parentStats.isSymbolicLink()) {
    response.status(404).json({ error: '父文件夹不存在', code: 'NOT_FOUND' });
    return;
  }

  const folderPath = resolveVirtualPath(STORAGE_ROOT, joinVirtualPath(parentPath, name));
  try {
    await fs.mkdir(folderPath);
  } catch (error) {
    if (error.code === 'EEXIST') {
      response.status(409).json({ error: '同名文件或文件夹已存在', code: 'ALREADY_EXISTS' });
      return;
    }
    throw error;
  }
  response.status(201).json({ name, path: joinVirtualPath(parentPath, name), kind: 'folder' });
});

app.get('/api/download', async (request, response, next) => {
  try {
    const virtualPath = normalizeVirtualPath(request.query.path || '');
    if (!virtualPath) {
      response.status(400).json({ error: '请选择需要下载的文件', code: 'INVALID_PATH' });
      return;
    }
    const absolutePath = resolveVirtualPath(STORAGE_ROOT, virtualPath);
    const stats = await fs.lstat(absolutePath).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!stats?.isFile() || stats.isSymbolicLink()) {
      response.status(404).json({ error: '文件不存在', code: 'NOT_FOUND' });
      return;
    }
    response.setHeader('Cache-Control', 'private, no-store');
    response.download(absolutePath, path.basename(absolutePath), { dotfiles: 'allow' }, (error) => {
      if (error && !response.headersSent) next(error);
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/items/archive', requireSameOriginWrite, async (request, response) => {
  const items = await prepareBatchItems(STORAGE_ROOT, request.body?.paths);
  const token = crypto.randomBytes(24).toString('base64url');
  archiveDownloads.set(token, {
    username: request.session.username,
    paths: items.map((item) => item.normalizedPath),
    expiresAt: Date.now() + ARCHIVE_TOKEN_TTL_MS
  });
  response.status(201).json({ downloadUrl: `/api/items/archive/${token}` });
});

app.get('/api/items/archive/:token', async (request, response, next) => {
  const download = archiveDownloads.get(request.params.token);
  archiveDownloads.delete(request.params.token);
  if (!download || download.expiresAt <= Date.now() || download.username !== request.session.username) {
    response.status(404).json({ error: '批量下载链接已失效，请重新操作', code: 'NOT_FOUND' });
    return;
  }

  try {
    const items = await prepareBatchItems(STORAGE_ROOT, download.paths);
    const parentPaths = new Set(items.map((item) => parentVirtualPath(item.normalizedPath)));
    const commonParent = parentPaths.size === 1 ? [...parentPaths][0] : '';
    const archiveRoot = resolveVirtualPath(STORAGE_ROOT, commonParent);
    const archivePaths = items.map((item) => commonParent
      ? item.normalizedPath.slice(commonParent.length + 1)
      : item.normalizedPath);
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);

    response.set({
      'Cache-Control': 'private, no-store',
      'Content-Disposition': `attachment; filename="MyDrive_${stamp}.tar.gz"`,
      'Content-Type': 'application/gzip'
    });

    const archive = spawn('tar', ['-czf', '-', '-C', archiveRoot, '--', ...archivePaths], {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let archiveError = '';
    archive.stderr.setEncoding('utf8');
    archive.stderr.on('data', (chunk) => { archiveError = `${archiveError}${chunk}`.slice(-2000); });
    archive.once('error', (error) => {
      if (!response.headersSent) next(error);
      else response.destroy(error);
    });
    archive.once('close', (code) => {
      if (code !== 0 && !response.destroyed) {
        response.destroy(new Error(archiveError.trim() || `tar exited with code ${code}`));
      }
    });
    response.once('close', () => {
      if (!archive.killed) archive.kill();
    });
    archive.stdout.pipe(response);
  } catch (error) {
    next(error);
  }
});

app.patch('/api/items/rename', requireSameOriginWrite, async (request, response) => {
  const result = await renameItem(STORAGE_ROOT, request.body?.path, request.body?.name);
  response.json(result);
});

app.patch('/api/items/move', requireSameOriginWrite, async (request, response) => {
  const result = await moveItem(STORAGE_ROOT, request.body?.path, request.body?.destinationPath || '');
  response.json(result);
});

app.delete('/api/items', requireSameOriginWrite, async (request, response) => {
  const virtualPath = normalizeVirtualPath(request.body?.path || '');
  if (!virtualPath) {
    response.status(400).json({ error: '不能删除网盘根目录', code: 'ROOT_DELETE_FORBIDDEN' });
    return;
  }
  const absolutePath = resolveVirtualPath(STORAGE_ROOT, virtualPath);
  try {
    await fs.rm(absolutePath, { recursive: true, force: false, maxRetries: 2 });
  } catch (error) {
    if (error.code === 'ENOENT') {
      response.status(404).json({ error: '文件或文件夹不存在', code: 'NOT_FOUND' });
      return;
    }
    throw error;
  }
  response.status(204).end();
});

app.delete('/api/items/batch', requireSameOriginWrite, async (request, response) => {
  const items = await prepareBatchItems(STORAGE_ROOT, request.body?.paths);
  for (const item of items) {
    await fs.rm(item.absolutePath, { recursive: true, force: false, maxRetries: 2 });
  }
  response.json({ deleted: items.map((item) => item.normalizedPath) });
});

app.use('/api', (request, response) => {
  response.status(404).json({ error: '接口不存在', code: 'NOT_FOUND' });
});

app.use((error, request, response, next) => {
  if (response.headersSent) {
    next(error);
    return;
  }

  if (error instanceof multer.MulterError) {
    const message = error.code === 'LIMIT_FILE_SIZE'
      ? '文件超过服务器允许的上传大小'
      : error.code === 'LIMIT_FILE_COUNT'
        ? `一次最多上传 ${MAX_UPLOAD_FILES} 个文件`
        : '文件上传失败';
    uploadErrorResponse(request, response, 413, message, error.code);
    return;
  }
  if (['INVALID_PATH', 'INVALID_NAME', 'INVALID_ITEM', 'INVALID_SELECTION', 'ROOT_OPERATION_FORBIDDEN'].includes(error.code)) {
    uploadErrorResponse(request, response, 400, error.message, error.code);
    return;
  }
  if (['ALREADY_EXISTS', 'SAME_DESTINATION', 'INVALID_DESTINATION'].includes(error.code)) {
    uploadErrorResponse(request, response, 409, error.message, error.code);
    return;
  }
  if (['NOT_FOUND', 'NOT_DIRECTORY'].includes(error.code)) {
    uploadErrorResponse(request, response, 404, error.message, error.code);
    return;
  }

  console.error(`[${new Date().toISOString()}]`, error);
  uploadErrorResponse(request, response, 500, '服务器处理请求时出现错误', 'INTERNAL_ERROR');
});

async function start() {
  await fs.mkdir(STORAGE_ROOT, { recursive: true, mode: 0o700 });
  await fs.mkdir(TEMP_ROOT, { recursive: true, mode: 0o700 });
  const server = app.listen(PORT, HOST, () => {
    console.log(`MyDrive listening on http://${HOST}:${PORT}`);
    console.log(`Storage root: ${STORAGE_ROOT}`);
  });
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.timeout = REQUEST_TIMEOUT_MS;

  const shutdown = (signal) => {
    console.log(`${signal} received, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

start().catch((error) => {
  console.error(error);
  process.exit(1);
});

module.exports = app;
