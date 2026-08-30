import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyTrashedOutcome,
  buildTrashConfirmationMessage,
  clampMenuPosition,
  createFileLibraryView,
  fileNameFromPath,
  menuKeyDecision,
  nextMenuIndex,
  nextSidePanel,
  requestTrash,
  samePath,
  validateLibraryPaths,
  welcomePaths,
} from '../src/js/file-library.js';

test('file library helpers handle cross-platform paths and MRU order', () => {
  assert.equal(fileNameFromPath('C:\\docs\\a.md'), 'a.md');
  assert.equal(fileNameFromPath('/docs/b.txt'), 'b.txt');
  assert.equal(samePath('C:\\Docs\\A.md', 'c:/docs/a.md', 'windows'), true);
  assert.equal(samePath('C:\\Docs\\A.md', 'c:/docs/a.md', 'posix'), false);
  assert.equal(
    welcomePaths(Array.from({ length: 12 }, (_, index) => `${index}.md`)).length,
    8,
  );
  assert.deepEqual(
    validateLibraryPaths(['/docs/paper.tex', '/logs/build.log']),
    ['/docs/paper.tex', '/logs/build.log'],
  );
  assert.throws(() => validateLibraryPaths(['/docs/image.png']), /不支持的文档类型/);
  assert.throws(() => validateLibraryPaths('not-an-array'), /文件库数据无效/);
});

test('clampMenuPosition keeps the menu inside the viewport', () => {
  assert.deepEqual(
    clampMenuPosition({
      x: 790,
      y: 590,
      width: 180,
      height: 120,
      viewportWidth: 800,
      viewportHeight: 600,
    }),
    { left: 612, top: 472 },
  );
});

test('menu keyboard navigation wraps and supports first/last', () => {
  assert.equal(nextMenuIndex('ArrowDown', 1, 2), 0);
  assert.equal(nextMenuIndex('ArrowUp', 0, 2), 1);
  assert.equal(nextMenuIndex('Home', 1, 2), 0);
  assert.equal(nextMenuIndex('End', 0, 2), 1);
  assert.equal(nextMenuIndex('Escape', 0, 2), null);
  assert.deepEqual(menuKeyDecision('Home', 0, 2), {
    handled: true,
    close: false,
    restoreFocus: false,
    nextIndex: 0,
  });
  assert.deepEqual(menuKeyDecision('Tab', 0, 2), {
    handled: false,
    close: true,
    restoreFocus: false,
    nextIndex: null,
  });
  assert.deepEqual(menuKeyDecision('Escape', 0, 2), {
    handled: true,
    close: true,
    restoreFocus: true,
    nextIndex: null,
  });
});

test('nextSidePanel makes library and TOC mutually exclusive', () => {
  assert.equal(nextSidePanel('none', 'library'), 'library');
  assert.equal(nextSidePanel('library', 'toc'), 'toc');
  assert.equal(nextSidePanel('toc', 'toc'), 'none');
  assert.throws(() => nextSidePanel('none', 'history'), /未知侧栏/);
});

function createFakeElement(tag = 'div') {
  const element = {
    tagName: tag,
    children: [],
    attributes: {},
    dataset: {},
    style: {},
    listeners: {},
    textContent: '',
    focused: false,
    classList: {
      set: new Set(),
      add(...names) {
        names.forEach(name => this.set.add(name));
      },
      remove(...names) {
        names.forEach(name => this.set.delete(name));
      },
      toggle(name, force) {
        const has = this.set.has(name);
        const next = force === undefined ? !has : force;
        if (next) this.set.add(name);
        else this.set.delete(name);
        return next;
      },
      contains(name) {
        return this.set.has(name);
      },
    },
    setAttribute(name, value) {
      this.attributes[name] = value;
    },
    getAttribute(name) {
      return this.attributes[name] ?? null;
    },
    append(...children) {
      this.children.push(...children);
    },
    addEventListener(type, handler) {
      (this.listeners[type] ??= []).push(handler);
    },
    removeEventListener(type, handler) {
      this.listeners[type] = (this.listeners[type] ?? []).filter(
        registered => registered !== handler,
      );
    },
    dispatch(type, event) {
      (this.listeners[type] ?? []).forEach(handler => handler(event));
    },
    focus() {
      this.focused = true;
    },
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 120, height: 44 };
    },
    replaceChildren() {
      this.children = [];
    },
    contains(node) {
      if (node === this) return true;
      return this.children.some(child => child.contains(node));
    },
    querySelectorAll(selector) {
      if (selector !== '[role="menuitem"]') return [];
      return this.children.filter(child => child.getAttribute('role') === 'menuitem');
    },
    closest(selector) {
      let current = this;
      while (current) {
        if (selector === '[data-action]' && current.dataset?.action) return current;
        current = current.parent ?? null;
      }
      return null;
    },
  };
  return element;
}

function createViewHarness() {
  const listElement = createFakeElement('div');
  const emptyElement = createFakeElement();
  const scrollElement = createFakeElement();
  const menuElement = createFakeElement('div');
  menuElement.classList.add('hidden');
  const removeItem = createFakeElement('button');
  removeItem.setAttribute('role', 'menuitem');
  removeItem.dataset.action = 'remove';
  menuElement.children.push(removeItem);

  const documentRef = createFakeElement('document');
  documentRef.createElement = () => createFakeElement('div');
  const windowRef = {
    innerWidth: 800,
    innerHeight: 600,
    listeners: {},
    addEventListener(type, handler) {
      (this.listeners[type] ??= []).push(handler);
    },
    removeEventListener(type, handler) {
      this.listeners[type] = (this.listeners[type] ?? []).filter(h => h !== handler);
    },
    dispatch(type, event) {
      (this.listeners[type] ?? []).forEach(handler => handler(event));
    },
  };

  const calls = { open: [], remove: [], errors: [] };
  const view = createFileLibraryView({
    listElement,
    scrollElement,
    emptyElement,
    menuElement,
    platform: 'windows',
    onOpen: path => calls.open.push(path),
    onRemove: path => calls.remove.push(path),
    onError: error => calls.errors.push(error),
    documentRef,
    windowRef,
  });

  return { view, listElement, emptyElement, scrollElement, menuElement, removeItem, documentRef, windowRef, calls };
}

test('file library view renders names, paths, and the current item safely', () => {
  const { view, listElement, emptyElement } = createViewHarness();

  view.render(['C:\\docs\\readme.md', 'C:\\docs\\notes.tex'], 'c:/docs/readme.md');

  assert.equal(listElement.children.length, 2);
  assert.equal(emptyElement.classList.contains('hidden'), true);
  const [first, second] = listElement.children;
  const [button] = first.children;
  const [name, fullPath] = button.children;
  assert.equal(name.textContent, 'readme.md');
  assert.equal(fullPath.textContent, 'C:\\docs\\readme.md');
  assert.equal(button.getAttribute('aria-current'), 'page');
  const [secondButton] = second.children;
  assert.equal(secondButton.getAttribute('aria-current'), null);
});

test('file library view rejects corrupted library data before touching the DOM', () => {
  const { view, listElement } = createViewHarness();

  assert.throws(() => view.render(['C:\\docs\\image.png'], ''), /不支持的文档类型/);
  assert.throws(() => view.render('garbage', ''), /文件库数据无效/);
  assert.equal(listElement.children.length, 0);
});

test('view item clicks open the file and context menu removes records', async () => {
  const { view, listElement, menuElement, removeItem, documentRef, calls } = createViewHarness();

  view.render(['C:\\docs\\readme.md'], '');
  const [row] = listElement.children;
  const [button] = row.children;
  button.dispatch('click', {});
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls.open, ['C:\\docs\\readme.md']);

  button.dispatch('contextmenu', {
    preventDefault() {},
    clientX: 700,
    clientY: 500,
    target: {},
  });
  assert.equal(menuElement.classList.contains('hidden'), false);
  assert.ok(Number.parseFloat(menuElement.style.left) <= 800 - 8 - 120);
  assert.ok(Number.parseFloat(menuElement.style.top) <= 600 - 8 - 44);
  assert.equal(removeItem.focused, true);

  menuElement.dispatch('click', {
    target: { closest: selector => (selector === '[data-action]' ? removeItem : null) },
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls.remove, ['C:\\docs\\readme.md']);
  assert.equal(menuElement.classList.contains('hidden'), true);
  assert.equal(button.focused, true);
});

test('escape and outside pointerdown close the menu without stealing focus', async () => {
  const { view, listElement, menuElement, scrollElement, documentRef, windowRef, calls } =
    createViewHarness();

  view.render(['C:\\docs\\readme.md'], '');
  const [row] = listElement.children;
  const [button] = row.children;
  button.dispatch('contextmenu', {
    preventDefault() {},
    clientX: 10,
    clientY: 10,
    target: {},
  });
  assert.equal(menuElement.classList.contains('hidden'), false);

  documentRef.dispatch('keydown', { key: 'Escape', preventDefault() {} });
  assert.equal(menuElement.classList.contains('hidden'), true);

  button.dispatch('contextmenu', {
    preventDefault() {},
    clientX: 10,
    clientY: 10,
    target: {},
  });
  documentRef.dispatch('pointerdown', { target: { someOther: true } });
  assert.equal(menuElement.classList.contains('hidden'), true);

  windowRef.dispatch('blur', {});
  scrollElement.dispatch('scroll', {});
  assert.deepEqual(calls.remove, []);
  assert.deepEqual(calls.errors, []);
});

test('menu action failures surface through onError without unhandled rejections', async () => {
  const listElement = createFakeElement('div');
  const emptyElement = createFakeElement();
  const scrollElement = createFakeElement();
  const menuElement = createFakeElement('div');
  menuElement.classList.add('hidden');
  const removeItem = createFakeElement('button');
  removeItem.setAttribute('role', 'menuitem');
  removeItem.dataset.action = 'remove';
  menuElement.children.push(removeItem);
  const documentRef = createFakeElement('document');
  documentRef.createElement = () => createFakeElement('div');
  const windowRef = {
    innerWidth: 800,
    innerHeight: 600,
    listeners: {},
    addEventListener(type, handler) {
      (this.listeners[type] ??= []).push(handler);
    },
    removeEventListener() {},
    dispatch() {},
  };
  const errors = [];

  const view = createFileLibraryView({
    listElement,
    scrollElement,
    emptyElement,
    menuElement,
    platform: 'windows',
    onOpen: () => {},
    onRemove: () => {
      throw new Error('移出失败');
    },
    onError: error => errors.push(error),
    documentRef,
    windowRef,
  });

  view.render(['C:\\docs\\readme.md'], '');
  const [row] = listElement.children;
  const [button] = row.children;
  button.dispatch('contextmenu', {
    preventDefault() {},
    clientX: 10,
    clientY: 10,
    target: {},
  });

  menuElement.dispatch('click', {
    target: { closest: selector => (selector === '[data-action]' ? removeItem : null) },
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(errors.length, 1);
  assert.equal(errors[0].message, '移出失败');
  assert.equal(menuElement.classList.contains('hidden'), true);
});

test('trash confirmation message includes recovery note and dirty warning', () => {
  const base = { path: 'C:/docs/a.md', currentPath: 'C:/docs/b.md', isDirty: false, platform: 'windows' };
  const plain = buildTrashConfirmationMessage(base);
  assert.match(plain, /a\.md/);
  assert.match(plain, /系统回收站恢复/);
  assert.doesNotMatch(plain, /未保存修改/);

  assert.match(
    buildTrashConfirmationMessage({ ...base, currentPath: 'c:/docs/a.md', isDirty: true }),
    /未保存修改/,
  );
});

test('requestTrash cancels without invoking backend and reports backend rejection', async () => {
  let backendCalls = 0;
  const common = {
    path: 'C:/docs/a.md',
    currentPath: 'C:/docs/a.md',
    isDirty: true,
    platform: 'windows',
    trashFile: async () => {
      backendCalls += 1;
      return { trashed: true, files: [], cleanupWarning: null };
    },
  };

  assert.deepEqual(await requestTrash({ ...common, confirmTrash: async () => false }), {
    status: 'cancelled',
  });
  assert.equal(backendCalls, 0);

  const result = await requestTrash({ ...common, confirmTrash: async () => true });
  assert.equal(result.status, 'trashed');
  assert.equal(backendCalls, 1);
  assert.deepEqual(result.outcome.files, []);

  await assert.rejects(
    () =>
      requestTrash({
        ...common,
        confirmTrash: async () => true,
        trashFile: async () => {
          throw new Error('后端拒绝');
        },
      }),
    /后端拒绝/,
  );
});

test('applyTrashedOutcome separates recycle success from UI commit failure', async () => {
  const applied = await applyTrashedOutcome(
    { trashed: true, files: ['C:/other.md'], cleanupWarning: null },
    async () => {},
  );
  assert.equal(applied.status, 'applied');

  const uiResult = await applyTrashedOutcome(
    { trashed: true, files: [], cleanupWarning: null },
    async () => {
      throw new Error('界面提交失败');
    },
  );
  assert.equal(uiResult.status, 'ui_failed');
  assert.equal(uiResult.outcome.trashed, true);
});

test('view dispatches the trash action to the injected onTrash callback', async () => {
  const listElement = createFakeElement('div');
  const emptyElement = createFakeElement();
  const scrollElement = createFakeElement();
  const menuElement = createFakeElement('div');
  menuElement.classList.add('hidden');
  const trashItem = createFakeElement('button');
  trashItem.setAttribute('role', 'menuitem');
  trashItem.dataset.action = 'trash';
  menuElement.children.push(trashItem);
  const documentRef = createFakeElement('document');
  documentRef.createElement = () => createFakeElement('div');
  const windowRef = {
    innerWidth: 800,
    innerHeight: 600,
    listeners: {},
    addEventListener() {},
    removeEventListener() {},
    dispatch() {},
  };
  const trashed = [];

  const view = createFileLibraryView({
    listElement,
    scrollElement,
    emptyElement,
    menuElement,
    platform: 'windows',
    onOpen: () => {},
    onRemove: () => {},
    onTrash: path => trashed.push(path),
    onError: () => {},
    documentRef,
    windowRef,
  });

  view.render(['C:/docs/readme.md'], '');
  const [row] = listElement.children;
  const [button] = row.children;
  button.dispatch('contextmenu', {
    preventDefault() {},
    clientX: 10,
    clientY: 10,
    target: {},
  });

  menuElement.dispatch('click', {
    target: { closest: selector => (selector === '[data-action]' ? trashItem : null) },
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(trashed, ['C:/docs/readme.md']);
});
