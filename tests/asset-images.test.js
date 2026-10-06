import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildAssetLookup,
  collectRelativeImageReferences,
  readOriginalAssetSource,
  resolveAgainst,
  rewriteImageSources,
} from '../src/js/asset-images.js';

function fakeImageElement(attributes) {
  return {
    attributes: { ...attributes },
    getAttribute(name) {
      return Object.hasOwn(this.attributes, name) ? this.attributes[name] : null;
    },
    setAttribute(name, value) {
      this.attributes[name] = String(value);
    },
  };
}

function fakeRoot(images) {
  return {
    querySelectorAll(selector) {
      assert.equal(selector, 'img[src]');
      return images;
    },
  };
}

function withConverter(fn) {
  const previous = globalThis.__TAURI__;
  globalThis.__TAURI__ = { core: { convertFileSrc: fn } };
  return () => {
    globalThis.__TAURI__ = previous;
  };
}

test('only relative image sources become candidates', () => {
  const html = [
    '<p><img src="images/a.png">',
    '<img src="https://example.com/b.png">',
    '<img src="data:image/png;base64,AAA">',
    '<img src="/absolute/c.png">',
    '<img src="file:///C:/x.png">',
    '<img src="sub dir/d.png">',
  ].join('');

  assert.deepEqual(
    collectRelativeImageReferences(html),
    ['images/a.png', 'sub dir/d.png'],
  );
});

test('duplicate references are collected once', () => {
  const html = '<img src="a.png"><img src="a.png"><img src="./a.png">';
  assert.deepEqual(collectRelativeImageReferences(html), ['a.png', './a.png']);
});

test('html entities in the source are decoded before comparison', () => {
  assert.deepEqual(
    collectRelativeImageReferences('<img src="images/a%20b.png">'),
    ['images/a%20b.png'],
  );
  assert.deepEqual(
    collectRelativeImageReferences('<img src="images/a&amp;b.png">'),
    ['images/a&b.png'],
  );
});

test('the asset lookup strips the Windows extended-length prefix', () => {
  const lookup = buildAssetLookup([
    '\\\\?\\C:\\docs\\images\\a.png',
    'C:\\docs\\images\\b.png',
  ]);

  assert.ok(lookup.has('C:/docs/images/a.png'));
  assert.ok(lookup.has('C:/docs/images/b.png'));
});

test('resolveAgainst resolves relative references against the document directory', () => {
  // 基准是文档**所在目录**，不是文件本身。
  assert.equal(
    resolveAgainst('images/a.png', 'C:/docs/guide.md'),
    'C:/docs/images/a.png',
  );
  assert.equal(
    resolveAgainst('../assets/a.png', 'C:/docs/guide.md'),
    'C:/assets/a.png',
  );
  assert.equal(
    resolveAgainst('./same/a.png', 'C:/docs/guide.md'),
    'C:/docs/same/a.png',
  );
  assert.equal(
    resolveAgainst('a.png', 'C:/docs/guide.md'),
    'C:/docs/a.png',
  );
});

test('resolveAgainst returns null when the document directory is unknown', () => {
  assert.equal(resolveAgainst('a.png', ''), null);
  assert.equal(resolveAgainst('a.png', null), null);
});

test('only allowed references are rewritten and the original is preserved', () => {
  const restore = withConverter(path => `asset://localhost/${path}`);
  try {
    const allowed = ['C:/docs/images/a.png'];
    const ok = fakeImageElement({ src: 'images/a.png' });
    const denied = fakeImageElement({ src: 'images/secret.png' });
    const remote = fakeImageElement({ src: 'https://example.com/x.png' });

    const count = rewriteImageSources(
      fakeRoot([ok, denied, remote]),
      allowed,
      'C:/docs/guide.md',
    );

    assert.equal(count, 1);
    assert.equal(ok.getAttribute('src'), 'asset://localhost/C:/docs/images/a.png');
    assert.equal(ok.getAttribute('data-asset-src'), 'images/a.png');
    assert.equal(ok.getAttribute('loading'), 'lazy');

    assert.equal(denied.getAttribute('src'), 'images/secret.png');
    assert.equal(denied.getAttribute('data-asset-src'), null);

    assert.equal(remote.getAttribute('src'), 'https://example.com/x.png');
    assert.equal(remote.getAttribute('data-asset-src'), null);
  } finally {
    restore();
  }
});

test('browser preview without the asset protocol rewrites nothing', () => {
  const restore = withConverter(undefined);
  try {
    const image = fakeImageElement({ src: 'images/a.png' });
    const count = rewriteImageSources(fakeRoot([image]), ['C:/docs/images/a.png'], 'C:/docs/guide.md');

    assert.equal(count, 0);
    assert.equal(image.getAttribute('src'), 'images/a.png');
  } finally {
    restore();
  }
});

test('a missing or foreign root is handled without throwing', () => {
  assert.equal(rewriteImageSources(null, [], 'C:/docs'), 0);
  assert.equal(rewriteImageSources({}, [], 'C:/docs'), 0);
});

test('readOriginalAssetSource prefers the preserved relative reference', () => {
  assert.equal(
    readOriginalAssetSource(fakeImageElement({
      src: 'asset://localhost/C:/docs/a.png',
      'data-asset-src': 'images/a.png',
    })),
    'images/a.png',
  );
  assert.equal(readOriginalAssetSource(fakeImageElement({ src: 'images/a.png' })), 'images/a.png');
  assert.equal(readOriginalAssetSource(null), '');
});