# MD Reader 文件库、链接导航、图标与清理 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 MD Reader 增加阅读时可展开的持久化文件库、安全的“移出目录/移到系统回收站”操作，修复网页链接占用 WebView 且无法返回的问题，并完成图标透明圆角与证据充分的项目清理。

**Architecture:** Rust/Tauri 后端作为文件库、路径校验与回收站操作的唯一可信边界；`storage.rs` 提供严格 JSON 与可恢复替换，回收站使用事务日志区分“未移动”和“已移动但元数据待收尾”。前端用独立的 `file-library.js` 和 `navigation.js` 模块实现可测试的列表/菜单、链接分类与历史栈，`app.js` 只协调状态与 UI；文件库与文章目录共享左侧槽位并互斥，外链仅允许 `http`、`https`、`mailto` 交给系统，锚点留在当前文档，本地文档链接在阅读器内打开并进入返回栈。

**Tech Stack:** Vanilla ES modules, Node.js built-in test runner, Vite 6, Tauri 2, Rust 2021, `tauri-plugin-opener`, `tauri-plugin-single-instance`, `tauri-plugin-dialog`, `trash`, `same-file`, DOMPurify, markdown-it.

**已交付前置基础（2026-07-26）：** `shared/document-types.json`、`src/js/file-types.js` 与 `src-tauri/src/file_types.rs` 已统一 `.md` / `.markdown` / `.txt` / `.tex` / `.log` 五种运行时格式；TeX 是可编辑纯文本，LOG 是可搜索只读快照且达到或超过 10 MiB 时先确认。`src/js/document-session.js` 与现有 `app.js` 已接入未保存切换守卫和大型日志打开协调；`tauri-plugin-fs` 与全部 `fs:*` capability 已移除，并有配置契约测试。Tauri 系统文件关联仍有意只注册 `.md` / `.markdown` / `.txt`。这些是本计划必须保留和复用的前置条件，并不表示下述文件库、链接导航、回收站或图标任务已经完成。

**执行状态（2026-07-30）：本文件保留为总路线与历史设计，不再作为可逐项直接执行的当前计划。** 后续 Tasks 5/6/10–14 混合了 opener、`btn-back`、导航验收与文件库边界，不能安全裁剪。独立的 [`2026-07-29-release-hardening.md`](2026-07-29-release-hardening.md) 当前完成 13/16：本地门禁与候选提交已完成，远端 CI、独立 Windows 安装验收和 1.2.0 提升/tag 仍待完成。

当前产品状态与唯一执行顺序详见 [`../PROJECT_STATUS.md`](../PROJECT_STATUS.md)。封板之后应分别创建“外链最小路由”“文件库 MVP”“安全回收站”计划；透明圆角图标可独立并行，本地文档链接、返回历史与滚动恢复继续延期。

### 归档说明（2026-07-29）

- 2026-07-28 的“执行重排”已废止；本文件所有未完成复选框都只是历史设计素材，不代表当前执行队列。
- 文件库 MVP、安全回收站、外链最小路由和图标必须分别建立新计划与独立验收门槛，不得直接执行混合任务。
- 下文未加 `--locked` 或缺少 Clippy 的旧命令保留为历史步骤；当前权威验证命令以封板计划和 README 为准。
- 回收站 no-follow 身份复核、single-instance 队列、调试隔离配置目录及保留 `els.main` 等已核实约束，必须带入对应的新计划。
- `2/110` 只表示本归档文档的复选框快照，不是当前项目完成率。

---

## 实施约束

- 不修改、暂存或提交用户现有的 `.gitignore` 变更。
- 本计划不执行提交、推送、发布或永久删除；测试删除只针对实施过程中创建的临时文件，并使用系统回收站。
- 所有功能与缺陷修复都遵循红—绿—重构：先运行一个因缺少行为而失败的测试，再写最小实现，再运行同一测试确认通过。
- 任何读取失败都必须先区分“路径确定不存在”与权限、编码、设备等其他错误；只有前者允许自动清理文件库中的失效记录。
- 实际回收站命令只接受文件库中已登记、由 `src-tauri/src/file_types.rs` 共享策略判定为受支持的普通文件；前端确认不能代替后端校验，`library.rs` 不得维护独立扩展名列表。
- 本地链接与前端文件库通过 `src/js/file-types.js` 判断受支持类型；Rust 文件库、CLI 与回收站通过 `src-tauri/src/file_types.rs` 判断。不得新增后缀正则、字符串 `match` 或复制 `shared/document-types.json` 内容。
- 系统文件关联是独立产品边界，本计划不得把 `.tex` / `.log` 加入 `tauri.conf.json`；运行时五格式支持不等于系统关联五格式。
- 图标任务遵循 `imagegen` skill 对确定性项目内小改动的例外：使用本地 alpha 蒙版，不调用生成模型。若候选无法同时满足“透明圆角”“全部 RGB 不变”和“蒙版内部 RGBA 不变”，在覆盖正式资源前停止。
- 浏览器验证前必须读取并遵循 `browser:control-in-app-browser` 与 `build-web-apps:frontend-testing-debugging` skill；桌面原生验证需要时读取 `computer-use:computer-use` skill。

## 文件职责锁定

- `src/js/navigation.js`：链接分类/解码/本地路径解析、链接事件控制器、滚动优先级和文件返回栈；不得直接访问 Tauri。
- `src/js/file-library.js`：路径显示比较、欢迎页截断、菜单定位/键盘状态、删除确认控制器和文件列表 DOM；不得直接调用 `invoke`。
- `src/js/file-types.js`（已存在）：运行时文档类型的唯一前端判断入口；`navigation.js` 与 `file-library.js` 直接复用其导出，不复制扩展名。
- `src/js/document-session.js`（已存在）：未保存切换守卫与大型日志打开协调；导航层不得重新实现 `guardDirtyDocumentSwitch`。
- `src/js/app.js`：注入 Tauri/dialog/opener 回调，协调现有渲染、进度、文件库与导航模块。
- `src-tauri/src/storage.rs`：配置目录、严格 JSON 读取和可恢复安全写入；不含产品规则。
- `src-tauri/src/library.rs`：文件库 MRU/迁移、文档路径状态、回收站安全校验、事务日志与 Tauri 命令。
- `src-tauri/src/file_types.rs`（已存在）：运行时文档类型的唯一 Rust 判断入口；`library.rs` 与 `main.rs` 复用 `classify_path` / `is_supported_document_path`。
- `src-tauri/src/main.rs`：文件读写、阅读进度、CLI/文件关联、插件和命令注册。
- `tests/navigation.test.js`、`tests/file-library.test.js`、`tests/markup.test.js`：Node 可运行的纯逻辑、控制器和 HTML 契约回归测试。

## Task 1：建立 JavaScript 测试入口与链接纯逻辑

**Files:**

- Existing prerequisite: `package.json` (`"test": "node --test"` 已交付)
- Existing dependency: `src/js/file-types.js`
- Create: `tests/navigation.test.js`
- Create: `src/js/navigation.js`

- [x] 1.1 前置基础已在 `package.json` 的 `scripts` 中增加 Node 内置测试入口，实施本任务时只验证并保留，不重复修改或增加测试框架依赖：

```json
"test": "node --test"
```

- [ ] 1.2 先创建只导入尚不存在模块的分类测试：

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyLink,
  createMarkdownLinkHandler,
  resolveDocumentLink,
  NavigationHistory,
} from '../src/js/navigation.js';

test('classifyLink separates external, anchor, local, and blocked links', () => {
  assert.deepEqual(classifyLink('https://example.com/a'), { kind: 'external', href: 'https://example.com/a' });
  assert.deepEqual(classifyLink('mailto:reader@example.com'), { kind: 'external', href: 'mailto:reader@example.com' });
  assert.deepEqual(classifyLink('#安装'), { kind: 'anchor', fragment: '安装' });
  assert.deepEqual(classifyLink('../guide.md'), { kind: 'local', href: '../guide.md' });
  assert.deepEqual(classifyLink('\\\\server\\share\\guide.md'), { kind: 'local', href: '\\\\server\\share\\guide.md' });
  assert.deepEqual(classifyLink('javascript:alert(1)'), { kind: 'blocked', protocol: 'javascript:' });
  assert.deepEqual(classifyLink('#bad%ZZ'), { kind: 'anchor', fragment: 'bad%ZZ' });
});
```

- [ ] 1.3 运行 `npm.cmd test -- tests/navigation.test.js`，确认因 `src/js/navigation.js` 不存在而失败，预期包含 `ERR_MODULE_NOT_FOUND`。

- [ ] 1.4 创建 `src/js/navigation.js`，先最小实现 `classifyLink(rawHref)`：

```js
const WINDOWS_ABSOLUTE = /^(?:[a-zA-Z]:[\\/]|\\\\)/;
const SCHEME = /^([a-zA-Z][a-zA-Z\d+.-]*:)/;

function decodeFragment(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function classifyLink(rawHref) {
  const href = String(rawHref ?? '').trim();
  if (href.startsWith('#')) {
    return { kind: 'anchor', fragment: decodeFragment(href.slice(1)) };
  }
  if (WINDOWS_ABSOLUTE.test(href)) return { kind: 'local', href };
  const scheme = href.match(SCHEME)?.[1]?.toLowerCase();
  if (scheme === 'http:' || scheme === 'https:' || scheme === 'mailto:') {
    return { kind: 'external', href };
  }
  if (scheme === 'file:') return { kind: 'local', href };
  if (scheme) return { kind: 'blocked', protocol: scheme };
  return { kind: 'local', href };
}
```

- [ ] 1.5 重跑 `npm.cmd test -- tests/navigation.test.js`，确认分类测试通过。

- [ ] 1.6 增加路径解析的失败测试，覆盖 Windows、Unix、URL 解码、标题片段及不支持扩展名：

```js
test('resolveDocumentLink resolves policy-supported Windows and Unix document paths', () => {
  assert.deepEqual(
    resolveDocumentLink('../guide/next.md#安装', 'C:\\notes\\book\\intro.md'),
    { path: 'C:\\notes\\guide\\next.md', fragment: '安装' },
  );
  assert.deepEqual(
    resolveDocumentLink('./next%20step.txt#part%201', '/notes/book/intro.md'),
    { path: '/notes/book/next step.txt', fragment: 'part 1' },
  );
  assert.deepEqual(
    resolveDocumentLink('file:///C:/notes/absolute.md#top', 'C:\\notes\\book\\intro.md'),
    { path: 'C:\\notes\\absolute.md', fragment: 'top' },
  );
  assert.deepEqual(
    resolveDocumentLink('..\\next.md', '\\\\server\\share\\book\\intro.md'),
    { path: '\\\\server\\share\\next.md', fragment: '' },
  );
  assert.deepEqual(
    resolveDocumentLink('./paper.tex', '/notes/book/intro.md'),
    { path: '/notes/book/paper.tex', fragment: '' },
  );
  assert.deepEqual(
    resolveDocumentLink('../logs/build.log', '/notes/book/intro.md'),
    { path: '/notes/logs/build.log', fragment: '' },
  );
  assert.deepEqual(
    resolveDocumentLink('/guide.md', 'C:\\notes\\intro.md'),
    { path: 'C:\\guide.md', fragment: '' },
  );
  assert.throws(
    () => resolveDocumentLink('../image.png', '/notes/book/intro.md'),
    /不支持的文档类型/,
  );
  assert.throws(
    () => resolveDocumentLink('./bad%ZZ.md', '/notes/book/intro.md'),
    /链接编码无效/,
  );
});
```

- [ ] 1.7 运行单测确认 `resolveDocumentLink` 缺失或断言失败；随后按下列代码实现 `decodeLinkPath`、`normalizeSegments`、Windows/Unix 归一化、file URL 转换，并通过已交付的共享策略完成类型校验：

```js
import { isSupportedDocumentPath } from './file-types.js';

function decodeLinkPath(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new Error('链接编码无效');
  }
}

function normalizeSegments(segments) {
  const result = [];
  for (const segment of segments) {
    if (!segment || segment === '.') continue;
    if (segment === '..') result.pop();
    else result.push(segment);
  }
  return result;
}

function normalizeWindowsPath(value) {
  const path = value.replaceAll('/', '\\');
  if (path.startsWith('\\\\')) {
    const [server, share, ...rest] = path.slice(2).split('\\');
    if (!server || !share) throw new Error('本地文档路径无效');
    const tail = normalizeSegments(rest);
    return `\\\\${server}\\${share}${tail.length ? `\\${tail.join('\\')}` : ''}`;
  }
  const drive = path.match(/^([a-zA-Z]:)\\/);
  if (!drive) throw new Error('本地文档路径无效');
  return `${drive[1]}\\${normalizeSegments(path.slice(3).split('\\')).join('\\')}`;
}

function normalizePosixPath(value) {
  if (!value.startsWith('/')) throw new Error('本地文档路径无效');
  return `/${normalizeSegments(value.split('/')).join('/')}`;
}

function windowsRoot(value) {
  const path = value.replaceAll('/', '\\');
  const drive = path.match(/^([a-zA-Z]:)\\/);
  if (drive) return drive[1];
  if (path.startsWith('\\\\')) {
    const [server, share] = path.slice(2).split('\\');
    if (server && share) return `\\\\${server}\\${share}`;
  }
  throw new Error('本地文档路径无效');
}

function fileUrlToPath(rawPath) {
  let url;
  try {
    url = new URL(rawPath);
  } catch {
    throw new Error('本地文档路径无效');
  }
  if (url.search) throw new Error('本地文档链接不支持查询参数');
  const pathname = decodeLinkPath(url.pathname);
  if (url.hostname && url.hostname !== 'localhost') {
    return `\\\\${url.hostname}${pathname.replaceAll('/', '\\')}`;
  }
  return /^\/[a-zA-Z]:\//.test(pathname) ? pathname.slice(1) : pathname;
}

export function resolveDocumentLink(rawHref, currentFilePath) {
  const href = String(rawHref ?? '').trim();
  const hashIndex = href.indexOf('#');
  const rawPath = hashIndex >= 0 ? href.slice(0, hashIndex) : href;
  const fragment = hashIndex >= 0 ? decodeFragment(href.slice(hashIndex + 1)) : '';
  if (!rawPath) throw new Error('本地文档路径为空');
  if (!/^file:/i.test(rawPath) && rawPath.includes('?')) {
    throw new Error('本地文档链接不支持查询参数');
  }

  const decoded = /^file:/i.test(rawPath) ? fileUrlToPath(rawPath) : decodeLinkPath(rawPath);
  const windows = WINDOWS_ABSOLUTE.test(decoded) || WINDOWS_ABSOLUTE.test(currentFilePath);
  let path;
  if (windows) {
    const normalizedCurrent = currentFilePath.replaceAll('/', '\\');
    const rootRelative = /^[\\/](?![\\/])/.test(decoded);
    const candidate = WINDOWS_ABSOLUTE.test(decoded)
      ? decoded
      : rootRelative
        ? `${windowsRoot(normalizedCurrent)}${decoded.replaceAll('/', '\\')}`
        : `${normalizedCurrent.slice(0, normalizedCurrent.lastIndexOf('\\'))}\\${decoded}`;
    path = normalizeWindowsPath(candidate);
  } else {
    const candidate = decoded.startsWith('/')
      ? decoded
      : `${currentFilePath.slice(0, currentFilePath.lastIndexOf('/'))}/${decoded}`;
    path = normalizePosixPath(candidate);
  }
  if (!isSupportedDocumentPath(path)) throw new Error('不支持的文档类型');
  return { path, fragment };
}
```

`navigation.js` 不缓存或导出自己的支持后缀清单；策略新增格式后，本地链接应仅通过 `file-types.js` 的既有测试和上述代表性解析测试自动获得支持。

- [ ] 1.8 重跑测试，确认两种平台路径和片段解析全部通过。

- [ ] 1.9 增加导航栈失败测试：

```js
test('NavigationHistory supports push, dedupe, pop, and clear', () => {
  const history = new NavigationHistory({ platform: 'windows' });
  history.push({ path: 'C:\\a.md', scrollTop: 120 });
  history.push({ path: 'c:/A.md', scrollTop: 240 });
  assert.equal(history.size, 1);
  assert.equal(history.canGoBack, true);
  assert.deepEqual(history.peek(), { path: 'c:/A.md', scrollTop: 240 });
  assert.deepEqual(history.pop(), { path: 'c:/A.md', scrollTop: 240 });
  assert.equal(history.canGoBack, false);
  history.push({ path: '/b.md', scrollTop: 8 });
  history.clear();
  assert.equal(history.size, 0);
});
```

- [ ] 1.10 实现 `new NavigationHistory({ platform })`；只有显式 Windows 平台比较时忽略大小写和斜杠，同一路径的新快照替换栈顶旧快照，返回值均复制：

```js
function navigationKey(path, platform) {
  const value = String(path);
  return platform === 'windows' ? value.replaceAll('/', '\\').toLowerCase() : value;
}

export class NavigationHistory {
  constructor({ platform = 'posix' } = {}) {
    this.platform = platform;
    this.entries = [];
  }

  push(entry) {
    const copy = { path: String(entry.path), scrollTop: Number(entry.scrollTop) || 0 };
    const top = this.entries.at(-1);
    if (top && navigationKey(top.path, this.platform) === navigationKey(copy.path, this.platform)) {
      this.entries[this.entries.length - 1] = copy;
    } else {
      this.entries.push(copy);
    }
  }

  peek() { return this.entries.length ? { ...this.entries.at(-1) } : null; }
  pop() { return this.entries.length ? { ...this.entries.pop() } : null; }
  clear() { this.entries.length = 0; }
  get size() { return this.entries.length; }
  get canGoBack() { return this.entries.length > 0; }
}
```

- [ ] 1.11 先增加原始缺陷的链接委托回归测试，使用假的 anchor/event 而不依赖浏览器 DOM：

```js
test('markdown link handler prevents WebView navigation and uses raw href', async () => {
  const calls = [];
  let prevented = false;
  const anchor = {
    href: 'http://localhost:1420/linked.md',
    getAttribute: (name) => name === 'href' ? './linked.md' : null,
  };
  const handler = createMarkdownLinkHandler({
    findAnchor: () => anchor,
    onExternal: async (href) => calls.push(['external', href]),
    onAnchor: async (fragment) => calls.push(['anchor', fragment]),
    onLocal: async (href) => calls.push(['local', href]),
    onBlocked: async (protocol) => calls.push(['blocked', protocol]),
    onError: (error) => calls.push(['error', error.message]),
  });

  const promise = handler({ preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
  await promise;
  assert.deepEqual(calls, [['local', './linked.md']]);
});
```

- [ ] 1.12 实现并导出 `createMarkdownLinkHandler(options)`；不得读取会把相对路径绝对化的 `anchor.href`：

```js
export function createMarkdownLinkHandler({
  findAnchor,
  onExternal,
  onAnchor,
  onLocal,
  onBlocked,
  onError,
}) {
  return async function handleMarkdownLink(event) {
    const anchor = findAnchor(event);
    if (!anchor) return false;
    event.preventDefault();
    try {
      const target = classifyLink(anchor.getAttribute('href') ?? '');
      if (target.kind === 'external') await onExternal(target.href, anchor);
      else if (target.kind === 'anchor') await onAnchor(target.fragment, anchor);
      else if (target.kind === 'local') await onLocal(target.href, anchor);
      else await onBlocked(target.protocol, anchor);
    } catch (error) {
      onError(error instanceof Error ? error : new Error(String(error)));
    }
    return true;
  };
}
```

- [ ] 1.13 运行 `npm.cmd test -- tests/navigation.test.js`，预期全部通过；再运行 `npm.cmd run build`，预期 Vite 构建成功。

## Task 2：建立文件库列表与菜单的可测试前端模块

**Files:**

- Existing dependency: `src/js/file-types.js`
- Create: `tests/file-library.test.js`
- Create: `src/js/file-library.js`

- [ ] 2.1 先写纯函数测试：

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyTrashedOutcome,
  buildTrashConfirmationMessage,
  clampMenuPosition,
  fileNameFromPath,
  menuKeyDecision,
  nextSidePanel,
  nextMenuIndex,
  requestTrash,
  samePath,
  validateLibraryPaths,
  welcomePaths,
} from '../src/js/file-library.js';

test('file library helpers handle cross-platform paths and MRU order', () => {
  assert.equal(fileNameFromPath('C:\\docs\\a.md'), 'a.md');
  assert.equal(fileNameFromPath('/docs/b.txt'), 'b.txt');
  assert.equal(samePath('C:\\Docs\\A.md', 'c:/docs/a.md', 'windows'), true);
  assert.equal(samePath('C:\\Docs\\A.md', 'c:/docs/a.md', 'posix'), false);
  assert.equal(welcomePaths(Array.from({ length: 12 }, (_, index) => `${index}.md`)).length, 8);
  assert.deepEqual(validateLibraryPaths(['/docs/paper.tex', '/logs/build.log']), ['/docs/paper.tex', '/logs/build.log']);
  assert.throws(() => validateLibraryPaths(['/docs/image.png']), /不支持的文档类型/);
});

test('clampMenuPosition keeps the menu inside the viewport', () => {
  assert.deepEqual(
    clampMenuPosition({ x: 790, y: 590, width: 180, height: 120, viewportWidth: 800, viewportHeight: 600 }),
    { left: 612, top: 472 },
  );
});

test('menu keyboard navigation wraps and supports first/last', () => {
  assert.equal(nextMenuIndex('ArrowDown', 1, 2), 0);
  assert.equal(nextMenuIndex('ArrowUp', 0, 2), 1);
  assert.equal(nextMenuIndex('Home', 1, 2), 0);
  assert.equal(nextMenuIndex('End', 0, 2), 1);
  assert.equal(nextMenuIndex('Escape', 0, 2), null);
  assert.deepEqual(menuKeyDecision('Home', 0, 2), { handled: true, close: false, restoreFocus: false, nextIndex: 0 });
  assert.deepEqual(menuKeyDecision('Tab', 0, 2), { handled: false, close: true, restoreFocus: false, nextIndex: null });
  assert.deepEqual(menuKeyDecision('Escape', 0, 2), { handled: true, close: true, restoreFocus: true, nextIndex: null });
});

test('nextSidePanel makes library and TOC mutually exclusive', () => {
  assert.equal(nextSidePanel('none', 'library'), 'library');
  assert.equal(nextSidePanel('library', 'toc'), 'toc');
  assert.equal(nextSidePanel('toc', 'toc'), 'none');
});

test('requestTrash cancels without invoking backend and returns a trashed outcome', async () => {
  let backendCalls = 0;
  const common = {
    path: 'C:\\docs\\a.md',
    currentPath: 'C:\\docs\\a.md',
    isDirty: true,
    platform: 'windows',
    trashFile: async () => {
      backendCalls += 1;
      return { trashed: true, files: [], cleanupWarning: null };
    },
  };

  assert.deepEqual(await requestTrash({ ...common, confirmTrash: async () => false }), { status: 'cancelled' });
  assert.equal(backendCalls, 0);
  assert.match(buildTrashConfirmationMessage(common), /未保存修改将丢失/);

  const result = await requestTrash({ ...common, confirmTrash: async () => true });
  assert.equal(result.status, 'trashed');
  assert.equal(backendCalls, 1);
  assert.deepEqual(result.outcome.files, []);

  await assert.rejects(() => requestTrash({
    ...common,
    confirmTrash: async () => true,
    trashFile: async () => { throw new Error('后端拒绝'); },
  }), /后端拒绝/);

  const uiResult = await applyTrashedOutcome(
    { trashed: true, files: [], cleanupWarning: null },
    async () => { throw new Error('界面提交失败'); },
  );
  assert.equal(uiResult.status, 'ui_failed');
  assert.equal(uiResult.outcome.trashed, true);
});
```

- [ ] 2.2 运行 `npm.cmd test -- tests/file-library.test.js`，确认模块缺失而失败。

- [ ] 2.3 创建 `src/js/file-library.js` 并实现上述纯函数：

```js
import { isSupportedDocumentPath } from './file-types.js';

export function fileNameFromPath(path) {
  return String(path).split(/[\\/]/).filter(Boolean).at(-1) ?? String(path);
}

function pathKey(path, platform) {
  const value = String(path);
  return platform === 'windows' ? value.replaceAll('/', '\\').toLowerCase() : value;
}

export function samePath(left, right, platform = 'posix') {
  return pathKey(left, platform) === pathKey(right, platform);
}

export function welcomePaths(paths) {
  return paths.slice(0, 8);
}

export function validateLibraryPaths(paths) {
  if (!Array.isArray(paths)) throw new Error('文件库数据无效');
  for (const path of paths) {
    if (!isSupportedDocumentPath(path)) throw new Error(`文件库包含不支持的文档类型: ${path}`);
  }
  return [...paths];
}

export function clampMenuPosition({ x, y, width, height, viewportWidth, viewportHeight, margin = 8 }) {
  return {
    left: Math.max(margin, Math.min(x, viewportWidth - width - margin)),
    top: Math.max(margin, Math.min(y, viewportHeight - height - margin)),
  };
}

export function nextMenuIndex(key, currentIndex, count) {
  if (key === 'Escape') return null;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  if (key === 'ArrowDown') return (currentIndex + 1) % count;
  if (key === 'ArrowUp') return (currentIndex - 1 + count) % count;
  return currentIndex;
}

export function menuKeyDecision(key, currentIndex, count) {
  if (key === 'Tab') return { handled: false, close: true, restoreFocus: false, nextIndex: null };
  if (key === 'Escape') return { handled: true, close: true, restoreFocus: true, nextIndex: null };
  if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(key)) {
    return { handled: true, close: false, restoreFocus: false, nextIndex: nextMenuIndex(key, currentIndex, count) };
  }
  return { handled: false, close: false, restoreFocus: false, nextIndex: currentIndex };
}

export function nextSidePanel(current, requested) {
  if (!['library', 'toc'].includes(requested)) throw new Error('未知侧栏');
  return current === requested ? 'none' : requested;
}
```

- [ ] 2.4 实现并导出确认消息与可注入回收站协调器：

```js
export function buildTrashConfirmationMessage({ path, currentPath, isDirty, platform = 'posix' }) {
  const dirtyWarning = isDirty && samePath(path, currentPath, platform)
    ? '\n\n当前文件有未保存修改，这些修改将丢失。'
    : '';
  return `确定将“${fileNameFromPath(path)}”移到系统回收站吗？\n\n文件可从系统回收站恢复。${dirtyWarning}`;
}

export async function requestTrash({
  path,
  currentPath,
  isDirty,
  platform,
  confirmTrash,
  trashFile,
}) {
  const message = buildTrashConfirmationMessage({ path, currentPath, isDirty, platform });
  if (!await confirmTrash(message)) return { status: 'cancelled' };
  const outcome = await trashFile(path);
  if (!outcome?.trashed) throw new Error('回收站命令未返回成功状态');
  return { status: 'trashed', outcome };
}

export async function applyTrashedOutcome(outcome, applyUi) {
  try {
    await applyUi(outcome);
    return { status: 'applied', outcome };
  } catch (error) {
    return {
      status: 'ui_failed',
      outcome,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}
```

后端 reject 原样抛出供 `app.js` 作为“尚未移入回收站”错误处理；`requestTrash` 不执行 UI 提交，因此 UI 回调失败绝不会被误报成回收站失败。

- [ ] 2.5 增加并实现 `createFileLibraryView(options)`；路径只通过 `textContent` 进入 DOM；Esc/执行菜单项后恢复触发项焦点，Tab、外部点击、滚动和失焦关闭时不抢回焦点：

```js
export function createFileLibraryView({
  listElement,
  scrollElement,
  emptyElement,
  menuElement,
  platform,
  onOpen,
  onRemove,
  onTrash,
  onError,
  documentRef = globalThis.document,
  windowRef = globalThis.window,
}) {
  const menuItems = [...menuElement.querySelectorAll('[role="menuitem"]')];
  let triggerButton = null;
  let activePath = '';

  function closeMenu({ restoreFocus = true } = {}) {
    menuElement.classList.add('hidden');
    menuElement.style.visibility = '';
    if (restoreFocus) triggerButton?.focus();
    triggerButton = null;
    activePath = '';
  }

  function openMenu(button, path, x, y) {
    triggerButton = button;
    activePath = path;
    menuElement.classList.remove('hidden');
    menuElement.style.visibility = 'hidden';
    const rect = menuElement.getBoundingClientRect();
    const position = clampMenuPosition({
      x,
      y,
      width: rect.width,
      height: rect.height,
      viewportWidth: windowRef.innerWidth,
      viewportHeight: windowRef.innerHeight,
    });
    menuElement.style.left = `${position.left}px`;
    menuElement.style.top = `${position.top}px`;
    menuElement.style.visibility = '';
    menuItems[0]?.focus();
  }

  function onDocumentPointerDown(event) {
    if (!menuElement.classList.contains('hidden') && !menuElement.contains(event.target)) {
      closeMenu({ restoreFocus: false });
    }
  }

  const onPanelScroll = () => closeMenu({ restoreFocus: false });
  const onWindowBlur = () => closeMenu({ restoreFocus: false });

  function onDocumentKeyDown(event) {
    if (menuElement.classList.contains('hidden')) return;
    const current = Math.max(0, menuItems.indexOf(documentRef.activeElement));
    const decision = menuKeyDecision(event.key, current, menuItems.length);
    if (decision.handled) event.preventDefault();
    if (decision.close) closeMenu({ restoreFocus: decision.restoreFocus });
    else if (decision.handled) menuItems[decision.nextIndex]?.focus();
  }

  async function onMenuClick(event) {
    const item = event.target?.closest?.('[data-action]');
    if (!item || !activePath) return;
    const path = activePath;
    const action = item.dataset.action;
    closeMenu();
    try {
      if (action === 'remove') await onRemove(path);
      if (action === 'trash') await onTrash(path);
    } catch (error) {
      onError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  function render(paths, currentPath) {
    const validatedPaths = validateLibraryPaths(paths);
    closeMenu({ restoreFocus: false });
    listElement.replaceChildren();
    emptyElement.classList.toggle('hidden', validatedPaths.length > 0);
    for (const path of validatedPaths) {
      const row = documentRef.createElement('div');
      row.setAttribute('role', 'listitem');
      const button = documentRef.createElement('button');
      button.type = 'button';
      button.className = 'library-item';
      button.setAttribute('aria-haspopup', 'menu');
      if (samePath(path, currentPath, platform)) button.setAttribute('aria-current', 'page');

      const name = documentRef.createElement('span');
      name.className = 'library-item-name';
      name.textContent = fileNameFromPath(path);
      const fullPath = documentRef.createElement('span');
      fullPath.className = 'library-item-path';
      fullPath.textContent = path;
      button.append(name, fullPath);
      button.addEventListener('click', () => {
        Promise.resolve(onOpen(path)).catch((error) => {
          onError(error instanceof Error ? error : new Error(String(error)));
        });
      });
      button.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        openMenu(button, path, event.clientX, event.clientY);
      });
      button.addEventListener('keydown', (event) => {
        if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
        event.preventDefault();
        const rect = button.getBoundingClientRect();
        openMenu(button, path, rect.left, rect.bottom);
      });
      row.append(button);
      listElement.append(row);
    }
  }

  documentRef.addEventListener('pointerdown', onDocumentPointerDown);
  documentRef.addEventListener('keydown', onDocumentKeyDown);
  menuElement.addEventListener('click', onMenuClick);
  scrollElement.addEventListener('scroll', onPanelScroll);
  windowRef.addEventListener('blur', onWindowBlur);

  return {
    render,
    closeMenu,
    destroy() {
      documentRef.removeEventListener('pointerdown', onDocumentPointerDown);
      documentRef.removeEventListener('keydown', onDocumentKeyDown);
      menuElement.removeEventListener('click', onMenuClick);
      scrollElement.removeEventListener('scroll', onPanelScroll);
      windowRef.removeEventListener('blur', onWindowBlur);
      closeMenu({ restoreFocus: false });
    },
  };
}
```

前端验证用于防止损坏或手工篡改的文件库数据进入 DOM，并始终调用 `file-types.js`；后端仍是登记与回收站安全边界，不能因为前端已验证而省略 Task 3/4 的 `file_types.rs` 校验。

`app.js` 将 `onError` 注入为错误 toast；异步菜单操作不得产生 unhandled rejection。

- [ ] 2.6 运行 `npm.cmd test -- tests/file-library.test.js` 与 `npm.cmd run build`，预期全部通过。

## Task 3：用 Rust 文件库替换最近文件存储

**Files:**

- Create: `src-tauri/src/storage.rs`
- Create: `src-tauri/src/library.rs`
- Existing dependency: `src-tauri/src/file_types.rs`
- Modify: `src-tauri/src/main.rs`

- [ ] 3.1 在 `src-tauri/src/storage.rs` 先写严格 JSON、可恢复写入与并发串行化测试。测试模块导入 `Arc`、`AtomicU64`、`AtomicUsize` 和 `Ordering`；测试目录只位于 `std::env::temp_dir()`，名称由进程 ID 和 `AtomicU64` 组成：

```rust
fn test_dir(label: &str) -> PathBuf {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let path = std::env::temp_dir().join(format!(
        "md-reader-{label}-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir_all(&path).unwrap();
    path
}

#[test]
fn corrupt_json_is_reported_instead_of_becoming_empty_data() {
    let dir = test_dir("corrupt-json");
    let path = dir.join("library.json");
    fs::write(&path, "{").unwrap();
    let result: Result<Vec<String>, String> = read_json_or_default(&path);
    assert!(result.unwrap_err().contains("解析"));
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn existence_check_errors_are_not_treated_as_missing() {
    let result = try_path_exists_with(Path::new("library.json"), |_| {
        Err(std::io::Error::from(std::io::ErrorKind::PermissionDenied))
    });
    assert!(result.unwrap_err().contains("检查"));
}

#[test]
fn safe_write_replaces_target_and_recovers_backup() {
    let dir = test_dir("safe-write");
    let path = dir.join("library.json");
    write_json_safely(&path, &vec!["old.md"]).unwrap();
    write_json_safely(&path, &vec!["new.md"]).unwrap();
    assert_eq!(read_json_or_default::<Vec<String>>(&path).unwrap(), vec!["new.md"]);

    fs::rename(&path, backup_path(&path)).unwrap();
    recover_interrupted_write(&path).unwrap();
    assert_eq!(read_json_or_default::<Vec<String>>(&path).unwrap(), vec!["new.md"]);
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn committed_target_wins_over_a_stale_backup() {
    let dir = test_dir("committed-target");
    let path = dir.join("library.json");
    fs::write(&path, r#"["new.md"]"#).unwrap();
    fs::write(backup_path(&path), r#"["old.md"]"#).unwrap();
    recover_interrupted_write(&path).unwrap();
    assert_eq!(read_json_or_default::<Vec<String>>(&path).unwrap(), vec!["new.md"]);
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn orphan_partial_temp_is_discarded_instead_of_promoted() {
    let dir = test_dir("orphan-temp");
    let path = dir.join("library.json");
    fs::write(temp_path(&path), b"[").unwrap();
    recover_interrupted_write(&path).unwrap();
    assert!(!temp_path(&path).try_exists().unwrap());
    assert_eq!(read_json_or_default::<Vec<String>>(&path).unwrap(), Vec::<String>::new());
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn storage_lock_serializes_concurrent_writers() {
    let active = Arc::new(AtomicUsize::new(0));
    let peak = Arc::new(AtomicUsize::new(0));
    let threads: Vec<_> = (0..4).map(|_| {
        let active = Arc::clone(&active);
        let peak = Arc::clone(&peak);
        std::thread::spawn(move || {
            let _guard = lock_storage().unwrap();
            let now = active.fetch_add(1, Ordering::SeqCst) + 1;
            peak.fetch_max(now, Ordering::SeqCst);
            std::thread::sleep(std::time::Duration::from_millis(5));
            active.fetch_sub(1, Ordering::SeqCst);
        })
    }).collect();
    for thread in threads { thread.join().unwrap(); }
    assert_eq!(peak.load(Ordering::SeqCst), 1);
}
```

- [ ] 3.2 在 `main.rs` 加入 `mod storage; mod library;`，运行 `cargo test --manifest-path src-tauri/Cargo.toml storage`，确认因存储函数缺失而失败。

- [ ] 3.3 实现 `storage.rs` 的完整接口：

```rust
pub(crate) fn config_dir() -> Result<PathBuf, String>;
pub(crate) fn lock_storage() -> Result<std::sync::MutexGuard<'static, ()>, String>;
pub(crate) fn try_path_exists(path: &Path) -> Result<bool, String>;
pub(crate) fn read_json_or_default<T>(path: &Path) -> Result<T, String>
where
    T: DeserializeOwned + Default;
pub(crate) fn read_json_required<T>(path: &Path) -> Result<T, String>
where
    T: DeserializeOwned;
pub(crate) fn write_json_safely<T>(path: &Path, value: &T) -> Result<(), String>
where
    T: Serialize + ?Sized;
pub(crate) fn recover_interrupted_write(path: &Path) -> Result<(), String>;
```

`config_dir()` 必须从 `dirs::config_dir()` 得到基目录，缺失时返回错误；创建 `<config>/md-reader` 失败时传播错误，不回退当前工作目录。所有生产存在性检查统一使用 `try_path_exists()`（内部调用 `Path::try_exists`），只有明确的 NotFound 才视为不存在，权限、设备、路径组件和其他 I/O 错误全部传播。`read_json_or_default` 仅在明确不存在时返回 `Default`，读取或解析失败必须带路径返回错误。

`write_json_safely` 在同目录写 `<name>.tmp` 并 `sync_all`，关闭文件句柄后把已有目标改名为 `<name>.bak`，再把 tmp 改为目标；第二次改名失败时恢复 bak。`temp -> target` 成功是唯一提交点：目标缺失且存在 bak 时恢复 bak；目标与 bak 都缺失时，孤立 tmp 无论内容是否完整都代表未提交写入，必须删除而不能提升。提交后删除 bak 失败只能留下待下次清理的 sidecar，不能返回“业务写失败”。所有删除只针对这两个由函数计算的同目录辅助路径。

核心实现固定如下；错误消息可补充中文上下文，但不能改成默认空数据：

```rust
use serde::de::DeserializeOwned;
use serde::Serialize;
use std::fs::{self, File};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, OnceLock};

static STORAGE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

pub(crate) fn lock_storage() -> Result<MutexGuard<'static, ()>, String> {
    STORAGE_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "配置存储锁已损坏".to_string())
}

pub(crate) fn config_dir() -> Result<PathBuf, String> {
    let base = dirs::config_dir().ok_or_else(|| "无法确定系统配置目录".to_string())?;
    let dir = base.join("md-reader");
    fs::create_dir_all(&dir).map_err(|error| format!("创建配置目录失败: {error}"))?;
    Ok(dir)
}

fn try_path_exists_with(
    path: &Path,
    probe: impl FnOnce(&Path) -> io::Result<bool>,
) -> Result<bool, String> {
    probe(path)
        .map_err(|error| format!("检查 {} 是否存在失败: {error}", path.display()))
}

pub(crate) fn try_path_exists(path: &Path) -> Result<bool, String> {
    try_path_exists_with(path, |candidate| candidate.try_exists())
}

fn sidecar_path(path: &Path, suffix: &str) -> Result<PathBuf, String> {
    let name = path.file_name().ok_or_else(|| format!("配置文件路径无效: {}", path.display()))?;
    Ok(path.with_file_name(format!("{}{suffix}", name.to_string_lossy())))
}

pub(crate) fn backup_path(path: &Path) -> PathBuf {
    sidecar_path(path, ".bak").expect("JSON path always has a file name")
}

fn temp_path(path: &Path) -> PathBuf {
    sidecar_path(path, ".tmp").expect("JSON path always has a file name")
}

pub(crate) fn recover_interrupted_write(path: &Path) -> Result<(), String> {
    let backup = backup_path(path);
    let temp = temp_path(path);
    if try_path_exists(path)? {
        let _ = fs::remove_file(&backup);
        let _ = fs::remove_file(&temp);
    } else if try_path_exists(&backup)? {
        fs::rename(&backup, path).map_err(|error| format!("恢复配置备份失败: {error}"))?;
        let _ = fs::remove_file(&temp);
    } else if try_path_exists(&temp)? {
        fs::remove_file(&temp).map_err(|error| format!("清理未提交临时配置失败: {error}"))?;
    }
    Ok(())
}

pub(crate) fn read_json_or_default<T>(path: &Path) -> Result<T, String>
where
    T: DeserializeOwned + Default,
{
    recover_interrupted_write(path)?;
    if !try_path_exists(path)? { return Ok(T::default()); }
    read_json_required(path)
}

pub(crate) fn read_json_required<T>(path: &Path) -> Result<T, String>
where
    T: DeserializeOwned,
{
    recover_interrupted_write(path)?;
    let source = fs::read_to_string(path)
        .map_err(|error| format!("读取 {} 失败: {error}", path.display()))?;
    serde_json::from_str(&source)
        .map_err(|error| format!("解析 {} 失败: {error}", path.display()))
}

pub(crate) fn write_json_safely<T>(path: &Path, value: &T) -> Result<(), String>
where
    T: Serialize + ?Sized,
{
    recover_interrupted_write(path)?;
    let temp = temp_path(path);
    let backup = backup_path(path);
    let bytes = serde_json::to_vec_pretty(value).map_err(|error| format!("序列化配置失败: {error}"))?;
    let mut file = File::create(&temp).map_err(|error| format!("创建临时配置失败: {error}"))?;
    file.write_all(&bytes).map_err(|error| format!("写入临时配置失败: {error}"))?;
    file.sync_all().map_err(|error| format!("同步临时配置失败: {error}"))?;
    drop(file);
    let had_target = try_path_exists(path)?;
    if had_target { fs::rename(path, &backup).map_err(|error| format!("备份旧配置失败: {error}"))?; }
    if let Err(error) = fs::rename(&temp, path) {
        if had_target {
            fs::rename(&backup, path)
                .map_err(|restore| format!("替换配置失败: {error}; 恢复旧配置失败: {restore}"))?;
        }
        return Err(format!("替换配置失败: {error}"));
    }
    if had_target { let _ = fs::remove_file(&backup); }
    Ok(())
}
```

- [ ] 3.4 运行 `cargo fmt --manifest-path src-tauri/Cargo.toml` 和 `cargo test --manifest-path src-tauri/Cargo.toml storage`，预期严格解析和恢复测试通过。

- [ ] 3.5 在 `library.rs` 写迁移、MRU、跨平台去重、不限条数与仅移除记录测试：

```rust
#[test]
fn migrates_recent_file_once_and_keeps_recent_for_rollback() {
    let dir = test_dir("migration");
    fs::write(dir.join("recent.json"), r#"["C:\\a.md","C:\\b.txt"]"#).unwrap();
    let store = LibraryStore::new(dir.clone());

    assert_eq!(store.load().unwrap(), vec!["C:\\a.md", "C:\\b.txt"]);
    assert!(dir.join("library.json").is_file());
    assert!(dir.join("recent.json").is_file());
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn corrupt_recent_aborts_migration_without_creating_library() {
    let dir = test_dir("bad-migration");
    fs::write(dir.join("recent.json"), "[").unwrap();
    let store = LibraryStore::new(dir.clone());
    assert!(store.load().is_err());
    assert!(!dir.join("library.json").exists());
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn register_moves_existing_path_to_front_without_limit() {
    let dir = test_dir("mru");
    let store = LibraryStore::new(dir.clone());
    let paths: Vec<String> = (0..25).map(|index| format!("{index}.md")).collect();
    store.save(&paths).unwrap();
    let result = store.register("24.md").unwrap();
    assert_eq!(result.len(), 25);
    assert_eq!(result.first().unwrap(), "24.md");
    fs::remove_dir_all(dir).unwrap();
}

#[cfg(windows)]
#[test]
fn windows_registration_ignores_case_and_separator_style() {
    let dir = test_dir("windows-key");
    let store = LibraryStore::new(dir.clone());
    store.save(&["C:\\A.md".into(), "C:\\B.md".into()]).unwrap();
    assert_eq!(store.register("c:/b.md").unwrap(), vec!["c:/b.md", "C:\\A.md"]);
    fs::remove_dir_all(dir).unwrap();
}

#[cfg(not(windows))]
#[test]
fn non_windows_registration_preserves_case() {
    let dir = test_dir("posix-key");
    let store = LibraryStore::new(dir.clone());
    store.save(&["/docs/A.md".into()]).unwrap();
    assert_eq!(store.register("/docs/a.md").unwrap(), vec!["/docs/a.md", "/docs/A.md"]);
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn remove_does_not_change_progress_json() {
    let dir = test_dir("remove-only");
    let store = LibraryStore::new(dir.clone());
    store.save(&["a.md".into()]).unwrap();
    fs::write(dir.join("progress.json"), r#"{"a.md":{"scroll_pct":0.5}}"#).unwrap();
    let before = fs::read(dir.join("progress.json")).unwrap();
    assert!(store.remove("a.md").unwrap().is_empty());
    assert_eq!(fs::read(dir.join("progress.json")).unwrap(), before);
    fs::remove_dir_all(dir).unwrap();
}
```

- [ ] 3.6 运行 `cargo test --manifest-path src-tauri/Cargo.toml library`，确认 `LibraryStore` 缺失而失败。

- [ ] 3.7 实现以下后端接口，所有 JSON 读写只通过 `storage.rs`：

```rust
pub(crate) struct LibraryStore {
    config_dir: PathBuf,
}

impl LibraryStore {
    pub(crate) fn new(config_dir: PathBuf) -> Self;
    pub(crate) fn load(&self) -> Result<Vec<String>, String>;
    pub(crate) fn save(&self, paths: &[String]) -> Result<(), String>;
    pub(crate) fn register(&self, path: &str) -> Result<Vec<String>, String>;
    pub(crate) fn remove(&self, path: &str) -> Result<Vec<String>, String>;
    pub(crate) fn contains(&self, path: &str) -> Result<bool, String>;
    pub(crate) fn transaction_path(&self) -> PathBuf;
    pub(crate) fn progress_path(&self) -> PathBuf;
}
```

最小实现如下；Task 4 会在命令入口前加入事务恢复，不改变这些 MRU 方法：

```rust
use crate::file_types;
use crate::storage::{config_dir, read_json_or_default, recover_interrupted_write, try_path_exists, write_json_safely};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

fn ensure_supported_document_path(path: &Path) -> Result<(), String> {
    file_types::classify_path(path)
        .map(|_| ())
        .map_err(|error| error.message)
}

fn validate_library_entries(paths: Vec<String>) -> Result<Vec<String>, String> {
    for path in &paths {
        ensure_supported_document_path(Path::new(path))?;
    }
    Ok(paths)
}

#[cfg(windows)]
fn path_key(path: &str) -> String { path.replace('/', "\\").to_lowercase() }

#[cfg(not(windows))]
fn path_key(path: &str) -> String { path.to_string() }

impl LibraryStore {
    pub(crate) fn new(config_dir: PathBuf) -> Self { Self { config_dir } }
    fn library_path(&self) -> PathBuf { self.config_dir.join("library.json") }
    fn recent_path(&self) -> PathBuf { self.config_dir.join("recent.json") }
    pub(crate) fn progress_path(&self) -> PathBuf { self.config_dir.join("progress.json") }
    pub(crate) fn transaction_path(&self) -> PathBuf { self.config_dir.join("trash-transaction.json") }

    pub(crate) fn load(&self) -> Result<Vec<String>, String> {
        let library = self.library_path();
        recover_interrupted_write(&library)?;
        if try_path_exists(&library)? {
            let paths: Vec<String> = read_json_or_default(&library)?;
            return validate_library_entries(paths);
        }
        let recent: Vec<String> = validate_library_entries(read_json_or_default(&self.recent_path())?)?;
        let mut seen = std::collections::HashSet::new();
        let migrated: Vec<String> = recent
            .into_iter()
            .filter(|path| seen.insert(path_key(path)))
            .collect();
        write_json_safely(&library, &migrated)?;
        Ok(migrated)
    }

    pub(crate) fn save(&self, paths: &[String]) -> Result<(), String> {
        validate_library_entries(paths.to_vec())?;
        write_json_safely(&self.library_path(), paths)
    }

    pub(crate) fn register(&self, path: &str) -> Result<Vec<String>, String> {
        let key = path_key(path);
        let mut paths = self.load()?;
        paths.retain(|existing| path_key(existing) != key);
        paths.insert(0, path.to_string());
        self.save(&paths)?;
        Ok(paths)
    }

    pub(crate) fn remove(&self, path: &str) -> Result<Vec<String>, String> {
        let key = path_key(path);
        let mut paths = self.load()?;
        paths.retain(|existing| path_key(existing) != key);
        self.save(&paths)?;
        Ok(paths)
    }

    pub(crate) fn contains(&self, path: &str) -> Result<bool, String> {
        let key = path_key(path);
        Ok(self.load()?.iter().any(|existing| path_key(existing) == key))
    }
}
```

`LibraryStore` 结构体本身保持 Task 3.7 所列的 `config_dir: PathBuf` 字段；不得在 `load()` 中用 `unwrap_or_default`。

`load()` 在 `library.json` 已存在时只读取它；不存在时严格读取 `recent.json`、按当前平台规则去重并写入 `library.json`，但不删除 `recent.json`。每个条目都通过 `file_types::classify_path` 验证；策略外条目使读取失败并保留原数据，不静默丢弃。Windows 的比较键为斜杠统一后的小写字符串；其他平台使用原字符串。不设置条数上限。

- [ ] 3.8 先写 `document_path_status` 测试：策略支持的临时 `.md`、`.tex`、`.log` 普通文件返回 `File`，缺失 `.md` 返回 `Missing`，同名目录返回 `Other`，`.png` 返回错误；运行 `cargo test --manifest-path src-tauri/Cargo.toml document_path_status`，确认命令缺失而失败。随后增加受限状态枚举与 Tauri 命令薄包装：

```rust
#[test]
fn document_path_status_distinguishes_file_missing_other_and_unsupported() {
    let dir = test_dir("path-status");
    let file = dir.join("file.md");
    let tex = dir.join("paper.tex");
    let log = dir.join("build.log");
    let folder = dir.join("folder.md");
    fs::write(&file, "# test").unwrap();
    fs::write(&tex, "\\section{test}").unwrap();
    fs::write(&log, "build output").unwrap();
    fs::create_dir(&folder).unwrap();
    assert!(matches!(document_path_status(file.to_string_lossy().into_owned()), Ok(DocumentPathStatus::File)));
    assert!(matches!(document_path_status(tex.to_string_lossy().into_owned()), Ok(DocumentPathStatus::File)));
    assert!(matches!(document_path_status(log.to_string_lossy().into_owned()), Ok(DocumentPathStatus::File)));
    assert!(matches!(document_path_status(dir.join("missing.md").to_string_lossy().into_owned()), Ok(DocumentPathStatus::Missing)));
    assert!(matches!(document_path_status(folder.to_string_lossy().into_owned()), Ok(DocumentPathStatus::Other)));
    assert!(document_path_status(dir.join("image.png").to_string_lossy().into_owned()).is_err());
    fs::remove_dir_all(dir).unwrap();
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum DocumentPathStatus {
    Missing,
    File,
    Other,
}

#[tauri::command]
pub(crate) fn get_library_files() -> Result<Vec<String>, String>;

#[tauri::command]
pub(crate) fn register_library_file(path: String) -> Result<Vec<String>, String>;

#[tauri::command]
pub(crate) fn remove_library_file(path: String) -> Result<Vec<String>, String>;

#[tauri::command]
pub(crate) fn document_path_status(path: String) -> Result<DocumentPathStatus, String>;
```

`register_library_file` 必须在写入前通过 `ensure_supported_document_path` 验证目标，并确认当前可作为文件读取；允许把指向受支持文件的符号链接登记到文件库，因为登记本身不修改磁盘。`remove_library_file` 只改 `library.json`，不改原文件或阅读进度；符号链接仍会在回收站命令中被独立拒绝。`document_path_status` 先通过同一策略拒绝不支持的文档，再用 `try_exists` 与 `metadata` 返回 `missing/file/other`，不提供任意路径的裸布尔存在性查询。

命令最小实现固定为：

```rust
fn store() -> Result<LibraryStore, String> {
    Ok(LibraryStore::new(config_dir()?))
}

#[tauri::command]
pub(crate) fn get_library_files() -> Result<Vec<String>, String> {
    let _guard = crate::storage::lock_storage()?;
    store()?.load()
}

#[tauri::command]
pub(crate) fn register_library_file(path: String) -> Result<Vec<String>, String> {
    let _guard = crate::storage::lock_storage()?;
    let target = Path::new(&path);
    ensure_supported_document_path(target)?;
    let metadata = fs::metadata(target).map_err(|error| format!("检查文件失败: {error}"))?;
    if !metadata.is_file() { return Err("目标不是普通文档文件".to_string()); }
    store()?.register(&path)
}

#[tauri::command]
pub(crate) fn remove_library_file(path: String) -> Result<Vec<String>, String> {
    let _guard = crate::storage::lock_storage()?;
    store()?.remove(&path)
}

#[tauri::command]
pub(crate) fn document_path_status(path: String) -> Result<DocumentPathStatus, String> {
    let target = Path::new(&path);
    ensure_supported_document_path(target)?;
    if !target.try_exists().map_err(|error| format!("检查文件失败: {error}"))? {
        return Ok(DocumentPathStatus::Missing);
    }
    let metadata = fs::metadata(target).map_err(|error| format!("检查文件失败: {error}"))?;
    Ok(if metadata.is_file() { DocumentPathStatus::File } else { DocumentPathStatus::Other })
}
```

- [ ] 3.9 运行 `cargo fmt --manifest-path src-tauri/Cargo.toml`，再运行 `cargo test --manifest-path src-tauri/Cargo.toml library`，预期存储、迁移、MRU、去重、状态枚举和仅移除记录测试全部通过。

## Task 4：实现经过后端复核的系统回收站操作

**Files:**

- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/Cargo.lock`
- Modify: `src-tauri/src/library.rs`
- Modify: `src-tauri/src/storage.rs`

- [ ] 4.1 在 `Cargo.toml` 增加 `trash = "5.2.6"` 与 `same-file = "1.0.6"`，由后续 Cargo 命令更新锁文件。`same-file::Handle` 提供稳定 Rust 可用的跨平台文件身份句柄，避免依赖 Windows nightly-only 的 `MetadataExt::file_index`。

- [ ] 4.2 定义回收站事务的序列化契约，然后先写注入式测试；单测中的 `trash_file` 只修改布尔值或临时夹具，绝不调用真实回收站：

```rust
#[derive(Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "snake_case")]
enum TrashPhase { Prepared, Trashed }

#[derive(Serialize, Deserialize, Clone)]
struct TrashTransaction {
    path: String,
    phase: TrashPhase,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TrashOutcome {
    trashed: bool,
    files: Vec<String>,
    cleanup_warning: Option<String>,
}

#[test]
fn rejects_unregistered_missing_directory_symlink_and_unsupported_paths() {
    assert!(validate_trash_candidate(false, FileKind::Regular, Path::new("a.md")).is_err());
    assert!(validate_trash_candidate(true, FileKind::Missing, Path::new("a.md")).is_err());
    assert!(validate_trash_candidate(true, FileKind::Directory, Path::new("a.md")).is_err());
    assert!(validate_trash_candidate(true, FileKind::Symlink, Path::new("a.md")).is_err());
    assert!(validate_trash_candidate(true, FileKind::Regular, Path::new("a.png")).is_err());
}

#[test]
fn accepts_regular_files_from_the_shared_document_policy() {
    assert!(validate_trash_candidate(true, FileKind::Regular, Path::new("paper.tex")).is_ok());
    assert!(validate_trash_candidate(true, FileKind::Regular, Path::new("build.log")).is_ok());
}

#[test]
fn replacement_with_directory_after_prepared_is_rejected_before_trash() {
    let (dir, store, file) = trash_fixture("swap-directory");
    let trash_called = Cell::new(false);
    let result = trash_registered_file_with(
        &store,
        &RealPersistence,
        &file,
        |target| {
            fs::remove_file(target).map_err(|error| error.to_string())?;
            fs::create_dir(target).map_err(|error| error.to_string())?;
            Ok(())
        },
        |_| {
            trash_called.set(true);
            Ok(())
        },
    );
    assert!(result.is_err());
    assert!(!trash_called.get());
    assert!(store.contains(file.to_str().unwrap()).unwrap());
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn replacement_with_different_regular_file_identity_is_rejected() {
    let (dir, store, file) = trash_fixture("swap-identity");
    let replacement = dir.join("replacement.md");
    fs::write(&replacement, "replacement").unwrap();
    let trash_called = Cell::new(false);
    let result = trash_registered_file_with(
        &store,
        &RealPersistence,
        &file,
        |target| {
            fs::remove_file(target).map_err(|error| error.to_string())?;
            fs::rename(&replacement, target).map_err(|error| error.to_string())?;
            Ok(())
        },
        |_| {
            trash_called.set(true);
            Ok(())
        },
    );
    assert!(result.is_err());
    assert!(!trash_called.get());
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn trash_failure_preserves_library_and_progress() {
    let (dir, store, file) = trash_fixture("trash-failure");
    let result = trash_registered_file_with(
        &store,
        &RealPersistence,
        &file,
        |_| Ok(()),
        |_| Err("模拟失败".into()),
    );
    assert!(result.is_err());
    assert!(store.contains(file.to_str().unwrap()).unwrap());
    assert!(progress_contains(&store, file.to_str().unwrap()).unwrap());
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn library_write_failure_after_trash_returns_partial_success_and_recovers() {
    let (dir, store, file) = trash_fixture("library-failure");
    let persistence = FailingPersistence::once(FailPoint::Library);
    let outcome = trash_registered_file_with(&store, &persistence, &file, |_| Ok(()), |target| {
        fs::remove_file(target).map_err(|error| error.to_string())
    }).unwrap();
    assert!(outcome.trashed);
    assert!(outcome.cleanup_warning.is_some());
    assert!(store.transaction_path().exists());
    recover_pending_trash(&store, &RealPersistence).unwrap();
    assert!(!store.contains(file.to_str().unwrap()).unwrap());
    assert!(!progress_contains(&store, file.to_str().unwrap()).unwrap());
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn progress_write_failure_after_trash_returns_partial_success_and_recovers() {
    let (dir, store, file) = trash_fixture("progress-failure");
    let persistence = FailingPersistence::once(FailPoint::Progress);
    let outcome = trash_registered_file_with(&store, &persistence, &file, |_| Ok(()), |target| {
        fs::remove_file(target).map_err(|error| error.to_string())
    }).unwrap();
    assert!(outcome.trashed);
    assert!(outcome.cleanup_warning.is_some());
    recover_pending_trash(&store, &RealPersistence).unwrap();
    assert!(!progress_contains(&store, file.to_str().unwrap()).unwrap());
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn trashed_phase_write_failure_stops_metadata_writes_and_recovers_delta() {
    let (dir, store, file) = trash_fixture("phase-failure");
    let persistence = FailingPersistence::once(FailPoint::TransactionPhase);
    let outcome = trash_registered_file_with(&store, &persistence, &file, |_| Ok(()), |target| {
        fs::remove_file(target).map_err(|error| error.to_string())
    }).unwrap();
    assert!(outcome.trashed);
    assert!(outcome.cleanup_warning.is_some());
    assert!(store.contains(file.to_str().unwrap()).unwrap());
    assert!(progress_contains(&store, file.to_str().unwrap()).unwrap());
    recover_pending_trash(&store, &RealPersistence).unwrap();
    assert!(!store.contains(file.to_str().unwrap()).unwrap());
    assert!(!progress_contains(&store, file.to_str().unwrap()).unwrap());
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn journal_removal_failure_returns_warning_and_recovery_is_idempotent() {
    let (dir, store, file) = trash_fixture("journal-removal");
    let persistence = FailingPersistence::once(FailPoint::RemoveJournal);
    let outcome = trash_registered_file_with(&store, &persistence, &file, |_| Ok(()), |target| {
        fs::remove_file(target).map_err(|error| error.to_string())
    }).unwrap();
    assert!(outcome.trashed);
    assert!(outcome.cleanup_warning.is_some());
    assert!(store.transaction_path().exists());
    recover_pending_trash(&store, &RealPersistence).unwrap();
    assert!(!store.contains(file.to_str().unwrap()).unwrap());
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn prepared_transaction_is_discarded_when_target_still_exists() {
    let (dir, store, file) = trash_fixture("prepared-exists");
    write_prepared_fixture(&store, &file);
    recover_pending_trash(&store, &RealPersistence).unwrap();
    assert!(store.contains(file.to_str().unwrap()).unwrap());
    assert!(!store.transaction_path().exists());
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn prepared_transaction_is_replayed_when_target_is_missing() {
    let (dir, store, file) = trash_fixture("prepared-missing");
    write_prepared_fixture(&store, &file);
    fs::remove_file(&file).unwrap();
    recover_pending_trash(&store, &RealPersistence).unwrap();
    assert!(!store.contains(file.to_str().unwrap()).unwrap());
    assert!(!progress_contains(&store, file.to_str().unwrap()).unwrap());
    fs::remove_dir_all(dir).unwrap();
}
```

- [ ] 4.3 测试模块定义以下故障注入辅助，然后运行 `cargo test --manifest-path src-tauri/Cargo.toml trash_`，确认事务函数缺失而失败：

```rust
#[derive(Clone, Copy, PartialEq, Eq)]
enum FailPoint { TransactionPhase, Library, Progress, RemoveJournal }

fn trash_fixture(label: &str) -> (PathBuf, LibraryStore, PathBuf) {
    let dir = test_dir(label);
    let file = dir.join("file.md");
    fs::write(&file, "# fixture").unwrap();
    let store = LibraryStore::new(dir.clone());
    store.save(&[file.to_string_lossy().into_owned()]).unwrap();
    let mut progress = serde_json::Map::new();
    progress.insert(file.to_string_lossy().into_owned(), serde_json::json!({ "scroll_pct": 0.5 }));
    crate::storage::write_json_safely(&store.progress_path(), &progress).unwrap();
    (dir, store, file)
}

struct FailingPersistence {
    point: FailPoint,
    failed: Cell<bool>,
}

impl FailingPersistence {
    fn once(point: FailPoint) -> Self { Self { point, failed: Cell::new(false) } }
    fn should_fail(&self, point: FailPoint) -> bool {
        if self.point == point && !self.failed.replace(true) { true } else { false }
    }
}

impl TrashPersistence for FailingPersistence {
    fn write_transaction(&self, store: &LibraryStore, value: &TrashTransaction) -> Result<(), String> {
        if value.phase == TrashPhase::Trashed && self.should_fail(FailPoint::TransactionPhase) {
            Err("模拟 trashed 阶段写入失败".into())
        } else {
            RealPersistence.write_transaction(store, value)
        }
    }
    fn remove_transaction(&self, store: &LibraryStore) -> Result<(), String> {
        if self.should_fail(FailPoint::RemoveJournal) { Err("模拟事务日志删除失败".into()) }
        else { RealPersistence.remove_transaction(store) }
    }
    fn write_library(&self, store: &LibraryStore, files: &[String]) -> Result<(), String> {
        if self.should_fail(FailPoint::Library) { Err("模拟 library 写入失败".into()) }
        else { RealPersistence.write_library(store, files) }
    }
    fn write_progress(
        &self,
        store: &LibraryStore,
        progress: &serde_json::Map<String, serde_json::Value>,
    ) -> Result<(), String> {
        if self.should_fail(FailPoint::Progress) { Err("模拟 progress 写入失败".into()) }
        else { RealPersistence.write_progress(store, progress) }
    }
}

fn progress_contains(store: &LibraryStore, path: &str) -> Result<bool, String> {
    let progress: serde_json::Map<String, serde_json::Value> =
        crate::storage::read_json_or_default(&store.progress_path())?;
    let key = path_key(path);
    Ok(progress.keys().any(|entry| path_key(entry) == key))
}

fn write_prepared_fixture(store: &LibraryStore, path: &Path) {
    RealPersistence.write_transaction(store, &TrashTransaction {
        path: path.to_string_lossy().into_owned(),
        phase: TrashPhase::Prepared,
    }).unwrap();
}
```

- [ ] 4.4 实现纯校验枚举 `FileKind { Missing, Regular, Directory, Symlink, Other }` 与 `validate_trash_candidate(registered, kind, path)`；生产代码用错误感知的 `storage::try_path_exists` 和 `symlink_metadata` 映射该枚举，因而 Windows 不需要创建真实符号链接也能覆盖拒绝分支。另用 `same_file::Handle` 保存跨平台文件身份；创建句柄前后都必须确认路径本身不是符号链接且句柄指向普通文件，拿不到句柄或元数据时拒绝回收。

```rust
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum FileKind { Missing, Regular, Directory, Symlink, Other }

fn file_kind(path: &Path) -> Result<FileKind, String> {
    if !crate::storage::try_path_exists(path)? {
        return Ok(FileKind::Missing);
    }
    let metadata = fs::symlink_metadata(path).map_err(|error| format!("检查文件失败: {error}"))?;
    let kind = metadata.file_type();
    Ok(if kind.is_symlink() {
        FileKind::Symlink
    } else if kind.is_file() {
        FileKind::Regular
    } else if kind.is_dir() {
        FileKind::Directory
    } else {
        FileKind::Other
    })
}

fn regular_file_handle(path: &Path) -> Result<same_file::Handle, String> {
    let path_metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("重新检查待回收文件失败: {error}"))?;
    if path_metadata.file_type().is_symlink() || !path_metadata.is_file() {
        return Err("待回收路径发生变化，不再是原普通文件".to_string());
    }
    let handle = same_file::Handle::from_path(path)
        .map_err(|error| format!("打开待回收文件身份句柄失败: {error}"))?;
    let opened_metadata = handle.as_file().metadata()
        .map_err(|error| format!("读取待回收文件身份失败: {error}"))?;
    if !opened_metadata.is_file() {
        return Err("待回收路径发生变化，不再是原普通文件".to_string());
    }
    Ok(handle)
}

fn validate_trash_candidate(registered: bool, kind: FileKind, path: &Path) -> Result<(), String> {
    if !registered { return Err("文件未登记在文件目录中".to_string()); }
    if kind != FileKind::Regular { return Err("只允许把已登记的普通文件移到回收站".to_string()); }
    ensure_supported_document_path(path)?;
    Ok(())
}
```

这里的 TeX/LOG 只是验证策略接线的代表性夹具；生产 allowlist 仍来自 `file_types::classify_path`，不得把测试中的后缀重新写成 `matches!`。

- [ ] 4.5 实现 `TrashPersistence` trait；方法签名固定为 `write_transaction(&self, store, transaction)`、`remove_transaction(&self, store)`、`write_library(&self, store, files)`、`write_progress(&self, store, progress)`。`RealPersistence` 的三个写方法全部调用 `storage::write_json_safely`，删除只针对 `store.transaction_path()`。`progress.json` 读取为 `serde_json::Map<String, Value>`，所以无需与 `main.rs::ReadingProgress` 共享类型且能保留未知字段；解析损坏必须返回错误。

```rust
trait TrashPersistence {
    fn write_transaction(&self, store: &LibraryStore, value: &TrashTransaction) -> Result<(), String>;
    fn remove_transaction(&self, store: &LibraryStore) -> Result<(), String>;
    fn write_library(&self, store: &LibraryStore, files: &[String]) -> Result<(), String>;
    fn write_progress(
        &self,
        store: &LibraryStore,
        progress: &serde_json::Map<String, serde_json::Value>,
    ) -> Result<(), String>;
}

struct RealPersistence;

impl TrashPersistence for RealPersistence {
    fn write_transaction(&self, store: &LibraryStore, value: &TrashTransaction) -> Result<(), String> {
        crate::storage::write_json_safely(&store.transaction_path(), value)
    }

    fn remove_transaction(&self, store: &LibraryStore) -> Result<(), String> {
        let path = store.transaction_path();
        match fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(format!("清理回收站事务失败: {error}")),
        }
    }

    fn write_library(&self, store: &LibraryStore, files: &[String]) -> Result<(), String> {
        store.save(files)
    }

    fn write_progress(
        &self,
        store: &LibraryStore,
        progress: &serde_json::Map<String, serde_json::Value>,
    ) -> Result<(), String> {
        crate::storage::write_json_safely(&store.progress_path(), progress)
    }
}
```

- [ ] 4.6 日志只保存 `{ path, phase }` 增量，不保存整份文件库/进度快照，防止恢复时覆盖后来产生的状态。实现顺序：校验并取得原始 `same_file::Handle` → 计算仅供即时 UI 使用的 `files_after` → 安全写 `phase=prepared` → 紧接着重新确认路径仍是普通非符号链接并取得第二个句柄 → 两个句柄不相等或复核失败时删日志并返回 `Err`，不得调用回收站。句柄相等时，在二次校验与 `trash_file(path)` 之间不执行其他文件系统操作；释放两个只读句柄后立即调用回收站闭包。

回收站闭包失败则删日志并返回 `Err`（业务 JSON 未改）→ 闭包成功后写 `phase=trashed`。若该阶段写失败，立即返回 `trashed=true` 警告，不再写业务 JSON，保留 prepared 日志供“目标已不存在”恢复。阶段写成功后才按当前 JSON 增量移除该路径，再删除日志。回收站已成功后的任何清理错误都返回 `Ok(TrashOutcome { trashed: true, files: files_after, cleanup_warning: Some(cleanup_error) })`。

- [ ] 4.7 实现 `recover_pending_trash`：无日志直接成功；`prepared` 且目标仍存在时删除日志、不改业务 JSON；`prepared` 且目标明确不存在或 `trashed` 时幂等写入日志中的两份目标状态，成功后删日志；存在性检查或重放写入失败时保留日志并返回错误。`get/register/remove/trash` 每个文件库命令开始时都调用恢复函数。

```rust
fn recover_pending_trash(
    store: &LibraryStore,
    persistence: &impl TrashPersistence,
) -> Result<(), String> {
    let transaction_path = store.transaction_path();
    crate::storage::recover_interrupted_write(&transaction_path)?;
    if !crate::storage::try_path_exists(&transaction_path)? { return Ok(()); }
    let transaction: TrashTransaction = crate::storage::read_json_required(&transaction_path)?;
    let target_exists = Path::new(&transaction.path)
        .try_exists()
        .map_err(|error| format!("检查待恢复文件失败: {error}"))?;
    if transaction.phase == TrashPhase::Prepared && target_exists {
        return persistence.remove_transaction(store);
    }
    remove_path_from_metadata(store, persistence, &transaction.path)?;
    persistence.remove_transaction(store)
}

fn remove_path_from_metadata(
    store: &LibraryStore,
    persistence: &impl TrashPersistence,
    path: &str,
) -> Result<Vec<String>, String> {
    let key = path_key(path);
    let mut files = store.load()?;
    files.retain(|entry| path_key(entry) != key);
    persistence.write_library(store, &files)?;

    let mut progress: serde_json::Map<String, serde_json::Value> =
        crate::storage::read_json_or_default(&store.progress_path())?;
    progress.retain(|entry, _| path_key(entry) != key);
    persistence.write_progress(store, &progress)?;
    Ok(files)
}
```

把 Task 3 的 `store()` 替换为恢复后的构造器，四个文件库命令统一使用它：

```rust
fn recovered_store() -> Result<LibraryStore, String> {
    let store = LibraryStore::new(crate::storage::config_dir()?);
    recover_pending_trash(&store, &RealPersistence)?;
    Ok(store)
}
```

`get_library_files`、`register_library_file`、`remove_library_file` 使用 `recovered_store()`；`trash_library_file` 也先调用它，不能只依赖前端启动时曾加载侧栏。

`TrashTransaction` 不实现 `Default`；读取现有日志必须使用不带 `Default` 约束的 `storage::read_json_required<T>()`。把损坏事务日志返回错误的断言加入 `storage.rs` 测试。

```rust
fn trash_registered_file_with<A, F>(
    store: &LibraryStore,
    persistence: &impl TrashPersistence,
    path: &Path,
    after_prepared: A,
    trash_file: F,
) -> Result<TrashOutcome, String>
where
    A: FnOnce(&Path) -> Result<(), String>,
    F: FnOnce(&Path) -> Result<(), String>;

#[tauri::command]
pub(crate) fn trash_library_file(path: String) -> Result<TrashOutcome, String> {
    let _guard = crate::storage::lock_storage()?;
    let store = recovered_store()?;
    trash_registered_file_with(
        &store,
        &RealPersistence,
        Path::new(&path),
        |_| Ok(()),
        |target| trash::delete(target).map_err(|error| format!("移到系统回收站失败: {error}")),
    )
}
```

`after_prepared` 只用于单测在日志落盘后模拟外部路径替换；生产调用固定传无操作闭包。`trash_registered_file_with` 的函数体按以下代码实现；增量清理通过 `path_key` 比较，保留其他 JSON 值原样：

```rust
let registered = store.contains(path.to_string_lossy().as_ref())?;
let kind = file_kind(path)?;
validate_trash_candidate(registered, kind, path)?;
let original_handle = regular_file_handle(path)?;

let key = path_key(path.to_string_lossy().as_ref());
let mut files_after = store.load()?;
files_after.retain(|entry| path_key(entry) != key);

let mut transaction = TrashTransaction {
    path: path.to_string_lossy().into_owned(),
    phase: TrashPhase::Prepared,
};
persistence.write_transaction(store, &transaction)?;
let abort_prepared = |error: String| -> Result<TrashOutcome, String> {
    let journal_error = persistence.remove_transaction(store).err();
    Err(match journal_error {
        Some(cleanup) => format!("{error}; 清理事务记录失败: {cleanup}"),
        None => error,
    })
};
if let Err(error) = after_prepared(path) {
    return abort_prepared(error);
}
let current_handle = match regular_file_handle(path) {
    Ok(handle) => handle,
    Err(error) => return abort_prepared(format!("待回收文件发生变化: {error}")),
};
if original_handle != current_handle {
    return abort_prepared("待回收文件发生变化，已取消操作".to_string());
}
drop(current_handle);
drop(original_handle);
if let Err(error) = trash_file(path) {
    return abort_prepared(error);
}

let mut warnings = Vec::new();
transaction.phase = TrashPhase::Trashed;
if let Err(error) = persistence.write_transaction(store, &transaction) {
    return Ok(TrashOutcome {
        trashed: true,
        files: files_after,
        cleanup_warning: Some(error),
    });
}
match remove_path_from_metadata(store, persistence, &transaction.path) {
    Ok(current_files) => files_after = current_files,
    Err(error) => warnings.push(error),
}
if warnings.is_empty() {
    if let Err(error) = persistence.remove_transaction(store) {
        warnings.push(error);
    }
}

Ok(TrashOutcome {
    trashed: true,
    files: files_after,
    cleanup_warning: (!warnings.is_empty()).then(|| warnings.join("; ")),
})
```

- [ ] 4.8 增量清理按当前平台路径比较规则匹配键；文件不存在或 JSON 无对应键时不报错。应用启动恢复后重新读取当前 `library.json` 返回侧栏，不从旧日志覆盖整份状态。

- [ ] 4.9 运行 `cargo fmt --manifest-path src-tauri/Cargo.toml` 与 `cargo test --manifest-path src-tauri/Cargo.toml library`，预期所有安全边界、回收站失败原子性、成功后的部分清理失败和崩溃恢复测试通过。

## Task 5：接入 Tauri opener、命令注册与最小权限

**Files:**

- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/Cargo.lock`
- Modify: `src-tauri/src/main.rs`
- Modify: `src-tauri/src/storage.rs`
- Modify: `src-tauri/capabilities/default.json`
- Existing dependencies: `src-tauri/src/file_types.rs`, `tests/configuration.test.js`

- [ ] 5.1 修改 Rust 依赖：增加 `tauri-plugin-opener = "2"`，并按 Tauri 官方桌面目标配置增加 `tauri-plugin-single-instance = "2"`。`tauri-plugin-fs` 已在前置基础中删除，本步骤只验证它仍不存在，不再执行一次“待删除”工作。单实例保证不同进程不争写固定 JSON/事务日志，`storage::lock_storage` 负责同一进程内命令串行化。

```toml
[dependencies]
tauri-plugin-opener = "2"
trash = "5.2.6"
same-file = "1.0.6"

[target.'cfg(any(target_os = "macos", windows, target_os = "linux"))'.dependencies]
tauri-plugin-single-instance = "2"
```

其余现有依赖保留，不重新引入 `tauri-plugin-fs`。

- [ ] 5.2 先给进度存储抽出 `save_reading_progress_at(config_dir, path, scroll_pct)` 与 `load_reading_progress_at(config_dir, path)`，并写以下测试；测试模块使用与 Task 3 相同的 PID + `AtomicU64` 临时目录生成代码，而不是固定目录：

```rust
#[test]
fn reading_progress_corruption_is_reported() {
    let dir = progress_test_dir("corrupt");
    fs::write(dir.join("progress.json"), "{").unwrap();
    assert!(load_reading_progress_at(&dir, "a.md").is_err());
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn reading_progress_accepts_legacy_scroll_top_field() {
    let dir = progress_test_dir("legacy");
    fs::write(dir.join("progress.json"), r#"{"a.md":{"scroll_top":12.0,"scroll_pct":0.4}}"#).unwrap();
    assert_eq!(load_reading_progress_at(&dir, "a.md").unwrap().scroll_pct, 0.4);
    fs::remove_dir_all(dir).unwrap();
}
```

运行 `cargo test --manifest-path src-tauri/Cargo.toml reading_progress_`，确认旧实现不满足测试。

- [ ] 5.3 在 `main.rs` 中移除 `read_file_with_registration` / `save_recent_file` 的旧最近文件副作用，让已交付的 `read_document(path, allow_large_log)` 在成功解码后直接返回；保留 `inspect_document`、二次大日志阈值校验、结构化错误与 LOG 只读边界。删除旧 `config_dir`、`save_recent_file`、`get_recent_files` 和未使用的 `AppState`。把 `ReadingProgress` 收缩为只有 `scroll_pct: f64`，保持 serde 默认忽略旧 JSON 中的多余 `scroll_top`。保存/加载实现固定为：

```rust
fn save_reading_progress_at(config: &Path, path: String, scroll_pct: f64) -> Result<(), String> {
    let progress_file = config.join("progress.json");
    let mut map: std::collections::HashMap<String, ReadingProgress> =
        storage::read_json_or_default(&progress_file)?;
    map.insert(path, ReadingProgress { scroll_pct });
    storage::write_json_safely(&progress_file, &map)
}

fn load_reading_progress_at(config: &Path, path: &str) -> Result<ReadingProgress, String> {
    let progress_file = config.join("progress.json");
    let map: std::collections::HashMap<String, ReadingProgress> =
        storage::read_json_or_default(&progress_file)?;
    Ok(map.get(path).cloned().unwrap_or_default())
}

#[tauri::command]
fn save_reading_progress(path: String, scroll_pct: f64) -> Result<(), String> {
    let _guard = storage::lock_storage()?;
    save_reading_progress_at(&storage::config_dir()?, path, scroll_pct)
}

#[tauri::command]
fn load_reading_progress(path: String) -> Result<ReadingProgress, String> {
    let _guard = storage::lock_storage()?;
    load_reading_progress_at(&storage::config_dir()?, &path)
}
```

不得吞解析或写入错误。CLI 参数收集和文件打开事件继续直接调用已交付的 `file_types::is_supported_document_path(Path::new(&path))`，不得经 `library.rs` 反向依赖或恢复重复的字符串后缀判断函数。

- [ ] 5.4 先把 CLI 解析抽为 `collect_file_args_from(args, cwd)` 并写测试：临时 cwd 下的相对 `.md`、`.tex`、`.log` 均按共享策略解析为现有文件，`.png`、选项和缺失文件被忽略。运行 `cargo test --manifest-path src-tauri/Cargo.toml forwarded_file_args` 确认测试失败，再实现该纯函数，让现有首次启动 `collect_cli_file_args()` 和单实例回调共用它。

```rust
fn collect_file_args_from<I, S>(args: I, cwd: &Path) -> Vec<String>
where
    I: IntoIterator<Item = S>,
    S: Into<String>,
{
    args.into_iter()
        .skip(1)
        .map(Into::into)
        .filter(|raw: &String| !raw.starts_with('-'))
        .filter_map(|raw| {
            let normalized = normalize_file_path(&raw);
            let candidate = PathBuf::from(normalized);
            let absolute = if candidate.is_absolute() { candidate } else { cwd.join(candidate) };
            let regular_file = fs::symlink_metadata(&absolute)
                .map(|metadata| metadata.file_type().is_file())
                .unwrap_or(false);
            (file_types::is_supported_document_path(&absolute) && regular_file)
                .then(|| absolute.to_string_lossy().into_owned())
        })
        .collect()
}

fn collect_cli_file_args() -> Vec<String> {
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    collect_file_args_from(std::env::args(), &cwd)
}
```

测试必须创建真实临时 `relative.md`、`paper.tex`、`build.log` 后传入 `vec!["md-reader", "relative.md", "paper.tex", "build.log", "missing.md", "image.png", "--flag"]`，断言只按参数顺序返回三个策略支持文件的绝对路径并清理临时目录。这验证 CLI 的运行时五格式边界，不得据此扩大 Tauri 系统文件关联。

- [ ] 5.5 把 single-instance 作为第一个插件注册；将现有仅供部分平台编译的 `emit_file_opened` 抽成桌面端可用的共用函数，并保留其 `file_types::is_supported_document_path` 与普通文件校验。第二实例的参数经该函数转交已有主窗口并聚焦，不启动第二套配置写入者：

```rust
let mut builder = tauri::Builder::default()
    .manage(CliArgs(Mutex::new(initial_args)));

#[cfg(desktop)]
{
    builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
        for path in collect_file_args_from(args, Path::new(&cwd)) {
            emit_file_opened(app, path);
        }
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.show();
            let _ = window.set_focus();
        }
    }));
}

builder
.plugin(tauri_plugin_dialog::init())
.plugin(tauri_plugin_opener::init())
.plugin(
    tauri_plugin_window_state::Builder::new()
        .with_filename("window-state.json")
        .build(),
)
.invoke_handler(tauri::generate_handler![
    inspect_document,
    read_file,
    save_file,
    save_reading_progress,
    load_reading_progress,
    library::get_library_files,
    library::register_library_file,
    library::remove_library_file,
    library::trash_library_file,
    library::document_path_status,
    get_cli_args,
])
```

把原 Task 5.4 的插件/命令注册内容合并到上述 builder，确保 single-instance 位于其他插件之前。

- [ ] 5.6 从已交付的“无 `fs:*`”`default.json` 基线出发，将权限收缩为现有核心、窗口状态、`dialog:default`，以及三个 opener URL 范围；删除重复/弃用的显式 dialog 权限，但不得重新加入任何前端文件系统权限：

```json
{
  "identifier": "opener:allow-open-url",
  "allow": [
    { "url": "http://*" },
    { "url": "https://*" },
    { "url": "mailto:*" }
  ]
}
```

- [ ] 5.7 运行 `npm.cmd test -- tests/configuration.test.js` 与 `cargo test --manifest-path src-tauri/Cargo.toml`，预期系统关联仍严格为 `.md` / `.markdown` / `.txt`、前端仍无 `fs:*` 权限、锁文件完成更新且测试通过；再运行 `cargo check --manifest-path src-tauri/Cargo.toml`，预期 capability 生成与 Rust 编译无错误。三个 `opener:allow-open-url` scope 已按 Tauri 2 插件 schema 固定，不得改成 `opener:allow-default-urls`、任意协议或 shell 命令。

## Task 6：加入侧栏、返回按钮和上下文菜单，并复用既有未保存确认 UI

**Files:**

- Create: `tests/markup.test.js`
- Modify: `index.html`
- Modify: `src/css/reader.css`

- [ ] 6.1 先写 HTML 契约测试：

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('index exposes library, back, context-menu, and dirty-switch hooks', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  for (const id of ['btn-library', 'btn-back', 'library-panel', 'library-list', 'library-empty', 'library-error-text', 'library-retry', 'file-context-menu', 'dirty-switch-dialog']) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
  assert.match(html, /role=["']menu["']/);
  assert.match(html, /id=["']btn-library["'][^>]*type=["']button["'][^>]*aria-expanded=["']false["'][^>]*aria-controls=["']library-panel["']/);
  assert.match(html, /id=["']btn-toc["'][^>]*aria-expanded=["']false["'][^>]*aria-controls=["']toc-panel["']/);
  assert.match(html, /id=["']btn-back["'][^>]*class=["'][^"']*hidden/);
  assert.match(html, /data-action=["']remove["']/);
  assert.match(html, /data-action=["']trash["']/);
  assert.equal((html.match(/role=["']menuitem["']/g) ?? []).length, 2);
  for (const result of ['save', 'discard', 'cancel']) {
    assert.match(html, new RegExp(`data-dialog-result=["']${result}["']`));
  }
});
```

- [ ] 6.2 运行 `npm.cmd test -- tests/markup.test.js`，确认因标记缺失而失败。

- [ ] 6.3 在工具栏左区按“打开 → 文件目录 → 返回 → 文件名”顺序加入 `btn-library` 和默认隐藏的 `btn-back`；新增按钮都显式设置 `type="button"`，使用现有线性 SVG 风格并提供中文 `title` 和 `aria-label`。`btn-library` 使用 `aria-expanded="false"`、`aria-controls="library-panel"`；现有 `btn-toc` 同步补上 `type="button"`、`aria-expanded="false"`、`aria-controls="toc-panel"`。

- [ ] 6.4 在 `main` 内、`toc-panel` 之前加入：

```html
<aside id="library-panel" class="side-panel library-panel hidden" aria-label="文件目录">
  <div class="side-panel-title">文件目录</div>
  <div id="library-error" class="library-error hidden">
    <div id="library-error-text" class="library-message" role="status" aria-live="polite"></div>
    <button id="library-retry" type="button">重试</button>
  </div>
  <div id="library-empty" class="library-message">尚未打开文件</div>
  <div id="library-list" class="library-list" role="list"></div>
</aside>
```

把原 `toc-panel` 同时加上共享的 `side-panel` 类。

- [ ] 6.5 在 `body` 末尾加入默认隐藏菜单：

```html
<div id="file-context-menu" class="context-menu hidden" role="menu" aria-label="文件操作">
  <button type="button" role="menuitem" data-action="remove">移出文件目录</button>
  <button type="button" role="menuitem" data-action="trash" class="danger">移到回收站…</button>
</div>
```

保留前置基础中已经存在的原生 `<dialog id="dirty-switch-dialog">` 及三个 `data-dialog-result="save|discard|cancel"` 按钮，不创建第二个对话框，也不改写其三分支契约。Esc、关闭或未知结果仍由现有 `promptDialog` 归为 `cancel`。

- [ ] 6.6 在 `reader.css` 抽取 `.side-panel` 的 240px 宽度、背景、边框、滚动和进入动画；增加文件条目、当前态、双行截断、空/错误状态、上下文菜单与危险操作样式。菜单使用 `position: fixed` 和高于侧栏但低于 toast 的 z-index；给工具按钮、文件按钮、菜单项、既有对话框按钮和重试按钮增加不依赖颜色的 `:focus-visible` 轮廓。保留已交付 `.document-dialog` 的 backdrop、窄窗口限制与原生 modal 焦点行为，不重复新增一套未保存确认样式。

```css
.side-panel {
  width: 240px;
  min-width: 240px;
  flex-shrink: 0;
  overflow-y: auto;
  background: var(--bg-secondary);
  border-right: 1px solid var(--border-light);
  animation: slideRight 0.3s var(--ease-out);
}

.library-panel { padding: 20px 12px; }
.side-panel-title { padding: 0 8px 12px; font-size: 11px; font-weight: 600; color: var(--text-muted); }
.library-list { display: grid; gap: 4px; }
.library-item {
  width: 100%;
  padding: 9px 10px;
  display: flex;
  flex-direction: column;
  gap: 3px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--text);
  text-align: left;
  cursor: pointer;
}
.library-item:hover { background: var(--bg-hover); }
.library-item[aria-current="page"] { background: var(--accent-light); color: var(--accent); }
.library-item-name, .library-item-path { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.library-item-name { font-size: 13px; font-weight: 600; }
.library-item-path { font-size: 11px; color: var(--text-muted); }
.library-message { padding: 16px 8px; color: var(--text-muted); font-size: 12px; line-height: 1.6; }
.library-error { padding: 8px; }
.library-error .library-message { padding: 0 0 8px; }
.library-error button { border: 1px solid var(--border); border-radius: 7px; background: var(--bg-card); color: var(--text); padding: 6px 10px; cursor: pointer; }

.context-menu {
  position: fixed;
  z-index: 500;
  min-width: 184px;
  padding: 6px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg-card);
  box-shadow: var(--shadow-lg);
}
.context-menu button {
  width: 100%;
  padding: 8px 10px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--text);
  text-align: left;
  cursor: pointer;
}
.context-menu button:hover { background: var(--bg-hover); }
.context-menu button.danger { color: #b43c3c; }
.tool-btn:focus-visible, .library-item:focus-visible, .context-menu button:focus-visible,
.library-error button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
```

- [ ] 6.7 增加 `@media (max-width: 720px)`：侧栏改为覆盖主内容的绝对定位层，宽度为 `min(82vw, 280px)`，保留滚动；工具栏文件名进一步缩短，防止按钮重叠。

```css
@media (max-width: 720px) {
  .side-panel {
    position: absolute;
    inset: 0 auto 0 0;
    z-index: 80;
    width: min(82vw, 280px);
    min-width: 0;
    box-shadow: var(--shadow-lg);
  }
  .file-name { max-width: 120px; }
}
```

- [ ] 6.8 运行 `npm.cmd test -- tests/markup.test.js` 和 `npm.cmd run build`，预期通过。

## Task 7：在应用状态中接入文件库与安全菜单行为

**Files:**

- Modify: `src/js/app.js`
- Modify: `src/js/file-library.js`
- Modify: `tests/file-library.test.js`
- Existing dependencies: `src/js/file-types.js`, `src/js/document-session.js`

- [ ] 7.1 在 `app.js` 导入 `applyTrashedOutcome`、`createFileLibraryView`、`nextSidePanel`、`requestTrash`、`samePath`、`welcomePaths`；将状态 `recentFiles` 改为：

```js
libraryFiles: [],
libraryError: '',
activeSidePanel: 'none',
platform: /Win/i.test(globalThis.navigator?.platform ?? '') ? 'windows' : 'posix',
```

新增所有 Task 6 DOM 引用，删除未使用的 `toolbar` 与 `main` 引用。

- [ ] 7.2 创建 `createFileLibraryView` 时传入 `state.platform` 与实际可滚动容器 `scrollElement: els.libraryPanel`，并在所有当前文件比较和确认消息中显式传入同一平台值；前端不自行重排列表，始终采用 `get/register/remove/trash` 后端返回的权威顺序。菜单的滚动关闭监听必须绑定 `.side-panel`，不能绑定内部不滚动的列表节点。

- [ ] 7.3 将 `loadRecentFiles()` 改为 `loadLibraryFiles()`，调用 `get_library_files`。成功结果先经过 Task 2 的 `validateLibraryPaths`（其内部消费 `file-types.js`）再更新侧栏与欢迎页；失败时保留当前文档，在侧栏显示错误并提供“重试”按钮；欢迎页通过 `welcomePaths(libraryFiles)` 继续显示前 8 项。

- [ ] 7.4 扩展现有 `performDocumentOpen` / `applyOpenedDocument`，不得另写一条绕过 `openDocumentWithGuards` 的读取路径：共享协调器返回 `opened` 后应用文档状态并返回 `true`，取消、保存失败、大日志确认取消或已处理读取失败返回 `false`。只有 `read_file` 成功并完成界面切换后，才调用 `register_library_file`；登记失败只 toast、不回滚文档，也不能把已经成功打开的返回值改成 false。已交付的 `saveFile()` 已遵守“成功为 `true`，另存为取消或已处理失败为 `false`”契约，保留其测试和语义。

- [ ] 7.5 `toggleLibrary()` 与 `toggleToc()` 都用已测试的 `nextSidePanel(state.activeSidePanel, requested)` 更新单一状态源，再由 `renderSidePanels()` 同步两个 panel 的 `hidden`、两个按钮的 active 状态和 `aria-expanded`；不得分别维护两个可能同时为 true 的布尔值。

- [ ] 7.6 初始化 `createFileLibraryView`：

  - `onOpen(path)` 只调用共用的、内部仍经 `openDocumentWithGuards` 的 `openFileByPath(path, { source: 'manual' })`；由 `openDocumentWithHistory` 在返回 true 后清空历史，点击回调不得提前清栈。
  - `onRemove(path)` 调用 `remove_library_file`，成功后用返回列表渲染；若当前文档被移出，只移除记录，内容与阅读进度保持。
  - `onTrash(path)` 进入下一步的二次确认流程。

- [ ] 7.7 实现系统确认封装：Tauri 环境调用 `window.__TAURI__.dialog.confirm(message, { title: '移到回收站', kind: 'warning' })`，浏览器预览降级到 `window.confirm`。只把确认封装和 `trash_library_file` invoke 注入 Task 2 已测试的 `requestTrash`；取消时不调用后端、不改任何状态。

- [ ] 7.8 后端在实际回收站调用前 reject 时，保持文件库、当前内容和进度不变并显示具体错误。获得 `TrashOutcome.trashed === true` 后，用 `applyTrashedOutcome` 单独提交 UI：采用 `outcome.files`；若是当前文件，清空导航历史/编辑脏状态并回欢迎页；再显示 `cleanupWarning`。若 UI 提交自身失败，显示“原文件已移到回收站，但界面刷新失败”，立即调用 `loadLibraryFiles()` 重同步；不得落入“回收站失败、原文件仍在”的普通错误分支。

- [ ] 7.9 对侧栏条目打开失败调用 `document_path_status`：只在明确返回 `missing` 时提示“文件已不存在”并调用 `remove_library_file`；`file`、`other`、命令错误或编码/权限错误都保留记录。

- [ ] 7.10 `showToast` 创建的元素按严重性设置 `role="alert"` 或 `role="status"` 及 `aria-live`，避免只有视觉反馈；文件库错误重试按钮使用实际 `loadLibraryFiles` 回调。

- [ ] 7.11 运行 `npm.cmd test` 和 `npm.cmd run build`，预期通过。

## Task 8：统一阅读区/预览区链接路由并加入返回行为

**Files:**

- Modify: `src/js/app.js`
- Modify: `src/js/navigation.js`
- Modify: `tests/navigation.test.js`
- Existing dependencies: `src/js/document-session.js`, `tests/document-session.test.js`

- [ ] 8.1 先在 `tests/navigation.test.js` 的 import 中加入 `openDocumentWithHistory` 和 `selectInitialScrollTarget`，并写历史提交协调测试。`guardDirtyDocumentSwitch` 已由 `tests/document-session.test.js` 覆盖，导航测试不从 `navigation.js` 导入或复制它：

```js
test('document navigation commits history only after target opens', async () => {
  const history = new NavigationHistory({ platform: 'windows' });
  const snapshot = { path: 'C:\\source.md', scrollTop: 320 };
  await assert.rejects(() => openDocumentWithHistory({
    path: 'C:\\missing.md', source: 'link', snapshot, history,
    open: async () => { throw new Error('missing'); },
  }));
  assert.equal(history.size, 0);

  assert.equal(await openDocumentWithHistory({
    path: 'C:\\missing.md', source: 'link', snapshot, history,
    open: async () => false,
  }), false);
  assert.equal(history.size, 0);

  await openDocumentWithHistory({
    path: 'C:\\target.md', source: 'link', snapshot, history,
    open: async () => true,
  });
  assert.deepEqual(history.peek(), snapshot);

  await openDocumentWithHistory({
    path: 'C:\\manual.md', source: 'manual', snapshot: null, history,
    open: async () => true,
  });
  assert.equal(history.size, 0);
});

test('fragment wins over history scroll, which wins over saved progress', () => {
  assert.deepEqual(selectInitialScrollTarget({ fragment: '目标', restoreScroll: 80, savedProgress: 0.4 }), { kind: 'fragment', value: '目标' });
  assert.deepEqual(selectInitialScrollTarget({ fragment: '', restoreScroll: 80, savedProgress: 0.4 }), { kind: 'scroll_top', value: 80 });
  assert.deepEqual(selectInitialScrollTarget({ fragment: '', restoreScroll: null, savedProgress: 0.4 }), { kind: 'progress', value: 0.4 });
});
```

- [ ] 8.2 运行 `npm.cmd test -- tests/navigation.test.js`，确认两个新导出缺失而失败；随后实现并重跑：

```js
export async function openDocumentWithHistory({ path, source, snapshot, history, open }) {
  const opened = await open(path);
  if (opened !== true) return false;
  if (source === 'link' && snapshot) history.push(snapshot);
  if (source === 'manual') history.clear();
  return true;
}

export function selectInitialScrollTarget({ fragment, restoreScroll, savedProgress }) {
  if (fragment) return { kind: 'fragment', value: fragment };
  if (Number.isFinite(restoreScroll)) return { kind: 'scroll_top', value: restoreScroll };
  return { kind: 'progress', value: Number.isFinite(savedProgress) ? savedProgress : 0 };
}
```

预期协调测试通过。`open(path)` 必须注入现有受守卫的文档打开协调器，其唯一成功值是 `true`；未保存取消、保存失败、大日志确认取消、打开返回 `false` 或 reject 都发生在历史提交前。`navigation.js` 只根据最终成功值更新历史，不负责再次询问用户。

- [ ] 8.3 在 `app.js` 创建 `new NavigationHistory({ platform: state.platform })`，并把打开来源固定为三类：`manual`、`link`、`history`。保留前置基础已经实现的 `promptDialog` / `requestDirtySwitchDecision` / `openDocumentWithGuards`，Esc、关闭或未知结果继续归为 `cancel`。所有来源都调用 `openDocumentWithHistory`，其 `open` 回调必须进入同一个现有文档打开协调器（包含大日志确认和 `guardDirtyDocumentSwitch`）且只执行一次守卫；不得在导航层重新实现 `beforeDocumentSwitch`、直接调用 `read_file` 或造成双重提示。

调用链接打开前执行 `const { scrollRoot } = getReaderContext()`，捕获 `Object.freeze({ path: state.filePath, scrollTop: scrollRoot.scrollTop })`，再执行目标读取/应用；现有协调器返回取消或失败时不修改文档或历史。选择保存且是未命名文档时，用户取消另存为仍等同取消本次切换；从脏的可编辑文档切换到只读 `.log` 也走同一守卫。

- [ ] 8.4 把阅读区现有“仅处理复制代码”的 click 委托抽为 `handleMarkdownClick(event)`，同时绑定到 `markdown-body` 与 `preview-body`。先处理 `.code-copy`；其他点击交给 Task 1 已测试的 `createMarkdownLinkHandler`，`findAnchor` 使用 `event.target instanceof Element ? event.target.closest('a[href]') : null`。委托必须读取 `getAttribute('href')`，并在任何解码、路径解析或异步调用前同步 `preventDefault()`。

- [ ] 8.5 外部链接回调：仅 `external` 分类调用 `window.__TAURI__.opener.openUrl(href)`；非 Tauri 预览调用 `window.open(href, '_blank', 'noopener,noreferrer')` 并把返回窗口的 opener 置空。失败只 toast，不改变 WebView URL、当前文件、滚动或编辑状态。

- [ ] 8.6 未知协议回调：`blocked` 分类直接提示“已阻止不支持的链接协议：…”，不得调用 opener 或 `window.location`。DOMPurify 若在渲染阶段已移除危险 href，同样视为安全阻止；可点击提示路径由纯路由测试和 Task 13 注入测试覆盖。

- [ ] 8.7 锚点回调：在触发链接所属的 `.markdown-body` 内按安全解码后的 `id` 查找目标，找到后在相应阅读容器内滚动；找不到则 toast。畸形百分号编码不得抛出未处理异常，不得改变 URL 或导航栈。

- [ ] 8.8 本地文档回调：用 `resolveDocumentLink(href, state.filePath)` 得到 `target`；该解析器已通过 `file-types.js` 接受共享策略当前五种格式而非硬编码后缀。捕获来源快照后调用 `openFileByPath(target.path, { source: 'link', fragment: target.fragment, snapshot })`。解析失败、未保存守卫取消、保存失败、大日志确认取消、存在检查失败或读取失败均保留来源文档，且不压栈。

- [ ] 8.9 `updateBackButton()` 以 `history.canGoBack` 控制 `btn-back`。点击返回时先保存 `const entry = history.pop()`，再以 `{ source: 'history', restoreScroll: entry.scrollTop }` 打开；未保存守卫取消或保存失败时，把原始 `entry` 原样压回栈顶且不读取目标；若 `document_path_status` 明确为 `missing`，丢弃该条并继续更早记录；其他失败同样把原始 `entry` 压回并停止，防止丢历史。

- [ ] 8.10 打开对话框、文件库点击、拖拽、CLI/文件关联事件都走 `source: 'manual'` 并使用同一个未保存守卫；返回与链接打开不清栈。只有守卫放行且手动目标成功打开后才清栈。每次清栈/压栈/弹栈后更新返回按钮。

- [ ] 8.11 修正阅读容器一致性：`saveProgress`、`loadProgress`、`updateReadingProgress`、历史 `scrollTop` 和锚点滚动均通过 `getReaderContext()` 选择阅读区或编辑预览区；给 `readerView` 与 `editorPreview` 都绑定 scroll 监听。删除 `saveProgress` 中始终指向 `readerView` 的冗余 `container` 变量。

- [ ] 8.12 把打开后的滚动恢复集中到一个 `await restoreInitialPosition({ fragment, restoreScroll })`：先读取 `progress.scroll_pct` 数值但不立即安排独立 RAF，再以 `{ fragment, restoreScroll, savedProgress: progress.scroll_pct }` 调用 `selectInitialScrollTarget`，只安排一次渲染后滚动。片段存在时不应用历史位置或保存进度；返回位置存在时不让保存进度覆盖；进度读取错误只 toast 并回到顶部，不回滚已打开文档。

- [ ] 8.13 运行 `npm.cmd test` 和 `npm.cmd run build`，预期通过。

## Task 9：生成真实透明圆角图标并刷新派生图标

**Files:**

- Modify: `src-tauri/icons/app-icon-source.png`
- Modify: generated files under `src-tauri/icons/`
- Delete: `assets/app-icon.png`

- [x] 9.1 读取 `imagegen` skill，并用 `view_image` 重新检查 `src-tauri/icons/app-icon-source.png`；已于 2026-07-28 确认尺寸为 1024×1024 RGBA、四角 alpha 均为 255，源图 SHA-256 为 `472ee5fbc09af7bd54ae7ece269801e0aee858808d74553652d3b6a2e6c6b9ec`。

- [ ] 9.2 从规范源图创建临时候选，只应用半径为画布宽度 20% 的确定性抗锯齿 alpha 蒙版；逐字节复制所有 RGB，不新增边框、背景或发光，不重绘图案。候选放在临时路径，先不覆盖源图。

- [ ] 9.3 用 `view_image` 比较临时输出与原图；再用 `System.Drawing.Bitmap.GetPixel` 或等价逐像素工具验证：四个角 alpha 为 0，全部 RGB 与原图完全一致，圆角蒙版 alpha=255 的内部 RGBA 完全一致，尺寸仍为 1024×1024；只允许抗锯齿边界和蒙版外 alpha 发生变化。任一条件失败则停止，不覆盖项目图标。

- [ ] 9.4 候选逐像素验证通过后，先把整套 Tauri 派生图生成到临时输出目录，不修改正式图标：

```powershell
npm.cmd exec tauri icon -- <candidate.png> --output <temporary-output-directory>
```

检查临时 PNG 的尺寸和四角 alpha，确认 ICO/ICNS 成功生成，并用 `view_image` 检查主要小尺寸没有白色方角或明显锯齿。任一检查失败时删除临时输出并停止，正式目录保持不变。

- [ ] 9.5 两层验证都通过后才替换 `src-tauri/icons/app-icon-source.png`，运行 `npm.cmd exec tauri icon -- src-tauri/icons/app-icon-source.png` 刷新正式派生图；成功后删除与规范源图重复的 `assets/app-icon.png`。若 `assets` 无其他文件，目录自然消失，不删除任何 `src-tauri/icons` 派生文件。

- [ ] 9.6 用 `view_image` 检查源图和 `src-tauri/icons/128x128.png`；用 alpha 检查确认两者四角均为 0，并确认小尺寸没有白色方角或明显锯齿。

## Task 10：删除已经证实无用的代码、依赖与文件

**Files:**

- Delete: `src/css/scrollbar.css`
- Modify: `src/css/reader.css`
- Modify: `src/js/app.js`
- Modify: `src-tauri/src/main.rs`
- Review only for the delivered no-fs invariant: `src-tauri/Cargo.toml`, `src-tauri/capabilities/default.json`

- [ ] 10.1 运行下列引用审计，保存输出到任务记录而不创建仓库文件：

```powershell
rg -n "scrollbar\.css|recent-dropdown|recent-dropdown-title|AppState|tauri_plugin_fs|\btoolbar\b|\bmain\b|scroll_top" . --glob '!node_modules/**' --glob '!src-tauri/target/**'
```

确认结果与当前证据一致：`scrollbar.css` 没有导入；dropdown 选择器只有 CSS 定义；`AppState` 无实例；`tauri_plugin_fs` 与 `fs:*` 已因前置基础清理而无命中；`els.toolbar` 无读取；`els.main` 当前用于维护 `aria-busy`，必须保留；`scroll_top` 只在旧进度结构与固定 0 构造中。

- [ ] 10.2 删除 `src/css/scrollbar.css`；删除 `reader.css` 中 `.recent-dropdown`、`@keyframes dropIn`、`.recent-dropdown-title` 整块，但保留欢迎页仍使用的 `.recent-item*` 样式。

- [ ] 10.3 确认 Task 5/7 已删除 `AppState`、`scroll_top`、`els.toolbar` 和冗余 `container`，并保留当前用于 `aria-busy` 的 `els.main`；另行确认前置基础已经删除的 fs 依赖/注册/权限仍未被本计划重新引入。没有明确引用证据的其他代码与文件保持不动。

- [ ] 10.4 重跑同一 `rg`，预期只出现真实仍使用的 HTML `main` 元素、toolbar 样式等语义引用，不再出现已删除符号/选择器/插件。

- [ ] 10.5 运行 `npm.cmd test`（包含无 fs capability 契约）、`npm.cmd run build`、`cargo test --manifest-path src-tauri/Cargo.toml`，预期全部通过。

## Task 11：同步 README 与变更记录

**Files:**

- Modify: `README.md`
- Modify: `CHANGELOG.md`

- [ ] 11.1 只在 Tasks 1–8 已实施并验证后，向 README 当前的 LOG/TeX 基础说明追加：文件库在阅读时可展开、与文章目录互斥；右键可只移出记录或经确认移到系统回收站；网页链接由默认浏览器打开；策略支持的本地文档链接可返回。实施前不得把这些未来功能写成现状。

- [ ] 11.2 在实际文件创建/删除完成后更新 README 项目树：加入 `src/js/file-library.js`、`src/js/navigation.js`、`src-tauri/src/library.rs`、`src-tauri/src/storage.rs` 与新增测试；移除届时已删除的 `src/css/scrollbar.css`。当前 README 已删除从未存在的 `build-portable.sh` / `build-portable.bat`，并记录共享策略、会话模块、后端类型模块、测试目录和唯一图标源，不得回退这些基础说明。

- [ ] 11.3（历史步骤）在当时的 `Unreleased` 中按 Added/Fixed/Changed/Removed 追加实际完成且已验证的用户可见行为与清理；功能任务本身不负责版本发布。当前源码已由后续封板工作同步为 v1.2.0 候选，仍不得提前记录未实现项或创建标签。

- [ ] 11.4 运行 `rg -n "build-portable|scrollbar\.css|assets/app-icon|recent.json|最近 8" README.md CHANGELOG.md`，逐项确认没有与最终实现冲突的过时描述；Task 10 完成后 README 中当前真实存在的 `scrollbar.css` 条目必须移除。“欢迎页前 8 项”可以保留，但应明确它来自无上限文件库。另搜索文件库/链接返回/回收站措辞，确保只有已验证完成的行为使用现在时。

## Task 12：浏览器模式交互与响应式验证

**Files:**

- No production-file changes unless verification reveals a reproducible defect; any fix must return to the relevant task and add a failing regression test first.

- [ ] 12.1 读取 `browser:control-in-app-browser` 与 `build-web-apps:frontend-testing-debugging` skill。写明目标流程：启动欢迎页 → 展开空文件目录 → 验证与 TOC 互斥 → 调整窄窗口 → 确认无页面导航、错误层或控制台异常。真实文件项、上下文菜单和系统能力留给 Task 13，不伪造通过证据。

- [ ] 12.2 启动 `npm.cmd run dev`，使用内置 Browser 打开 `http://localhost:1420`；验证 URL、标题 `MD Reader`、正文非空、无框架错误层和无控制台错误。

- [ ] 12.3 检查 DOM：`btn-library`、`library-panel`、`btn-back`、`file-context-menu` 均存在；初始返回按钮隐藏。点击文件目录后 library 按钮 `aria-expanded=true`、TOC 按钮为 false 且文件侧栏可见；再打开 TOC 后两者值反转且文件侧栏关闭。

- [ ] 12.4 桌面宽度与不超过 720px 的窄宽度各截图一次；确认桌面侧栏占位、窄屏侧栏覆盖、文件名不会挤掉工具栏按钮，并在两种宽度都检查 `document.documentElement.scrollWidth <= window.innerWidth`。用键盘 Tab 聚焦文件目录与 TOC 按钮，确认 `:focus-visible` 清晰可见。

- [ ] 12.5 浏览器模式若无法提供真实 Tauri 文件库，只验证空态和 UI 契约；不得把浏览器降级行为当作系统回收站或系统 opener 已通过的证据。

## Task 13：Tauri 桌面端真实流程验证

**Files:**

- Create only temporary fixtures outside tracked source, for example under `tmp-manual-test/`; remove them from the workspace after verification without touching user files.

- [ ] 13.1 读取 `computer-use:computer-use` skill（若需要 GUI 控制），创建临时 `source.md`、`linked.md`、`paper.tex`、`build.log`、`trash-me.md`、`trash-log.log`；其中 `source.md` 含 `https://example.com`、当前文档锚点、`./linked.md#目标`、`./paper.tex`、`./build.log` 与 `javascript:` 链接。所有夹具均位于本轮临时目录。

- [ ] 13.2 运行 `npm.cmd run tauri -- dev`。依次打开 `source.md`、`paper.tex` 与小型 `build.log`，确认三者均登记在文件库且当前项高亮；确认 TeX 仍可编辑、LOG 仍只读可搜索。重启应用后确认 `library.json` 持久化并保留这些策略支持路径。欢迎页前 8 项上限由 Task 2 的纯函数测试与 Task 7 的唯一调用路径证明。

- [ ] 13.3 在主窗口仍运行时，从仓库根目录执行 `& .\src-tauri\target\debug\md-reader.exe 'F:\su\md-reader\tmp-manual-test\linked.md'`；确认现有窗口获得焦点并打开该文件，系统中没有第二个 MD Reader 窗口/配置写入实例。随后继续以下菜单验证。

- [ ] 13.4 验证菜单可用性：在靠近窗口右下边界的文件项打开右键菜单，确认菜单不溢出；分别用菜单键与 `Shift+F10` 打开，确认首项获得焦点；验证 ArrowUp/ArrowDown/Home/End；用 `Esc` 关闭并确认焦点回到触发文件项。再次打开菜单并滚动文件侧栏，确认菜单关闭且焦点不会跳回触发项。再执行“移出文件目录”，确认原临时文件仍在磁盘、当前内容仍打开、阅读进度未被清理；重新成功打开后它再次置顶登记。

- [ ] 13.5 验证“移到回收站”：对 `trash-me.md` 先取消，确认文件/记录/页面均不变；再确认，确认临时文件离开原路径、记录与进度被清理、当前文档回欢迎页，并在系统回收站中可见。再对临时 `trash-log.log` 完成同一成功流程，证明回收站边界消费共享策略而非旧三后缀清单。只处理这两个临时夹具。

- [ ] 13.6 验证安全失败：尝试通过命令测试或开发控制台传入未登记文件、目录、共享策略不支持的扩展名与缺失路径，确认后端拒绝且其他文件未变化。

- [ ] 13.7 点击网页链接，确认系统默认浏览器打开且 MD Reader 留在原文档；点击锚点留在当前文件；依次点击本地链接打开 `linked.md`、`paper.tex`、`build.log` 并使用返回按钮回到 `source.md` 的原滚动位置，确认三类文档都经过同一策略路由。对未知协议，若 DOMPurify 已移除 href，记录“渲染期阻止”；若 href 被保留，则点击并确认路由提示阻止。两条路径都要确认 WebView URL 与当前文档未变化，分类/委托单测必须已通过。

- [ ] 13.8 在编辑模式预览区重复外链、锚点和本地文档链接三类检查，确认与阅读区一致。把当前文档改为脏状态后点击 `./build.log`：先选“取消”，确认只读目标未读取、草稿与历史不变；再选“保存并继续”，确认保存成功后才切换且 LOG 控件保持只读。回到可编辑目标并再次变脏后点击返回，选择取消，确认目标草稿与返回条目都保留；再验证“放弃修改”会明确切换。最后尝试回收站，确认提示包含未保存修改会丢失。

- [ ] 13.9 关闭应用，删除仍留在工作区的临时夹具目录；不要清空系统回收站。

## Task 14：全量验证、差异审查与交付

**Files:**

- Review every modified/deleted file listed above.

- [ ] 14.1 运行完整验证，必须使用本轮新鲜输出：

```powershell
npm.cmd test
npm.cmd run build
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo test --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
npm.cmd run tauri -- build --debug --no-bundle
git diff --check
git status --short
```

预期：所有命令退出码为 0；`git status --short` 只包含本计划授权的功能/测试/文档/图标变更以及用户原有的 `.gitignore`，没有临时夹具、图像中间产物、构建输出或无关文件。

- [ ] 14.2 逐项审查安全不变量：前端所有已路由链接都 `preventDefault`；opener 权限不含任意协议；前端仍无 `fs:*` 权限；配置代码没有用 `Path::exists()` 吞掉 I/O 错误，孤立 tmp 不会被提升为正式 JSON；回收站函数在调用 `trash::delete` 前复核登记、普通文件、非符号链接，并通过 `file_types::classify_path` 复核共享策略类型，在 prepared 日志落盘后再次比较同一文件身份；取消、校验/身份复核失败及系统回收站调用失败不改文件库与进度；系统回收站已成功但元数据清理失败时返回 `trashed=true` 和可恢复日志，而非普通失败；“移出目录”不调用回收站函数。

- [ ] 14.3 逐项审查产品不变量：文件库/TOC 互斥；阅读与编辑预览共用路由；文件库/本地链接/回收站分别复用 `file-types.js` / `file_types.rs`，不含独立后缀清单；系统关联仍仅为 `.md` / `.markdown` / `.txt`；所有文档切换只执行一次既有未保存守卫；取消或保存失败发生在目标读取与历史变更前；手动打开清导航栈；链接成功后才压栈；返回恢复滚动；当前文件仅在回收站成功后回欢迎页；欢迎页仍显示前 8 个文件。

- [ ] 14.4 运行占位符与意外调试代码扫描：

```powershell
rg -n "TODO|TBD|FIXME|console\.(log|debug)|debugger" src src-tauri tests index.html README.md CHANGELOG.md
```

对仓库原有命中逐条说明；本次新增代码不得留下占位符或调试输出。

- [ ] 14.5 复核 `git diff -- .gitignore` 仍只含用户原有修改，且任何暂存区（若存在）不包含 `.gitignore`。本计划不提交或推送；向用户交付改动摘要、测试命令与结果、真实桌面验证结果、仍未验证项（若有）和关键文件链接。

## 规格追踪矩阵

| 已确认需求 | 实施任务 | 关键验证 |
|---|---:|---|
| 阅读时展开文件侧栏，与 TOC 互斥 | 2、6、7 | 12.3、14.3 |
| 移出目录不碰原文件 | 3、7 | 13.3、14.2 |
| 二次确认后移到系统回收站 | 4、7 | 13.4、14.2 |
| 网页链接不再占用 WebView | 5、8 | 13.6、14.2 |
| 锚点与本地文档链接可返回 | 1、8 | 13.6、14.3 |
| 文件库/链接/回收站共享五格式策略，系统关联仍限三格式 | 1、2、3、4、5 | 5.7、13.2、13.5、14.3 |
| 图标透明圆角且内部不重绘 | 9 | 9.3、9.6 |
| 删除已证实无用代码和文件 | 5、10、11 | 10.4、14.1 |
| 保留用户 `.gitignore` 修改 | 全程 | 14.1、14.5 |
