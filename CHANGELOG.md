# Changelog

本文件记录 MD Reader 的重要变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [Unreleased]

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

[Unreleased]: https://github.com/Miasakiii/md-reader/compare/v1.2.0...HEAD
[1.2.0]: https://github.com/Miasakiii/md-reader/compare/v1.1.2...v1.2.0
[1.1.2]: https://github.com/Miasakiii/md-reader/compare/v1.1.1...v1.1.2
[1.1.1]: https://github.com/Miasakiii/md-reader/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/Miasakiii/md-reader/compare/v1.0.0...v1.1.0
