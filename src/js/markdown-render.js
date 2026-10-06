import MarkdownIt from 'markdown-it';
import DOMPurify from 'dompurify';
import markdownItAnchor from 'markdown-it-anchor';
import markdownItToc from 'markdown-it-toc-done-right';
import markdownItTaskLists from 'markdown-it-task-lists';

import hljs from './highlight.js';

// ========== Markdown Engine ==========
export function createMarkdownEngine() {
  const md = new MarkdownIt({
    html: true,
    linkify: true,
    typographer: true,
    highlight(str, lang) {
      if (lang && hljs.getLanguage(lang)) {
        try {
          return hljs.highlight(str, { language: lang }).value;
        } catch (_) {}
      }
      return md.utils.escapeHtml(str);
    },
  });

  md.use(markdownItAnchor, {
    permalink: false,
    slugify: s => s.toLowerCase().replace(/[^\w\u4e00-\u9fff]+/g, '-').replace(/(^-|-$)/g, ''),
  });

  md.use(markdownItToc, {
    containerClass: 'toc-container',
    listType: 'ul',
  });

  // 阅读器里的勾选动作不该写回文档，因此 checkbox 渲染为不可交互。
  md.use(markdownItTaskLists, {
    enabled: false,
    label: true,
    labelAfter: true,
  });

  return md;
}

// ========== Frontmatter ==========
const FRONTMATTER_PATTERN = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/**
 * 剥离文档开头的 YAML frontmatter。只支持简单的 `key: value` 与 `- item`
 * 列表；未闭合、无法解析或为空块时返回 null，表示应按原文渲染。
 *
 * 不引入行号偏移补偿：本项目的 TOC 与搜索都从渲染后 DOM 读取，不依赖
 * 源码行坐标（见 app.js 的 buildTOC 与 doSearch）。
 */
export function extractFrontmatter(content) {
  const text = String(content ?? '');
  const match = text.match(FRONTMATTER_PATTERN);
  if (!match) return null;

  const entries = [];
  let listKey = '';
  for (const rawLine of match[1].split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, '');
    if (!line || line.trimStart().startsWith('#')) continue;

    const listItem = line.match(/^[ \t]*-[ \t]+(.*)$/);
    if (listItem) {
      if (!listKey) return null;
      entries.push({ key: listKey, value: listItem[1].trim() });
      continue;
    }

    const pair = line.match(/^([A-Za-z_][\w.-]*)[ \t]*:[ \t]*(.*)$/);
    if (!pair) return null;

    listKey = '';
    const key = pair[1];
    const value = pair[2].trim();
    if (!value) {
      listKey = key;
      entries.push({ key, value: null });
      continue;
    }
    entries.push({ key, value });
  }

  if (entries.length === 0) return null;

  return {
    entries,
    body: text.slice(match[0].length),
    raw: match[0],
  };
}

// ========== Rendering ==========
const TOC_PLACEHOLDER = /^\[\[toc\]\]\s*$/gim;
const TOC_MARKER = '%%TOC%%';
const CODE_COPY_BUTTON = /<pre><code/g;

/**
 * 消毒器注入而非直接引用 DOMPurify：DOMPurify 需要 DOM window，无法在
 * Node 测试环境运行，注入后渲染逻辑可被纯函数测试覆盖。
 */
export function sanitizeMarkdownHtml(html) {
  return DOMPurify.sanitize(html, {
    ADD_TAGS: ['nav'],
    ADD_ATTR: ['class'],
  });
}

export function renderMarkdownHtml(md, content, sanitize = sanitizeMarkdownHtml) {
  const processed = String(content ?? '').replace(TOC_PLACEHOLDER, TOC_MARKER);
  let html = md.render(processed).replace(
    /<p>%%TOC%%<\/p>/,
    '<nav class="toc-inline"></nav>',
  );

  // 消毒在前：图片重写等后处理只针对已通过消毒的节点。
  html = sanitize(html);

  return html.replace(
    CODE_COPY_BUTTON,
    '<pre><button type="button" class="code-copy">复制</button><code',
  );
}

export function renderFrontmatter(entries) {
  const items = entries.map(entry => {
    if (entry.value === null) {
      return `<li class="frontmatter-list"><span class="frontmatter-key">${escapeHtml(entry.key)}</span></li>`;
    }
    return `<li class="frontmatter-item"><span class="frontmatter-key">${escapeHtml(entry.key)}</span><span class="frontmatter-colon">:</span><span class="frontmatter-value">${escapeHtml(entry.value)}</span></li>`;
  });
  return `<nav class="frontmatter" aria-label="文档元数据"><ul>${items.join('')}</ul></nav>`;
}

export function renderDocumentHtml(md, content, renderMode, sanitize = sanitizeMarkdownHtml) {
  if (renderMode !== 'markdown') return renderPlainText(content);

  const frontmatter = extractFrontmatter(content);
  const body = frontmatter ? frontmatter.body : String(content ?? '');
  const bodyHtml = renderMarkdownHtml(md, body, sanitize);
  return frontmatter ? renderFrontmatter(frontmatter.entries) + bodyHtml : bodyHtml;
}

export function renderPlainText(content) {
  return `<div class="plain-text">${escapeHtml(content)}</div>`;
}

export function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}