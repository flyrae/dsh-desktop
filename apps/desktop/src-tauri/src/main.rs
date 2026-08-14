//! DeepSeek Harness Tauri desktop shell entry.
//!
//! The Rust host spawns the dsh Node runtime (`--profile web`) in `setup`,
//! holds it in Tauri state for the app lifetime, and tears it down on exit.
//! The WebView loads the frontend served by that Node child — the same HTTP +
//! WebSocket transport a browser uses via `dsh web`. A future `IpcApiClient`
//! subclass (`packages/host/apiproxy`) can replace this HTTP carriage with
//! Tauri IPC without touching the web client packages.
//!
//! Closing the main window shows a dialog: minimize to system tray (Node keeps
//! running) or quit entirely (Node is killed). The tray icon restores the
//! window on click and offers a quit entry.

mod spawn;

use spawn::{DshProcess, DSH_WEB_PORT};
use std::io;
use std::sync::Arc;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager,
};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

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

/// Fully quit: kill the Node child and exit the app.
fn quit_app(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<DshState>() {
        state.0.kill();
    }
    app.exit(0);
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
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
                    return Err(Box::new(e));
                }
            }

            // Create the system tray with a context menu.
            let show_item = MenuItem::with_id(app, "show", "显示窗口", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &quit_item])?;
            TrayIconBuilder::with_id("main-tray")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("DeepSeek Harness")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                })
                .build(app)?;

            // Navigate the WebView to the local dsh web server.
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
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            "quit" => quit_app(app),
            _ => {}
        })
        .on_window_event(|window, event| {
            // Intercept the close button: show a dialog asking whether to
            // minimize to tray or quit entirely.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let app = window.app_handle().clone();
                api.prevent_close();

                app.dialog()
                    .message("点击\"是\"最小化到系统托盘（后台运行），点击\"否\"直接退出。")
                    .kind(MessageDialogKind::Info)
                    .title("DeepSeek Harness")
                    .buttons(MessageDialogButtons::YesNo)
                    .show(move |yes| {
                        if yes {
                            // Yes = minimize to tray
                            if let Some(win) = app.get_webview_window("main") {
                                let _ = win.hide();
                            }
                        } else {
                            // No = quit
                            quit_app(&app);
                        }
                    });
            }
        })
        .invoke_handler(tauri::generate_handler![dsh_status, dsh_restart])
        .run(tauri::generate_context!())
        .expect("error while running dsh-desktop");
}
