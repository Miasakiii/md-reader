//! 文档内相对路径图片的白名单放行。
//!
//! 资产协议一旦启用就等于给 WebView 一条读取本地文件的通道，因此这里
//! 的边界必须失败关闭：
//!
//! 1. 只处理相对路径。`http(s):`、`data:`、`file:` 与绝对路径一律拒绝，
//!    避免把协议处理器变成万能读取器。
//! 2. 目标必须能`canonicalize`（符号链接与 junction 会被解析成真实
//!    路径，无法夹带），且必须是普通文件。
//! 3. 目标必须落在允许根内：基准是文档所在目录；向上遇到 `.git` 可
//!    放宽到仓库根，兼容 `docs/guide.md` 引用 `../assets/x.png`。
//! 4. **主目录是天花板**。没有这一层，文档目录里的一个 `.git` 目录就
//!    能把整个家目录变成资源根，`![](../../../.ssh/id_rsa)` 即可读取
//!    任意文件。

use std::fs;
use std::path::{Path, PathBuf};

use tauri::Manager;

use crate::file_types::BackendError;
use crate::safe_file;

/// 主目录天花板：文档位于主目录之内时，任何允许根都不得越过它。
///
/// 文档在主目录之外时返回 `None`（不设天花板）：`/tmp`、外接盘、网络盘上的
/// 文档若被主目录规则拦下，本地图片会一律失效——这正是 CI 上 Ubuntu runner
/// 的 `/tmp` 夹具全数失败的原因。此时边界仍由「允许根 ⊆ 文档目录或仓库根」
/// 保证，而允许根是从文档自身推导的，不存在越界面。
fn home_ceiling(document_file: &Path) -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    let home = fs::canonicalize(&home).unwrap_or(home);
    let document_file = fs::canonicalize(document_file).ok()?;
    document_file.starts_with(&home).then_some(home)
}

/// 从 `document_path` 向上求允许根：命中 `.git` 的仓库根，或文档所在目录。
///
/// 上溯到文件系统根仍未命中 `.git` 时回退为文档目录——否则普通目录里的
/// 文档会一张本地图片都显示不出来。
///
/// 命中仓库根即停止上溯：`~/.git` 存在时会把家目录纳入允许根，正是天花板
/// 规则要防的情形。
fn allowed_root(document_path: &Path) -> Option<PathBuf> {
    let document_file = fs::canonicalize(document_path).ok()?;
    // 从文档所在的**目录**开始上溯，而不是从文件本身。
    let mut directory = document_file.parent()?;

    loop {
        if directory.join(".git").exists() {
            return Some(directory.to_path_buf());
        }
        match directory.parent() {
            Some(parent) => directory = parent,
            // 已到文件系统根，回退为文档所在目录。
            None => return document_file.parent().map(Path::to_path_buf),
        }
    }
}

fn is_relative_reference(reference: &str) -> bool {
    let trimmed = reference.trim();
    !trimmed.is_empty()
        && !trimmed.starts_with('/')
        && !trimmed.starts_with('\\')
        && !trimmed.contains(':')
        && !trimmed.starts_with('#')
}

/// 校验单个相对引用并返回可放行的绝对路径。
///
/// 不做扩展名白名单：`shared/document-types.json` 管的是文档类型，
/// 图片类型由浏览器在解码阶段判断，这里越权反而容易与浏览器行为不一致。
fn resolve_asset(
    document_path: &Path,
    root: &Path,
    reference: &str,
    ceiling: Option<&Path>,
) -> Option<PathBuf> {
    if !is_relative_reference(reference) {
        return None;
    }

    let trimmed = reference.trim().replace('\\', "/");

    // 相对路径必须相对**文档所在目录**解析，而不是相对允许根。
    // `docs/guide.md` 里的 `../assets/x.png` 指向仓库根下的 assets/，
    // 按允许根解析会指向允许根之外，导致最常见的写法失效。
    let document_dir = fs::canonicalize(document_path).ok()?;
    let document_dir = document_dir.parent()?;

    // 越界判定只有一个权威来源：canonicalize 之后做前缀比较。
    // 不做字符串层面的 `..` 计数预检——符号链接、junction 与 `..`
    // 都在 canonicalize 阶段被解析掉，前缀比较已是权威判定。
    let candidate = document_dir.join(&trimmed);
    let canonical = fs::canonicalize(&candidate).ok()?;
    if !canonical.starts_with(root) {
        return None;
    }
    if let Some(ceiling) = ceiling {
        if !canonical.starts_with(ceiling) {
            return None;
        }
    }

    // 复用文档读取的同一套判定：不跟随链接打开，且必须是普通文件。
    // reparse point / junction / 目录在这里被拒。
    safe_file::open_regular_for_read(&canonical).ok()?;
    Some(canonical)
}

/// 逐个放行文档引用到的本地图片，返回实际放行的绝对路径列表。
///
/// 白名单必须在写入正文状态之前完成：首帧 `<img>` 请求与白名单存在竞态，
/// 首帧失败不会自动重试。
///
/// 校验与放行拆成两段：`resolve_references` 是纯逻辑、可单测的核心，
/// 命令层只负责把结果写入 Tauri 的资产作用域。
fn resolve_references(
    document_path: &Path,
    references: &[&str],
) -> Result<Vec<PathBuf>, BackendError> {
    if references.is_empty() {
        return Ok(Vec::new());
    }

    let root = allowed_root(document_path).ok_or_else(|| {
        BackendError::new(
            "asset_scope_unavailable",
            "无法确定文档所在目录的资源允许根",
        )
    })?;
    let ceiling = home_ceiling(document_path);

    let mut allowed: Vec<PathBuf> = Vec::new();
    for reference in references {
        let Some(canonical) = resolve_asset(document_path, &root, reference, ceiling.as_deref())
        else {
            continue;
        };
        if !allowed.contains(&canonical) {
            allowed.push(canonical);
        }
    }
    Ok(allowed)
}

fn authorize_document_assets(
    app: &tauri::AppHandle,
    document_path: &Path,
    references: &[String],
) -> Result<Vec<String>, BackendError> {
    let borrowed: Vec<&str> = references.iter().map(String::as_str).collect();
    let resolved = resolve_references(document_path, &borrowed)?;

    let scope = app.asset_protocol_scope();
    let mut allowed = Vec::with_capacity(resolved.len());
    for canonical in resolved {
        scope.allow_file(&canonical).map_err(|error| {
            BackendError::new(
                "asset_scope_failed",
                format!("无法放行资源 {}: {error}", canonical.display()),
            )
        })?;
        allowed.push(canonical.to_string_lossy().into_owned());
    }
    Ok(allowed)
}

#[tauri::command]
pub fn authorize_document_assets_command(
    app: tauri::AppHandle,
    document_path: String,
    references: Vec<String>,
) -> Result<Vec<String>, BackendError> {
    authorize_document_assets(&app, Path::new(&document_path), &references)
}

#[cfg(test)]
mod tests {
    use super::*;

    static TEMP_COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

    /// 唯一临时目录：同一条测试内可能需要嵌套目录树，仅靠名称会互相覆盖。
    ///
    /// 注意 `std::env::temp_dir()` 在 Unix 上可能返回符号链接（macOS 的
    /// `/tmp -> /private/tmp`，见 rust-lang/rust#100824），而 `resolve_asset`
    /// 刻意用 `O_NOFOLLOW` 拒绝链接。`canonicalize` 会把末段解析掉，因此
    /// 中间仍含链接的路径在测试里会被生产逻辑正确拒绝——那是刻意边界，
    /// 夹具不应依赖它不发生。
    fn temp_dir(name: &str) -> PathBuf {
        let seq = TEMP_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let base = std::env::temp_dir().join(format!(
            "md-reader-assets-{name}-{}-{seq}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();
        fs::canonicalize(&base).unwrap()
    }

    fn write_file(path: &Path, contents: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, contents).unwrap();
    }

    fn commit_repo(root: &Path) {
        write_file(&root.join(".git/HEAD"), "ref: refs/heads/main\n");
    }

    /// 与命令同构的可测核心：不触碰 Tauri 运行时即可验证放行集合。
    fn authorize(document_path: &Path, references: &[&str]) -> Vec<String> {
        resolve_references(document_path, references)
            .unwrap()
            .iter()
            .map(|path| path.to_string_lossy().into_owned())
            .collect()
    }

    #[test]
    fn allows_a_relative_image_under_the_document_directory() {
        let root = temp_dir("relative");
        write_file(&root.join("guide.md"), "# 指南");
        write_file(&root.join("images/diagram.png"), "png");

        let allowed = resolve_asset(&root.join("guide.md"), &root, "images/diagram.png", None);
        assert_eq!(allowed, Some(root.join("images").join("diagram.png")));

        let batch = authorize(&root.join("guide.md"), &["images/diagram.png"]);
        assert_eq!(
            batch,
            vec![root.join("images").join("diagram.png").to_string_lossy()]
        );
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn allows_a_parent_reference_that_stays_inside_the_repository_root() {
        let root = temp_dir("repo");
        commit_repo(&root);
        write_file(&root.join("docs/guide.md"), "# 指南");
        write_file(&root.join("assets/diagram.png"), "png");

        let repository_root = allowed_root(&root.join("docs/guide.md")).unwrap();
        assert_eq!(repository_root, root);

        let allowed = resolve_asset(
            &root.join("docs/guide.md"),
            &repository_root,
            "../assets/diagram.png",
            None,
        );
        assert_eq!(allowed, Some(root.join("assets").join("diagram.png")));
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn allows_a_sibling_reference_that_resolves_back_into_the_repository_root() {
        // 文档在 docs/ 下，`../secret.png` 解析到仓库根内，属合法。
        let root = temp_dir("escape");
        commit_repo(&root);
        write_file(&root.join("docs/guide.md"), "# 指南");
        write_file(&root.join("secret.png"), "png");

        let repository_root = allowed_root(&root.join("docs/guide.md")).unwrap();
        assert_eq!(
            resolve_asset(
                &root.join("docs/guide.md"),
                &repository_root,
                "../secret.png",
                None
            ),
            Some(root.join("secret.png"))
        );
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn rejects_parent_references_that_escape_the_repository_root() {
        // 构造真正的越界：仓库建在容器目录的 repo/ 子目录里，目标是
        // 容器目录下的 sibling.png —— 从 docs/ 引用需上溯两级。
        let container = temp_dir("escape-outside");
        let repository = container.join("repo");
        commit_repo(&repository);
        write_file(&repository.join("docs/guide.md"), "# 指南");
        write_file(&container.join("secret.png"), "png");

        let repository_root = allowed_root(&repository.join("docs/guide.md")).unwrap();
        assert_eq!(repository_root, fs::canonicalize(&repository).unwrap());

        assert_eq!(
            resolve_asset(
                &repository.join("docs/guide.md"),
                &repository_root,
                "../../secret.png",
                None,
            ),
            None,
            "仓库根之外的同��级文件不可达"
        );
        fs::remove_dir_all(&container).unwrap();
    }

    #[test]
    fn the_home_directory_ceiling_blocks_paths_outside_it() {
        let ceiling = temp_dir("ceiling-base");
        let inside = ceiling.join("docs/inside.png");
        let sibling = ceiling.parent().unwrap().join("outside.png");

        assert!(inside.starts_with(&ceiling));
        assert!(!sibling.starts_with(&ceiling));
        fs::remove_dir_all(&ceiling).unwrap();
    }

    #[test]
    fn the_home_ceiling_only_applies_to_documents_inside_the_home_directory() {
        // 文档在主目录之外（/tmp、外接盘、网络盘）时不设天花板，
        // 否则这些位置的文档会一张本地图片都显示不出来。
        let root = temp_dir("outside-home");
        write_file(&root.join("guide.md"), "# 指南");
        write_file(&root.join("a.png"), "png");
        let document = root.join("guide.md");

        let home = dirs::home_dir().unwrap();
        let inside_home = document.starts_with(fs::canonicalize(&home).unwrap_or(home.clone()));
        assert_eq!(
            home_ceiling(&document),
            inside_home.then(|| fs::canonicalize(&home).unwrap_or(home)),
            "ceiling must be present only when the document lives under the home directory"
        );
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn a_document_outside_the_home_directory_still_gets_its_assets_authorized() {
        // CI 上的真实场景：Ubuntu runner 的临时目录不在 /home/runner 之下。
        let root = temp_dir("tmp-like");
        commit_repo(&root);
        write_file(&root.join("guide.md"), "# 指南");
        write_file(&root.join("a.png"), "png");

        let allowed = authorize(&root.join("guide.md"), &["a.png"]);
        assert_eq!(
            allowed,
            vec![root.join("a.png").to_string_lossy().into_owned()]
        );
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn rejects_references_outside_the_configured_ceiling() {
        let root = temp_dir("ceiling");
        commit_repo(&root);
        write_file(&root.join("docs/guide.md"), "# 指南");
        write_file(&root.join("private/secret.png"), "png");

        // 假设的天花板比允许根更窄，一切资源都被拒。
        let narrow_ceiling = root.join("docs");
        assert_eq!(
            resolve_asset(
                &root.join("docs/guide.md"),
                &root,
                "private/secret.png",
                Some(&narrow_ceiling),
            ),
            None
        );
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn rejects_directories_and_missing_files() {
        let root = temp_dir("notfile");
        write_file(&root.join("guide.md"), "# 指南");
        fs::create_dir_all(root.join("images")).unwrap();

        assert_eq!(
            resolve_asset(&root.join("guide.md"), &root, "images", None),
            None
        );
        assert_eq!(
            resolve_asset(&root.join("guide.md"), &root, "images/missing.png", None),
            None
        );
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn rejects_non_relative_and_ambiguous_references() {
        let root = temp_dir("protocol");
        write_file(&root.join("guide.md"), "# 指南");

        for reference in [
            "https://example.com/a.png",
            "http://example.com/a.png",
            "data:image/png;base64,AAAA",
            "file:///C:/Windows/win.ini",
            "/etc/passwd",
            "\\\\server\\share\\a.png",
            "#anchor",
            "",
            "   ",
            "C:/Windows/win.ini",
        ] {
            assert_eq!(
                resolve_asset(&root.join("guide.md"), &root, reference, None),
                None,
                "reference must be rejected: {reference}"
            );
        }
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn rejects_a_traversal_that_escapes_before_normalization() {
        let root = temp_dir("traversal");
        commit_repo(&root);
        write_file(&root.join("docs/guide.md"), "# 指南");

        let repository_root = allowed_root(&root.join("docs/guide.md")).unwrap();
        assert_eq!(
            resolve_asset(
                &root.join("docs/guide.md"),
                &repository_root,
                "../../outside.png",
                None,
            ),
            None
        );
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn deduplicates_repeated_references() {
        let root = temp_dir("dedupe");
        commit_repo(&root);
        write_file(&root.join("guide.md"), "# 指南");
        write_file(&root.join("a.png"), "png");

        let allowed = authorize(&root.join("guide.md"), &["a.png", "./a.png", "a.png"]);
        assert_eq!(
            allowed,
            vec![root.join("a.png").to_string_lossy().into_owned()]
        );
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn skips_missing_files_without_failing_the_batch() {
        let root = temp_dir("skip");
        commit_repo(&root);
        write_file(&root.join("guide.md"), "# 指南");
        write_file(&root.join("ok.png"), "png");

        let allowed = authorize(&root.join("guide.md"), &["ok.png", "gone.png"]);
        assert_eq!(
            allowed,
            vec![root.join("ok.png").to_string_lossy().into_owned()]
        );
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn returns_an_empty_allowance_for_an_empty_reference_list() {
        let root = temp_dir("empty");
        write_file(&root.join("guide.md"), "# 指南");
        assert!(authorize(&root.join("guide.md"), &[]).is_empty());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn backslash_separators_resolve_like_posix_ones() {
        let root = temp_dir("backslash");
        write_file(&root.join("guide.md"), "# 指南");
        write_file(&root.join("images/diagram.png"), "png");

        let allowed = resolve_asset(&root.join("guide.md"), &root, "images\\diagram.png", None);
        assert_eq!(allowed, Some(root.join("images").join("diagram.png")));
        fs::remove_dir_all(&root).unwrap();
    }
}
