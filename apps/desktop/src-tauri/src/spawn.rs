//! Spawn and lifecycle for the dsh Node runtime child process.
//!
//! In a release build the Rust host extracts the bundled runtime zip
//! (`bundle.resources`) to `app_data_dir` on first launch, resolves the bundled
//! Node binary (`bundle.externalBin`) next to the executable, and spawns the dsh
//! CLI entry. In dev the host reads `DSH_BIN` and launches from source. This
//! module mirrors the concepts of `packages/subprocess/subprocess-local/src/spawn.ts`
//! (environment scrubbing, process-tree kill) on the Rust side.

use std::io;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

/// The port the dsh web server listens on. Avoid 3080 because Windows
/// Hyper-V/WSL often reserves the 3031-3130 range, causing EACCES.
pub const DSH_WEB_PORT: &str = "13000";

/// The launched dsh child process, guarded for interior mutability.
pub struct DshProcess {
    child: Mutex<Option<Child>>,
}

impl DshProcess {
    /// Create a new `DshProcess` by spawning the dsh runtime.
    ///
    /// In dev (`cargo tauri dev`) this reads `DSH_BIN` (defaulting to the
    /// repository source launch). In a release build it resolves the bundled
    /// Node binary and dsh CLI entry, extracting the runtime zip on first launch.
    pub fn new(app: &AppHandle) -> io::Result<Self> {
        let child = if cfg!(dev) {
            Self::spawn_dev()?
        } else {
            Self::spawn_release(app)?
        };
        Ok(DshProcess {
            child: Mutex::new(Some(child)),
        })
    }

    /// Dev spawn: read `DSH_BIN` (defaulting to the source launch) and spawn
    /// from the host filesystem. Environment is inherited as-is.
    fn spawn_dev() -> io::Result<Child> {
        let bin = std::env::var("DSH_BIN")
            .unwrap_or_else(|_| "node --import tsx/esm apps/cli/src/bin.ts".to_string());
        let mut parts = bin.split_whitespace();
        let program = parts.next().ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidInput, "DSH_BIN is empty")
        })?;
        let args: Vec<&str> = parts.collect();

        let mut cmd = Command::new(program);
        cmd.args(&args);
        cmd.arg("--profile").arg("web");
        cmd.arg("--port").arg(DSH_WEB_PORT);
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());
        let child = cmd.spawn()?;
        log::info!("dsh child spawned (dev, pid {})", child.id());
        Ok(child)
    }

    /// Release spawn: extract the runtime zip (if not already cached), resolve
    /// the bundled Node binary next to the executable, and spawn the dsh CLI
    /// entry from the extracted runtime directory. The working directory is set
    /// to the runtime root so bare-specifier resolution finds node_modules.
    fn spawn_release(app: &AppHandle) -> io::Result<Child> {
        let runtime_dir = ensure_runtime_extracted(app)?;

        // The bundled node binary lands next to the main executable, with the
        // target-triple suffix stripped by the installer. Use std::env::current_exe
        // instead of app.path().executable_dir() because the latter can return
        // "unknown path" in some Tauri v2 configurations.
        let exe_path = std::env::current_exe()
            .map_err(|e| io::Error::new(io::ErrorKind::NotFound, format!("cannot resolve current exe: {}", e)))?;
        let exe_dir = exe_path
            .parent()
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "exe path has no parent"))?;
        let node_bin = exe_dir.join(if cfg!(windows) { "node.exe" } else { "node" });
        if !node_bin.exists() {
            return Err(io::Error::new(
                io::ErrorKind::NotFound,
                format!("bundled node binary not found at {}", node_bin.display()),
            ));
        }

        let entry = runtime_dir.join("lib").join("bin.js");
        if !entry.exists() {
            return Err(io::Error::new(
                io::ErrorKind::NotFound,
                format!("dsh CLI entry not found at {} (extraction incomplete?)", entry.display()),
            ));
        }

        let child = Command::new(&node_bin)
            .arg(&entry)
            .arg("--profile")
            .arg("web")
            .arg("--port")
            .arg(DSH_WEB_PORT)
            .current_dir(&runtime_dir)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?;
        log::info!("dsh child spawned (release, pid {})", child.id());
        Ok(child)
    }

    /// Whether the child process is still running.
    pub fn is_alive(&self) -> bool {
        let mut guard = self.child.lock().unwrap();
        match guard.as_mut() {
            Some(child) => matches!(child.try_wait(), Ok(None)),
            None => false,
        }
    }

    /// Kill the child process. Idempotent.
    pub fn kill(&self) {
        let mut guard = self.child.lock().unwrap();
        if let Some(child) = guard.as_mut() {
            let pid = child.id();
            let _ = child.kill();
            let _ = child.wait();
            log::info!("dsh child killed (pid {})", pid);
        }
        *guard = None;
    }

    /// Restart: kill the current child, then spawn a fresh one.
    pub fn restart(&self, app: &AppHandle) -> io::Result<()> {
        self.kill();
        let child = if cfg!(dev) {
            Self::spawn_dev()?
        } else {
            Self::spawn_release(app)?
        };
        let mut guard = self.child.lock().unwrap();
        *guard = Some(child);
        Ok(())
    }
}

impl Drop for DshProcess {
    fn drop(&mut self) {
        self.kill();
    }
}

/// The marker file written into the extracted runtime directory once
/// extraction completes, so subsequent launches skip re-extraction.
const EXTRACT_MARKER: &str = ".dsh-runtime-extracted";

/**
 * Extract the bundled `dsh-runtime.zip` resource to `app_data_dir/dsh-runtime`
 * on first launch. On subsequent launches the existing extraction is reused
 * (detected via the marker file). The zip is packaged as a single Tauri
 * resource to avoid NSIS long-path failures from deeply nested node_modules.
 */
fn ensure_runtime_extracted(app: &AppHandle) -> io::Result<PathBuf> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| io::Error::new(io::ErrorKind::NotFound, e.to_string()))?;
    let runtime_dir = data_dir.join("dsh-runtime");

    // Skip extraction if the marker exists (already extracted).
    if runtime_dir.join(EXTRACT_MARKER).exists() {
        log::info!("dsh runtime already extracted at {}", runtime_dir.display());
        return Ok(runtime_dir);
    }

    // Resolve the bundled zip from the resource directory. Tauri places
    // resources under a "resources/" subdirectory relative to the executable.
    let zip_path = app
        .path()
        .resolve("resources/dsh-runtime.zip", tauri::path::BaseDirectory::Resource)
        .map_err(|e| io::Error::new(io::ErrorKind::NotFound, e.to_string()))?;
    if !zip_path.exists() {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            format!("bundled runtime zip not found at {}", zip_path.display()),
        ));
    }

    log::info!("extracting dsh runtime zip to {}", runtime_dir.display());
    std::fs::create_dir_all(&runtime_dir)?;
    extract_zip(&zip_path, &runtime_dir)?;

    // Write the marker so future launches skip extraction.
    std::fs::write(runtime_dir.join(EXTRACT_MARKER), "ok")?;
    log::info!("dsh runtime extracted successfully");
    Ok(runtime_dir)
}

/**
 * Extract a zip archive using the system tar command (Windows 10+ ships bsdtar
 * with zip support; macOS/Linux have unzip). The `zip` crate silently drops
 * entries on some Windows path layouts, so shelling out is more reliable.
 * @param zip_path - the source zip file.
 * @param dest_dir - the destination directory.
 */
fn extract_zip(zip_path: &Path, dest_dir: &Path) -> io::Result<()> {
    let mut cmd = Command::new("tar");
    cmd.arg("-xf").arg(zip_path).arg("-C").arg(dest_dir);
    let status = cmd.status()?;
    if !status.success() {
        // Fall back to PowerShell Expand-Archive if tar cannot handle the zip.
        let mut ps = Command::new("powershell");
        ps.args(["-NoProfile", "-Command",
            &format!("Expand-Archive -Path '{}' -DestinationPath '{}' -Force",
                zip_path.display(), dest_dir.display())]);
        let ps_status = ps.status()?;
        if !ps_status.success() {
            return Err(io::Error::new(
                io::ErrorKind::Other,
                format!("zip extraction failed: tar exit {:?}, powershell exit {:?}", status.code(), ps_status.code()),
            ));
        }
    }
    Ok(())
}
