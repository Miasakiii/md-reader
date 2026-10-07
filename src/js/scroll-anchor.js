/**
 * 源码坐标 ↔ 渲染标题锚点的映射。
 *
 * 模式切换的滚动交接与「预览跟随光标」都依赖同一件事：知道光标（或阅读
 * 位置）对应渲染文档的哪个标题块。两侧必须出自同一引擎——源码侧用注入的
 * markdown-it 实例解析（heading_open token 自带 `map` 行号），DOM 侧用
 * 渲染产物里带 id 的标题元素，按出现顺序做**索引配对**，因此 setext、
 * 引用内、列表内的标题都天然一致，无需重实现 CommonMark。
 *
 * 注意：解析前必须剥离 frontmatter——渲染管线就是这么做的（见
 * markdown-render 的 renderDocumentHtml），而 `---` 围栏里的 `key: value`
 * 会被解析成 setext 伪标题，剥离不一致会造成两侧索引错位。
 */

import { extractFrontmatter } from './markdown-render.js';

const LINE_BREAK = /\r\n|\r|\n/g;

function countLineBreaks(text) {
  const matches = text.match(new RegExp(LINE_BREAK.source, 'g'));
  return matches ? matches.length : 0;
}

/** 每一行（0-based）在原文中的起始字符偏移。 */
function collectLineStartOffsets(text) {
  const offsets = [0];
  for (const match of text.matchAll(LINE_BREAK)) {
    offsets.push(match.index + match[0].length);
  }
  return offsets;
}

const clamp01 = value => Math.min(1, Math.max(0, value));

/**
 * 提取标题锚点序列。返回按文档顺序排列的
 * `{ line, level, startOffset }`：行号与偏移均以**完整原文**为坐标系
 * （frontmatter 剥离后的行号已平移回去），startOffset 指向标题所在行的行首。
 *
 * `maxLevel` 用于与 DOM 侧的配对选择器对齐（TOC/scroll-spy 只跟踪 h1-h4，
 * 预览跟随光标用全部层级）。
 */
export function extractSourceHeadings(md, source, { maxLevel = 6 } = {}) {
  const text = String(source ?? '');
  const frontmatter = extractFrontmatter(text);
  const body = frontmatter ? frontmatter.body : text;
  const bodyStartLine = frontmatter ? countLineBreaks(frontmatter.raw) : 0;
  const lineOffsets = collectLineStartOffsets(text);

  const headings = [];
  for (const token of md.parse(body, {})) {
    if (token.type !== 'heading_open') continue;
    const level = Number(token.tag.slice(1));
    if (!Number.isInteger(level) || level < 1 || level > maxLevel) continue;
    const line = bodyStartLine + (token.map ? token.map[0] : 0);
    headings.push({
      line,
      level,
      startOffset: lineOffsets[line] ?? text.length,
    });
  }
  return headings;
}

/**
 * 定位一个源码偏移落在哪个标题块内。
 *
 * 返回 `{ index, fraction, anchored }`：index 为命中的标题序号（-1 表示
 * 位于第一个标题之前的前言区，fraction 相对 `[文档头, 第一个标题)` 计算）；
 * `anchored: false` 表示整个文档没有锚点，调用方应走比例降级。
 */
export function locateOffsetInAnchors(headings, offset, totalLength) {
  const position = Math.max(0, Number(offset) || 0);
  if (!Array.isArray(headings) || headings.length === 0) {
    return { index: -1, fraction: 0, anchored: false };
  }

  let index = -1;
  for (let i = 0; i < headings.length; i++) {
    if (headings[i].startOffset <= position) {
      index = i;
    } else {
      break;
    }
  }

  if (index < 0) {
    const first = headings[0].startOffset;
    return { index: -1, fraction: clamp01(first > 0 ? position / first : 0), anchored: true };
  }

  const start = headings[index].startOffset;
  const end = index + 1 < headings.length
    ? headings[index + 1].startOffset
    : Math.max(Number(totalLength) || start, start + 1);
  return {
    index,
    fraction: clamp01((position - start) / Math.max(1, end - start)),
    anchored: true,
  };
}
