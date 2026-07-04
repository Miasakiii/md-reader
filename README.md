# 📖 MD Reader

轻量级 Markdown 阅读器 — 主打阅读体验和快速启动。

**当前版本：1.1.0**

## ✨ 特性

- ⚡ **极速启动** — 基于 Tauri 2，秒开无延迟
- 🎨 **三种主题** — 浅色 / 深色 / 护眼（Sepia），工具栏图标随主题三态切换
- 📖 **优雅排版** — 衬线体正文、无衬线标题、精心调校行距字距
- 📑 **目录导航** — 自动生成 TOC，滚动高亮当前章节
- 🔍 **全文搜索** — 实时高亮段落内所有匹配项，支持逐个定位
- ✏️ **轻量编辑** — 分屏实时预览
- 📂 **拖拽打开** — 直接拖入 .md 文件（`dragDropEnabled`）
- 💾 **阅读进度** — 自动保存/恢复每个文件的滚动位置
- 🪟 **窗口记忆** — 自动记住窗口大小和位置
- 📌 **最近文件** — 欢迎页展示最近 8 个文件，点击即可重新打开
- 📋 **文件关联** — 双击 .md 直接打开（Windows 经 CLI 参数，macOS/iOS/Android 经 `file-opened` 事件）
- 🔒 **安全渲染** — DOMPurify 过滤 Markdown HTML 输出，CSP 限制资源加载
- 🪶 **极致轻量** — 前端 gzip < 100KB，安装包 ~8MB
- 📦 **便携版** — Windows 单 exe 免安装

## 🚀 快速开始

### 环境要求

- [Node.js](https://nodejs.org/) >= 18
- [Rust](https://rustup.rs/) >= 1.70
- 系统依赖：
  - **Windows**: WebView2（Win10/11 自带）
  - **macOS**: 系统 WebKit（自带）
  - **Linux**: `sudo apt install libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev`

### 安装 & 运行

```bash
# 安装依赖
npm install

# 开发模式（热重载）
npm run tauri dev

# 构建发布版
npm run tauri build

# 仅构建 Windows MSI（简体中文 WiX 语言包，见 src-tauri/wix/zh-CN.wxl）
npm run build && npm run tauri build -- --bundles msi
```

### 仅前端（浏览器预览）

```bash
npm run dev
# 访问 http://localhost:1420
```

### 构建产物

位于 `src-tauri/target/release/bundle/`：

| 平台 | 安装版 | 便携版 |
|------|--------|--------|
| Windows | NSIS `*-setup.exe` / MSI（简体中文 WiX） | `target/release/md-reader.exe` 单文件 |
| macOS | `.dmg` | — |
| Linux | `.deb` | `.AppImage` |

一键打包 GitHub Release 资产（Windows）：

```powershell
.\scripts\build-release.ps1
# 输出目录：release/v1.1.0/
```



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

Markdown 渲染后的 HTML 经 [DOMPurify](https://github.com/cure53/DOMPurify) 消毒后再插入 DOM，防止 XSS。内容安全策略（CSP）在 `src-tauri/tauri.conf.json` 中配置，限制脚本、样式与外部资源来源。

## 📁 项目结构

```
md-reader/
├── index.html                  # 入口页面
├── package.json                # 前端依赖
├── vite.config.js              # Vite 构建配置
├── README.md
├── build-portable.sh           # Linux/macOS 构建脚本
├── build-portable.bat          # Windows 构建脚本
│
├── assets/
│   └── app-icon.png            # 应用图标源文件 (1024×1024)
│
├── src/
│   ├── css/
│   │   ├── base.css            # 主题变量 & 全局样式
│   │   ├── reader.css          # 阅读器排版 & UI 组件
│   │   └── editor.css          # 编辑器分屏样式
│   └── js/
│       ├── app.js              # 主逻辑
│       └── highlight.js        # 按需加载语言包 (30+)
│
├── src-tauri/
│   ├── Cargo.toml              # Rust 依赖
│   ├── tauri.conf.json         # 应用配置、CSP、文件关联
│   ├── build.rs
│   ├── capabilities/
│   │   └── default.json        # 权限声明
│   ├── icons/                  # Tauri 完整图标集
│   └── src/
│       └── main.rs             # Rust 后端 (文件/进度/历史/CLI)
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
| 插件 | tauri-plugin-dialog / fs / window-state | 文件对话框、文件系统、窗口状态 |



## 📦 构建产物体积

| 组件 | 原始 | Gzip |
|------|------|------|
| CSS | 14 KB | 3.6 KB |
| JS | 258 KB | 91 KB |
| HTML | 6.4 KB | 1.9 KB |
| **前端总计** | **278 KB** | **97 KB** |

## 📝 更新记录

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
