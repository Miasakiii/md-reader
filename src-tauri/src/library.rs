use crate::file_types;
use crate::storage::{
    read_json_or_default, recover_interrupted_write, try_path_exists, write_json_safely,
};
use crate::StoragePaths;
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

fn ensure_supported_document_path(path: &Path) -> Result<(), String> {
    file_types::classify_path(path)
        .map(|_| ())
        .map_err(|error| error.message)
}

fn validate_library_entries(paths: Vec<String>) -> Result<Vec<String>, String> {
    for path in &paths {
        ensure_supported_document_path(Path::new(path))?;
    }
    Ok(paths)
}

#[cfg(windows)]
fn path_key(path: &str) -> String {
    path.replace('/', "\\").to_lowercase()
}

#[cfg(not(windows))]
fn path_key(path: &str) -> String {
    path.to_string()
}

pub(crate) struct LibraryStore {
    config_dir: PathBuf,
}

impl LibraryStore {
    pub(crate) fn new(config_dir: PathBuf) -> Self {
        Self { config_dir }
    }

    fn library_path(&self) -> PathBuf {
        self.config_dir.join("library.json")
    }

    fn recent_path(&self) -> PathBuf {
        self.config_dir.join("recent.json")
    }

    pub(crate) fn load(&self) -> Result<Vec<String>, String> {
        let library = self.library_path();
        recover_interrupted_write(&library)?;
        if try_path_exists(&library)? {
            let paths: Vec<String> = read_json_or_default(&library)?;
            return validate_library_entries(paths);
        }
        let recent: Vec<String> =
            validate_library_entries(read_json_or_default(&self.recent_path())?)?;
        let mut seen = std::collections::HashSet::new();
        let migrated: Vec<String> = recent
            .into_iter()
            .filter(|path| seen.insert(path_key(path)))
            .collect();
        write_json_safely(&library, &migrated)?;
        Ok(migrated)
    }

    pub(crate) fn save(&self, paths: &[String]) -> Result<(), String> {
        validate_library_entries(paths.to_vec())?;
        write_json_safely(&self.library_path(), paths)
    }

    pub(crate) fn register(&self, path: &str) -> Result<Vec<String>, String> {
        let key = path_key(path);
        let mut paths = self.load()?;
        paths.retain(|existing| path_key(existing) != key);
        paths.insert(0, path.to_string());
        self.save(&paths)?;
        Ok(paths)
    }

    pub(crate) fn remove(&self, path: &str) -> Result<Vec<String>, String> {
        let key = path_key(path);
        let mut paths = self.load()?;
        paths.retain(|existing| path_key(existing) != key);
        self.save(&paths)?;
        Ok(paths)
    }

    pub(crate) fn contains(&self, path: &str) -> Result<bool, String> {
        let key = path_key(path);
        Ok(self
            .load()?
            .iter()
            .any(|existing| path_key(existing) == key))
    }

    pub(crate) fn progress_path(&self) -> PathBuf {
        self.config_dir.join("progress.json")
    }

    pub(crate) fn transaction_path(&self) -> PathBuf {
        self.config_dir.join("trash-transaction.json")
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum TrashPhase {
    Prepared,
    Trashed,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
struct TrashTransaction {
    path: String,
    phase: TrashPhase,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TrashOutcome {
    pub(crate) trashed: bool,
    pub(crate) files: Vec<String>,
    pub(crate) cleanup_warning: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum FileKind {
    Missing,
    Regular,
    Directory,
    Symlink,
    Other,
}

fn file_kind(path: &Path) -> Result<FileKind, String> {
    if !crate::storage::try_path_exists(path)? {
        return Ok(FileKind::Missing);
    }
    let metadata = fs::symlink_metadata(path).map_err(|error| format!("检查文件失败: {error}"))?;
    let kind = metadata.file_type();
    Ok(if kind.is_symlink() {
        FileKind::Symlink
    } else if kind.is_file() {
        FileKind::Regular
    } else if kind.is_dir() {
        FileKind::Directory
    } else {
        FileKind::Other
    })
}

fn regular_file_handle(path: &Path) -> Result<same_file::Handle, String> {
    let path_metadata =
        fs::symlink_metadata(path).map_err(|error| format!("重新检查待回收文件失败: {error}"))?;
    if path_metadata.file_type().is_symlink() || !path_metadata.is_file() {
        return Err("待回收路径发生变化，不再是原普通文件".to_string());
    }
    let handle = same_file::Handle::from_path(path)
        .map_err(|error| format!("打开待回收文件身份句柄失败: {error}"))?;
    let opened_metadata = handle
        .as_file()
        .metadata()
        .map_err(|error| format!("读取待回收文件身份失败: {error}"))?;
    if !opened_metadata.is_file() {
        return Err("待回收路径发生变化，不再是原普通文件".to_string());
    }
    Ok(handle)
}

fn validate_trash_candidate(registered: bool, kind: FileKind, path: &Path) -> Result<(), String> {
    if !registered {
        return Err("文件未登记在文件目录中".to_string());
    }
    if kind != FileKind::Regular {
        return Err("只允许把已登记的普通文件移到回收站".to_string());
    }
    ensure_supported_document_path(path)?;
    Ok(())
}

trait TrashPersistence {
    fn write_transaction(
        &self,
        store: &LibraryStore,
        value: &TrashTransaction,
    ) -> Result<(), String>;
    fn remove_transaction(&self, store: &LibraryStore) -> Result<(), String>;
    fn write_library(&self, store: &LibraryStore, files: &[String]) -> Result<(), String>;
    fn write_progress(
        &self,
        store: &LibraryStore,
        progress: &serde_json::Map<String, serde_json::Value>,
    ) -> Result<(), String>;
}

struct RealPersistence;

impl TrashPersistence for RealPersistence {
    fn write_transaction(
        &self,
        store: &LibraryStore,
        value: &TrashTransaction,
    ) -> Result<(), String> {
        crate::storage::write_json_safely(&store.transaction_path(), value)
    }

    fn remove_transaction(&self, store: &LibraryStore) -> Result<(), String> {
        let path = store.transaction_path();
        match fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(format!("清理回收站事务失败: {error}")),
        }
    }

    fn write_library(&self, store: &LibraryStore, files: &[String]) -> Result<(), String> {
        store.save(files)
    }

    fn write_progress(
        &self,
        store: &LibraryStore,
        progress: &serde_json::Map<String, serde_json::Value>,
    ) -> Result<(), String> {
        crate::storage::write_json_safely(&store.progress_path(), progress)
    }
}

fn remove_path_from_metadata(
    store: &LibraryStore,
    persistence: &impl TrashPersistence,
    path: &str,
) -> Result<Vec<String>, String> {
    let key = path_key(path);
    let mut files = store.load()?;
    files.retain(|entry| path_key(entry) != key);
    persistence.write_library(store, &files)?;

    let mut progress: serde_json::Map<String, serde_json::Value> =
        crate::storage::read_json_or_default(&store.progress_path())?;
    progress.retain(|entry, _| path_key(entry) != key);
    persistence.write_progress(store, &progress)?;
    Ok(files)
}

fn recover_pending_trash(
    store: &LibraryStore,
    persistence: &impl TrashPersistence,
) -> Result<(), String> {
    let transaction_path = store.transaction_path();
    crate::storage::recover_interrupted_write(&transaction_path)?;
    if !crate::storage::try_path_exists(&transaction_path)? {
        return Ok(());
    }
    let transaction: TrashTransaction = crate::storage::read_json_required(&transaction_path)?;
    let target_exists = Path::new(&transaction.path)
        .try_exists()
        .map_err(|error| format!("检查待恢复文件失败: {error}"))?;
    if transaction.phase == TrashPhase::Prepared && target_exists {
        return persistence.remove_transaction(store);
    }
    remove_path_from_metadata(store, persistence, &transaction.path)?;
    persistence.remove_transaction(store)
}

fn trash_registered_file_with<A, F>(
    store: &LibraryStore,
    persistence: &impl TrashPersistence,
    path: &Path,
    after_prepared: A,
    trash_file: F,
) -> Result<TrashOutcome, String>
where
    A: FnOnce(&Path) -> Result<(), String>,
    F: FnOnce(&Path) -> Result<(), String>,
{
    let registered = store.contains(path.to_string_lossy().as_ref())?;
    let kind = file_kind(path)?;
    validate_trash_candidate(registered, kind, path)?;
    let original_handle = regular_file_handle(path)?;

    let key = path_key(path.to_string_lossy().as_ref());
    let mut files_after = store.load()?;
    files_after.retain(|entry| path_key(entry) != key);

    let mut transaction = TrashTransaction {
        path: path.to_string_lossy().into_owned(),
        phase: TrashPhase::Prepared,
    };
    persistence.write_transaction(store, &transaction)?;
    let abort_prepared = |error: String| -> Result<TrashOutcome, String> {
        let journal_error = persistence.remove_transaction(store).err();
        Err(match journal_error {
            Some(cleanup) => format!("{error}; 清理事务记录失败: {cleanup}"),
            None => error,
        })
    };
    if let Err(error) = after_prepared(path) {
        return abort_prepared(error);
    }
    let current_handle = match regular_file_handle(path) {
        Ok(handle) => handle,
        Err(error) => return abort_prepared(format!("待回收文件发生变化: {error}")),
    };
    if original_handle != current_handle {
        return abort_prepared("待回收文件发生变化，已取消操作".to_string());
    }
    drop(current_handle);
    drop(original_handle);
    if let Err(error) = trash_file(path) {
        return abort_prepared(error);
    }

    let mut warnings = Vec::new();
    transaction.phase = TrashPhase::Trashed;
    if let Err(error) = persistence.write_transaction(store, &transaction) {
        return Ok(TrashOutcome {
            trashed: true,
            files: files_after,
            cleanup_warning: Some(error),
        });
    }
    match remove_path_from_metadata(store, persistence, &transaction.path) {
        Ok(current_files) => files_after = current_files,
        Err(error) => warnings.push(error),
    }
    if warnings.is_empty() {
        if let Err(error) = persistence.remove_transaction(store) {
            warnings.push(error);
        }
    }

    Ok(TrashOutcome {
        trashed: true,
        files: files_after,
        cleanup_warning: (!warnings.is_empty()).then(|| warnings.join("; ")),
    })
}

fn store(storage_paths: &StoragePaths) -> LibraryStore {
    LibraryStore::new(storage_paths.config_dir.clone())
}

fn recovered_store(storage_paths: &StoragePaths) -> Result<LibraryStore, String> {
    let store = store(storage_paths);
    recover_pending_trash(&store, &RealPersistence)?;
    Ok(store)
}

pub(crate) fn get_library_files_at(storage_paths: &StoragePaths) -> Result<Vec<String>, String> {
    recovered_store(storage_paths)?.load()
}

pub(crate) fn register_library_file_at(
    storage_paths: &StoragePaths,
    path: String,
) -> Result<Vec<String>, String> {
    let target = Path::new(&path);
    ensure_supported_document_path(target)?;
    let metadata = fs::metadata(target).map_err(|error| format!("检查文件失败: {error}"))?;
    if !metadata.is_file() {
        return Err("目标不是普通文档文件".to_string());
    }
    recovered_store(storage_paths)?.register(&path)
}

pub(crate) fn remove_library_file_at(
    storage_paths: &StoragePaths,
    path: String,
) -> Result<Vec<String>, String> {
    recovered_store(storage_paths)?.remove(&path)
}

pub(crate) fn trash_library_file_at(
    storage_paths: &StoragePaths,
    path: String,
) -> Result<TrashOutcome, String> {
    let store = recovered_store(storage_paths)?;
    trash_registered_file_with(
        &store,
        &RealPersistence,
        Path::new(&path),
        |_| Ok(()),
        |target| trash::delete(target).map_err(|error| format!("移到系统回收站失败: {error}")),
    )
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum DocumentPathStatus {
    Missing,
    File,
    Other,
}

#[tauri::command]
pub(crate) fn document_path_status(path: String) -> Result<DocumentPathStatus, String> {
    let target = Path::new(&path);
    ensure_supported_document_path(target)?;
    if !target
        .try_exists()
        .map_err(|error| format!("检查文件失败: {error}"))?
    {
        return Ok(DocumentPathStatus::Missing);
    }
    let metadata = fs::metadata(target).map_err(|error| format!("检查文件失败: {error}"))?;
    Ok(if metadata.is_file() {
        DocumentPathStatus::File
    } else {
        DocumentPathStatus::Other
    })
}

#[tauri::command]
pub(crate) fn get_library_files(
    storage_paths: tauri::State<'_, StoragePaths>,
) -> Result<Vec<String>, String> {
    let _guard = crate::storage::lock_storage()?;
    get_library_files_at(storage_paths.inner())
}

#[tauri::command]
pub(crate) fn register_library_file(
    storage_paths: tauri::State<'_, StoragePaths>,
    path: String,
) -> Result<Vec<String>, String> {
    let _guard = crate::storage::lock_storage()?;
    register_library_file_at(storage_paths.inner(), path)
}

#[tauri::command]
pub(crate) fn remove_library_file(
    storage_paths: tauri::State<'_, StoragePaths>,
    path: String,
) -> Result<Vec<String>, String> {
    let _guard = crate::storage::lock_storage()?;
    remove_library_file_at(storage_paths.inner(), path)
}

#[tauri::command]
pub(crate) fn trash_library_file(
    storage_paths: tauri::State<'_, StoragePaths>,
    path: String,
) -> Result<TrashOutcome, String> {
    let _guard = crate::storage::lock_storage()?;
    trash_library_file_at(storage_paths.inner(), path)
}

#[cfg(test)]
fn test_dir(label: &str) -> PathBuf {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let path = std::env::temp_dir().join(format!(
        "md-reader-library-{label}-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::create_dir_all(&path).unwrap();
    path
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn migrates_recent_file_once_and_keeps_recent_for_rollback() {
        let dir = test_dir("migration");
        fs::write(dir.join("recent.json"), r#"["C:\\a.md","C:\\b.txt"]"#).unwrap();
        let store = LibraryStore::new(dir.clone());

        assert_eq!(
            store.load().unwrap(),
            vec!["C:\\a.md".to_string(), "C:\\b.txt".to_string()]
        );
        assert!(dir.join("library.json").is_file());
        assert!(dir.join("recent.json").is_file());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn corrupt_recent_aborts_migration_without_creating_library() {
        let dir = test_dir("bad-migration");
        fs::write(dir.join("recent.json"), "[").unwrap();
        let store = LibraryStore::new(dir.clone());
        assert!(store.load().is_err());
        assert!(!dir.join("library.json").exists());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn unsupported_recent_entry_aborts_migration() {
        let dir = test_dir("bad-entry");
        fs::write(dir.join("recent.json"), r#"["C:\\a.md","C:\\pic.png"]"#).unwrap();
        let store = LibraryStore::new(dir.clone());
        assert!(store.load().is_err());
        assert!(!dir.join("library.json").exists());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn register_moves_existing_path_to_front_without_limit() {
        let dir = test_dir("mru");
        let store = LibraryStore::new(dir.clone());
        let paths: Vec<String> = (0..25).map(|index| format!("{index}.md")).collect();
        store.save(&paths).unwrap();
        let result = store.register("24.md").unwrap();
        assert_eq!(result.len(), 25);
        assert_eq!(result.first().unwrap(), "24.md");
        fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn windows_registration_ignores_case_and_separator_style() {
        let dir = test_dir("windows-key");
        let store = LibraryStore::new(dir.clone());
        store.save(&["C:\\A.md".into(), "C:\\B.md".into()]).unwrap();
        assert_eq!(
            store.register("c:/b.md").unwrap(),
            vec!["c:/b.md".to_string(), "C:\\A.md".to_string()]
        );
        fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(not(windows))]
    #[test]
    fn non_windows_registration_preserves_case() {
        let dir = test_dir("posix-key");
        let store = LibraryStore::new(dir.clone());
        store.save(&["/docs/A.md".into()]).unwrap();
        assert_eq!(
            store.register("/docs/a.md").unwrap(),
            vec!["/docs/a.md".to_string(), "/docs/A.md".to_string()]
        );
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn remove_does_not_change_progress_json() {
        let dir = test_dir("remove-only");
        let store = LibraryStore::new(dir.clone());
        store.save(&["a.md".into()]).unwrap();
        fs::write(
            dir.join("progress.json"),
            r#"{"a.md":{"scroll_top":0.0,"scroll_pct":0.5}}"#,
        )
        .unwrap();
        let before = fs::read(dir.join("progress.json")).unwrap();
        assert!(store.remove("a.md").unwrap().is_empty());
        assert_eq!(fs::read(dir.join("progress.json")).unwrap(), before);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn document_path_status_distinguishes_file_missing_other_and_unsupported() {
        let dir = test_dir("path-status");
        let file = dir.join("file.md");
        let tex = dir.join("paper.tex");
        let log = dir.join("build.log");
        let folder = dir.join("folder.md");
        fs::write(&file, "# test").unwrap();
        fs::write(&tex, "\\section{test}").unwrap();
        fs::write(&log, "build output").unwrap();
        fs::create_dir(&folder).unwrap();
        assert!(matches!(
            document_path_status(file.to_string_lossy().into_owned()),
            Ok(DocumentPathStatus::File)
        ));
        assert!(matches!(
            document_path_status(tex.to_string_lossy().into_owned()),
            Ok(DocumentPathStatus::File)
        ));
        assert!(matches!(
            document_path_status(log.to_string_lossy().into_owned()),
            Ok(DocumentPathStatus::File)
        ));
        assert!(matches!(
            document_path_status(dir.join("missing.md").to_string_lossy().into_owned()),
            Ok(DocumentPathStatus::Missing)
        ));
        assert!(matches!(
            document_path_status(folder.to_string_lossy().into_owned()),
            Ok(DocumentPathStatus::Other)
        ));
        assert!(
            document_path_status(dir.join("image.png").to_string_lossy().into_owned()).is_err()
        );
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn command_cores_only_use_the_injected_storage_paths() {
        let dir = test_dir("injected-commands");
        let legacy = dir.join("legacy");
        let canonical = dir.join("canonical");
        fs::create_dir(&legacy).unwrap();
        fs::create_dir(&canonical).unwrap();
        let document = dir.join("paper.md");
        fs::write(&document, "# paper").unwrap();
        fs::write(
            canonical.join("recent.json"),
            serde_json::to_string(&vec![document.to_string_lossy().into_owned()]).unwrap(),
        )
        .unwrap();
        fs::write(legacy.join("recent.json"), r#"["legacy.md"]"#).unwrap();
        let storage_paths = StoragePaths::new(canonical.clone());

        let loaded = get_library_files_at(&storage_paths).unwrap();
        assert_eq!(loaded, vec![document.to_string_lossy().into_owned()]);
        assert!(canonical.join("library.json").is_file());
        assert!(legacy.join("recent.json").is_file());

        let registered =
            register_library_file_at(&storage_paths, document.to_string_lossy().into_owned())
                .unwrap();
        assert_eq!(
            registered.first().unwrap(),
            &document.to_string_lossy().into_owned()
        );

        let removed =
            remove_library_file_at(&storage_paths, document.to_string_lossy().into_owned())
                .unwrap();
        assert!(removed.is_empty());
        assert!(
            read_json_or_default::<Vec<String>>(&canonical.join("library.json"))
                .unwrap()
                .is_empty()
        );
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn register_rejects_unsupported_paths_and_directories() {
        let dir = test_dir("register-guard");
        let canonical = dir.join("canonical");
        fs::create_dir(&canonical).unwrap();
        let folder = dir.join("folder.md");
        fs::create_dir(&folder).unwrap();
        let storage_paths = StoragePaths::new(canonical.clone());

        assert!(register_library_file_at(
            &storage_paths,
            dir.join("image.png").to_string_lossy().into_owned()
        )
        .is_err());
        assert!(
            register_library_file_at(&storage_paths, folder.to_string_lossy().into_owned())
                .is_err()
        );
        assert!(register_library_file_at(
            &storage_paths,
            dir.join("missing.md").to_string_lossy().into_owned()
        )
        .is_err());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn rejects_unregistered_missing_directory_symlink_and_unsupported_paths() {
        assert!(validate_trash_candidate(false, FileKind::Regular, Path::new("a.md")).is_err());
        assert!(validate_trash_candidate(true, FileKind::Missing, Path::new("a.md")).is_err());
        assert!(validate_trash_candidate(true, FileKind::Directory, Path::new("a.md")).is_err());
        assert!(validate_trash_candidate(true, FileKind::Symlink, Path::new("a.md")).is_err());
        assert!(validate_trash_candidate(true, FileKind::Regular, Path::new("a.png")).is_err());
    }

    #[test]
    fn accepts_regular_files_from_the_shared_document_policy() {
        assert!(validate_trash_candidate(true, FileKind::Regular, Path::new("paper.tex")).is_ok());
        assert!(validate_trash_candidate(true, FileKind::Regular, Path::new("build.log")).is_ok());
    }

    #[test]
    fn corrupt_transaction_log_is_reported_instead_of_silently_ignored() {
        let dir = test_dir("corrupt-transaction");
        let store = LibraryStore::new(dir.clone());
        fs::write(store.transaction_path(), "{").unwrap();
        assert!(recover_pending_trash(&store, &RealPersistence).is_err());
        assert!(store.transaction_path().is_file());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn replacement_with_directory_after_prepared_is_rejected_before_trash() {
        let (dir, store, file) = trash_fixture("swap-directory");
        let trash_called = std::cell::Cell::new(false);
        let result = trash_registered_file_with(
            &store,
            &RealPersistence,
            &file,
            |target| {
                fs::remove_file(target).map_err(|error| error.to_string())?;
                fs::create_dir(target).map_err(|error| error.to_string())?;
                Ok(())
            },
            |_| {
                trash_called.set(true);
                Ok(())
            },
        );
        assert!(result.is_err());
        assert!(!trash_called.get());
        assert!(store.contains(file.to_str().unwrap()).unwrap());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn replacement_with_different_regular_file_identity_is_rejected() {
        let (dir, store, file) = trash_fixture("swap-identity");
        let replacement = dir.join("replacement.md");
        fs::write(&replacement, "replacement").unwrap();
        let trash_called = std::cell::Cell::new(false);
        let result = trash_registered_file_with(
            &store,
            &RealPersistence,
            &file,
            |target| {
                fs::remove_file(target).map_err(|error| error.to_string())?;
                fs::rename(&replacement, target).map_err(|error| error.to_string())?;
                Ok(())
            },
            |_| {
                trash_called.set(true);
                Ok(())
            },
        );
        assert!(result.is_err());
        assert!(!trash_called.get());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn trash_failure_preserves_library_and_progress() {
        let (dir, store, file) = trash_fixture("trash-failure");
        let result = trash_registered_file_with(
            &store,
            &RealPersistence,
            &file,
            |_| Ok(()),
            |_| Err("模拟失败".into()),
        );
        assert!(result.is_err());
        assert!(store.contains(file.to_str().unwrap()).unwrap());
        assert!(progress_contains(&store, file.to_str().unwrap()).unwrap());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn library_write_failure_after_trash_returns_partial_success_and_recovers() {
        let (dir, store, file) = trash_fixture("library-failure");
        let persistence = FailingPersistence::once(FailPoint::Library);
        let outcome = trash_registered_file_with(
            &store,
            &persistence,
            &file,
            |_| Ok(()),
            |target| fs::remove_file(target).map_err(|error| error.to_string()),
        )
        .unwrap();
        assert!(outcome.trashed);
        assert!(outcome.cleanup_warning.is_some());
        assert!(store.transaction_path().exists());
        recover_pending_trash(&store, &RealPersistence).unwrap();
        assert!(!store.contains(file.to_str().unwrap()).unwrap());
        assert!(!progress_contains(&store, file.to_str().unwrap()).unwrap());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn progress_write_failure_after_trash_returns_partial_success_and_recovers() {
        let (dir, store, file) = trash_fixture("progress-failure");
        let persistence = FailingPersistence::once(FailPoint::Progress);
        let outcome = trash_registered_file_with(
            &store,
            &persistence,
            &file,
            |_| Ok(()),
            |target| fs::remove_file(target).map_err(|error| error.to_string()),
        )
        .unwrap();
        assert!(outcome.trashed);
        assert!(outcome.cleanup_warning.is_some());
        recover_pending_trash(&store, &RealPersistence).unwrap();
        assert!(!progress_contains(&store, file.to_str().unwrap()).unwrap());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn trashed_phase_write_failure_stops_metadata_writes_and_recovers_delta() {
        let (dir, store, file) = trash_fixture("phase-failure");
        let persistence = FailingPersistence::once(FailPoint::TransactionPhase);
        let outcome = trash_registered_file_with(
            &store,
            &persistence,
            &file,
            |_| Ok(()),
            |target| fs::remove_file(target).map_err(|error| error.to_string()),
        )
        .unwrap();
        assert!(outcome.trashed);
        assert!(outcome.cleanup_warning.is_some());
        assert!(store.contains(file.to_str().unwrap()).unwrap());
        assert!(progress_contains(&store, file.to_str().unwrap()).unwrap());
        recover_pending_trash(&store, &RealPersistence).unwrap();
        assert!(!store.contains(file.to_str().unwrap()).unwrap());
        assert!(!progress_contains(&store, file.to_str().unwrap()).unwrap());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn journal_removal_failure_returns_warning_and_recovery_is_idempotent() {
        let (dir, store, file) = trash_fixture("journal-removal");
        let persistence = FailingPersistence::once(FailPoint::RemoveJournal);
        let outcome = trash_registered_file_with(
            &store,
            &persistence,
            &file,
            |_| Ok(()),
            |target| fs::remove_file(target).map_err(|error| error.to_string()),
        )
        .unwrap();
        assert!(outcome.trashed);
        assert!(outcome.cleanup_warning.is_some());
        assert!(store.transaction_path().exists());
        recover_pending_trash(&store, &RealPersistence).unwrap();
        assert!(!store.contains(file.to_str().unwrap()).unwrap());
        assert!(!store.transaction_path().exists());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn prepared_transaction_is_discarded_when_target_still_exists() {
        let (dir, store, file) = trash_fixture("prepared-exists");
        write_prepared_fixture(&store, &file);
        recover_pending_trash(&store, &RealPersistence).unwrap();
        assert!(store.contains(file.to_str().unwrap()).unwrap());
        assert!(!store.transaction_path().exists());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn prepared_transaction_is_replayed_when_target_is_missing() {
        let (dir, store, file) = trash_fixture("prepared-missing");
        write_prepared_fixture(&store, &file);
        fs::remove_file(&file).unwrap();
        recover_pending_trash(&store, &RealPersistence).unwrap();
        assert!(!store.contains(file.to_str().unwrap()).unwrap());
        assert!(!progress_contains(&store, file.to_str().unwrap()).unwrap());
        fs::remove_dir_all(dir).unwrap();
    }

    #[derive(Clone, Copy, PartialEq, Eq)]
    enum FailPoint {
        TransactionPhase,
        Library,
        Progress,
        RemoveJournal,
    }

    fn trash_fixture(label: &str) -> (PathBuf, LibraryStore, PathBuf) {
        let dir = test_dir(label);
        let file = dir.join("file.md");
        fs::write(&file, "# fixture").unwrap();
        let store = LibraryStore::new(dir.clone());
        store.save(&[file.to_string_lossy().into_owned()]).unwrap();
        let mut progress = serde_json::Map::new();
        progress.insert(
            file.to_string_lossy().into_owned(),
            serde_json::json!({ "scroll_pct": 0.5 }),
        );
        crate::storage::write_json_safely(&store.progress_path(), &progress).unwrap();
        (dir, store, file)
    }

    struct FailingPersistence {
        point: FailPoint,
        failed: std::cell::Cell<bool>,
    }

    impl FailingPersistence {
        fn once(point: FailPoint) -> Self {
            Self {
                point,
                failed: std::cell::Cell::new(false),
            }
        }
        fn should_fail(&self, point: FailPoint) -> bool {
            self.point == point && !self.failed.replace(true)
        }
    }

    impl TrashPersistence for FailingPersistence {
        fn write_transaction(
            &self,
            store: &LibraryStore,
            value: &TrashTransaction,
        ) -> Result<(), String> {
            if value.phase == TrashPhase::Trashed && self.should_fail(FailPoint::TransactionPhase) {
                Err("模拟 trashed 阶段写入失败".into())
            } else {
                RealPersistence.write_transaction(store, value)
            }
        }
        fn remove_transaction(&self, store: &LibraryStore) -> Result<(), String> {
            if self.should_fail(FailPoint::RemoveJournal) {
                Err("模拟事务日志删除失败".into())
            } else {
                RealPersistence.remove_transaction(store)
            }
        }
        fn write_library(&self, store: &LibraryStore, files: &[String]) -> Result<(), String> {
            if self.should_fail(FailPoint::Library) {
                Err("模拟 library 写入失败".into())
            } else {
                RealPersistence.write_library(store, files)
            }
        }
        fn write_progress(
            &self,
            store: &LibraryStore,
            progress: &serde_json::Map<String, serde_json::Value>,
        ) -> Result<(), String> {
            if self.should_fail(FailPoint::Progress) {
                Err("模拟 progress 写入失败".into())
            } else {
                RealPersistence.write_progress(store, progress)
            }
        }
    }

    fn progress_contains(store: &LibraryStore, path: &str) -> Result<bool, String> {
        let progress: serde_json::Map<String, serde_json::Value> =
            crate::storage::read_json_or_default(&store.progress_path())?;
        let key = path_key(path);
        Ok(progress.keys().any(|entry| path_key(entry) == key))
    }

    fn write_prepared_fixture(store: &LibraryStore, path: &Path) {
        RealPersistence
            .write_transaction(
                store,
                &TrashTransaction {
                    path: path.to_string_lossy().into_owned(),
                    phase: TrashPhase::Prepared,
                },
            )
            .unwrap();
    }
}
