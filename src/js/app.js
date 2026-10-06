import {
  LARGE_LOG_WARNING_BYTES,
  classifyDocumentPath,
  getBrowserAccept,
  getDocumentFormatLabel,
  getOpenDialogFilters,
  getSaveDialogFilters,
  isSupportedDocumentPath,
} from './file-types.js';
import {
  createDocumentViewState,
  createSerialTaskQueue,
  formatMiB,
  isDraftDirty,
  isEditorSnapshotCurrent,
  openDocumentWithGuards,
} from './document-session.js';
import { readBrowserTextFile } from './text-decoding.js';
import {
  createMarkdownEngine,
  escapeHtml,
  renderDocumentHtml,
} from './markdown-render.js';
import {
  DEFAULT_PREFERENCES,
  THEMES,
  createPreferenceStore,
} from './preferences.js';
import {
  collectRelativeImageReferences,
  rewriteImageSources,
} from './asset-images.js';
import { createDocumentSession } from './document-session-state.js';
import { createCloseGuard } from './close-guard.js';
import {
  createExternalChangeWatcher,
  planReload,
} from './external-change.js';

const preferences = createPreferenceStore(globalThis.localStorage);
import {
  applyTrashedOutcome,
  createFileLibraryView,
  nextSidePanel,
  requestTrash,
  samePath,
  validateLibraryPaths,
  welcomePaths,
} from './file-library.js';
import {
  classifyLinkHref,
  createOpenExternal,
  handleRenderedLinkClick,
} from './link-router.js';
import {
  createNativeWindowThemeSynchronizer,
  getNativeWindowTheme,
} from './window-theme.js';

// ========== Markdown Engine ==========
const md = createMarkdownEngine();

// ========== State ==========
const state = {
  filePath: null,
  nativeFile: false,
  rawContent: '',
  persistedContent: '',
  kind: null,
  renderMode: null,
  readOnly: false,
  toc: false,
  sizeBytes: 0,
  encoding: 'UTF-8',
  isDirty: false,
  documentGeneration: 0,
  editRevision: 0,
  documentSwitchPending: false,
  savePending: false,
  fileSelectionPending: false,
  isEditMode: false,
  theme: 'light',
  fontSize: 16,
  fullWidth: false,
  activeSidePanel: 'none',
  allowedAssets: [],
  searchVisible: false,
  searchResults: [],
  searchIndex: -1,
  scrollSaveTimer: null,
  libraryFiles: [],
  libraryError: '',
  platform: /Win/i.test(globalThis.navigator?.platform ?? '') ? 'windows' : 'posix',
};

// ========== Document Session (3a) ==========
// 文档级字段的归口对象。当前仍单文档，`state` 与会话一一对应；
// 3b 引入多标签后，切换活动标签只需换绑会话实例。
const documentSession = createDocumentSession();

/**
 * 把会话状态同步回扁平 `state`。
 *
 * 迁移期的单向同步：会话是文档级字段的唯一写入口，`state` 是只读镜像。
 * 3b 完成 `state.xxx` → `session.snapshot().xxx` 的全量改写后即可删除本函数
 * 与 `state` 中的文档级字段。
 */
function syncDocumentStateFromSession() {
  const doc = documentSession.snapshot();
  state.filePath = doc.filePath;
  state.nativeFile = doc.nativeFile;
  state.rawContent = doc.rawContent;
  state.persistedContent = doc.persistedContent;
  state.kind = doc.kind;
  state.renderMode = doc.renderMode;
  state.readOnly = doc.readOnly;
  state.toc = doc.toc;
  state.sizeBytes = doc.sizeBytes;
  state.encoding = doc.encoding;
  state.isDirty = doc.isDirty;
  state.documentGeneration = doc.documentGeneration;
  state.editRevision = doc.editRevision;
  state.isEditMode = doc.isEditMode;
  state.allowedAssets = doc.allowedAssets;
  state.scrollSaveTimer = doc.scrollSaveTimer;
}

const themes = THEMES;
const themeLabels = { light: '浅色', dark: '深色', sepia: '护眼' };

// ========== DOM Elements ==========
const $ = id => document.getElementById(id);
const els = {
  btnOpen: $('btn-open'),
  btnLibrary: $('btn-library'),
  btnToc: $('btn-toc'),
  btnSearch: $('btn-search'),
  btnMode: $('btn-mode'),
  btnTheme: $('btn-theme'),
  btnFontUp: $('btn-font-up'),
  btnFontDown: $('btn-font-down'),
  btnFullWidth: $('btn-full-width'),
  btnSave: $('btn-save'),
  fileName: $('file-name'),
  searchBar: $('search-bar'),
  searchInput: $('search-input'),
  searchCount: $('search-count'),
  searchPrev: $('search-prev'),
  searchNext: $('search-next'),
  searchClose: $('search-close'),
  main: $('main'),
  tocPanel: $('toc-panel'),
  tocContent: $('toc-content'),
  readerView: $('reader-view'),
  editorView: $('editor-view'),
  editorPreview: $('editor-preview'),
  markdownBody: $('markdown-body'),
  editorTextarea: $('editor-textarea'),
  previewBody: $('preview-body'),
  progressBar: $('reading-progress-bar'),
  statusMode: $('status-mode'),
  statusInfo: $('status-info'),
  externalChangeNotice: $('external-change-notice'),
  btnReloadExternal: $('btn-reload-external'),
  statusEncoding: $('status-encoding'),
  fileInput: $('file-input'),
  themeIconSun: $('theme-icon-sun'),
  themeIconMoon: $('theme-icon-moon'),
  themeIconSepia: $('theme-icon-sepia'),
  dirtySwitchDialog: $('dirty-switch-dialog'),
  closeAppDialog: $('close-app-dialog'),
  largeLogDialog: $('large-log-dialog'),
  largeLogFileName: $('large-log-file-name'),
  largeLogFileSize: $('large-log-file-size'),
  libraryPanel: $('library-panel'),
  libraryList: $('library-list'),
  libraryEmpty: $('library-empty'),
  libraryError: $('library-error'),
  libraryErrorText: $('library-error-text'),
  libraryRetry: $('library-retry'),
  fileContextMenu: $('file-context-menu'),
};

const fileLibraryView = createFileLibraryView({
  listElement: els.libraryList,
  scrollElement: els.libraryPanel,
  emptyElement: els.libraryEmpty,
  menuElement: els.fileContextMenu,
  platform: state.platform,
  onOpen: path => openLibraryFile(path),
  onRemove: path => removeLibraryFile(path),
  onTrash: path => trashLibraryFile(path),
  onError: error => showToast(describeAppError(error, '文件目录操作失败')),
});

// ========== Tauri Bridge ==========
let tauriAvailable = false;
let tauriInvoke = null;

function getTauriGlobal() {
  return typeof window !== 'undefined' ? window.__TAURI__ : undefined;
}

async function getTauriInvoke() {
  if (tauriInvoke) return tauriInvoke;
  const global = getTauriGlobal();
  if (global?.core?.invoke) {
    tauriInvoke = global.core.invoke;
    return tauriInvoke;
  }
  const { invoke } = await import('@tauri-apps/api/core');
  tauriInvoke = invoke;
  return tauriInvoke;
}

async function getTauriDialog() {
  const global = getTauriGlobal();
  if (global?.dialog?.open) return global.dialog;
  throw new Error('Tauri dialog plugin not available');
}

async function getTauriEvent() {
  const global = getTauriGlobal();
  if (global?.event?.listen) return global.event;
  const { listen, TauriEvent } = await import('@tauri-apps/api/event');
  return { listen, TauriEvent };
}

async function getTauriWindow() {
  const global = getTauriGlobal();
  if (global?.window?.getCurrentWindow) return global.window;
  return import('@tauri-apps/api/window');
}

const syncNativeWindowTheme = createNativeWindowThemeSynchronizer({
  isAvailable: () => tauriAvailable,
  getCurrentWindow: async () => {
    const windowApi = await getTauriWindow();
    return windowApi.getCurrentWindow();
  },
  onError: error => {
    console.warn('Native window theme sync failed:', error?.message || error);
  },
});

const openExternalUrl = createOpenExternal({
  isTauriAvailable: () => tauriAvailable,
  invoke: async (command, args) => {
    const invoke = await getTauriInvoke();
    return invoke(command, args);
  },
  browserOpen: url => window.open(url, '_blank', 'noopener,noreferrer'),
  onError: error => {
    console.warn('External link open failed:', error?.message || error);
    showToast(describeAppError(error, '无法打开链接'));
  },
});

async function initTauri() {
  if (!getTauriGlobal()?.core?.invoke) {
    console.log('Running in browser mode (no Tauri)');
    return;
  }
  try {
    await getTauriInvoke();
    tauriAvailable = true;
    console.log('Tauri API available (global)');
  } catch {
    console.log('Running in browser mode (no Tauri)');
  }
}

async function selectTauriFile() {
  const dialog = await getTauriDialog();
  const selected = await dialog.open({
    multiple: false,
    directory: false,
    filters: getOpenDialogFilters(),
  });
  return !selected || Array.isArray(selected) ? null : selected;
}

function selectBrowserFile() {
  return new Promise(resolve => {
    let settled = false;
    let focusTimer = null;
    const cleanup = () => {
      els.fileInput.removeEventListener('change', onChange);
      els.fileInput.removeEventListener('cancel', onCancel);
      window.removeEventListener('focus', onWindowFocus);
      if (focusTimer) clearTimeout(focusTimer);
    };
    const finish = file => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(file || null);
    };
    const onChange = () => finish(els.fileInput.files[0]);
    const onCancel = () => finish(null);
    const onWindowFocus = () => {
      focusTimer = setTimeout(() => {
        if (!els.fileInput.files?.length) finish(null);
      }, 150);
    };
    els.fileInput.value = '';
    els.fileInput.addEventListener('change', onChange);
    els.fileInput.addEventListener('cancel', onCancel);
    window.addEventListener('focus', onWindowFocus);
    els.fileInput.click();
  });
}

function getSaveDialogOptions(path) {
  const preferredPath = path || state.filePath;
  const type = classifyDocumentPath(preferredPath);
  const defaultExtension = type.editable ? type.extension : 'md';
  return {
    filters: getSaveDialogFilters(preferredPath),
    defaultPath: preferredPath || `untitled.${defaultExtension}`,
  };
}

async function tauriSaveFile(path, content, canOverwriteCurrentPath) {
  if (tauriAvailable) {
    if (!canOverwriteCurrentPath) {
      const dialog = await getTauriDialog();
      path = await dialog.save(getSaveDialogOptions(path));
      if (!path) return null;
    }
    await tauriInvoke('save_file', { path, content });
    return path;
  }
  // Browser fallback
  const targetPath = path || state.filePath || 'untitled.md';
  const type = classifyDocumentPath(targetPath);
  const blob = new Blob([content], {
    type: type.renderMode === 'plain'
      ? 'text/plain;charset=utf-8'
      : 'text/markdown;charset=utf-8',
  });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = targetPath;
  a.click();
  URL.revokeObjectURL(a.href);
  return targetPath;
}

// ========== Reading Progress ==========
function scrollPercentage(scrollEl) {
  return scrollEl.scrollHeight > scrollEl.clientHeight
    ? scrollEl.scrollTop / (scrollEl.scrollHeight - scrollEl.clientHeight)
    : 0;
}

async function saveProgress() {
  if (!state.filePath || !tauriAvailable) return;
  const path = state.filePath;
  const { scrollRoot: scrollEl } = getReaderContext();
  if (!scrollEl) return;
  const pct = scrollPercentage(scrollEl);

  try {
    await tauriInvoke('save_reading_progress', {
      path,
      scrollPct: Math.min(1, Math.max(0, pct)),
    });
  } catch (e) {
    console.error('Save progress failed:', e);
  }
}

async function loadProgress() {
  if (!state.filePath || !tauriAvailable) return;
  const path = state.filePath;
  const generation = state.documentGeneration;
  const { scrollRoot: scrollEl } = getReaderContext();
  try {
    const progress = await tauriInvoke('load_reading_progress', { path });
    if (progress && progress.scroll_pct > 0) {
      requestAnimationFrame(() => {
        if (
          scrollEl
          && state.filePath === path
          && state.documentGeneration === generation
        ) {
          const maxScroll = scrollEl.scrollHeight - scrollEl.clientHeight;
          scrollEl.scrollTop = progress.scroll_pct * maxScroll;
        }
      });
    }
  } catch (e) {
    console.error('Load progress failed:', e);
  }
}

function onScroll(scrollEl) {
  if (scrollEl !== getReaderContext().scrollRoot) return;
  clearTimeout(state.scrollSaveTimer);
  const path = state.filePath;
  const generation = state.documentGeneration;
  documentSession.setScrollSaveTimer(setTimeout(() => {
    if (state.filePath === path && state.documentGeneration === generation) {
      void saveProgress();
    }
  }, 800));
  state.scrollSaveTimer = documentSession.snapshot().scrollSaveTimer;

  if (scrollEl && els.progressBar) {
    const pct = scrollPercentage(scrollEl) * 100;
    els.progressBar.style.width = pct + '%';
  }
}

// ========== Helpers ==========

const ERROR_MESSAGES = {
  policy_invalid: '文档类型策略无效，应用已阻止文件访问',
  unsupported_type: '不支持的文件类型',
  missing_file: '文件不存在或已被移动',
  not_regular_file: '只能打开普通文件',
  metadata_failed: '无法读取文件信息',
  large_log_confirmation_required: '该日志需要确认后才能读取',
  decode_failed: '无法识别文件编码（仅支持 UTF-8 或 GBK/GB18030）',
  read_failed: '读取文件失败',
  readonly_file: 'LOG 文件以只读模式打开',
  save_failed: '保存文件失败',
};

function normalizeAppError(error) {
  if (error && typeof error === 'object') {
    return {
      code: typeof error.code === 'string' ? error.code : '',
      message: typeof error.message === 'string' ? error.message : '',
    };
  }
  if (typeof error === 'string') {
    try {
      const parsed = JSON.parse(error);
      if (parsed && typeof parsed === 'object') return normalizeAppError(parsed);
    } catch {}
    return { code: '', message: error };
  }
  return { code: '', message: String(error ?? '') };
}

function describeAppError(error, prefix) {
  const normalized = normalizeAppError(error);
  const detail = ERROR_MESSAGES[normalized.code] || normalized.message || '未知错误';
  return prefix ? `${prefix}: ${detail}` : detail;
}

function createClientError(code, message = ERROR_MESSAGES[code]) {
  const error = new Error(message || code);
  error.code = code;
  return error;
}

function promptDialog(dialog, defaultResult = 'cancel') {
  const previouslyFocused = document.activeElement;
  return new Promise(resolve => {
    let settled = false;
    const supportsNativeDialog = typeof dialog.showModal === 'function';
    const cleanup = () => {
      dialog.removeEventListener('click', onClick);
      dialog.removeEventListener('cancel', onCancel);
      dialog.removeEventListener('close', onClose);
      dialog.removeEventListener('keydown', onKeyDown);
    };
    const finish = (result, closeDialog = true) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (closeDialog && dialog.hasAttribute('open')) {
        if (supportsNativeDialog) dialog.close();
        else dialog.removeAttribute('open');
      }
      dialog.classList.remove('dialog-fallback-open');
      if (
        previouslyFocused instanceof HTMLElement
        && previouslyFocused.isConnected
        && !previouslyFocused.hasAttribute('disabled')
      ) {
        requestAnimationFrame(() => previouslyFocused.focus());
      }
      resolve(result);
    };
    const onClick = event => {
      const button = event.target instanceof Element
        ? event.target.closest('button[data-dialog-result]')
        : null;
      if (button) finish(button.dataset.dialogResult);
    };
    const onCancel = event => {
      event.preventDefault();
      finish(defaultResult);
    };
    const onClose = () => finish(defaultResult, false);
    const onKeyDown = event => {
      if (event.key === 'Escape') {
        event.preventDefault();
        finish(defaultResult);
        return;
      }
      if (event.key !== 'Tab') return;
      const buttons = [...dialog.querySelectorAll('button:not([disabled])')];
      if (!buttons.length) return;
      const first = buttons[0];
      const last = buttons[buttons.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    dialog.addEventListener('click', onClick);
    dialog.addEventListener('cancel', onCancel);
    dialog.addEventListener('close', onClose);
    dialog.addEventListener('keydown', onKeyDown);
    if (supportsNativeDialog) dialog.showModal();
    else {
      dialog.setAttribute('open', '');
      dialog.classList.add('dialog-fallback-open');
    }
    dialog.querySelector('button:not([disabled])')?.focus();
  });
}

function requestDirtySwitchDecision() {
  return promptDialog(els.dirtySwitchDialog, 'cancel');
}

// ========== Close Guard ==========
// 退出应用时的未保存保护。Tauri 的关闭事件必须 preventDefault() 拦下，
// 等用户决策后再真正 close——直接放行就来不及问了。
const closeGuard = createCloseGuard({
  getState: () => ({
    isDirty: state.isDirty,
    isReadOnly: state.readOnly,
    hasDocument: documentSession.isOpen(),
  }),
  showDialog: () => promptDialog(els.closeAppDialog, 'cancel'),
  saveFile,
  performClose: async () => {
    const windowApi = await getTauriWindow();
    await windowApi.getCurrentWindow().destroy();
  },
  onSaveError: () => showToast(ERROR_MESSAGES.save_failed, 'error'),
});

/**
 * 注册关闭拦截。仅原生端需要——浏览器预览的 `beforeunload` 由浏览器
 * 自己画框，文案不可控，作为兜底即可。
 */
async function initCloseGuard() {
  if (!tauriAvailable) return;
  try {
    const windowApi = await getTauriWindow();
    const current = windowApi.getCurrentWindow();
    await current.onCloseRequested(async event => {
      if (closeGuard.isClosing()) return;
      const { action } = await closeGuard.handleRequest();
      // 已确认关闭或正在关闭流程中：放行。
      if (action === 'allow') return;
      event.preventDefault();
    });
  } catch (error) {
    console.warn('Close guard unavailable:', error?.message || error);
  }
}

function confirmLargeLog(inspection) {
  const name = inspection.path.split(/[/\\]/).pop() || inspection.path;
  els.largeLogFileName.textContent = name;
  els.largeLogFileSize.textContent = formatMiB(inspection.sizeBytes);
  return promptDialog(els.largeLogDialog, 'cancel').then(result => result === 'continue');
}

function browserInspection(file) {
  const type = classifyDocumentPath(file.name);
  if (type.kind === 'unsupported') throw createClientError('unsupported_type');
  return {
    path: file.name,
    kind: type.kind,
    renderMode: type.renderMode,
    readOnly: !type.editable,
    sizeBytes: file.size,
    requiresLargeFileConfirmation:
      type.warnWhenLarge && file.size >= LARGE_LOG_WARNING_BYTES,
  };
}

async function readBrowserDocument(file, allowLargeLog) {
  const inspection = browserInspection(file);
  if (inspection.requiresLargeFileConfirmation && !allowLargeLog) {
    throw createClientError('large_log_confirmation_required');
  }
  const decoded = await readBrowserTextFile(file);
  return {
    ...inspection,
    ...decoded,
  };
}

function copyCode(btn) {
  const code = btn.nextElementSibling;
  navigator.clipboard.writeText(code.textContent).then(() => {
    btn.textContent = '已复制 ✓';
    setTimeout(() => btn.textContent = '复制', 1500);
  });
}

// ========== File Library ==========
async function loadLibraryFiles() {
  if (!tauriAvailable) return;
  try {
    state.libraryFiles = validateLibraryPaths(await tauriInvoke('get_library_files'));
    state.libraryError = '';
  } catch (error) {
    state.libraryError = describeAppError(error, '文件目录加载失败');
  }
  renderLibrarySidebar();
  renderWelcome();
}

function renderLibrarySidebar() {
  els.libraryError.classList.toggle('hidden', !state.libraryError);
  els.libraryErrorText.textContent = state.libraryError;
  try {
    fileLibraryView.render(state.libraryFiles, state.filePath);
  } catch (error) {
    state.libraryError = error?.message || String(error);
    els.libraryError.classList.remove('hidden');
    els.libraryErrorText.textContent = state.libraryError;
  }
}

async function registerOpenedDocument(path) {
  if (!tauriAvailable) return;
  try {
    state.libraryFiles = await tauriInvoke('register_library_file', { path });
    state.libraryError = '';
    renderLibrarySidebar();
  } catch (error) {
    showToast(describeAppError(error, '文件目录登记失败'), 'info');
  }
}

async function removeLibraryFile(path) {
  if (!tauriAvailable) return;
  try {
    state.libraryFiles = await tauriInvoke('remove_library_file', { path });
    state.libraryError = '';
  } catch (error) {
    showToast(describeAppError(error, '移出文件目录失败'));
    return;
  }
  renderLibrarySidebar();
  renderWelcome();
}

async function openLibraryFile(path) {
  if (documentInteractionLocked()) {
    showToast('文档操作正在进行，请稍候', 'info');
    return false;
  }
  const opened = await openFileByPath(path);
  if (!opened && tauriAvailable) {
    try {
      const status = await tauriInvoke('document_path_status', { path });
      if (status === 'missing') {
        showToast('文件已不存在，已从文件目录移除', 'info');
        await removeLibraryFile(path);
      }
    } catch {
      // 无法确认状态时保留记录，不自动清理。
    }
  }
  return opened;
}

async function confirmTrashDialog(message) {
  if (tauriAvailable) {
    try {
      const dialog = await getTauriDialog();
      if (typeof dialog.confirm === 'function') {
        return await dialog.confirm(message, { title: '移到回收站', kind: 'warning' });
      }
    } catch (error) {
      console.warn('Tauri confirm dialog failed:', error?.message || error);
    }
  }
  return window.confirm(message);
}

async function trashLibraryFile(path) {
  if (documentInteractionLocked()) {
    showToast('文档操作正在进行，请稍候', 'info');
    return;
  }
  try {
    const result = await requestTrash({
      path,
      currentPath: state.filePath,
      isDirty: state.isDirty,
      platform: state.platform,
      confirmTrash: confirmTrashDialog,
      trashFile: async target => tauriInvoke('trash_library_file', { path: target }),
    });
    if (result.status === 'cancelled') return;
    const applied = await applyTrashedOutcome(result.outcome, outcome =>
      applyTrashedUi(path, outcome),
    );
    if (applied.status === 'ui_failed') {
      showToast('原文件已移到回收站，但界面刷新失败');
      await loadLibraryFiles();
    }
  } catch (error) {
    showToast(describeAppError(error, '移到回收站失败'));
  }
}

function applyTrashedUi(path, outcome) {
  state.libraryFiles = Array.isArray(outcome.files) ? outcome.files : [];
  renderLibrarySidebar();
  if (state.filePath && samePath(state.filePath, path, state.platform)) {
    returnToWelcome();
  }
  renderWelcome();
  if (outcome.cleanupWarning) {
    showToast(outcome.cleanupWarning, 'info');
  }
}

function returnToWelcome() {
  // 经会话归口：代次随之递增，使在途的保存/监听回调全部失效。
  documentSession.close();
  syncDocumentStateFromSession();
  if (state.activeSidePanel === 'toc') state.activeSidePanel = 'none';
  clearSearch();
  setFileEncoding('UTF-8');
  els.editorTextarea.value = '';
  applyModeVisibility();
  applyDocumentControls();
  setDocumentIdentity(null);
  els.readerView.scrollTop = 0;
  els.editorPreview.scrollTop = 0;
  renderSidePanels();
  renderWelcome();
}

function renderWelcome() {
  if (state.filePath) return;

  const recentHtml = state.libraryFiles.length > 0
    ? `<div class="welcome-recent">
        <div class="welcome-recent-title">最近打开</div>
        ${welcomePaths(state.libraryFiles).map(path => {
          const name = path.split(/[/\\]/).pop();
          return `<button type="button" class="recent-item" data-path="${escapeHtml(path)}">
            <div class="recent-item-name">${escapeHtml(name)}</div>
            <div class="recent-item-path">${escapeHtml(path)}</div>
          </button>`;
        }).join('')}
      </div>`
    : '';

  els.markdownBody.innerHTML = `
    <div class="welcome">
      <div class="welcome-icon">📖</div>
      <h1>MD Reader</h1>
      <p>轻量级 Markdown 阅读器</p>
      <p class="hint">拖拽 Markdown、TXT、TeX 或 LOG 文件到此处，或点击打开</p>
      <p class="shortcut-hint">Ctrl+O 打开 · Ctrl+S 保存 · Ctrl+F 搜索 · Ctrl+\\ 目录</p>
    </div>
    ${recentHtml}
  `;

  els.markdownBody.querySelectorAll('.recent-item').forEach(btn => {
    btn.addEventListener('click', () => openFileByPath(btn.dataset.path));
  });
}

// ========== External Change ==========
const externalChangeWatcher = createExternalChangeWatcher({
  // 走 getTauriInvoke() 而非直接引用 `tauriInvoke`：后者在模块顶层求值时
  // 还是 null，且 Tauri 的 invoke 可能依赖 this 绑定。
  invoke: async (command, payload) => {
    const invoke = await getTauriInvoke();
    return invoke(command, payload);
  },
  listen: async () => () => {},
  getDocumentState: () => state,
  onNotify: onExternalChangeDetected,
  reload: () => reloadAfterExternalChange(),
});

/**
 * 外部改动的呈现分两层，各司其职：
 *
 * 1. **右下角弹窗** —— 首次感知就该看见，附带「重载 / 忽略」两个决策。
 *    弹窗可关闭：它是一次性提示，不是常驻控件。
 * 2. **状态栏常驻小提示** —— 弹窗关掉后仍留在状态栏，带重载入口，
 *    直到重载或换文档才消失。外部改动在磁盘上持续存在，提示也该持续存在。
 */
function onExternalChangeDetected({ hasDraft, readOnly }) {
  const message = hasDraft
    ? '文件已被外部修改'
    : readOnly
      ? '日志已被外部修改'
      : '文件已被外部修改';
  const detail = hasDraft
    ? '当前草稿尚未保存，重载前会先让你决定如何处理'
    : '磁盘上的内容与当前显示不一致';

  showActionToast({
    message,
    detail,
    actionLabel: '重载',
    onAction: () => reloadAfterExternalChange(),
  });
  showExternalChangeNotice({ hasDraft, readOnly });
}

function showExternalChangeNotice({ hasDraft, readOnly }) {
  if (!els.externalChangeNotice) return;
  const text = els.externalChangeNotice.querySelector('.external-change-text');
  if (text) {
    text.textContent = hasDraft
      ? '文件已被外部修改，草稿未保存'
      : readOnly
        ? '日志已被外部修改'
        : '文件已被外部修改';
  }
  els.externalChangeNotice.classList.remove('hidden');
}

function hideExternalChangeNotice() {
  hideActionToast();
  els.externalChangeNotice?.classList.add('hidden');
}

/**
 * 重载当前文档。有未保存草稿时必须走既有切换保护，不静默覆盖。
 */
async function reloadAfterExternalChange() {
  if (!state.filePath || state.documentSwitchPending) return;
  const path = state.filePath;
  const generationAtStart = state.documentGeneration;

  if (state.isDirty) {
    const proceed = await guardDirtyDocumentSwitch({
      isDirty: true,
      decide: requestDirtySwitchDecision,
      save: saveFile,
    });
    if (!proceed) return;
    if (state.documentGeneration !== generationAtStart) return;
  }

  hideExternalChangeNotice();
  await openFileByPath(path);
}

// ========== Render ==========
function renderContent(content, renderMode = state.renderMode) {
  return renderDocumentHtml(md, content, renderMode);
}

/**
 * 文档内相对路径图片的放行集合。
 *
 * 白名单必须在 HTML 写入正文状态**之前**完成：首帧 `<img>` 请求与白名单
 * 写入存在竞态，首帧失败不会自动重试。浏览器预览与纯文本模式没有资产
 * 协议需求，直接返回空集合。
 */
async function authorizeAssetsFor(html) {
  if (!state.filePath || !state.nativeFile || state.renderMode !== 'markdown') return [];
  const references = collectRelativeImageReferences(html);
  if (references.length === 0) return [];

  try {
    return await tauriInvoke('authorize_document_assets_command', {
      documentPath: state.filePath,
      references,
    });
  } catch (error) {
    // 放行失败不阻断阅读：图片保持原引用，交给浏览器处理。
    console.warn('Local asset authorization failed:', error);
    return [];
  }
}

async function updateView(content) {
  const html = renderContent(content);
  const allowed = await authorizeAssetsFor(html);
  documentSession.setAllowedAssets(allowed);
  state.allowedAssets = documentSession.snapshot().allowedAssets;

  els.markdownBody.innerHTML = html;
  if (allowed.length > 0) {
    rewriteImageSources(els.markdownBody, allowed, state.filePath);
  }

  els.previewBody.innerHTML = state.readOnly ? '' : html;
  if (allowed.length > 0 && !state.readOnly) {
    rewriteImageSources(els.previewBody, allowed, state.filePath);
  }

  if (state.readOnly) els.editorTextarea.value = '';
  els.tocContent.innerHTML = buildTOC();
  updateStatusInfo(content);
  observeHeadings();
}

function getReaderContext() {
  if (state.isEditMode) {
    return {
      scrollRoot: els.editorView.querySelector('.editor-preview'),
      markdownBody: els.previewBody,
    };
  }
  return { scrollRoot: els.readerView, markdownBody: els.markdownBody };
}

function buildTOC() {
  if (!state.toc) return '';
  const { markdownBody } = getReaderContext();
  const headings = markdownBody.querySelectorAll('h1[id], h2[id], h3[id], h4[id]');
  if (headings.length < 2) return '';

  return [...headings].map(h => {
    const level = h.tagName.charAt(1);
    const slug = h.id;
    return `<a class="toc-h${level}" href="#${slug}" data-slug="${slug}">${escapeHtml(h.textContent)}</a>`;
  }).join('\n');
}

function refreshTOC() {
  els.tocContent.innerHTML = buildTOC();
  observeHeadings();
}

function setFileEncoding(encoding) {
  // 经会话归口。刻意用 setEncoding 而非 open()——代次只在换/关文档时
  // 推进，编码更新不得让在途的保存、滚动与监听回调误判为过期。
  documentSession.setEncoding(encoding);
  state.encoding = documentSession.snapshot().encoding;
  if (els.statusEncoding) {
    if (!state.filePath) {
      els.statusEncoding.textContent = state.encoding;
      return;
    }
    const readOnlyLabel = state.readOnly ? ' · 只读' : '';
    els.statusEncoding.textContent = `${getDocumentFormatLabel(state.filePath)} · ${state.encoding}${readOnlyLabel}`;
  }
}

function updateStatusInfo(content) {
  const chars = content.length;
  const lines = content.split('\n').length;
  els.statusInfo.textContent = `${lines} 行 · ${chars} 字`;
}

// ========== Heading Scroll Spy ==========
const SCROLL_SPY_OFFSET = 96;
let scrollSpyHandler = null;
let scrollSpyRoot = null;

function updateActiveHeading() {
  const { scrollRoot, markdownBody } = getReaderContext();
  if (!scrollRoot || !markdownBody) return;

  const headings = [...markdownBody.querySelectorAll('h1[id], h2[id], h3[id], h4[id]')];
  if (!headings.length) return;

  const rootRect = scrollRoot.getBoundingClientRect();
  let active = headings[0];

  for (const h of headings) {
    if (h.getBoundingClientRect().top - rootRect.top <= SCROLL_SPY_OFFSET) {
      active = h;
    } else {
      break;
    }
  }

  const atBottom = scrollRoot.scrollTop + scrollRoot.clientHeight >= scrollRoot.scrollHeight - 4;
  if (atBottom) active = headings[headings.length - 1];

  els.tocContent.querySelectorAll('a').forEach(a => {
    a.classList.toggle('active', a.dataset.slug === active.id);
  });
}

function observeHeadings() {
  if (scrollSpyHandler && scrollSpyRoot) {
    scrollSpyRoot.removeEventListener('scroll', scrollSpyHandler);
  }

  const { scrollRoot } = getReaderContext();
  if (!scrollRoot) return;

  scrollSpyRoot = scrollRoot;
  scrollSpyHandler = () => requestAnimationFrame(updateActiveHeading);
  scrollRoot.addEventListener('scroll', scrollSpyHandler, { passive: true });
  updateActiveHeading();
}

// ========== File Operations ==========
const serializeDocumentMutation = createSerialTaskQueue();

function documentInteractionLocked() {
  return state.documentSwitchPending || state.savePending || state.fileSelectionPending;
}

function setDocumentIdentity(path, dirty = false) {
  const name = path?.split(/[/\\]/).pop() || 'MD Reader';
  els.fileName.textContent = `${name}${dirty ? ' ●' : ''}`;
  els.fileName.classList.toggle('has-file', Boolean(path));
  document.title = path ? `${name} — MD Reader` : 'MD Reader';
}

function applyModeVisibility() {
  els.readerView.classList.toggle('hidden', state.isEditMode);
  els.editorView.classList.toggle('hidden', !state.isEditMode);
  els.statusMode.textContent = state.isEditMode ? '编辑' : '阅读';
  // 按钮激活态：与搜索/侧栏/铺满按钮一致。放在这个统一切换点，
  // 切文档、只读回退、按钮点击三条路径都会同步。
  els.btnMode.classList.toggle('active', state.isEditMode);
  els.btnMode.setAttribute('aria-pressed', state.isEditMode ? 'true' : 'false');
}

function applyDocumentControls() {
  const viewState = createDocumentViewState({
    content: state.rawContent,
    readOnly: state.readOnly,
    toc: state.toc,
  });
  const controlsLocked = state.documentSwitchPending || state.savePending;
  els.btnOpen.disabled = controlsLocked || state.fileSelectionPending;
  els.btnMode.disabled = viewState.editorDisabled || controlsLocked;
  els.btnSave.disabled = viewState.saveDisabled || controlsLocked;
  els.btnToc.disabled = viewState.tocDisabled || controlsLocked;
  els.editorTextarea.disabled = viewState.editorDisabled || state.documentSwitchPending;
  els.main.setAttribute('aria-busy', String(controlsLocked));
  if (viewState.tocDisabled && state.activeSidePanel === 'toc') {
    state.activeSidePanel = 'none';
  }
  renderSidePanels();

  els.btnMode.title = state.readOnly
    ? 'LOG 文件以只读模式打开'
    : '切换编辑/阅读 (Ctrl+E)';
  els.btnSave.title = state.readOnly
    ? 'LOG 文件以只读模式打开'
    : '保存 (Ctrl+S)';
  els.btnToc.title = state.toc
    ? '目录 (Ctrl+\\)'
    : '纯文本文档不提供目录';
  els.btnMode.setAttribute('aria-label', els.btnMode.title);
  els.btnSave.setAttribute('aria-label', els.btnSave.title);
  els.btnToc.setAttribute('aria-label', els.btnToc.title);
}

async function applyOpenedDocument(documentData, { nativeFile }) {
  const type = classifyDocumentPath(documentData.path);
  if (type.kind === 'unsupported') throw createClientError('unsupported_type');
  if (
    (documentData.kind && documentData.kind !== type.kind)
    || (documentData.renderMode && documentData.renderMode !== type.renderMode)
    || (typeof documentData.readOnly === 'boolean' && documentData.readOnly !== !type.editable)
  ) {
    throw createClientError('policy_invalid', '前后端文档类型能力不一致');
  }

  if (previewFrame !== null) cancelAnimationFrame(previewFrame);
  previewFrame = null;
  clearTimeout(state.scrollSaveTimer);

  // 文档级字段经会话对象归口：这是 3a 的接入点。当前仍是单文档，
  // 会话与扁平 state 一一对应；3b 引入多标签后，每次切换活动标签只需
  // 换绑一个会话实例，字段赋值点无需改动。
  documentSession.open(
    {
      path: documentData.path,
      content: documentData.content ?? '',
      kind: documentData.kind || type.kind,
      renderMode: documentData.renderMode || type.renderMode,
      readOnly: documentData.readOnly ?? !type.editable,
      toc: type.toc,
      sizeBytes: Number(documentData.sizeBytes) || 0,
      encoding: documentData.encoding,
    },
    { nativeFile },
  );
  syncDocumentStateFromSession();

  clearSearch();
  applyModeVisibility();
  els.editorTextarea.value = state.readOnly ? '' : state.rawContent;
  applyDocumentControls();
  await updateView(state.rawContent);
  setFileEncoding(documentData.encoding);

  setDocumentIdentity(documentData.path);
  els.readerView.scrollTop = 0;
  els.editorTextarea.scrollTop = 0;
  els.editorPreview.scrollTop = 0;
  if (els.progressBar) els.progressBar.style.width = '0%';

  // 新文档就绪后重建监听目标，并清掉上一份文档可能残留的提示。
  hideExternalChangeNotice();
  void externalChangeWatcher.start();
}

async function performDocumentOpen({
  path,
  inspectDocument,
  readDocument,
  refreshLibraryFiles,
  nativeFile,
}) {
  const focusBeforeSwitch = document.activeElement;
  let opened = false;
  state.documentSwitchPending = true;
  applyDocumentControls();
  try {
    const result = await openDocumentWithGuards({
      path,
      inspectDocument,
      confirmLargeLog,
      isDirty: () => state.isDirty,
      decideDirtySwitch: requestDirtySwitchDecision,
      saveCurrentDocument: () => performSaveFile({ allowDuringSwitch: true }),
      readDocument,
    });
    if (result.status !== 'opened') return false;

    if (state.filePath) await saveProgress();
    await applyOpenedDocument(result.document, { nativeFile });
    if (refreshLibraryFiles && nativeFile) {
      await registerOpenedDocument(result.document.path);
    }
    await loadProgress();
    opened = true;
    return true;
  } catch (error) {
    console.error('Open document failed:', error);
    showToast(describeAppError(error, '打开文件失败'));
    return false;
  } finally {
    state.documentSwitchPending = false;
    applyDocumentControls();
    if (
      !opened
      && focusBeforeSwitch instanceof HTMLElement
      && focusBeforeSwitch.isConnected
      && !focusBeforeSwitch.hasAttribute('disabled')
    ) {
      requestAnimationFrame(() => focusBeforeSwitch.focus());
    }
  }
}

function openFileByPath(path) {
  if (!path || !tauriAvailable) return Promise.resolve(false);
  return serializeDocumentMutation(() => performDocumentOpen({
    path,
    inspectDocument: targetPath => tauriInvoke('inspect_document', { path: targetPath }),
    readDocument: (targetPath, allowLargeLog) => tauriInvoke('read_file', {
      path: targetPath,
      allowLargeLog,
    }),
    refreshLibraryFiles: true,
    nativeFile: true,
  }));
}

function openBrowserFile(file) {
  return serializeDocumentMutation(() => performDocumentOpen({
    path: file.name,
    inspectDocument: async () => browserInspection(file),
    readDocument: async (_path, allowLargeLog) => readBrowserDocument(file, allowLargeLog),
    refreshLibraryFiles: false,
    nativeFile: false,
  }));
}

async function openFile() {
  if (documentInteractionLocked()) {
    showToast('文档操作正在进行，请稍候', 'info');
    return false;
  }
  state.fileSelectionPending = true;
  applyDocumentControls();
  try {
    if (tauriAvailable) {
      const path = await selectTauriFile();
      return path ? await openFileByPath(path) : false;
    }
    const file = await selectBrowserFile();
    return file ? await openBrowserFile(file) : false;
  } catch (error) {
    console.error('Select file failed:', error);
    showToast(describeAppError(error, '打开文件失败'));
    return false;
  } finally {
    state.fileSelectionPending = false;
    applyDocumentControls();
  }
}

async function performSaveFile({ allowDuringSwitch = false } = {}) {
  if (state.documentSwitchPending && !allowDuringSwitch) return false;
  if (state.readOnly) {
    showToast(ERROR_MESSAGES.readonly_file, 'info');
    return false;
  }
  const content = state.isEditMode ? els.editorTextarea.value : state.rawContent;
  const generationAtStart = state.documentGeneration;
  const revisionAtStart = state.editRevision;
  state.savePending = true;
  applyDocumentControls();
  try {
    const savedPath = await tauriSaveFile(state.filePath, content, state.nativeFile);
    if (!savedPath) return false;
    const type = classifyDocumentPath(savedPath);
    if (!type.editable) throw createClientError('unsupported_type');
    if (state.documentGeneration !== generationAtStart) return true;

    const currentEditorContent = state.isEditMode
      ? els.editorTextarea.value
      : state.rawContent;

    // 归并经会话：保留保存请求发出后继续输入的内容，既有语义不变。
    documentSession.reconcileSave({
      savedContent: content,
      currentContent: currentEditorContent,
    });

    state.filePath = savedPath;
    state.nativeFile = tauriAvailable;
    state.kind = type.kind;
    state.renderMode = type.renderMode;
    state.readOnly = false;
    state.toc = type.toc;
    state.sizeBytes = new TextEncoder().encode(content).byteLength;
    syncDocumentStateFromSession();
    const savedState = {
      isDirty: documentSession.snapshot().isDirty,
      previewContent: documentSession.snapshot().rawContent,
    };
    applyDocumentControls();
    // 保存会触发文件系统事件；登记抑制窗口，避免保存后立刻弹出
    // 「文件已被外部修改」的假提示。
    void externalChangeWatcher.registerSelfSave();
    hideExternalChangeNotice();
    if (savedState.isDirty) {
      els.previewBody.innerHTML = renderContent(savedState.previewContent);
      if (state.filePath) {
        rewriteImageSources(els.previewBody, state.allowedAssets, state.filePath);
      }
      refreshTOC();
      updateStatusInfo(savedState.previewContent);
    } else {
      if (previewFrame !== null) cancelAnimationFrame(previewFrame);
      previewFrame = null;
      await updateView(savedState.previewContent);
    }
    setFileEncoding('UTF-8');
    setDocumentIdentity(savedPath, savedState.isDirty);
    return true;
  } catch (error) {
    console.error('Save file failed:', error);
    showToast(describeAppError(error, '保存文件失败'));
    return false;
  } finally {
    state.savePending = false;
    applyDocumentControls();
  }
}

function saveFile() {
  if (documentInteractionLocked()) {
    showToast('文档操作正在进行，请稍候', 'info');
    return Promise.resolve(false);
  }
  return serializeDocumentMutation(() => performSaveFile());
}

// ========== Mode Toggle ==========
async function toggleEditMode() {
  if (documentInteractionLocked()) {
    showToast('文档操作正在进行，请稍候', 'info');
    return;
  }
  if (state.readOnly) {
    showToast(ERROR_MESSAGES.readonly_file, 'info');
    return;
  }
  state.isEditMode = !state.isEditMode;

  if (state.isEditMode) {
    els.editorTextarea.value = state.rawContent;
    els.previewBody.innerHTML = renderContent(state.rawContent);
    if (state.filePath) {
      rewriteImageSources(els.previewBody, state.allowedAssets, state.filePath);
    }
    refreshTOC();
    applyModeVisibility();
    els.editorTextarea.focus();
  } else {
    if (previewFrame !== null) cancelAnimationFrame(previewFrame);
    previewFrame = null;
    state.rawContent = els.editorTextarea.value;
    applyModeVisibility();
    await updateView(state.rawContent);
  }
}

// ========== Theme ==========
function applyTheme(theme) {
  state.theme = theme;
  if (theme === 'light') {
    document.documentElement.removeAttribute('data-theme');
  } else {
    document.documentElement.setAttribute('data-theme', theme);
  }
  preferences.set({ theme });
  document.documentElement.style.colorScheme = getNativeWindowTheme(theme);
  void syncNativeWindowTheme(theme);

  // Update theme icon (light / dark / sepia)
  els.themeIconSun.classList.toggle('hidden', theme !== 'light');
  els.themeIconMoon.classList.toggle('hidden', theme !== 'dark');
  els.themeIconSepia.classList.toggle('hidden', theme !== 'sepia');
  els.btnTheme.title = `切换主题（当前：${themeLabels[theme]}）`;

  // Switch highlight.js theme
  const hljsLink = document.getElementById('hljs-theme');
  hljsLink.href = theme === 'dark' ? '/styles/github-dark.min.css' : '/styles/github.min.css';
}

function cycleTheme() {
  const idx = themes.indexOf(state.theme);
  const next = themes[(idx + 1) % themes.length];
  applyTheme(next);
}

function loadTheme() {
  applyTheme(preferences.load().theme);
}

// ========== Font Size ==========
function applyFontSize(fontSize) {
  state.fontSize = fontSize;
  document.documentElement.style.setProperty('--font-size', fontSize + 'px');
}

function changeFontSize(delta) {
  const next = preferences.set({ fontSize: state.fontSize + delta });
  applyFontSize(next.fontSize);
}

function loadFontSize() {
  const { fontSize } = preferences.load();
  if (fontSize !== DEFAULT_PREFERENCES.fontSize) {
    applyFontSize(fontSize);
  }
}

// ========== Full Width ==========
function applyFullWidth(fullWidth) {
  state.fullWidth = fullWidth;
  document.documentElement.classList.toggle('full-width', fullWidth);
  if (els.btnFullWidth) {
    els.btnFullWidth.classList.toggle('active', fullWidth);
    const label = fullWidth ? '退出铺满' : '铺满宽度';
    els.btnFullWidth.title = `${label} (Ctrl+Shift+F)`;
    els.btnFullWidth.setAttribute('aria-label', label);
  }
}

function toggleFullWidth() {
  applyFullWidth(!state.fullWidth);
  preferences.set({ fullWidth: state.fullWidth });
}

function loadFullWidth() {
  applyFullWidth(preferences.load().fullWidth);
}

// ========== Side Panels ==========
function renderSidePanels() {
  const panel = state.activeSidePanel;
  els.libraryPanel.classList.toggle('hidden', panel !== 'library');
  els.tocPanel.classList.toggle('hidden', panel !== 'toc');
  els.btnLibrary.classList.toggle('active', panel === 'library');
  els.btnToc.classList.toggle('active', panel === 'toc');
  els.btnLibrary.setAttribute('aria-expanded', panel === 'library' ? 'true' : 'false');
  els.btnToc.setAttribute('aria-expanded', panel === 'toc' ? 'true' : 'false');
}

function toggleLibrary() {
  if (documentInteractionLocked()) {
    showToast('文档操作正在进行，请稍候', 'info');
    return;
  }
  state.activeSidePanel = nextSidePanel(state.activeSidePanel, 'library');
  renderSidePanels();
}

function toggleTOC() {
  if (documentInteractionLocked()) {
    showToast('文档操作正在进行，请稍候', 'info');
    return;
  }
  if (!state.toc) {
    showToast('纯文本文档不提供目录', 'info');
    return;
  }
  state.activeSidePanel = nextSidePanel(state.activeSidePanel, 'toc');
  renderSidePanels();
}

els.tocContent.addEventListener('click', e => {
  const link = e.target.closest('a');
  if (!link) return;
  e.preventDefault();
  const slug = link.dataset.slug;
  const { scrollRoot, markdownBody } = getReaderContext();
  const target = markdownBody.querySelector(`#${CSS.escape(slug)}`);
  if (target && scrollRoot) {
    const rootRect = scrollRoot.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    scrollRoot.scrollTo({
      top: scrollRoot.scrollTop + targetRect.top - rootRect.top - SCROLL_SPY_OFFSET,
      behavior: 'smooth',
    });
    els.tocContent.querySelectorAll('a').forEach(a => a.classList.remove('active'));
    link.classList.add('active');
  }
});

// ========== Search ==========
function toggleSearch() {
  state.searchVisible = !state.searchVisible;
  els.searchBar.classList.toggle('hidden', !state.searchVisible);
  // 按钮激活态：与侧栏/铺满按钮一致，让「当前处于搜索模式」可见。
  els.btnSearch.classList.toggle('active', state.searchVisible);
  els.btnSearch.setAttribute('aria-pressed', state.searchVisible ? 'true' : 'false');
  if (state.searchVisible) {
    els.searchInput.focus();
    els.searchInput.select();
  } else {
    clearSearch();
  }
}

function clearSearch() {
  state.searchResults = [];
  state.searchIndex = -1;
  els.searchCount.textContent = '';
  [els.markdownBody, els.previewBody].forEach(body => {
    body.querySelectorAll('.search-highlight, .search-current').forEach(el => {
      const parent = el.parentNode;
      parent.replaceChild(document.createTextNode(el.textContent), el);
      parent.normalize();
    });
  });
}

function doSearch(query) {
  clearSearch();
  if (!query) return;

  const { markdownBody: body } = getReaderContext();
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  const textNodes = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode);

  const lowerQuery = query.toLowerCase();
  const matches = [];

  for (const node of textNodes) {
    const text = node.textContent;
    const lower = text.toLowerCase();
    let start = 0;
    let idx;

    while ((idx = lower.indexOf(lowerQuery, start)) !== -1) {
      matches.push({ node, start: idx, length: query.length });
      start = idx + query.length;
    }
  }

  const byNode = new Map();
  for (const match of matches) {
    if (!byNode.has(match.node)) byNode.set(match.node, []);
    byNode.get(match.node).push(match);
  }

  const results = [];
  for (const [node, nodeMatches] of byNode) {
    nodeMatches.sort((a, b) => b.start - a.start);
    for (const match of nodeMatches) {
      const text = node.textContent;
      const range = document.createRange();
      range.setStart(node, match.start);
      range.setEnd(node, match.start + match.length);

      const span = document.createElement('span');
      span.className = 'search-highlight';
      span.textContent = text.slice(match.start, match.start + match.length);
      range.deleteContents();
      range.insertNode(span);
      results.unshift(span);
    }
  }

  state.searchResults = results;
  if (results.length > 0) {
    state.searchIndex = 0;
    results[0].classList.remove('search-highlight');
    results[0].classList.add('search-current');
    results[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  els.searchCount.textContent = results.length > 0 ? `1 / ${results.length}` : '无结果';
}

function searchNext() {
  if (state.searchResults.length === 0) return;
  state.searchResults[state.searchIndex]?.classList.replace('search-current', 'search-highlight');
  state.searchIndex = (state.searchIndex + 1) % state.searchResults.length;
  const current = state.searchResults[state.searchIndex];
  current.classList.replace('search-highlight', 'search-current');
  current.scrollIntoView({ behavior: 'smooth', block: 'center' });
  els.searchCount.textContent = `${state.searchIndex + 1} / ${state.searchResults.length}`;
}

function searchPrev() {
  if (state.searchResults.length === 0) return;
  state.searchResults[state.searchIndex]?.classList.replace('search-current', 'search-highlight');
  state.searchIndex = (state.searchIndex - 1 + state.searchResults.length) % state.searchResults.length;
  const current = state.searchResults[state.searchIndex];
  current.classList.replace('search-highlight', 'search-current');
  current.scrollIntoView({ behavior: 'smooth', block: 'center' });
  els.searchCount.textContent = `${state.searchIndex + 1} / ${state.searchResults.length}`;
}

// ========== Editor ==========
els.editorTextarea.addEventListener('keydown', e => {
  if (state.readOnly || state.documentSwitchPending) return;
  if (e.key === 'Tab') {
    e.preventDefault();
    const start = e.target.selectionStart;
    const end = e.target.selectionEnd;
    e.target.value = e.target.value.substring(0, start) + '    ' + e.target.value.substring(end);
    e.target.selectionStart = e.target.selectionEnd = start + 4;
    e.target.dispatchEvent(new Event('input', { bubbles: true }));
  }
});

let previewFrame = null;
function onEditorChanged() {
  if (state.readOnly || state.documentSwitchPending) return;
  // 修订号经会话推进：`isEditorSnapshotCurrent` 是闭包内自比对，若只改
  // 扁平 state 而不同步会话，守卫会读到会话里过期的修订号，预览永不刷新。
  documentSession.markEdited(els.editorTextarea.value);
  syncDocumentStateFromSession();
  setDocumentIdentity(state.filePath, state.isDirty);

  // rAF 合帧而非 150ms 防抖：预览随编辑实时更新，不必等保存也不必等
  // 固定延迟。rAF 天然把同一帧内的多次输入合并成一次渲染。
  if (previewFrame !== null) cancelAnimationFrame(previewFrame);
  previewFrame = requestAnimationFrame(() => {
    previewFrame = null;
    if (!state.isEditMode || state.readOnly) return;
    const content = els.editorTextarea.value;
    renderPreviewPane(content);
  });
}

/**
 * 重写预览区并保持滚动位置。
 *
 * `innerHTML` 赋值会把 scrollTop 归零，导致编辑器的滚动同步映射失效、
 * 预览「跳回顶部」。渲染前记录比例，渲染后按比例还原——文档变长变短
 * 都保持视觉位置稳定。
 */
function renderPreviewPane(content) {
  const preview = els.editorPreview;
  const hadScroll = preview.scrollHeight > preview.clientHeight;
  const ratio = hadScroll && preview.scrollHeight > 0
    ? preview.scrollTop / (preview.scrollHeight - preview.clientHeight)
    : 0;

  els.previewBody.innerHTML = renderContent(content);
  // 白名单已在打开文档或切换模式时建立，这里复用同一放行集合。
  if (state.filePath) {
    rewriteImageSources(els.previewBody, state.allowedAssets, state.filePath);
  }

  if (hadScroll) {
    preview.scrollTop = ratio * (preview.scrollHeight - preview.clientHeight);
  }

  refreshTOC();
  updateStatusInfo(content);
}

els.editorTextarea.addEventListener('input', onEditorChanged);

// ========== Toast ==========
function showToast(message, type = 'error') {
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
  toast.setAttribute('aria-live', type === 'error' ? 'assertive' : 'polite');
  document.body.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('show'));
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 300);
  }, 4500);
}

/**
 * 带操作按钮的右下角浮层。外部修改提示用它——状态栏文字太弱，
 * 而这是一个需要用户决策的事件（是否重载）。
 *
 * 不自动消失：事件在磁盘改动持续存在期间一直有效，用户的编辑可能更久。
 * 关闭由用户显式操作，或在文档切换/保存后由调用方撤下。
 */
function showActionToast({ message, detail = '', actionLabel, onAction }) {
  document.getElementById('external-change-toast')?.remove();

  const toast = document.createElement('div');
  toast.id = 'external-change-toast';
  toast.className = 'toast toast-action';
  toast.setAttribute('role', 'alertdialog');
  toast.setAttribute('aria-live', 'assertive');
  toast.setAttribute('aria-label', message);

  const text = document.createElement('div');
  text.className = 'toast-action-text';
  text.textContent = message;
  toast.appendChild(text);

  if (detail) {
    const hint = document.createElement('div');
    hint.className = 'toast-action-detail';
    hint.textContent = detail;
    toast.appendChild(hint);
  }

  const actions = document.createElement('div');
  actions.className = 'toast-action-buttons';

  const action = document.createElement('button');
  action.type = 'button';
  action.className = 'toast-action-primary';
  action.textContent = actionLabel;
  action.addEventListener('click', () => {
    hideActionToast();
    onAction?.();
  });
  actions.appendChild(action);

  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'toast-action-secondary';
  dismiss.textContent = '忽略';
  dismiss.setAttribute('aria-label', '忽略此提示');
  dismiss.addEventListener('click', hideActionToast);
  actions.appendChild(dismiss);

  toast.appendChild(actions);
  document.body.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('show'));
  // 首个可聚焦元素即主操作，键盘用户可直接回车。
  action.focus();

  // Esc 关闭：浮层可键盘撤销，不该逼用户去够鼠标。
  const onKeyDown = event => {
    if (event.key !== 'Escape') return;
    hideActionToast();
    document.removeEventListener('keydown', onKeyDown, true);
  };
  document.addEventListener('keydown', onKeyDown, true);
  // 关闭时一并摘掉监听，避免文档生命周期结束后仍在监听。
  const observer = new MutationObserver(() => {
    if (document.getElementById('external-change-toast')) return;
    document.removeEventListener('keydown', onKeyDown, true);
    observer.disconnect();
  });
  observer.observe(document.body, { childList: true });

  return toast;
}

function hideActionToast() {
  const toast = document.getElementById('external-change-toast');
  if (!toast) return;
  toast.classList.remove('show');
  setTimeout(() => toast.remove(), 300);
}

// ========== Drag & Drop ==========
let dropOverlay = null;

function showDropOverlay() {
  if (dropOverlay) return;
  dropOverlay = document.createElement('div');
  dropOverlay.className = 'drop-overlay';
  dropOverlay.innerHTML = '<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/></svg><span>松开以打开文件</span>';
  document.body.appendChild(dropOverlay);
}

function hideDropOverlay() {
  if (!dropOverlay) return;
  dropOverlay.remove();
  dropOverlay = null;
}

function isSupportedDropPath(path) {
  return isSupportedDocumentPath(path);
}

async function initNativeTauriDragDrop() {
  // The frontend owns drag/drop opening; Rust only forwards OS and CLI open events.
  const handleDropPaths = paths => {
    hideDropOverlay();
    for (const path of paths) {
      if (isSupportedDropPath(path)) {
        void openFileByPath(path);
        return;
      }
    }
    if (paths?.length) {
      showToast(`不支持的文件类型，请拖入 ${getBrowserAccept().split(',').join(' / ')} 文件`);
    }
  };

  const onDragPayload = payload => {
    const { type, paths } = payload;
    if (type === 'enter' || type === 'over') {
      showDropOverlay();
    } else if (type === 'leave') {
      hideDropOverlay();
    } else if (type === 'drop') {
      handleDropPaths(paths || []);
    }
  };

  try {
    const tauriWindow = await getTauriWindow();
    await tauriWindow.getCurrentWindow().onDragDropEvent(event => onDragPayload(event.payload));
    console.log('Native Tauri drag-drop listeners registered');
    return true;
  } catch (e) {
    console.warn('Native Tauri drag-drop unavailable:', e.message || e);
  }

  try {
    const { listen, TauriEvent } = await getTauriEvent();
    await listen(TauriEvent.DRAG_ENTER, () => showDropOverlay());
    await listen(TauriEvent.DRAG_OVER, () => showDropOverlay());
    await listen(TauriEvent.DRAG_LEAVE, () => hideDropOverlay());
    await listen(TauriEvent.DRAG_DROP, event => handleDropPaths(event.payload?.paths || []));

    console.log('Tauri drag-drop event listeners registered');
    return true;
  } catch (e) {
    console.warn('Tauri drag-drop event listeners unavailable:', e.message || e);
    showToast('原生拖放初始化失败，请使用 Ctrl+O 打开文件', 'info');
  }

  return false;
}

async function initDragDrop() {
  if (!tauriAvailable) return;
  await initNativeTauriDragDrop();
}

/**
 * 订阅外部修改事件。
 *
 * 独立于拖放初始化：`initNativeTauriDragDrop` 的原生分支成功后会提前
 * return，把订阅放在它的 fallback 块里等于永远不执行。
 */
async function initExternalChangeListener() {
  if (!tauriAvailable) return;
  try {
    const { listen } = await getTauriEvent();
    await listen('document-changed-externally', event => {
      void externalChangeWatcher.handleEvent(event.payload);
    });
    console.log('External change listener registered');
  } catch (error) {
    // 订阅失败只影响外部修改提示，不阻断文档阅读。
    console.warn('External change listener unavailable:', error?.message || error);
  }
}

// ========== Keyboard Shortcuts ==========
document.addEventListener('keydown', e => {
  const ctrl = e.ctrlKey || e.metaKey;

  if (ctrl && e.key === 'o') { e.preventDefault(); openFile(); }
  if (ctrl && e.key === 's') {
    e.preventDefault();
    if (state.readOnly) showToast(ERROR_MESSAGES.readonly_file, 'info');
    else saveFile();
  }
  if (ctrl && e.key === 'f') { e.preventDefault(); toggleSearch(); }
  if (ctrl && e.key === '\\') { e.preventDefault(); toggleTOC(); }
  if (ctrl && e.key === 'e') {
    e.preventDefault();
    if (state.readOnly) showToast(ERROR_MESSAGES.readonly_file, 'info');
    else toggleEditMode();
  }
  if (ctrl && e.shiftKey && e.key === 'F') { e.preventDefault(); toggleFullWidth(); }
  if (ctrl && e.key === '=') { e.preventDefault(); changeFontSize(1); }
  if (ctrl && e.key === '-') { e.preventDefault(); changeFontSize(-1); }
  if (e.key === 'Escape' && state.searchVisible) toggleSearch();
  if (e.key === 'Enter' && state.searchVisible && document.activeElement === els.searchInput) {
    e.preventDefault();
    if (e.shiftKey) searchPrev(); else searchNext();
  }
});

// ========== Scroll Events ==========
els.readerView.addEventListener('scroll', () => {
  onScroll(els.readerView);
});
els.editorPreview.addEventListener('scroll', () => {
  onScroll(els.editorPreview);
});

// ========== Scroll Sync (Edit Mode) ==========
els.editorTextarea.addEventListener('scroll', () => {
  if (!state.isEditMode) return;
  const maxEditorScroll = els.editorTextarea.scrollHeight - els.editorTextarea.clientHeight;
  const pct = maxEditorScroll > 0 ? els.editorTextarea.scrollTop / maxEditorScroll : 0;
  const preview = els.editorPreview;
  if (preview) {
    preview.scrollTop = pct * (preview.scrollHeight - preview.clientHeight);
  }
});

// ========== Event Bindings ==========
els.btnOpen.addEventListener('click', openFile);
els.btnLibrary.addEventListener('click', toggleLibrary);
els.libraryRetry.addEventListener('click', () => {
  void loadLibraryFiles();
});
els.markdownBody.addEventListener('click', e => {
  const btn = e.target instanceof Element ? e.target.closest('.code-copy') : null;
  if (btn) {
    copyCode(btn);
    return;
  }
  handleRenderedLinkClick(e, {
    classify: classifyLinkHref,
    openExternal: openExternalUrl,
  });
});
els.btnSave.addEventListener('click', saveFile);
els.btnMode.addEventListener('click', toggleEditMode);
els.btnTheme.addEventListener('click', cycleTheme);
els.btnToc.addEventListener('click', toggleTOC);
els.btnSearch.addEventListener('click', toggleSearch);
els.btnFontUp.addEventListener('click', () => changeFontSize(1));
els.btnFontDown.addEventListener('click', () => changeFontSize(-1));
els.btnFullWidth.addEventListener('click', toggleFullWidth);
els.btnReloadExternal.addEventListener('click', () => reloadAfterExternalChange());
els.searchClose.addEventListener('click', toggleSearch);
els.searchNext.addEventListener('click', searchNext);
els.searchPrev.addEventListener('click', searchPrev);
els.searchInput.addEventListener('input', e => doSearch(e.target.value));

// Save progress on unload
window.addEventListener('beforeunload', saveProgress);

// 浏览器预览兜底：原生端由 initCloseGuard 精确保留，本条只覆盖
// `beforeunload` 不可靠的 WebView/浏览器场景（框由浏览器绘制，文案不可控）。
window.addEventListener('beforeunload', event => {
  if (state.isDirty && !closeGuard.isClosing()) {
    event.preventDefault();
    event.returnValue = '';
  }
});

// ========== Init ==========
async function init() {
  els.fileInput.accept = getBrowserAccept();
  loadTheme();
  loadFontSize();
  loadFullWidth();
  renderWelcome();
  await initTauri();
  void syncNativeWindowTheme(state.theme);
  await initDragDrop();
  await initExternalChangeListener();
  await initCloseGuard();
  await loadLibraryFiles();

  if (tauriAvailable) {
    try {
      const { listen } = await getTauriEvent();
      await listen('file-opened', event => {
        hideDropOverlay();
        const path = typeof event.payload === 'string' ? event.payload : event.payload?.path;
        if (path) void openFileByPath(path);
      });
    } catch (e) {
      console.error('Tauri file-opened listener failed:', e);
    }

    try {
      const args = await tauriInvoke('get_cli_args');
      if (args && args.length > 0) {
        await openFileByPath(args[0]);
      }
    } catch (e) {
      console.error('CLI file open failed:', e);
    }
  }
}

init();
