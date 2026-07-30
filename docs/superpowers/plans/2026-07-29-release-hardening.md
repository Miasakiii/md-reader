# MD Reader Unreleased 封板计划

**日期：** 2026-07-29

**目标：** 在继续文件库开发前，把当前五格式、安全读写与窗口主题成果整理成可复现、可发布、可回退的基线。

**状态：** 13/16；本地实现、验证和候选提交已完成，三项远端与发布动作待完成。

## 本轮范围

- 修复 `npm run tauri dev/build` 的前端前置命令契约。
- 让普通 CI 与标签发布使用锁文件、前端测试/构建、Rust 格式检查、测试和 Clippy。
- 保留 Windows 资产可在 macOS/Linux 部分打包失败时发布的既有策略，但验证门禁失败时禁止发布。
- 约束三处应用版本一致，并在标签发布时校验 tag 与 CHANGELOG。
- 区分 README 中的已发布版本和当前 Unreleased 源码能力，统一发布包说明。

## 已实施

- [x] `tauri.conf.json` 增加 `beforeDevCommand` 与 `beforeBuildCommand`。
- [x] 配置契约测试覆盖前置命令和 `package.json` / Cargo / Tauri 三处版本一致性。
- [x] Checks 使用 `npm ci`、前端测试/构建、Rust fmt、锁定依赖测试和 Clippy。
- [x] Build workflow 增加独立 `verify` 门禁，构建矩阵依赖该门禁。
- [x] Release 显式要求 `verify` 成功，并校验 tag 与 CHANGELOG 版本小节。
- [x] 构建矩阵改用 `npm ci`，避免 Tauri 前置命令生效后重复构建前端。
- [x] README 区分 v1.1.2 与 Unreleased；本地发布脚本从 `package.json` 读取并校验版本。
- [x] Windows 便携版说明同步五种运行时格式和三种系统文件关联边界。

## 封板验收

- [x] 当前环境完整运行 `npm test` 与 `npm run build`。
- [x] Windows Rust 工具链运行 fmt、`cargo test --locked` 与 Clippy `-D warnings`。
- [x] 校验 GitHub Actions YAML、PowerShell 脚本语法和 `git diff --check`。
- [x] 下一候选版本确定为 1.2.0，并同步 package、Cargo、Tauri 与锁文件。
- [x] 审查并提交当前未跟踪的共享策略、源码、测试、CI 和文档；排除 `.codegraph`、临时产物及用户原有的 `.gitignore` 修改。
- [ ] 推送候选提交，并在远端实际运行 Checks 与手动 Build workflow。
- [ ] 使用干净 Windows 安装环境验证打开对话框、拖放和 `.md/.markdown/.txt` 文件关联。
- [ ] 外部验收通过后，把 Unreleased 提升为带日期的 1.2.0 CHANGELOG 小节，同步 README 的发布状态和比较链接，再创建 tag。

## 明确不在本轮

- 文件库、系统回收站、透明圆角图标。
- 本地文档链接、返回历史和滚动恢复。
- 超大日志分块、虚拟滚动或 tail/follow。

## 本地验证快照

- `npm test`：Node 运行器报告 5 个测试文件通过；`npm run build`：124 个模块转换成功。
- Windows Rust 工具链：fmt、20 个单元测试、Clippy `-D warnings` 通过。
- GitHub Actions YAML、PowerShell AST、版本化 NSIS 筛选、`git diff --check` 与 Vite HTTP 冒烟通过。
- 完整 Windows Tauri debug 构建在当前 Linux/Windows 共用 `node_modules` 中缺少 Windows Rollup 可选包，未作为通过项；由干净 Windows `npm ci` 或远端 Build 补验。

完成三项剩余封板动作后，再分别启动“外链最小路由”“文件库 MVP”“安全回收站”三个独立里程碑；透明圆角图标可并行，本地文档链接、返回历史和滚动恢复继续延期。不得直接执行 2026-07-16 旧总计划中的混合任务。
