// Compañero de escritorio de Loki · shell Tauri 2 (Windows primero).
//
// El protocolo vive UNA sola vez en el núcleo TypeScript (`src/`, binario
// sidecar `loki-desktop`). Este shell solo aporta lo nativo: ícono de bandeja
// con estado, menú en español, ventana pequeña de vinculación, autoarranque y
// notificaciones del sistema. Sin puertos abiertos: el shell habla con el
// núcleo por stdin/stdout JSON (sidecar), nunca por red local.

use std::process::{Child, Command};
use std::sync::Mutex;
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Manager, State,
};

struct Sidecar(Mutex<Option<Child>>);

#[derive(Clone, serde::Serialize)]
struct StatusPayload {
    state: String,
}

fn sidecar_bin(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path()
        .resource_dir()
        .ok()
        .map(|dir| dir.join("bin").join("loki-desktop.exe"))
}

fn set_tray_state(app: &AppHandle, state: &str) {
    let tooltip = match state {
        "ejecutando" => "Loki: ejecutando…",
        "pausado" => "Loki: pausado",
        "desconectado" => "Loki: desconectado",
        "vincular" => "Loki: sin vincular",
        _ => "Loki: conectado",
    };
    if let Some(tray) = app.tray_by_id("loki") {
        let _ = tray.set_tooltip(Some(tooltip));
    }
}

fn build_menu(app: &AppHandle, paused: bool, linked: bool) -> Menu<tauri::Wry> {
    let pause_label = if paused {
        "Reanudar (aceptar comandos)"
    } else {
        "Pausar (no aceptar comandos)"
    };
    let pause = MenuItem::with_id(app, "pause", pause_label, paused || linked, None::<&str>)
        .unwrap_or_else(|_| MenuItem::with_id(app, "pause", pause_label, false, None::<&str>).unwrap());
    let recent = MenuItem::with_id(app, "recent", "Actividad reciente", linked, None::<&str>)
        .unwrap_or_else(|_| MenuItem::with_id(app, "recent", "Actividad reciente", false, None::<&str>).unwrap());
    let perms = MenuItem::with_id(app, "perms", "Permisos de este PC", linked, None::<&str>)
        .unwrap_or_else(|_| MenuItem::with_id(app, "perms", "Permisos de este PC", false, None::<&str>).unwrap());
    let unlink = MenuItem::with_id(app, "unlink", "Desvincular este PC", linked, None::<&str>)
        .unwrap_or_else(|_| MenuItem::with_id(app, "unlink", "Desvincular", false, None::<&str>).unwrap());
    let quit = MenuItem::with_id(app, "quit", "Salir", true, None::<&str>)
        .unwrap_or_else(|_| MenuItem::with_id(app, "quit", "Salir", true, None::<&str>).unwrap());
    Menu::with_items(app, &[&pause, &recent, &perms, &unlink, &quit]).unwrap()
}

fn run_sidecar_cmd(app: &AppHandle, args: &[&str]) -> String {
    let Some(bin) = sidecar_bin(app) else {
        return "El núcleo no está instalado.".to_string();
    };
    Command::new(bin)
        .args(args)
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
        .unwrap_or_else(|_| "No se pudo hablar con el núcleo.".to_string())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--minimized"]),
        ))
        .plugin(tauri_plugin_notification::init())
        .manage(Sidecar(Mutex::new(None)))
        .setup(|app| {
            let handle = app.handle().clone();
            let menu = build_menu(&handle, false, true);
            let _tray = TrayIconBuilder::with_id("loki")
                .tooltip("Loki: conectado")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "pause" => {
                        let _ = run_sidecar_cmd(app, &["pause"]);
                        let menu = build_menu(app, true, true);
                        if let Some(tray) = app.tray_by_id("loki") {
                            let _ = tray.set_menu(Some(menu));
                        }
                        set_tray_state(app, "pausado");
                    }
                    "recent" => {
                        let out = run_sidecar_cmd(app, &["status"]);
                        let _ = app.emit("loki:recent", StatusPayload { state: out });
                        if let Some(win) = app.get_webview_window("vincular") {
                            let _ = win.show();
                        }
                    }
                    "perms" => {
                        if let Some(win) = app.get_webview_window("vincular") {
                            let _ = win.show();
                        }
                    }
                    "unlink" => {
                        let _ = run_sidecar_cmd(app, &["unlink"]);
                        set_tray_state(app, "vincular");
                        if let Some(win) = app.get_webview_window("vincular") {
                            let _ = win.show();
                        }
                    }
                    "quit" => {
                        if let Some(state) = app.try_state::<Sidecar>() {
                            if let Ok(mut guard) = state.0.lock() {
                                if let Some(mut child) = guard.take() {
                                    let _ = child.kill();
                                }
                            }
                        }
                        app.exit(0);
                    }
                    _ => {}
                })
                .build(&handle)?;
            // El núcleo arranca como sidecar en `run` (una sola conexión
            // saliente a Supabase; nada queda escuchando en el PC).
            if let Some(bin) = sidecar_bin(&handle) {
                if bin.exists() {
                    if let Ok(child) = Command::new(bin).arg("run").spawn() {
                        if let Some(state) = handle.try_state::<Sidecar>() {
                            if let Ok(mut guard) = state.0.lock() {
                                *guard = Some(child);
                            }
                        }
                    }
                }
            }
            // Primera vez: ventana pequeña "Vincular con Loki".
            if let Some(win) = handle.get_webview_window("vincular") {
                let linked = sidecar_bin(&handle).is_some_and(|_| {
                    !run_sidecar_cmd(&handle, &["status", "--json"]).contains("\"linked\": false")
                });
                if !linked {
                    let _ = win.show();
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("no se pudo iniciar Loki Escritorio");
}

fn main() {
    run();
}
