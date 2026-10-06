/**
 * 退出应用时的未保存保护。
 *
 * 与「切换文档」的未保存保护同源，但**不能直接复用**那个对话框：
 * 触发时机、确认后的动作（真关闭 vs 继续打开）都不同。
 *
 * 关键约束：Tauri 的关闭事件必须 `preventDefault()` 拦下，等用户决策后
 * 再真正关闭。若直接放行，决策就来不及了。
 */

/**
 * 关闭请求的决策核心（纯函数，便于测试）。
 *
 * 返回 `allow` 表示直接关闭；`prompt` 表示需要询问用户。
 */
export function decideCloseRequest({ isDirty, isReadOnly, hasDocument, closeInProgress }) {
  // 已经在关闭流程中：放行，避免拦截自己触发的关闭。
  if (closeInProgress) return { action: 'allow' };
  // 无文档、只读、或没有未保存修改：直接关。
  if (!hasDocument || isReadOnly || !isDirty) return { action: 'allow' };
  return { action: 'prompt' };
}

/**
 * 把用户的对话框选择翻译成关闭决策。
 *
 * 取消 → 继续用应用（不关闭）；放弃 → 关闭且不保存；保存 → 先保存，
 * **保存成功才关闭**——保存失败必须留在应用里，否则用户以为存上了。
 */
export function resolveCloseDecision(decision, { saveSucceeded = false } = {}) {
  switch (decision) {
    case 'save':
      return saveSucceeded ? { action: 'close' } : { action: 'stay' };
    case 'discard':
      return { action: 'close' };
    case 'cancel':
    default:
      return { action: 'stay' };
  }
}

/**
 * 装配关闭拦截。
 *
 * `onDialogResult` 复用既有的 `promptDialog`（原生 `<dialog>` + 降级路径）。
 * 浏览器预览下 `beforeunload` 作为补充，但那一条是浏览器自己画的框，
 * 文案不可控，仅作为兜底。
 */
export function createCloseGuard({
  getState,
  showDialog,
  saveFile,
  performClose,
  onSaveError = () => {},
}) {
  let closeInProgress = false;

  async function handleRequest() {
    // 关闭流程进行中：直接放行且**不再**调用 performClose——否则第二次
    // 请求会对同一窗口重复触发真实关闭。
    if (closeInProgress) return { action: 'allow' };

    const { isDirty, isReadOnly, hasDocument } = getState();
    const decision = decideCloseRequest({
      isDirty,
      isReadOnly,
      hasDocument,
      closeInProgress,
    });

    if (decision.action === 'allow') {
      await performClose();
      return { action: 'allow' };
    }

    const answer = await showDialog();

    if (answer === 'cancel') return { action: 'deny' };

    if (answer === 'save') {
      // 保存失败必须中止关闭：用户以为存上了就退出，数据就没了。
      const saveSucceeded = await saveFile();
      if (resolveCloseDecision('save', { saveSucceeded }).action === 'stay') {
        onSaveError();
        return { action: 'deny' };
      }
    }
    // 其余情况（discard）直接关闭，不保存。

    closeInProgress = true;
    await performClose();
    return { action: 'allow' };
  }

  return {
    handleRequest,
    /** 供 `beforeunload` 与测试观察当前状态。 */
    isClosing: () => closeInProgress,
  };
}
