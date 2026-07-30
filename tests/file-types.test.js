import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LARGE_LOG_WARNING_BYTES,
  classifyDocumentPath,
  extractExtension,
  getBrowserAccept,
  getDocumentFormatLabel,
  getOpenDialogFilters,
  getSaveDialogFilters,
  isEditableDocumentPath,
  isSupportedDocumentPath,
  validateDocumentTypePolicy,
} from '../src/js/file-types.js';

test('shared policy classifies every supported document type case-insensitively', () => {
  assert.equal(classifyDocumentPath('/notes/guide.MD').kind, 'markdown');
  assert.equal(classifyDocumentPath('C:\\notes\\guide.MarkDown').kind, 'markdown');

  const tex = classifyDocumentPath('/notes/source.TeX');
  assert.deepEqual(
    {
      kind: tex.kind,
      renderMode: tex.renderMode,
      editable: tex.editable,
      toc: tex.toc,
      warnWhenLarge: tex.warnWhenLarge,
    },
    {
      kind: 'text',
      renderMode: 'plain',
      editable: true,
      toc: false,
      warnWhenLarge: false,
    },
  );

  const log = classifyDocumentPath('/logs/build.LOG');
  assert.deepEqual(
    {
      kind: log.kind,
      renderMode: log.renderMode,
      editable: log.editable,
      toc: log.toc,
      warnWhenLarge: log.warnWhenLarge,
    },
    {
      kind: 'log',
      renderMode: 'plain',
      editable: false,
      toc: false,
      warnWhenLarge: true,
    },
  );

  assert.equal(LARGE_LOG_WARNING_BYTES, 10 * 1024 * 1024);
});

test('extension parsing rejects names without a real supported suffix', () => {
  assert.equal(extractExtension('/notes/archive.tar.log'), 'log');
  assert.equal(extractExtension('/notes/no-extension'), '');
  assert.equal(extractExtension('/notes/trailing.'), '');
  assert.equal(extractExtension('/notes/.log'), '');
  assert.equal(extractExtension('/notes/fake.log/'), '');

  for (const path of ['', '/notes/no-extension', '/notes/file.', '/notes/.log', '/notes/image.png']) {
    assert.equal(classifyDocumentPath(path).kind, 'unsupported');
    assert.equal(isSupportedDocumentPath(path), false);
    assert.equal(isEditableDocumentPath(path), false);
  }
});

test('dialog and browser filters are derived from the shared policy', () => {
  assert.deepEqual(getOpenDialogFilters(), [
    {
      name: 'Markdown / Text / Log',
      extensions: ['md', 'markdown', 'txt', 'tex', 'log'],
    },
  ]);
  assert.equal(getBrowserAccept(), '.md,.markdown,.txt,.tex,.log');

  assert.deepEqual(getSaveDialogFilters('/notes/paper.tex'), [
    { name: 'Text', extensions: ['txt', 'tex'] },
    { name: 'Markdown', extensions: ['md', 'markdown'] },
  ]);
  assert.deepEqual(getSaveDialogFilters('/notes/readme.md'), [
    { name: 'Markdown', extensions: ['md', 'markdown'] },
    { name: 'Text', extensions: ['txt', 'tex'] },
  ]);
  assert.equal(getSaveDialogFilters('/logs/build.log').flatMap(filter => filter.extensions).includes('log'), false);
});

test('format labels come from the real extension instead of the shared text kind', () => {
  assert.equal(getDocumentFormatLabel('/notes/README.md'), 'Markdown');
  assert.equal(getDocumentFormatLabel('/notes/README.markdown'), 'Markdown');
  assert.equal(getDocumentFormatLabel('/notes/plain.txt'), 'TXT');
  assert.equal(getDocumentFormatLabel('/notes/paper.tex'), 'TeX');
  assert.equal(getDocumentFormatLabel('/logs/build.log'), 'LOG');
  assert.equal(getDocumentFormatLabel('/notes/image.png'), 'Unsupported');
});

test('policy validation rejects unsafe or ambiguous manifests', () => {
  const valid = {
    version: 1,
    largeLogWarningBytes: 1024,
    types: {
      markdown: {
        extensions: ['md'],
        renderMode: 'markdown',
        editable: true,
        toc: true,
        warnWhenLarge: false,
      },
      text: {
        extensions: ['txt'],
        renderMode: 'plain',
        editable: true,
        toc: false,
        warnWhenLarge: false,
      },
      log: {
        extensions: ['log'],
        renderMode: 'plain',
        editable: false,
        toc: false,
        warnWhenLarge: true,
      },
    },
  };

  assert.equal(validateDocumentTypePolicy(valid), valid);
  assert.throws(
    () => validateDocumentTypePolicy({ ...valid, largeLogWarningBytes: 0 }),
    error => error?.code === 'policy_invalid',
  );
  assert.throws(
    () => validateDocumentTypePolicy({
      ...valid,
      types: {
        ...valid.types,
        text: { ...valid.types.text, extensions: ['md'] },
      },
    }),
    error => error?.code === 'policy_invalid',
  );
  assert.throws(
    () => validateDocumentTypePolicy({
      ...valid,
      types: {
        ...valid.types,
        log: { ...valid.types.log, editable: true },
      },
    }),
    error => error?.code === 'policy_invalid',
  );
  assert.throws(
    () => validateDocumentTypePolicy({ ...valid, allowAnyFile: true }),
    error => error?.code === 'policy_invalid',
  );
  assert.throws(
    () => validateDocumentTypePolicy({
      ...valid,
      types: {
        ...valid.types,
        text: { ...valid.types.text, extraCapability: true },
      },
    }),
    error => error?.code === 'policy_invalid',
  );
  const missingField = structuredClone(valid);
  delete missingField.types.text.toc;
  assert.throws(
    () => validateDocumentTypePolicy(missingField),
    error => error?.code === 'policy_invalid',
  );
});
