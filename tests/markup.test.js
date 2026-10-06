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
