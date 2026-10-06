import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createMarkdownEngine,
  escapeHtml,
  extractFrontmatter,
  renderDocumentHtml,
  renderFrontmatter,
  renderMarkdownHtml,
  renderPlainText,
} from '../src/js/markdown-render.js';

// DOMPurify 需要 DOM window，Node 测试环境改用恒等消毒器：渲染管线的
// 契约（结构、顺序、不可交互）在此处验证，消毒行为由真实运行与
// configuration 契约测试共同守护。
const passthroughSanitize = html => html;
const md = createMarkdownEngine();

// markdown-it-task-lists 每次渲染都会生成随机任务 id，无法直接比较两次
// 渲染的输出；断言结构一致性时先剥离该 id。
const stripTaskIds = html => html.replace(/id="task-item-\d+"/g, 'id="task"')
  .replace(/for="task-item-\d+"/g, 'for="task"');

test('task lists render as non-interactive checkboxes', () => {
  const html = renderMarkdownHtml(md, '- [ ] 待办\n- [x] 已完成\n', passthroughSanitize);

  assert.match(html, /type="checkbox"/);
  assert.match(html, /checked/);
  assert.match(html, /task-list-item-checkbox/);

  for (const tag of html.match(/<input[^>]*task-list-item-checkbox[^>]*>/g)) {
    assert.match(tag, /disabled/, 'checkbox must be disabled');
    assert.doesNotMatch(tag, /on(change|click|input)/, 'checkbox must carry no event handler');
  }
});

test('both rendering paths produce identical task list markup', () => {
  const source = '- [ ] alpha\n- [x] beta\n';
  const reading = renderMarkdownHtml(md, source, passthroughSanitize);
  const preview = renderDocumentHtml(md, source, 'markdown', passthroughSanitize);

  assert.equal(stripTaskIds(preview), stripTaskIds(reading));
});

test('plain text mode escapes markup instead of rendering it', () => {
  const html = renderDocumentHtml(md, '# <img src=x onerror=alert(1)>', 'plain', passthroughSanitize);

  assert.match(html, /class="plain-text"/);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
});

test('the [[toc]] placeholder becomes an inline navigation container', () => {
  const html = renderMarkdownHtml(md, '[[toc]]\n\n# 标题\n\n正文\n', passthroughSanitize);

  assert.match(html, /<nav class="toc-inline"><\/nav>/);
  assert.doesNotMatch(html, /%%TOC%%/);
});

test('frontmatter is stripped and rendered as metadata', () => {
  const result = extractFrontmatter('---\ntitle: 指南\ntags:\n  - a\n  - b\n---\n\n# 正文\n');

  assert.ok(result);
  assert.equal(result.body.trim(), '# 正文');
  assert.deepEqual(result.entries, [
    { key: 'title', value: '指南' },
    { key: 'tags', value: null },
    { key: 'tags', value: 'a' },
    { key: 'tags', value: 'b' },
  ]);
});

test('frontmatter keys and values are HTML escaped', () => {
  const html = renderFrontmatter([{ key: 'title', value: '<script>x</script>' }]);

  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
});

test('unclosed or malformed frontmatter falls back to the original text', () => {
  assert.equal(extractFrontmatter('---\ntitle: 未闭合\n\n# 正文\n'), null);
  assert.equal(extractFrontmatter('---\n---\n\n# 正文\n'), null);
  assert.equal(extractFrontmatter('---\n  bad indent: x\n---\n\n正文\n'), null);

  const content = '---\ntitle: 未闭合\n\n# 正文\n';
  const html = renderDocumentHtml(md, content, 'markdown', passthroughSanitize);
  assert.match(html, /title: 未闭合/);
});

test('a thematic break after content is not treated as frontmatter', () => {
  const content = '# 标题\n\n正文\n\n---\n\n更多正文\n';
  const result = extractFrontmatter(content);

  assert.equal(result, null);
  assert.match(renderDocumentHtml(md, content, 'markdown', passthroughSanitize), /<hr>/);
});

test('a document starting with frontmatter keeps heading anchors intact', () => {
  const html = renderDocumentHtml(
    md,
    '---\ntitle: 指南\n---\n\n[[toc]]\n\n# 第一章\n\n正文\n',
    'markdown',
    passthroughSanitize,
  );

  assert.match(html, /id="第一章"/);
  assert.match(html, /<nav class="toc-inline">/);
  assert.match(html, /class="frontmatter"/);
});

test('the code copy button is injected before the highlighted block', () => {
  const html = renderMarkdownHtml(md, '```js\nconst a = 1;\n```\n', passthroughSanitize);

  assert.match(html, /<pre><button type="button" class="code-copy">复制<\/button><code/);
});

test('sanitize runs before post-processing rewrites', () => {
  const calls = [];
  const recordingSanitize = html => {
    calls.push(html);
    return html;
  };

  const html = renderMarkdownHtml(md, '# 标题\n', recordingSanitize);

  assert.equal(calls.length, 1);
  assert.match(calls[0], /<h1/);
  assert.doesNotMatch(calls[0], /code-copy/);
  assert.match(html, /<h1/);
});

test('escapeHtml neutralizes the markup-significant characters it claims to', () => {
  assert.equal(escapeHtml('&<>"\''), '&amp;&lt;&gt;&quot;\'');
  assert.equal(escapeHtml('<img src=x onerror=alert(1)>'),
    '&lt;img src=x onerror=alert(1)&gt;');
  assert.equal(escapeHtml(null), 'null');
});

test('renderPlainText keeps line breaks intact for .txt and .tex', () => {
  const html = renderPlainText('第一行\n第二行');

  assert.equal(html, '<div class="plain-text">第一行\n第二行</div>');
});