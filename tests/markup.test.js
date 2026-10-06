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
