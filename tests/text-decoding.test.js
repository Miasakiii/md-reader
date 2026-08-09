import assert from 'node:assert/strict';
import test from 'node:test';

import {
  decodeTextBytes,
  readBrowserTextFile,
} from '../src/js/text-decoding.js';

test('browser text decoding prefers strict UTF-8 and preserves its BOM', () => {
  const encoded = Uint8Array.from([
    0xef, 0xbb, 0xbf,
    ...new TextEncoder().encode('你好'),
  ]);

  assert.deepEqual(decodeTextBytes(encoded), {
    content: '\ufeff你好',
    encoding: 'UTF-8',
  });
});

test('browser text decoding strictly falls back to GB18030', () => {
  assert.deepEqual(
    decodeTextBytes(Uint8Array.from([0xd6, 0xd0, 0xce, 0xc4])),
    {
      content: '中文',
      encoding: 'GB18030',
    },
  );
});

test('browser text decoding reports a stable error when both decoders reject', () => {
  assert.throws(
    () => decodeTextBytes(Uint8Array.from([0x81])),
    error => error?.code === 'decode_failed'
      && error.message === '无法识别文件编码（仅支持 UTF-8 或 GBK/GB18030）',
  );
});

test('browser files are read as bytes without using File.text()', async () => {
  const encoded = Uint8Array.from([0xd6, 0xd0, 0xce, 0xc4]);
  let arrayBufferCalls = 0;
  let textCalls = 0;
  const file = {
    async arrayBuffer() {
      arrayBufferCalls += 1;
      return encoded.buffer;
    },
    async text() {
      textCalls += 1;
      throw new Error('File.text() must not be used');
    },
  };

  assert.deepEqual(await readBrowserTextFile(file), {
    content: '中文',
    encoding: 'GB18030',
  });
  assert.equal(arrayBufferCalls, 1);
  assert.equal(textCalls, 0);
});
