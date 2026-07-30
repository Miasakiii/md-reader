# LOG 与 TeX 纯文本支持 Implementation Plan

**Goal:** 在不增加 TeX 编译、日志跟随或系统文件关联的前提下，让 `.tex` 作为可编辑纯文本、`.log` 作为带 10 MiB 预警的只读快照，安全地进入所有现有打开入口。

**Architecture:** `shared/document-types.json` 是 JS 与 Rust 唯一的运行时类型策略；Rust 负责预检、读取、保存和最终权限边界，纯 `document-session.js` 负责可测试的异步切换流程，`app.js` 只做适配、串行调度和一次性 UI 提交。

**Tech Stack:** Vanilla ES modules、Node.js 内置测试运行器、Vite 6、Tauri 2、Rust 2021、serde/serde_json、encoding_rs。

**状态更新（2026-07-29）：** 本功能计划完成 46/47，唯一未勾选的 Task 6.5 是独立 Windows 安装环境验收，现由 [`2026-07-29-release-hardening.md`](2026-07-29-release-hardening.md) 统一追踪。当前仓库共有 5 个 JavaScript 测试文件；现行 CI 基线为 Node.js 24、`npm ci`、前端测试/构建、Rust fmt、`cargo test --locked` 与 Clippy `-D warnings`。下方已完成步骤仍记录实施过程，不作为新的版本发布计划。

## 锁定契约

- 所有文档命令失败均返回可序列化对象 `{ code, message }`，不返回拼接字符串；Rust 响应结构统一 `#[serde(rename_all = "camelCase")]`，前端只消费 `renderMode`、`readOnly`、`sizeBytes`、`requiresLargeFileConfirmation` 等 camelCase 字段。
- 清单按严格模式解析：根对象和每个类型只允许已声明字段，版本、三个固定分组、能力值、正整数阈值、非空小写 ASCII 扩展名及全局唯一性全部校验；任一失败返回 `policy_invalid`，不得降级为任意文件访问。
- `guardDirtyDocumentSwitch`、决定回调和保存回调均为异步；未知决定、异常、保存失败和另存为取消都返回 `false`。`document-session.js` 不访问 DOM、Tauri 或全局应用状态。
- 格式显示由路径的真实扩展名映射，而不是由 `kind` 推断；至少保证同属 `text` 的 `.txt` 显示 `TXT`、`.tex` 显示 `TeX`，`.log` 显示 `LOG`。
- 保存前先校验扩展名；若目标已存在，使用不跟随链接的元数据拒绝符号链接、目录和其他特殊文件，仅允许覆盖普通文件。同目录临时文件完整写入并同步后再原子替换目标，成功内容始终为 UTF-8。
- “保留换行”指解码后的文本行与空白在阅读、编辑、再保存时语义不丢失，不承诺保留原始编码字节或平台换行字节序列；纯文本渲染必须转义 HTML 并以保留空格和换行的 CSS 展示。
- Tauri 拖放只由前端窗口事件处理，Rust 不再把同一次拖放重复转换为 `file-opened`；打开对话框、拖放、CLI、文件关联、最近文件和浏览器文件输入全部进入同一个串行打开队列。
- CI 命令必须跨平台：使用 `npm test`、`npm run build`，不得写成仅适用于 Windows 的 `npm.cmd ...`。

## Task 1：确认已完成的 JS 基础层

**Files:** `shared/document-types.json`、`src/js/file-types.js`、`src/js/document-session.js`、`tests/file-types.test.js`、`tests/document-session.test.js`、`package.json`

- [x] 1.1 新增版本化共享清单，声明 Markdown、Text、Log 三组能力及 `10485760` 字节阈值。
- [x] 1.2 在 `package.json` 增加跨平台的 `"test": "node --test"`，未引入测试框架依赖。
- [x] 1.3 新增纯 `file-types.js`，实现大小写无关分类、真实后缀提取、打开/保存过滤器和浏览器 `accept`。
- [x] 1.4 实现清单版本、分组、能力值、扩展名格式/重复及阈值的首轮校验，并以 `policy_invalid` 标记失败。
- [x] 1.5 新增纯 `document-session.js`，实现异步 dirty guard、大日志确认/阈值竞态处理、只读视图状态和 MiB 格式化。
- [x] 1.6 添加首批单测，覆盖五种扩展名、过滤器、只读日志、异步保存/放弃/取消、大日志取消与再次确认、控件恢复和隐藏缓冲区为空。
- [x] 1.7 运行 `npm test`；该检查点当时 4 个测试文件通过，当前仓库已扩展为 5 个。

## Task 2：补齐严格策略、显示标签与串行队列测试

**Files:** `src/js/file-types.js`、`src/js/document-session.js`、`tests/file-types.test.js`、`tests/document-session.test.js`

- [x] 2.1 先增加失败测试：清单含未知根字段/类型字段、缺字段、额外分组、非小写扩展名或重复扩展名时必须抛出 `code === 'policy_invalid'`。
- [x] 2.2 收紧 `validateDocumentTypePolicy` 到精确字段集合，并保证返回供运行时使用的策略不会被调用方意外修改。
- [x] 2.3 先增加真实扩展名标签测试：`.md`/`.markdown`、`.txt`、`.tex`、`.log` 分别从路径后缀取得显示标签，不能把 `.tex` 显示成通用 `Text`。
- [x] 2.4 在 `file-types.js` 实现显示标签纯函数；对无后缀或不支持类型返回明确的 unsupported 结果。
- [x] 2.5 先增加并发测试：两个几乎同时到达的打开请求不得重叠执行，前一个失败也不能使后续队列永久失效。
- [x] 2.6 在纯 `document-session.js` 实现串行打开包装器；保持每次调用的返回值/异常独立，且不读取 DOM 或应用状态。
- [x] 2.7 运行 `npm test -- tests/file-types.test.js tests/document-session.test.js`，确认新增回归测试通过。

## Task 3：建立 Rust 类型边界和结构化命令

**Files:** `src-tauri/src/file_types.rs`、`src-tauri/src/main.rs`

- [x] 3.1 先写 Rust 失败测试，覆盖嵌入清单、严格拒绝未知/缺失字段、三类文档、大小写后缀、无真实后缀及不支持格式。
- [x] 3.2 新增 `file_types.rs`：用 `include_str!` 嵌入共享清单，以 `deny_unknown_fields` 加显式业务校验严格解析，并集中提供分类、可保存性和大日志阈值。
- [x] 3.3 定义稳定的 `CommandError { code, message }` 与 camelCase 响应 DTO；让 CLI、文件关联、预检、读取和保存都复用 `file_types`，删除 `is_supported_file` 等硬编码列表。
- [x] 3.4 先写 `inspect_document` 失败测试，覆盖缺失文件、目录/特殊文件、元数据失败，以及略小于、等于、略大于 10 MiB 的确认边界。
- [x] 3.5 实现无副作用的 `inspect_document(path)`；不读内容、不写最近文件，返回 `path/kind/renderMode/readOnly/sizeBytes/requiresLargeFileConfirmation`。
- [x] 3.6 先写 `read_file` 测试，覆盖未确认大日志不读取、预检后增长、UTF-8/GB18030 `.tex` 解码、解码失败，以及只有成功解码才更新最近文件。
- [x] 3.7 将 `read_file(path, allow_large_log)` 改为重新分类、重新检查普通文件和当前大小后再读；按 `{ code, message }` 返回稳定错误，成功结果字段使用 camelCase。
- [x] 3.8 先写保存测试：`.log`/不支持类型被拒且原文件哈希和 mtime 不变；现有目录、符号链接和特殊目标被拒；普通 `.tex` 可覆盖，不存在的 `.tex` 可创建。
- [x] 3.9 实现 `save_file(path, content)`：分类后拒绝现有符号链接/非普通目标，并通过同目录临时文件完整写入、同步和原子替换避免失败时截断原文件；成功后前端可确定编码为 UTF-8。
- [x] 3.10 增加包含 LF、CRLF、空行、缩进和反斜杠的测试；按解码后的行语义比较内容，并单独断言保存字节是有效 UTF-8。
- [x] 3.11 运行 `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` 和 Rust 测试；2026-07-29 封板复验使用 `cargo test --manifest-path src-tauri/Cargo.toml --locked`。

## Task 4：把所有打开与保存入口接入统一会话

**Files:** `index.html`、`src/js/app.js`、`src/css/base.css`、`src/css/reader.css`、`tests/document-session.test.js`

- [x] 4.1 扩展前端状态为 `path/content/encoding/kind/renderMode/readOnly/sizeBytes/isDirty`，并把 Tauri 适配器改为选择路径后调用 `inspect_document` 与 `read_file`；结构化错误直接按 `code/message` 处理。
- [x] 4.2 实现可键盘访问的异步三选项 dirty 对话框（保存并继续/放弃修改/取消）；关闭、Esc、未知值、保存异常和另存为取消均终止切换，关闭后恢复合理焦点。
- [x] 4.3 为大日志实现继续/取消确认，显示文件名、一位小数 MiB 和“完整读取可能卡顿”；浏览器模式使用 `File.size` 执行同一阈值。
- [x] 4.4 让所有入口调用同一串行协调器，严格执行“预检 → 大日志确认 → dirty guard → 读取 → 一次性提交”；失败或取消不改变原内容、草稿、滚动、导航和最近文件。
- [x] 4.5 若读取阶段返回 `large_log_confirmation_required`，按纯模块约定重新预检和确认；不得当成普通读取失败，也不得重复运行 dirty guard。
- [x] 4.6 用共享分类替换 `isTxtFile`、拖放数组、对话框过滤器和渲染特例；纯文本 HTML 转义并保留空白/换行，Markdown 与 DOMPurify 流程保持不变。
- [x] 4.7 按真实扩展名更新状态栏：例如 `TeX · UTF-8`、`LOG · GB18030 · 只读`；保存成功后编码立即更新为 UTF-8。
- [x] 4.8 `.log` 成功打开时只填充阅读区，清空编辑器和隐藏预览，原生禁用编辑/保存/TOC；`Ctrl+E`、`Ctrl+S` 只显示 `role="status"` 的只读说明。切回可编辑文档时恢复控件。
- [x] 4.9 真正的预检/读写失败使用 `role="alert"`，用户取消不显示错误 toast；搜索继续只遍历当前可见阅读容器。

## Task 5：消除拖放重复路径并收紧权限

**Files:** `src/js/app.js`、`src-tauri/src/main.rs`、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock`、`src-tauri/capabilities/default.json`、`src-tauri/tauri.conf.json`、`tests/configuration.test.js`

- [x] 5.1 先增加静态配置测试：文件关联恰好保持 `md/markdown/txt`，不得出现 `tex/log`；源码和 capability 不再包含 fs 插件或全盘 `fs:scope`。
- [x] 5.2 前端只注册一套 Tauri 窗口拖放处理并把首个支持路径送入串行队列；不支持提示列出 `.md/.markdown/.txt/.tex/.log`。
- [x] 5.3 删除 Rust `WebviewEvent::DragDrop` 分支；保留 CLI 与操作系统 `RunEvent::Opened` 的 `file-opened` 事件，并让它们仅通过共享类型策略筛选。
- [x] 5.4 删除未使用的 `tauri-plugin-fs` 依赖、注册、`fs:*` 权限与 `**` scope；不增加 CSP、网络、shell 或文件系统权限。
- [x] 5.5 运行 `npm test` 与 Rust 测试，确认配置和两端策略回归通过；现行完整门禁统一使用锁定依赖测试与 Clippy。

## Task 6：CI、文档与端到端验收

**Files:** `.github/workflows/checks.yml`、`README.md`、`CHANGELOG.md`、`docs/superpowers/specs/2026-07-16-file-library-navigation-cleanup-design.md`、`docs/superpowers/plans/2026-07-16-file-library-navigation-cleanup.md`

- [x] 6.1 新增独立 checks workflow；当前版本使用 Node.js 24 与 `npm ci`，依次执行 `npm test`、`npm run build`、`cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`、`cargo test --manifest-path src-tauri/Cargo.toml --locked` 和 Clippy `-D warnings`；YAML 中不使用 `npm.cmd`。
- [x] 6.2 更新 README 与 CHANGELOG 的支持格式、只读日志、大文件预警、UTF-8 保存、测试入口和权限收紧；本功能实施时不负责版本发布，也不暗示 TeX 编译、日志跟随或文件库已经完成。后续封板工作另行同步了 v1.2.0 候选版本。
- [x] 6.3 更新 7 月 16 日规格和计划：允许格式改为消费共享策略，把本计划已完成的分类、dirty guard 和 fs 清理列为前置依赖；文件库、导航栈和回收站任务仍保持未完成。
- [x] 6.4 运行最终自动验证：`npm test`、`npm run build`、Rust fmt check、Rust 全量测试与 Clippy。
- [ ] 6.5 桌面验证打开对话框、拖放、CLI、文件关联和最近文件；确认同一次拖放只打开一次，快速连续请求严格串行，失败请求不覆盖当前文档。已通过 Tauri 拖放事件、CLI、最近文件、串行队列和失败隔离；独立安装环境的系统文件选择器与文件关联仍待验证，验收所有权已转移到 v1.2.0 封板计划。
- [x] 6.6 用略小于/等于/大于 10 MiB 的临时 `.log` 验证取消与继续；验证日志只读前后哈希/mtime 不变，并确认切回 `.tex` 后编辑、保存和快捷键恢复。
- [x] 6.7 用含 UTF-8/GB18030、LF/CRLF、空行、缩进和反斜杠的临时 `.tex` 验证显示与搜索的行语义，编辑保存后确认文件为 UTF-8。
- [x] 6.8 检查安装配置仍只关联 `.md/.markdown/.txt`；验证结束后仅清理本轮创建的临时夹具，不触碰用户文件。
