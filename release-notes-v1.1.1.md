## MD Reader v1.1.1

轻量级 Markdown 阅读器 — 主打阅读体验和快速启动。

### 下载

| 文件 | 说明 |
|------|------|
| **MD-Reader-1.1.1-setup.exe** | 推荐：NSIS 安装版（`src-tauri/target/release/bundle/nsis/*-setup.exe`） |
| **MD-Reader-1.1.1-portable.exe** | 便携版：来自 `src-tauri/target/release/md-reader.exe` |
| **MD-Reader-1.1.1-portable.zip** | 便携版压缩包（含 exe + 使用说明） |

**系统要求**：Windows 10/11（WebView2，通常已自带）

### 修复

- 目录导航：TOC 从渲染后 DOM 读取，与 markdown-it-anchor 标题 ID 一致
- 滚动高亮：阅读/编辑模式共用滚动监听，修复编辑预览与 TOC 点击定位

完整变更见 [CHANGELOG.md](./CHANGELOG.md)。
