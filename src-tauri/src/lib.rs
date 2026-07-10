use base64::{engine::general_purpose, Engine as _};
use once_cell::sync::Lazy;
use serde::Serialize;
use std::sync::{
    atomic::{AtomicBool, AtomicI64, Ordering},
    Mutex,
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager,
};
use tauri_plugin_autostart::ManagerExt;
use image::{
    codecs::jpeg::JpegEncoder,
    imageops::FilterType,
    DynamicImage,
    ImageBuffer,
    Rgba,
};

static INPUT_MONITOR_RUNNING: AtomicBool = AtomicBool::new(false);
static LAST_ACTIVITY_MS: AtomicI64 = AtomicI64::new(0);
static INPUT_THREAD_GUARD: Lazy<Mutex<Option<std::thread::JoinHandle<()>>>> =
    Lazy::new(|| Mutex::new(None));

#[derive(Serialize, Clone)]
struct ActivityEvent {
    kind: &'static str,
    at_ms: i64,
}

#[derive(Serialize, Clone)]
struct ScreenshotMeta {
    at_ms: i64,
    trigger: String,
    bytes_b64: String,
    content_type: String,
}

#[derive(Serialize, Clone)]
struct MonitorScreenshotMeta {
    capture_group_id: String,
    screen_index: u32,
    screen_name: String,
    screen_width: u32,
    screen_height: u32,
    is_primary_screen: bool,
    at_ms: i64,
    trigger: String,
    bytes_b64: String,
    content_type: String,
}

fn encode_rgba_to_jpeg(rgba: Vec<u8>, width: u32, height: u32) -> Result<Vec<u8>, String> {
    let img_buffer: ImageBuffer<Rgba<u8>, Vec<u8>> =
        ImageBuffer::from_raw(width, height, rgba).ok_or("Failed to build image buffer")?;

    let dyn_img = DynamicImage::ImageRgba8(img_buffer);

    let max_width: u32 = 1280;
    let resized = if dyn_img.width() > max_width {
        let new_height =
            (dyn_img.height() as f32 * (max_width as f32 / dyn_img.width() as f32)) as u32;
        dyn_img.resize(max_width, new_height, FilterType::Triangle)
    } else {
        dyn_img
    };

    let rgb = resized.to_rgb8();
    let mut out: Vec<u8> = Vec::new();
    {
        let mut encoder = JpegEncoder::new_with_quality(&mut out, 45);
        encoder
            .encode_image(&DynamicImage::ImageRgb8(rgb))
            .map_err(|e| e.to_string())?;
    }

    Ok(out)
}

fn capture_screen_image(screen: &screenshots::Screen) -> Result<(Vec<u8>, u32, u32), String> {
    let image = screen.capture().map_err(|e| e.to_string())?;
    let width = image.width() as u32;
    let height = image.height() as u32;
    let jpeg = encode_rgba_to_jpeg(image.as_raw().clone(), width, height)?;
    Ok((jpeg, width, height))
}

fn monitor_screenshot_meta(
    screen: &screenshots::Screen,
    screen_index: u32,
    capture_group_id: &str,
    trigger: &str,
    at_ms: i64,
) -> Result<MonitorScreenshotMeta, String> {
    let info = screen.display_info;
    let (jpeg, width, height) = capture_screen_image(screen)?;

    Ok(MonitorScreenshotMeta {
        capture_group_id: capture_group_id.to_string(),
        screen_index,
        screen_name: format!("Screen {}", screen_index),
        screen_width: width,
        screen_height: height,
        is_primary_screen: info.is_primary || screen_index == 1,
        at_ms,
        trigger: trigger.to_string(),
        bytes_b64: general_purpose::STANDARD.encode(jpeg),
        content_type: "image/jpeg".to_string(),
    })
}

#[tauri::command]
fn capture_screenshot(_app: AppHandle, trigger: String) -> Result<ScreenshotMeta, String> {
    let screens = screenshots::Screen::all().map_err(|e| e.to_string())?;
    let screen = screens.first().ok_or("No screen detected")?;
    let at = now_ms();
    let (jpeg, _, _) = capture_screen_image(screen)?;

    Ok(ScreenshotMeta {
        at_ms: at,
        trigger,
        bytes_b64: general_purpose::STANDARD.encode(jpeg),
        content_type: "image/jpeg".to_string(),
    })
}

#[tauri::command]
fn capture_all_screenshots(_app: AppHandle, trigger: String) -> Result<Vec<MonitorScreenshotMeta>, String> {
    let screens = screenshots::Screen::all().map_err(|e| e.to_string())?;
    if screens.is_empty() {
        return Err("No screen detected".to_string());
    }

    let at = now_ms();
    let capture_group_id = uuid::Uuid::new_v4().to_string();
    let mut captured: Vec<MonitorScreenshotMeta> = Vec::new();

    for (idx, screen) in screens.iter().enumerate() {
        let screen_index = (idx + 1) as u32;
        match monitor_screenshot_meta(screen, screen_index, &capture_group_id, &trigger, at) {
            Ok(meta) => captured.push(meta),
            Err(e) => {
                eprintln!(
                    "[hrms-agent] Monitor screenshot failed (screen {}): {}",
                    screen_index, e
                );
            }
        }
    }

    if captured.is_empty() {
        return Err("All monitor screenshot captures failed".to_string());
    }

    Ok(captured)
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

#[tauri::command]
fn start_input_monitoring(app: AppHandle) -> Result<(), String> {
    let was_running = INPUT_MONITOR_RUNNING.swap(true, Ordering::SeqCst);
    // Always bump baseline on each start: if monitoring stayed running (e.g. a
    // failed session insert then retry), we must not reuse an old LAST_ACTIVITY_MS
    // or the next sync can treat the user as idle for 5+ minutes immediately.
    LAST_ACTIVITY_MS.store(now_ms(), Ordering::SeqCst);

    if was_running {
        return Ok(());
    }

    let handle = std::thread::spawn(move || {
        let emit_app = app.clone();

        let callback = move |event: rdev::Event| {
            if !INPUT_MONITOR_RUNNING.load(Ordering::SeqCst) {
                return;
            }

            use rdev::EventType::*;

            match event.event_type {
                MouseMove { .. } | ButtonPress(_) | KeyPress(_) => {
                    let t = now_ms();
                    LAST_ACTIVITY_MS.store(t, Ordering::SeqCst);

                    let _ = emit_app.emit(
                        "hrms://activity",
                        ActivityEvent {
                            kind: "activity",
                            at_ms: t,
                        },
                    );
                }
                _ => {}
            }
        };

        let _ = rdev::listen(callback);
    });

    *INPUT_THREAD_GUARD.lock().unwrap() = Some(handle);

    Ok(())
}

#[tauri::command]
fn stop_input_monitoring() -> Result<(), String> {
    INPUT_MONITOR_RUNNING.store(false, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
fn get_last_activity_ms() -> i64 {
    // If global input hooks aren't running (permissions, blocked by OS, etc),
    // treat "last activity" as now so screenshots/tracking don't get stuck
    // in a permanent "idle" state.
    if !INPUT_MONITOR_RUNNING.load(Ordering::SeqCst) {
        return now_ms();
    }

    LAST_ACTIVITY_MS.load(Ordering::SeqCst)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_autostart::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            LAST_ACTIVITY_MS.store(now_ms(), Ordering::SeqCst);

            let autostart = app.autolaunch();

            match autostart.is_enabled() {
                Ok(true) => {
                    println!("Autostart already enabled");
                }
                Ok(false) => match autostart.enable() {
                    Ok(_) => println!("Autostart enabled successfully"),
                    Err(e) => println!("Autostart enable failed: {:?}", e),
                },
                Err(e) => println!("Autostart check failed: {:?}", e),
            }

            let show = MenuItem::with_id(app, "show", "Show Agent", true, None::<&str>)?;
            let sync = MenuItem::with_id(app, "sync", "Sync Now", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;

            let menu = Menu::with_items(app, &[&show, &sync, &quit])?;

            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .tooltip("HRMS Attendance Agent Running")
                .on_menu_event(|tray, event| match event.id().as_ref() {
                    "show" => {
                        if let Some(window) = tray.app_handle().get_webview_window("main") {
                            let _ = window.unminimize();
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "sync" => {
                        println!("Manual sync requested");
                    }
                    "quit" => {
                        tray.app_handle().exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::DoubleClick { .. } = event {
                        if let Some(window) = tray.app_handle().get_webview_window("main") {
                            let _ = window.unminimize();
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                })
                .build(app)?;

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            start_input_monitoring,
            stop_input_monitoring,
            get_last_activity_ms,
            capture_screenshot,
            capture_all_screenshots
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}