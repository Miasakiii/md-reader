/**
 * 当前文档的外部修改监听。
 *
 * 语义（见 `docs/superpowers/PROJECT_STATUS.md` 的「文件监控的两条决策」）：
 * 文档在应用之外被改动时**只提示 + 提供重载，不自动重载、不自动合并**。
 *
 * 关键约束：外部刷新**不得绕过未保存保护**。用户可能正在编辑器里写草稿，
 * 磁盘内容被外部改掉时若直接覆盖视图，草稿就没了。因此这里只置标志位，
 * 真正重载由用户显式触发。
 *
 * 不引入第二套并发原语：文档代次与修订号沿用 `document-session.js` 的
 * `documentGeneration` / `editRevision` 守卫，串行化沿用 `createSerialTaskQueue`。
 */

import { isEditorSnapshotCurrent } from './document-session.js';

/**
 * 外部改动事件的可测核心：从事件路径与当前状态推出下一步动作。
 *
 * 丢弃条件（任一命中即不提示）：
 * - 事件路径与当前文档不符（多文档或多窗口场景）；
 * - 当前无打开文档；
 * - 文档代次已变（事件来自上一个文档，切换后才到达）。
 *
 * `hasDraft` 不在这里阻断：带草稿时**仍要提示**，只是重载动作要走
 * 未保存保护，由调用方按 `documentGeneration` 决定，不能静默丢弃。
 */
export function classifyExternalChange({
  changedPath,
  documentPath,
  generation,
  snapshotGeneration,
  readOnly,
}) {
  // 无文档或事件不是当前文档：不是「当前文档被外部修改」。
  if (!documentPath || !changedPath) {
    return { action: 'ignore', reason: 'no-document' };
  }
  if (!samePath(changedPath, documentPath)) {
    return { action: 'ignore', reason: 'other-document' };
  }
  // 事件抵达时代次已变：属于旧文档的迟到通知。
  if (generation !== snapshotGeneration) {
    return { action: 'ignore', reason: 'stale-generation' };
  }
  // 只读文档（.log）不会被本应用写入，外部改动同样只提示。
  return { action: 'notify', readOnly: Boolean(readOnly) };
}

function samePath(a, b) {
  return normalizePath(a) === normalizePath(b);
}

/** Windows 大小写不敏感，且后端可能回传 `\\?\` 前缀与反斜杠。 */
function normalizePath(value) {
  return String(value ?? '')
    .trim()
    .replace(/^\\\\\?\\/, '')
    .replaceAll('\\', '/')
    .toLowerCase();
}

/**
 * 监听控制器。负责命令调用与事件订阅，状态判定全部委托给纯函数。
 */
export function createExternalChangeWatcher({
  invoke,
  listen,
  getDocumentState,
  onNotify,
  reload = () => {},
  now = () => Date.now(),
}) {
  let unwatchedPath = null;
  // 开始监听时的文档代次。事件本身不带代次，用它作快照基准即可识别
  // 「切换文档后才抵达的迟到通知」。
  let watchedGeneration = null;
  // 自保存抑制：与后端窗口对齐，前端也留一份，避免双击保存时的往返。
  const SELF_SAVE_WINDOW_MS = 1200;
  let lastSelfSaveAt = 0;

  async function watchCurrent() {
    const { filePath, nativeFile, renderMode } = getDocumentState();
    if (!filePath || !nativeFile || renderMode !== 'markdown') {
      await stopWatching();
      return;
    }
    if (unwatchedPath === filePath) return;
    await stopWatching();
    unwatchedPath = filePath;
    watchedGeneration = getDocumentState().documentGeneration;
    try {
      await invoke('watch_document_command', { documentPath: filePath });
    } catch (error) {
      // 监听失败不阻断阅读：外部提示是增强，不是必需能力。
      unwatchedPath = null;
      watchedGeneration = null;
      console.warn('External change watch failed:', error);
    }
  }

  async function stopWatching() {
    const previous = unwatchedPath;
    unwatchedPath = null;
    watchedGeneration = null;
    if (!previous) return;
    try {
      await invoke('unwatch_document_command', { documentPath: previous });
    } catch (error) {
      console.warn('External change unwatch failed:', error);
    }
  }

  /** 保存成功后登记抑制窗口，窗口内的同路径事件不再提示。 */
  function registerSelfSave() {
    lastSelfSaveAt = now();
    return invoke('register_self_save_command', {
      documentPath: getDocumentState().filePath ?? '',
    }).catch(error => console.warn('Self-save suppression failed:', error));
  }

  async function handleEvent(changedPath) {
    // 前端抑制窗口：保存后立刻回来的事件不算外部修改。
    // `lastSelfSaveAt` 为 0 表示本次会话还没保存过——此时**不得**抑制，
    // 否则会话刚开始的第一个外部事件会被误吞。
    if (lastSelfSaveAt > 0 && now() - lastSelfSaveAt < SELF_SAVE_WINDOW_MS) return;

    const state = getDocumentState();
    // 监听建立时的代次：事件抵达时若代次已变，说明是旧文档的迟到通知。
    // 后端事件不携带代次，故以「开始监听时记录的代次」为快照基准。
    // 兜底：尚未start() 就收到事件（时序竞态）时，以当前代次为准，
    // 不因此吞掉真实提示——漏报比多报更糟。
    const snapshotGeneration = watchedGeneration ?? state.documentGeneration;
    const outcome = classifyExternalChange({
      changedPath,
      documentPath: state.filePath,
      generation: snapshotGeneration,
      snapshotGeneration: state.documentGeneration,
      readOnly: state.readOnly,
    });
    if (outcome.action !== 'notify') return;

    onNotify?.({
      path: changedPath,
      hasDraft: Boolean(state.isDirty),
      readOnly: outcome.readOnly,
      reload,
    });
  }

  return {
    start: watchCurrent,
    stop: stopWatching,
    registerSelfSave,
    handleEvent,
    isWatching: () => unwatchedPath !== null,
  };
}

/**
 * 重载前的决策：带未保存草稿时必须走保护，不能静默覆盖。
 *
 * 返回 `reload` 表示可直接重载；返回 `guard` 表示需先让用户在
 * 「保存 / 放弃 / 取消」之间选择（复用既有 `guardDirtyDocumentSwitch`）。
 */
export function planReload({ hasDraft, isEditorSnapshotCurrentGuard }) {
  if (!hasDraft) return 'reload';
  if (isEditorSnapshotCurrentGuard === false) return 'reload';
  return 'guard';
}

export { isEditorSnapshotCurrent };
