//! DeepSeek Harness Tauri desktop shell entry.
//!
//! The Rust host spawns the dsh Node runtime (`--profile web`) in `setup`,
//! holds it in Tauri state for the app lifetime, and tears it down on exit.
//! The WebView loads the frontend served by that Node child — the same HTTP +
//! WebSocket transport a browser uses via `dsh web`. A future `IpcApiClient`
//! subclass (`packages/host/apiproxy`) can replace this HTTP carriage with
//! Tauri IPC without touching the web client packages.

mod spawn;

use spawn::{DshProcess, DSH_WEB_PORT};
use std::io;
use std::sync::Arc;
use tauri::Manager;

/// The shared dsh child handle, held in Tauri state for the app lifetime.
#[derive(Clone)]
struct DshState(Arc<DshProcess>);

/// Report whether the dsh child is still alive.
#[tauri::command]
fn dsh_status(state: tauri::State<DshState>) -> bool {
    state.0.is_alive()
}

/// Restart the dsh child. Returns Ok on a successful re-spawn.
#[tauri::command]
fn dsh_restart(app: tauri::AppHandle, state: tauri::State<DshState>) -> Result<(), String> {
    state.0.restart(&app).map_err(|e| e.to_string())
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            // Initialize logging so spawn/dsh output is visible during dev.
            if let Err(e) = env_logger::try_init() {
                eprintln!("logging already initialized or failed: {}", e);
            }

            match DshProcess::new(app.handle()) {
                Ok(proc) => {
                    app.manage(DshState(Arc::new(proc)));
                }
                Err(e) => {
                    // Fail loud: a desktop shell without its Node runtime is
                    // useless. Surface the error rather than silently starting
                    // a dead WebView.
                    return Err(Box::new(e));
                }
            }

            // In a release build, override the frontendDist-loaded window URL
            // to point at the local dsh web server. The static dist requires
            // host-injected __DSH_BOOT__, so it cannot work over file://.
            // The webserver injects it at serve time.
            let main_window = app.get_webview_window("main").ok_or_else(|| {
                Box::new(io::Error::new(io::ErrorKind::NotFound, "main window not found"))
            })?;
            let url: url::Url = format!("http://127.0.0.1:{}", DSH_WEB_PORT)
                .parse()
                .map_err(|e| Box::new(io::Error::new(io::ErrorKind::InvalidInput, e)) as Box<dyn std::error::Error>)?;
            main_window
                .navigate(url)
                .map_err(|e| Box::new(io::Error::other(e.to_string())) as Box<dyn std::error::Error>)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            // Tear down the child when the main window closes.
            if let tauri::WindowEvent::Destroyed = event {
                if let Some(state) = window.app_handle().try_state::<DshState>() {
                    state.0.kill();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![dsh_status, dsh_restart])
        .run(tauri::generate_context!())
        .expect("error while running dsh-desktop");
}
