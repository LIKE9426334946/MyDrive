'use strict';

const state = {
  authenticated: false,
  username: '',
  currentPath: '',
  items: [],
  searchQuery: '',
  searchTimer: null,
  requestSequence: 0,
  deleteTarget: null,
  renameTarget: null,
  moveTarget: null,
  movePath: '',
  moveRequestSequence: 0,
  selectionMode: false,
  selectedPaths: new Set(),
  dragDepth: 0
};

const elements = {
  loginView: document.querySelector('#login-view'),
  driveView: document.querySelector('#drive-view'),
  loginForm: document.querySelector('#login-form'),
  loginButton: document.querySelector('#login-button'),
  loginError: document.querySelector('#login-error'),
  username: document.querySelector('#username'),
  password: document.querySelector('#password'),
  togglePassword: document.querySelector('#toggle-password'),
  accountName: document.querySelector('#account-name'),
  accountAvatar: document.querySelector('#account-avatar'),
  logoutButton: document.querySelector('#logout-button'),
  searchInput: document.querySelector('#search-input'),
  clearSearch: document.querySelector('#clear-search'),
  pageEyebrow: document.querySelector('#page-eyebrow'),
  pageTitle: document.querySelector('#page-title'),
  breadcrumbs: document.querySelector('#breadcrumbs'),
  selectModeButton: document.querySelector('#select-mode-button'),
  newFolderButton: document.querySelector('#new-folder-button'),
  uploadButton: document.querySelector('#upload-button'),
  emptyUploadButton: document.querySelector('#empty-upload-button'),
  fileInput: document.querySelector('#file-input'),
  filePanel: document.querySelector('#drop-zone'),
  dropOverlay: document.querySelector('#drop-overlay'),
  selectionToolbar: document.querySelector('#selection-toolbar'),
  selectAllCheckbox: document.querySelector('#select-all-checkbox'),
  selectionCount: document.querySelector('#selection-count'),
  batchDownloadButton: document.querySelector('#batch-download-button'),
  batchDeleteButton: document.querySelector('#batch-delete-button'),
  selectionCancelButton: document.querySelector('#selection-cancel-button'),
  listHeader: document.querySelector('#list-header'),
  loadingState: document.querySelector('#loading-state'),
  fileList: document.querySelector('#file-list'),
  emptyState: document.querySelector('#empty-state'),
  emptyTitle: document.querySelector('#empty-title'),
  emptyDescription: document.querySelector('#empty-description'),
  itemCount: document.querySelector('#item-count'),
  uploadProgress: document.querySelector('#upload-progress'),
  uploadProgressTitle: document.querySelector('#upload-progress-title'),
  uploadProgressDetail: document.querySelector('#upload-progress-detail'),
  uploadPercent: document.querySelector('#upload-percent'),
  progressBar: document.querySelector('#progress-bar'),
  folderDialog: document.querySelector('#folder-dialog'),
  folderForm: document.querySelector('#folder-form'),
  folderName: document.querySelector('#folder-name'),
  folderError: document.querySelector('#folder-error'),
  folderCancel: document.querySelector('#folder-cancel'),
  renameDialog: document.querySelector('#rename-dialog'),
  renameForm: document.querySelector('#rename-form'),
  renameDescription: document.querySelector('#rename-description'),
  renameInput: document.querySelector('#rename-input'),
  renameError: document.querySelector('#rename-error'),
  renameConfirm: document.querySelector('#rename-confirm'),
  renameCancel: document.querySelector('#rename-cancel'),
  moveDialog: document.querySelector('#move-dialog'),
  moveForm: document.querySelector('#move-form'),
  moveDescription: document.querySelector('#move-description'),
  moveBreadcrumbs: document.querySelector('#move-breadcrumbs'),
  moveFolderList: document.querySelector('#move-folder-list'),
  moveEmpty: document.querySelector('#move-empty'),
  moveError: document.querySelector('#move-error'),
  moveSelectedPath: document.querySelector('#move-selected-path'),
  moveConfirm: document.querySelector('#move-confirm'),
  moveCancel: document.querySelector('#move-cancel'),
  deleteDialog: document.querySelector('#delete-dialog'),
  deleteForm: document.querySelector('#delete-form'),
  deleteDescription: document.querySelector('#delete-description'),
  deleteConfirm: document.querySelector('#delete-confirm'),
  deleteCancel: document.querySelector('#delete-cancel'),
  toastRegion: document.querySelector('#toast-region')
};

const icons = {
  chevron: '<path d="m9 18 6-6-6-6"/>',
  folder: '<path d="M3 7.5h7l2 2h9v9.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  download: '<path d="M12 4v12M7 11l5 5 5-5"/><path d="M5 20h14"/>',
  move: '<path d="M3 7.5h7l2 2h9v9.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="m9 16 3-3 3 3M12 13v6"/>',
  rename: '<path d="m4 16-.8 4.8L8 20l11-11-4-4z"/><path d="m13.5 6.5 4 4"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5"/>'
};

function createSvg(markup) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = markup;
  return svg;
}

async function api(url, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body && !(options.body instanceof FormData)) headers.set('Content-Type', 'application/json');
  if (options.method && options.method !== 'GET') headers.set('X-Requested-With', 'MyDrive');

  const response = await fetch(url, { ...options, headers });
  let payload = null;
  if (response.status !== 204) {
    const contentType = response.headers.get('content-type') || '';
    payload = contentType.includes('application/json') ? await response.json() : null;
  }
  if (!response.ok) {
    if (response.status === 401 && url !== '/api/login') showLogin();
    const error = new Error(payload?.error || '请求失败，请稍后重试');
    error.status = response.status;
    error.code = payload?.code;
    throw error;
  }
  return payload;
}

function showLogin() {
  state.authenticated = false;
  state.selectionMode = false;
  state.selectedPaths.clear();
  elements.selectionToolbar.hidden = true;
  elements.driveView.hidden = true;
  elements.loginView.hidden = false;
  elements.password.value = '';
  window.setTimeout(() => elements.username.focus(), 30);
}

function showDrive(username) {
  state.authenticated = true;
  state.username = username;
  elements.accountName.textContent = username;
  elements.accountAvatar.textContent = username.charAt(0).toUpperCase();
  elements.loginView.hidden = true;
  elements.driveView.hidden = false;
}

function setLoading(isLoading) {
  elements.loadingState.hidden = !isLoading;
  if (isLoading) {
    elements.fileList.replaceChildren();
    elements.emptyState.hidden = true;
  }
}

function showToast(message, type = 'success') {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  elements.toastRegion.append(toast);
  window.setTimeout(() => toast.remove(), 3600);
}

function formatSize(bytes) {
  if (bytes === null || bytes === undefined) return '—';
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / (1024 ** index);
  return `${value.toLocaleString('zh-CN', { maximumFractionDigits: index === 0 ? 0 : 1 })} ${units[index]}`;
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  return new Intl.DateTimeFormat('zh-CN', sameDay
    ? { hour: '2-digit', minute: '2-digit' }
    : { year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

function fileCategory(extension) {
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'heic'].includes(extension)) return 'image';
  if (['mp4', 'mov', 'avi', 'mkv', 'webm', 'm4v'].includes(extension)) return 'video';
  if (['mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg'].includes(extension)) return 'audio';
  if (['zip', 'rar', '7z', 'tar', 'gz', 'bz2'].includes(extension)) return 'archive';
  if (['js', 'ts', 'jsx', 'tsx', 'py', 'java', 'kt', 'go', 'rs', 'html', 'css', 'json', 'yaml', 'yml', 'md', 'sh'].includes(extension)) return 'code';
  if (extension === 'pdf') return 'pdf';
  return 'default';
}

function makeFileIcon(item) {
  const icon = document.createElement('span');
  if (item.kind === 'folder') {
    icon.className = 'file-icon folder';
    icon.append(createSvg(icons.folder));
    return icon;
  }
  const category = fileCategory(item.extension);
  icon.className = `file-icon ${category}`;
  icon.textContent = (item.extension || 'FILE').slice(0, 4);
  return icon;
}

function actionButton(label, icon, className, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `icon-button file-action-button ${className}`;
  button.setAttribute('aria-label', label);
  button.title = label;
  button.append(createSvg(icon));
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    onClick();
  });
  return button;
}

function openItem(item) {
  if (item.kind === 'folder') {
    elements.searchInput.value = '';
    state.searchQuery = '';
    elements.clearSearch.hidden = true;
    loadDirectory(item.path, true);
  } else {
    downloadItem(item);
  }
}

function downloadItem(item) {
  const url = `/api/download?path=${encodeURIComponent(item.path)}`;
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = item.name;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}

function selectedItems() {
  return state.items.filter((item) => state.selectedPaths.has(item.path));
}

function updateSelectionUi() {
  const count = state.selectedPaths.size;
  const allSelected = state.items.length > 0 && count === state.items.length;
  elements.selectionCount.textContent = `已选 ${count} 项`;
  elements.selectAllCheckbox.checked = allSelected;
  elements.selectAllCheckbox.indeterminate = count > 0 && !allSelected;
  elements.batchDownloadButton.disabled = count === 0;
  elements.batchDeleteButton.disabled = count === 0;
}

function setSelectionMode(enabled) {
  state.selectionMode = Boolean(enabled) && !state.searchQuery && state.items.length > 0;
  state.selectedPaths.clear();
  renderItems(state.items);
}

function toggleItemSelection(itemPath, selected) {
  if (selected) state.selectedPaths.add(itemPath);
  else state.selectedPaths.delete(itemPath);
  renderItems(state.items);
}

async function downloadSelectedItems() {
  const paths = selectedItems().map((item) => item.path);
  if (!paths.length) return;
  elements.batchDownloadButton.disabled = true;
  try {
    const payload = await api('/api/items/archive', {
      method: 'POST',
      body: JSON.stringify({ paths })
    });
    const anchor = document.createElement('a');
    anchor.href = payload.downloadUrl;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    showToast(`正在打包下载 ${paths.length} 个项目`);
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    updateSelectionUi();
  }
}

function parentPath(virtualPath) {
  const separator = virtualPath.lastIndexOf('/');
  return separator < 0 ? '' : virtualPath.slice(0, separator);
}

function renderFileRow(item) {
  const row = document.createElement('article');
  row.className = 'file-row';
  row.classList.toggle('selected', state.selectedPaths.has(item.path));

  const nameCell = document.createElement('div');
  nameCell.className = 'file-name-cell';
  if (state.selectionMode) {
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'item-checkbox';
    checkbox.checked = state.selectedPaths.has(item.path);
    checkbox.setAttribute('aria-label', `选择 ${item.name}`);
    checkbox.addEventListener('click', (event) => event.stopPropagation());
    checkbox.addEventListener('change', () => toggleItemSelection(item.path, checkbox.checked));
    nameCell.append(checkbox);
  }
  const openButton = document.createElement('button');
  openButton.type = 'button';
  openButton.className = 'file-open-button';
  openButton.append(makeFileIcon(item));

  const titleWrap = document.createElement('span');
  titleWrap.className = 'file-title-wrap';
  titleWrap.dataset.meta = item.kind === 'folder'
    ? `文件夹 · ${formatDate(item.modifiedAt)}`
    : `${formatSize(item.size)} · ${formatDate(item.modifiedAt)}`;
  const title = document.createElement('span');
  title.className = 'file-title';
  title.textContent = item.name;
  title.title = item.name;
  titleWrap.append(title);
  if (state.searchQuery) {
    const location = document.createElement('span');
    location.className = 'file-location';
    location.textContent = item.parentPath ? `位置：/${item.parentPath}` : '位置：我的文件';
    titleWrap.append(location);
  }
  openButton.append(titleWrap);
  openButton.addEventListener('click', () => {
    if (state.selectionMode) toggleItemSelection(item.path, !state.selectedPaths.has(item.path));
    else openItem(item);
  });
  nameCell.append(openButton);

  const modified = document.createElement('span');
  modified.className = 'file-meta modified-cell';
  modified.textContent = formatDate(item.modifiedAt);

  const size = document.createElement('span');
  size.className = 'file-meta size-cell';
  size.textContent = formatSize(item.size);

  const actions = document.createElement('div');
  actions.className = 'file-actions';
  if (item.kind === 'file') {
    actions.append(actionButton('下载', icons.download, 'download', () => downloadItem(item)));
  }
  actions.append(actionButton('移动', icons.move, 'move', () => askMove(item)));
  actions.append(actionButton('重命名', icons.rename, 'rename', () => askRename(item)));
  actions.append(actionButton('删除', icons.trash, 'delete', () => askDelete(item)));

  row.append(nameCell, modified, size, actions);
  return row;
}

function renderItems(items) {
  const availablePaths = new Set(items.map((item) => item.path));
  for (const selectedPath of state.selectedPaths) {
    if (!availablePaths.has(selectedPath)) state.selectedPaths.delete(selectedPath);
  }
  elements.fileList.replaceChildren(...items.map(renderFileRow));
  elements.filePanel.classList.toggle('search-results', Boolean(state.searchQuery));
  elements.filePanel.classList.toggle('selection-mode', state.selectionMode);
  elements.selectionToolbar.hidden = !state.selectionMode;
  elements.selectModeButton.classList.toggle('active', state.selectionMode);
  elements.selectModeButton.setAttribute('aria-pressed', String(state.selectionMode));
  elements.selectModeButton.disabled = Boolean(state.searchQuery) || items.length === 0;
  elements.newFolderButton.disabled = state.selectionMode;
  elements.uploadButton.disabled = state.selectionMode;
  elements.searchInput.disabled = state.selectionMode;
  elements.listHeader.hidden = items.length === 0;
  elements.emptyState.hidden = items.length !== 0;
  elements.itemCount.textContent = state.searchQuery
    ? `找到 ${items.length} 个结果`
    : `${items.length} 个项目`;

  if (items.length === 0) {
    elements.emptyTitle.textContent = state.searchQuery ? '没有找到相关文件' : '这里还没有文件';
    elements.emptyDescription.textContent = state.searchQuery
      ? `没有与“${state.searchQuery}”匹配的文件或文件夹`
      : '拖放文件到这里，或者使用上方的上传按钮';
    elements.emptyUploadButton.hidden = Boolean(state.searchQuery);
  }
  updateSelectionUi();
}

function breadcrumbButton(label, path, isCurrent = false) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'breadcrumb-button';
  button.textContent = label;
  if (isCurrent) button.setAttribute('aria-current', 'page');
  button.addEventListener('click', () => {
    elements.searchInput.value = '';
    state.searchQuery = '';
    elements.clearSearch.hidden = true;
    loadDirectory(path, true);
  });
  return button;
}

function renderBreadcrumbs() {
  const nodes = [];
  const segments = state.currentPath ? state.currentPath.split('/') : [];
  nodes.push(breadcrumbButton('我的文件', '', segments.length === 0 && !state.searchQuery));
  let accumulated = '';
  segments.forEach((segment, index) => {
    nodes.push(createSvg(icons.chevron));
    nodes.at(-1).classList.add('breadcrumb-separator');
    accumulated = accumulated ? `${accumulated}/${segment}` : segment;
    nodes.push(breadcrumbButton(segment, accumulated, index === segments.length - 1 && !state.searchQuery));
  });
  if (state.searchQuery) {
    nodes.push(createSvg(icons.chevron));
    nodes.at(-1).classList.add('breadcrumb-separator');
    nodes.push(breadcrumbButton('搜索结果', state.currentPath, true));
  }
  elements.breadcrumbs.replaceChildren(...nodes);
}

function pathFromLocation() {
  const parameters = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  return parameters.get('path') || '';
}

function updateLocation(path, push) {
  const hash = path ? `#path=${encodeURIComponent(path)}` : '#';
  const method = push ? 'pushState' : 'replaceState';
  window.history[method]({ path }, '', hash);
}

async function loadDirectory(path = '', push = false) {
  const sequence = ++state.requestSequence;
  setLoading(true);
  try {
    const payload = await api(`/api/files?path=${encodeURIComponent(path)}`);
    if (sequence !== state.requestSequence) return;
    state.currentPath = payload.currentPath;
    state.items = payload.items;
    state.searchQuery = '';
    state.selectionMode = false;
    state.selectedPaths.clear();
    elements.pageEyebrow.textContent = 'MY FILES';
    elements.pageTitle.textContent = payload.currentPath ? payload.currentPath.split('/').at(-1) : '我的文件';
    renderBreadcrumbs();
    renderItems(payload.items);
    updateLocation(payload.currentPath, push);
  } catch (error) {
    if (error.status === 404 && path) {
      showToast('这个文件夹已不存在，已返回首页', 'error');
      await loadDirectory('', false);
      return;
    }
    if (error.status !== 401) showToast(error.message, 'error');
  } finally {
    if (sequence === state.requestSequence) setLoading(false);
  }
}

async function runSearch(query) {
  const normalized = query.trim();
  if (!normalized) {
    state.searchQuery = '';
    await loadDirectory(state.currentPath, false);
    return;
  }
  const sequence = ++state.requestSequence;
  setLoading(true);
  try {
    const payload = await api(`/api/search?q=${encodeURIComponent(normalized)}`);
    if (sequence !== state.requestSequence) return;
    state.searchQuery = payload.query;
    state.items = payload.items;
    state.selectionMode = false;
    state.selectedPaths.clear();
    elements.pageEyebrow.textContent = 'SEARCH';
    elements.pageTitle.textContent = '搜索结果';
    renderBreadcrumbs();
    renderItems(payload.items);
    if (payload.limited) showToast('结果较多，仅显示前 200 项');
  } catch (error) {
    if (error.status !== 401) showToast(error.message, 'error');
  } finally {
    if (sequence === state.requestSequence) setLoading(false);
  }
}

function askDelete(item) {
  state.deleteTarget = item;
  const extra = item.kind === 'folder' ? '文件夹内的所有内容也会被删除，' : '';
  elements.deleteDescription.textContent = `确定删除“${item.name}”吗？${extra}删除后无法恢复。`;
  elements.deleteDialog.showModal();
}

function askBatchDelete() {
  const items = selectedItems();
  if (!items.length) return;
  state.deleteTarget = { batch: true, items };
  elements.deleteDescription.textContent = `确定删除选中的 ${items.length} 个项目吗？文件夹内的内容也会被删除，删除后无法恢复。`;
  elements.deleteDialog.showModal();
}

function updateCurrentPath(previousPath, nextPath) {
  if (state.currentPath === previousPath || state.currentPath.startsWith(`${previousPath}/`)) {
    state.currentPath = `${nextPath}${state.currentPath.slice(previousPath.length)}`;
    updateLocation(state.currentPath, false);
  }
}

async function refreshCurrentView() {
  if (state.searchQuery) await runSearch(state.searchQuery);
  else await loadDirectory(state.currentPath, false);
}

function askRename(item) {
  state.renameTarget = item;
  elements.renameDescription.textContent = `修改“${item.name}”的名称`;
  elements.renameInput.value = item.name;
  elements.renameError.textContent = '';
  elements.renameDialog.showModal();
  window.setTimeout(() => {
    elements.renameInput.focus();
    const extensionStart = item.kind === 'file' ? item.name.lastIndexOf('.') : -1;
    elements.renameInput.setSelectionRange(0, extensionStart > 0 ? extensionStart : item.name.length);
  }, 30);
}

async function submitRename() {
  if (!state.renameTarget) return;
  const target = state.renameTarget;
  const name = elements.renameInput.value.trim();
  if (!name) {
    elements.renameError.textContent = '请输入新的名称';
    return;
  }
  elements.renameError.textContent = '';
  elements.renameConfirm.disabled = true;
  try {
    const result = await api('/api/items/rename', {
      method: 'PATCH',
      body: JSON.stringify({ path: target.path, name })
    });
    updateCurrentPath(result.previousPath, result.path);
    elements.renameDialog.close();
    state.renameTarget = null;
    showToast(result.changed ? `已重命名为“${result.name}”` : '名称没有变化');
    await refreshCurrentView();
  } catch (error) {
    elements.renameError.textContent = error.message;
  } finally {
    elements.renameConfirm.disabled = false;
  }
}

function isInvalidMoveFolder(folderPath) {
  if (!state.moveTarget || state.moveTarget.kind !== 'folder') return false;
  return folderPath === state.moveTarget.path || folderPath.startsWith(`${state.moveTarget.path}/`);
}

function renderMoveBreadcrumbs() {
  const nodes = [];
  const segments = state.movePath ? state.movePath.split('/') : [];
  const root = document.createElement('button');
  root.type = 'button';
  root.className = 'move-crumb';
  root.textContent = '我的文件';
  if (segments.length === 0) root.setAttribute('aria-current', 'page');
  root.addEventListener('click', () => loadMoveFolders(''));
  nodes.push(root);

  let accumulated = '';
  segments.forEach((segment, index) => {
    const separator = createSvg(icons.chevron);
    separator.classList.add('move-crumb-separator');
    nodes.push(separator);
    accumulated = accumulated ? `${accumulated}/${segment}` : segment;
    const targetPath = accumulated;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'move-crumb';
    button.textContent = segment;
    if (index === segments.length - 1) button.setAttribute('aria-current', 'page');
    button.addEventListener('click', () => loadMoveFolders(targetPath));
    nodes.push(button);
  });
  elements.moveBreadcrumbs.replaceChildren(...nodes);
}

function renderMoveFolders(items) {
  const folders = items.filter((item) => item.kind === 'folder');
  const rows = folders.map((folder) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'move-folder-row';
    const disabled = isInvalidMoveFolder(folder.path);
    button.disabled = disabled;
    button.append(makeFileIcon(folder));
    const name = document.createElement('span');
    name.textContent = folder.name;
    button.append(name);
    if (disabled) {
      const note = document.createElement('small');
      note.textContent = '不能选择';
      button.append(note);
    } else {
      button.append(createSvg(icons.chevron));
      button.addEventListener('click', () => loadMoveFolders(folder.path));
    }
    return button;
  });
  elements.moveFolderList.replaceChildren(...rows);
  elements.moveEmpty.hidden = rows.length !== 0;
}

async function loadMoveFolders(path) {
  const sequence = ++state.moveRequestSequence;
  elements.moveError.textContent = '';
  elements.moveFolderList.textContent = '正在读取文件夹…';
  elements.moveFolderList.classList.add('file-meta');
  elements.moveEmpty.hidden = true;
  try {
    const payload = await api(`/api/files?path=${encodeURIComponent(path)}`);
    if (sequence !== state.moveRequestSequence) return;
    state.movePath = payload.currentPath;
    renderMoveBreadcrumbs();
    renderMoveFolders(payload.items);
    elements.moveSelectedPath.textContent = payload.currentPath ? `我的文件 / ${payload.currentPath}` : '我的文件';
    const sameParent = state.moveTarget && parentPath(state.moveTarget.path) === payload.currentPath;
    const invalidFolder = state.moveTarget && isInvalidMoveFolder(payload.currentPath);
    elements.moveConfirm.disabled = sameParent || invalidFolder;
    elements.moveConfirm.title = sameParent ? '文件已经位于这个文件夹中' : '';
  } catch (error) {
    elements.moveError.textContent = error.message;
    elements.moveFolderList.replaceChildren();
  } finally {
    elements.moveFolderList.classList.remove('file-meta');
  }
}

function askMove(item) {
  state.moveTarget = item;
  state.movePath = '';
  elements.moveConfirm.disabled = true;
  elements.moveDescription.textContent = `选择“${item.name}”的新位置`;
  elements.moveError.textContent = '';
  elements.moveDialog.showModal();
  loadMoveFolders('');
}

async function submitMove() {
  if (!state.moveTarget) return;
  const target = state.moveTarget;
  elements.moveError.textContent = '';
  elements.moveConfirm.disabled = true;
  try {
    const result = await api('/api/items/move', {
      method: 'PATCH',
      body: JSON.stringify({ path: target.path, destinationPath: state.movePath })
    });
    updateCurrentPath(result.previousPath, result.path);
    elements.moveDialog.close();
    state.moveTarget = null;
    showToast(`已将“${result.name}”移动到新位置`);
    await refreshCurrentView();
  } catch (error) {
    elements.moveError.textContent = error.message;
  } finally {
    elements.moveConfirm.disabled = false;
  }
}

async function deleteTarget() {
  if (!state.deleteTarget) return;
  const target = state.deleteTarget;
  elements.deleteConfirm.disabled = true;
  try {
    if (target.batch) {
      await api('/api/items/batch', {
        method: 'DELETE',
        body: JSON.stringify({ paths: target.items.map((item) => item.path) })
      });
    } else {
      await api('/api/items', { method: 'DELETE', body: JSON.stringify({ path: target.path }) });
    }
    elements.deleteDialog.close();
    showToast(target.batch ? `已删除 ${target.items.length} 个项目` : `已删除“${target.name}”`);
    state.deleteTarget = null;
    state.selectionMode = false;
    state.selectedPaths.clear();
    if (state.searchQuery) await runSearch(state.searchQuery);
    else await loadDirectory(state.currentPath, false);
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    elements.deleteConfirm.disabled = false;
  }
}

async function createFolder(name) {
  elements.folderError.textContent = '';
  const submitButton = elements.folderForm.querySelector('[type="submit"]');
  submitButton.disabled = true;
  try {
    await api('/api/folders', {
      method: 'POST',
      body: JSON.stringify({ path: state.currentPath, name })
    });
    elements.folderDialog.close();
    elements.folderForm.reset();
    showToast(`文件夹“${name}”已创建`);
    await loadDirectory(state.currentPath, false);
  } catch (error) {
    elements.folderError.textContent = error.message;
  } finally {
    submitButton.disabled = false;
  }
}

function uploadFiles(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;
  const formData = new FormData();
  files.forEach((file) => formData.append('files', file));

  elements.uploadProgress.hidden = false;
  elements.uploadProgressTitle.textContent = files.length === 1 ? `正在上传 ${files[0].name}` : `正在上传 ${files.length} 个文件`;
  elements.uploadProgressDetail.textContent = '正在连接服务器…';
  elements.uploadPercent.textContent = '0%';
  elements.progressBar.style.width = '0%';

  const xhr = new XMLHttpRequest();
  xhr.open('POST', `/api/upload?path=${encodeURIComponent(state.currentPath)}`);
  xhr.setRequestHeader('X-Requested-With', 'MyDrive');
  xhr.upload.addEventListener('progress', (event) => {
    if (!event.lengthComputable) return;
    const percent = Math.min(100, Math.round((event.loaded / event.total) * 100));
    elements.uploadPercent.textContent = `${percent}%`;
    elements.progressBar.style.width = `${percent}%`;
    elements.uploadProgressDetail.textContent = `${formatSize(event.loaded)} / ${formatSize(event.total)}`;
  });
  xhr.addEventListener('load', async () => {
    let payload = null;
    try { payload = JSON.parse(xhr.responseText); } catch { /* response may be empty */ }
    if (xhr.status >= 200 && xhr.status < 300) {
      elements.uploadPercent.textContent = '100%';
      elements.progressBar.style.width = '100%';
      showToast(files.length === 1 ? '文件上传完成' : `${files.length} 个文件上传完成`);
      await loadDirectory(state.currentPath, false);
    } else {
      if (xhr.status === 401) showLogin();
      showToast(payload?.error || '文件上传失败', 'error');
    }
    window.setTimeout(() => { elements.uploadProgress.hidden = true; }, 900);
  });
  xhr.addEventListener('error', () => {
    showToast('网络连接中断，上传失败', 'error');
    elements.uploadProgress.hidden = true;
  });
  xhr.send(formData);
  elements.fileInput.value = '';
}

elements.loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  elements.loginError.textContent = '';
  const username = elements.username.value.trim();
  const password = elements.password.value;
  if (!username || !password) {
    elements.loginError.textContent = '请输入用户名和密码';
    return;
  }
  elements.loginButton.disabled = true;
  try {
    const payload = await api('/api/login', {
      method: 'POST',
      body: JSON.stringify({ username, password })
    });
    showDrive(payload.username);
    await loadDirectory(pathFromLocation(), false);
  } catch (error) {
    elements.loginError.textContent = error.message;
    elements.password.select();
  } finally {
    elements.loginButton.disabled = false;
  }
});

elements.togglePassword.addEventListener('click', () => {
  const showing = elements.password.type === 'text';
  elements.password.type = showing ? 'password' : 'text';
  elements.togglePassword.setAttribute('aria-label', showing ? '显示密码' : '隐藏密码');
  elements.togglePassword.title = showing ? '显示密码' : '隐藏密码';
});

elements.logoutButton.addEventListener('click', async () => {
  try { await api('/api/logout', { method: 'POST' }); } catch { /* local logout still proceeds */ }
  showLogin();
});

elements.searchInput.addEventListener('input', () => {
  window.clearTimeout(state.searchTimer);
  const value = elements.searchInput.value;
  elements.clearSearch.hidden = !value;
  state.searchTimer = window.setTimeout(() => runSearch(value), 320);
});

elements.clearSearch.addEventListener('click', () => {
  elements.searchInput.value = '';
  elements.clearSearch.hidden = true;
  elements.searchInput.focus();
  runSearch('');
});

elements.selectModeButton.addEventListener('click', () => setSelectionMode(!state.selectionMode));
elements.selectionCancelButton.addEventListener('click', () => setSelectionMode(false));
elements.selectAllCheckbox.addEventListener('change', () => {
  state.selectedPaths.clear();
  if (elements.selectAllCheckbox.checked) {
    for (const item of state.items) state.selectedPaths.add(item.path);
  }
  renderItems(state.items);
});
elements.batchDownloadButton.addEventListener('click', downloadSelectedItems);
elements.batchDeleteButton.addEventListener('click', askBatchDelete);

elements.newFolderButton.addEventListener('click', () => {
  elements.folderError.textContent = '';
  elements.folderForm.reset();
  elements.folderDialog.showModal();
  window.setTimeout(() => elements.folderName.focus(), 30);
});
elements.folderCancel.addEventListener('click', () => elements.folderDialog.close());
elements.folderForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const name = elements.folderName.value.trim();
  if (!name) {
    elements.folderError.textContent = '请输入文件夹名称';
    return;
  }
  createFolder(name);
});

elements.renameCancel.addEventListener('click', () => {
  state.renameTarget = null;
  elements.renameDialog.close();
});
elements.renameForm.addEventListener('submit', (event) => {
  event.preventDefault();
  submitRename();
});

elements.moveCancel.addEventListener('click', () => {
  state.moveTarget = null;
  elements.moveDialog.close();
});
elements.moveForm.addEventListener('submit', (event) => {
  event.preventDefault();
  submitMove();
});

elements.deleteCancel.addEventListener('click', () => {
  state.deleteTarget = null;
  elements.deleteDialog.close();
});
elements.deleteForm.addEventListener('submit', (event) => {
  event.preventDefault();
  deleteTarget();
});

for (const button of [elements.uploadButton, elements.emptyUploadButton]) {
  button.addEventListener('click', () => elements.fileInput.click());
}
elements.fileInput.addEventListener('change', () => uploadFiles(elements.fileInput.files));

for (const eventName of ['dragenter', 'dragover']) {
  elements.filePanel.addEventListener(eventName, (event) => {
    event.preventDefault();
    if (state.selectionMode) return;
    if (!event.dataTransfer?.types.includes('Files')) return;
    if (eventName === 'dragenter') state.dragDepth += 1;
    elements.dropOverlay.hidden = false;
  });
}
elements.filePanel.addEventListener('dragleave', (event) => {
  event.preventDefault();
  state.dragDepth = Math.max(0, state.dragDepth - 1);
  if (state.dragDepth === 0) elements.dropOverlay.hidden = true;
});
elements.filePanel.addEventListener('drop', (event) => {
  event.preventDefault();
  state.dragDepth = 0;
  elements.dropOverlay.hidden = true;
  uploadFiles(event.dataTransfer?.files);
});

window.addEventListener('popstate', () => {
  if (state.authenticated) loadDirectory(pathFromLocation(), false);
});

async function bootstrap() {
  try {
    const session = await api('/api/session');
    if (!session.authenticated) {
      showLogin();
      return;
    }
    showDrive(session.username);
    await loadDirectory(pathFromLocation(), false);
  } catch {
    showLogin();
  }
}

bootstrap();
