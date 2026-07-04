# MD Reader 发布指南

本文说明如何构建 Windows 发布资产并上传到 GitHub Release。

## 版本号

发布前确认以下文件版本一致为 `1.1.0`（或目标版本）：

- `package.json` → `version`
- `src-tauri/tauri.conf.json` → `version`
- `src-tauri/Cargo.toml` → `version`

## 本地构建（Windows）

```powershell
# 1. 构建前端
npm run build

# 2. 构建 Tauri（仅 NSIS，跳过 MSI 若 WiX 失败）
$env:CARGO_TARGET_DIR = "F:\su\md-reader\src-tauri\target"
npm run tauri build -- --bundles nsis
```

或使用一键脚本：

```powershell
.\scripts\build-release.ps1
```

脚本会在 `release/v1.1.0/` 生成：

| 文件 | 说明 |
|------|------|
| `MD-Reader-1.1.0-portable.exe` | 便携版，免安装单文件 |
| `MD-Reader-1.1.0-portable.zip` | 便携版压缩包（含 exe + 使用说明） |
| `MD-Reader-1.1.0-setup.exe` | NSIS 桌面安装程序 |

> `release/` 目录已在 `.gitignore` 中，二进制不会提交到 Git。

## 构建产物来源

| 发布文件 | 复制自 |
|----------|--------|
| 便携 exe | `src-tauri/target/release/md-reader.exe` |
| NSIS 安装包 | `src-tauri/target/release/bundle/nsis/*-setup.exe` |

## Git 发布流程

```powershell
# 更新 CHANGELOG.md、README、版本号后
git add CHANGELOG.md RELEASE.md README.md package.json src-tauri/
git commit -m "chore: release v1.1.0"
git tag -a v1.1.0 -m "MD Reader v1.1.0"

# 推送（由维护者手动执行）
git push origin main
git push origin v1.1.0
```

## 创建 GitHub Release

1. 打开仓库 **Releases** → **Draft a new release**
2. **Choose a tag**: `v1.1.0`（若本地已打 tag 并 push，选择现有 tag）
3. **Release title**: `MD Reader v1.1.0`
4. 粘贴 [下方 Release Notes 模板](#release-notes-模板) 到描述框
5. **Attach binaries**（拖拽上传 `release/v1.1.0/` 下三个文件）：
   - `MD-Reader-1.1.0-portable.exe`
   - `MD-Reader-1.1.0-portable.zip`
   - `MD-Reader-1.1.0-setup.exe`
6. 点击 **Publish release**

### 使用 gh CLI

```powershell
gh release create v1.1.0 `
  --title "MD Reader v1.1.0" `
  --notes-file release-notes-v1.1.0.md `
  release/v1.1.0/MD-Reader-1.1.0-portable.exe `
  release/v1.1.0/MD-Reader-1.1.0-portable.zip `
  release/v1.1.0/MD-Reader-1.1.0-setup.exe
```

## Release Notes 模板

```markdown
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
```

## CI 自动构建

推送 `v*` tag 时，`.github/workflows/build.yml` 会触发多平台构建。Windows job 会额外上传便携 exe 与 zip 到 Release（draft）。

本地构建的 `release/v1.1.0/` 与 CI 产物命名一致，可互为备份。
