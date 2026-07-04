## MD Reader v1.1.0

轻量级 Markdown 阅读器 — 主打阅读体验和快速启动。

### 下载

| 文件 | 说明 |
|------|------|
| **MD-Reader-1.1.0-setup.exe** | 推荐：NSIS 安装版（`src-tauri/target/release/bundle/nsis/*-setup.exe`） |
| **MD-Reader-1.1.0-portable.exe** | 便携版：来自 `src-tauri/target/release/md-reader.exe` |
| **MD-Reader-1.1.0-portable.zip** | 便携版压缩包（含 exe + 使用说明） |

**系统要求**：Windows 10/11（WebView2，通常已自带）

### 新功能

- 应用图标与完整 Tauri 图标集
- 文件关联 / CLI 打开 `.md`；欢迎页最近 8 个文件
- 搜索段落内全部匹配高亮；Sepia 主题与三态图标
- DOMPurify + CSP；MSI 简体中文 WiX（`zh-CN.wxl`）

### 修复

- 原生拖拽：`withGlobalTauri` + `dragDropEnabled`
- 构建：`tauri-plugin-dialog`、Tauri 2 `dragDropEnabled` 配置

完整变更见 [CHANGELOG.md](./CHANGELOG.md)。