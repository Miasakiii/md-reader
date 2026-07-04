## MD Reader v1.1.0

轻量级 Markdown 阅读器 — 主打阅读体验和快速启动。

### 下载

| 文件 | 说明 |
|------|------|
| **MD-Reader-1.1.0-setup.exe** | 推荐：NSIS 安装版，支持开始菜单快捷方式与卸载 |
| **MD-Reader-1.1.0-portable.exe** | 便携版：单文件免安装，可直接运行 |
| **MD-Reader-1.1.0-portable.zip** | 便携版压缩包（含 exe + 使用说明） |

**系统要求**：Windows 10/11（需 WebView2 运行时，Win10/11 通常已自带）

### 新功能

- 文件关联：双击 `.md` 直接打开
- 搜索：段落内所有匹配项高亮
- Sepia 护眼主题与三态主题图标
- DOMPurify HTML 消毒 + CSP 安全策略
- 欢迎页最近 8 个文件
- 应用图标与完整图标集

### 修复

- Tauri 配置：`dragDropEnabled`、dialog 插件迁移

完整变更见 [CHANGELOG.md](./CHANGELOG.md)。
