import MarkdownIt from 'markdown-it';
import DOMPurify from 'dompurify';
import hljs from './highlight.js';
import markdownItAnchor from 'markdown-it-anchor';
import markdownItToc from 'markdown-it-toc-done-right';

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
  rawContent: '',
  isDirty: false,
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
  markdownBody: $('markdown-body'),
  editorTextarea: $('editor-textarea'),
  previewBody: $('preview-body'),
  progressBar: $('reading-progress-bar'),
  statusMode: $('status-mode'),
  statusInfo: $('status-info'),
  fileInput: $('file-input'),
  themeIconSun: $('theme-icon-sun'),
  themeIconMoon: $('theme-icon-moon'),
  themeIconSepia: $('theme-icon-sepia'),
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

async function initTauri() {
  try {
    await getTauriInvoke();
    tauriAvailable = true;
    console.log('Tauri API available', getTauriGlobal()?.core ? '(global)' : '(module)');
  } catch {
    console.log('Running in browser mode (no Tauri)');
  }
}

async function tauriOpenFile() {
  if (tauriAvailable) {
    try {
      const dialog = await getTauriDialog();
      const selected = await dialog.open({
        multiple: false,
        directory: false,
        filters: [{ name: 'Markdown', extensions: ['md', 'markdown', 'txt'] }],
      });
      if (!selected || Array.isArray(selected)) return null;
      return await tauriInvoke('read_file', { path: selected });
    } catch (e) {
      console.error('Tauri open failed:', e);
      showToast(`打开文件失败: ${e.message || e}`);
    }
    return null;
  }
  // Browser fallback
  return new Promise(resolve => {
    els.fileInput.onchange = () => {
      const file = els.fileInput.files[0];
      if (!file) return resolve(null);
      const reader = new FileReader();
      reader.onload = () => resolve({ path: file.name, content: reader.result });
      reader.readAsText(file);
    };
    els.fileInput.click();
  });
}

function isAbsoluteFilePath(path) {
  if (!path) return false;
  return /^([a-zA-Z]:[\\/]|\\\\|\/)/.test(path);
}

async function tauriSaveFile(path, content) {
  if (tauriAvailable) {
    try {
      if (!isAbsoluteFilePath(path)) {
        const dialog = await getTauriDialog();
        path = await dialog.save({
          filters: [{ name: 'Markdown', extensions: ['md'] }],
          defaultPath: path || 'untitled.md',
        });
        if (!path) return false;
      }
      await tauriInvoke('save_file', { path, content });
      return path;
    } catch (e) {
      console.error('Tauri save failed:', e);
      return false;
    }
  }
  // Browser fallback
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = path || 'untitled.md';
  a.click();
  URL.revokeObjectURL(a.href);
  return true;
}

// ========== Reading Progress ==========
async function saveProgress() {
  if (!state.filePath || !tauriAvailable) return;
  const container = state.isEditMode ? els.readerView : els.readerView;
  const scrollEl = els.markdownBody.parentElement;
  if (!scrollEl) return;

  const pct = scrollEl.scrollHeight > scrollEl.clientHeight
    ? scrollEl.scrollTop / (scrollEl.scrollHeight - scrollEl.clientHeight)
    : 0;

  try {
    await tauriInvoke('save_reading_progress', {
      path: state.filePath,
      scrollPct: Math.min(1, Math.max(0, pct)),
    });
  } catch (e) {
    console.error('Save progress failed:', e);
  }
}

async function loadProgress() {
  if (!state.filePath || !tauriAvailable) return;
  try {
    const progress = await tauriInvoke('load_reading_progress', { path: state.filePath });
    if (progress && progress.scroll_pct > 0) {
      // Wait for render
      requestAnimationFrame(() => {
        const scrollEl = els.markdownBody.parentElement;
        if (scrollEl) {
          const maxScroll = scrollEl.scrollHeight - scrollEl.clientHeight;
          scrollEl.scrollTop = progress.scroll_pct * maxScroll;
        }
      });
    }
  } catch (e) {
    console.error('Load progress failed:', e);
  }
}

function onScroll() {
  clearTimeout(state.scrollSaveTimer);
  state.scrollSaveTimer = setTimeout(saveProgress, 800);

  // Update progress bar
  const scrollEl = els.markdownBody.parentElement;
  if (scrollEl && els.progressBar) {
    const pct = scrollEl.scrollHeight > scrollEl.clientHeight
      ? (scrollEl.scrollTop / (scrollEl.scrollHeight - scrollEl.clientHeight)) * 100
      : 0;
    els.progressBar.style.width = pct + '%';
  }
}

// ========== Helpers ==========
function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
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
      <p class="hint">拖拽 .md 文件到此处，或点击打开</p>
      <p class="shortcut-hint">Ctrl+O 打开 · Ctrl+S 保存 · Ctrl+F 搜索 · Ctrl+\\ 目录</p>
    </div>
    ${recentHtml}
  `;

  els.markdownBody.querySelectorAll('.recent-item').forEach(btn => {
    btn.addEventListener('click', () => openFileByPath(btn.dataset.path));
  });
}

// ========== Render ==========
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

function renderTOC(content) {
  const headings = [];
  const lines = content.split('\n');
  const slugCount = {};

  for (const line of lines) {
    const match = line.match(/^(#{1,4})\s+(.+)/);
    if (match) {
      const level = match[1].length;
      const text = match[2].replace(/[*_`~\[\]]/g, '');
      let slug = text.toLowerCase()
        .replace(/[^\w\u4e00-\u9fff]+/g, '-')
        .replace(/(^-|-$)/g, '');

      if (slugCount[slug] !== undefined) {
        slugCount[slug]++;
        slug += '-' + slugCount[slug];
      } else {
        slugCount[slug] = 0;
      }
      headings.push({ level, text, slug });
    }
  }

  if (headings.length < 2) return '';

  return headings.map(h =>
    `<a class="toc-h${h.level}" href="#${h.slug}" data-slug="${h.slug}">${h.text}</a>`
  ).join('\n');
}

function updateView(content) {
  const html = renderMarkdown(content);
  els.markdownBody.innerHTML = html;
  els.previewBody.innerHTML = html;
  els.tocContent.innerHTML = renderTOC(content);
  updateStatusInfo(content);
  observeHeadings();
}

function updateStatusInfo(content) {
  const chars = content.length;
  const lines = content.split('\n').length;
  els.statusInfo.textContent = `${lines} 行 · ${chars} 字`;
}

// ========== Heading Observer (Scroll Spy) ==========
let headingObserver = null;

function observeHeadings() {
  if (headingObserver) headingObserver.disconnect();

  headingObserver = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        const id = entry.target.id;
        els.tocContent.querySelectorAll('a').forEach(a => {
          a.classList.toggle('active', a.dataset.slug === id);
        });
      }
    }
  }, { rootMargin: '-80px 0px -60% 0px' });

  els.markdownBody.querySelectorAll('h1[id],h2[id],h3[id],h4[id]').forEach(h => {
    headingObserver.observe(h);
  });
}

// ========== File Operations ==========
async function openFileByPath(path) {
  if (!path || !tauriAvailable) return false;

  if (state.filePath) saveProgress();

  try {
    const result = await tauriInvoke('read_file', { path });
    if (!result) return false;

    state.filePath = result.path;
    state.rawContent = result.content;
    state.isDirty = false;

    const name = result.path.split(/[/\\]/).pop();
    els.fileName.textContent = name;
    els.fileName.classList.add('has-file');
    document.title = `${name} — MD Reader`;

    els.editorTextarea.value = state.rawContent;
    updateView(state.rawContent);
    loadProgress();
    await loadRecentFiles();
    return true;
  } catch (e) {
    console.error('Open file by path failed:', e);
    return false;
  }
}

async function openFile() {
  // Save current progress before switching
  if (state.filePath) saveProgress();

  const result = await tauriOpenFile();
  if (!result) return;

  state.filePath = result.path;
  state.rawContent = result.content;
  state.isDirty = false;

  const name = result.path.split(/[/\\]/).pop();
  els.fileName.textContent = name;
  els.fileName.classList.add('has-file');
  document.title = `${name} — MD Reader`;

  els.editorTextarea.value = state.rawContent;
  updateView(state.rawContent);

  await loadRecentFiles();

  // Restore reading progress
  loadProgress();
}

async function saveFile() {
  const content = state.isEditMode ? els.editorTextarea.value : state.rawContent;
  const savedPath = await tauriSaveFile(state.filePath, content);
  if (savedPath) {
    state.filePath = savedPath;
    state.rawContent = content;
    state.isDirty = false;
    const name = savedPath.split(/[/\\]/).pop();
    els.fileName.textContent = name;
    els.fileName.classList.add('has-file');
    document.title = `${name} — MD Reader`;
  }
}

// ========== Mode Toggle ==========
function toggleEditMode() {
  state.isEditMode = !state.isEditMode;

  if (state.isEditMode) {
    els.readerView.classList.add('hidden');
    els.editorView.classList.remove('hidden');
    els.statusMode.textContent = '编辑';
    els.editorTextarea.value = state.rawContent;
    els.editorTextarea.focus();
  } else {
    els.readerView.classList.remove('hidden');
    els.editorView.classList.add('hidden');
    els.statusMode.textContent = '阅读';
    state.rawContent = els.editorTextarea.value;
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
  const saved = localStorage.getItem('md-reader-theme') || 'light';
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
  state.tocVisible = !state.tocVisible;
  els.tocPanel.classList.toggle('hidden', !state.tocVisible);
}

els.tocContent.addEventListener('click', e => {
  const link = e.target.closest('a');
  if (!link) return;
  e.preventDefault();
  const slug = link.dataset.slug;
  const target = els.markdownBody.querySelector(`#${CSS.escape(slug)}`);
  if (target) {
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
  els.markdownBody.querySelectorAll('.search-highlight, .search-current').forEach(el => {
    const parent = el.parentNode;
    parent.replaceChild(document.createTextNode(el.textContent), el);
    parent.normalize();
  });
}

function doSearch(query) {
  clearSearch();
  if (!query) return;

  const body = els.markdownBody;
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
  if (e.key === 'Tab') {
    e.preventDefault();
    const start = e.target.selectionStart;
    const end = e.target.selectionEnd;
    e.target.value = e.target.value.substring(0, start) + '    ' + e.target.value.substring(end);
    e.target.selectionStart = e.target.selectionEnd = start + 4;
  }
});

let previewTimer = null;
els.editorTextarea.addEventListener('input', () => {
  state.isDirty = true;
  if (!els.fileName.textContent.includes('●')) {
    els.fileName.textContent += ' ●';
  }
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => {
    const content = els.editorTextarea.value;
    els.previewBody.innerHTML = renderMarkdown(content);
    els.tocContent.innerHTML = renderTOC(content);
    updateStatusInfo(content);
  }, 150);
});

// ========== Toast ==========
function showToast(message, type = 'error') {
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
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

async function initNativeTauriDragDrop() {
  // Drop is handled in Rust (WebviewEvent::DragDrop → emit file-opened).
  // Frontend only drives the drag overlay via native Tauri events.
  const onDragPayload = payload => {
    const { type } = payload;
    if (type === 'enter' || type === 'over') {
      showDropOverlay();
    } else if (type === 'leave' || type === 'drop') {
      hideDropOverlay();
    }
  };

  try {
    const tauriWindow = await getTauriWindow();
    await tauriWindow.getCurrentWindow().onDragDropEvent(event => onDragPayload(event.payload));
    console.log('Native Tauri drag-drop overlay registered');
    return true;
  } catch (e) {
    console.warn('Native Tauri drag-drop unavailable:', e.message || e);
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
  if (ctrl && e.key === 's') { e.preventDefault(); saveFile(); }
  if (ctrl && e.key === 'f') { e.preventDefault(); toggleSearch(); }
  if (ctrl && e.key === '\\') { e.preventDefault(); toggleTOC(); }
  if (ctrl && e.key === 'e') { e.preventDefault(); toggleEditMode(); }
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
  onScroll();
});

// ========== Scroll Sync (Edit Mode) ==========
els.editorTextarea.addEventListener('scroll', () => {
  if (!state.isEditMode) return;
  const pct = els.editorTextarea.scrollTop / (els.editorTextarea.scrollHeight - els.editorTextarea.clientHeight);
  const preview = els.editorView.querySelector('.editor-preview');
  if (preview) {
    preview.scrollTop = pct * (preview.scrollHeight - preview.clientHeight);
  }
});

// ========== Event Bindings ==========
els.btnOpen.addEventListener('click', openFile);
els.markdownBody.addEventListener('click', e => {
  const btn = e.target.closest('.code-copy');
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
  await initTauri();
  await initDragDrop();
  loadTheme();
  loadFontSize();
  renderWelcome();
  await loadRecentFiles();

  if (tauriAvailable) {
    try {
      const { listen } = await getTauriEvent();
      listen('file-opened', event => {
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
