import MarkdownIt from 'markdown-it';
import DOMPurify from 'dompurify';
import hljs from './highlight.js';
import markdownItAnchor from 'markdown-it-anchor';
import markdownItToc from 'markdown-it-toc-done-right';
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
  reconcileSavedEditorState,
} from './document-session.js';
import { readBrowserTextFile } from './text-decoding.js';
import {
  createNativeWindowThemeSynchronizer,
  getNativeWindowTheme,
} from './window-theme.js';

// ========== Markdown Engine ==========
const md = new MarkdownIt({
  html: true,
  linkify: true,
  typographer: true,
  highlight(str, lang) {
    if (lang && hljs.getLanguage(lang)) {
      try {
        return hljs.highlight(str, { language: lang }).value;
      } catch (_) {}
    }
    return md.utils.escapeHtml(str);
  }
});

md.use(markdownItAnchor, {
  permalink: false,
  slugify: s => s.toLowerCase().replace(/[^\w\u4e00-\u9fff]+/g, '-').replace(/(^-|-$)/g, ''),
});

md.use(markdownItToc, {
  containerClass: 'toc-container',
  listType: 'ul',
});

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
  tocVisible: false,
  searchVisible: false,
  searchResults: [],
  searchIndex: -1,
  scrollSaveTimer: null,
  recentFiles: [],
};

const themes = ['light', 'dark', 'sepia'];
const themeLabels = { light: '浅色', dark: '深色', sepia: '护眼' };

// ========== DOM Elements ==========
const $ = id => document.getElementById(id);
const els = {
  toolbar: $('toolbar'),
  btnOpen: $('btn-open'),
  btnToc: $('btn-toc'),
  btnSearch: $('btn-search'),
  btnMode: $('btn-mode'),
  btnTheme: $('btn-theme'),
  btnFontUp: $('btn-font-up'),
  btnFontDown: $('btn-font-down'),
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
  statusEncoding: $('status-encoding'),
  fileInput: $('file-input'),
  themeIconSun: $('theme-icon-sun'),
  themeIconMoon: $('theme-icon-moon'),
  themeIconSepia: $('theme-icon-sepia'),
  dirtySwitchDialog: $('dirty-switch-dialog'),
  largeLogDialog: $('large-log-dialog'),
  largeLogFileName: $('large-log-file-name'),
  largeLogFileSize: $('large-log-file-size'),
};

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
  state.scrollSaveTimer = setTimeout(() => {
    if (state.filePath === path && state.documentGeneration === generation) {
      void saveProgress();
    }
  }, 800);

  if (scrollEl && els.progressBar) {
    const pct = scrollPercentage(scrollEl) * 100;
    els.progressBar.style.width = pct + '%';
  }
}

// ========== Helpers ==========
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

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

// ========== Recent Files ==========
async function loadRecentFiles() {
  if (!tauriAvailable) return;
  try {
    state.recentFiles = await tauriInvoke('get_recent_files');
    renderWelcome();
  } catch {}
}

function renderWelcome() {
  if (state.filePath) return;

  const recentHtml = state.recentFiles.length > 0
    ? `<div class="welcome-recent">
        <div class="welcome-recent-title">最近打开</div>
        ${state.recentFiles.slice(0, 8).map(path => {
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

// ========== Render ==========
function renderPlainText(content) {
  return `<div class="plain-text">${escapeHtml(content)}</div>`;
}

function renderContent(content, renderMode = state.renderMode) {
  return renderMode === 'plain' ? renderPlainText(content) : renderMarkdown(content);
}

function renderMarkdown(content) {
  const tocRe = /^\[\[toc\]\]\s*$/gim;
  const processed = content.replace(tocRe, '%%TOC%%');
  let html = md.render(processed).replace(
    /<p>%%TOC%%<\/p>/,
    '<nav class="toc-inline"></nav>'
  );
  html = DOMPurify.sanitize(html, {
    ADD_TAGS: ['nav'],
    ADD_ATTR: ['class'],
  });
  return html.replace(
    /<pre><code/g,
    '<pre><button type="button" class="code-copy">复制</button><code'
  );
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

function updateView(content) {
  const html = renderContent(content);
  els.markdownBody.innerHTML = html;
  els.previewBody.innerHTML = state.readOnly ? '' : html;
  if (state.readOnly) els.editorTextarea.value = '';
  els.tocContent.innerHTML = buildTOC();
  updateStatusInfo(content);
  observeHeadings();
}

function setFileEncoding(encoding) {
  state.encoding = encoding || 'UTF-8';
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
  if (viewState.tocDisabled) {
    state.tocVisible = false;
    els.tocPanel.classList.add('hidden');
  }

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

function applyOpenedDocument(documentData, { nativeFile }) {
  const type = classifyDocumentPath(documentData.path);
  if (type.kind === 'unsupported') throw createClientError('unsupported_type');
  if (
    (documentData.kind && documentData.kind !== type.kind)
    || (documentData.renderMode && documentData.renderMode !== type.renderMode)
    || (typeof documentData.readOnly === 'boolean' && documentData.readOnly !== !type.editable)
  ) {
    throw createClientError('policy_invalid', '前后端文档类型能力不一致');
  }

  clearTimeout(previewTimer);
  previewTimer = null;
  clearTimeout(state.scrollSaveTimer);
  state.scrollSaveTimer = null;
  state.documentGeneration += 1;
  state.editRevision = 0;
  state.filePath = documentData.path;
  state.nativeFile = nativeFile;
  state.rawContent = String(documentData.content ?? '');
  state.persistedContent = state.rawContent;
  state.kind = documentData.kind || type.kind;
  state.renderMode = documentData.renderMode || type.renderMode;
  state.readOnly = documentData.readOnly ?? !type.editable;
  state.toc = type.toc;
  state.sizeBytes = Number(documentData.sizeBytes) || 0;
  state.isDirty = false;
  if (state.readOnly) state.isEditMode = false;

  clearSearch();
  applyModeVisibility();
  els.editorTextarea.value = state.readOnly ? '' : state.rawContent;
  applyDocumentControls();
  updateView(state.rawContent);
  setFileEncoding(documentData.encoding);

  setDocumentIdentity(documentData.path);
  els.readerView.scrollTop = 0;
  els.editorTextarea.scrollTop = 0;
  els.editorPreview.scrollTop = 0;
  if (els.progressBar) els.progressBar.style.width = '0%';
}

async function performDocumentOpen({
  path,
  inspectDocument,
  readDocument,
  refreshRecentFiles,
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
    applyOpenedDocument(result.document, { nativeFile });
    if (refreshRecentFiles) await loadRecentFiles();
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
    refreshRecentFiles: true,
    nativeFile: true,
  }));
}

function openBrowserFile(file) {
  return serializeDocumentMutation(() => performDocumentOpen({
    path: file.name,
    inspectDocument: async () => browserInspection(file),
    readDocument: async (_path, allowLargeLog) => readBrowserDocument(file, allowLargeLog),
    refreshRecentFiles: false,
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
    const savedState = reconcileSavedEditorState({
      savedContent: content,
      currentEditorContent,
      revisionAtStart,
      currentRevision: state.editRevision,
    });

    state.filePath = savedPath;
    state.nativeFile = tauriAvailable;
    state.persistedContent = savedState.persistedContent;
    state.rawContent = savedState.rawContent;
    state.kind = type.kind;
    state.renderMode = type.renderMode;
    state.readOnly = false;
    state.toc = type.toc;
    state.sizeBytes = new TextEncoder().encode(content).byteLength;
    state.isDirty = savedState.isDirty;
    applyDocumentControls();
    if (savedState.isDirty) {
      els.previewBody.innerHTML = renderContent(savedState.previewContent);
      refreshTOC();
      updateStatusInfo(savedState.previewContent);
    } else {
      clearTimeout(previewTimer);
      previewTimer = null;
      updateView(savedState.previewContent);
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
function toggleEditMode() {
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
    refreshTOC();
    applyModeVisibility();
    els.editorTextarea.focus();
  } else {
    clearTimeout(previewTimer);
    previewTimer = null;
    state.rawContent = els.editorTextarea.value;
    applyModeVisibility();
    updateView(state.rawContent);
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
  localStorage.setItem('md-reader-theme', theme);
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
  const stored = localStorage.getItem('md-reader-theme');
  const saved = themes.includes(stored) ? stored : 'light';
  applyTheme(saved);
}

// ========== Font Size ==========
function changeFontSize(delta) {
  state.fontSize = Math.max(13, Math.min(22, state.fontSize + delta));
  document.documentElement.style.setProperty('--font-size', state.fontSize + 'px');
  localStorage.setItem('md-reader-font-size', state.fontSize);
}

function loadFontSize() {
  const saved = parseInt(localStorage.getItem('md-reader-font-size'));
  if (saved && saved >= 13 && saved <= 22) {
    state.fontSize = saved;
    document.documentElement.style.setProperty('--font-size', state.fontSize + 'px');
  }
}

// ========== TOC ==========
function toggleTOC() {
  if (documentInteractionLocked()) {
    showToast('文档操作正在进行，请稍候', 'info');
    return;
  }
  if (!state.toc) {
    showToast('纯文本文档不提供目录', 'info');
    return;
  }
  state.tocVisible = !state.tocVisible;
  els.tocPanel.classList.toggle('hidden', !state.tocVisible);
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

let previewTimer = null;
function onEditorChanged() {
  if (state.readOnly || state.documentSwitchPending) return;
  state.editRevision += 1;
  state.isDirty = isDraftDirty(els.editorTextarea.value, state.persistedContent);
  setDocumentIdentity(state.filePath, state.isDirty);
  const snapshot = {
    generation: state.documentGeneration,
    revision: state.editRevision,
  };
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => {
    if (
      !state.isEditMode
      || !isEditorSnapshotCurrent(snapshot, {
        generation: state.documentGeneration,
        revision: state.editRevision,
        readOnly: state.readOnly,
      })
    ) return;
    const content = els.editorTextarea.value;
    els.previewBody.innerHTML = renderContent(content);
    refreshTOC();
    updateStatusInfo(content);
  }, 150);
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
els.markdownBody.addEventListener('click', e => {
  const btn = e.target instanceof Element ? e.target.closest('.code-copy') : null;
  if (btn) copyCode(btn);
});
els.btnSave.addEventListener('click', saveFile);
els.btnMode.addEventListener('click', toggleEditMode);
els.btnTheme.addEventListener('click', cycleTheme);
els.btnToc.addEventListener('click', toggleTOC);
els.btnSearch.addEventListener('click', toggleSearch);
els.btnFontUp.addEventListener('click', () => changeFontSize(1));
els.btnFontDown.addEventListener('click', () => changeFontSize(-1));
els.searchClose.addEventListener('click', toggleSearch);
els.searchNext.addEventListener('click', searchNext);
els.searchPrev.addEventListener('click', searchPrev);
els.searchInput.addEventListener('input', e => doSearch(e.target.value));

// Save progress on unload
window.addEventListener('beforeunload', saveProgress);

// ========== Init ==========
async function init() {
  els.fileInput.accept = getBrowserAccept();
  loadTheme();
  loadFontSize();
  renderWelcome();
  await initTauri();
  void syncNativeWindowTheme(state.theme);
  await initDragDrop();
  await loadRecentFiles();

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
