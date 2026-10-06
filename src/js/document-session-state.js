/**
 * 文档会话：把「当前打开的文档」的全部状态收进一个可实例化的对象。
 *
 * ## 为什么要抽
 *
 * `app.js` 原来用一个模块级 `state` 对象持有 29 个字段，其中约 17 个是
 * 文档级（随打开的文档变化）。多标签页会同时存在多份「当前文档」，
 * 单个扁平对象会逼出三套互相打架的引用。这是本项目当前最大的架构约束，
 * 本模块是拆解它的第一步——**纯重构，不改任何 UI 行为**。
 *
 * ## 字段归属（依实测证据划分，非直觉）
 *
 * **文档级**（每个标签各自一份）：`filePath`、`nativeFile`、`rawContent`、
 * `persistedContent`、`kind`、`renderMode`、`readOnly`、`toc`、`sizeBytes`、
 * `encoding`、`isDirty`、`documentGeneration`、`editRevision`、
 * `isEditMode`、`allowedAssets`、`scrollSaveTimer`。
 *
 * `isEditMode` 归属文档级有实测依据：切文档时 `app.js:678` 把它重置为
 * false，即它跟文档走而不是跟应用走。
 *
 * **应用级**（跨标签共享）：`theme`、`fontSize`、`fullWidth`、
 * `activeSidePanel`、`libraryFiles`、`libraryError`、`platform`。
 *
 * **待定**（暂留 app.js 的 `state`，语义上可能随标签走，但当前无需求）：
 * `documentSwitchPending`、`savePending`、`fileSelectionPending`、
 * `searchVisible`、`searchResults`、`searchIndex`。
 *
 * 搜索三件套的处理是刻意的：实测切文档时走 `clearSearch()` 清空重建
 * （`app.js:1027`），而非切换到另一个索引。多标签下若要「每个标签保留
 * 自己的搜索位置」，需先定义清楚切标签时是否恢复——这属于 3b 的设计
 * 决策，不在本次重构里预设。
 */

import { isDraftDirty, reconcileSavedEditorState } from './document-session.js';

/** 文档级字段的初始值。 */
function initialDocumentState(overrides = {}) {
  return {
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
    // 代次从 1 起：0 表示「尚未打开任何文档」，便于用真值判断。
    documentGeneration: 0,
    editRevision: 0,
    isEditMode: false,
    allowedAssets: [],
    scrollSaveTimer: null,
    ...overrides,
  };
}

/**
 * 创建文档会话控制器。
 *
 * 状态用闭包持有而非暴露可变引用：多标签下「谁能改这份状态」必须清晰，
 * 否则会出现某个标签的逻辑改到另一个标签的数据。
 */
export function createDocumentSession({ onChange = () => {} } = {}) {
  let doc = initialDocumentState();

  function snapshot() {
    return { ...doc };
  }

  /** 当前是否有已打开的文档。 */
  function isOpen() {
    return doc.filePath !== null;
  }

  /**
   * 打开新文档。代次自增，使所有在途的异步回调（保存、监听事件、
   * 编辑器快照）能凭代次判定自己已过期。
   */
  function open(document, { nativeFile = false } = {}) {
    doc = initialDocumentState({
      filePath: document.path ?? null,
      nativeFile,
      rawContent: String(document.content ?? ''),
      persistedContent: String(document.content ?? ''),
      kind: document.kind ?? null,
      renderMode: document.renderMode ?? null,
      readOnly: Boolean(document.readOnly),
      toc: Boolean(document.toc),
      sizeBytes: Number(document.sizeBytes ?? 0),
      encoding: document.encoding ?? 'UTF-8',
      documentGeneration: doc.documentGeneration + 1,
    });
    onChange('open', snapshot());
    return snapshot();
  }

  /** 关闭当前文档，回到「无文档」状态。代次继续递增，使旧回调失效。 */
  function close() {
    doc = initialDocumentState({ documentGeneration: doc.documentGeneration + 1 });
    onChange('close', snapshot());
    return snapshot();
  }

  /** 是否可以进入编辑态：只读文档与未打开文档都不行。 */
  function canEdit() {
    return isOpen() && !doc.readOnly;
  }

  function toggleEditMode() {
    if (!canEdit()) return snapshot();
    doc.isEditMode = !doc.isEditMode;
    if (!doc.isEditMode) {
      // 回到阅读态时，编辑框内容以当前磁盘内容为准。
      doc.rawContent = doc.persistedContent;
    }
    onChange('edit-mode', snapshot());
    return snapshot();
  }

  /**
   * 记录一次编辑。修订号自增，异步守卫凭它判定编辑器快照是否过期。
   */
  function markEdited(content) {
    doc.editRevision += 1;
    doc.rawContent = String(content ?? '');
    doc.isDirty = isDraftDirty(doc.rawContent, doc.persistedContent);
    onChange('edit', snapshot());
    return snapshot();
  }

  /**
   * 保存成功后的状态归并。保留比保存请求更新的编辑（用户在保存过程中
   * 继续输入），这与既有 `reconcileSavedEditorState` 语义一致。
   */
  function reconcileSave({ savedContent, currentContent }) {
    const merged = reconcileSavedEditorState({
      savedContent,
      currentEditorContent: currentContent,
    });
    doc.persistedContent = merged.persistedContent;
    doc.rawContent = merged.rawContent;
    doc.isDirty = merged.isDirty;
    onChange('save', snapshot());
    return { ...merged, generation: doc.documentGeneration };
  }

  /** 文件在外部被改动：只更新磁盘侧与脏标记，不动正在编辑的草稿。 */
  function markExternallyChanged() {
    doc.isDirty = true;
    onChange('external-change', snapshot());
    return snapshot();
  }

  function setAllowedAssets(assets) {
    doc.allowedAssets = Array.isArray(assets) ? [...assets] : [];
    onChange('assets', snapshot());
    return snapshot();
  }

  /**
   * 只更新编码，**不**推进代次。
   *
   * 刻意不提供通用的 `update(fields)`：编码在打开流程中于内容就绪之后才
   * 单独确定，若借 `open()` 或推进代次的通用更新来写它，会让所有在途的
   * 保存 / 滚动 / 监听回调误判为过期。代次只应在「换文档」与「关文档」时
   * 推进。
   */
  function setEncoding(encoding) {
    doc.encoding = encoding || 'UTF-8';
    onChange('encoding', snapshot());
    return snapshot();
  }

  function setScrollSaveTimer(timer) {
    doc.scrollSaveTimer = timer;
    return timer;
  }

  /** 某代次下编辑器快照是否仍然有效——供异步回调守卫复用。 */
  function isEditorSnapshotCurrent(snapshot) {
    return (
      !doc.readOnly &&
      snapshot?.generation === doc.documentGeneration &&
      snapshot?.revision === doc.editRevision
    );
  }

  function currentGeneration() {
    return doc.documentGeneration;
  }

  return {
    snapshot,
    isOpen,
    canEdit,
    open,
    close,
    toggleEditMode,
    markEdited,
    reconcileSave,
    markExternallyChanged,
    setAllowedAssets,
    setEncoding,
    setScrollSaveTimer,
    isEditorSnapshotCurrent,
    currentGeneration,
  };
}

/**
 * 从既有扁平状态构造文档会话——3a 期间的兼容层。
 *
 * 重构分两步：先把字段搬进会话对象（本步），再把 `app.js` 的
 * `state.xxx` 改写为 `session.snapshot().xxx`（后续步骤）。此函数保证
 * 迁移过程中两边数据一致，且迁移是可回退的。
 */
export function adoptDocumentState(session, flatState) {
  const current = session.snapshot();
  const next = {
    ...current,
    filePath: flatState.filePath,
    nativeFile: flatState.nativeFile,
    rawContent: flatState.rawContent,
    persistedContent: flatState.persistedContent,
    kind: flatState.kind,
    renderMode: flatState.renderMode,
    readOnly: flatState.readOnly,
    toc: flatState.toc,
    sizeBytes: flatState.sizeBytes,
    encoding: flatState.encoding,
    isDirty: flatState.isDirty,
    documentGeneration: flatState.documentGeneration,
    editRevision: flatState.editRevision,
    isEditMode: flatState.isEditMode,
    allowedAssets: flatState.allowedAssets,
    scrollSaveTimer: flatState.scrollSaveTimer,
  };
  return { ...next, isDirty: isDraftDirty(next.rawContent, next.persistedContent) };
}
