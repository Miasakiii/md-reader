# Changelog

本文件记录 MD Reader 的重要变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

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

[1.1.1]: https://github.com/Miasakiii/md-reader/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/Miasakiii/md-reader/compare/v1.0.0...v1.1.0