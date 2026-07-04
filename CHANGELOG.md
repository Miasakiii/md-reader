# Changelog

All notable changes to MD Reader are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [1.1.0] - 2026-07-05

### Added

- 文件关联：双击 `.md` 打开（Windows 经 `get_cli_args`，macOS/iOS/Android 经 `RunEvent::Opened` + `file-opened` 事件）
- 搜索：段落内所有匹配项均高亮显示
- Sepia 护眼主题与三态主题图标（太阳 / 月亮 / 书本）
- DOMPurify HTML 消毒 + CSP 安全策略
- 欢迎页展示最近 8 个文件
- 应用图标与完整 Tauri 图标集
- GitHub Release 便携版（单 exe + zip）与 NSIS 安装包

### Fixed

- Tauri 配置：`dragDropEnabled`、移除无效的 `dialog` feature（改用 `tauri-plugin-dialog`）

## [1.0.0] - Initial release

- 轻量级 Markdown 阅读器，基于 Tauri 2
- 三种主题、目录导航、全文搜索、轻量编辑、阅读进度与窗口记忆

[1.1.0]: https://github.com/YOUR_ORG/md-reader/compare/v1.0.0...v1.1.0
