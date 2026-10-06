import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('index exposes the file library panel, toggle, and context menu hooks', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');

  for (const id of [
    'btn-library',
    'library-panel',
    'library-list',
    'library-empty',
    'library-error-text',
    'library-retry',
    'file-context-menu',
  ]) {
    assert.match(html, new RegExp(`id=["']${id}["']`), `missing #${id}`);
  }

  assert.match(html, /id=["']btn-library["'][^>]*type=["']button["'][^>]*aria-expanded=["']false["'][^>]*aria-controls=["']library-panel["']/);
  assert.match(html, /id=["']btn-toc["'][^>]*type=["']button["'][^>]*aria-expanded=["']false["'][^>]*aria-controls=["']toc-panel["']/);
  assert.match(html, /id=["']toc-panel["'][^>]*class=["'][^"']*side-panel/);
  assert.match(html, /id=["']library-panel["'][^>]*class=["'][^"']*side-panel/);
  assert.match(html, /role=["']menu["']/);
  assert.match(html, /data-action=["']remove["']/);
  assert.match(html, /data-action=["']trash["']/);
  assert.equal((html.match(/role=["']menuitem["']/g) ?? []).length, 2);
});

test('index exposes the full width toggle with an accessible label', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const button = html.match(/<button\b[^>]*id=["']btn-full-width["'][^>]*>/i)?.[0];

  assert.ok(button, 'expected #btn-full-width');
  assert.match(button, /type=["']button["']/);
  assert.match(button, /aria-label=["']铺满宽度["']/);
  assert.match(button, /title=["'][^"']*Ctrl\+Shift\+F/);
});

test('the welcome page advertises the full width shortcut', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');

  assert.match(html, /Ctrl\+Shift\+F/);
});

test('index exposes the external change notice with an accessible reload action', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const notice = html.match(/<span\b[^>]*id=["']external-change-notice["'][^>]*>/i)?.[0];

  assert.ok(notice, 'expected #external-change-notice');
  assert.match(notice, /class=["'][^"']*\bhidden\b/, 'notice must start hidden');

  const reload = html.match(/<button\b[^>]*id=["']btn-reload-external["'][^>]*>/i)?.[0];
  assert.ok(reload, 'expected #btn-reload-external');
  assert.match(reload, /type=["']button["']/);
  assert.match(reload, /class=["'][^"']*external-change-action/, 'reload must be styleable');
});

test('the external change listener is registered outside the drag-drop fallback', async () => {
  const source = await readFile(new URL('../src/js/app.js', import.meta.url), 'utf8');

  // `initNativeTauriDragDrop` 的原生分支成功即 return，fallback 块永不执行。
  // 事件订阅若落在该块内，等于永远不注册。
  const nativeInit = source.slice(
    source.indexOf('async function initNativeTauriDragDrop()'),
    source.indexOf('async function initDragDrop()'),
  );
  assert.doesNotMatch(
    nativeInit,
    /document-changed-externally/,
    'the drag-drop fallback branch returns early, so it must not own event subscriptions',
  );

  // 订阅必须存在于独立函数中，并由 init 调用。
  const listenerInit = source.slice(
    source.indexOf('async function initExternalChangeListener()'),
    source.indexOf('async function initDragDrop()') > 0
      ? source.indexOf('// ========== Keyboard Shortcuts ==========')
      : source.length,
  );
  assert.match(
    listenerInit,
    /document-changed-externally/,
    'expected a dedicated external-change listener registration',
  );
  assert.match(
    source,
    /await initExternalChangeListener\(\)/,
    'init must call the external-change listener setup',
  );
});

test('edit and search buttons expose an active state', async () => {
  const source = await readFile(new URL('../src/js/app.js', import.meta.url), 'utf8');

  // 编辑模式：激活态挂在 applyModeVisibility（统一切换点）上。
  const modeVisibility = source.slice(
    source.indexOf('function applyModeVisibility()'),
    source.indexOf('function applyDocumentControls()'),
  );
  assert.match(
    modeVisibility,
    /els\.btnMode\.classList\.toggle\('active', state\.isEditMode\)/,
    'edit-mode button must reflect the current mode',
  );
  assert.match(modeVisibility, /aria-pressed/, 'edit-mode button needs an aria-pressed state');

  // 搜索模式：必须在 toggleSearch 里同步。
  const toggleSearch = source.slice(
    source.indexOf('function toggleSearch()'),
    source.indexOf('function clearSearch()'),
  );
  assert.match(
    toggleSearch,
    /els\.btnSearch\.classList\.toggle\('active', state\.searchVisible\)/,
    'search button must reflect the search-panel state',
  );
  assert.match(toggleSearch, /aria-pressed/, 'search button needs an aria-pressed state');
});

test('editor input advances the revision through the session, not the flat state', async () => {
  const source = await readFile(new URL('../src/js/app.js', import.meta.url), 'utf8');
  const handler = source.slice(
    source.indexOf('function onEditorChanged()'),
    source.indexOf("els.editorTextarea.addEventListener('input'"),
  );

  // 回归：曾直接递增 state.editRevision，而 isEditorSnapshotCurrent 是
  // 闭包内自比对，会话里的修订号不更新 → 预览永不刷新。
  assert.doesNotMatch(
    handler,
    /state\.editRevision \+= 1/,
    'revision must advance through the session so the snapshot guard sees it',
  );
  assert.match(handler, /documentSession\.markEdited\(/);
  assert.match(handler, /syncDocumentStateFromSession\(\)/);
});

test('the close-app dialog offers save, discard, and cancel', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const dialog = html.match(/<dialog\b[^>]*id=["']close-app-dialog["'][\s\S]*?<\/dialog>/)?.[0];

  assert.ok(dialog, 'expected #close-app-dialog');
  assert.match(dialog, /aria-labelledby=["']close-app-title["']/);
  for (const result of ['cancel', 'discard', 'save']) {
    assert.match(
      dialog,
      new RegExp(`data-dialog-result=["']${result}["']`),
      `missing ${result} action`,
    );
  }
  // 文案必须说的是「退出应用」而非「打开其他文件」——与切换文档对话框区分。
  assert.match(dialog, /退出应用/);
});

test('close interception is registered in init and the fallback is guarded', async () => {
  const source = await readFile(new URL('../src/js/app.js', import.meta.url), 'utf8');

  assert.match(source, /await initCloseGuard\(\)/, 'init must register the close guard');
  assert.match(source, /onCloseRequested\(/, 'must intercept the native close request');
  // 拦截后必须 preventDefault，否则决策来不及。
  const handler = source.slice(
    source.indexOf('async function initCloseGuard()'),
    source.indexOf('function confirmLargeLog'),
  );
  assert.match(handler, /event\.preventDefault\(\)/);

  // beforeunload 兜底不得对正在关闭的流程重复拦截。
  const fallback = source.slice(source.indexOf("window.addEventListener('beforeunload', event =>"));
  assert.match(fallback, /state\.isDirty/);
  assert.match(fallback, /!closeGuard\.isClosing\(\)/);
});

test('the preview pane re-render keeps its scroll position', async () => {
  const source = await readFile(new URL('../src/js/app.js', import.meta.url), 'utf8');
  const render = source.slice(
    source.indexOf('function renderPreviewPane('),
    source.indexOf("els.editorTextarea.addEventListener('input'"),
  );

  // innerHTML 赋值会把 scrollTop 归零；渲染前后必须记录/还原比例。
  assert.match(render, /preview\.scrollTop/, 'must restore the scroll position');
  assert.match(render, /scrollHeight/, 'must compute the scroll ratio');
  assert.ok(
    render.indexOf('scrollTop') < render.lastIndexOf('innerHTML')
      || render.includes('ratio'),
    'scroll ratio must be captured before re-rendering',
  );
});

test('editor input schedules the preview through rAF, not a timer', async () => {
  const source = await readFile(new URL('../src/js/app.js', import.meta.url), 'utf8');
  const handler = source.slice(
    source.indexOf('function onEditorChanged()'),
    source.indexOf('function renderPreviewPane('),
  );

  assert.match(handler, /requestAnimationFrame/, 'preview must repaint on the next frame');
  assert.doesNotMatch(handler, /setTimeout/, 'a fixed delay makes the preview feel laggy');
  assert.doesNotMatch(source, /previewTimer/, 'the old debounce timer must be gone');
});

test('the close guard never destroys the window on a plain pass-through', async () => {
  const source = await readFile(new URL('../src/js/close-guard.js', import.meta.url), 'utf8');

  // 回归：曾在「无需询问」分支里调用 performClose()（即 Tauri 的
  // destroy()），导致连正常的关闭按钮与 Alt+F4 都被强杀——窗控失效。
  // `onCloseRequested` 的正确用法是：可以关就 return 放行，只有用户
  // 明确确认后才 destroy。
  const passThrough = source.slice(
    source.indexOf("if (decision.action === 'allow')"),
    source.indexOf('const answer = await showDialog()'),
  );
  assert.doesNotMatch(
    passThrough,
    /performClose\(\)/,
    'a pass-through close must not destroy the window',
  );

  // 确认后仍需真正 destroy，否则点了「保存并退出」窗口不关。
  const confirmed = source.slice(source.indexOf('closeInProgress = true;'));
  assert.match(confirmed, /performClose\(\)/, 'a confirmed close must actually close the window');
});
