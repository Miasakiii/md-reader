import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyExternalChange,
  createExternalChangeWatcher,
  planReload,
} from '../src/js/external-change.js';

function watcherHarness(overrides = {}) {
  const calls = { invoke: [], listen: [], onNotify: [] };
  let clock = 1000;
  const state = {
    filePath: 'C:/docs/guide.md',
    nativeFile: true,
    renderMode: 'markdown',
    documentGeneration: 7,
    readOnly: false,
    isDirty: false,
    ...overrides.state,
  };

  const watcher = createExternalChangeWatcher({
    invoke: async (command, payload) => {
      calls.invoke.push({ command, payload });
      return null;
    },
    listen: async () => {
      calls.listen.push(true);
      return () => {};
    },
    getDocumentState: () => state,
    onNotify: notification => calls.onNotify.push(notification),
    reload: () => calls.onNotify.push({ reloaded: true }),
    now: () => clock,
  });

  return { watcher, calls, state, advance: ms => { clock += ms; } };
}

test('an event for the current document produces a notification', () => {
  const outcome = classifyExternalChange({
    changedPath: 'C:/docs/guide.md',
    documentPath: 'C:/docs/guide.md',
  });

  assert.deepEqual(outcome, { action: 'notify', readOnly: false });
});

test('paths are compared case-insensitively and across slash styles', () => {
  const outcome = classifyExternalChange({
    changedPath: 'c:\\DOCS\\guide.md',
    documentPath: 'C:/docs/guide.md',
  });

  assert.equal(outcome.action, 'notify');
});

test('the windows extended-length prefix does not break path comparison', () => {
  const outcome = classifyExternalChange({
    changedPath: '\\\\?\\C:\\docs\\guide.md',
    documentPath: 'C:/docs/guide.md',
  });

  assert.equal(outcome.action, 'notify');
});

test('events for other documents are ignored', () => {
  const outcome = classifyExternalChange({
    changedPath: 'C:/docs/other.md',
    documentPath: 'C:/docs/guide.md',
  });

  assert.deepEqual(outcome, { action: 'ignore', reason: 'other-document' });
});

test('events without an open document are ignored', () => {
  assert.deepEqual(
    classifyExternalChange({
      changedPath: 'C:/docs/guide.md',
      documentPath: null,
    }),
    { action: 'ignore', reason: 'no-document' },
  );
  assert.equal(
    classifyExternalChange({ changedPath: null, documentPath: 'C:/docs/guide.md' }).action,
    'ignore',
  );
});

test('reloading the same document does not silence later events', () => {
  // 回归用例：曾用 documentGeneration 作守卫，但重载同一文件也会让代次
  // 递增（实测 1 → 2），导致第一次提示后再改动全部被判为 stale-generation
  // 丢弃。现在只看路径，重载后的事件必须照常提示。
  const outcome = classifyExternalChange({
    changedPath: 'C:/docs/guide.md',
    documentPath: 'C:/docs/guide.md',
  });

  assert.equal(outcome.action, 'notify');
});

test('classifyExternalChange ignores generation arguments entirely', () => {
  // 负向保证：即便调用方传了互相矛盾的代次，也不得影响判定。
  // 少了这一条，上面那条回归用例就抓不住「代次守卫」缺陷。
  const base = { changedPath: 'C:/docs/guide.md', documentPath: 'C:/docs/guide.md' };

  for (const extra of [
    { generation: 1, snapshotGeneration: 2 },
    { generation: 9, snapshotGeneration: 1 },
    { generation: 0, snapshotGeneration: 0 },
  ]) {
    const outcome = classifyExternalChange({ ...base, ...extra });
    assert.equal(
      outcome.action,
      'notify',
      `代次参数 ${JSON.stringify(extra)} 不得影响判定`
    );
  }
});

test('read-only documents still notify but are marked', () => {
  const outcome = classifyExternalChange({
    changedPath: 'C:/docs/app.log',
    documentPath: 'C:/docs/app.log',


    readOnly: true,
  });

  assert.deepEqual(outcome, { action: 'notify', readOnly: true });
});

test('a dirty document still notifies, carrying the draft flag', async () => {
  const { watcher, calls } = watcherHarness({ state: { isDirty: true } });

  await watcher.handleEvent('C:/docs/guide.md');

  assert.equal(calls.onNotify.length, 1);
  assert.equal(calls.onNotify[0].hasDraft, true);
});

test('watching starts for a native markdown document', async () => {
  const { watcher, calls } = watcherHarness();

  await watcher.start();

  assert.deepEqual(calls.invoke, [
    { command: 'watch_document_command', payload: { documentPath: 'C:/docs/guide.md' } },
  ]);
  assert.equal(watcher.isWatching(), true);
});

test('watching is skipped for browser-sourced and plain-text documents', async () => {
  const browser = watcherHarness({ state: { nativeFile: false } });
  await browser.watcher.start();
  assert.deepEqual(browser.calls.invoke, []);

  const plain = watcherHarness({ state: { renderMode: 'plain' } });
  await plain.watcher.start();
  assert.deepEqual(plain.calls.invoke, []);
});

test('watching the same document twice does not re-invoke the backend', async () => {
  const { watcher, calls } = watcherHarness();

  await watcher.start();
  await watcher.start();

  assert.equal(calls.invoke.filter(c => c.command === 'watch_document_command').length, 1);
});

test('switching documents unwatches the previous one first', async () => {
  const { watcher, calls, state } = watcherHarness();

  await watcher.start();
  state.filePath = 'C:/docs/other.md';
  await watcher.start();

  const commands = calls.invoke.map(c => c.command);
  assert.deepEqual(commands, [
    'watch_document_command',
    'unwatch_document_command',
    'watch_document_command',
  ]);
  assert.equal(calls.invoke[1].payload.documentPath, 'C:/docs/guide.md');
});

test('a failed watch does not leave the controller thinking it is watching', async () => {
  let clock = 1000;
  const watcher = createExternalChangeWatcher({
    invoke: async command => {
      if (command === 'watch_document_command') throw new Error('boom');
      return null;
    },
    listen: async () => () => {},
    getDocumentState: () => ({
      filePath: 'C:/docs/guide.md',
      nativeFile: true,
      renderMode: 'markdown',
      documentGeneration: 1,
      readOnly: false,
      isDirty: false,
    }),
    onNotify: () => {},
    now: () => clock,
  });

  await watcher.start();
  assert.equal(watcher.isWatching(), false);
});

test('events inside the self-save window are not treated as external changes', async () => {
  const { watcher, calls, advance } = watcherHarness();

  await watcher.start();
  await watcher.registerSelfSave();

  await watcher.handleEvent('C:/docs/guide.md');
  assert.equal(calls.onNotify.length, 0, '保存后立刻回来的事件必须被抑制');

  // 窗口外的事件仍应提示。
  advance(1500);
  await watcher.handleEvent('C:/docs/guide.md');
  assert.equal(calls.onNotify.length, 1);
});

test('self-save suppression is scoped to the saved window only', async () => {
  const { watcher, calls, advance } = watcherHarness();

  await watcher.start();
  await watcher.registerSelfSave();
  advance(1300);
  await watcher.handleEvent('C:/docs/guide.md');

  assert.equal(calls.onNotify.length, 1);
  assert.ok(
    calls.invoke.some(c => c.command === 'register_self_save_command'),
    '后端抑制登记必须真的发出，否则后端会emit 事件',
  );
});

test('reload with a draft requires the unsaved-changes guard', () => {
  assert.equal(planReload({ hasDraft: false }), 'reload');
  assert.equal(planReload({ hasDraft: true }), 'guard');
  assert.equal(
    planReload({ hasDraft: true, isEditorSnapshotCurrentGuard: false }),
    'reload',
    '编辑器快照已失效时（已切换文档）可直接重载',
  );
});

test('a late event arriving after a document switch is ignored', async () => {
  const { watcher, calls, state } = watcherHarness();

  await watcher.start();
  // 切换文档：代次 +1，路径也变。
  state.documentGeneration = 8;
  state.filePath = 'C:/docs/other.md';

  // 旧文档的迟到事件：路径已不匹配，且代次已变。
  await watcher.handleEvent('C:/docs/guide.md');

  assert.equal(calls.onNotify.length, 0);
});

test('an event arriving before start() is still surfaced', async () => {
  const { watcher, calls } = watcherHarness();

  // 未 start 就收到事件：不应被静默吞掉。
  await watcher.handleEvent('C:/docs/guide.md');

  assert.equal(calls.onNotify.length, 1);
});

test('a document generation bump alone never silences events', async () => {
  // 回归：重载同一文档会让 documentGeneration 递增，但事件仍属当前文档。
  // 守卫只看路径——代次变化不得导致静默。
  const { watcher, calls, state } = watcherHarness();

  await watcher.start();
  state.documentGeneration += 1; // 模拟重载后的代次递增

  await watcher.handleEvent('C:/docs/guide.md');
  assert.equal(calls.onNotify.length, 1, '代次递增后事件必须照常提示');

  state.documentGeneration += 5;
  await watcher.handleEvent('C:/docs/guide.md');
  assert.equal(calls.onNotify.length, 2, '反复重载也不应静音');
});

test('repeated external edits keep notifying after a reload', async () => {
  // 端到端复现用户场景：改 → 重载 → 再改 → 再改，每次都应提示。
  const { watcher, calls, state } = watcherHarness();

  await watcher.start();
  await watcher.handleEvent('C:/docs/guide.md');
  assert.equal(calls.onNotify.length, 1);

  // 重载：路径不变，代次递增。
  state.documentGeneration += 1;
  await watcher.handleEvent('C:/docs/guide.md');
  assert.equal(calls.onNotify.length, 2, '重载后的第一次改动必须提示');

  await watcher.handleEvent('C:/docs/guide.md');
  assert.equal(calls.onNotify.length, 3, '连续改动都必须提示');
});
