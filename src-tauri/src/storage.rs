use serde::de::DeserializeOwned;
use serde::Serialize;
use std::fs::{self, File};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, OnceLock};

static STORAGE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

pub(crate) fn lock_storage() -> Result<MutexGuard<'static, ()>, String> {
    STORAGE_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "配置存储锁已损坏".to_string())
}

fn try_path_exists_with(
    path: &Path,
    probe: impl FnOnce(&Path) -> io::Result<bool>,
) -> Result<bool, String> {
    probe(path).map_err(|error| format!("检查 {} 是否存在失败: {error}", path.display()))
}

pub(crate) fn try_path_exists(path: &Path) -> Result<bool, String> {
    try_path_exists_with(path, |candidate| candidate.try_exists())
}

fn sidecar_path(path: &Path, suffix: &str) -> Result<PathBuf, String> {
    let name = path
        .file_name()
        .ok_or_else(|| format!("配置文件路径无效: {}", path.display()))?;
    Ok(path.with_file_name(format!("{}{suffix}", name.to_string_lossy())))
}

pub(crate) fn backup_path(path: &Path) -> PathBuf {
    sidecar_path(path, ".bak").expect("JSON path always has a file name")
}

fn temp_path(path: &Path) -> PathBuf {
    sidecar_path(path, ".tmp").expect("JSON path always has a file name")
}

pub(crate) fn recover_interrupted_write(path: &Path) -> Result<(), String> {
    let backup = backup_path(path);
    let temp = temp_path(path);
    if try_path_exists(path)? {
        let _ = fs::remove_file(&backup);
        let _ = fs::remove_file(&temp);
    } else if try_path_exists(&backup)? {
        fs::rename(&backup, path).map_err(|error| format!("恢复配置备份失败: {error}"))?;
        let _ = fs::remove_file(&temp);
    } else if try_path_exists(&temp)? {
        fs::remove_file(&temp).map_err(|error| format!("清理未提交临时配置失败: {error}"))?;
    }
    Ok(())
}

pub(crate) fn read_json_or_default<T>(path: &Path) -> Result<T, String>
where
    T: DeserializeOwned + Default,
{
    recover_interrupted_write(path)?;
    if !try_path_exists(path)? {
        return Ok(T::default());
    }
    read_json_required(path)
}

pub(crate) fn read_json_required<T>(path: &Path) -> Result<T, String>
where
    T: DeserializeOwned,
{
    recover_interrupted_write(path)?;
    let source = fs::read_to_string(path)
        .map_err(|error| format!("读取 {} 失败: {error}", path.display()))?;
    serde_json::from_str(&source).map_err(|error| format!("解析 {} 失败: {error}", path.display()))
}

pub(crate) fn write_json_safely<T>(path: &Path, value: &T) -> Result<(), String>
where
    T: Serialize + ?Sized,
{
    recover_interrupted_write(path)?;
    let temp = temp_path(path);
    let backup = backup_path(path);
    let bytes =
        serde_json::to_vec_pretty(value).map_err(|error| format!("序列化配置失败: {error}"))?;
    let mut file = File::create(&temp).map_err(|error| format!("创建临时配置失败: {error}"))?;
    file.write_all(&bytes)
        .map_err(|error| format!("写入临时配置失败: {error}"))?;
    file.sync_all()
        .map_err(|error| format!("同步临时配置失败: {error}"))?;
    drop(file);
    let had_target = try_path_exists(path)?;
    if had_target {
        fs::rename(path, &backup).map_err(|error| format!("备份旧配置失败: {error}"))?;
    }
    if let Err(error) = fs::rename(&temp, path) {
        if had_target {
            fs::rename(&backup, path)
                .map_err(|restore| format!("替换配置失败: {error}; 恢复旧配置失败: {restore}"))?;
        }
        return Err(format!("替换配置失败: {error}"));
    }
    if had_target {
        let _ = fs::remove_file(&backup);
    }
    Ok(())
}

#[cfg(test)]
fn test_dir(label: &str) -> PathBuf {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let path = std::env::temp_dir().join(format!(
        "md-reader-{label}-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir_all(&path).unwrap();
    path
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn corrupt_json_is_reported_instead_of_becoming_empty_data() {
        let dir = test_dir("corrupt-json");
        let path = dir.join("library.json");
        fs::write(&path, "{").unwrap();
        let result: Result<Vec<String>, String> = read_json_or_default(&path);
        assert!(result.unwrap_err().contains("解析"));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn existence_check_errors_are_not_treated_as_missing() {
        let result = try_path_exists_with(Path::new("library.json"), |_| {
            Err(std::io::Error::from(std::io::ErrorKind::PermissionDenied))
        });
        assert!(result.unwrap_err().contains("检查"));
    }

    #[test]
    fn safe_write_replaces_target_and_recovers_backup() {
        let dir = test_dir("safe-write");
        let path = dir.join("library.json");
        write_json_safely(&path, &vec!["old.md"]).unwrap();
        write_json_safely(&path, &vec!["new.md"]).unwrap();
        assert_eq!(
            read_json_or_default::<Vec<String>>(&path).unwrap(),
            vec!["new.md"]
        );

        fs::rename(&path, backup_path(&path)).unwrap();
        recover_interrupted_write(&path).unwrap();
        assert_eq!(
            read_json_or_default::<Vec<String>>(&path).unwrap(),
            vec!["new.md"]
        );
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn committed_target_wins_over_a_stale_backup() {
        let dir = test_dir("committed-target");
        let path = dir.join("library.json");
        fs::write(&path, r#"["new.md"]"#).unwrap();
        fs::write(backup_path(&path), r#"["old.md"]"#).unwrap();
        recover_interrupted_write(&path).unwrap();
        assert_eq!(
            read_json_or_default::<Vec<String>>(&path).unwrap(),
            vec!["new.md"]
        );
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn orphan_partial_temp_is_discarded_instead_of_promoted() {
        let dir = test_dir("orphan-temp");
        let path = dir.join("library.json");
        fs::write(temp_path(&path), b"[").unwrap();
        recover_interrupted_write(&path).unwrap();
        assert!(!temp_path(&path).try_exists().unwrap());
        assert_eq!(
            read_json_or_default::<Vec<String>>(&path).unwrap(),
            Vec::<String>::new()
        );
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn storage_lock_serializes_concurrent_writers() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;

        let active = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let threads: Vec<_> = (0..4)
            .map(|_| {
                let active = Arc::clone(&active);
                let peak = Arc::clone(&peak);
                std::thread::spawn(move || {
                    let _guard = lock_storage().unwrap();
                    let now = active.fetch_add(1, Ordering::SeqCst) + 1;
                    peak.fetch_max(now, Ordering::SeqCst);
                    std::thread::sleep(std::time::Duration::from_millis(5));
                    active.fetch_sub(1, Ordering::SeqCst);
                })
            })
            .collect();
        for thread in threads {
            thread.join().unwrap();
        }
        assert_eq!(peak.load(Ordering::SeqCst), 1);
    }
}
