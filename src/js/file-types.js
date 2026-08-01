import manifest from '../../shared/document-types.json' with { type: 'json' };

const TYPE_RULES = {
  markdown: {
    renderMode: 'markdown',
    editable: true,
    toc: true,
    warnWhenLarge: false,
  },
  text: {
    renderMode: 'plain',
    editable: true,
    toc: false,
    warnWhenLarge: false,
  },
  log: {
    renderMode: 'plain',
    editable: false,
    toc: false,
    warnWhenLarge: true,
  },
};

const FILTER_LABELS = {
  markdown: 'Markdown',
  text: 'Text',
  log: 'Log',
};

const ROOT_FIELDS = ['version', 'largeLogWarningBytes', 'types'];
const TYPE_FIELDS = ['extensions', 'renderMode', 'editable', 'toc', 'warnWhenLarge'];

function policyError(message) {
  const error = new Error(message);
  error.code = 'policy_invalid';
  return error;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactFields(value, expectedFields) {
  const actualFields = Object.keys(value);
  return actualFields.length === expectedFields.length
    && actualFields.every(field => expectedFields.includes(field));
}

function deepFreeze(value) {
  if (!isRecord(value) && !Array.isArray(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

export function validateDocumentTypePolicy(policy) {
  if (!isRecord(policy) || !hasExactFields(policy, ROOT_FIELDS) || policy.version !== 1) {
    throw policyError('文档类型策略版本无效');
  }
  if (!Number.isSafeInteger(policy.largeLogWarningBytes) || policy.largeLogWarningBytes <= 0) {
    throw policyError('大日志阈值必须是正整数');
  }
  if (!isRecord(policy.types)) {
    throw policyError('文档类型策略缺少 types');
  }

  const typeNames = Object.keys(policy.types);
  if (
    typeNames.length !== Object.keys(TYPE_RULES).length
    || typeNames.some(name => !Object.prototype.hasOwnProperty.call(TYPE_RULES, name))
  ) {
    throw policyError('文档类型分组无效');
  }

  const seenExtensions = new Set();
  for (const [kind, expected] of Object.entries(TYPE_RULES)) {
    const type = policy.types[kind];
    if (
      !isRecord(type)
      || !hasExactFields(type, TYPE_FIELDS)
      || !Array.isArray(type.extensions)
      || type.extensions.length === 0
    ) {
      throw policyError(`文档类型 ${kind} 缺少扩展名`);
    }

    for (const extension of type.extensions) {
      if (typeof extension !== 'string' || !/^[a-z0-9]+$/.test(extension)) {
        throw policyError(`文档类型 ${kind} 包含无效扩展名`);
      }
      const normalized = extension.toLowerCase();
      if (seenExtensions.has(normalized)) {
        throw policyError(`扩展名 ${extension} 重复`);
      }
      seenExtensions.add(normalized);
    }

    for (const [field, expectedValue] of Object.entries(expected)) {
      if (type[field] !== expectedValue) {
        throw policyError(`文档类型 ${kind} 的 ${field} 配置无效`);
      }
    }
  }

  return policy;
}

export const documentTypePolicy = deepFreeze(validateDocumentTypePolicy(manifest));
export const LARGE_LOG_WARNING_BYTES = documentTypePolicy.largeLogWarningBytes;

export function extractExtension(path) {
  const value = String(path ?? '');
  const lastSegment = value.split(/[/\\]/).pop() ?? '';
  if (!lastSegment) return '';
  const dotIndex = lastSegment.lastIndexOf('.');
  if (dotIndex <= 0 || dotIndex === lastSegment.length - 1) return '';
  return lastSegment.slice(dotIndex + 1).toLowerCase();
}

export function classifyDocumentPath(path) {
  const extension = extractExtension(path);
  for (const [kind, type] of Object.entries(documentTypePolicy.types)) {
    if (type.extensions.includes(extension)) {
      return {
        kind,
        extension,
        renderMode: type.renderMode,
        editable: type.editable,
        toc: type.toc,
        warnWhenLarge: type.warnWhenLarge,
      };
    }
  }
  return {
    kind: 'unsupported',
    extension,
    renderMode: null,
    editable: false,
    toc: false,
    warnWhenLarge: false,
  };
}

export function isSupportedDocumentPath(path) {
  return classifyDocumentPath(path).kind !== 'unsupported';
}

export function isEditableDocumentPath(path) {
  return classifyDocumentPath(path).editable;
}

function extensionsFor(kind) {
  return [...documentTypePolicy.types[kind].extensions];
}

export function getOpenDialogFilters() {
  return [{
    name: 'Markdown / Text / Log',
    extensions: Object.values(documentTypePolicy.types).flatMap(type => [...type.extensions]),
  }];
}

export function getBrowserAccept() {
  return getOpenDialogFilters()[0].extensions.map(extension => `.${extension}`).join(',');
}

export function getDocumentFormatLabel(path) {
  const type = classifyDocumentPath(path);
  if (type.kind === 'unsupported') return 'Unsupported';
  if (type.kind === 'markdown') return 'Markdown';
  return type.extension === 'tex' ? 'TeX' : type.extension.toUpperCase();
}

export function getSaveDialogFilters(preferredPath) {
  const editableKinds = Object.entries(documentTypePolicy.types)
    .filter(([, type]) => type.editable)
    .map(([kind]) => kind);
  const preferredKind = classifyDocumentPath(preferredPath).kind;
  if (editableKinds.includes(preferredKind)) {
    editableKinds.splice(editableKinds.indexOf(preferredKind), 1);
    editableKinds.unshift(preferredKind);
  }
  return editableKinds.map(kind => ({
    name: FILTER_LABELS[kind],
    extensions: extensionsFor(kind),
  }));
}
