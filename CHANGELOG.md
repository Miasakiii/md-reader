# Changelog

本文件记录 MD Reader 的重要变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [Unreleased]

## [1.3.3] - 2026-10-08

### Added

- 编辑预览随输入实时更新：渲染由 150ms 防抖改为 `requestAnimationFrame` 合帧（同一帧内的多次输入合并为一次渲染），去掉固定延迟；新增 `renderPreviewPane()`，渲染前记录预览滚动比例、渲染后按比例还原，重写 `innerHTML` 不再把预览拉回顶部
- 编辑时预览跟随光标（Typora 式）：重渲后按标题锚点把光标所在块锚定到预览视口，块内按源码进度取比例，随打字平滑推进；无锚点文档（纯文本、无标题）不动作，手动滚动仍走既有比例同步，两条路径互不抢占
- 阅读 ↔ 编辑模式切换的滚动位置交接：新增 `src/js/scroll-anchor.js`，用同一 markdown-it 实例解析源码，`heading_open` token 自带行号，与渲染产物中带 `id` 的标题按出现顺序索引配对（setext、引用内、列表内标题天然一致；frontmatter 必须与渲染管线同源剥离，否则 `---` 围栏会被解析成 setext 伪标题造成两侧错位）。进入编辑时编辑器与预览落到阅读时所在标题块、光标随迁到该标题行首；退出编辑时按光标所在标题块滚回对应位置；前言区按块内比例落位；无锚点走比例降级，纯文本行为不变
- 退出应用前提醒未保存修改：新增 `src/js/close-guard.js`，经 Tauri `onCloseRequested` 拦截后再决策，提供「取消 / 放弃修改 / 保存并退出」，文案与切换文档的对话框区分；浏览器预览降级为 `beforeunload` 兜底（框由浏览器绘制、文案不可控）
- 编辑与搜索按钮补齐激活态与 `aria-pressed`（此前只有侧栏与铺满按钮有）

### Changed

- 文档级状态归口 `DocumentSession`（多标签页前置的 3a 步，**用户可见行为不变**）：16 个文档级字段（`filePath`/`rawContent`/`persistedContent`/`documentGeneration`/`editRevision`/`isEditMode`/`allowedAssets`/`scrollSaveTimer` 等）收进 `src/js/document-session-state.js` 的可实例化对象，模块级 `state` 保留为只读镜像并由 `syncDocumentStateFromSession()` 单向同步；刻意不提供通用 `update()`，改以专用 `setEncoding()` 写入，确保代次只在换/关文档时推进，避免编码落定误伤在途的保存、滚动与监听回调
- `performSaveFile` 的编辑中保存分支改用 `renderPreviewPane`，与常规渲染共用滚动保持（此前绕过该路径导致预览跳顶）

### Fixed

- **窗控失效（点 X 永久无反应）**：注册 `onCloseRequested` 后 Rust 把关闭权交给 JS 包装器的 `destroy()`，而 `capabilities/default.json` 缺 `core:window:allow-destroy`，该调用被 ACL 静默拒绝，关闭按钮与 Alt+F4 一并失效（v1.3.2 没有 close-guard，故不受影响）
- 关闭放行分支擅自 `destroy()`：`handleRequest()` 在「无需询问」分支也调用了 `performClose()`（对应 `destroy()`），绕过原生窗口管理强杀窗口。现改为只 `return { action: 'allow' }`，仅在用户明确选择「放弃修改 / 保存并退出」后才真正关闭
- 关闭链路防呆：handler 包 `try/catch`，异常时 `preventDefault` 保住窗口（把「Rust 已 `prevent_close` 而 `destroy` 永不执行」的永久关不掉降级为可诊断）；`performClose` 已自行 destroy 时拦下包装器的第二次 destroy，避免同一窗口被关闭两次
- 编辑预览不刷新：`onEditorChanged` 只递增扁平 `state.editRevision`，而 `isEditorSnapshotCurrent` 比对的是会话内修订号，守卫永远判定快照过期、重渲染直接 `return`。改为经 `documentSession.markEdited()` 归口
- 编辑中打字后预览冻结、`Ctrl+E` 退出失效：`toggleEditMode` 直接翻转 `state.isEditMode`，下一次 `syncDocumentStateFromSession()` 会用会话旧值刷回，预览渲染守卫读到 `false` 早退（退出也被误判为再次进入）。改为 `documentSession.setEditMode(entering)` 归口；会话侧以 `setEditMode` 替换语义过时的 `toggleEditMode`（退出保留草稿）
- 进入编辑时预览未落在标题处（实测偏 14.6px）：交接程序化设置 `textarea.scrollTop` 触发的异步 scroll 事件用滚动百分比覆盖了刚设置的锚点定位。交接期间置抑制标志（双 rAF 清除）
- `.txt` 与代码块的中文观感呈衬线：`--font-mono` 栈（JetBrains Mono / Fira Code / Cascadia / Consolas）均不含 CJK 字形，中文一路回退到浏览器默认字体。补 `Microsoft YaHei` 后 CJK 走雅黑、西文仍走既有 mono 链

### Security

- `capabilities/default.json` 新增 `core:window:allow-destroy`——这是 `onCloseRequested` 语义下的必需权限（Rust 对「有 JS 监听器」的窗口 `prevent_close`，最终关闭由包装器 `destroy()` 完成）。新增契约测试同时锁定两条：该权限必须存在，且不得放宽 `close`/`hide`/`show`/`minimize`/`maximize`/`unminimize`/`unmaximize`/`set-fullscreen` 中任何一项

## [1.3.2] - 2026-10-07

### Added

- 外部修改监听：当前文档在应用之外被改动时，右下角弹出常驻提示并提供「重载 / 忽略」。**不自动重载、不自动合并**——有未保存草稿时走既有切换保护（保存/放弃/取消），不静默覆盖。关闭弹窗后状态栏保留常驻小提示与重载入口，直到重载或换文档
- 新增 `src/js/external-change.js` 与 `src-tauri/src/watcher.rs`：监听**父目录**而非文件本身（抗「写临时文件再 rename」的原子保存），500ms 防抖合并事件，同目录引用计数去重，保存后 1200ms 自保存抑制窗口（前后端各一份）

### Fixed

- 外部修改事件订阅落在 `initNativeTauriDragDrop()` 的 fallback 分支中，而原生分支成功即提前返回，导致订阅从未注册、提示永不出现
- 外部修改提示的重载后失效：曾用 `documentGeneration` 识别「旧文档的迟到通知」，但重载同一文件同样会递增代次，使第一次提示之后的改动全被丢弃。现只按路径判定——同一文档的迟到通知与实时事件语义等价，切换文档由路径不匹配拦截

## [1.3.1] - 2026-10-06

### Added

- GFM 任务列表：`- [ ]` / `- [x]` 渲染为 checkbox，且强制不可交互（`enabled: false`）——阅读器里的勾选动作不写回文档
- frontmatter 折叠展示：文档开头的 `---…---` 元数据块渲染为折叠式属性表，不再按水平线或标题渲染；仅支持简单 `key: value` 与列表，未闭合或无法解析时回退为原文渲染
- 铺满模式：`Ctrl+Shift+F` 或工具栏按钮在正文限宽居中与铺满窗口宽度之间切换，偏好随主题、字号一并持久化
- 文档内相对路径图片正常显示（`![](images/a.png)`）：资产协议启用，白名单按文档所在目录逐文件运行时放行
- 新增 `src/js/preferences.js`：主题、字号与铺满模式收敛到 `md-reader-preferences` 单一命名空间（版本号 + 类型校验 + 读取失败回退默认值），替代此前散落的 `md-reader-theme` / `md-reader-font-size` 两个键

### Changed

- 渲染管线从 `app.js` 抽出为 `src/js/markdown-render.js`：Markdown 引擎、frontmatter 剥离与消毒后处理集中在一个纯模块中。消毒器改为注入式，便于在没有 DOM window 的 Node 测试环境覆盖渲染契约

### Security

- 本地图片白名单的安全边界全部在后端（`src-tauri/src/assets.rs`）：静态 `assetProtocol.scope` 留空不写任何通配，白名单只由 `authorize_document_assets_command` 运行时逐文件放行；相对路径按**文档所在目录**解析（而非允许根，否则 `docs/guide.md` 引用 `../assets/x.png` 这类常见写法会失效），`canonicalize` 后必须落在「文档目录或上溯命中 `.git` 的仓库根」之内；文档位于主目录之内时另加**用户主目录天花板**，否则家目录里的一个 `.git` 就能把整个家目录变成资源根。`http(s):`、`data:`、`file:` 与绝对路径一律不改写，目标必须是普通文件。原始相对路径保留在 `data-asset-src`
- 生产 CSP 收紧：移除 `'unsafe-inline'`、`'unsafe-eval'` 与开发服务器来源 `http://localhost:1420`。实测生产产物无内联脚本、bundle 中 `eval(` 与 `new Function` 出现次数均为 0。开发期宽松值改由 Tauri 2 的 `devCsp` 承载。`style-src` 保留 `'unsafe-inline'`（实测 8 处 JS 内联样式写入）
- DOMPurify 升级至 3.4.16：修复 `IN_PLACE` 模式下 `afterSanitize` 钩子遗留分离子树事件处理器导致的 DOM XSS（GHSA-p98j-92pf-mc4p）
- markdown-it 升级至 14.3.2：修复 `linkify: true` 下两处二次复杂度路径导致几百 KB 文档可阻塞事件循环数十秒的问题（GHSA-253c-mchw-3w2r），本项目已启用 `linkify`

### Fixed

- 本地图片白名单在**文档位于主目录之外**时全部失效（Linux/macOS 受影响）：主目录天花板是无条件生效的，而 `/tmp`、外接盘、网络盘上的文档不在主目录之下，其图片会被天花板规则全部拒绝。天花板现仅在文档确实位于主目录之内时生效；文档在主目录之外时边界由「允许根 ⊆ 文档目录或上溯命中 `.git` 的仓库根」保证，而允许根本身从文档推导，不存在越界面
- 阅读进度写入改用可恢复的安全写（同目录临时文件 + 同步 + 原子替换，并保留 `.bak`）：`progress.json` 内容损坏时不再被单条记录整体覆盖而静默丢失其余文档的进度，写入中断后可从备份恢复
- 文档内的远程图片（`![](https://…)`）此前一律显示为破图：CSP 的 `img-src` 从未包含 `https:` 来源。自 v1.1.0 起该指令未变，属长期存在的既有缺陷，本次补齐。仅放开 `img-src`，`default-src` / `script-src` / `connect-src` 不受影响——远程图片加载会向图片请求方泄漏「该用户正在阅读此 IP 的文档」，这是阅读器场景的常规取舍

## [1.3.0] - 2026-08-30

### Added

- 文档内 `http`/`https` 与 `mailto` 链接交给系统默认程序打开，WebView 不再被外链导航占用；本地文档链接与未知协议保持拦截不导航，浏览器预览降级为带 `noopener` 的安全新窗口
- 持久化文件库：成功打开的受支持文档自动登记，工具栏新增“文件目录”侧栏（与文章目录互斥），支持右键“移出文件目录”、缺失文件自动清理，欢迎页继续展示最近 8 项；数据保存为 `library.json` 并从旧最近文件列表一次性迁移
- 文件目录新增“移到回收站…”：系统确认框（含未保存修改警告）后，后端独立复核“已登记 + 共享策略 + 普通非符号链接文件 + 文件身份二次确认”再交系统回收站；成功后清理文件库记录与阅读进度，当前文件被移除时回到欢迎页；增量事务日志在崩溃或收尾失败后幂等恢复，绝不调用永久删除
- 应用启用单实例：重复启动时文件参数转发给已运行窗口并聚焦；命令行相对路径按启动目录解析

### Changed

- 最近文件存储由旧 `recent.json`（20 条上限）切换为 `library.json`（不设上限）；读取文档不再写回 `recent.json`，旧文件保留用于版本回退
- 应用图标四角真实透明：确定性 alpha 蒙版（圆角半径为画布宽度 20%），图案、颜色与内部像素逐字节不变；Windows/macOS/Linux/Android/iOS 全部派生图标重新生成

### Removed

- 未被引用的 `src/css/scrollbar.css` 与 recent dropdown 遗留样式
- 阅读进度 JSON 不再写入恒为 0 的旧 `scroll_top` 字段；旧数据中的该字段继续被忽略，向后兼容

### Fixed

- Windows 最近文件与阅读进度存储改用 Tauri canonical `app_config_dir`；旧目录中的 `recent.json` / `progress.json` 按原始字节迁移，canonical 冲突时隔离为 `*.legacy.json`，并通过可注入存储路径测试避免读写回旧目录

## [1.2.0] - 2026-08-09

### Added

- `.tex` 作为可编辑纯文本打开，保留原文，不执行 TeX 渲染或编译
- `.log` 作为本地离线的一次性只读快照打开并支持全文搜索；10 MiB 是完整读取前的确认阈值，而非硬上限
- `shared/document-types.json` 作为前端与 Rust 后端共同校验的文档类型策略，统一五种运行时扩展名（`.md`、`.markdown`、`.txt`、`.tex`、`.log`）及其渲染、编辑、目录和大文件能力
- 文档切换保护：当前内容未保存时可选择“保存并继续 / 放弃修改 / 取消”，取消或保存失败不会读取目标文件
- JavaScript/Rust 策略、只读、大日志竞态、文件关联与权限契约测试，以及持续集成检查

### Changed

- 打开对话框、浏览器文件选择、拖拽、CLI 和应用内打开事件从共享策略接受五种运行时格式；保存入口只列出可编辑格式并排除 `.log`
- 系统文件关联刻意维持在 `.md`、`.markdown`、`.txt`，不接管 `.tex` 或 `.log` 的系统默认程序
- 文件读取、保存与类型判断集中到受校验的后端命令；不支持的类型、目录和符号链接失败关闭
- 浏览器预览与原生端一致采用严格 UTF-8 优先、GB18030 回退；无法识别的字节不会以替换字符静默打开
- 原生读取不跟随最终链接；保存改为同目录临时文件完整写入、同步并原子替换，写入或替换失败时保留原文件
- Node.js 开发基线提升为仍受支持的 22+，CI 使用 Node.js 24 LTS；普通检查和标签发布均使用锁文件、前端测试/构建、Rust 格式检查、测试与 Clippy
- `npm test` 只运行仓库根目录的 `tests/*.test.js`，避免其他目录中的测试被误计入当前仓库结果
- 标签发布校验 tag、应用版本与 CHANGELOG，并在验证门禁失败时停止发布
- `package.json`、Cargo 与 Tauri 清单统一为 1.2.0
- Windows 本地发布脚本从 `package.json` 读取并校验版本，构建失败立即停止，且只打包唯一、版本精确匹配的 NSIS 产物

### Fixed

- 切换浅色、深色和护眼主题时同步 Tauri 原生窗口栏；深色使用原生深色栏，浅色与护眼使用原生浅色栏
- `npm run tauri dev/build` 现在分别自动启动 Vite 和构建前端，避免漏启开发服务器或打包旧 `dist`
- macOS 文件打开事件队列改为安全借用路径，避免队列访问生命周期问题
- Windows 启动时先恢复已保存的窗口尺寸和位置，再显示主窗口，避免默认大窗口短暂闪现
- 更新 DOMPurify、PostCSS 与 nanoid 至已修复版本，关闭发布前发现的依赖安全告警

### Removed

- 未使用的 Tauri 前端文件系统插件依赖与全部 `fs:*` capability 权限

## [1.1.2] - 2026-07-06

### Added

- 纯文本 `.txt` 支持：阅读与编辑模式保留换行，等宽排版
- 编码自动识别：UTF-8 优先，失败时回退 GB18030/GBK，状态栏显示当前编码
- 文件关联与 CLI：`.txt` 双击打开（与 `.md` 一致）
- 拖拽、打开/保存对话框、欢迎页文案支持 `.txt`

### Changed

- 版本号统一为 **1.1.2**（`package.json` / `tauri.conf.json` / `Cargo.toml`）

## [1.1.1] - 2026-07-06

### Fixed

- 目录导航：TOC 从渲染后 DOM 读取标题，与 `markdown-it-anchor` 生成的 ID 一致，避免手写 slug 不同步
- 滚动高亮：阅读/编辑模式共用滚动监听，修复编辑预览区 TOC 高亮与点击定位

### Changed

- 版本号统一为 **1.1.1**（`package.json` / `tauri.conf.json` / `Cargo.toml`）

## [1.1.0] - 2026-07-05

### Added

- 应用图标与完整 Tauri 图标集
- 文件关联 / CLI 打开 `.md`（Windows `get_cli_args`，macOS/iOS/Android `file-opened`）
- 欢迎页最近 8 个文件
- 搜索：段落内全部匹配高亮
- Sepia 护眼主题与三态主题图标（太阳 / 月亮 / 书本）
- DOMPurify HTML 消毒 + CSP 安全策略
- MSI 简体中文 WiX 语言包（`src-tauri/wix/zh-CN.wxl`）
- GitHub Release 便携版（单 exe + zip）与 NSIS 安装包

### Fixed

- 原生拖拽打开：`withGlobalTauri` + `dragDropEnabled`，修复拖入 `.md` 无效
- 构建配置：移除无效 Tauri `dialog` feature，改用 `tauri-plugin-dialog`；`dragDropEnabled` 命名与 Tauri 2 一致

### Changed

- 版本号统一为 **1.1.0**（`package.json` / `tauri.conf.json` / `Cargo.toml`）

## [1.0.0] - 初始版本

- 轻量级 Markdown 阅读器（Tauri 2）
- 三种主题、目录导航、全文搜索、轻量编辑、阅读进度与窗口记忆

[Unreleased]: https://github.com/Miasakiii/md-reader/compare/v1.3.2...HEAD
[1.3.2]: https://github.com/Miasakiii/md-reader/compare/v1.3.1...v1.3.2
[1.3.1]: https://github.com/Miasakiii/md-reader/compare/v1.3.0...v1.3.1
[1.3.0]: https://github.com/Miasakiii/md-reader/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/Miasakiii/md-reader/compare/v1.1.2...v1.2.0
[1.1.2]: https://github.com/Miasakiii/md-reader/compare/v1.1.1...v1.1.2
[1.1.1]: https://github.com/Miasakiii/md-reader/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/Miasakiii/md-reader/compare/v1.0.0...v1.1.0
