#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod file_types;
mod library;
mod safe_file;
mod storage;

use file_types::{BackendError, DocumentKind, DocumentType, RenderMode};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{ErrorKind, Read};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
#[cfg(any(desktop, target_os = "ios", target_os = "android"))]
use tauri::Emitter;
use tauri::Manager;

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct FileData {
    path: String,
    content: String,
    encoding: String,
    kind: DocumentKind,
    render_mode: RenderMode,
    read_only: bool,
    size_bytes: u64,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct DocumentInspection {
    path: String,
    kind: DocumentKind,
    render_mode: RenderMode,
    read_only: bool,
    size_bytes: u64,
    requires_large_file_confirmation: bool,
}

#[derive(Serialize, Deserialize, Clone, Default)]
struct ReadingProgress {
    scroll_top: f64,
    scroll_pct: f64,
}

#[derive(Debug, Clone)]
struct StoragePaths {
    config_dir: PathBuf,
}

impl StoragePaths {
    fn new(config_dir: PathBuf) -> Self {
        Self { config_dir }
    }

    fn progress_file(&self) -> PathBuf {
        self.config_dir.join("progress.json")
    }
}

fn legacy_config_dir() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("md-reader")
}

#[cfg(any(not(target_os = "windows"), test))]
fn legacy_storage_paths(config_dir: PathBuf) -> StoragePaths {
    let _ = fs::create_dir_all(&config_dir).ok();
    StoragePaths::new(config_dir)
}

#[cfg(any(target_os = "windows", test))]
fn migrate_storage_files(legacy_dir: &Path, canonical_dir: &Path) -> std::io::Result<()> {
    const STORAGE_FILES: [(&str, &str); 2] = [
        ("recent.json", "recent.legacy.json"),
        ("progress.json", "progress.legacy.json"),
    ];

    fs::create_dir_all(canonical_dir)?;
    if !legacy_dir.try_exists()? {
        return Ok(());
    }

    let mut moves = Vec::new();
    for (file_name, legacy_file_name) in STORAGE_FILES {
        let source = legacy_dir.join(file_name);
        if !source.try_exists()? {
            continue;
        }

        let canonical = canonical_dir.join(file_name);
        let destination = if canonical.try_exists()? {
            let quarantine = canonical_dir.join(legacy_file_name);
            if quarantine.try_exists()? {
                return Err(std::io::Error::new(
                    ErrorKind::AlreadyExists,
                    format!(
                        "cannot migrate {} because quarantine target already exists: {}",
                        source.display(),
                        quarantine.display()
                    ),
                ));
            }
            quarantine
        } else {
            canonical
        };
        moves.push((source, destination));
    }

    for (source, destination) in moves {
        fs::rename(source, destination)?;
    }

    match fs::remove_dir(legacy_dir) {
        Ok(()) => Ok(()),
        Err(error)
            if matches!(
                error.kind(),
                ErrorKind::NotFound | ErrorKind::DirectoryNotEmpty
            ) =>
        {
            Ok(())
        }
        Err(error) => Err(error),
    }
}

fn metadata_error(path: &Path, error: std::io::Error) -> BackendError {
    if error.kind() == ErrorKind::NotFound {
        BackendError::new("missing_file", format!("文件不存在: {}", path.display()))
    } else {
        BackendError::new(
            "metadata_failed",
            format!("无法读取文件元数据 {}: {error}", path.display()),
        )
    }
}

fn inspect_document_path(path: &Path) -> Result<(DocumentType, fs::Metadata), BackendError> {
    let document_type = file_types::classify_path(path)?;
    let metadata = fs::symlink_metadata(path).map_err(|error| metadata_error(path, error))?;

    if !metadata.file_type().is_file() {
        return Err(BackendError::new(
            "not_regular_file",
            format!("路径不是普通文件: {}", path.display()),
        ));
    }

    Ok((document_type, metadata))
}

/// 无副作用地检查文档类型、文件状态和大日志预警条件。
#[tauri::command]
fn inspect_document(path: String) -> Result<DocumentInspection, BackendError> {
    let (document_type, metadata) = inspect_document_path(Path::new(&path))?;
    let size_bytes = metadata.len();
    let requires_large_file_confirmation = document_type.warn_when_large
        && size_bytes >= file_types::policy()?.large_log_warning_bytes();

    Ok(DocumentInspection {
        path,
        kind: document_type.kind,
        render_mode: document_type.render_mode,
        read_only: !document_type.can_save(),
        size_bytes,
        requires_large_file_confirmation,
    })
}

fn large_log_confirmation_error() -> BackendError {
    BackendError::new(
        "large_log_confirmation_required",
        "日志文件较大，读取前需要用户确认",
    )
}

fn read_document_bytes<R: Read>(
    reader: &mut R,
    unconfirmed_log_threshold: Option<u64>,
    path: &str,
) -> Result<Vec<u8>, BackendError> {
    let mut bytes = Vec::new();
    if let Some(threshold) = unconfirmed_log_threshold {
        reader
            .take(threshold)
            .read_to_end(&mut bytes)
            .map_err(|error| {
                BackendError::new("read_failed", format!("读取文件失败 {path}: {error}"))
            })?;
        if bytes.len() as u64 >= threshold {
            return Err(large_log_confirmation_error());
        }
    } else {
        reader.read_to_end(&mut bytes).map_err(|error| {
            BackendError::new("read_failed", format!("读取文件失败 {path}: {error}"))
        })?;
    }
    Ok(bytes)
}

fn read_document(path: String, allow_large_log: bool) -> Result<FileData, BackendError> {
    let target = Path::new(&path);
    let document_type = file_types::classify_path(target)?;
    let (mut file, metadata) =
        safe_file::open_regular_for_read(target).map_err(|error| match error {
            safe_file::OpenRegularFileError::Open(error) if error.kind() == ErrorKind::NotFound => {
                BackendError::new("missing_file", format!("文件不存在: {path}"))
            }
            safe_file::OpenRegularFileError::Open(error) => {
                BackendError::new("read_failed", format!("打开文件失败 {path}: {error}"))
            }
            safe_file::OpenRegularFileError::Metadata(error) => BackendError::new(
                "metadata_failed",
                format!("无法读取已打开文件的元数据 {path}: {error}"),
            ),
            safe_file::OpenRegularFileError::NotRegular => BackendError::new(
                "not_regular_file",
                format!("已打开的路径不是普通文件: {path}"),
            ),
        })?;
    let unconfirmed_log_threshold = if document_type.warn_when_large && !allow_large_log {
        Some(file_types::policy()?.large_log_warning_bytes())
    } else {
        None
    };
    if unconfirmed_log_threshold.is_some_and(|threshold| metadata.len() >= threshold) {
        return Err(large_log_confirmation_error());
    }

    // Unconfirmed logs are read through a hard cap as well as a metadata check.
    // This closes the race where an actively appended log crosses the warning
    // threshold after the file handle was opened.
    let bytes = read_document_bytes(&mut file, unconfirmed_log_threshold, &path)?;
    let size_bytes = bytes.len() as u64;

    let (content, encoding) = if let Ok(content) = std::str::from_utf8(&bytes) {
        (content.to_string(), "UTF-8".to_string())
    } else {
        let (content, _, had_errors) = encoding_rs::GB18030.decode(&bytes);
        if had_errors {
            return Err(BackendError::new(
                "decode_failed",
                "无法识别文件编码（非 UTF-8 或 GBK/GB18030）",
            ));
        }
        (content.into_owned(), "GB18030".to_string())
    };

    Ok(FileData {
        path,
        content,
        encoding,
        kind: document_type.kind,
        render_mode: document_type.render_mode,
        read_only: !document_type.can_save(),
        size_bytes,
    })
}

/// 读取文件内容（UTF-8 优先，失败时尝试 GB18030/GBK）。
#[tauri::command]
fn read_file(path: String, allow_large_log: bool) -> Result<FileData, BackendError> {
    read_document(path, allow_large_log)
}

/// 保存文件内容
#[tauri::command]
fn save_file(path: String, content: String) -> Result<(), BackendError> {
    let target = Path::new(&path);
    let document_type = file_types::classify_path(target)?;
    if document_type.kind == DocumentKind::Log || !document_type.can_save() {
        return Err(BackendError::new(
            "readonly_file",
            "LOG 文件以只读模式打开，不能保存",
        ));
    }

    let existing_permissions = match fs::symlink_metadata(target) {
        Ok(metadata) if !metadata.file_type().is_file() => {
            return Err(BackendError::new(
                "not_regular_file",
                format!("保存目标不是普通文件: {}", target.display()),
            ));
        }
        Ok(metadata) => Some(metadata.permissions()),
        Err(error) if error.kind() == ErrorKind::NotFound => None,
        Err(error) => {
            return Err(BackendError::new(
                "metadata_failed",
                format!("无法读取保存目标元数据 {}: {error}", target.display()),
            ));
        }
    };

    safe_file::atomic_replace_contents(target, content.as_bytes(), existing_permissions).map_err(
        |error| {
            BackendError::new(
                "save_failed",
                format!("保存文件失败 {}: {error}", target.display()),
            )
        },
    )?;
    Ok(())
}

/// 保存阅读进度
fn save_reading_progress_at(
    storage_paths: &StoragePaths,
    path: String,
    scroll_pct: f64,
) -> Result<(), String> {
    let progress_file = storage_paths.progress_file();
    let mut map: std::collections::HashMap<String, ReadingProgress> = if progress_file.exists() {
        serde_json::from_str(&fs::read_to_string(&progress_file).unwrap_or_default())
            .unwrap_or_default()
    } else {
        std::collections::HashMap::new()
    };

    map.insert(
        path,
        ReadingProgress {
            scroll_top: 0.0,
            scroll_pct,
        },
    );

    let json = serde_json::to_string_pretty(&map).unwrap_or_default();
    fs::write(&progress_file, json).map_err(|e| format!("保存进度失败: {}", e))?;
    Ok(())
}

#[tauri::command]
fn save_reading_progress(
    path: String,
    scroll_pct: f64,
    storage_paths: tauri::State<'_, StoragePaths>,
) -> Result<(), String> {
    save_reading_progress_at(storage_paths.inner(), path, scroll_pct)
}

/// 读取阅读进度
fn load_reading_progress_at(storage_paths: &StoragePaths, path: String) -> ReadingProgress {
    let progress_file = storage_paths.progress_file();
    if !progress_file.exists() {
        return ReadingProgress::default();
    }
    let map: std::collections::HashMap<String, ReadingProgress> =
        serde_json::from_str(&fs::read_to_string(&progress_file).unwrap_or_default())
            .unwrap_or_default();
    map.get(&path).cloned().unwrap_or_default()
}

#[tauri::command]
fn load_reading_progress(
    path: String,
    storage_paths: tauri::State<'_, StoragePaths>,
) -> ReadingProgress {
    load_reading_progress_at(storage_paths.inner(), path)
}

#[derive(Debug)]
struct OpenFileQueue {
    pending: Vec<String>,
    frontend_ready: bool,
}

impl OpenFileQueue {
    fn new(pending: Vec<String>) -> Self {
        Self {
            pending,
            frontend_ready: false,
        }
    }

    fn take_pending_and_mark_ready(&mut self) -> Vec<String> {
        self.frontend_ready = true;
        std::mem::take(&mut self.pending)
    }

    #[cfg(any(test, target_os = "macos", target_os = "ios", target_os = "android"))]
    fn queue_or_emit(&mut self, path: String) -> Option<String> {
        if self.frontend_ready {
            Some(path)
        } else {
            self.pending.push(path);
            None
        }
    }
}

/// 启动时传入、或在前端事件监听器就绪前收到的文件路径。
struct CliArgs(Mutex<OpenFileQueue>);

#[cfg(any(test, target_os = "macos", target_os = "ios", target_os = "android"))]
fn queue_or_emit_open_file(cli_args: &CliArgs, path: String) -> Option<String> {
    let mut queue = cli_args.0.lock().unwrap();
    queue.queue_or_emit(path)
}

fn is_openable_document_path(path: &Path) -> bool {
    file_types::is_supported_document_path(path)
        && fs::symlink_metadata(path)
            .map(|metadata| metadata.file_type().is_file())
            .unwrap_or(false)
}

fn normalize_file_path(raw: &str) -> String {
    let mut path = raw.trim().trim_matches('"').to_string();
    if let Some(stripped) = path.strip_prefix("file://") {
        path = stripped.to_string();
        if cfg!(windows) && path.starts_with('/') {
            path = path.trim_start_matches('/').to_string();
        }
    }
    if cfg!(windows) {
        path = path.replace('/', "\\");
    }
    path
}

fn collect_file_args<I>(args: I, base_dir: &Path) -> Vec<String>
where
    I: IntoIterator<Item = String>,
{
    let mut files = Vec::new();
    for maybe_file in args {
        if maybe_file.starts_with('-') {
            continue;
        }
        let normalized = normalize_file_path(&maybe_file);
        // 相对路径按传入进程的工作目录绝对化；不使用 canonicalize，
        // 避免 Windows 的 \\?\ 前缀破坏与文件库路径的可比性。
        let path = if Path::new(&normalized).is_absolute() {
            normalized
        } else {
            base_dir.join(&normalized).to_string_lossy().into_owned()
        };
        if is_openable_document_path(Path::new(&path)) {
            files.push(path);
        }
    }
    files
}

fn collect_cli_file_args() -> Vec<String> {
    let current_dir = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    collect_file_args(std::env::args().skip(1), &current_dir)
}

#[cfg(any(desktop, target_os = "ios", target_os = "android"))]
fn emit_file_opened(app: &tauri::AppHandle, path: String) {
    if !is_openable_document_path(Path::new(&path)) {
        return;
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.emit("file-opened", path);
    }
}

/// 仅调试构建允许用环境变量把配置目录隔离到指定位置，供桌面 QA 使用。
fn isolated_config_dir_override() -> Option<PathBuf> {
    #[cfg(debug_assertions)]
    return std::env::var_os("MD_READER_CONFIG_DIR").map(PathBuf::from);
    #[cfg(not(debug_assertions))]
    return None;
}

/// 获取启动时传入的文件路径
#[tauri::command]
fn get_cli_args(state: tauri::State<CliArgs>) -> Vec<String> {
    state.0.lock().unwrap().take_pending_and_mark_ready()
}

fn main() {
    let initial_args = collect_cli_file_args();

    let mut builder =
        tauri::Builder::default().manage(CliArgs(Mutex::new(OpenFileQueue::new(initial_args))));

    // 单实例必须先于其他插件注册：第二实例的文件参数经现有队列转交主窗口，
    // 避免出现第二个配置写入者。
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            for path in collect_file_args(args.into_iter().skip(1), Path::new(&cwd)) {
                emit_file_opened(app, path);
            }
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }));
    }

    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_filename("window-state.json")
                .build(),
        )
        .setup(|app| {
            let storage_paths = match isolated_config_dir_override() {
                Some(dir) => {
                    fs::create_dir_all(&dir)
                        .map_err(|error| format!("创建隔离配置目录失败: {error}"))?;
                    StoragePaths::new(dir)
                }
                None => {
                    #[cfg(target_os = "windows")]
                    let storage_paths = {
                        let canonical_dir = app.path().app_config_dir()?;
                        migrate_storage_files(&legacy_config_dir(), &canonical_dir)?;
                        StoragePaths::new(canonical_dir)
                    };

                    #[cfg(not(target_os = "windows"))]
                    let storage_paths = legacy_storage_paths(legacy_config_dir());
                    storage_paths
                }
            };

            app.manage(storage_paths);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            inspect_document,
            read_file,
            save_file,
            save_reading_progress,
            load_reading_progress,
            library::get_library_files,
            library::register_library_file,
            library::remove_library_file,
            library::trash_library_file,
            library::document_path_status,
            get_cli_args,
        ])
        .build(tauri::generate_context!())
        .expect("failed to run MD Reader")
        .run(|_app, event| match event {
            #[cfg(any(target_os = "macos", target_os = "ios", target_os = "android"))]
            tauri::RunEvent::Opened { urls } => {
                for url in urls {
                    if let Ok(path) = url.to_file_path() {
                        let p = path.to_string_lossy().to_string();
                        if is_openable_document_path(&path) {
                            let path_to_emit = {
                                let cli_args = _app.state::<CliArgs>();
                                queue_or_emit_open_file(&cli_args, p)
                            };
                            if let Some(path_to_emit) = path_to_emit {
                                emit_file_opened(_app, path_to_emit);
                            }
                        }
                    }
                }
            }
            _ => {}
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static TEMP_DIRECTORY_COUNTER: AtomicU64 = AtomicU64::new(0);

    struct TestDirectory {
        path: PathBuf,
    }

    impl TestDirectory {
        fn new(label: &str) -> Self {
            let counter = TEMP_DIRECTORY_COUNTER.fetch_add(1, Ordering::Relaxed);
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system time should be after the epoch")
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "md-reader-{label}-{}-{nonce}-{counter}",
                std::process::id()
            ));
            fs::create_dir(&path).expect("unique test directory should be created");
            Self { path }
        }

        fn path(&self, name: &str) -> PathBuf {
            self.path.join(name)
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    fn path_string(path: &Path) -> String {
        path.to_string_lossy().into_owned()
    }

    #[test]
    fn inspection_distinguishes_missing_directory_regular_and_unsupported_paths() {
        let directory = TestDirectory::new("inspection");

        let missing = directory.path("missing.md");
        assert_eq!(
            inspect_document(path_string(&missing)).unwrap_err().code,
            "missing_file"
        );

        let non_file = directory.path("folder.tex");
        fs::create_dir(&non_file).unwrap();
        assert_eq!(
            inspect_document(path_string(&non_file)).unwrap_err().code,
            "not_regular_file"
        );

        let unsupported = directory.path("image.png");
        fs::write(&unsupported, b"not a document").unwrap();
        assert_eq!(
            inspect_document(path_string(&unsupported))
                .unwrap_err()
                .code,
            "unsupported_type"
        );

        let regular = directory.path("paper.TeX");
        fs::write(&regular, "\\section{Intro}").unwrap();
        let inspection = inspect_document(path_string(&regular)).unwrap();
        assert_eq!(inspection.kind, DocumentKind::Text);
        assert_eq!(inspection.render_mode, RenderMode::Plain);
        assert!(!inspection.read_only);
        assert_eq!(inspection.size_bytes, 15);
        assert!(!inspection.requires_large_file_confirmation);

        let serialized = serde_json::to_value(inspection).unwrap();
        assert_eq!(serialized["renderMode"], "plain");
        assert_eq!(serialized["readOnly"], false);
        assert_eq!(serialized["sizeBytes"], 15);
        assert!(serialized.get("requiresLargeFileConfirmation").is_some());
        assert!(serialized.get("render_mode").is_none());
    }

    #[test]
    fn non_not_found_metadata_errors_have_a_stable_code() {
        let error = metadata_error(
            Path::new("denied.md"),
            std::io::Error::new(ErrorKind::PermissionDenied, "denied by fixture"),
        );
        assert_eq!(error.code, "metadata_failed");
        assert!(error.message.contains("denied.md"));
    }

    #[test]
    fn large_log_warning_includes_equal_threshold_boundary() {
        let directory = TestDirectory::new("log-boundary");
        let threshold = file_types::policy().unwrap().large_log_warning_bytes();

        for (name, size, expected_warning) in [
            ("below.log", threshold - 1, false),
            ("equal.log", threshold, true),
            ("above.log", threshold + 1, true),
        ] {
            let path = directory.path(name);
            fs::File::create(&path).unwrap().set_len(size).unwrap();
            let inspection = inspect_document(path_string(&path)).unwrap();
            assert_eq!(inspection.size_bytes, size);
            assert_eq!(
                inspection.requires_large_file_confirmation, expected_warning,
                "size: {size}"
            );
        }
    }

    #[test]
    fn unconfirmed_large_log_is_not_read() {
        let directory = TestDirectory::new("unconfirmed-log");

        let log = directory.path("large.log");
        fs::File::create(&log)
            .unwrap()
            .set_len(file_types::policy().unwrap().large_log_warning_bytes())
            .unwrap();

        let error = read_document(path_string(&log), false).unwrap_err();
        assert_eq!(error.code, "large_log_confirmation_required");
    }

    #[test]
    fn log_growth_after_inspection_is_rechecked_before_reading() {
        let directory = TestDirectory::new("growing-log");
        let log = directory.path("growing.log");
        fs::write(&log, b"initial").unwrap();

        let inspection = inspect_document(path_string(&log)).unwrap();
        assert!(!inspection.requires_large_file_confirmation);

        fs::OpenOptions::new()
            .write(true)
            .open(&log)
            .unwrap()
            .set_len(file_types::policy().unwrap().large_log_warning_bytes())
            .unwrap();
        let error = read_document(path_string(&log), false).unwrap_err();
        assert_eq!(error.code, "large_log_confirmation_required");
    }

    #[test]
    fn unconfirmed_log_stream_stops_at_the_warning_boundary() {
        let mut below = Cursor::new(b"1234567".to_vec());
        assert_eq!(
            read_document_bytes(&mut below, Some(8), "below.log").unwrap(),
            b"1234567"
        );

        let mut growing = Cursor::new(b"1234567890".to_vec());
        let error = read_document_bytes(&mut growing, Some(8), "growing.log").unwrap_err();
        assert_eq!(error.code, "large_log_confirmation_required");
        assert_eq!(
            growing.position(),
            8,
            "the unconfirmed read must stay bounded"
        );
    }

    #[test]
    fn tex_reading_supports_utf8_and_gb18030_and_returns_document_capabilities() {
        let directory = TestDirectory::new("tex-decode");

        let utf8 = directory.path("utf8.tex");
        let utf8_content = "\\section{你好}\r\n\r\n  indented\n\\command{value}";
        fs::write(&utf8, utf8_content.as_bytes()).unwrap();
        let utf8_data = read_document(path_string(&utf8), false).unwrap();
        assert_eq!(utf8_data.content, utf8_content);
        assert_eq!(utf8_data.encoding, "UTF-8");
        assert_eq!(utf8_data.kind, DocumentKind::Text);
        assert_eq!(utf8_data.render_mode, RenderMode::Plain);
        assert!(!utf8_data.read_only);
        assert_eq!(utf8_data.size_bytes, utf8_content.len() as u64);

        let gb18030 = directory.path("gb18030.TeX");
        fs::write(&gb18030, [0xD6, 0xD0, 0xCE, 0xC4]).unwrap();
        let gb18030_data = read_document(path_string(&gb18030), false).unwrap();
        assert_eq!(gb18030_data.content, "中文");
        assert_eq!(gb18030_data.encoding, "GB18030");
    }

    #[test]
    fn failed_decode_and_missing_paths_return_stable_errors() {
        let directory = TestDirectory::new("decode-failure");

        let invalid = directory.path("invalid.tex");
        fs::write(&invalid, [0x81]).unwrap();
        let error = read_document(path_string(&invalid), false).unwrap_err();
        assert_eq!(error.code, "decode_failed");

        let missing = directory.path("missing.tex");
        let error = read_document(path_string(&missing), false).unwrap_err();
        assert_eq!(error.code, "missing_file");
    }

    #[test]
    fn saving_tex_writes_utf8_and_rejects_log_without_modifying_it() {
        let directory = TestDirectory::new("save-policy");

        let tex = directory.path("paper.tex");
        fs::write(&tex, b"old content").unwrap();
        let content = "\\section{保存}\r\n\r\n  正文\n\\end{document}";
        save_file(path_string(&tex), content.to_string()).unwrap();
        assert_eq!(fs::read(&tex).unwrap(), content.as_bytes());
        assert_eq!(
            std::str::from_utf8(&fs::read(&tex).unwrap()).unwrap(),
            content
        );

        let new_tex = directory.path("new.tex");
        save_file(path_string(&new_tex), "新文件".to_string()).unwrap();
        assert_eq!(fs::read(&new_tex).unwrap(), "新文件".as_bytes());

        let log = directory.path("build.log");
        fs::write(&log, b"original log").unwrap();
        let modified_before = fs::metadata(&log).unwrap().modified().unwrap();
        let error = save_file(path_string(&log), "replacement".to_string()).unwrap_err();
        assert_eq!(error.code, "readonly_file");
        assert_eq!(fs::read(&log).unwrap(), b"original log");
        assert_eq!(
            fs::metadata(&log).unwrap().modified().unwrap(),
            modified_before
        );

        let unsupported = directory.path("notes.json");
        fs::write(&unsupported, b"original json").unwrap();
        let unsupported_modified_before = fs::metadata(&unsupported).unwrap().modified().unwrap();
        let error = save_file(path_string(&unsupported), "{}".to_string()).unwrap_err();
        assert_eq!(error.code, "unsupported_type");
        assert_eq!(fs::read(&unsupported).unwrap(), b"original json");
        assert_eq!(
            fs::metadata(&unsupported).unwrap().modified().unwrap(),
            unsupported_modified_before
        );
    }

    #[test]
    fn save_rejects_existing_non_regular_targets() {
        let directory = TestDirectory::new("save-special");
        let target_directory = directory.path("directory.tex");
        fs::create_dir(&target_directory).unwrap();

        let error = save_file(path_string(&target_directory), "content".to_string()).unwrap_err();
        assert_eq!(error.code, "not_regular_file");
        assert!(target_directory.is_dir());
    }

    #[cfg(unix)]
    #[test]
    fn reads_and_saves_reject_existing_symbolic_links() {
        use std::os::unix::fs::symlink;

        let directory = TestDirectory::new("symlink");
        let target = directory.path("target.tex");
        let link = directory.path("link.tex");
        fs::write(&target, b"original").unwrap();
        symlink(&target, &link).unwrap();

        assert_eq!(
            inspect_document(path_string(&link)).unwrap_err().code,
            "not_regular_file"
        );
        assert_eq!(
            save_file(path_string(&link), "replacement".to_string())
                .unwrap_err()
                .code,
            "not_regular_file"
        );
        assert_eq!(fs::read(&target).unwrap(), b"original");
    }

    #[cfg(unix)]
    #[test]
    fn save_rejects_existing_special_files() {
        use std::os::unix::net::UnixListener;

        let directory = TestDirectory::new("special-file");
        let socket = directory.path("socket.tex");
        let _listener = UnixListener::bind(&socket).unwrap();

        let error = save_file(path_string(&socket), "replacement".to_string()).unwrap_err();
        assert_eq!(error.code, "not_regular_file");
        assert!(!fs::symlink_metadata(&socket).unwrap().file_type().is_file());
    }

    #[test]
    fn cli_filter_uses_shared_policy_and_requires_regular_files() {
        let directory = TestDirectory::new("cli-filter");
        let tex = directory.path("paper.TeX");
        let log = directory.path("build.LOG");
        let markdown = directory.path("README.md");
        let unsupported = directory.path("image.png");
        let fake_file = directory.path("folder.log");
        fs::write(&tex, b"tex").unwrap();
        fs::write(&log, b"log").unwrap();
        fs::write(&markdown, b"markdown").unwrap();
        fs::write(&unsupported, b"png").unwrap();
        fs::create_dir(&fake_file).unwrap();

        let accepted = collect_file_args(
            vec![
                "--ignored-option".to_string(),
                path_string(&tex),
                path_string(&log),
                path_string(&markdown),
                path_string(&unsupported),
                path_string(&fake_file),
                path_string(&directory.path("missing.txt")),
            ],
            &directory.path,
        );

        assert_eq!(
            accepted,
            vec![path_string(&tex), path_string(&log), path_string(&markdown)]
        );
    }

    #[test]
    fn cli_relative_paths_are_resolved_against_the_base_directory() {
        let directory = TestDirectory::new("cli-relative");
        let relative = directory.path("relative.md");
        fs::write(&relative, b"# relative").unwrap();
        let tex = directory.path("paper.tex");
        fs::write(&tex, b"tex").unwrap();
        let unsupported = directory.path("image.png");
        fs::write(&unsupported, b"png").unwrap();

        let accepted = collect_file_args(
            vec![
                "relative.md".to_string(),
                "paper.tex".to_string(),
                "missing.md".to_string(),
                "image.png".to_string(),
            ],
            &directory.path,
        );

        assert_eq!(accepted, vec![path_string(&relative), path_string(&tex)]);
    }

    #[test]
    fn open_file_queue_delivers_each_path_through_exactly_one_channel() {
        let startup = "startup.tex".to_string();
        let before_ready = "before-ready.log".to_string();
        let after_ready = "after-ready.md".to_string();
        let mut queue = OpenFileQueue::new(vec![startup.clone()]);

        assert_eq!(queue.queue_or_emit(before_ready.clone()), None);
        assert_eq!(
            queue.take_pending_and_mark_ready(),
            vec![startup, before_ready]
        );
        assert!(queue.take_pending_and_mark_ready().is_empty());
        assert_eq!(queue.queue_or_emit(after_ready.clone()), Some(after_ready));
        assert!(queue.pending.is_empty());
    }

    #[test]
    fn cli_args_queue_access_returns_an_owned_path_after_frontend_is_ready() {
        let cli_args = CliArgs(Mutex::new(OpenFileQueue::new(Vec::new())));
        let before_ready = "before-ready.log".to_string();
        let after_ready = "after-ready.tex".to_string();

        assert_eq!(
            queue_or_emit_open_file(&cli_args, before_ready.clone()),
            None
        );
        assert_eq!(
            cli_args.0.lock().unwrap().take_pending_and_mark_ready(),
            vec![before_ready]
        );
        assert_eq!(
            queue_or_emit_open_file(&cli_args, after_ready.clone()),
            Some(after_ready)
        );
    }

    #[test]
    fn legacy_storage_paths_returns_selected_path_after_directory_creation_failure() {
        let directory = TestDirectory::new("legacy-storage-create-failure");
        let occupied_path = directory.path("legacy");
        fs::write(&occupied_path, b"not a directory").unwrap();

        let storage_paths = legacy_storage_paths(occupied_path.clone());

        assert_eq!(storage_paths.config_dir, occupied_path);
        assert!(storage_paths.config_dir.is_file());
    }

    #[test]
    fn migration_moves_both_storage_files_without_changing_bytes() {
        let directory = TestDirectory::new("migrate-both");
        let legacy = directory.path("legacy");
        let canonical = directory.path("canonical");
        fs::create_dir(&legacy).unwrap();
        let recent_bytes = b"[\x00legacy recent bytes\xff]";
        let progress_bytes = b"{\x00legacy progress bytes\xff}";
        fs::write(legacy.join("recent.json"), recent_bytes).unwrap();
        fs::write(legacy.join("progress.json"), progress_bytes).unwrap();

        migrate_storage_files(&legacy, &canonical).unwrap();

        assert_eq!(
            fs::read(canonical.join("recent.json")).unwrap(),
            recent_bytes
        );
        assert_eq!(
            fs::read(canonical.join("progress.json")).unwrap(),
            progress_bytes
        );
        assert!(!legacy.exists());
    }

    #[test]
    fn migration_moves_a_single_storage_file() {
        let directory = TestDirectory::new("migrate-single");
        let legacy = directory.path("legacy");
        let canonical = directory.path("canonical");
        fs::create_dir(&legacy).unwrap();
        fs::write(legacy.join("recent.json"), b"recent only").unwrap();

        migrate_storage_files(&legacy, &canonical).unwrap();

        assert_eq!(
            fs::read(canonical.join("recent.json")).unwrap(),
            b"recent only"
        );
        assert!(!canonical.join("progress.json").exists());
        assert!(!legacy.exists());
    }

    #[test]
    fn migration_without_legacy_prepares_an_empty_canonical_directory() {
        let directory = TestDirectory::new("migrate-no-legacy");
        let legacy = directory.path("missing-legacy");
        let canonical = directory.path("canonical");

        migrate_storage_files(&legacy, &canonical).unwrap();

        assert!(canonical.is_dir());
        assert!(!legacy.exists());
        assert!(fs::read_dir(&canonical).unwrap().next().is_none());
    }

    #[test]
    fn migration_is_idempotent_after_success() {
        let directory = TestDirectory::new("migrate-idempotent");
        let legacy = directory.path("legacy");
        let canonical = directory.path("canonical");
        fs::create_dir(&legacy).unwrap();
        fs::write(legacy.join("progress.json"), b"progress bytes").unwrap();

        migrate_storage_files(&legacy, &canonical).unwrap();
        migrate_storage_files(&legacy, &canonical).unwrap();

        assert_eq!(
            fs::read(canonical.join("progress.json")).unwrap(),
            b"progress bytes"
        );
        assert!(!legacy.exists());
    }

    #[test]
    fn migration_quarantines_legacy_file_when_canonical_conflicts() {
        let directory = TestDirectory::new("migrate-conflict");
        let legacy = directory.path("legacy");
        let canonical = directory.path("canonical");
        fs::create_dir(&legacy).unwrap();
        fs::create_dir(&canonical).unwrap();
        fs::write(legacy.join("recent.json"), b"legacy recent").unwrap();
        fs::write(canonical.join("recent.json"), b"canonical recent").unwrap();

        migrate_storage_files(&legacy, &canonical).unwrap();

        assert_eq!(
            fs::read(canonical.join("recent.json")).unwrap(),
            b"canonical recent"
        );
        assert_eq!(
            fs::read(canonical.join("recent.legacy.json")).unwrap(),
            b"legacy recent"
        );
        assert!(!legacy.exists());
    }

    #[test]
    fn migration_preflights_existing_quarantine_before_any_rename() {
        let directory = TestDirectory::new("migrate-preflight");
        let legacy = directory.path("legacy");
        let canonical = directory.path("canonical");
        fs::create_dir(&legacy).unwrap();
        fs::create_dir(&canonical).unwrap();
        fs::write(legacy.join("recent.json"), b"legacy recent").unwrap();
        fs::write(legacy.join("progress.json"), b"legacy progress").unwrap();
        fs::write(canonical.join("progress.json"), b"canonical progress").unwrap();
        fs::write(
            canonical.join("progress.legacy.json"),
            b"existing quarantine",
        )
        .unwrap();

        let error = migrate_storage_files(&legacy, &canonical).unwrap_err();

        assert_eq!(error.kind(), ErrorKind::AlreadyExists);
        assert_eq!(
            fs::read(legacy.join("recent.json")).unwrap(),
            b"legacy recent"
        );
        assert_eq!(
            fs::read(legacy.join("progress.json")).unwrap(),
            b"legacy progress"
        );
        assert!(!canonical.join("recent.json").exists());
        assert_eq!(
            fs::read(canonical.join("progress.json")).unwrap(),
            b"canonical progress"
        );
        assert_eq!(
            fs::read(canonical.join("progress.legacy.json")).unwrap(),
            b"existing quarantine"
        );
    }

    #[test]
    fn migration_leaves_unknown_files_and_the_legacy_directory_in_place() {
        let directory = TestDirectory::new("migrate-unknown");
        let legacy = directory.path("legacy");
        let canonical = directory.path("canonical");
        fs::create_dir(&legacy).unwrap();
        fs::write(legacy.join("recent.json"), b"recent bytes").unwrap();
        fs::write(legacy.join("keep.me"), b"unknown bytes").unwrap();

        migrate_storage_files(&legacy, &canonical).unwrap();

        assert_eq!(
            fs::read(canonical.join("recent.json")).unwrap(),
            b"recent bytes"
        );
        assert_eq!(fs::read(legacy.join("keep.me")).unwrap(), b"unknown bytes");
        assert!(legacy.is_dir());
    }

    #[test]
    fn progress_helpers_only_use_the_injected_storage_paths() {
        let directory = TestDirectory::new("injected-storage");
        let legacy = directory.path("legacy");
        let canonical = directory.path("canonical");
        fs::create_dir(&legacy).unwrap();
        fs::create_dir(&canonical).unwrap();
        let legacy_progress = br#"{"legacy.md":{"scroll_top":9.0,"scroll_pct":0.9}}"#;
        fs::write(legacy.join("progress.json"), legacy_progress).unwrap();
        let storage_paths = StoragePaths::new(canonical.clone());

        save_reading_progress_at(&storage_paths, "canonical.md".to_string(), 0.75).unwrap();

        let progress = load_reading_progress_at(&storage_paths, "canonical.md".to_string());
        assert_eq!(progress.scroll_top, 0.0);
        assert_eq!(progress.scroll_pct, 0.75);
        assert_eq!(
            fs::read(legacy.join("progress.json")).unwrap(),
            legacy_progress
        );
        assert_eq!(
            storage_paths.progress_file(),
            canonical.join("progress.json")
        );
    }
}
