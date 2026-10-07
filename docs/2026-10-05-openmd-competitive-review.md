# OpenMD 竞品对比与可借鉴清单

- **调研对象**：[MuLiuSaMa/OpenMD](https://github.com/MuLiuSaMa/OpenMD) v1.0.2（GPL-3.0，React 19 + Chakra UI v3 + Zustand + Vite + Tauri 2；单 commit 历史）
- **对照对象**：本项目 MD Reader v1.3.0（MIT，Vanilla JS + Vite 6 + Tauri 2）
- **调研日期**：2026-10-05
- **方法**：浅克隆上游到 `_refs/OpenMD` 后逐文件阅读 + 关键字交叉检索；本项目侧只读核对，`npm test` 基线 **60/60 通过**
- **性质**：调研阶段全程只读；报告定稿后按用户确认，单独修复了第十节 A 登记的 3 项（修复范围与验证见该节）

---

## 一、结论摘要

1. **直接竞品，取舍相反**：都是 Windows 优先的 Tauri 2 本地 Markdown 阅读器，功能覆盖面重叠约七成。OpenMD 把预算花在**沉浸阅读 + 就地编辑 + 安装/更新闭环**；MD Reader 把预算花在**格式覆盖 + 安全读写 + 工程门禁**。

2. **最值得补的三件事**：

   | 优先级 | 事项 | 为什么 | 量级 |
   |---|---|---|---|
   | 1 | **本地相对路径图片渲染**（asset 协议 + 白名单） | 唯一的功能性硬缺口：`![](img.png)` 目前显示不出来 | 中 |
   | 2 | **外部修改监听 + 冲突提示** | 高频场景（Git 切换、编辑器侧写），目前完全无感知 | 中 |
   | 3 | **多标签页** | 体验跃升最大，但必须先重构单文档状态模型 | 高（独立立项） |

   另有 **3 个低成本项**值得顺手做：GFM 任务列表 checkbox、frontmatter 折叠展示、铺满模式。

3. **不要照搬**：GPL-3.0 代码（许可传染，见第七节）；它的安装器/更新器（明文令牌入库、无签名校验、`taskkill` 强杀正在运行的应用、静默遥测）。

4. **不要退化的既有优势**：GB18030/GBK 回退解码、同目录临时文件 + 原子替换保存、`.log` 只读快照与大文件竞态封堵、回收站四重复核 + 事务日志、60 项前端 + 60 项 Rust 测试与 CI 门禁。这些 OpenMD 全部没有或明显更弱。

---

## 二、基本面对照

| 维度 | MD Reader v1.3.0 | OpenMD v1.0.2 |
|---|---|---|
| 许可 | MIT | **GPL-3.0** |
| 前端 | Vanilla JS（零框架），`app.js` 1598 行单文件 + 6 个纯逻辑模块 | React 19 + Chakra UI v3 + Zustand |
| 构建 | Vite 6，无 TypeScript | Vite 8 + TypeScript |
| Markdown | markdown-it + anchor + toc-done-right | markdown-it + anchor + task-lists |
| 高亮 / 消毒 | highlight.js（按需 30+ 语言）/ DOMPurify | highlight.js（25 语言）/ DOMPurify |
| 格式 | `.md` `.markdown` `.txt` `.tex` `.log`，两端共享能力矩阵 | `.md` `.markdown` `.mdown` `.mkd` `.mdx` `.txt` `.text`，仅扩展名白名单 |
| 编码 | UTF-8 优先 + **GB18030/GBK 回退** | 仅 UTF-8，其他直接报错要求重存 |
| 保存 | 同目录临时文件 + `sync` + 原子替换；不跟随符号链接 | `fs::write` **直接覆盖** |
| 窗口 | 原生装饰 + `window-state` 记忆 + 主题同步原生窗口栏 | 无边框自绘标题栏 + 托盘 + 关闭三选一 |
| 主题 | 浅色 / 深色 / 护眼三态 | 亮 / 暗 / 跟随系统，View Transitions 过渡 |
| 标签页 | 无 | 多标签 + 中键关闭 + Ctrl+Tab |
| 目录导航 | ✓ 从渲染后 DOM 生成 + 滚动高亮 | ✓ `IntersectionObserver` + 平滑滚动抑制 |
| 全文搜索 | ✓ md/txt/log 均可，逐项定位（字面量、大小写不敏感） | **无** |
| 编辑 | 分屏编辑（md）+ 纯文本（txt/tex） | 双视图 + 源码透明 textarea 叠加高亮 + **预览内就地编辑** |
| 文件监听 | 无 | ✓ notify 防抖 + 外部修改冲突确认 |
| 本地图片 | **无**（CSP 预留了 `asset:`，但协议未启用） | ✓ 相对路径解析 + asset 白名单 |
| 外部编辑器 | 无 | ✓ 检测已注册编辑器并"用…打开"（不经 shell） |
| 阅读进度 | ✓ 每文件 `scroll_pct` 持久化 | 每标签内存内 `scrollY`（会话级） |
| 自动更新 | 无（走 GitHub Release） | ✓ 应用内检查/下载/拉起安装器 |
| 安装形态 | NSIS + MSI（中文 WiX）+ 便携版 | 自研 Tauri 安装向导 + 卸载器 |
| 遥测 | 无 | **静默上报**（第三方域，无开关无告知） |
| 测试 / CI | Node 60/60、Rust 60/60、fmt、clippy、双 workflow 门禁 | 无 CI；仅 Rust 侧 3 个文件有单测，前端零测试 |

---

## 三、A 类：建议做（功能缺口，按优先级）

### A1. 本地相对路径图片渲染 ★最高优先级

- **OpenMD 怎么做**：渲染时把 `<img src>` / `srcset` 的相对路径解析成绝对路径并收集成清单，落地渲染**之前**先 `await` 一个 Rust 命令把文件逐个加进 asset 协议白名单；白名单校验做三件事——`canonicalize`（符号链接无法夹带）、必须落在"文档所在目录"内（向上遇到 `.git` 可放宽到仓库根，兼容 `docs/guide.md` 引用 `../assets/x.png`）、**以用户主目录为天花板**（避免 `~/.git` 让整个家目录变成资源根）。它的注释明确指出动机：没有这层约束，一旦消毒器被绕过，`![](../../../.ssh/id_rsa)` 就是全盘文件读取原语。
- **你的现状**：`src-tauri/tauri.conf.json` 只有 `csp`，**没有 `assetProtocol` 配置块**；`src-tauri/src/` 与 `src/js/` 检索 `convertFileSrc`/`asset_protocol` 均无命中；`capabilities` 也无 asset 权限。CSP 里却已经写了 `img-src 'self' asset: http://asset.localhost ...`——**通道预留了但没有来源**。结论：网络图片正常，相对路径本地图片在 `tauri://localhost` 下必然 404。**[建议先实测复现]**
- **建议做法**（贴合你现有分层）：
  1. Rust 新增单一命令，复用 `safe_file.rs` 的路径校验风格：canonicalize → 必须 `is_file()` → 必须落在允许根内（文档目录，可选放宽到仓库根）→ 主目录天花板；
  2. `tauri.conf.json` 开启 `assetProtocol`，**静态 scope 留空**，只靠运行时逐文件放行，不写通配；
  3. 前端在 DOMPurify 消毒**之后**遍历 DOM 重写 `img[src]` / `source[srcset]`，只重写相对路径，并把原始相对路径保留在 `data-` 属性上（编辑模式回写要用原值）；
  4. 在写入正文状态**之前**完成白名单写入，避免首帧 `<img>` 请求与白名单竞态（首帧失败不会自动重试）；
  5. 契约测试：`../` 越界、目录、缺失文件、`file:`/`data:` 一律拒绝或不改写。
- **量级 / 风险**：中。风险全在安全边界：把 scope 放宽成"任意路径"等于给消毒器绕过配一把全盘钥匙。

### A2. 外部修改监听与冲突提示

- **OpenMD 怎么做**：Rust 侧单个 debouncer + 500ms 防抖，**监听父目录而非文件**（抗"写临时文件再 rename"的原子保存），用引用计数管理目录监听（同目录多标签只监听一次），只对登记过的文件发事件，可测逻辑（`WatchSet`）拆出来带单测；前端再加一层 100ms 合并 + 1500ms"自保存抑制窗口"，命中标签后重读磁盘；重读**保留编辑草稿**，只把 `diskChanged` 置位，保存前弹确认覆盖。
- **你的现状**：无任何监听（依赖表无 `notify`，源码零命中）。注意 `PROJECT_STATUS.md` 里"不做文件监控"是**回收站语境**下的决策（还原后不自动恢复记录），与本项语义不同——落地前应显式更新那一页，避免两条决策打架。
- **建议**：先写决策再写代码。语义定为"当前文档被外部改动 → 状态栏提示 + 提供重载"。重载必须走 `document-session.js` 的既有守卫（`documentGeneration`/`editRevision`/串行队列），不能让外部刷新绕过未保存保护；文件被删除/改名走同一事件，可直接复用已有的 `document_path_status` 判定。
- **量级 / 风险**：中。难点是自保存抑制窗口取值（太小闪、太大漏）与"重载 vs 保留草稿"的交互。OpenMD 把抑制逻辑放在前端、Rust 不知道谁写的，这个取舍你自己定。

### A3. GFM 任务列表 checkbox（低成本，顺带补）

- **OpenMD 怎么做**：直接用 `markdown-it-task-lists`，并把 checkbox 渲染成不可交互（`enabled: false`）——阅读器里勾选不该改文档。
- **你的现状**：任务列表语法 `- [ ]` 会渲染成普通列表项文字（依赖里没有 task-lists 插件）。
- **建议**：加一个插件即可，注意两点——**渲染为 disabled**（阅读模式不该写回文件）、在编辑预览与只读日志两条渲染路径上表现一致。若顺手，脚注/KaTeX 可作为后续独立评估项（都涉及体积与安全面，不建议一次全上）。
- **量级 / 风险**：低。

### A4. 多标签页

- **OpenMD 怎么做**：每个标签持有 `content`（磁盘内容）/ `draft`（编辑缓冲）/ `lastSavedAt` / `diskChanged` / `scrollY` / `error`；"脏"是派生量（草稿存在且与磁盘内容不同）；切标签、切视图都不丢草稿；关闭脏标签走自定义确认框（保存/不保存/取消），保存失败则标签保持打开；已打开的文件再打开会**重读磁盘**；中键关闭需先 `preventDefault`（否则 WebView2 中键自动滚动会吞掉事件）。
- **你的现状**：单文档模型——模块级 `state`（`app.js:70-98`，约 30 个字段）持有唯一文档，`els` 一次性绑定 DOM；`document-session.js` 已提供 generation/revision 守卫与串行任务队列。
- **建议**：**必须单独立项做前置重构**。先把"文档状态"从模块级单例抽成可实例化的 per-document 对象（守卫原语可复用），再引入标签容器与视图切换。不要在多标签的同时改渲染/搜索/TOC：`getReaderContext()`、搜索索引、TOC 高亮、文件库侧栏当前项、阅读进度上报都要跟随活动标签，三套"当前文档"引用会互相打架。
- **量级 / 风险**：高（重构级）。收益最高，因此排在 A1/A2 之后。

### A5. frontmatter 折叠展示

- **OpenMD 怎么做**：正则识别首个 `---…---` 块并剥离；同时提供行号偏移补偿——因为剥离后所有源码行坐标都前移了，行级编辑必须加回偏移。解析只支持简单 `key: value` 与数组。
- **你的现状**：无处理，`---` 会按水平线/标题渲染。
- **建议**：先只做"渲染时折叠/展示元数据"，不要碰编辑。一旦引入，**TOC 锚点与搜索高亮的行号坐标都要跟着调**（这是 OpenMD 被迫引入偏移量的原因，值得预先记账）。解析失败一律回退为原样渲染。
- **量级 / 风险**：低-中，风险集中在坐标一致性。

### A6. 铺满模式（内容铺满窗口宽度）

- **OpenMD 怎么做**：`fullWidth` 开关，关闭时正文限宽居中（820px），开启时铺满；与其他 UI 偏好一起持久化。
- **你的现状**：无；正文有固定阅读宽度。另有 `Ctrl+=`/`Ctrl+-` 字号（13–22px，已持久化）。
- **建议**：纯 CSS + 偏好位，成本低、阅读器感知强。**注意一处硬约束**：`capabilities/default.json` 目前唯一被授予的窗口变更权限是 `core:window:allow-set-theme`，且 `configuration.test.js` 断言它是**唯一**的——若实现方式需要新增权限（铺满通常不需要），必须同步更新该契约测试，否则 CI 直接失败。
- **量级 / 风险**：低。

### A7. "用其他编辑器打开"

- **OpenMD 怎么做**：枚举系统里可以作为 Markdown 编辑器的程序（来源包括 `.md` 关联、`OpenWithList`/`OpenWithProgids`、用户已选程序，以及 `HKCR\Applications` 里按关键字过滤的项），取友好名与 exe 图标做菜单；打开时校验 exe 存在且后缀为 `.exe`、目标文件存在，然后直接 `Command::new(exe).arg(path)`——**不经 shell，无命令注入面**。它的过滤逻辑特意对候选名做了后缀数字剥离，避免 `codec_checker` 被 `code` 误命中。
- **你的现状**：无。
- **建议**：这是阅读器的口碑功能（"这文档我要改"），但属于 Windows 平台特化。若做，从最小版本开始：只枚举 `.md` 的 `OpenWithList` + 用户 `UserChoice`，**只读不写**注册表（不要像它那样在运行时改动用户关联），打开走 `Command::new` 或 `tauri-plugin-opener`，不做 shell 拼接。
- **量级 / 风险**：中。风险：注册表读取的兼容性与"不要劫持用户关联"的边界。

---

## 四、B 类：可选（取决于产品定位）

### B1. 源码视图高亮

OpenMD 用 highlight.js 高亮整份 Markdown，逐行补闭合标签后套标题 id，编辑时把**透明 textarea 叠在高亮 `<pre>` 上**（CSS grid 同格，textarea 文字透明 + 保留光标色）。代价是字体/行高/padding/折行必须两处手抄一致，否则光标与高亮错位。你的编辑模式是 textarea + 实时预览，已覆盖"改文档"；源码高亮属于体验加分项，收益中等、维护成本不低，可延后。

### B2. 应用内自动更新

OpenMD 的做法：打 Release API 比较版本 → 应用内流式下载（进度节流、可取消、`Content-Length` 完整性校验、`sync_all` 落盘）→ 拉起安装器 → 应用退出。**关键缺陷：只校验长度，没有签名或哈希校验**；且源码里硬编码了 API 令牌（见第五节）。
**建议**：要做就用 **Tauri 官方 updater 插件**（自带签名校验），不要手写"下载-落盘-执行"链路；或者维持现状的"跳转 Release 页"。你的发布链已有版本一致性门禁，不要在这个环节退化。

### B3. UI 偏好持久化归口

OpenMD 的偏好散在三处存储（受管 store 两处 + 裸 localStorage 一处，主题库自己再存一处），全部留在 WebView 存储里、**卸载不清理**——这是反面参考。
你的现状：主题与字号已在 localStorage 持久化（`md-reader-theme`、`md-reader-font-size`）；侧栏开合等状态未持久化。
**建议**：不必引入框架，但把散落的键收敛到一个 `preferences.js`（单一 schema + 版本号 + 解析失败回落默认值），并明确分工：**UI 偏好归前端，文档数据归后端 canonical 目录**。

### B4. 字数/统计口径

你**已经**有状态栏统计：`app.js:812` 输出 `${lines} 行 · ${chars} 字`（行数 + 字符数）。OpenMD 的对应实现额外给了"词数"和"标题数"，但词数按空格切分，对中文完全失真（整段算 1 个词）。
**建议**：这一项不是缺口，只需决定是否补"选区统计 / 阅读时长"。若补词数，务必用 CJK 逐字 + 西文按词的口径，不要照抄空格切分。

### B5. CSP 生产环境收紧

OpenMD 的 CSP 是 `script-src 'self'`；你的 `script-src` 含 `'unsafe-inline'` 与 `'unsafe-eval'`（其中 `http://localhost:1420` 是 dev 需要）。渲染侧靠 DOMPurify 兜底，所以 CSP 目前不是强约束。
**建议**：评估按环境拆分 CSP（dev 宽松 / 生产收紧），至少去掉生产环境的 `'unsafe-eval'`。属于既有安全债，与竞品无关。**[需实测]** 先确认是否真有内联脚本/eval 依赖。

---

## 五、C 类：技术参考，但现阶段不建议照搬

### C1. 预览内就地编辑（它最大的技术亮点，性价比仍偏低）

**它的机制值得学习**：渲染时给每个顶层块打上 `data-source-line` / `data-source-end`；编辑时用 MutationObserver 把变更归集成"行区间替换补丁"（同一块打字十次合成一次替换），新块按前后兄弟锚定行号、删块产出删除补丁；拼接草稿时**按原始坐标累计行漂移**（删整块时连带吃掉一个空行，避免留双空行）；最后用 turndown 把 DOM 块转回 Markdown，原始 HTML 块走"原样保留"通道。无法映射时**整篇回退**，是两级策略。

**不建议现在做的理由**：
1. 它引入 **HTML → Markdown 的有损往返**。真正的风险不是手感，而是"用户只改了一个字，保存后整段语法被改写"——它的 `data-raw-html` 通道就是为了压住这个问题；你还要额外兼容 GB18030 文档与 `.log` 只读等约束；
2. 实现深度依赖 `document.execCommand`（废弃 API），等于把编辑器基座押在弃用接口上；
3. 收益与多标签强耦合：想"边读边改多份文档"，要先有标签页。

**如果将来做**：用现代 Selection/Range + `beforeinput` 自建编辑层；并把"往返保真"做成可测契约——表格、嵌套列表、HTML 块、行内代码各备样例，断言"**未被编辑的块转换后必须与原 Markdown 逐字一致**"。

### C2. 无边框窗口 + 自绘标题栏

它的自绘标题栏有一个值得记下的坑：`window-state` 插件会恢复装饰标志，必须显式把 `DECORATIONS`/`VISIBLE` 从恢复位里排除，否则 `decorations:false` 失效。
**不建议**：你已有窗口状态记忆与三态原生窗口栏同步，改成无边框要同时处理拖拽区、双击最大化、圆角/阴影与全屏行为，收益不抵风险。

### C3. 自定义安装向导 / 卸载器

它用两个独立 Tauri 工程做安装与卸载向导，payload 内嵌，安装时可选文件关联，卸载自删除。你已有 NSIS + MSI + 便携版，且文件关联边界有契约测试。
**不建议照搬**。若确实需要"安装时可选关联"，NSIS 组件页（或 MSI feature）成本低一个数量级。它的实现里还有：打包脚本**硬编码 `D:\OpenMD` 绝对路径**、payload 无签名/哈希清单、卸载**不清理** WebView 存储与 app_data、自删除依赖固定 3 秒睡眠 + VBS（杀软拦截即残留）、注册表写入用 `taskkill /F /T` **强杀正在运行的应用（会丢未保存内容）**。

### C4. 托盘与关闭行为

托盘 + "关闭时询问/最小化到托盘/退出"是产品定位选择而非技术债。它的关闭处理是把 `CloseRequested` 全部 `prevent_close()` 后交给前端决定。你需要先决定 MD Reader 是否定位为常驻应用，再谈实现。

---

## 六、反面教材：明确不要学的部分

| 问题 | 位置 | 说明 |
|---|---|---|
| **明文凭据入库** | `src/utils/update-checker.ts` | 源码硬编码了一个 GitCode API 令牌（值不在此复述），任何 clone 都能读到 |
| **无签名校验的自动更新** | `src-tauri/src/updater.rs` | 只校验 `Content-Length`，被替换的安装包会被正常拉起 |
| **静默遥测** | `src-tauri/src/stats.rs` | 首次启动向第三方域 POST 版本与 OS，无开关、无告知；仅在 app_data 留一个标志文件 |
| **任意 URL 下载面** | `src-tauri/src/qq_group.rs` | 直接 GET 服务端 JSON 指定的 URL 并落盘缓存 |
| **非原子保存** | `src-tauri/src/commands.rs` | `fs::write` 直接覆盖，保存中崩溃即截断（你有原子替换，保持住） |
| **强杀运行中的应用** | `installer/…/installer.rs` | 安装前 `taskkill /F /T`，用户未保存的编辑直接丢失 |
| **调试残留** | `src-tauri/src/lib.rs` | 文件关联转发链路常驻 `assoc-debug.log` 日志 |
| **卸载不清理用户数据** | `uninstaller/…/uninstaller.rs` | WebView 存储（设置/最近列表）与 app_data 缓存全部残留 |

补充观察：仓库里有从作者另一项目改造的痕迹（安装器临时脚本名、卸载器语言包里残留的其他产品描述），说明它多处是从既有工程移植而来。这不影响功能判断，但能解释上面部分粗糙度。

---

## 七、反向清单：你已经更强的地方（别退化）

| 能力 | 你的实现 | OpenMD 对应 |
|---|---|---|
| 非 UTF-8 文档 | GB18030/GBK 严格回退（`text-decoding.js`），状态栏显示编码 | 只接受 UTF-8，其他报错要求重存 |
| 保存安全 | 同目录临时文件 + `sync` + `ReplaceFileW`/`rename` 原子替换，失败保留原文件；Windows 新建目标故意不带 `REPLACE_EXISTING` | `fs::write` 直接覆盖 |
| 读取安全 | 不跟随符号链接（Unix `O_NOFOLLOW`；Windows reparse point 标志 + 句柄元数据复核） | 扩展名白名单（这条同样扎实，见 A1） |
| 大文件竞态 | 未确认时先按阈值**硬上限读取**，封堵"打开后追加跨阈值" | 无此机制 |
| 删除安全 | 回收站四重复核 + `same_file` 身份二次确认 + 增量事务日志 + 幂等恢复；绝不调用永久删除 | 仅卸载时 `remove_dir_all` |
| 只读格式 | `.log` 一次性离线快照，后端独立执行只读约束 | 无此格式 |
| 全文搜索 | md/txt/log 三态覆盖，逐项定位 | 无 |
| 工程门禁 | Node 60 + Rust 60 用例、`cargo fmt`/`clippy -D warnings`、配置契约测试（关联/权限/版本/CI 逐条断言）、双 workflow | 无 CI、前端零测试、无 lint 配置 |
| 影子能力对比 | 悬浮滚动条你已有等价实现（`base.css` 悬停浮现 + Firefox `scrollbar-width`） | 自绘 JS 滚动条（直写 DOM 避免重渲染，手法可学但你不缺） |

---

## 八、GPL-3.0 合规边界（必读）

你是 **MIT**，上游是 **GPL-3.0**，两者不兼容：**一行代码都不能直接搬**（含测试、常量表、注释），否则整个 MD Reader 需要以 GPL-3.0 分发，或取得作者授权。

安全做法（本次调研已按此执行）：

1. 只提炼**思想、算法、架构决策、失败教训**——版权保护表达，不保护思路；
2. 用自己的语言与结构重写；本文件不含任何上游代码片段，令牌值也未复述；
3. 特别注意**大段具体注释**（它的注释写得很细，最容易被认定为受保护表达），只转述结论；
4. 不要复制它的测试用例文本，按自己的契约重写测试。

---

## 九、建议落地顺序

| 批次 | 内容 | 前置 |
|---|---|---|
| 1 | A1 本地图片（先造一张含本地图片的样例文档做验收）→ A6 铺满 → A3 任务列表 → A5 frontmatter | 无 |
| 2 | A2 外部修改监听（先更新 `PROJECT_STATUS.md` 的"不做文件监控"决策）→ B1 源码高亮 → A7 外部编辑器 | 批次 1 |
| 3 | A4 多标签页（独立立项，先做状态模型重构） | 需要单独设计文档 |
| 4（可选/需安全评审） | B2 应用内更新（官方 updater + 签名）、B5 CSP 生产收紧 | 安全评审 |

每项按项目既有节奏推进：`specs/*-design.md` → `plans/*.md` → 契约测试 → README/CHANGELOG 同步。

---

## 十、附录

### A. 调研中顺带发现的本项目问题（**2026-10-05 已全部处理**）

1. **README 结构清单漂移 → 已修复**：删除已不存在的 `src/css/scrollbar.css`；补上 `src/js/file-library.js`、`src/js/link-router.js`、`src-tauri/src/library.rs`、`src-tauri/src/storage.rs`；`tests/` 补全为 8 个文件；图标行改为"四角透明圆角已生效"（该图标的透明化早已随 v1.3.0 交付，原文"待实施"是旧状态）；体积表与 gzip 数字按重新构建的实测值更新；补上缺失的"文件目录"特性条目。
   - **附更正**：原文称"提到 `src-tauri/icons/app-icon-source.png` 但仓库内无对应目录"——**该判断有误**，文件确实存在（当时误读了 README 的描述），此条不属于漂移。
2. **`PROJECT_STATUS.md` 的 Rust 测试数字 → 原判断有误，该页记录是准确的**：58/58 与源码 63 个 `#[test]` 标记并不矛盾——其中 5 个是 `cfg(unix)` / `cfg(not(windows))` 门控，不参与 Windows 本地运行（63 − 5 = 58）。已在该页把口径写清楚，并把基线更新为本次的 **60/60**（新增 2 个测试后：65 标记 − 5 门控）。
   - 易踩的坑：源码 `#[test]` 标记数 ≠ 实际运行数，引用测试基线一律以 `cargo test` 输出为准。
3. **阅读进度写入未走安全写 → 已修复**：`save_reading_progress_at` / `load_reading_progress_at` 统一改用 `storage` 的 `read_json_or_default` + `write_json_safely`；新增 2 个 Rust 测试锁定"损坏文件不被单条记录覆盖"与"中断后从 `.bak` 恢复"。`CHANGELOG.md` 的 `[Unreleased]` 已记入 `### Fixed`。

**修复后验证**：`npm test` 60/60、`npm run build` 通过、`cargo fmt --check` 通过、`cargo test --locked` 60/60、`cargo clippy --all-targets -D warnings` 通过。

### B. 证据索引

**OpenMD（本次阅读/检索的关键文件）**

| 文件 | 内容 |
|---|---|
| `src/renderer/pipeline.ts` | 渲染管线、块级行号标记、frontmatter 剥离、本地图片解析 |
| `src/renderer/previewEdit.ts` / `backconvert.ts` | 预览编辑补丁归集、行漂移累计、HTML→Markdown 反转换与回退 |
| `src/components/MarkdownView.tsx` | 双视图、就地编辑装配、右键菜单、图片缩放（1343 行，最大单文件） |
| `src/stores/tabs.ts` / `settings.ts` / `recent.ts` / `toc.ts` | 标签、偏好、最近打开、目录状态 |
| `src/App.tsx` | 装配、快捷键、监听事件合并与自保存抑制、托盘/关闭行为 |
| `src/utils/update-checker.ts` / `stores/update.ts` | 版本检查（含明文令牌）与更新状态机 |
| `src-tauri/src/watcher.rs` | notify 防抖 + 目录引用计数 + 单测 |
| `src-tauri/src/commands.rs` | 读写白名单、asset 白名单、图片导入 |
| `src-tauri/src/updater.rs` / `stats.rs` / `qq_group.rs` / `editors.rs` / `file_assoc.rs` | 更新、遥测、外部程序、关联注册 |
| `installer/` / `uninstaller/` | 两个独立 Tauri 安装向导工程 |
| `src-tauri/tauri.conf.json` | 无边框窗口、CSP、assetProtocol、文件关联 |

**MD Reader（本次核对的关键文件）**

| 文件 | 内容 |
|---|---|
| `src/js/app.js` | 单文档状态模型（70-98 行）、渲染管线、状态栏统计（812 行）、字号与主题持久化 |
| `src/js/document-session.js` | 文档切换守卫、串行队列、脏判定与保存对账 |
| `src/js/file-library.js` / `link-router.js` / `text-decoding.js` / `file-types.js` | 文件库、外链路由、编码回退、类型策略 |
| `src-tauri/src/safe_file.rs` | 不跟随链接的读取与原子替换保存 |
| `src-tauri/src/library.rs` / `storage.rs` | 文件库、回收站事务日志、canonical 目录与可恢复 JSON 写 |
| `src-tauri/src/main.rs` | 11 个命令、CLI 队列、大文件阈值读取、存储迁移 |
| `src-tauri/tauri.conf.json` / `capabilities/default.json` | 原生窗口、CSP（含 `asset:` 但未启用 assetProtocol）、最小权限 |
| `tests/configuration.test.js` 等 8 个文件 | 配置契约 + 纯逻辑单测（60 用例） |
| `docs/superpowers/PROJECT_STATUS.md` | 既有决策（含"不做文件监控"）与验证基线 |
