import assert from 'node:assert/strict';
import test from 'node:test';

import {
  adoptDocumentState,
  createDocumentSession,
} from '../src/js/document-session-state.js';

function openSample(session, overrides = {}) {
  return session.open(
    {
      path: 'C:/docs/guide.md',
      content: '# 指南\n\n正文',
      kind: 'markdown',
      renderMode: 'markdown',
      readOnly: false,
      toc: true,
      sizeBytes: 24,
      encoding: 'UTF-8',
      ...overrides,
    },
    { nativeFile: true },
  );
}

test('a fresh session has no open document', () => {
  const session = createDocumentSession();

  assert.equal(session.isOpen(), false);
  assert.equal(session.canEdit(), false);
  assert.equal(session.snapshot().filePath, null);
});

test('opening a document records its type and identity', () => {
  const session = createDocumentSession();
  const doc = openSample(session);

  assert.equal(session.isOpen(), true);
  assert.equal(doc.filePath, 'C:/docs/guide.md');
  assert.equal(doc.renderMode, 'markdown');
  assert.equal(doc.toc, true);
  assert.equal(doc.nativeFile, true);
  assert.equal(doc.isDirty, false);
});

test('the generation advances on open so stale callbacks are rejected', () => {
  const session = createDocumentSession();

  const first = openSample(session);
  const second = openSample(session, { path: 'C:/docs/other.md' });

  assert.equal(second.documentGeneration > first.documentGeneration, true);
});

test('a closed session advances the generation too', () => {
  const session = createDocumentSession();
  const opened = openSample(session);
  const closed = session.close();

  assert.equal(closed.documentGeneration > opened.documentGeneration, true);
  assert.equal(session.isOpen(), false);
});

test('read-only documents report they cannot be edited', () => {
  const session = createDocumentSession();
  openSample(session, { readOnly: true, path: 'C:/logs/app.log', renderMode: 'plain' });

  // 守卫属调用方（app 层负责提示）；setEditMode 不做静默拒绝，
  // 否则 state 镜像与 UI 会分叉。
  assert.equal(session.canEdit(), false);
  assert.equal(session.snapshot().isEditMode, false);
});

test('setEditMode stores the caller-decided value and keeps the draft on exit', () => {
  const session = createDocumentSession();
  openSample(session);

  assert.equal(session.setEditMode(true).isEditMode, true);

  session.markEdited('# 指南\n\n改过的正文');
  const afterEdit = session.setEditMode(false);

  assert.equal(afterEdit.isEditMode, false);
  // 退出编辑态保留草稿：退出未保存提醒依赖草稿仍在。
  assert.equal(afterEdit.rawContent, '# 指南\n\n改过的正文');
  assert.notEqual(afterEdit.rawContent, afterEdit.persistedContent);
});

test('editing marks the document dirty only when content actually differs', () => {
  const session = createDocumentSession();
  openSample(session);

  session.markEdited('# 指南\n\n正文');
  assert.equal(session.snapshot().isDirty, false, '内容未变不应算脏');

  session.markEdited('# 指南\n\n真正改过的正文');
  assert.equal(session.snapshot().isDirty, true);
});

test('saving keeps edits made while the save was in flight', () => {
  const session = createDocumentSession();
  openSample(session);

  const merged = session.reconcileSave({
    savedContent: '# 指南\n\n正文',
    currentContent: '# 指南\n\n保存期间又改的内容',
  });

  assert.equal(merged.persistedContent, '# 指南\n\n正文');
  assert.equal(merged.isDirty, true, '保存期间的新编辑必须保留为脏');
  assert.equal(merged.previewContent, '# 指南\n\n保存期间又改的内容');
});

test('a save with no newer edits clears the dirty flag', () => {
  const session = createDocumentSession();
  openSample(session);

  const merged = session.reconcileSave({
    savedContent: '# 指南\n\n正文',
    currentContent: '# 指南\n\n正文',
  });

  assert.equal(merged.isDirty, false);
});

test('the editor snapshot guard rejects a stale revision', () => {
  const session = createDocumentSession();
  openSample(session);

  const snapshot = { generation: session.currentGeneration(), revision: 0 };
  assert.equal(session.isEditorSnapshotCurrent(snapshot), true);

  session.markEdited('改动');
  assert.equal(
    session.isEditorSnapshotCurrent(snapshot),
    false,
    '修订号变化后旧快照必须失效',
  );
});

test('the editor snapshot guard rejects a snapshot from a previous document', () => {
  const session = createDocumentSession();
  const opened = openSample(session);
  const stale = { generation: opened.documentGeneration, revision: 0 };

  openSample(session, { path: 'C:/docs/other.md' });

  assert.equal(session.isEditorSnapshotCurrent(stale), false);
});

test('two sessions never share state', () => {
  const a = createDocumentSession();
  const b = createDocumentSession();

  openSample(a, { path: 'C:/docs/a.md', content: '# A' });
  openSample(b, { path: 'C:/docs/b.md', content: '# B' });

  a.markEdited('# A\n\nA 被改过');
  b.markEdited('# B\n\nB 被改过');

  assert.equal(a.snapshot().rawContent, '# A\n\nA 被改过');
  assert.equal(b.snapshot().rawContent, '# B\n\nB 被改过');

  a.close();
  assert.equal(b.isOpen(), true, '关闭 A 不得影响 B');
  assert.equal(b.snapshot().rawContent, '# B\n\nB 被改过');
});

test('generations are per-session, not globally unique', () => {
  const a = createDocumentSession();
  const b = createDocumentSession();

  openSample(a);
  openSample(a);
  openSample(a);
  openSample(b);

  // 代次只在会话内有意义：app.js 全部比较都是「同一份 state 内部」的
  // 自比对（`const g = state.documentGeneration` 再与自身比），从不跨会话。
  // 因此 A 开了三次、B 开一次时不等，是正确行为而非缺陷。
  assert.equal(a.snapshot().documentGeneration, 3);
  assert.equal(b.snapshot().documentGeneration, 1);

  // 关键性质是各自独立累加：A 的推进不改变 B 的代次，B 的快照也不受 A 影响。
  const beforeB = b.snapshot().documentGeneration;
  a.open({ path: 'C:/docs/4th.md', content: '# 4' }, { nativeFile: true });
  assert.equal(b.snapshot().documentGeneration, beforeB, 'A 推进不得改变 B 的代次');

  assert.equal(
    a.isEditorSnapshotCurrent({ generation: 3, revision: 0 }),
    false,
    'A 的旧代次快照在 A 内失效',
  );
  assert.equal(
    b.isEditorSnapshotCurrent({ generation: 1, revision: 0 }),
    true,
    'B 不受 A 的代次变化影响',
  );
});

test('allowed assets are copied so external mutation cannot leak in', () => {
  const session = createDocumentSession();
  openSample(session);

  const source = ['C:/docs/a.png'];
  session.setAllowedAssets(source);
  source.push('C:/docs/b.png');

  assert.deepEqual(session.snapshot().allowedAssets, ['C:/docs/a.png']);
});

test('the change hook reports the transition and a snapshot', () => {
  const events = [];
  const session = createDocumentSession({ onChange: (kind, doc) => events.push([kind, doc.filePath]) });

  openSample(session);
  session.markEdited('改动');
  session.reconcileSave({ savedContent: 'x', currentContent: 'y' });
  session.close();

  assert.deepEqual(events.map(([kind]) => kind), ['open', 'edit', 'save', 'close']);
});

test('adopting a flat state preserves every document-level field', () => {
  const session = createDocumentSession();
  const flat = {
    filePath: 'C:/docs/x.md',
    nativeFile: true,
    rawContent: '# X',
    persistedContent: '# X',
    kind: 'markdown',
    renderMode: 'markdown',
    readOnly: false,
    toc: true,
    sizeBytes: 12,
    encoding: 'UTF-8',
    isDirty: false,
    documentGeneration: 3,
    editRevision: 7,
    isEditMode: true,
    allowedAssets: ['C:/docs/a.png'],
    scrollSaveTimer: 'timer-1',
    // 应用级字段不参与迁移
    theme: 'dark',
    searchVisible: true,
  };

  const adopted = adoptDocumentState(session, flat);

  assert.equal(adopted.filePath, 'C:/docs/x.md');
  assert.equal(adopted.documentGeneration, 3);
  assert.equal(adopted.editRevision, 7);
  assert.equal(adopted.isEditMode, true);
  assert.deepEqual(adopted.allowedAssets, ['C:/docs/a.png']);
  assert.equal(adopted.scrollSaveTimer, 'timer-1');
  // 应用级字段不得被搬进文档会话。
  assert.equal('theme' in adopted, false);
  assert.equal('searchVisible' in adopted, false);
});

test('adopting recomputes the dirty flag from actual content', () => {
  const session = createDocumentSession();
  const adopted = adoptDocumentState(session, {
    filePath: 'C:/docs/x.md',
    rawContent: '已改内容',
    persistedContent: '磁盘内容',
    isDirty: false,
  });

  assert.equal(adopted.isDirty, true, '与磁盘不一致就是脏，不能信传入的 isDirty');
});

test('updating the encoding does not advance the generation', () => {
  // 关键不变量：代次只在换/关文档时推进。编码在打开流程中于内容就绪之后
  // 才单独确定，若用它推进代次，所有在途的保存/滚动/监听回调都会误判过期。
  const session = createDocumentSession();
  openSample(session);
  const before = session.currentGeneration();

  session.setEncoding('GB18030');

  assert.equal(session.currentGeneration(), before, '编码更新不得推进代次');
  assert.equal(session.snapshot().encoding, 'GB18030');
  assert.equal(
    session.isEditorSnapshotCurrent({ generation: before, revision: 0 }),
    true,
    '代次不变时编辑器快照仍有效',
  );
});

test('an empty encoding falls back to UTF-8', () => {
  const session = createDocumentSession();
  openSample(session);

  session.setEncoding('');
  assert.equal(session.snapshot().encoding, 'UTF-8');
});
