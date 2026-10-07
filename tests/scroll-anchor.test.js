import assert from 'node:assert/strict';
import test from 'node:test';

import { createMarkdownEngine } from '../src/js/markdown-render.js';
import {
  extractSourceHeadings,
  locateOffsetInAnchors,
} from '../src/js/scroll-anchor.js';

const md = createMarkdownEngine();

const SAMPLE = [
  '---',
  'title: 示例',
  '---',
  '',
  '前言段落。',
  '',
  '# 第一章',
  '',
  '正文 *强调* 内容。',
  '',
  '```bash',
  '# 这是注释不是标题',
  '```',
  '',
  '## 1.1 小节',
  '',
  'Setext 标题',
  '===',
  '',
  '> # 引用内标题',
  '',
  '## 第一章',
  '',
  '结尾。',
].join('\n');

test('source headings pair with the rendered heading order', () => {
  const headings = extractSourceHeadings(md, SAMPLE);

  // frontmatter 剥离后，# 第一章 应落在第 6 行（0-based）。
  assert.deepEqual(
    headings.map(h => h.level),
    [1, 2, 1, 1, 2],
    'setext / 引用内标题都算锚点，围栏内注释不算',
  );
  assert.equal(headings[0].line, 6);
  assert.equal(headings[0].startOffset, SAMPLE.indexOf('# 第一章'));
  assert.equal(headings[1].line, 14);
});

test('CRLF sources produce identical line numbers to LF', () => {
  const lf = extractSourceHeadings(md, '# A\n\ntext\n\n## B\n');
  const crlf = extractSourceHeadings(md, '# A\r\n\r\ntext\r\n\r\n## B\r\n');

  assert.deepEqual(crlf.map(h => h.line), lf.map(h => h.line));
  assert.deepEqual(crlf.map(h => h.level), lf.map(h => h.level));
});

test('maxLevel filter mirrors the DOM pairing selector', () => {
  const doc = '# 一\n\n## 二\n\n### 三\n\n#### 四\n\n##### 五\n';
  const all = extractSourceHeadings(md, doc);
  const tocOnly = extractSourceHeadings(md, doc, { maxLevel: 4 });

  assert.equal(all.length, 5);
  assert.deepEqual(tocOnly.map(h => h.level), [1, 2, 3, 4]);
});

test('documents without headings yield no anchors', () => {
  assert.deepEqual(extractSourceHeadings(md, '普通段落\n另一段\n'), []);
  assert.deepEqual(extractSourceHeadings(md, ''), []);
});

test('offset before the first heading lands in the preamble', () => {
  const headings = extractSourceHeadings(md, SAMPLE);
  const firstStart = headings[0].startOffset;
  const located = locateOffsetInAnchors(headings, 10, SAMPLE.length);

  assert.equal(located.index, -1);
  assert.equal(located.anchored, true);
  assert.ok(located.fraction > 0 && located.fraction < 1);
  assert.ok(Math.abs(located.fraction - 10 / firstStart) < 1e-9);
});

test('offset at a heading start resolves to that anchor at fraction zero', () => {
  const headings = extractSourceHeadings(md, SAMPLE);
  const located = locateOffsetInAnchors(headings, headings[1].startOffset, SAMPLE.length);

  assert.equal(located.index, 1);
  assert.equal(located.fraction, 0);
});

test('offset inside a block maps to a fraction within it', () => {
  const headings = extractSourceHeadings(md, SAMPLE);
  const third = headings[2].startOffset;
  const next = headings[3].startOffset;
  const middle = Math.floor((third + next) / 2);
  const located = locateOffsetInAnchors(headings, middle, SAMPLE.length);

  assert.equal(located.index, 2);
  assert.ok(located.fraction > 0 && located.fraction < 1);
});

test('offsets near the document end clamp into the last block', () => {
  const headings = extractSourceHeadings(md, SAMPLE);
  const tail = locateOffsetInAnchors(headings, SAMPLE.length, SAMPLE.length);

  assert.equal(tail.index, headings.length - 1);
  assert.equal(tail.fraction, 1);
});

test('empty heading list reports no anchor so callers can fall back', () => {
  const located = locateOffsetInAnchors([], 42, 100);

  assert.deepEqual(located, { index: -1, fraction: 0, anchored: false });
});

test('fractions advance monotonically across the document', () => {
  const headings = extractSourceHeadings(md, SAMPLE);
  let previous = { index: -1, fraction: 0 };
  for (let offset = 0; offset <= SAMPLE.length; offset += 7) {
    const located = locateOffsetInAnchors(headings, offset, SAMPLE.length);
    const progress = located.index * 1e6 + located.fraction;
    const previousProgress = previous.index * 1e6 + previous.fraction;
    assert.ok(
      progress >= previousProgress - 1e-9,
      `offset ${offset} must not move backwards`,
    );
    previous = located;
  }
});
