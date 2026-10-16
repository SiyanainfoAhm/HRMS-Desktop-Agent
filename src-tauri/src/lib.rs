use base64::{engine::general_purpose, Engine as _};
use image::{codecs::jpeg::JpegEncoder, imageops::FilterType, DynamicImage, ImageBuffer, Rgba};
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HrmsLoginRequest {
    base_url: String,
    email: String,
    password: String,
}

#[derive(Serialize)]
struct HrmsLoginResponse {
    status: u16,
    body: String,
    content_type: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HrmsHeartbeatRequest {
    base_url: String,
    agent_token: String,
    app_version: Option<String>,
    device_name: Option<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct HrmsHeartbeatResponse {
    company_id: String,
    employee_id: String,
}

fn hrms_login_url(raw_base_url: &str) -> Result<reqwest::Url, String> {
    let mut base_url = reqwest::Url::parse(raw_base_url.trim())
        .map_err(|_| "HRMS web URL is invalid. Update VITE_HRMS_WEB_URL.".to_string())?;

    if base_url.scheme() != "https" || base_url.host_str().is_none() {
        return Err("HRMS web URL must be an absolute HTTPS URL.".to_string());
    }

    // This is an origin setting, not a route. Normalize it here so a trailing
    // slash, query string, or fragment cannot alter the login endpoint.
    base_url.set_path("/");
    base_url.set_query(None);
    base_url.set_fragment(None);

    base_url
        .join("api/auth/login")
        .map_err(|_| "HRMS web URL could not be normalized.".to_string())
}

fn login_network_error(error: &reqwest::Error) -> String {
    let detail = error.to_string().to_ascii_lowercase();

    #[cfg(debug_assertions)]
    eprintln!("[hrms-agent] Login request failed: {error}");

    if error.is_timeout() {
        "The HRMS web request timed out. Check your connection and try again.".to_string()
    } else if detail.contains("proxy") {
        "The configured network proxy could not be reached. Contact your network administrator."
            .to_string()
    } else if detail.contains("certificate")
        || detail.contains("tls")
        || detail.contains("handshake")
    {
        "Could not verify the HRMS web security certificate. Check your system date and network security settings."
            .to_string()
    } else if detail.contains("dns")
        || detail.contains("lookup")
        || detail.contains("name or service not known")
    {
        "Could not find the HRMS web server. Check VITE_HRMS_WEB_URL and your connection."
            .to_string()
    } else if error.is_connect() {
        "Could not connect to HRMS web. Check your internet connection and try again.".to_string()
    } else {
        "Could not reach HRMS web. Check VITE_HRMS_WEB_URL and your connection.".to_string()
    }
}

/// Sends credentials only to the configured HTTPS HRMS web origin. Keeping
/// this in the native layer avoids browser CORS restrictions in WebView2.
#[tauri::command]
async fn login_with_hrms_web(request: HrmsLoginRequest) -> Result<HrmsLoginResponse, String> {
    let login_url = hrms_login_url(&request.base_url)?;

    let response = reqwest::Client::builder()
        // The desktop agent calls the configured public HRMS origin directly.
        // In some developer and managed Windows environments HTTP(S)_PROXY is
        // set to an unavailable local proxy (for example 127.0.0.1:9). Reqwest
        // honors those variables by default, causing every login to fail before
        // it reaches the HRMS server.
        .no_proxy()
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "Could not initialize secure HRMS connection.".to_string())?
        .post(login_url)
        .header(reqwest::header::ACCEPT, "application/json")
        .header("X-HRMS-Agent-Client", "desktop")
        .json(&serde_json::json!({
            "email": request.email,
            "password": request.password,
        }))
        .send()
        .await
        .map_err(|error| login_network_error(&error))?;

    let status = response.status().as_u16();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    let body = response
        .text()
        .await
        .map_err(|_| "HRMS web returned an unreadable response.".to_string())?;

    Ok(HrmsLoginResponse {
        status,
        body,
        content_type,
    })
}

/// Sends desktop presence through HRMS Web, which authorizes it server-side
/// and can keep the underlying HRMS tables closed to direct clients.
#[tauri::command]
async fn send_heartbeat_to_hrms_web(
    request: HrmsHeartbeatRequest,
) -> Result<HrmsHeartbeatResponse, String> {
    let heartbeat_url = hrms_login_url(&request.base_url)?
        .join("../agent/heartbeat")
        .map_err(|_| "HRMS web URL could not be normalized.".to_string())?;

    let response = reqwest::Client::builder()
        .no_proxy()
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "Could not initialize secure HRMS connection.".to_string())?
        .post(heartbeat_url)
        .header(reqwest::header::ACCEPT, "application/json")
        .bearer_auth(request.agent_token)
        .json(&serde_json::json!({
            "appVersion": request.app_version,
            "deviceName": request.device_name,
        }))
        .send()
        .await
        .map_err(|error| login_network_error(&error))?;

    if !response.status().is_success() {
        return Err(format!("HRMS agent heartbeat was rejected (HTTP {}). Sign in again.", response.status()));
    }

    response
        .json::<HrmsHeartbeatResponse>()
        .await
        .map_err(|_| "HRMS returned an invalid heartbeat response.".to_string())
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
fn capture_all_screenshots(
    _app: AppHandle,
    trigger: String,
) -> Result<Vec<MonitorScreenshotMeta>, String> {
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
            login_with_hrms_web,
            send_heartbeat_to_hrms_web,
            capture_screenshot,
            capture_all_screenshots
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_an_hrms_origin_to_the_fixed_login_route() {
        assert_eq!(
            hrms_login_url("https://hrms.example.test/some/path?ignored=true#fragment")
                .unwrap()
                .as_str(),
            "https://hrms.example.test/api/auth/login"
        );
    }

    #[test]
    fn accepts_the_frontend_camel_case_login_request() {
        let request: HrmsLoginRequest = serde_json::from_value(serde_json::json!({
            "baseUrl": "https://hrms.example.test/",
            "email": "employee@example.test",
            "password": "not-a-real-password"
        }))
        .unwrap();

        assert_eq!(request.base_url, "https://hrms.example.test/");
    }

    #[test]
    #[ignore = "requires an explicitly supplied HRMS_LOGIN_SMOKE_TEST_URL and makes one invalid login request"]
    fn configured_hrms_login_endpoint_is_reachable_without_proxy() {
        let base_url = std::env::var("HRMS_LOGIN_SMOKE_TEST_URL")
            .expect("set HRMS_LOGIN_SMOKE_TEST_URL to the HRMS HTTPS origin");

        let response = tauri::async_runtime::block_on(login_with_hrms_web(HrmsLoginRequest {
            base_url,
            email: "desktop-agent-network-probe@example.invalid".to_string(),
            password: "not-a-valid-password".to_string(),
        }))
        .expect("the native HTTP client should reach the HRMS login endpoint");

        assert!(
            response.status >= 400,
            "invalid credentials must not authenticate successfully"
        );
        assert!(
            response
                .content_type
                .as_deref()
                .unwrap_or_default()
                .contains("application/json"),
            "the HRMS login endpoint must return JSON"
        );
        serde_json::from_str::<serde_json::Value>(&response.body)
            .expect("the HRMS login endpoint response must be JSON");
    }
}
