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
}

fn store(storage_paths: &StoragePaths) -> LibraryStore {
    LibraryStore::new(storage_paths.config_dir.clone())
}

pub(crate) fn get_library_files_at(storage_paths: &StoragePaths) -> Result<Vec<String>, String> {
    store(storage_paths).load()
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
    store(storage_paths).register(&path)
}

pub(crate) fn remove_library_file_at(
    storage_paths: &StoragePaths,
    path: String,
) -> Result<Vec<String>, String> {
    store(storage_paths).remove(&path)
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
}
