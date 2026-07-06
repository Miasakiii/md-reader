#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{Emitter, Manager, RunEvent, WebviewEvent};

#[derive(Serialize, Deserialize, Clone)]
struct FileData {
    path: String,
    content: String,
    encoding: String,
}

#[derive(Serialize, Deserialize, Clone, Default)]
struct ReadingProgress {
    scroll_top: f64,
    scroll_pct: f64,
}

#[derive(Serialize, Deserialize, Clone, Default)]
struct AppState {
    recent_files: Vec<String>,
}

/// 获取配置目录
fn config_dir() -> PathBuf {
    let dir = dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("md-reader");
    fs::create_dir_all(&dir).ok();
    dir
}

/// 读取文件内容（UTF-8 优先，失败时尝试 GB18030/GBK）
#[tauri::command]
fn read_file(path: String) -> Result<FileData, String> {
    let bytes = fs::read(&path).map_err(|e| format!("读取文件失败: {}", e))?;

    if let Ok(content) = std::str::from_utf8(&bytes) {
        save_recent_file(&path);
        return Ok(FileData {
            path,
            content: content.to_string(),
            encoding: "UTF-8".to_string(),
        });
    }

    let (content, _, had_errors) = encoding_rs::GB18030.decode(&bytes);
    if had_errors {
        return Err("无法识别文件编码（非 UTF-8 或 GBK/GB18030）".to_string());
    }

    save_recent_file(&path);
    Ok(FileData {
        path,
        content: content.into_owned(),
        encoding: "GB18030".to_string(),
    })
}

/// 保存文件内容
#[tauri::command]
fn save_file(path: String, content: String) -> Result<(), String> {
    fs::write(&path, content).map_err(|e| format!("保存文件失败: {}", e))?;
    Ok(())
}

/// 保存阅读进度
#[tauri::command]
fn save_reading_progress(path: String, scroll_pct: f64) -> Result<(), String> {
    let progress_file = config_dir().join("progress.json");
    let mut map: std::collections::HashMap<String, ReadingProgress> =
        if progress_file.exists() {
            serde_json::from_str(&fs::read_to_string(&progress_file).unwrap_or_default())
                .unwrap_or_default()
        } else {
            std::collections::HashMap::new()
        };

    map.insert(path, ReadingProgress { scroll_top: 0.0, scroll_pct });

    let json = serde_json::to_string_pretty(&map).unwrap_or_default();
    fs::write(&progress_file, json).map_err(|e| format!("保存进度失败: {}", e))?;
    Ok(())
}

/// 读取阅读进度
#[tauri::command]
fn load_reading_progress(path: String) -> ReadingProgress {
    let progress_file = config_dir().join("progress.json");
    if !progress_file.exists() {
        return ReadingProgress::default();
    }
    let map: std::collections::HashMap<String, ReadingProgress> =
        serde_json::from_str(&fs::read_to_string(&progress_file).unwrap_or_default())
            .unwrap_or_default();
    map.get(&path).cloned().unwrap_or_default()
}

/// 保存最近文件列表
fn save_recent_file(path: &str) {
    let recent_file = config_dir().join("recent.json");
    let mut list: Vec<String> = if recent_file.exists() {
        serde_json::from_str(&fs::read_to_string(&recent_file).unwrap_or_default())
            .unwrap_or_default()
    } else {
        Vec::new()
    };

    // 去重，移到最前
    list.retain(|p| p != path);
    list.insert(0, path.to_string());
    list.truncate(20); // 最多保留 20 个

    let json = serde_json::to_string_pretty(&list).unwrap_or_default();
    fs::write(&recent_file, json).ok();
}

/// 启动时传入的文件路径（CLI 参数 / 文件关联）
struct CliArgs(Mutex<Vec<String>>);

fn is_supported_file(path: &str) -> bool {
    let lower = path.to_lowercase();
    lower.ends_with(".md") || lower.ends_with(".markdown") || lower.ends_with(".txt")
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

fn collect_cli_file_args() -> Vec<String> {
    let mut files = Vec::new();
    for maybe_file in std::env::args().skip(1) {
        if maybe_file.starts_with('-') {
            continue;
        }
        let path = normalize_file_path(&maybe_file);
        if is_supported_file(&path) && Path::new(&path).is_file() {
            files.push(path);
        }
    }
    files
}

fn emit_file_opened(app: &tauri::AppHandle, path: String) {
    if !is_supported_file(&path) {
        return;
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.emit("file-opened", path);
    }
}

/// 获取启动时传入的文件路径
#[tauri::command]
fn get_cli_args(state: tauri::State<CliArgs>) -> Vec<String> {
    state.0.lock().unwrap().clone()
}

/// 获取最近文件列表
#[tauri::command]
fn get_recent_files() -> Vec<String> {
    let recent_file = config_dir().join("recent.json");
    if !recent_file.exists() {
        return Vec::new();
    }
    serde_json::from_str(&fs::read_to_string(&recent_file).unwrap_or_default())
        .unwrap_or_default()
}

fn main() {
    let initial_args = collect_cli_file_args();

    tauri::Builder::default()
        .manage(CliArgs(Mutex::new(initial_args)))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_filename("window-state.json")
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            read_file,
            save_file,
            save_reading_progress,
            load_reading_progress,
            get_recent_files,
            get_cli_args,
        ])
        .build(tauri::generate_context!())
        .expect("failed to run MD Reader")
        .run(|app, event| {
            match event {
                #[cfg(any(target_os = "macos", target_os = "ios", target_os = "android"))]
                RunEvent::Opened { urls } => {
                    let cli_args = app.state::<CliArgs>();
                    let mut args = cli_args.0.lock().unwrap();
                    for url in urls {
                        if let Ok(path) = url.to_file_path() {
                            let p = path.to_string_lossy().to_string();
                            if is_supported_file(&p) {
                                args.push(p.clone());
                                emit_file_opened(app, p);
                            }
                        }
                    }
                }
                RunEvent::WebviewEvent { label, event, .. } if label == "main" => {
                    if let WebviewEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event {
                        for path in paths {
                            let p = path.to_string_lossy().to_string();
                            if is_supported_file(&p) {
                                emit_file_opened(app, p);
                            }
                        }
                    }
                }
                _ => {}
            }
        });
}
