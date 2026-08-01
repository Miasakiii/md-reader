function errorCode(error) {
  if (error && typeof error === 'object' && typeof error.code === 'string') {
    return error.code;
  }
  if (typeof error !== 'string') return '';
  try {
    const parsed = JSON.parse(error);
    return typeof parsed?.code === 'string' ? parsed.code : '';
  } catch {
    return error;
  }
}

export function createSerialTaskQueue() {
  let tail = Promise.resolve();
  return operation => {
    const result = tail.then(operation, operation);
    tail = result.catch(() => {});
    return result;
  };
}

export function reconcileSavedEditorState({
  savedContent,
  currentEditorContent,
}) {
  const hasNewerEdits = currentEditorContent !== savedContent;
  return {
    persistedContent: savedContent,
    rawContent: savedContent,
    previewContent: hasNewerEdits ? currentEditorContent : savedContent,
    isDirty: hasNewerEdits,
  };
}

export function isDraftDirty(currentContent, persistedContent) {
  return String(currentContent ?? '') !== String(persistedContent ?? '');
}

export function isEditorSnapshotCurrent(snapshot, current) {
  return !current.readOnly
    && snapshot.generation === current.generation
    && snapshot.revision === current.revision;
}

export async function guardDirtyDocumentSwitch({ isDirty, decide, save } = {}) {
  if (!isDirty) return true;
  try {
    const decision = await decide?.();
    if (decision === 'discard') return true;
    if (decision !== 'save') return false;
    return await save?.() === true;
  } catch {
    return false;
  }
}

export async function openDocumentWithGuards({
  path,
  inspectDocument,
  confirmLargeLog,
  isDirty = false,
  decideDirtySwitch,
  saveCurrentDocument,
  readDocument,
}) {
  let inspection = await inspectDocument(path);
  let allowLargeLog = false;

  if (inspection.requiresLargeFileConfirmation) {
    allowLargeLog = await confirmLargeLog(inspection) === true;
    if (!allowLargeLog) {
      return { status: 'cancelled', reason: 'large-log' };
    }
  }

  const dirty = typeof isDirty === 'function' ? await isDirty() : isDirty;
  const canSwitch = await guardDirtyDocumentSwitch({
    isDirty: dirty,
    decide: decideDirtySwitch,
    save: saveCurrentDocument,
  });
  if (!canSwitch) {
    return { status: 'cancelled', reason: 'dirty-switch' };
  }

  try {
    const document = await readDocument(path, allowLargeLog);
    return { status: 'opened', document };
  } catch (error) {
    if (allowLargeLog || errorCode(error) !== 'large_log_confirmation_required') {
      throw error;
    }
  }

  inspection = await inspectDocument(path);
  if (!inspection.requiresLargeFileConfirmation) {
    const error = new Error('日志读取状态已变化，请重试');
    error.code = 'large_log_confirmation_required';
    throw error;
  }
  if (await confirmLargeLog(inspection) !== true) {
    return { status: 'cancelled', reason: 'large-log' };
  }

  const document = await readDocument(path, true);
  return { status: 'opened', document };
}

export function createDocumentViewState(document) {
  const readOnly = Boolean(document.readOnly);
  const content = String(document.content ?? '');
  return {
    editorDisabled: readOnly,
    saveDisabled: readOnly,
    tocDisabled: !document.toc,
    editorContent: readOnly ? '' : content,
    previewContent: readOnly ? '' : content,
  };
}

export function formatMiB(sizeBytes) {
  return `${(Number(sizeBytes) / (1024 * 1024)).toFixed(1)} MiB`;
}
