//! 当前打开文档的外部修改监听。
//!
//! 语义（见 `docs/superpowers/PROJECT_STATUS.md` 的「文件监控的两条决策」）：
//! 文档在应用之外被改动时**只提示、不自动重载、不自动合并**。
//!
//! 三个关键设计：
//!
//! 1. **监听父目录而非文件本身**。编辑器保存的常见写法是「写临时文件 +
//!    rename 覆盖」，这类原子替换会让针对文件本身的监听丢失；而父目录的
//!    watch 在 rename 后依然有效。
//! 2. **防抖 + 同目录引用计数**。一次保存会触发多事件（create/modify/
//!    rename/close_write），必须合并；同一目录被重复监听时必须去重，否则
//!    同一次保存会被处理多次。
//! 3. **自保存抑制**。应用自己保存也会触发事件，若不回���会在保存后立刻弹
//!    「文件已被外部修改」。保存成功时登记一个短时抑制窗口，窗口内同路径
//!    事件直接丢弃。窗口宁大勿漏——误报一次是体验问题，漏掉一次是用户看到
//!    的虚假提示消失。
//!
//! 与「不做文件监控」的回收站决策不冲突：那条只管文件库记录的还原，本模块
//! 只管当前打开文档的外部编辑。

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};

use tauri::{AppHandle, Emitter};

use crate::file_types::BackendError;

/// 事件合并窗口：一次保存通常在几十毫秒内触发多事件。
const DEBOUNCE: Duration = Duration::from_millis(500);

/// 自保存抑制窗口。保存后文件系统事件到达有延迟，窗口过小会漏掉自己写的。
const SELF_SAVE_SUPPRESSION: Duration = Duration::from_millis(1200);

/// 监听目标：文档所在目录 + 关注的文件名。
#[derive(Debug, Clone, PartialEq, Eq)]
struct WatchTarget {
    directory: PathBuf,
    file_name: String,
}

impl WatchTarget {
    fn new(document_path: &Path) -> Option<Self> {
        let file_name = document_path.file_name()?.to_str()?.to_string();
        let directory = document_path.parent()?.to_path_buf();
        Some(Self {
            directory,
            file_name,
        })
    }
}

/// 监听器内部状态。`DocumentWatchState` 的字段类型，对外只需 `DocumentWatchState`。
#[derive(Default)]
pub struct WatcherState {
    /// 目录 → 事件发送端。同目录只建一个 watch，引用计数复用。
    senders: HashMap<PathBuf, Sender<notify::Result<Event>>>,
    /// 自保存抑制到期时刻。
    suppressed: HashMap<String, Instant>,
}

/// 全局监听器。Tauri 状态需`Send + Sync`，故用 `Mutex` 包裹。
pub struct DocumentWatchState(Mutex<WatcherState>);

impl DocumentWatchState {
    /// 登记一次自保存，使随后窗口内的同路径事件被丢弃。
    pub fn register_self_save(&self, document_path: &Path) {
        register_self_save(&self.0, document_path);
        prune_expired_suppressions(&self.0);
    }

    /// 停止监听指定文档。
    pub fn unwatch(&self, document_path: &Path) {
        unwatch_document(&self.0, document_path);
    }
}

impl Default for DocumentWatchState {
    fn default() -> Self {
        Self(Mutex::new(WatcherState::default()))
    }
}

fn now_key(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

/// 事件是否与目标文件相关。
///
/// 只认「路径等于目标」或「路径以目标目录开头且文件��相同」两种形态：
/// 原子保存会先写 `foo.md.tmp` 再 rename 回 `foo.md`，前者覆盖后者。
fn event_touches_file(event: &Event, target: &WatchTarget) -> bool {
    event.paths.iter().any(|path| {
        path == &target.directory.join(&target.file_name)
            || path
                .file_name()
                .is_some_and(|name| name == target.file_name.as_str())
                && path
                    .parent()
                    .is_some_and(|parent| parent == target.directory)
    })
}

/// 是否是需要提示的内容变更。
///
/// 刻意排除三类：
/// - `Access` —— 读取不是修改；
/// - `Metadata` —— 权限与时间戳变化不代表内容变了；
/// - `Name`（改名）—— 交给 `document_path_status` 的既有判定，避免同一
///   件事提示两次；
/// - `Remove` —— 同样交给 `document_path_status`。
///
/// `Modify(Data(_))` 是真正的内容写入；`Any` / `Other` 是后端无法归类的
/// 事件，保守处理为提示，宁可多提示也不漏。
fn is_content_change(kind: EventKind) -> bool {
    match kind {
        EventKind::Create(_)
        | EventKind::Any
        | EventKind::Other
        | EventKind::Modify(notify::event::ModifyKind::Data(_))
        // 后端给不出更细分类时保守提示：宁可多提示一次，也不让用户的
        // 外部修改悄无声息。
        | EventKind::Modify(notify::event::ModifyKind::Any)
        | EventKind::Modify(notify::event::ModifyKind::Other) => true,
        EventKind::Modify(_) => false,
        _ => false,
    }
}

/// 自保存抑制窗口内的事件应被丢弃。
fn is_suppressed(state: &WatcherState, document_path: &Path, at: Instant) -> bool {
    state
        .suppressed
        .get(&now_key(document_path))
        .is_some_and(|until| at < *until)
}

fn prune_suppressions(state: &mut WatcherState, at: Instant) {
    state.suppressed.retain(|_, until| at < *until);
}

/// 登记一次自保存，使随后窗口内的同路径事件被抑制。
pub fn register_self_save(state: &Mutex<WatcherState>, document_path: &Path) {
    let at = Instant::now();
    if let Ok(mut state) = state.lock() {
        prune_suppressions(&mut state, at);
        state
            .suppressed
            .insert(now_key(document_path), at + SELF_SAVE_SUPPRESSION);
    }
}

/// 清理过期抑制条目。保存成功路径调用，避免 Map 无界增长。
pub fn prune_expired_suppressions(state: &Mutex<WatcherState>) {
    let at = Instant::now();
    if let Ok(mut state) = state.lock() {
        prune_suppressions(&mut state, at);
    }
}

/// 启动监听当前文档。重复监听同一文档是幂等的。
pub fn watch_document(
    app: &AppHandle,
    state: &Arc<DocumentWatchState>,
    document_path: PathBuf,
) -> Result<(), BackendError> {
    let Some(target) = WatchTarget::new(&document_path) else {
        return Err(BackendError::new(
            "watch_target_unavailable",
            "无法确定文档的监听目标",
        ));
    };

    // 先克隆 Arc：事件线程要独立持有一份，避免与本函数争锁。必须在下面
    // 的局部 `state` 遮蔽同名绑定之前完成。
    let shared_state = Arc::clone(state);
    let mut state = state
        .0
        .lock()
        .map_err(|_| BackendError::new("watch_state_poisoned", "文件监听状态已不可用"))?;

    // 同目录已有 watch：直接返回。重复建 watch 会让一次保存被处理多次。
    if state.senders.contains_key(&target.directory) {
        return Ok(());
    }

    let (tx, rx) = channel::<notify::Result<Event>>();
    let mut watcher = RecommendedWatcher::new(tx.clone(), notify_config()).map_err(|error| {
        BackendError::new(
            "watcher_init_failed",
            format!("无法创建文件监听器: {error}"),
        )
    })?;

    watcher
        .watch(&target.directory, RecursiveMode::NonRecursive)
        .map_err(|error| {
            BackendError::new(
                "watch_failed",
                format!("无法监听目录 {}: {error}", target.directory.display()),
            )
        })?;

    diagnostic(&format!(
        "watching directory: {} for {}",
        target.directory.display(),
        target.file_name
    ));
    state.senders.insert(target.directory.clone(), tx);

    // guard 必须先释放：事件线程需要独立地重新取锁。
    drop(state);

    // 事件消费线程：防抖合并后逐个 emit。
    let app = app.clone();
    let state_for_thread = shared_state;
    let path_for_thread = document_path.clone();
    let target_for_thread = target;

    std::thread::spawn(move || {
        // `watcher` 必须活在本线程内：`RecommendedWatcher` 被 drop 时会
        // 注销底层 watch，函数返回即失效。移动进来即可保持注册。
        let _watcher = watcher;
        while let Ok(Ok(event)) = rx.recv() {
            diagnostic(&format!(
                "raw event: kind={:?} paths={:?}",
                event.kind,
                event.paths.iter().map(|p| p.display().to_string()).collect::<Vec<_>>()
            ));
            // 防抖：丢弃窗口内的后续事件。
            loop {
                match rx.recv_timeout(DEBOUNCE) {
                    // 窗口内还有事件：丢弃，让最后一次成为代表。
                    Ok(_) => continue,
                    Err(RecvTimeoutError::Timeout) => break,
                    Err(RecvTimeoutError::Disconnected) => return,
                }
            }

            if !is_content_change(event.kind) {
                diagnostic(&format!("skipped: not a content change ({:?})", event.kind));
                continue;
            }
            if !event_touches_file(&event, &target_for_thread) {
                diagnostic("skipped: event does not touch the target file");
                continue;
            }

            let at = Instant::now();
            let suppressed = match state_for_thread.0.lock() {
                Ok(mut state) => {
                    prune_suppressions(&mut state, at);
                    is_suppressed(&state, &path_for_thread, at)
                }
                // 锁被毒化：宁可不提示，也不误报。
                Err(_) => true,
            };
            if suppressed {
                diagnostic("skipped: inside self-save suppression window");
                continue;
            }

            diagnostic(&format!(
                "emitting document-changed-externally: {}",
                path_for_thread.display()
            ));
            if let Err(error) = app.emit("document-changed-externally", &path_for_thread) {
                diagnostic(&format!("emit failed: {error}"));
            }
        }
    });

    Ok(())
}

/// 诊断日志：release 构建没有控制台窗口，stderr 用户看不到。
/// 写入临时目录下的 `md-reader-watch.log`，供实测时查看。
fn diagnostic(message: &str) {
    use std::io::Write;
    let path = std::env::temp_dir().join("md-reader-watch.log");
    if let Ok(mut file) = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        use std::time::{SystemTime, UNIX_EPOCH};
        let millis = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let _ = writeln!(file, "[{millis}] {message}");
    }
}

fn notify_config() -> notify::Config {
    notify::Config::default().with_poll_interval(Duration::from_secs(2))
}

/// 停止监听。文档切换或关闭时调用，避免线程与 watch 泄漏。
pub fn unwatch_document(state: &Mutex<WatcherState>, document_path: &Path) {
    let Some(target) = WatchTarget::new(document_path) else {
        return;
    };
    if let Ok(mut state) = state.lock() {
        state.senders.remove(&target.directory);
        state.suppressed.remove(&now_key(document_path));
    }
}

#[tauri::command]
pub fn watch_document_command(
    app: AppHandle,
    state: tauri::State<'_, Arc<DocumentWatchState>>,
    document_path: String,
) -> Result<(), BackendError> {
    watch_document(&app, state.inner(), PathBuf::from(document_path))
}

#[tauri::command]
pub fn register_self_save_command(
    state: tauri::State<'_, Arc<DocumentWatchState>>,
    document_path: String,
) {
    state.register_self_save(Path::new(&document_path));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target(relative: &str) -> WatchTarget {
        WatchTarget::new(Path::new(relative)).unwrap()
    }

    #[test]
    fn a_watch_target_is_derived_from_the_documents_directory_and_name() {
        let t = target("C:/docs/guide.md");
        assert_eq!(t.file_name, "guide.md");
        assert_eq!(t.directory, PathBuf::from("C:/docs"));
    }

    #[test]
    fn a_document_without_a_file_name_has_no_watch_target() {
        assert!(WatchTarget::new(Path::new("/")).is_none());
    }

    #[test]
    fn events_for_the_target_file_are_recognized() {
        let t = target("C:/docs/guide.md");
        let direct = Event {
            kind: EventKind::Modify(notify::event::ModifyKind::Any),
            paths: vec![PathBuf::from("C:/docs/guide.md")],
            attrs: Default::default(),
        };
        assert!(event_touches_file(&direct, &t));

        // 原子保存的临时文件：文件名不同，不应触发。
        let temp = Event {
            kind: EventKind::Create(notify::event::CreateKind::Any),
            paths: vec![PathBuf::from("C:/docs/guide.md.tmp")],
            attrs: Default::default(),
        };
        assert!(!event_touches_file(&temp, &t));
    }

    #[test]
    fn same_named_files_in_other_directories_are_not_matched() {
        let t = target("C:/docs/guide.md");
        let elsewhere = Event {
            kind: EventKind::Modify(notify::event::ModifyKind::Any),
            paths: vec![PathBuf::from("C:/other/guide.md")],
            attrs: Default::default(),
        };
        assert!(!event_touches_file(&elsewhere, &t));
    }

    #[test]
    fn content_changes_are_told_apart_from_access_and_removal() {
        assert!(is_content_change(EventKind::Create(
            notify::event::CreateKind::Any
        )));
        assert!(is_content_change(EventKind::Modify(
            notify::event::ModifyKind::Any
        )));
        // 读取不该提示。
        assert!(!is_content_change(EventKind::Access(
            notify::event::AccessKind::Read
        )));
        // 删除与改名由 document_path_status 既有判定处理，不重复提示。
        assert!(!is_content_change(EventKind::Remove(
            notify::event::RemoveKind::Any
        )));
        // 元数据变化（权限、时间戳）不提示。
        assert!(!is_content_change(EventKind::Modify(
            notify::event::ModifyKind::Metadata(notify::event::MetadataKind::Any)
        )));
        // 改名不提示：交给 document_path_status 判定，避免同一件事提示两次。
        assert!(!is_content_change(EventKind::Modify(
            notify::event::ModifyKind::Name(notify::event::RenameMode::Both)
        )));
        // 内容写入要提示。
        assert!(is_content_change(EventKind::Modify(
            notify::event::ModifyKind::Data(notify::event::DataChange::Content)
        )));
    }

    #[test]
    fn self_save_suppression_silences_events_within_its_window() {
        let mut state = WatcherState::default();
        let path = PathBuf::from("C:/docs/guide.md");
        let at = Instant::now();
        state
            .suppressed
            .insert(now_key(&path), at + Duration::from_millis(1200));

        assert!(is_suppressed(&state, &path, at));
        assert!(is_suppressed(
            &state,
            &path,
            at + Duration::from_millis(1199)
        ));
        assert!(!is_suppressed(
            &state,
            &path,
            at + Duration::from_millis(1201)
        ));
    }

    #[test]
    fn suppression_applies_per_path_not_globally() {
        let mut state = WatcherState::default();
        let saved = PathBuf::from("C:/docs/saved.md");
        let other = PathBuf::from("C:/docs/other.md");
        let at = Instant::now();
        state
            .suppressed
            .insert(now_key(&saved), at + Duration::from_millis(1200));

        assert!(is_suppressed(&state, &saved, at));
        assert!(!is_suppressed(&state, &other, at));
    }

    #[test]
    fn expired_suppressions_are_pruned_so_the_map_stays_bounded() {
        let mut state = WatcherState::default();
        let path = PathBuf::from("C:/docs/guide.md");
        let now = Instant::now();
        state
            .suppressed
            .insert(now_key(&path), now + Duration::from_millis(1200));

        // 尚未到期：保留。
        prune_suppressions(&mut state, now);
        assert_eq!(state.suppressed.len(), 1);

        // 已过期：清理。
        prune_suppressions(&mut state, now + Duration::from_millis(1300));
        assert!(state.suppressed.is_empty());
    }

    #[test]
    fn registering_a_self_save_is_idempotent_and_keeps_a_single_entry() {
        let state = Mutex::new(WatcherState::default());
        let path = PathBuf::from("C:/docs/guide.md");
        register_self_save(&state, &path);
        register_self_save(&state, &path);
        assert_eq!(state.lock().unwrap().suppressed.len(), 1);
    }
}

#[tauri::command]
pub fn unwatch_document_command(
    state: tauri::State<'_, Arc<DocumentWatchState>>,
    document_path: String,
) {
    state.unwatch(Path::new(&document_path));
}
