use std::ffi::OsString;
use std::fs::{self, File, Metadata, OpenOptions, Permissions};
use std::io::{self, ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static TEMP_FILE_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Debug)]
pub(crate) enum OpenRegularFileError {
    Open(io::Error),
    Metadata(io::Error),
    NotRegular,
}

pub(crate) fn open_regular_for_read(path: &Path) -> Result<(File, Metadata), OpenRegularFileError> {
    open_regular_for_read_with_hook(path, || Ok(()))
}

fn open_regular_for_read_with_hook<F>(
    path: &Path,
    before_open: F,
) -> Result<(File, Metadata), OpenRegularFileError>
where
    F: FnOnce() -> io::Result<()>,
{
    before_open().map_err(OpenRegularFileError::Open)?;

    let mut options = OpenOptions::new();
    options.read(true);
    configure_no_follow(&mut options);

    let file = options.open(path).map_err(|error| {
        if is_no_follow_error(&error) {
            OpenRegularFileError::NotRegular
        } else {
            OpenRegularFileError::Open(error)
        }
    })?;
    let metadata = file.metadata().map_err(OpenRegularFileError::Metadata)?;

    if opened_reparse_point(&metadata) || !metadata.is_file() {
        return Err(OpenRegularFileError::NotRegular);
    }

    Ok((file, metadata))
}

#[cfg(unix)]
fn configure_no_follow(options: &mut OpenOptions) {
    use std::os::unix::fs::OpenOptionsExt;

    options.custom_flags(libc::O_NOFOLLOW);
}

#[cfg(windows)]
fn configure_no_follow(options: &mut OpenOptions) {
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
    };

    // OPEN_REPARSE_POINT makes CreateFile open the directory entry itself
    // instead of following a final symlink/junction. BACKUP_SEMANTICS lets us
    // open a raced-in directory so it can be rejected from handle metadata.
    options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS);
}

#[cfg(not(any(unix, windows)))]
fn configure_no_follow(_options: &mut OpenOptions) {}

#[cfg(unix)]
fn is_no_follow_error(error: &io::Error) -> bool {
    error.raw_os_error() == Some(libc::ELOOP)
}

#[cfg(not(unix))]
fn is_no_follow_error(_error: &io::Error) -> bool {
    false
}

#[cfg(windows)]
fn opened_reparse_point(metadata: &Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;

    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn opened_reparse_point(_metadata: &Metadata) -> bool {
    false
}

pub(crate) fn atomic_replace_contents(
    target: &Path,
    contents: &[u8],
    existing_permissions: Option<Permissions>,
) -> io::Result<()> {
    atomic_replace_contents_with(
        target,
        contents,
        existing_permissions,
        write_and_sync,
        atomic_replace,
    )
}

fn atomic_replace_contents_with<W, R>(
    target: &Path,
    contents: &[u8],
    existing_permissions: Option<Permissions>,
    write_temp: W,
    replace: R,
) -> io::Result<()>
where
    W: FnOnce(&mut File, &[u8], Option<Permissions>) -> io::Result<()>,
    R: FnOnce(&Path, &Path, bool) -> io::Result<()>,
{
    let target_existed = existing_permissions.is_some();
    let (temporary_path, mut temporary_file) = create_temporary_file(target)?;
    let mut cleanup = TemporaryPath::new(temporary_path);

    if let Err(error) = write_temp(&mut temporary_file, contents, existing_permissions) {
        // The cleanup guard is declared after the file handle. Close the handle
        // explicitly so Windows can remove the failed temporary file.
        drop(temporary_file);
        return Err(error);
    }
    // Windows cannot replace a destination while all kinds of temporary-file
    // handles are open. Closing here also makes the replacement boundary clear.
    drop(temporary_file);

    replace(cleanup.path(), target, target_existed)?;
    cleanup.disarm();
    Ok(())
}

fn write_and_sync(
    file: &mut File,
    contents: &[u8],
    existing_permissions: Option<Permissions>,
) -> io::Result<()> {
    file.write_all(contents)?;
    file.flush()?;
    preserve_permissions(file, existing_permissions)?;
    file.sync_all()
}

#[cfg(unix)]
fn preserve_permissions(file: &File, permissions: Option<Permissions>) -> io::Result<()> {
    if let Some(permissions) = permissions {
        file.set_permissions(permissions)?;
    }
    Ok(())
}

#[cfg(not(unix))]
fn preserve_permissions(_file: &File, _permissions: Option<Permissions>) -> io::Result<()> {
    // ReplaceFileW preserves the destination ACL on Windows. Copying the
    // read-only attribute to the temporary file before replacement can make
    // the replacement itself fail, so leave Windows metadata to the API.
    Ok(())
}

fn create_temporary_file(target: &Path) -> io::Result<(PathBuf, File)> {
    let directory = target
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));

    for _ in 0..128 {
        let sequence = TEMP_FILE_COUNTER.fetch_add(1, Ordering::Relaxed);
        let mut name = OsString::from(".mdr-");
        name.push(std::process::id().to_string());
        name.push("-");
        name.push(sequence.to_string());
        name.push(".tmp");
        let candidate = directory.join(name);

        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
        {
            Ok(file) => return Ok((candidate, file)),
            Err(error) if error.kind() == ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    }

    Err(io::Error::new(
        ErrorKind::AlreadyExists,
        "unable to allocate a unique temporary save file",
    ))
}

struct TemporaryPath {
    path: PathBuf,
    armed: bool,
}

impl TemporaryPath {
    fn new(path: PathBuf) -> Self {
        Self { path, armed: true }
    }

    fn path(&self) -> &Path {
        &self.path
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for TemporaryPath {
    fn drop(&mut self) {
        if self.armed {
            let _ = fs::remove_file(&self.path);
        }
    }
}

#[cfg(unix)]
fn atomic_replace(temporary: &Path, target: &Path, _target_existed: bool) -> io::Result<()> {
    fs::rename(temporary, target)
}

#[cfg(windows)]
fn atomic_replace(temporary: &Path, target: &Path, target_existed: bool) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use std::ptr;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, ReplaceFileW, MOVEFILE_WRITE_THROUGH,
    };

    fn wide_path(path: &Path) -> io::Result<Vec<u16>> {
        let mut value: Vec<u16> = path.as_os_str().encode_wide().collect();
        if value.contains(&0) {
            return Err(io::Error::new(
                ErrorKind::InvalidInput,
                "path contains an interior NUL",
            ));
        }
        value.push(0);
        Ok(value)
    }

    fn move_new_file(temporary: &[u16], target: &[u16]) -> io::Result<()> {
        // Deliberately omit MOVEFILE_REPLACE_EXISTING: if the destination did
        // not exist when save began but appeared concurrently, preserve it and
        // report a conflict instead of silently overwriting it.
        let moved =
            unsafe { MoveFileExW(temporary.as_ptr(), target.as_ptr(), MOVEFILE_WRITE_THROUGH) };
        if moved == 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        }
    }

    let temporary = wide_path(temporary)?;
    let target_wide = wide_path(target)?;

    if !target_existed {
        return move_new_file(&temporary, &target_wide);
    }

    let replaced = unsafe {
        ReplaceFileW(
            target_wide.as_ptr(),
            temporary.as_ptr(),
            ptr::null(),
            0,
            ptr::null(),
            ptr::null(),
        )
    };
    if replaced != 0 {
        return Ok(());
    }

    let replace_error = io::Error::last_os_error();
    // ERROR_FILE_NOT_FOUND may mean the destination disappeared after the
    // initial check. Verify that fact before falling back to a no-replace move;
    // this keeps every failure path non-destructive.
    if replace_error.raw_os_error() == Some(2)
        && matches!(fs::symlink_metadata(target), Err(error) if error.kind() == ErrorKind::NotFound)
    {
        move_new_file(&temporary, &target_wide)
    } else {
        Err(replace_error)
    }
}

#[cfg(not(any(unix, windows)))]
fn atomic_replace(temporary: &Path, target: &Path, _target_existed: bool) -> io::Result<()> {
    fs::rename(temporary, target)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static TEST_DIRECTORY_COUNTER: AtomicU64 = AtomicU64::new(0);

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new(label: &str) -> Self {
            let sequence = TEST_DIRECTORY_COUNTER.fetch_add(1, Ordering::Relaxed);
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system clock should follow the Unix epoch")
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "md-reader-safe-file-{label}-{}-{nonce}-{sequence}",
                std::process::id()
            ));
            fs::create_dir(&path).expect("test directory should be unique");
            Self(path)
        }

        fn path(&self, name: &str) -> PathBuf {
            self.0.join(name)
        }

        fn assert_only_contains(&self, expected: &str) {
            let mut names: Vec<_> = fs::read_dir(&self.0)
                .unwrap()
                .map(|entry| entry.unwrap().file_name())
                .collect();
            names.sort();
            assert_eq!(names, [OsString::from(expected)]);
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn partial_write_failure_preserves_original_and_removes_temporary_file() {
        let directory = TestDirectory::new("partial-write");
        let target = directory.path("document.tex");
        fs::write(&target, b"original").unwrap();
        let permissions = fs::metadata(&target).unwrap().permissions();

        let error = atomic_replace_contents_with(
            &target,
            b"replacement",
            Some(permissions),
            |file, _, _| {
                file.write_all(b"partial")?;
                file.flush()?;
                Err(io::Error::new(
                    ErrorKind::WriteZero,
                    "injected write failure",
                ))
            },
            atomic_replace,
        )
        .unwrap_err();

        assert_eq!(error.kind(), ErrorKind::WriteZero);
        assert_eq!(fs::read(&target).unwrap(), b"original");
        directory.assert_only_contains("document.tex");
    }

    #[test]
    fn replacement_failure_preserves_original_and_removes_temporary_file() {
        let directory = TestDirectory::new("replace-failure");
        let target = directory.path("document.tex");
        fs::write(&target, b"original").unwrap();
        let permissions = fs::metadata(&target).unwrap().permissions();

        let error = atomic_replace_contents_with(
            &target,
            b"replacement",
            Some(permissions),
            write_and_sync,
            |_, _, _| {
                Err(io::Error::new(
                    ErrorKind::PermissionDenied,
                    "injected replace failure",
                ))
            },
        )
        .unwrap_err();

        assert_eq!(error.kind(), ErrorKind::PermissionDenied);
        assert_eq!(fs::read(&target).unwrap(), b"original");
        directory.assert_only_contains("document.tex");
    }

    #[test]
    fn atomic_replace_does_not_modify_another_name_for_a_raced_in_hard_link() {
        let directory = TestDirectory::new("hard-link-race");
        let target = directory.path("document.tex");
        let victim = directory.path("victim.tex");
        fs::write(&target, b"original").unwrap();
        fs::write(&victim, b"victim content").unwrap();
        let permissions = fs::metadata(&target).unwrap().permissions();

        atomic_replace_contents_with(
            &target,
            b"replacement",
            Some(permissions),
            write_and_sync,
            |temporary, target, target_existed| {
                fs::remove_file(target)?;
                fs::hard_link(&victim, target)?;
                atomic_replace(temporary, target, target_existed)
            },
        )
        .unwrap();

        assert_eq!(fs::read(&target).unwrap(), b"replacement");
        assert_eq!(fs::read(&victim).unwrap(), b"victim content");
    }

    #[cfg(unix)]
    #[test]
    fn opening_rejects_a_symlink_swapped_in_immediately_before_open() {
        use std::os::unix::fs::symlink;

        let directory = TestDirectory::new("open-race");
        let path = directory.path("document.tex");
        let victim = directory.path("victim.tex");
        fs::write(&path, b"safe document").unwrap();
        fs::write(&victim, b"victim content").unwrap();

        let error = open_regular_for_read_with_hook(&path, || {
            fs::remove_file(&path)?;
            symlink(&victim, &path)
        })
        .unwrap_err();

        assert!(matches!(error, OpenRegularFileError::NotRegular));
        assert_eq!(fs::read(&victim).unwrap(), b"victim content");
    }

    #[cfg(unix)]
    #[test]
    fn atomic_replace_does_not_follow_a_symlink_swapped_in_before_commit() {
        use std::os::unix::fs::symlink;

        let directory = TestDirectory::new("replace-race");
        let target = directory.path("document.tex");
        let victim = directory.path("victim.tex");
        fs::write(&target, b"original").unwrap();
        fs::write(&victim, b"victim content").unwrap();
        let permissions = fs::metadata(&target).unwrap().permissions();

        atomic_replace_contents_with(
            &target,
            b"replacement",
            Some(permissions),
            write_and_sync,
            |temporary, target, target_existed| {
                fs::remove_file(target)?;
                symlink(&victim, target)?;
                atomic_replace(temporary, target, target_existed)
            },
        )
        .unwrap();

        assert!(fs::symlink_metadata(&target).unwrap().file_type().is_file());
        assert_eq!(fs::read(&target).unwrap(), b"replacement");
        assert_eq!(fs::read(&victim).unwrap(), b"victim content");
    }

    #[cfg(windows)]
    #[test]
    fn windows_replace_does_not_follow_a_file_symlink_swapped_in_before_commit() {
        use std::os::windows::fs::symlink_file;

        let directory = TestDirectory::new("windows-replace-race");
        let target = directory.path("document.tex");
        let victim = directory.path("victim.tex");
        fs::write(&target, b"original").unwrap();
        fs::write(&victim, b"victim content").unwrap();
        let permissions = fs::metadata(&target).unwrap().permissions();

        let privilege_probe = directory.path("symlink-privilege-probe.tex");
        match symlink_file(&victim, &privilege_probe) {
            Ok(()) => fs::remove_file(&privilege_probe).unwrap(),
            Err(error) if error.raw_os_error() == Some(1314) => {
                eprintln!(
                    "skipped Windows file-symlink race check: symbolic-link privilege unavailable"
                );
                return;
            }
            Err(error) => panic!("unable to probe Windows file-symlink support: {error:?}"),
        }

        let result = atomic_replace_contents_with(
            &target,
            b"replacement",
            Some(permissions),
            write_and_sync,
            |temporary, target, target_existed| {
                fs::remove_file(target)?;
                symlink_file(&victim, target)?;
                atomic_replace(temporary, target, target_existed)
            },
        );

        assert_eq!(fs::read(&victim).unwrap(), b"victim content");
        match result {
            Ok(()) => {
                let metadata = fs::symlink_metadata(&target).unwrap();
                assert!(metadata.file_type().is_file());
                assert!(!metadata.file_type().is_symlink());
                assert_eq!(fs::read(&target).unwrap(), b"replacement");
                eprintln!("ReplaceFileW safely replaced the symlink directory entry");
            }
            Err(error) => {
                let metadata = fs::symlink_metadata(&target).unwrap();
                assert!(metadata.file_type().is_symlink());
                assert_eq!(fs::read_link(&target).unwrap(), victim);
                eprintln!("ReplaceFileW safely refused the symlink directory entry: {error:?}");
            }
        }
    }
}
