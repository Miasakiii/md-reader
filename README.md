# 📖 MD Reader

轻量级 Markdown 与纯文本文档阅读器 — 主打阅读体验和快速启动。

**最新发布版本：v1.3.0**

## ✨ 特性

- ⚡ **极速启动** — 基于 Tauri 2，秒开无延迟
- 🎨 **三种主题** — 浅色 / 深色 / 护眼（Sepia），工具栏图标随主题三态切换
- 📖 **优雅排版** — 衬线体正文、无衬线标题、精心调校行距字距
- 📑 **目录导航** — 自动生成 TOC，滚动高亮当前章节
- 🔍 **全文搜索** — Markdown、纯文本和只读日志均可搜索，实时高亮并逐个定位
- ✏️ **轻量编辑** — `.md` / `.markdown` 分屏预览，`.txt` / `.tex` 纯文本编辑
- 📂 **多入口打开** — 对话框、拖拽、CLI 与应用内打开事件支持 `.md` / `.markdown` / `.txt` / `.tex` / `.log`
- 💾 **阅读进度** — 自动保存/恢复每个文件的滚动位置
- 🪟 **窗口记忆** — 自动记住窗口大小和位置
- 📌 **最近文件** — 欢迎页展示最近 8 个文件，点击即可重新打开
- 📋 **系统文件关联** — 安装包仅注册 `.md` / `.markdown` / `.txt`；`.tex` / `.log` 不接管系统默认程序
- 📄 **纯文本与 TeX 源码** — `.txt` / `.tex` 按原文显示和编辑，不执行 TeX 渲染或编译；自动识别 UTF-8 / GB18030/GBK
- 🧾 **日志快照** — `.log` 一次性完整读取、只读展示并支持搜索；文件达到 10 MiB 时先确认
- 🛡️ **切换保护** — 有未保存修改时，打开另一文档前可保存、放弃或取消
- 🔒 **安全渲染** — DOMPurify 过滤 Markdown HTML 输出，CSP 限制资源加载
- 🪶 **极致轻量** — 前端 gzip 约 115KB，安装包 ~8MB
- 📦 **便携版** — Windows 单 exe 免安装

## 🚀 快速开始

### 环境要求

- [Node.js](https://nodejs.org/) >= 22（CI 使用 Node.js 24 LTS）
- [Rust](https://rustup.rs/) stable 工具链
- 系统依赖：
  - **Windows**: WebView2（Windows 10/11 通常已安装）
  - **macOS**: 系统 WebKit（自带）
  - **Linux**: `sudo apt install libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf`

### 安装 & 运行

```bash
# 按锁文件安装依赖
npm ci

# 桌面开发模式（Tauri 通过 beforeDevCommand 自动启动 Vite）
npm run tauri dev

# 构建发布版（Tauri 通过 beforeBuildCommand 自动构建前端）
npm run tauri build

# 仅构建 Windows MSI（简体中文 WiX 语言包，见 src-tauri/wix/zh-CN.wxl）
npm run tauri build -- --bundles msi
```

### 仅前端（浏览器预览）

```bash
npm run dev
# 访问 http://localhost:1420
```

### 支持格式与打开入口

运行时格式统一由 `shared/document-types.json` 定义，扩展名比较不区分大小写。

| 入口 / 操作 | 支持格式 | 说明 |
|---|---|---|
| 桌面打开对话框、拖拽 | `.md` `.markdown` `.txt` `.tex` `.log` | 成功读取后进入最近文件 |
| 浏览器预览文件选择 | `.md` `.markdown` `.txt` `.tex` `.log` | 仅本次预览，不写桌面端最近文件 |
| CLI 参数、应用内 `file-opened` 事件 | `.md` `.markdown` `.txt` `.tex` `.log` | 仍经过后端类型与普通文件校验 |
| 系统双击文件关联 | `.md` `.markdown` `.txt` | 安装包不会注册 `.tex` 或 `.log` |
| 保存 / 另存为 | `.md` `.markdown` `.txt` `.tex` | `.log` 始终只读，不出现在保存格式中 |

`.tex` 是可编辑的普通文本，不会生成排版预览；`.log` 是打开时的一次性本地离线只读快照，适合查看静态日志和轻量排障。它不提供 tail/follow、自动刷新、ANSI 解释、过滤或时间轴，也没有分块读取或虚拟滚动。10 MiB 是完整读取前的确认阈值，不是硬上限；若文件在初检后才跨过阈值，读取流程会重新检查并补做确认。

系统文件关联边界已有配置契约测试。主窗口会在已保存的尺寸和位置恢复后再显示，避免启动时先闪现默认大小窗口。

### 构建产物

位于 `src-tauri/target/release/bundle/`：

| 平台 | 安装版 | 便携版 |
|------|--------|--------|
| Windows | NSIS `*-setup.exe` / MSI（简体中文 WiX） | `target/release/md-reader.exe` 单文件 |
| macOS | `.dmg` | — |
| Linux | `.deb` | `.AppImage` |

### Windows 本地发布资产

先完成下方全部测试门禁，再在 Windows PowerShell 7 中运行：

```powershell
pwsh -File ./scripts/build-release.ps1
```

脚本从 `package.json` 读取版本，执行 NSIS 构建，并把安装程序、便携版 exe 与 zip 写入 `release/v<version>/`。可显式传入 `-Version`，但它必须与 `package.json` 完全一致。脚本本身不执行测试门禁，也不创建提交、标签或 GitHub Release。

## ⌨️ 快捷键

| 快捷键 | 功能 |
|--------|------|
| `Ctrl+O` | 打开文件 |
| `Ctrl+S` | 保存文件 |
| `Ctrl+F` | 搜索 |
| `Ctrl+\` | 目录面板 |
| `Ctrl+E` | 切换编辑/阅读模式 |
| `Ctrl+=` | 放大字号 |
| `Ctrl+-` | 缩小字号 |
| `Esc` | 关闭搜索 |
| `Enter` | 搜索下一个 |
| `Shift+Enter` | 搜索上一个 |

## 🎨 主题

| 主题 | 风格 | 适合场景 |
|------|------|---------|
| 浅色 | 温暖纸感 `#faf9f7` + 赤陶强调色 | 日间阅读 |
| 深色 | 低对比暗色 `#191919` | 夜间使用 |
| 护眼 | Sepia 色调 `#f5eed8` | 减轻视觉疲劳 |

点击工具栏主题按钮可在三种主题间循环切换，图标同步显示当前模式（太阳 / 月亮 / 书本）。

## 🔒 安全

Markdown 渲染后的 HTML 经 [DOMPurify](https://github.com/cure53/DOMPurify) 消毒后再插入 DOM；内容安全策略（CSP）在 `src-tauri/tauri.conf.json` 中限制脚本、样式与外部资源来源。

前端与 Rust 后端分别校验同一份 `shared/document-types.json`，策略损坏、未知类型、重复扩展名或不安全能力组合都会失败关闭。文件读取和保存由后端命令执行，并拒绝不支持的路径、目录和符号链接；读取时不跟随最终链接，保存使用同目录临时文件完整写入并同步后再原子替换，避免失败时截断原文件。`.log` 的只读限制也在后端独立执行。前端没有 Tauri 文件系统插件权限，系统文件关联则刻意保持在 `.md` / `.markdown` / `.txt`。

## 📁 项目结构

```
md-reader/
├── .github/
│   └── workflows/
│       ├── build.yml           # 多平台打包与发布
│       └── checks.yml          # 前端与 Rust 持续验证
├── index.html                  # 入口页面
├── package.json                # 前端依赖
├── vite.config.js              # Vite 构建配置
├── README.md
│
├── scripts/
│   └── build-release.ps1       # Windows 本地发布资产打包
│
├── shared/
│   └── document-types.json     # 前后端共享的运行时文档类型策略
│
├── src/
│   ├── css/
│   │   ├── base.css            # 主题变量 & 全局样式
│   │   ├── reader.css          # 阅读器排版 & UI 组件
│   │   ├── editor.css          # 编辑器分屏样式
│   │   └── scrollbar.css       # 独立滚动条样式
│   └── js/
│       ├── app.js              # 主逻辑与文档打开协调
│       ├── document-session.js # 未保存切换保护与大日志打开流程
│       ├── file-types.js       # 前端文档类型策略与对话框过滤器
│       ├── text-decoding.js    # 浏览器严格 UTF-8 / GB18030 解码
│       ├── window-theme.js     # 页面与原生窗口栏主题同步
│       └── highlight.js        # 按需加载语言包 (30+)
│
├── src-tauri/
│   ├── Cargo.toml              # Rust 依赖
│   ├── tauri.conf.json         # 应用配置、CSP、文件关联
│   ├── build.rs
│   ├── capabilities/
│   │   └── default.json        # 权限声明
│   ├── icons/                  # Tauri 图标集；app-icon-source.png 为规范源图，透明圆角待实施
│   └── src/
│       ├── file_types.rs       # 后端类型策略、能力与路径分类
│       ├── safe_file.rs        # 不跟随链接的读取与原子替换保存
│       └── main.rs             # Rust 后端 (文件/进度/历史/CLI)
│
├── tests/
│   ├── configuration.test.js   # 关联、权限和 CI 配置契约
│   ├── document-session.test.js # 文档切换与大日志协调测试
│   ├── file-types.test.js      # 共享策略与过滤器测试
│   ├── text-decoding.test.js   # 浏览器编码回退测试
│   └── window-theme.test.js    # 原生窗口栏主题同步测试
│
└── public/
    ├── sample.md               # 示例文档
    └── styles/                 # highlight.js 主题 CSS
```

## 🏗️ 技术栈

| 层 | 技术 | 说明 |
|----|------|------|
| 框架 | Tauri 2 | Rust 后端 + WebView 前端 |
| 构建 | Vite 6 | 快速 HMR + 生产构建 |
| 前端 | Vanilla JS | 零框架，纯原生 |
| Markdown | markdown-it | GFM 支持，插件丰富 |
| 安全 | DOMPurify | Markdown HTML 输出消毒 |
| 代码高亮 | highlight.js | 按需加载 30+ 语言 |
| 后端 | Rust | 文件读写、进度存储、窗口管理 |
| 插件 | tauri-plugin-dialog / window-state | 文件对话框、窗口状态；文件 I/O 只走自有后端命令 |



## 📦 构建产物体积

| 组件 | 原始 | Gzip |
|------|------|------|
| CSS | 16.8 KB | 4.3 KB |
| JS | 305.8 KB | 108.6 KB |
| HTML | 8.3 KB | 2.5 KB |
| **前端总计** | **330.9 KB** | **115.3 KB** |

## ✅ 测试

```bash
# JavaScript 单元测试与配置契约
npm test

# 前端生产构建
npm run build

# Rust 格式、后端单元测试与静态检查
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo test --manifest-path src-tauri/Cargo.toml --locked
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --locked -- -D warnings
```

测试覆盖共享格式策略、打开/保存过滤器、`.tex` 编辑能力、`.log` 只读与 10 MiB 确认竞态、未保存切换保护、系统文件关联边界、窗口状态恢复，以及前端无文件系统权限。`npm test` 只匹配仓库根目录的 `tests/*.test.js`；`.github/workflows/checks.yml` 使用 Node.js 24，并执行锁定依赖安装、前端测试/构建、Rust 格式检查、测试和 Clippy。

## 📝 更新记录

### v1.3.0（2026-08-30）

- 新增持久化文件库：打开过的文档自动登记，工具栏“文件目录”侧栏与文章目录互斥，支持右键移出记录、缺失文件自动清理，欢迎页展示最近 8 项；数据迁移到 `library.json` 且不再设 20 条上限
- 文件目录支持“移到回收站…”：系统确认后由后端独立复核（已登记、共享策略、普通非符号链接文件、文件身份二次确认）再交系统回收站；清理记录与阅读进度，事务日志支持崩溃后幂等恢复
- 文档内外部 `http`/`https`/`mailto` 链接交给系统默认程序打开，WebView 不再被外链导航占用；未知协议与本地文档链接保持拦截
- 应用启用单实例：重复启动把文件参数转发给已运行窗口；命令行相对路径按启动目录解析
- 应用图标四角真实透明（圆角半径为画布 20%），全平台派生图标重新生成
- Windows 最近文件与阅读进度迁移到 canonical 配置目录，旧数据按原始字节迁移
- 清理未引用样式与旧 `scroll_top` 进度字段（旧数据向后兼容）

### v1.2.0（2026-08-09）

- 新增 `.tex` 可编辑纯文本与 `.log` 本地离线只读快照/搜索支持；大型日志完整读取前确认
- 五种运行时扩展名由前后端共享策略统一分类，保存入口自动排除只读日志
- 所有现有文档打开入口共用未保存修改保护；移除未使用的前端文件系统权限
- 系统文件关联继续仅注册 `.md` / `.markdown` / `.txt`
- 浅色、深色和护眼主题会同步原生窗口栏明暗状态
- 修复 macOS 文件打开事件队列借用问题，以及 Windows 启动时默认大窗口短暂闪现
- 源码版本统一为 v1.2.0；Tauri 前置构建、Node.js 24 CI、锁定依赖测试、Clippy 和标签发布门禁已补齐

### v1.1.2

- 纯文本 `.txt` 阅读与编辑，保留换行、等宽排版
- 编码自动识别：UTF-8 优先，回退 GB18030/GBK，状态栏显示编码
- 文件关联 / 拖拽 / 对话框 / 欢迎页全面支持 `.txt`

### v1.1.1

- 目录导航：TOC 从渲染后 DOM 读取，与 markdown-it-anchor 标题 ID 一致
- 滚动高亮：阅读/编辑模式共用滚动监听，修复编辑预览与 TOC 点击定位

### v1.1.0

- 文件关联：双击 `.md` 打开（Windows 经 `get_cli_args`，macOS/iOS/Android 经 `RunEvent::Opened` + `file-opened` 事件）
- 搜索：段落内所有匹配项均高亮显示
- Sepia 护眼主题与三态主题图标
- DOMPurify HTML 消毒 + CSP 安全策略
- 欢迎页展示最近 8 个文件
- 应用图标与完整 Tauri 图标集
- 修复 Tauri 配置：`dragDropEnabled`、移除无效的 `dialog` feature（改用 `tauri-plugin-dialog`）

## 📝 License

MIT
