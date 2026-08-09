function decodeFailedError() {
  const error = new Error('无法识别文件编码（仅支持 UTF-8 或 GBK/GB18030）');
  error.code = 'decode_failed';
  return error;
}

function decodeStrict(bytes, encoding) {
  return new TextDecoder(encoding, {
    fatal: true,
    // Match the native decoder by preserving an initial BOM in the text.
    ignoreBOM: true,
  }).decode(bytes);
}

export function decodeTextBytes(bytes) {
  try {
    return {
      content: decodeStrict(bytes, 'utf-8'),
      encoding: 'UTF-8',
    };
  } catch {
    try {
      return {
        content: decodeStrict(bytes, 'gb18030'),
        encoding: 'GB18030',
      };
    } catch {
      throw decodeFailedError();
    }
  }
}

export async function readBrowserTextFile(file) {
  const bytes = await file.arrayBuffer();
  return decodeTextBytes(bytes);
}
