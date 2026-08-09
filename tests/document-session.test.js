import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createSerialTaskQueue,
  createDocumentViewState,
  formatMiB,
  guardDirtyDocumentSwitch,
  isDraftDirty,
  isEditorSnapshotCurrent,
  openDocumentWithGuards,
  reconcileSavedEditorState,
} from '../src/js/document-session.js';

test('dirty document guard handles save, discard, cancel, and failed saves', async () => {
  assert.equal(await guardDirtyDocumentSwitch({ isDirty: false }), true);
  assert.equal(await guardDirtyDocumentSwitch({
    isDirty: true,
    decide: async () => 'discard',
  }), true);
  assert.equal(await guardDirtyDocumentSwitch({
    isDirty: true,
    decide: async () => 'cancel',
  }), false);
  assert.equal(await guardDirtyDocumentSwitch({
    isDirty: true,
    decide: async () => 'unknown',
  }), false);
  assert.equal(await guardDirtyDocumentSwitch({
    isDirty: true,
    decide: async () => 'save',
    save: async () => true,
  }), true);
  assert.equal(await guardDirtyDocumentSwitch({
    isDirty: true,
    decide: async () => 'save',
    save: async () => false,
  }), false);
  assert.equal(await guardDirtyDocumentSwitch({
    isDirty: true,
    decide: async () => 'save',
    save: async () => { throw new Error('write failed'); },
  }), false);
});

test('large log cancellation happens before dirty prompting or file reading', async () => {
  const calls = [];
  const result = await openDocumentWithGuards({
    path: '/logs/large.log',
    inspectDocument: async path => {
      calls.push(['inspect', path]);
      return {
        path,
        kind: 'log',
        sizeBytes: 10 * 1024 * 1024,
        requiresLargeFileConfirmation: true,
      };
    },
    confirmLargeLog: async inspection => {
      calls.push(['confirm', inspection.sizeBytes]);
      return false;
    },
    isDirty: true,
    decideDirtySwitch: async () => {
      calls.push(['dirty']);
      return 'discard';
    },
    readDocument: async () => {
      calls.push(['read']);
      return {};
    },
  });

  assert.deepEqual(result, { status: 'cancelled', reason: 'large-log' });
  assert.deepEqual(calls, [
    ['inspect', '/logs/large.log'],
    ['confirm', 10 * 1024 * 1024],
  ]);
});

test('confirmed large logs are read only after the dirty guard succeeds', async () => {
  const calls = [];
  const document = {
    path: '/logs/large.log',
    content: 'complete snapshot',
    kind: 'log',
    readOnly: true,
  };
  const result = await openDocumentWithGuards({
    path: document.path,
    inspectDocument: async () => ({
      ...document,
      sizeBytes: 10 * 1024 * 1024,
      requiresLargeFileConfirmation: true,
    }),
    confirmLargeLog: async () => {
      calls.push('confirm');
      return true;
    },
    isDirty: true,
    decideDirtySwitch: async () => {
      calls.push('dirty');
      return 'discard';
    },
    readDocument: async (path, allowLargeLog) => {
      calls.push(['read', path, allowLargeLog]);
      return document;
    },
  });

  assert.deepEqual(result, { status: 'opened', document });
  assert.deepEqual(calls, [
    'confirm',
    'dirty',
    ['read', '/logs/large.log', true],
  ]);
});

test('dirty state is evaluated after asynchronous inspection instead of snapshotted', async () => {
  let dirty = false;
  const calls = [];
  const result = await openDocumentWithGuards({
    path: '/notes/next.md',
    inspectDocument: async path => {
      dirty = true;
      return { path, requiresLargeFileConfirmation: false };
    },
    isDirty: () => dirty,
    decideDirtySwitch: async () => {
      calls.push('dirty');
      return 'cancel';
    },
    readDocument: async () => {
      calls.push('read');
      return {};
    },
  });

  assert.deepEqual(result, { status: 'cancelled', reason: 'dirty-switch' });
  assert.deepEqual(calls, ['dirty']);

  const cleanCalls = [];
  const cleanResult = await openDocumentWithGuards({
    path: '/notes/clean.md',
    inspectDocument: async path => ({ path, requiresLargeFileConfirmation: false }),
    isDirty: () => false,
    decideDirtySwitch: async () => {
      cleanCalls.push('dirty');
      return 'cancel';
    },
    readDocument: async () => {
      cleanCalls.push('read');
      return { path: '/notes/clean.md' };
    },
  });
  assert.equal(cleanResult.status, 'opened');
  assert.deepEqual(cleanCalls, ['read']);
});

test('a log that crosses the threshold after inspection is re-inspected and confirmed', async () => {
  const calls = [];
  let inspectionCount = 0;
  const document = { path: '/logs/growing.log', content: 'snapshot', kind: 'log', readOnly: true };

  const result = await openDocumentWithGuards({
    path: document.path,
    inspectDocument: async () => {
      inspectionCount += 1;
      calls.push(['inspect', inspectionCount]);
      return {
        path: document.path,
        kind: 'log',
        sizeBytes: inspectionCount === 1 ? 1024 : 10 * 1024 * 1024,
        requiresLargeFileConfirmation: inspectionCount > 1,
      };
    },
    confirmLargeLog: async inspection => {
      calls.push(['confirm', inspection.sizeBytes]);
      return true;
    },
    readDocument: async (_path, allowLargeLog) => {
      calls.push(['read', allowLargeLog]);
      if (!allowLargeLog) throw { code: 'large_log_confirmation_required' };
      return document;
    },
  });

  assert.deepEqual(result, { status: 'opened', document });
  assert.deepEqual(calls, [
    ['inspect', 1],
    ['read', false],
    ['inspect', 2],
    ['confirm', 10 * 1024 * 1024],
    ['read', true],
  ]);
});

test('read-only logs never populate hidden editing buffers and editable files recover controls', () => {
  const logState = createDocumentViewState({
    content: 'large log snapshot',
    readOnly: true,
    toc: false,
  });
  assert.deepEqual(logState, {
    editorDisabled: true,
    saveDisabled: true,
    tocDisabled: true,
    editorContent: '',
    previewContent: '',
  });

  const texState = createDocumentViewState({
    content: '\\section{Intro}',
    readOnly: false,
    toc: false,
  });
  assert.deepEqual(texState, {
    editorDisabled: false,
    saveDisabled: false,
    tocDisabled: true,
    editorContent: '\\section{Intro}',
    previewContent: '\\section{Intro}',
  });
});

test('large file size is formatted in binary MiB with one decimal place', () => {
  assert.equal(formatMiB(10 * 1024 * 1024), '10.0 MiB');
  assert.equal(formatMiB(10.05 * 1024 * 1024), '10.1 MiB');
});

test('serial task queue prevents overlap and recovers after a failed request', async () => {
  const enqueue = createSerialTaskQueue();
  const calls = [];
  let releaseFirst;
  const firstGate = new Promise(resolve => { releaseFirst = resolve; });

  const first = enqueue(async () => {
    calls.push('first:start');
    await firstGate;
    calls.push('first:fail');
    throw new Error('expected failure');
  });
  const second = enqueue(async () => {
    calls.push('second:start');
    return 'opened';
  });

  await Promise.resolve();
  assert.deepEqual(calls, ['first:start']);
  releaseFirst();
  await assert.rejects(first, /expected failure/);
  assert.equal(await second, 'opened');
  assert.deepEqual(calls, ['first:start', 'first:fail', 'second:start']);
});

test('save reconciliation preserves edits made while the write was in flight', () => {
  assert.deepEqual(reconcileSavedEditorState({
    savedContent: 'version A',
    currentEditorContent: 'version A',
    revisionAtStart: 3,
    currentRevision: 3,
  }), {
    persistedContent: 'version A',
    rawContent: 'version A',
    previewContent: 'version A',
    isDirty: false,
  });

  assert.deepEqual(reconcileSavedEditorState({
    savedContent: 'version A',
    currentEditorContent: 'version A',
    revisionAtStart: 3,
    currentRevision: 4,
  }).isDirty, false);

  assert.deepEqual(reconcileSavedEditorState({
    savedContent: 'version A',
    currentEditorContent: 'version B',
    revisionAtStart: 3,
    currentRevision: 4,
  }), {
    persistedContent: 'version A',
    rawContent: 'version A',
    previewContent: 'version B',
    isDirty: true,
  });
});

test('dirty tracking keeps the persisted baseline across edit/read mode changes', () => {
  const persistedContent = 'version A';
  let currentContent = 'version B';

  assert.equal(isDraftDirty(currentContent, persistedContent), true);

  // Leaving edit mode may copy the draft into the reader, but it must not
  // replace the last content known to be on disk.
  const readerContent = currentContent;
  currentContent = readerContent;
  assert.equal(isDraftDirty(currentContent, persistedContent), true);

  currentContent = persistedContent;
  assert.equal(isDraftDirty(currentContent, persistedContent), false);
});

test('deferred editor work is rejected after revision, document, or capability changes', () => {
  const snapshot = { generation: 2, revision: 5 };
  assert.equal(isEditorSnapshotCurrent(snapshot, {
    generation: 2,
    revision: 5,
    readOnly: false,
  }), true);
  assert.equal(isEditorSnapshotCurrent(snapshot, {
    generation: 3,
    revision: 5,
    readOnly: false,
  }), false);
  assert.equal(isEditorSnapshotCurrent(snapshot, {
    generation: 2,
    revision: 6,
    readOnly: false,
  }), false);
  assert.equal(isEditorSnapshotCurrent(snapshot, {
    generation: 2,
    revision: 5,
    readOnly: true,
  }), false);
});
