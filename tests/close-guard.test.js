import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createCloseGuard,
  decideCloseRequest,
  resolveCloseDecision,
} from '../src/js/close-guard.js';

function guardHarness(overrides = {}) {
  const calls = { dialogs: 0, saves: 0, closes: 0, errors: 0 };
  const state = {
    isDirty: true,
    isReadOnly: false,
    hasDocument: true,
    saveSucceeds: true,
    dialogAnswer: 'save',
    ...overrides,
  };

  const guard = createCloseGuard({
    getState: () => ({
      isDirty: state.isDirty,
      isReadOnly: state.isReadOnly,
      hasDocument: state.hasDocument,
    }),
    showDialog: async () => {
      calls.dialogs += 1;
      return state.dialogAnswer;
    },
    saveFile: async () => {
      calls.saves += 1;
      return state.saveSucceeds;
    },
    performClose: async () => {
      calls.closes += 1;
    },
    onSaveError: () => {
      calls.errors += 1;
    },
  });

  return { guard, calls, state };
}

test('a clean document closes without prompting', () => {
  assert.deepEqual(
    decideCloseRequest({ isDirty: false, isReadOnly: false, hasDocument: true, closeInProgress: false }),
    { action: 'allow' },
  );
});

test('no open document closes without prompting', () => {
  assert.deepEqual(
    decideCloseRequest({ isDirty: true, isReadOnly: false, hasDocument: false, closeInProgress: false }),
    { action: 'allow' },
  );
});

test('a read-only document is never dirty, so it closes silently', () => {
  assert.deepEqual(
    decideCloseRequest({ isDirty: true, isReadOnly: true, hasDocument: true, closeInProgress: false }),
    { action: 'allow' },
  );
});

test('an in-flight close is not blocked by its own guard', () => {
  assert.deepEqual(
    decideCloseRequest({ isDirty: true, isReadOnly: false, hasDocument: true, closeInProgress: true }),
    { action: 'allow' },
  );
});

test('a dirty editable document prompts', () => {
  assert.deepEqual(
    decideCloseRequest({ isDirty: true, isReadOnly: false, hasDocument: true, closeInProgress: false }),
    { action: 'prompt' },
  );
});

test('cancelling keeps the application open', () => {
  assert.deepEqual(resolveCloseDecision('cancel'), { action: 'stay' });
  assert.deepEqual(resolveCloseDecision(undefined), { action: 'stay' });
});

test('discarding closes without saving', () => {
  assert.deepEqual(resolveCloseDecision('discard'), { action: 'close' });
});

test('saving closes only when the save actually succeeded', () => {
  assert.deepEqual(
    resolveCloseDecision('save', { saveSucceeded: true }),
    { action: 'close' },
  );
  assert.deepEqual(
    resolveCloseDecision('save', { saveSucceeded: false }),
    { action: 'stay' },
    '保存失败必须留在应用里，否则用户以为存上了',
  );
});

test('a clean document closes the window without any dialog', async () => {
  const { guard, calls } = guardHarness({ isDirty: false });

  const result = await guard.handleRequest();

  assert.deepEqual(result, { action: 'allow' });
  assert.equal(calls.dialogs, 0);
  assert.equal(calls.closes, 1);
});

test('a dirty document saves then closes on confirmation', async () => {
  const { guard, calls } = guardHarness({ dialogAnswer: 'save' });

  const result = await guard.handleRequest();

  assert.deepEqual(result, { action: 'allow' });
  assert.equal(calls.dialogs, 1);
  assert.equal(calls.saves, 1);
  assert.equal(calls.closes, 1);
});

test('a failed save keeps the application open', async () => {
  const { guard, calls } = guardHarness({ dialogAnswer: 'save', saveSucceeds: false });

  const result = await guard.handleRequest();

  assert.deepEqual(result, { action: 'deny' });
  assert.equal(calls.closes, 0, '保存失败不得关闭');
  assert.equal(calls.errors, 1);
});

test('discarding closes without saving', async () => {
  const { guard, calls } = guardHarness({ dialogAnswer: 'discard' });

  const result = await guard.handleRequest();

  assert.deepEqual(result, { action: 'allow' });
  assert.equal(calls.saves, 0, '选择放弃时不得保存');
  assert.equal(calls.closes, 1);
});

test('cancelling denies the close and leaves state intact', async () => {
  const { guard, calls } = guardHarness({ dialogAnswer: 'cancel' });

  const result = await guard.handleRequest();

  assert.deepEqual(result, { action: 'deny' });
  assert.equal(calls.saves, 0);
  assert.equal(calls.closes, 0);
  assert.equal(guard.isClosing(), false);
});

test('a second request during an in-flight close is not blocked or re-closed', async () => {
  const { guard, calls } = guardHarness({ dialogAnswer: 'save' });

  await guard.handleRequest();
  // 保存并关闭后守卫已标记 in-flight：重复请求放行但不重复触发真实关闭。
  const second = await guard.handleRequest();

  assert.deepEqual(second, { action: 'allow' });
  assert.equal(calls.dialogs, 1, '关闭流程中不得重复弹窗');
  assert.equal(calls.closes, 1, '对同一窗口不得重复触发关闭');
});

test('read-only documents never prompt', async () => {
  const { guard, calls } = guardHarness({ isDirty: true, isReadOnly: true });

  const result = await guard.handleRequest();

  assert.deepEqual(result, { action: 'allow' });
  assert.equal(calls.dialogs, 0);
});
